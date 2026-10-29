"""Offline task-context benchmark against the real Agent projection and POST.

Run identical script/interpreter with --source-root BASELINE and NEW_CHECKOUT.
Only synthetic temporary libraries and MockTransport are used. Aggregate reports
contain no request bodies, pixels, file paths from a library, or credentials.
Cold clears the process image encoding cache; warm primes it. OS caches remain.
Timings are uninstrumented; a separate restored call observes reads/SQL/encodes.
"""
from __future__ import annotations

import argparse
import base64
from collections import Counter
from contextlib import closing, contextmanager
import gc
import hashlib
from importlib.metadata import version
from io import BytesIO
import json
from pathlib import Path
import platform
import random
import sqlite3
import statistics
import subprocess
import sys
import tempfile
import time
from unittest.mock import patch


SCENARIOS = ("A_completed_image_tasks", "B_growing_required_images", "C_text_prompt_iterations")
PROMPT = "Synthetic geometric portrait with amber side light and a blue background."
ANSWER = "Synthetic response: the selected constraints and prompt are preserved."


def load_source(root):
    root = Path(root).resolve()
    sys.path.insert(0, str(root))
    from scripts import diagnose_agent_context as diagnostic
    from backend.services import agent_execution as execution, agent_image_encoding as encoding
    from backend.services import agent_context_pipeline as pipeline, agent_image_inputs as inputs
    from backend.agent_schemas import AgentRoundCreate
    from backend.db import connect
    import httpx
    from PIL import Image
    for module in (diagnostic, execution, encoding, pipeline, inputs):
        if not Path(module.__file__).resolve().is_relative_to(root):
            raise RuntimeError("Compare source trees in separate Python processes")
    return dict(diagnostic=diagnostic, execution=execution, encoding=encoding,
                pipeline=pipeline, inputs=inputs, schema=AgentRoundCreate,
                connect=connect, httpx=httpx, Image=Image)


