import asyncio
from concurrent.futures import ThreadPoolExecutor
from threading import Event

import pytest
from fastapi.testclient import TestClient

from backend.main import create_app
from backend.schemas import GenerationJobCreate
from backend.services import generation_queue as queue
from backend.services.generation_jobs import GenerationJobRepository
from backend.services.library_archives import LibraryArchiveError, LibraryOperationLock


@pytest.fixture
def isolated_queue(tmp_path, monkeypatch):
    for name in ("AUTH", "GROK_AUTH", "CONFIG", "CAPTURE_CLIENTS", "CAPTURE_ORGANIZER_CONFIG"):
        monkeypatch.setenv(f"IMAGE_PROMPT_LIBRARY_{name}_PATH", str(tmp_path / f"{name}.json"))
    executor = ThreadPoolExecutor(max_workers=5)
    monkeypatch.setattr(queue, "_executor", executor)
    monkeypatch.setattr(queue, "_active", set())
    monkeypatch.setattr(queue, "_active_providers", {})
    monkeypatch.setattr(queue, "_pause_timers", {})
    monkeypatch.setattr(queue, "_futures", {})
    monkeypatch.setattr(queue, "_direct_futures", {})
    monkeypatch.setattr(queue, "_closing", set())
    yield tmp_path / "library"
    executor.shutdown(wait=True)
    for timer in queue._pause_timers.values():
        timer.cancel()


@pytest.mark.parametrize("provider", sorted(queue.AUTOMATED_PROVIDER_IDS))
def test_lifespan_holds_library_lease_until_gallery_worker_settles(isolated_queue, monkeypatch, provider):
    library = isolated_queue
    repo = GenerationJobRepository(library)
    job = repo.create_job(GenerationJobCreate(provider=provider, model="synthetic-image", prompt_text="synthetic slow request"))
    entered, release, closing, closed = (Event() for _ in range(4))
    calls = []

    def remote(library_path, job_id, queued_provider):
        calls.append(job_id)
        worker_repo = GenerationJobRepository(library_path)
        worker_repo.mark_running(job_id)
        entered.set()
        assert release.wait(5)
        worker_repo.mark_failed(job_id, "synthetic provider completion")

    monkeypatch.setattr(queue, "_run_provider_job", remote)
    app = create_app(library)

    def lifecycle():
        with TestClient(app):
            assert entered.wait(3)
            # This durable job must remain queued while the app shuts down.
            repo.create_job(GenerationJobCreate(provider=provider, model="synthetic-image", prompt_text="next request"))
            closing.set()
        closed.set()

    with ThreadPoolExecutor(max_workers=1) as lifecycle_executor:
        lifecycle_future = lifecycle_executor.submit(lifecycle)
        try:
            assert closing.wait(3)
            assert not closed.wait(0.1), "the library lease was released with a Gallery worker still writing"
            with pytest.raises(LibraryArchiveError):
                with LibraryOperationLock(library):
                    pass
        finally:
            release.set()
            lifecycle_future.result(timeout=5)
    assert closed.is_set()
    assert calls == [job.id]
    with LibraryOperationLock(library):
        assert repo.get_job(job.id).status == "failed"
        queued = repo.next_queued_provider_jobs(provider, limit=5)
        assert len(queued) == 1
        assert not queue._active


def test_close_cancels_unstarted_workers_but_leaves_jobs_for_reopen(isolated_queue, monkeypatch):
    library = isolated_queue
    repo = GenerationJobRepository(library)
    job = repo.create_job(GenerationJobCreate(provider="openai_codex_oauth_native", prompt_text="queued"))
    occupied, release = Event(), Event()
    calls = []

    def occupy_executor():
        occupied.set()
        assert release.wait(5)

    def remote(library_path, job_id, provider):
        calls.append(job_id)
        worker_repo = GenerationJobRepository(library_path)
        worker_repo.mark_running(job_id)
        worker_repo.mark_failed(job_id, "synthetic completion")

    monkeypatch.setattr(queue, "_run_provider_job", remote)
    with ThreadPoolExecutor(max_workers=1) as executor:
        monkeypatch.setattr(queue, "_executor", executor)
        blocker = executor.submit(occupy_executor)
        try:
            assert occupied.wait(3)
            queue.enqueue_generation_jobs(library)
            assert job.id in queue._active
            queue.drain_generation_jobs(library)
            assert not queue._active
            assert not queue._futures
            assert not calls
            assert repo.get_job(job.id).status == "queued"
            queue.enqueue_generation_jobs(library)
            assert not queue._active
        finally:
            release.set()
            blocker.result(timeout=3)
        # A new lifespan reopens the same in-process library and drains durable work.
        finished = Event()
        original = queue._run_provider_job

        def finish(*args):
            original(*args)
            finished.set()

        monkeypatch.setattr(queue, "_run_provider_job", finish)
        with TestClient(create_app(library)):
            assert finished.wait(3)
        assert calls == [job.id]
        assert repo.get_job(job.id).status == "failed"


