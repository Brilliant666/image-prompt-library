"""Per-round durable image results and bounded execution timing; no real APIs."""
import json
import sqlite3

import pytest
import httpx

from backend.db import connect
from backend.services import agent_execution as execution
from backend.services import agent_execution_timing as timing
from backend.services.agent_repository import AgentError, AgentRepository
from backend.services.generation_jobs import GenerationJobRepository
from test_agent_execution_correctness import repo, start, transport, terminal, text_result, delta, image_result, new_child
from test_agent_image_selection import body


def make_job(repository, item, status):
    job = execution.create_image_job(repository, 'request', 1, 'images', item, 'Synthetic square', {})
    with connect(repository.library) as conn:
        conn.execute('UPDATE generation_jobs SET status=? WHERE id=?', (status, job.id))
    return job.id


def test_historical_round_uses_own_persisted_results_after_another_round(repo):
    start(repo)
    failed = make_job(repo, 'failed', 'failed')
    accepted = make_job(repo, 'accepted', 'accepted')
    repo.update('request', state='failed', outcome='known', error={'code': 'image_job_failed', 'message': 'synthetic'})
    previous = repo.request('request')['round']['id']
    following = body(repo, 'next', images=False).model_copy(update={'parentRoundId': previous, 'prompt': 'ordinary conversation'})
    repo.create_round('conversation', following)
    repo.update('next', state='completed', outcome='known', text='Synthetic answer')
    snapshot = AgentRepository(repo.library).snapshot('conversation')
    earlier = next(r for r in snapshot['conversation']['rounds'] if r['id'] == previous)
    summary = earlier['resultSummary']
    assert summary['requestState'] == 'failed'
    assert summary['imageJobsCreated'] == 2
    assert summary['imageJobsSucceeded'] == summary['imageJobsAccepted'] == 1
    assert summary['imageJobsFailed'] == 1 and summary['outcome'] == 'images_partial'
    assert snapshot['request']['state'] == 'completed'
    assert {failed, accepted} == set(earlier['outputTaskIds'])


@pytest.mark.parametrize('status,outcome', [('queued', 'waiting'), ('running', 'working'),
                                         ('cancelled', 'stopped'), ('discarded', 'cleared'), ('failed', 'images_failed')])
def test_round_summary_preserves_real_job_states(repo, status, outcome):
    start(repo)
    make_job(repo, 'image', status)
    repo.update('request', state='completed', outcome='known')
    value = repo.snapshot('conversation')['conversation']['rounds'][0]
    assert value['resultSummary']['outcome'] == outcome
    assert value['resultSummary']['imageJobsSucceeded'] == 0
    # No execution instrumentation existed for legacy stored rounds.
    with connect(repo.library) as conn:
        data = json.loads(conn.execute('SELECT data FROM agent_rounds WHERE id=?', (value['id'],)).fetchone()[0])
        data.pop('execution', None)
        conn.execute('UPDATE agent_rounds SET data=? WHERE id=?', (json.dumps(data), value['id']))
    assert AgentRepository(repo.library).snapshot('conversation')['conversation']['rounds'][0]['execution'] is None


def test_all_failed_image_call_does_not_claim_partial_success(repo, monkeypatch):
    start(repo)
    def finish(library, **kwargs):
        with connect(library) as conn:
            conn.execute("UPDATE generation_jobs SET status='failed',error='Synthetic rejection'")
    monkeypatch.setattr('backend.services.generation_queue.enqueue_generation_jobs', finish)
    call = {'type': 'function_call', 'name': 'generate_image_batch', 'call_id': 'images',
            'arguments': json.dumps({'images': [{'id': 'one', 'prompt': 'Synthetic square'}]})}
    with pytest.raises(AgentError, match='本次未生成图片'):
        execution.execute_calls(repo, 'request', 1, [call], {})


def test_model_timing_survives_new_repository_and_terminal_stream_close(repo, monkeypatch):
    start(repo)
    calls = transport(monkeypatch, events=[terminal([text_result()])])
    execution.run_request(repo.library, 'request')
    value = AgentRepository(repo.library).snapshot('conversation')['conversation']['rounds'][0]
    assert value['resultSummary']['textCompleted']
    measured = value['execution']
    assert measured['phase'] == 'completed'
    step = measured['modelSteps'][0]
    assert step['state'] == 'completed'
    assert 0 <= step['headersMs'] <= step['firstEventMs'] <= step['responseMs']
    assert step['preparationMs'] >= 0 and len(calls) == 1
    assert 'monotonic' not in json.dumps(measured)


