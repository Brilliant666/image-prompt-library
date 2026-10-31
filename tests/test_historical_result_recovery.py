"""Historical capability reads are local, round-owned and separate from tokens."""
import json

from fastapi.testclient import TestClient
import pytest

from backend.db import connect
from backend.main import create_app
from backend.services import agent_execution as execution
from backend.services.agent_repository import AgentRepository
from test_agent_image_selection import repo, body
from test_agent_execution_correctness import start, transport, image_result, text_result
from test_agent_native_result_recovery import fail_job_inserts, allow_job_inserts


def retained_a_then_b(repo, monkeypatch):
    start(repo, native=True)
    a_calls = transport(monkeypatch, payload={'status': 'completed', 'output': [image_result()]})
    fail_job_inserts(repo)
    execution.run_request(repo.library, 'request')
    allow_job_inserts(repo)
    assert repo.request('request')['error']['code'] == 'local_result_pending'
    b_body = body(repo, 'request-b', images=False).model_copy(update={
        'parentRoundId': repo.request('request')['round_id'], 'prompt': 'A separate synthetic text question'})
    repo.create_round('conversation', b_body)
    b_calls = transport(monkeypatch, payload={'status': 'completed', 'output': [text_result('Synthetic answer B')]})
    execution.run_request(repo.library, 'request-b')
    return a_calls, b_calls


def test_historical_round_hint_and_actual_capability_survive_a_later_completed_round(repo, monkeypatch):
    a_calls, b_calls = retained_a_then_b(repo, monkeypatch)
    client = TestClient(create_app(library_path=repo.library))
    before = client.get('/api/agent/conversations/conversation').json()
    a = next(r for r in before['conversation']['rounds'] if r['requestId'] == 'request')
    assert before['request']['id'] == 'request-b' and a['outputTaskIds'] == []
    assert a['localRecovery']['requestId'] == 'request' and a['localRecovery']['state'] == 'check_required'
    assert not a['localRecovery']['canRecover']
    capability = client.get('/api/agent/requests/request/local-result-recovery')
    assert capability.status_code == 200 and capability.headers['cache-control'] == 'no-store'
    assert capability.json()['state'] == 'pending' and capability.json()['canRecover']
    b_before = repo.request('request-b')
    branch = before['conversation']['activeRoundId']
    for _ in range(2):
        response = client.post('/api/agent/requests/request/recover-results')
        assert response.status_code == 200, response.text
    after = client.get('/api/agent/conversations/conversation').json()
    a = next(r for r in after['conversation']['rounds'] if r['requestId'] == 'request')
    assert after['conversation']['activeRoundId'] == branch and after['request']['id'] == 'request-b'
    assert repo.request('request-b') == b_before
    assert a['localRecovery']['state'] == 'recovered' and a.get('error') is None
    assert len(after['jobs']) == 1 and after['jobs'][0]['status'] == 'succeeded'
    assert client.get('/api/agent/requests/request/local-result-recovery').json()['state'] == 'recovered'
    assert len(a_calls) == len(b_calls) == 1


@pytest.mark.parametrize('change,expected', [('stop', 'stopped'), ('round', 'deleted'), ('conversation', 'deleted'), ('damage', 'blocked')])
def test_current_capability_refuses_stopped_deleted_or_damaged_historical_results(repo, monkeypatch, change, expected):
    a_calls, b_calls = retained_a_then_b(repo, monkeypatch)
    with connect(repo.library) as conn:
        if change == 'stop':
            conn.execute("UPDATE agent_requests SET stop_requested=1,state='stopped' WHERE id='request'")
        elif change == 'round':
            conn.execute("UPDATE agent_rounds SET deleted=1 WHERE request_id='request'")
        elif change == 'conversation':
            conn.execute("UPDATE agent_conversations SET deleted=1 WHERE id='conversation'")
        else:
            receipt = next((repo.library / 'generation-results').glob('*/native-final.json'))
            record = json.loads(receipt.read_bytes())
            record['result']['sha256'] = '0' * 64
            receipt.write_text(json.dumps(record), encoding='utf8')
    client = TestClient(create_app(library_path=repo.library))
    capability = client.get('/api/agent/requests/request/local-result-recovery').json()
    assert capability['state'] == expected and not capability['canRecover']
    assert client.post('/api/agent/requests/request/recover-results').status_code in {404, 409}
    assert len(a_calls) == len(b_calls) == 1


def test_snapshot_and_stream_projection_do_not_scan_or_decode_recovery_files(repo, monkeypatch):
    retained_a_then_b(repo, monkeypatch)
    import backend.services.agent_native_result_recovery as native
    def forbidden(*args, **kwargs):
        raise AssertionError('A snapshot must not scan local recovery receipts')
    monkeypatch.setattr(native, 'native_receipts_for_request', forbidden)
    snapshots = [repo.snapshot('conversation') for _ in range(3)]
    hints = [view['conversation']['rounds'][0]['localRecovery'] for view in snapshots]
    assert hints[0] == hints[1] == hints[2]
    repo.progress_view('request-b')


def test_scan_budget_exhaustion_is_not_reported_as_absent_or_a_completed_recovery(repo, monkeypatch):
    from backend.services.agent_repository import AgentError
    import backend.services.agent_native_result_recovery as native
    a_calls, b_calls = retained_a_then_b(repo, monkeypatch)
    pages = []
    def unfinished(*args, cursor=None, **kwargs):
        pages.append(cursor)
        return {'job_ids': [], 'blocked': False, 'complete': False, 'next_cursor': str(len(pages))}
    monkeypatch.setattr(native, 'native_receipts_for_request', unfinished)
    with pytest.raises(AgentError) as caught:
        repo.recover_request_results('request')
    assert caught.value.code == 'local_result_scan_incomplete'
    assert len(pages) == 4096
    assert repo.request('request')['error']['code'] == 'local_result_pending'
    assert len(a_calls) == len(b_calls) == 1
