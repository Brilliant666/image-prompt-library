"""Measure real read-only Agent progress routes with temporary synthetic history.

Run this same script/interpreter in separate processes with --source-root to
compare checkouts. No HTTP provider or queue worker is started; network access
is blocked by the existing diagnostic fixture. Cold samples use a fresh copy
of the synthetic library and a new observer; warm samples first run one full
observation against that copy. OS filesystem caches are not flushed.

Measurements exclude fixture construction, synthetic durable writes and the
consumer's JSON parsing. SQL/JSON/image-read counters describe observation,
including the initial full snapshot. Elapsed time includes instrumentation.
"""
from __future__ import annotations

import argparse
import asyncio
import builtins
from collections import Counter
from contextlib import contextmanager, ExitStack
import gc
import hashlib
import io
import json
from pathlib import Path
import platform
import shutil
import sqlite3
import statistics
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
from unittest.mock import patch


def load_source(root):
    sys.path.insert(0, str(root))
    from scripts import diagnose_agent_context as diagnostic
    from backend.routers import agent as routes
    from backend.services import agent_execution as execution
    from backend.services.agent_repository import AgentRepository
    from PIL import Image
    for module in (diagnostic, routes, execution, sys.modules[AgentRepository.__module__]):
        if not Path(module.__file__).resolve().is_relative_to(root):
            raise RuntimeError('Compare source checkouts in separate Python processes')
    return SimpleNamespace(diagnostic=diagnostic, routes=routes, execution=execution,
                           Repository=AgentRepository, Image=Image)


class Meter:
    def __init__(self):
        self.enabled = True
        self.counts = Counter({key: 0 for key in (
            'sql_connections', 'sql_statements', 'sql_selects', 'json_parse_calls', 'json_parse_bytes',
            'job_metadata_parse_calls', 'job_metadata_parse_bytes', 'request_calls', 'snapshot_calls',
            'progress_view_calls', 'image_file_opens', 'image_read_calls', 'image_read_bytes',
            'max_retained_view_bytes',
        )})

    @contextmanager
    def paused(self):
        old, self.enabled = self.enabled, False
        try:
            yield
        finally:
            self.enabled = old

    def add(self, key, amount=1):
        if self.enabled:
            self.counts[key] += amount


class ImageReader:
    def __init__(self, source, meter):
        self.source, self.meter = source, meter

    def __getattr__(self, name):
        return getattr(self.source, name)

    def read(self, *args):
        value = self.source.read(*args)
        self.meter.add('image_read_calls')
        self.meter.add('image_read_bytes', len(value))
        return value

    def readinto(self, target):
        size = self.source.readinto(target)
        self.meter.add('image_read_calls')
        self.meter.add('image_read_bytes', size or 0)
        return size

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return self.source.__exit__(*args)


@contextmanager
def observed(repo, modules):
    meter = Meter()
    original_connect, original_loads = sqlite3.connect, json.loads
    image_roots = tuple((repo.library / name).resolve() for name in ('generation-references', 'generation-results'))

    def connection(*args, **kwargs):
        conn = original_connect(*args, **kwargs)
        meter.add('sql_connections')
        def trace(statement):
            meter.add('sql_statements')
            meter.add('sql_selects', int(statement.lstrip().upper().startswith('SELECT')))
        conn.set_trace_callback(trace)
        return conn

    def loads(value, *args, **kwargs):
        result = original_loads(value, *args, **kwargs)
        if meter.enabled:
            size = len(value.encode('utf-8') if isinstance(value, str) else value)
            meter.add('json_parse_calls')
            meter.add('json_parse_bytes', size)
            if isinstance(result, dict) and ('agent' in result or 'agentRetry' in result):
                meter.add('job_metadata_parse_calls')
                meter.add('job_metadata_parse_bytes', size)
        return result

    def opener(original):
        def open_file(file, mode='r', *args, **kwargs):
            handle = original(file, mode, *args, **kwargs)
            if 'r' in mode and 'b' in mode and isinstance(file, (str, Path)):
                path = Path(file).resolve()
                if any(path.is_relative_to(root) for root in image_roots):
                    meter.add('image_file_opens')
                    return ImageReader(handle, meter)
            return handle
        return open_file

    def method(original, key):
        def counted(instance, *args, **kwargs):
            meter.add(key)
            return original(instance, *args, **kwargs)
        return counted

    with ExitStack() as stack:
        for target, name, replacement in (
                (sqlite3, 'connect', connection), (json, 'loads', loads),
                (builtins, 'open', opener(builtins.open)), (io, 'open', opener(io.open))):
            stack.enter_context(patch.object(target, name, replacement))
        for name in ('request', 'snapshot', 'progress_view'):
            if hasattr(modules.Repository, name):
                stack.enter_context(patch.object(modules.Repository, name,
                    method(getattr(modules.Repository, name), name + '_calls')))
        if hasattr(modules.routes, 'ProgressSession'):
            session_type = modules.routes.ProgressSession
            def retain(original):
                def wrapped(instance, *args, **kwargs):
                    result = original(instance, *args, **kwargs)
                    if instance.view is not None:
                        size = len(json.dumps(instance.view, ensure_ascii=False, separators=(',', ':')).encode())
                        meter.counts['max_retained_view_bytes'] = max(meter.counts['max_retained_view_bytes'], size)
                    return result
                return wrapped
            for name in ('__init__', 'patch'):
                stack.enter_context(patch.object(session_type, name, retain(getattr(session_type, name))))
        yield meter