@pytest.mark.parametrize('events_count', [1, 40])
def test_monotonic_model_milestones_are_exact_and_writes_bounded(repo, monkeypatch, events_count):
    start(repo)
    clock = [100.0]
    monkeypatch.setattr(timing, 'monotonic', lambda: clock[0])
    writes = []
    original = AgentRepository.record_execution
    def record(self, *args, **kwargs):
        writes.append(kwargs)
        return original(self, *args, **kwargs)
    monkeypatch.setattr(AgentRepository, 'record_execution', record)
    class Stream(httpx.SyncByteStream):
        def __iter__(self):
            clock[0] += 0.3
            yield ('data: ' + json.dumps({'type': 'response.created', 'response': {'id': 'response'}}) + '\n\n').encode()
            for i in range(events_count):
                yield ('data: ' + json.dumps(delta('x', sequence=i)) + '\n\n').encode()
            clock[0] += 0.5
            yield ('data: ' + json.dumps(terminal()) + '\n\n').encode()
    calls = []
    def handler(request):
        calls.append(request)
        clock[0] += 0.2
        return httpx.Response(200, headers={'content-type': 'text/event-stream'}, stream=Stream())
    monkeypatch.setattr(httpx, 'HTTPTransport', lambda **kwargs: httpx.MockTransport(handler))
    execution.run_request(repo.library, 'request')
    value = repo.snapshot('conversation')['conversation']['rounds'][0]
    step = value['execution']['modelSteps'][0]
    assert (step['headersMs'], step['firstEventMs'], step['responseMs']) == (200, 500, 1000)
    assert repo.request('request')['round']['assistantContent'] == 'x' * events_count
    assert len(writes) <= 9 and len(calls) == 1


@pytest.mark.parametrize('http_status,code,kind', [(402, 'insufficient_quota', 'quota'),
                                               (404, 'model_not_found', 'model_unsupported'),
                                               (400, 'moderation_blocked', 'moderation')])
def test_native_failure_has_safe_structured_reason_and_durable_timing(repo, monkeypatch, http_status, code, kind):
    start(repo, native=True)
    job = new_child(repo)
    calls = []
    def handler(request):
        calls.append(request)
        return httpx.Response(http_status, json={'error': {'code': code, 'message': 'private synthetic prompt sk-secret',
                                                         'details': {'url': 'https://secret.invalid'}}})
    monkeypatch.setattr(httpx, 'HTTPTransport', lambda **kwargs: httpx.MockTransport(handler))
    with pytest.raises(AgentError):
        execution.NativeAgentImageProvider().run_job(repo.library, job.id)
    stored = repo.jobs.get_job(job.id)
    assert stored.metadata['failure']['kind'] == kind
    assert stored.metadata['execution']['phase'] == 'failed'
    assert stored.metadata['execution']['timings']['providerMs'] >= 0
    assert 'private synthetic' not in json.dumps(stored.metadata)
    assert 'secret.invalid' not in json.dumps(stored.metadata)
    repo.update('request', state='failed', outcome='known', error={'code': 'image_job_failed', 'message': 'Synthetic failure'})
    round_data = AgentRepository(repo.library).snapshot('conversation')['conversation']['rounds'][0]
    assert round_data['failure']['kind'] == kind and round_data['resultSummary']['outcome'] == 'images_failed'
    with pytest.raises(AgentError):
        execution.NativeAgentImageProvider().run_job(repo.library, job.id)
    assert len(calls) == 1


def test_native_timeout_is_unknown_and_not_safe_retry(repo, monkeypatch):
    start(repo, native=True)
    job = new_child(repo)
    calls = transport(monkeypatch, events=[], error=httpx.ReadTimeout('synthetic disconnect'))
    with pytest.raises(httpx.ReadTimeout):
        execution.NativeAgentImageProvider().run_job(repo.library, job.id)
    repo.update('request', state='failed', outcome='known', error={'code': 'image_job_failed', 'message': 'Synthetic failure'})
    value = repo.snapshot('conversation')['conversation']['rounds'][0]
    assert value['resultSummary']['outcomeUnknown'] and value['resultSummary']['outcome'] == 'unknown'
    assert value['failure']['outcomeUnknown']
    assert repo.jobs.get_job(job.id).metadata['execution']['phase'] == 'unknown'
    execution.recover_agent_requests(repo.library)
    assert len(calls) == 1


def test_recovery_marks_unfinished_timer_without_inventing_duration(repo, monkeypatch):
    start(repo)
    repo.update('request', state='running', outcome='unknown')
    measured = timing.ModelTiming(repo, 'request', 1)
    measured.start_http()
    assert not repo.snapshot('conversation')['conversation']['rounds'][0]['resultSummary']['outcomeUnknown']
    monkeypatch.setattr(execution, 'schedule_request', lambda *args: pytest.fail('unknown request replayed'))
    execution.recover_agent_requests(repo.library)
    value = AgentRepository(repo.library).snapshot('conversation')['conversation']['rounds'][0]
    assert value['execution']['phase'] == value['resultSummary']['outcome'] == 'unknown'
    assert value['execution']['modelSteps'][0]['state'] == 'interrupted'
    assert value['execution']['timings']['modelResponseMs'] is None


def test_native_completion_timing_and_result_are_stable_after_close_timeout(repo, monkeypatch):
    start(repo, native=True)
    job = new_child(repo)
    calls = transport(monkeypatch, events=[terminal([image_result()])], close_error=httpx.ReadTimeout('closing'))
    result = execution.NativeAgentImageProvider().run_job(repo.library, job.id)
    assert result.status == 'succeeded'
    measured = result.metadata['execution']
    assert measured['phase'] == 'completed'
    assert all(measured['timings'][key] >= 0 for key in ('preparationMs', 'providerMs', 'resultWriteMs'))
    assert len(calls) == 1


