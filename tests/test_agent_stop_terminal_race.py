"""Stopping an active snapshot must not overwrite a concurrently durable terminal."""
from concurrent.futures import ThreadPoolExecutor
from threading import Event

import pytest

from backend.services.agent_execution import create_image_job, run_request
from backend.services.agent_repository import AgentRepository
from test_agent_image_selection import repo, body
from test_agent_workspaces import image_bytes


@pytest.mark.parametrize('terminal,error,outcome', [
    ('completed', None, 'known'),
    ('failed', {'code': 'local_result_pending', 'message': 'Retained local final needs registration'}, 'known'),
    ('failed', {'code': 'upstream_error', 'message': 'Confirmed provider failure'}, 'known'),
    ('unknown', {'code': 'upstream_outcome_unknown', 'message': 'Do not replay'}, 'unknown'),
])
def test_stop_rechecks_terminal_after_stale_active_snapshot(repo, monkeypatch, terminal, error, outcome):
    repo.create_round('conversation', body(repo))
    job = create_image_job(repo, 'request', 1, 'call', 'single', 'Exact synthetic final', {})
    repo.update('request', state='running', outcome='unknown')
    read, committed = Event(), Event()
    original_request = repo.request
    def delayed_request(request_id):
        snapshot = original_request(request_id)
        if not read.is_set():
            read.set()
            assert committed.wait(10), 'terminal writer did not complete'
        return snapshot
    monkeypatch.setattr(repo, 'request', delayed_request)
    with ThreadPoolExecutor(max_workers=1) as pool:
        stopped = pool.submit(repo.stop, 'request')
        assert read.wait(10), 'stop did not read the active snapshot'
        writer = AgentRepository(repo.library)
        if terminal == 'completed':
            writer.jobs.stage_result(job.id, image_bytes(), 'result.png')
        writer.update('request', state=terminal, error=error, outcome=outcome, text='Durable answer')
        before = writer.request('request')
        committed.set()
        result = stopped.result(timeout=10)
    after = writer.request('request')
    assert after['state'] == terminal
    assert after['stop_requested'] == before['stop_requested'] == 0
    assert after['error'] == error
    assert after['round'] == before['round']
    assert after['upstream_outcome'] == outcome
    assert result['request']['state'] == terminal
    if error:
        assert result['request']['error']['code'] == error['code']
    if terminal == 'completed':
        saved = writer.jobs.get_job(job.id)
        assert saved.status == 'succeeded'
        assert (repo.library / saved.result_path).read_bytes() == image_bytes()
    else:
        assert writer.jobs.get_job(job.id).status == 'queued', 'late stop cannot cancel children of a terminal receipt'


def test_stop_wins_once_and_a_late_completion_cannot_restart_request(repo, monkeypatch):
    repo.create_round('conversation', body(repo))
    child = create_image_job(repo, 'request', 1, 'call', 'single', 'Synthetic', {})
    repo.update('request', state='running', outcome='unknown')
    cancelling, finish = Event(), Event()
    original_cancel = repo.jobs.cancel_job
    def cancel_then_wait(job_id):
        result = original_cancel(job_id)
        cancelling.set()
        assert finish.wait(10)
        return result
    monkeypatch.setattr(repo.jobs, 'cancel_job', cancel_then_wait)
    with ThreadPoolExecutor(max_workers=1) as pool:
        stopped = pool.submit(repo.stop, 'request')
        assert cancelling.wait(10)
        writer = AgentRepository(repo.library)
        writer.update('request', state='completed', text='Late text receipt', outcome='known')
        finish.set()
        result = stopped.result(timeout=10)
    assert result['request']['state'] == 'stopped'
    assert result['request']['stopRequested'] is True
    assert writer.jobs.get_job(child.id).status == 'cancelled'
    before = writer.snapshot('conversation')
    assert writer.stop('request') == before
    run_request(repo.library, 'request')
    assert writer.request('request')['usage']['responseStepsStarted'] == 0
    assert writer.jobs.get_job(child.id).status == 'cancelled'


def test_late_stop_does_not_hide_paid_native_recovery_and_repair_makes_no_new_call(repo, monkeypatch):
    from backend.services import agent_execution as execution
    from test_agent_execution_correctness import start, transport, image_result
    from test_agent_native_result_recovery import fail_job_inserts, allow_job_inserts

    start(repo, native=True)
    calls = transport(monkeypatch, payload={'status': 'completed', 'output': [image_result()]})
    fail_job_inserts(repo)
    read, committed = Event(), Event()
    original_request = repo.request
    def delayed_request(request_id):
        snapshot = original_request(request_id)
        if not read.is_set():
            read.set()
            assert committed.wait(10)
        return snapshot
    monkeypatch.setattr(repo, 'request', delayed_request)
    with ThreadPoolExecutor(max_workers=1) as pool:
        stopped = pool.submit(repo.stop, 'request')
        assert read.wait(10)
        execution.run_request(repo.library, 'request')
        before = AgentRepository(repo.library).request('request')
        assert before['error']['code'] == 'local_result_pending'
        committed.set()
        observed = stopped.result(timeout=10)
    assert observed['request']['error']['code'] == 'local_result_pending'
    assert observed['request']['stopRequested'] is False
    assert len(calls) == 1
    receipt = next((repo.library / 'generation-results').glob('*/native-final.json'))
    assert next(receipt.parent.glob('result-*')).read_bytes() == image_bytes()
    allow_job_inserts(repo)
    restarted = AgentRepository(repo.library)
    recovered = restarted.jobs.recover_local_results()
    assert len(recovered['recovered']) == 1 and len(calls) == 1
    snapshot = restarted.snapshot('conversation', 'request')
    assert len(snapshot['jobs']) == 1 and snapshot['jobs'][0]['status'] == 'succeeded'
    assert snapshot['request']['canResume'] is False
    assert (repo.library / snapshot['jobs'][0]['result_path']).read_bytes() == image_bytes()


def test_stop_receipt_failure_rolls_back_stop_claim_before_cancelling_children(repo, monkeypatch):
    import sqlite3
    repo.create_round('conversation', body(repo))
    child = create_image_job(repo, 'request', 1, 'call', 'single', 'Synthetic', {})
    repo.update('request', state='running', outcome='unknown')
    before = repo.request('request')
    def fail_round(*args, **kwargs):
        raise sqlite3.OperationalError('synthetic stop receipt write failure')
    with monkeypatch.context() as patch:
        patch.setattr(repo, '_save_round', fail_round)
        with pytest.raises(sqlite3.OperationalError, match='stop receipt'):
            repo.stop('request')
    after = repo.request('request')
    assert after['state'] == before['state'] == 'running'
    assert after['stop_requested'] == before['stop_requested'] == 0
    assert after['round'] == before['round']
    assert repo.jobs.get_job(child.id).status == 'queued'
    assert repo.stop('request')['request']['state'] == 'stopped'
    assert repo.jobs.get_job(child.id).status == 'cancelled'