class Observer:
    def __init__(self, library):
        self.app = SimpleNamespace(state=SimpleNamespace(library_path=library))

    async def is_disconnected(self):
        return False


def read_frame(frame):
    if isinstance(frame, bytes):
        frame = frame.decode('utf-8')
    return frame.splitlines()[0][7:], json.loads(frame.split('data: ', 1)[1]), len(frame.encode('utf-8'))


def apply_patch(view, operations):
    for operation in operations:
        if not operation['path']:
            view = operation['value']
            continue
        target = view
        for key in operation['path'][:-1]:
            target = target[key]
        key = operation['path'][-1]
        if operation['op'] == 'append':
            assert len(target[key].encode('utf-16-le')) // 2 == operation['offset']
            target[key] += operation['value']
        else:
            target[key] = operation['value']
    return view


def observe_stream(repo, request_id, modules, chunks, meter):
    """Invoke the actual GET endpoint and drain its actual response iterator."""
    counters = Counter({key: 0 for key in ('published_bytes', 'snapshot_bytes', 'patch_bytes',
        'snapshot_events', 'patch_events', 'max_frame_bytes', 'max_patch_bytes')})
    elapsed, initial_counts = 0.0, None
    async def run():
        nonlocal elapsed, initial_counts
        started = time.perf_counter()
        response = await modules.routes.get_request_events(request_id, Observer(repo.library))
        elapsed += time.perf_counter() - started
        index, terminal, view = 0, False, None
        async for _ in one_at_a_time(response.body_iterator):
            # Timing includes route projection, encoding and metadata I/O only.
            frame, duration = _
            elapsed += duration
            with meter.paused():
                kind, payload, size = read_frame(frame)
                assert kind in {'snapshot', 'patch'}, 'Unexpected recovery event in stable synthetic stream'
                counters['published_bytes'] += size
                counters[kind + '_bytes'] += size
                counters[kind + '_events'] += 1
                counters['max_frame_bytes'] = max(counters['max_frame_bytes'], size)
                if kind == 'patch':
                    counters['max_patch_bytes'] = max(counters['max_patch_bytes'], size)
                    view = apply_patch(view, payload['operations'])
                    state = view['request']['state']
                else:
                    view = payload.get('stream', {}).get('view')
                    state = payload['request']['state']
                terminal = state == 'completed'
                if index == 0:
                    initial_counts = dict(meter.counts)
                if index < chunks:
                    index += 1
                    repo.update(request_id, text=('Synthetic streamed text 好🙂. ' * index),
                                state='completed' if index == chunks else 'running', outcome='known')
                else:
                    assert terminal
        assert index == chunks and terminal
        assert counters['snapshot_events'] + counters['patch_events'] == chunks + 1
    with patch.object(modules.routes, 'PROGRESS_INTERVAL', 0), patch.object(modules.routes, 'PROGRESS_HEARTBEAT', 3600):
        modules.runner.run(run())
    return {'instrumented_elapsed_ms': round(elapsed * 1000, 4), **meter.counts, **counters}, initial_counts


async def one_at_a_time(iterator):
    while True:
        started = time.perf_counter()
        try:
            frame = await anext(iterator)
        except StopAsyncIteration:
            break
        yield frame, time.perf_counter() - started


def summarize(samples):
    return {'samples': len(samples), **{key: {'median': statistics.median(row[key] for row in samples),
        'min': min(row[key] for row in samples), 'max': max(row[key] for row in samples)} for key in samples[0]}}