def test_closing_one_library_cancels_its_timer_without_stopping_another(isolated_queue, monkeypatch):
    library, other = isolated_queue, isolated_queue.parent / "other"
    provider = "openai_codex_oauth_native"
    calls = []

    class ControlledTimer:
        def __init__(self, delay, callback):
            self.callback = callback
            self.cancelled = False

        def start(self):
            pass

        def is_alive(self):
            return not self.cancelled

        def cancel(self):
            self.cancelled = True

    monkeypatch.setattr(queue, "Timer", ControlledTimer)
    monkeypatch.setattr(queue, "_continue_generation_queue", lambda path, provider: calls.append(path))
    queue._schedule_pause_wake(library, provider, 10)
    queue._schedule_pause_wake(other, provider, 10)
    key, other_key = (str(library.resolve()), provider), (str(other.resolve()), provider)
    stale, unaffected = queue._pause_timers[key], queue._pause_timers[other_key]
    queue.close_generation_queue(library)
    assert stale.cancelled and not unaffected.cancelled
    queue._schedule_pause_wake(library, provider, 1)
    assert key not in queue._pause_timers
    stale.callback()
    assert not calls
    queue.open_generation_queue(library)
    queue._schedule_pause_wake(library, provider, 1)
    replacement = queue._pause_timers[key]
    stale.callback()  # A callback already waiting on the lock cannot consume its replacement.
    assert queue._pause_timers[key] is replacement
    assert not calls
    unaffected.callback()
    replacement.callback()
    assert calls == [other, library]


def test_shutdown_waits_for_direct_call_and_rejects_new_calls(isolated_queue, monkeypatch):
    from backend.services.generation_jobs import GenerationJobConflict

    library = isolated_queue
    repo = GenerationJobRepository(library)
    job = repo.create_job(GenerationJobCreate(provider="openai_codex_oauth_native", prompt_text="direct"))
    entered, release, draining = Event(), Event(), Event()

    def remote(*args):
        entered.set()
        assert release.wait(5)
        repo.mark_running(job.id)
        repo.mark_failed(job.id, "synthetic completion")

    monkeypatch.setattr(queue, "_run_provider_job", remote)

    def drain():
        queue.close_generation_queue(library)
        draining.set()
        queue.drain_generation_jobs(library)

    with ThreadPoolExecutor(max_workers=2) as executor:
        request = executor.submit(queue.run_generation_job_now, library, job.id)
        assert entered.wait(3)
        shutdown = executor.submit(drain)
        try:
            assert draining.wait(3)
            assert not shutdown.done()
            with pytest.raises(GenerationJobConflict, match="shutting down"):
                queue.run_generation_job_now(library, job.id)
            with pytest.raises(GenerationJobConflict, match="still shutting down"):
                queue.open_generation_queue(library)
        finally:
            release.set()
            request.result(timeout=3)
            shutdown.result(timeout=3)
    assert repo.get_job(job.id).status == "failed"
    queue.open_generation_queue(library)