def test_missing_job_is_unknown_not_success_or_cleared(repo):
    start(repo)
    job_id = make_job(repo, 'missing', 'succeeded')
    with connect(repo.library) as conn:
        conn.execute('DELETE FROM agent_tool_jobs WHERE job_id=?', (job_id,))
        conn.execute('DELETE FROM generation_jobs WHERE id=?', (job_id,))
    repo.update('request', state='completed', outcome='known')
    summary = repo.snapshot('conversation')['conversation']['rounds'][0]['resultSummary']
    assert summary['imageJobsMissing'] == 1 and summary['imageJobsSucceeded'] == 0
    assert summary['outcomeUnknown'] and summary['outcome'] == 'unknown'


def test_native_recovery_keeps_image_outcome_unknown_without_estimated_time(repo, monkeypatch):
    start(repo, native=True)
    job = execution.create_image_job(repo, 'request', 1, 'native', 'single', 'Synthetic image', {}, native=True)
    repo.jobs.mark_running(job.id)
    repo.update('request', state='running', outcome='unknown')
    monkeypatch.setattr(execution, 'schedule_request', lambda *args: pytest.fail('unknown image replayed'))
    execution.recover_agent_requests(repo.library)
    stored = repo.jobs.get_job(job.id)
    assert stored.status == 'failed' and stored.metadata['failure']['outcomeUnknown']
    assert stored.metadata['execution']['phase'] == 'unknown'
    assert stored.metadata['execution']['timings']['providerMs'] is None
    assert repo.snapshot('conversation')['conversation']['rounds'][0]['resultSummary']['outcome'] == 'unknown'


def broken_measurement(*args, **kwargs):
    raise sqlite3.OperationalError('synthetic private database path and prompt')


def test_native_metrics_storage_error_cannot_change_success_or_repeat_post(repo, monkeypatch, caplog):
    start(repo, native=True)
    job = new_child(repo)
    monkeypatch.setattr(GenerationJobRepository, '_record_execution', broken_measurement)
    calls = transport(monkeypatch, events=[terminal([image_result()])])
    result = execution.NativeAgentImageProvider().run_job(repo.library, job.id)
    assert result.status == repo.jobs.get_job(job.id).status == 'succeeded'
    with pytest.raises(AgentError):
        execution.NativeAgentImageProvider().run_job(repo.library, job.id)
    assert len(calls) == 1
    assert 'OperationalError' in caplog.text and 'synthetic private' not in caplog.text
    assert result.metadata['execution']['timings']['providerMs'] is None


def test_native_metrics_storage_error_cannot_leave_failed_job_running(repo, monkeypatch, caplog):
    start(repo, native=True)
    job = new_child(repo)
    monkeypatch.setattr(GenerationJobRepository, '_record_execution', broken_measurement)
    calls = transport(monkeypatch, payload={'status': 'failed', 'error': {'code': 'insufficient_quota'}})
    with pytest.raises(AgentError):
        execution.NativeAgentImageProvider().run_job(repo.library, job.id)
    assert repo.jobs.get_job(job.id).status == 'failed'
    assert repo.jobs.get_job(job.id).metadata['failure']['kind'] == 'quota'
    assert len(calls) == 1 and 'OperationalError' in caplog.text


@pytest.mark.parametrize('succeeded', [True, False])
def test_request_metrics_storage_error_never_changes_business_terminal(repo, monkeypatch, caplog, succeeded):
    start(repo, native=True)
    monkeypatch.setattr(GenerationJobRepository, '_record_execution', broken_measurement)
    monkeypatch.setattr(AgentRepository, '_record_execution', broken_measurement)
    events = [{'type': 'response.output_item.added', 'item': {**image_result(), 'result': None, 'status': 'in_progress'}},
              terminal([image_result()], status='completed' if succeeded else 'failed')]
    calls = transport(monkeypatch, events=events)
    execution.run_request(repo.library, 'request')
    request = repo.request('request')
    assert request['state'] == ('completed' if succeeded else 'failed')
    assert request['upstream_outcome'] == 'known'
    assert repo.jobs.get_job(request['round']['outputTaskIds'][0]).status == ('succeeded' if succeeded else 'failed')
    assert request['round']['execution']['modelSteps'] == []
    assert 'OperationalError' in caplog.text and 'synthetic private' not in caplog.text
    assert execution.key_for(repo.library, 'request') not in execution._clients
    execution.recover_agent_requests(repo.library)
    assert len(calls) == 1


def test_metrics_programming_errors_are_not_hidden(repo, monkeypatch):
    start(repo)
    def programming_error(*args, **kwargs):
        raise TypeError('invalid instrumentation implementation')
    monkeypatch.setattr(AgentRepository, '_record_execution', programming_error)
    with pytest.raises(TypeError, match='invalid instrumentation'):
        repo.record_execution('request', phase='preparing')