def encoded(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def synthetic_png(Image, index):
    output = BytesIO()
    # Fixed incompressible pixels expose real wire growth, unlike uniform PNGs.
    Image.frombytes("RGB", (96, 96), random.Random(index + 1701).randbytes(96 * 96 * 3)).save(output, "PNG")
    return output.getvalue()


def image_urls(items):
    return [part["image_url"] for item in items for part in item.get("content", [])
            if isinstance(part, dict) and part.get("type") == "input_image"]


def pixel_hash(url, Image):
    with Image.open(BytesIO(base64.b64decode(url.split(",", 1)[1]))) as image:
        return hashlib.sha256(image.convert("RGB").tobytes()).hexdigest()


def wire_metrics(body, wire_bytes, expected, Image):
    urls = image_urls(body["input"])
    actual = {pixel_hash(url, Image) for url in urls}
    expected = set(expected)
    return {"wire_json_bytes": wire_bytes, "wire_image_occurrences": len(urls),
            "wire_unique_images": len(actual), "wire_image_base64_bytes": sum(len(url.split(",", 1)[1]) for url in urls),
            "required_images": len(expected), "required_images_present": len(expected & actual),
            "required_coverage_complete": expected <= actual,
            "unnecessary_unique_images": len(actual - expected),
            "wire_input_items": len(body["input"]),
            "wire_input_sha256": hashlib.sha256(encoded(body["input"]).encode()).hexdigest()}


@contextmanager
def observed_work(repo, modules):
    """Observe actual external work, separately from implementation metrics."""
    counts = Counter({key: 0 for key in ("image_file_reads", "image_file_bytes", "image_version_validations",
        "image_content_validations", "base64_encodes", "base64_input_bytes", "sql_connections",
        "sql_statements", "sql_selects", "mock_model_calls")})
    paths = (repo.library / "generation-references").resolve()
    read_bytes, connect, b64encode = Path.read_bytes, sqlite3.connect, base64.b64encode
    file_version, verify_image = modules["inputs"]._file_version, modules["inputs"]._verify_image_source
    connections = []

    def read(path):
        data = read_bytes(path)
        if path.resolve().is_relative_to(paths):
            counts["image_file_reads"] += 1
            counts["image_file_bytes"] += len(data)
        return data

    def sql(*args, **kwargs):
        conn = connect(*args, **kwargs)
        connections.append(conn)
        counts["sql_connections"] += 1
        def trace(statement):
            counts["sql_statements"] += 1
            counts["sql_selects"] += statement.lstrip().upper().startswith("SELECT")
        conn.set_trace_callback(trace)
        return conn

    def encode(data, *args, **kwargs):
        counts["base64_encodes"] += 1
        counts["base64_input_bytes"] += len(data)
        return b64encode(data, *args, **kwargs)

    def validate_version(*args, **kwargs):
        counts["image_version_validations"] += 1
        return file_version(*args, **kwargs)

    def validate_content(*args, **kwargs):
        counts["image_content_validations"] += 1
        return verify_image(*args, **kwargs)

    try:
        with patch.object(Path, "read_bytes", read), patch.object(sqlite3, "connect", sql), \
                patch.object(base64, "b64encode", encode), \
                patch.object(modules["inputs"], "_file_version", validate_version), \
                patch.object(modules["inputs"], "_verify_image_source", validate_content):
            yield counts
    finally:
        for conn in connections:
            conn.close()


def summarize(samples):
    return {"samples": len(samples), **{key: {
        "median": statistics.median(row[key] for row in samples),
        "min": min(row[key] for row in samples), "max": max(row[key] for row in samples)}
        for key in samples[0]}}


def sample(callback, restore, repo, modules, repeats):
    result, value = {}, None
    for temperature in ("cold", "warm"):
        if temperature == "warm":
            restore()
            callback()
        samples = []
        for _ in range(repeats):
            restore()
            if temperature == "cold":
                modules["encoding"]._cache.clear()
            start = time.perf_counter()
            value = callback()
            elapsed = 1000 * (time.perf_counter() - start)
            restore()
            if temperature == "cold":
                modules["encoding"]._cache.clear()
            with observed_work(repo, modules) as counts:
                start = time.perf_counter()
                value = callback(counts)
                observed_elapsed = 1000 * (time.perf_counter() - start)
            samples.append({"elapsed_ms": round(elapsed, 4),
                "instrumented_elapsed_ms": round(observed_elapsed, 4), **counts})
        result[temperature] = summarize(samples)
    restore()
    return value, result


def checkpoint(repo, request_id, expected, modules, repeats):
    connect, execution, pipeline, httpx = (modules[key] for key in ("connect", "execution", "pipeline", "httpx"))
    request = repo.request(request_id)
    original_round = encoded(request["round"])
    with closing(connect(repo.library)) as conn:
        row = dict(conn.execute("SELECT * FROM agent_requests WHERE id=?", (request_id,)).fetchone())
    columns = [key for key in row if key != "id"]

    def restore():
        with closing(connect(repo.library)) as conn, conn:
            conn.execute("UPDATE agent_rounds SET data=? WHERE id=?", (original_round, request["round_id"]))
            conn.execute("UPDATE agent_requests SET " + ",".join(f'"{key}"=?' for key in columns) + " WHERE id=?",
                         [*(row[key] for key in columns), request_id])

    def projection(_counts=None):
        current = repo.request(request_id)
        return pipeline.prepare_context(repo, current)

    def capture(counts=None):
        captured = []
        def respond(wire):
            assert str(wire.url) == "http://127.0.0.1:1/v1/responses"
            if counts is not None:
                counts["mock_model_calls"] += 1
            captured.append((json.loads(wire.content), len(wire.content)))
            return httpx.Response(200, json={"id": "mock-task-response", "status": "completed", "output": []})
        current = repo.request(request_id)
        with patch.object(httpx, "HTTPTransport", lambda **kwargs: httpx.MockTransport(respond)):
            execution.call_responses(repo, request_id, 1, execution.refs_for_request(repo, current))
        assert len(captured) == 1
        return captured[0]

    projected, build_cost = sample(projection, restore, repo, modules, repeats)
    (body, wire_bytes), wire_cost = sample(capture, restore, repo, modules, repeats)
    task = request["round"].get("taskContext") or request.get("taskContext")
    diagnostics = projected.diagnostics
    fallback = diagnostics.get("fallbackReason", diagnostics.get("taskContextFallbackReason"))
    if not task and fallback is None:
        fallback = "legacy_missing_task_state"
    return {"build": build_cost, "mock_post": wire_cost,
            "task_state_bytes": len(encoded(task).encode()) if task else 0,
            "fallback_reason": fallback, "projection_diagnostics": diagnostics,
            **wire_metrics(body, wire_bytes, expected, modules["Image"])}


def turn(repo, modules, number, parent, assets, prompt, *, context_scope="task"):
    value = {"requestId": f"task-benchmark-{number}", "expectedRevision": repo.snapshot("synthetic")["revision"],
             "parentRoundId": parent, "prompt": prompt, "configRevision": repo.config()["revision"],
             "refs": [{"kind": "upload", "uploadId": aid} for aid in assets],
             "authorization": {"scope": "this_request", "allowImageGeneration": False,
                               "maxImageJobs": 0, "maxToolRounds": 5}}
    if "contextScope" in modules["schema"].model_fields:
        value["contextScope"] = context_scope
    snapshot, _ = repo.create_round("synthetic", modules["schema"].model_validate(value))
    return snapshot["conversation"]["activeRoundId"]


def configure_task(repo, modules, parent, name, assets, original_prompt, number):
    """Task-state capable sources override this through their public repository API.

    Baselines have no such API and retain the identical natural-language intent.
    The hook deliberately does not fabricate frozen state in saved SQL rows.
    """
    if not hasattr(repo, "patch_task_context"):
        return False
    from backend.agent_schemas import AgentTaskContextPatch
    operations = []
    if name == SCENARIOS[0]:
        operations = [{"op": "new_task", "text": original_prompt, "taskType": "image_edit"},
            {"op": "set_target", "ref": {"kind": "upload", "uploadId": assets[0]}},
            {"op": "set_auxiliaries", "auxiliaries": [
                {"ref": {"kind": "upload", "uploadId": aid}, "role": "lighting"} for aid in assets[1:]]}]
    elif name == SCENARIOS[2] and number == 2:
        operations = [{"op": "new_task", "text": original_prompt, "taskType": "prompt"},
            {"op": "set_prompt", "text": original_prompt + " Preserve amber light; use a teal background.", "kind": "selected"}]
    if not operations:
        return False
    snapshot = repo.snapshot("synthetic")
    value = {"expectedRevision": snapshot["revision"], "branchRoundId": parent,
             "operations": operations}
    if snapshot.get("taskContext"):
        value["taskRevision"] = snapshot["taskContext"]["revision"]
    repo.patch_task_context("synthetic", AgentTaskContextPatch.model_validate(value))
    return True


def scenario(root, name, rounds, repeats, modules):
    rows = []
    with modules["diagnostic"].isolated_repository(root) as repo:
        count = max(rounds) + 1 if name == SCENARIOS[0] else max(rounds) if name == SCENARIOS[1] else 1
        raw = [synthetic_png(modules["Image"], index) for index in range(count)]
        assets = [repo.store_asset(data, None)["id"] for data in raw]
        hashes = [pixel_hash("data:image/png;base64," + base64.b64encode(data).decode(), modules["Image"]) for data in raw]
        originals = {path: hashlib.sha256(path.read_bytes()).hexdigest()
                     for path in (repo.library / "generation-references").rglob("*") if path.is_file()}
        parent = None
        for number in range(1, max(rounds) + 1):
            if name == SCENARIOS[0]:
                current = [assets[number - 1]] + ([assets[-1]] if number in rounds else [])
                expected = [hashes[number - 1]] + ([hashes[-1]] if number in rounds else [])
                prompt = "Earlier tasks are finished. Edit only the current target; use the other current attachment only for lighting. " + PROMPT
                state_assets = current
            elif name == SCENARIOS[1]:
                current, expected = [assets[number - 1]], hashes[:number]
                prompt = "Continue this comparison task. Every image introduced in this task is still required; compare every reference including the current one. " + PROMPT
                state_assets = assets[:number]
            else:
                current, expected = ([assets[0]], [hashes[0]]) if number == 1 else ([], [])
                prompt = ("Describe this synthetic reference. " if number == 1 else
                    ("End the previous image task. " if number == 2 else "") +
                    "Continue the text-only prompt revision; no pixels are needed. Keep the amber side light; make the background teal. ") + PROMPT
                state_assets = current
            configure_task(repo, modules, parent, name, state_assets, PROMPT, number)
            parent = turn(repo, modules, number, parent, current, prompt,
                          context_scope="branch" if name == SCENARIOS[1] else "task")
            request_id = f"task-benchmark-{number}"
            if number in rounds:
                rows.append({"rounds": number, **checkpoint(repo, request_id, expected, modules, repeats)})
                print(f"Measured {name}: {number} rounds", file=sys.stderr, flush=True)
            repo.update(request_id, state="completed", text=ANSWER, outcome="known")
        assert all(path.is_file() and hashlib.sha256(path.read_bytes()).hexdigest() == digest for path, digest in originals.items())
        return {"scenario": name, "original_assets_unchanged": True, "rows": rows}


def fingerprint(root):
    paths = sorted((root / "backend").rglob("*.py")) + [root / "uv.lock", root / "pyproject.toml", root / "scripts/diagnose_agent_context.py"]
    digest = hashlib.sha256()
    for path in paths:
        digest.update(path.relative_to(root).as_posix().encode() + b"\0")
        digest.update(hashlib.sha256(path.read_bytes()).digest())
    return {"sha256": digest.hexdigest(), "files": len(paths)}


def run(source_root, rounds=(5, 25, 50, 100, 200), repeats=3, scenarios=SCENARIOS):
    source_root = Path(source_root).resolve()
    identity = fingerprint(source_root)
    modules = load_source(source_root)
    with tempfile.TemporaryDirectory(prefix="ipl-task-context-benchmark-") as directory:
        try:
            report = {"schema": 1, "source_head": subprocess.check_output(["git", "-C", str(source_root), "rev-parse", "HEAD"], text=True).strip(),
                "source_content": identity, "benchmark_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                "source_dirty": bool(subprocess.check_output(["git", "-C", str(source_root), "status", "--porcelain"], text=True).strip()),
                "tracked_diff_sha256": hashlib.sha256(subprocess.check_output(["git", "-C", str(source_root), "diff", "HEAD", "--binary"])).hexdigest(),
                "uv_lock_sha256": hashlib.sha256((source_root / "uv.lock").read_bytes()).hexdigest(),
                "environment": {"python": sys.version, "platform": platform.platform(),
                    "python_executable_sha256": hashlib.sha256(Path(sys.executable).read_bytes()).hexdigest(),
                    "dependencies": {name: version(name) for name in ("httpx", "fastapi", "pillow", "pydantic")}},
                "network": "socket connections blocked; real Agent call_responses uses MockTransport only",
                "provider_latency_and_cache": "not measured", "synthetic_image": {"width": 96, "height": 96, "deterministic_random_rgb": True},
                "cache_definition": {"cold": "process encoding cache cleared before each call", "warm": "primed before sampling", "filesystem_cache": "not flushed"},
                "measurement": "elapsed_ms is uninstrumented; operation counts use a separate restored call at the same cache temperature",
                "state_capability": "task_state" if "contextScope" in modules["schema"].model_fields else "legacy_intent_only",
                "repeats": repeats, "scenarios": [scenario(Path(directory) / name, name, rounds, repeats, modules) for name in scenarios]}
        finally:
            gc.collect()
    if identity != fingerprint(source_root):
        raise RuntimeError("Source changed during benchmark; rerun from a stable source tree")
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--rounds", type=int, nargs="+", default=[5, 25, 50, 100, 200])
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--scenarios", choices=SCENARIOS, nargs="+", default=list(SCENARIOS))
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if not 1 <= args.repeats <= 10 or any(not 2 <= number <= 200 for number in args.rounds):
        parser.error("Use 2..200 rounds and 1..10 repeats")
    report = run(args.source_root, tuple(sorted(set(args.rounds))), args.repeats, args.scenarios)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote aggregate task-context report: {args.output}")


if __name__ == "__main__":
    main()
