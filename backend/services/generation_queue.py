from __future__ import annotations

import sqlite3
from concurrent.futures import Future, ThreadPoolExecutor
from contextlib import suppress
from pathlib import Path
from threading import BoundedSemaphore, RLock, Timer

from backend.services.generation_jobs import GenerationJobConflict, GenerationJobRepository
from backend.services.openai_codex_native import (
    PROVIDER_ID as CODEX_PROVIDER_ID,
    OpenAICodexNativeProvider,
)
from backend.services.xai_grok_oauth import PROVIDER_ID as GROK_PROVIDER_ID, XaiGrokOAuthProvider
from backend.services.openai_compatible import PROVIDER_ID as COMPATIBLE_PROVIDER_ID, OpenAICompatibleProvider

AUTOMATED_PROVIDER_IDS = frozenset({CODEX_PROVIDER_ID, GROK_PROVIDER_ID, COMPATIBLE_PROVIDER_ID, "agent_native_batch"})

MAX_CONCURRENT_GENERATION_JOBS = 5
QUEUE_RESUME_RETRY_SECONDS = 5
INTERRUPTED_BY_BACKEND_RESTART_ERROR = (
    "Generation job was interrupted by backend restart. Retry to run it again."
)

_executor = ThreadPoolExecutor(max_workers=MAX_CONCURRENT_GENERATION_JOBS, thread_name_prefix="generation-job")
_lock = RLock()
_active: set[str] = set()
_active_providers: dict[str, str] = {}
_futures: dict[tuple[str, str], Future] = {}
_direct_futures: dict[str, set[Future]] = {}
_closing: set[str] = set()
_pause_timers: dict[tuple[str, str], Timer] = {}
_provider_slots = BoundedSemaphore(MAX_CONCURRENT_GENERATION_JOBS)


def open_generation_queue(library_path: Path | str) -> None:
    """Reopen this library only after its previous workers have settled."""
    key = str(Path(library_path).resolve())
    with _lock:
        if any(path == key for path, _ in _futures) or _direct_futures.get(key):
            raise GenerationJobConflict("Generation workers are still shutting down")
        _closing.discard(key)


def close_generation_queue(library_path: Path | str) -> None:
    """Stop new calls/retries; leave unstarted jobs durable for the next startup."""
    key = str(Path(library_path).resolve())
    with _lock:
        _closing.add(key)
        for timer_key in [timer_key for timer_key in _pause_timers if timer_key[0] == key]:
            _pause_timers.pop(timer_key).cancel()
        for (path, _), future in list(_futures.items()):
            if path == key:
                future.cancel()


def drain_generation_jobs(library_path: Path | str) -> None:
    """Keep the library lease until every already-started writer has returned.

    A running provider request cannot safely be killed or replayed. Its normal
    timeout still applies, and shutdown waits for its local result/failure writes.
    """
    key = str(Path(library_path).resolve())
    close_generation_queue(library_path)
    with _lock:
        futures = [future for (path, _), future in _futures.items() if path == key]
        futures.extend(_direct_futures.get(key, ()))
    for future in futures:
        with suppress(Exception):
            future.result()


def _discard_cancelled_job(key: tuple[str, str], future: Future) -> None:
    if future.cancelled():
        with _lock:
            if _futures.get(key) is future:
                _futures.pop(key)
                _active.discard(key[1])
                _active_providers.pop(key[1], None)


def recover_interrupted_generation_jobs(library_path: Path | str, *, provider: str = CODEX_PROVIDER_ID):
    """Fail persisted running jobs left behind by a prior backend process.

    The queue runner is process-local, so running jobs from a previous backend
    process do not have a live provider request or worker in this process.
    Mark them failed instead of silently rerunning paid/non-idempotent generation.
    Persisted queued jobs are still safe to drain because they have not started.
    """
    repo = GenerationJobRepository(Path(library_path))
    repo.recover_local_results(provider=provider)
    repo.resume_pending_discard_repairs()
    repo.clear_terminal_stream_previews()
    return repo.mark_running_provider_jobs_failed(provider, INTERRUPTED_BY_BACKEND_RESTART_ERROR)


def enqueue_generation_jobs(library_path: Path | str, *, provider: str = CODEX_PROVIDER_ID) -> None:
    """Start queued provider jobs up to the local concurrency cap.

    This is intentionally in-process/local-first. Queued jobs persist in SQLite; the
    active set only protects the current app process from launching more than five
    provider calls at once.
    """
    library = Path(library_path)
    key = str(library.resolve())
    with _lock:
        if key in _closing:
            return
        repo = GenerationJobRepository(library)
        state = repo.get_provider_queue_state(provider)
        if state.paused:
            _schedule_pause_wake(library, provider, state.retry_after_seconds)
            return
        available = MAX_CONCURRENT_GENERATION_JOBS - len(_active)
        if available <= 0:
            return
        queued = [job for job in repo.next_queued_provider_jobs(provider, limit=available + len(_active))
                  if job.id not in _active and not job.metadata.get('local_result_recovery')][:available]
        if not queued:
            active_count = sum(active_provider == provider for active_provider in _active_providers.values())
            repo.clear_provider_backoff_if_drained(provider, active_count=active_count)
            return
        repo.mark_provider_wave_started(provider)
        for job in queued:
            _active.add(job.id)
            _active_providers[job.id] = provider
            try:
                future = _executor.submit(_run_job_and_continue, library, job.id, provider)
            except Exception:
                _active.discard(job.id)
                _active_providers.pop(job.id, None)
                raise
            job_key = (key, job.id)
            _futures[job_key] = future
            future.add_done_callback(lambda done, key=job_key: _discard_cancelled_job(key, done))