def sample_checkpoint(repo, request_id, modules, repeats, chunks, root):
    result = {}
    gc.collect()
    for temperature in ('cold', 'warm'):
        totals, initials, updates = [], [], []
        for repetition in range(repeats):
            # Copy only synthetic fixtures. No existing library is accepted.
            library = root / f'{request_id}-{temperature}-{repetition}'
            shutil.copytree(repo.library, library)
            local = modules.Repository(library)
            def reset():
                local.update(request_id, state='running', text='', outcome='known')
            reset()
            if temperature == 'warm':
                with observed(local, modules) as meter:
                    observe_stream(local, request_id, modules, chunks, meter)
                reset()
            with observed(local, modules) as meter:
                total, initial = observe_stream(local, request_id, modules, chunks, meter)
            totals.append(total)
            initials.append(initial)
            updates.append({key: total[key] - initial[key] for key in initial if key != 'max_retained_view_bytes'})
            gc.collect()
        result[temperature] = {'total': summarize(totals), 'initial': summarize(initials),
                               'after_initial': summarize(updates)}
    return result


def fingerprint(root):
    paths = ['backend/routers/agent.py', 'backend/services/agent_repository.py',
             'backend/services/agent_progress.py', 'requirements.txt']
    files = {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in paths if (root / name).is_file()}
    return {'head': subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip(),
            'files': files, 'benchmark_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}


def run(source_root, checkpoints, repeats, chunks):
    modules = load_source(source_root)
    rows = []
    with asyncio.Runner() as runner, ExitStack() as stack:
        # Windows constructs a private socketpair for the event loop. Create it
        # before blocking all connects; provider sockets remain blocked below.
        runner.get_loop()
        modules.runner = runner
        root = Path(stack.enter_context(tempfile.TemporaryDirectory(prefix='ipl-agent-progress-benchmark-')))
        stack.callback(gc.collect)
        with modules.diagnostic.isolated_repository(root / 'fixture') as repo:
            buffer = io.BytesIO()
            modules.Image.new('RGB', (64, 64), 'blue').save(buffer, 'PNG')
            image_bytes = buffer.getvalue()
            asset = repo.store_asset(image_bytes, None)['id']
            parent = None
            for number in range(1, max(checkpoints) + 1):
                snapshot, created = modules.diagnostic.create_round(repo, number, parent, asset)
                assert created
                request_id = f'request-{number}'
                parent = snapshot['conversation']['activeRoundId']
                job = modules.execution.create_image_job(repo, request_id, 1, 'synthetic-output', 'single',
                                                        'Synthetic local result', {}, native=True)
                repo.jobs.stage_result(job.id, image_bytes, 'synthetic.png')
                repo.update(request_id, state='running', text='', outcome='known')
                if number in checkpoints:
                    rows.append({'rounds': number, **sample_checkpoint(repo, request_id, modules, repeats, chunks, root)})
                    print(f'Measured progress: {number} rounds', file=sys.stderr, flush=True)
                repo.update(request_id, state='completed', text=modules.diagnostic.ANSWER, outcome='known')
        gc.collect()
    progress_module = sys.modules.get('backend.services.agent_progress')
    return {'schema': 1, 'source': fingerprint(source_root), 'environment': {'python': platform.python_version(),
            'os': platform.system(), 'sqlite': sqlite3.sqlite_version}, 'network': 'blocked; zero provider calls',
            'scenario': 'one synthetic input and one local output job per round; current answer streamed in durable chunks',
            'chunks_per_observation': chunks, 'repeats_per_temperature': repeats,
            'cold': 'fresh synthetic library copy and new observer; OS caches not flushed',
            'warm': 'same synthetic copy after one full observation; current synthetic request reset',
            'measurement': 'actual GET route generator; observer counters exclude durable writer and consumer JSON parsing',
            'metadata_counter': 'JSON objects containing agent or agentRetry; SQL and all JSON parsing also counted',
            'read_counter': 'Python binary image opens/read calls/bytes; excludes SQLite internal file reads',
            'configured_limits': {'retained_view_bytes': getattr(progress_module, 'MAX_VIEW_BYTES', None),
                                  'patch_bytes': getattr(progress_module, 'MAX_PATCH_BYTES', None)}, 'rows': rows}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-root', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--rounds', type=int, nargs='+', default=[5, 25, 50, 100])
    parser.add_argument('--repeats', type=int, default=3)
    parser.add_argument('--chunks', type=int, default=32)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    if not 1 <= args.repeats <= 10 or not 1 <= args.chunks <= 1000 or any(not 1 <= n <= 100 for n in args.rounds):
        parser.error('Use 1..100 rounds, 1..10 repeats and 1..1000 chunks')
    report = run(args.source_root.resolve(), sorted(set(args.rounds)), args.repeats, args.chunks)
    result = json.dumps(report, ensure_ascii=False, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(result + '\n', encoding='utf-8')
        print('Wrote aggregate progress benchmark report')
    else:
        print(result)


if __name__ == '__main__':
    main()