def test_cancelled_lifespan_still_holds_lease_until_gallery_writes_finish(isolated_queue, monkeypatch):
    import backend.main as app_module

    library = isolated_queue
    repo = GenerationJobRepository(library)
    job = repo.create_job(GenerationJobCreate(provider="openai_codex_oauth_native", prompt_text="cancel shutdown"))
    entered, release, draining = Event(), Event(), Event()
    real_drain = app_module.drain_generation_jobs

    def remote(library_path, job_id, provider):
        repo.mark_running(job_id)
        entered.set()
        assert release.wait(5)
        repo.mark_failed(job_id, "settled before releasing lease")

    def drain(path):
        draining.set()
        real_drain(path)

    monkeypatch.setattr(queue, "_run_provider_job", remote)
    monkeypatch.setattr(app_module, "drain_generation_jobs", drain)
    app = create_app(library)

    async def lifecycle():
        async with app.router.lifespan_context(app):
            assert await asyncio.to_thread(entered.wait, 3)

    async def cancel_shutdown():
        shutdown = asyncio.create_task(lifecycle())
        try:
            assert await asyncio.to_thread(draining.wait, 3)
            shutdown.cancel()
            await asyncio.sleep(0.05)
            assert not shutdown.done(), "cancellation released the lease before the drain thread finished"
            with pytest.raises(LibraryArchiveError):
                with LibraryOperationLock(library):
                    pass
            # Repeated cancellation must not bypass the same lease boundary.
            shutdown.cancel()
            await asyncio.sleep(0.05)
            assert not shutdown.done()
        finally:
            release.set()
            with pytest.raises(asyncio.CancelledError):
                await shutdown

    asyncio.run(cancel_shutdown())
    with LibraryOperationLock(library):
        assert repo.get_job(job.id).status == "failed"


def test_startup_failure_also_drains_already_started_gallery_work(isolated_queue, monkeypatch):
    import backend.main as app_module

    library = isolated_queue
    repo = GenerationJobRepository(library)
    job = repo.create_job(GenerationJobCreate(provider="openai_codex_oauth_native", prompt_text="startup"))
    entered, release, closing = Event(), Event(), Event()

    def remote(library_path, job_id, provider):
        repo.mark_running(job_id)
        entered.set()
        assert release.wait(5)
        repo.mark_failed(job_id, "synthetic completion")

    def enqueue_then_fail(path, *, provider):
        queue.enqueue_generation_jobs(path, provider="openai_codex_oauth_native")
        assert entered.wait(3)
        closing.set()
        raise RuntimeError("synthetic startup failure")

    monkeypatch.setattr(queue, "_run_provider_job", remote)
    monkeypatch.setattr(app_module, "enqueue_generation_jobs", enqueue_then_fail)
    app = create_app(library)

    def start():
        with pytest.raises(RuntimeError, match="synthetic startup failure"):
            with TestClient(app):
                pytest.fail("startup should have failed")

    with ThreadPoolExecutor(max_workers=1) as executor:
        startup = executor.submit(start)
        try:
            assert closing.wait(3)
            assert not startup.done()
            with pytest.raises(LibraryArchiveError):
                with LibraryOperationLock(library):
                    pass
        finally:
            release.set()
            startup.result(timeout=3)
    with LibraryOperationLock(library):
        assert repo.get_job(job.id).status == "failed"


def test_worker_waiting_for_provider_slot_does_not_start_during_close(isolated_queue, monkeypatch):
    from threading import BoundedSemaphore

    library = isolated_queue
    repo = GenerationJobRepository(library)
    job = repo.create_job(GenerationJobCreate(provider="openai_codex_oauth_native", prompt_text="waiting for slot"))
    waiting, closing = Event(), Event()
    semaphore = BoundedSemaphore(1)
    assert semaphore.acquire(blocking=False)

    class Slots:
        def acquire(self):
            waiting.set()
            return semaphore.acquire()

        def release(self):
            semaphore.release()

    calls = []
    monkeypatch.setattr(queue, "_provider_slots", Slots())
    monkeypatch.setattr(queue, "_run_provider_job", lambda *args: calls.append(args))
    queue.enqueue_generation_jobs(library)
    assert waiting.wait(3)

    def drain():
        queue.close_generation_queue(library)
        closing.set()
        queue.drain_generation_jobs(library)

    with ThreadPoolExecutor(max_workers=1) as executor:
        shutdown = executor.submit(drain)
        try:
            assert closing.wait(3)
            assert not shutdown.done()
        finally:
            semaphore.release()
            shutdown.result(timeout=3)
    assert not calls and not queue._active and not queue._futures
    assert repo.get_job(job.id).status == "queued"
