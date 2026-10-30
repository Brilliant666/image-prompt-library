"""A retained Native final must respect a stop committed during local repair."""
from concurrent.futures import ThreadPoolExecutor
from threading import Event

import pytest

from backend.services import agent_execution as execution
from backend.services import agent_native_result_recovery as native
from backend.services.agent_repository import AgentRepository
from backend.services.generation_jobs import GenerationJobConflict
from test_agent_image_selection import repo
from test_agent_execution_correctness import start, transport, image_result
from test_agent_native_result_recovery import fail_job_inserts, allow_job_inserts
from test_agent_workspaces import image_bytes


def test_stop_with_stale_round_snapshot_prevents_recovery_from_reviving_native_job(repo, monkeypatch):
    start(repo, native=True)
    calls = transport(monkeypatch, payload={'status': 'completed', 'output': [image_result()]})
    fail_job_inserts(repo)
    execution.run_request(repo.library, 'request')
    allow_job_inserts(repo)
    receipt = next((repo.library / 'generation-results').glob('*/native-final.json'))
    job_id = receipt.parent.name
    # Simulate startup local recovery before interrupted-request reconciliation.
    # A crash can leave the original request active but its final only in files.
    repo.update('request', state='running')
    assert repo.request('request')['round']['outputTaskIds'] == []

    snapshot_read, mapping_created, stop_committed = Event(), Event(), Event()
    original_request = repo.request
    original_ensure = native.ensure_native_job

    def request_before_mapping(request_id):
        snapshot = original_request(request_id)
        if not snapshot_read.is_set():
            snapshot_read.set()
            assert mapping_created.wait(10), 'Native original mapping was not materialized'
        return snapshot

    def ensure_then_stop(jobs, candidate_id):
        result = original_ensure(jobs, candidate_id)
        mapping_created.set()
        assert stop_committed.wait(10), 'User stop did not commit'
        return result

    monkeypatch.setattr(repo, 'request', request_before_mapping)
    monkeypatch.setattr(native, 'ensure_native_job', ensure_then_stop)

    def stop_original():
        try:
            return repo.stop('request')
        finally:
            stop_committed.set()

    with ThreadPoolExecutor(max_workers=1) as pool:
        stopped = pool.submit(stop_original)
        assert snapshot_read.wait(10), 'Stop did not read its original round snapshot'
        with pytest.raises(GenerationJobConflict):
            repo.jobs.recover_local_result(job_id)
        stopped.result(timeout=10)

    current = AgentRepository(repo.library)
    assert current.request('request')['state'] == 'stopped'
    assert current.jobs.get_job(job_id).status != 'succeeded'
    assert receipt.is_file()
    assert next(receipt.parent.glob('result-*')).read_bytes() == image_bytes()
    assert len(calls) == 1


def test_startup_local_native_recovery_cannot_be_replayed_by_request_resume(repo, monkeypatch):
    from backend.services.agent_repository import AgentError

    start(repo, native=True)
    calls = transport(monkeypatch, payload={'status': 'completed', 'output': [image_result()]})
    fail_job_inserts(repo)
    execution.run_request(repo.library, 'request')
    allow_job_inserts(repo)
    assert repo.request('request')['steps'][0]['state'] == 'sending'
    # Reproduce the crash boundary: final files durable, request reconciliation
    # not yet committed. Startup repairs the final but must not replay Responses.
    repo.update('request', state='running')
    execution.recover_agent_requests(repo.library)
    recovered = AgentRepository(repo.library)
    snapshot = recovered.snapshot('conversation', 'request')
    assert len(snapshot['jobs']) == 1 and snapshot['jobs'][0]['status'] == 'succeeded'
    assert recovered.request('request')['state'] == 'interrupted'
    assert snapshot['request']['canResume'] is False
    try:
        accepted = recovered.resume('request', 'resume-after-local-final')
    except AgentError as exc:
        assert exc.code in {'resume_not_safe', 'local_result_pending'}
    else:
        if accepted:
            execution.run_request(repo.library, 'request')
    assert len(calls) == 1
    final = recovered.snapshot('conversation', 'request')
    assert len(final['jobs']) == 1
    assert (repo.library / final['jobs'][0]['result_path']).read_bytes() == image_bytes()