def _run_job_and_continue(library_path: Path, job_id: str, provider: str) -> None:
    key = str(library_path.resolve())
    try:
        _provider_slots.acquire()
        try:
            with _lock:
                if key in _closing:
                    return
            _run_provider_job(library_path, job_id, provider)
        finally:
            _provider_slots.release()
    except Exception:
        # Provider/repository code records failed/cancelled state where possible.
        # The queue runner must never die because one job failed.
        pass
    finally:
        with _lock:
            _active.discard(job_id)
            _active_providers.pop(job_id, None)
            _futures.pop((key, job_id), None)
            if key not in _closing:
                _continue_automated_generation_queues(library_path, completed_provider=provider)


def run_generation_job_now(library_path: Path | str, job_id: str):
    """Run a synchronous native job without exceeding the shared provider cap."""
    library = Path(library_path)
    key = str(library.resolve())
    future = Future()
    with _lock:
        if key in _closing:
            raise GenerationJobConflict("The generation queue is shutting down")
        if not _provider_slots.acquire(blocking=False):
            raise GenerationJobConflict("The generation provider is at its concurrency limit; wait for a running job to finish")
        _direct_futures.setdefault(key, set()).add(future)
    try:
        job = GenerationJobRepository(library).get_job(job_id)
        return _run_provider_job(library, job_id, job.provider)
    finally:
        _provider_slots.release()
        with _lock:
            _direct_futures[key].discard(future)
            if not _direct_futures[key]:
                _direct_futures.pop(key)
            future.set_result(None)


def _run_provider_job(library, job_id, provider):
    repo = GenerationJobRepository(library)
    job = repo.get_job(job_id)
    if repo.local_result_recovery(job_id) is not None:
        return repo.recover_local_result(job_id)
    if provider in {COMPATIBLE_PROVIDER_ID, "agent_native_batch"} and (job.metadata or {}).get("agentRetry"):
        from .agent_image_retry import run_agent_image_retry
        return run_agent_image_retry(library, job_id)
    if provider == COMPATIBLE_PROVIDER_ID and (job.metadata or {}).get("agent"):
        from .agent_execution import run_compatible_agent_job
        return run_compatible_agent_job(library, job_id)
    return _provider_for(provider).run_job(library, job_id)


def _provider_for(provider: str):
    if provider == "agent_native_batch":
        from .agent_execution import NativeAgentImageProvider
        return NativeAgentImageProvider()
    if provider == COMPATIBLE_PROVIDER_ID:
        return OpenAICompatibleProvider()
    if provider == CODEX_PROVIDER_ID:
        return OpenAICodexNativeProvider()
    if provider == GROK_PROVIDER_ID:
        return XaiGrokOAuthProvider()
    raise GenerationJobConflict(f"Generation provider {provider} does not support automatic generation")


def _schedule_pause_wake(library_path: Path, provider: str, delay_seconds: int) -> None:
    key = (str(library_path.resolve()), provider)
    delay = max(0.01, float(delay_seconds or 0))
    with _lock:
        if key[0] in _closing:
            return
        timer = _pause_timers.get(key)
        if timer is not None and timer.is_alive():
            return

        def wake() -> None:
            with _lock:
                # A cancelled callback may already be waiting for the lock.
                # It must not consume a newer timer or resume a reopened queue.
                if _pause_timers.get(key) is not timer:
                    return
                _pause_timers.pop(key, None)
                _continue_generation_queue(library_path, provider)

        timer = Timer(delay, wake)
        timer.daemon = True
        _pause_timers[key] = timer
        timer.start()


def _continue_generation_queue(library_path: Path, provider: str) -> None:
    try:
        enqueue_generation_jobs(library_path, provider=provider)
    except (OSError, sqlite3.Error):
        _schedule_pause_wake(library_path, provider, QUEUE_RESUME_RETRY_SECONDS)


def _continue_automated_generation_queues(library_path: Path, *, completed_provider: str) -> None:
    providers = sorted(AUTOMATED_PROVIDER_IDS - {completed_provider})
    if completed_provider in AUTOMATED_PROVIDER_IDS:
        providers.append(completed_provider)
    for provider in providers:
        _continue_generation_queue(library_path, provider)
