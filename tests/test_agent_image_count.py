"""Desired image quantity is frozen turn intent, never a provider parameter."""
import pytest
from pydantic import ValidationError

from backend.agent_schemas import AgentConfigSave, AgentRoundCreate
from backend.db import connect
from backend.services import agent_execution as execution
from backend.services.agent_repository import AgentError, AgentRepository, encoded, fingerprint
from test_agent_image_selection import repo, body
from test_agent_workflow_execution import application, isolated
from test_agent_workspaces import payload


def set_limit(repo, count):
    current = repo.config()
    repo.save_config(AgentConfigSave.model_validate({'expectedRevision': current['revision'],
        'config': {**current['config'], 'maxImageJobs': count}}))


@pytest.mark.parametrize('count', [1, 3, 5, 10])
def test_desired_count_is_frozen_and_replayed_without_becoming_image_parameter(repo, count):
    set_limit(repo, 10)
    value = body(repo).model_copy(update={'imageCount': count})
    value.authorization = value.authorization.model_copy(update={'maxImageJobs': 10})
    first, created = repo.create_round('conversation', value)
    assert created and first['request']['imageCount'] == count
    request = repo.request('request')
    assert request['body']['imageCount'] == count and request['round']['imageCount'] == count
    assert 'imageCount' not in request['body']['params']
    again, created = repo.create_round('conversation', value)
    assert not created and again['request']['imageCount'] == count
    changed = value.model_copy(update={'imageCount': 3 if count == 1 else 1})
    with pytest.raises(AgentError) as failure:
        repo.create_round('conversation', changed)
    assert failure.value.code == 'request_id_conflict'


@pytest.mark.parametrize('count,limit,budget', [(5, 4, 4), (3, 4, 2)])
def test_count_above_config_or_request_limit_is_rejected_not_truncated(repo, count, limit, budget):
    set_limit(repo, limit)
    value = body(repo).model_copy(update={'imageCount': count})
    value.authorization = value.authorization.model_copy(update={'maxImageJobs': budget})
    with pytest.raises(AgentError) as failure:
        repo.create_round('conversation', value)
    assert failure.value.code == 'authorization_denied' and str(count) in failure.value.message
    with connect(repo.library) as conn:
        assert conn.execute('SELECT count(*) FROM agent_requests').fetchone()[0] == 0
        assert conn.execute('SELECT count(*) FROM generation_jobs').fetchone()[0] == 0


def test_default_one_preserves_legacy_request_identity(repo):
    value = body(repo)
    repo.create_round('conversation', value)
    legacy = value.model_dump(exclude_none=True)
    legacy.pop('imageCount')
    legacy.pop('contextScope')
    legacy.pop('historyRoundIds')
    digest = {key: data for key, data in legacy.items() if key != 'expectedRevision'}
    digest['conversationId'] = 'conversation'
    with connect(repo.library) as conn:
        conn.execute('UPDATE agent_requests SET body=?,fingerprint=? WHERE id=?', (encoded(legacy), fingerprint(digest), 'request'))
    receipt, created = repo.create_round('conversation', value.model_copy(update={'imageCount': 1}))
    assert not created and receipt['request']['imageCount'] == 1


@pytest.mark.parametrize('scope', ['task', 'branch'])
def test_default_and_explicit_one_share_identity_with_context_scope(repo, scope):
    raw = {**body(repo).model_dump(exclude={'imageCount'}), 'contextScope': scope, 'historyRoundIds': []}
    omitted = AgentRoundCreate.model_validate(raw)
    assert 'imageCount' not in omitted.model_fields_set
    first, created = repo.create_round('conversation', omitted)
    assert created and first['request']['imageCount'] == 1
    assert repo.request('request')['body']['contextScope'] == scope
    explicit = AgentRoundCreate.model_validate({**raw, 'imageCount': 1})
    receipt, created = repo.create_round('conversation', explicit)
    assert not created and receipt['request']['imageCount'] == 1
    with pytest.raises(AgentError) as failure:
        repo.create_round('conversation', explicit.model_copy(update={'contextScope': 'branch' if scope == 'task' else 'task'}))
    assert failure.value.code == 'request_id_conflict'


def test_saved_count_never_grants_generation_when_mode_is_off(repo):
    value = body(repo, images=False).model_copy(update={'imageCount': 10})
    repo.create_round('conversation', value)
    assert not any(tool.get('name') in {'generate_image', 'generate_image_batch'} or tool['type'] == 'image_generation'
                   for tool in execution.tools_for(repo.request('request')))


@pytest.mark.parametrize('count', [0, 2, 4, 20, '3'])
def test_count_uses_supported_quantity_choices(repo, count):
    with pytest.raises(ValidationError):
        AgentRoundCreate.model_validate({**body(repo).model_dump(), 'imageCount': count})


def test_three_image_prompt_reaches_shared_queue_as_three_separate_images(isolated, monkeypatch):
    with application(isolated, monkeypatch) as (client, calls, replies):
        snapshot = client.get('/api/agent/conversations/conv').json()
        config = client.get('/api/agent/config').json()
        value = payload(snapshot, config, prompt='方形画面，蓝色陶瓷茶杯，窗边柔光，浅色桌面。')
        value['imageCount'] = 3
        replies.append({'id': 'batch', 'status': 'completed', 'output': [
            {'id': 'batch-tool', 'call_id': 'batch-tool', 'type': 'function_call', 'name': 'generate_image_batch',
             'arguments': encoded({'images': [{'id': str(index), 'prompt': 'Synthetic blue cup'} for index in range(3)],
                                   'finish_after_generation': True})}]})
        response = client.post('/api/agent/conversations/conv/rounds', json=value)
        assert response.status_code == 202, response.text
        execution.run_request(isolated, 'req_1')
        result = client.get('/api/agent/requests/req_1').json()
        assert result['request']['state'] == 'completed' and result['request']['imageCount'] == 3
        assert len(result['jobs']) == 3 and all(job['status'] == 'succeeded' for job in result['jobs'])
        model_body = next(sent for path, sent in calls if path == '/v1/responses')
        assert '"requested_image_count":3' in model_body['instructions']
        image_bodies = [sent for path, sent in calls if path == '/v1/images/generations']
        assert len(image_bodies) == 3
        assert all('imageCount' not in sent and 'requested_image_count' not in sent for sent in image_bodies)
        assert all('imageCount' not in job['parameters'] for job in result['jobs'])
