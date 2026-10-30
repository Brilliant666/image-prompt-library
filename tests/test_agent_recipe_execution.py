"""Confirmed recipe execution uses real existing providers with mocked HTTP only."""
import base64
from concurrent.futures import ThreadPoolExecutor
from email.parser import BytesParser
from email.policy import default
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from backend.agent_schemas import AgentConfigSave, AgentPromptExecutionCreate, AgentTaskContextPatch
from backend.db import connect
from backend.main import create_app
from backend.services import agent_execution as execution
from backend.services.agent_repository import AgentError, AgentRepository
from test_agent_image_selection import repo, set_mode
from test_agent_workspaces import image_bytes

EXACT = '  Exact selected Prompt\nKeep punctuation: <ref id="round-1-reference-1" />  '


def prepare(repo, *, native=False, count=1, refs=2, exact=EXACT):
    if native:
        set_mode(repo, 'native')
    if count > repo.config()['config']['maxImageJobs']:
        config = repo.config()
        repo.save_config(AgentConfigSave(expectedRevision=config['revision'],
            config={**config['config'], 'maxImageJobs': count}))
    images = [repo.store_asset(image_bytes(color), None)['id'] for color in ('red', 'blue', 'green')[:refs]]
    snapshot = repo.snapshot('conversation')
    operations = [{'op': 'new_task', 'text': 'Original user wording', 'taskType': 'prompt'},
                  {'op': 'set_prompt', 'text': exact, 'kind': 'selected'}]
    if images:
        operations.append({'op': 'set_target', 'ref': {'kind': 'upload', 'uploadId': images[0]}})
        operations.append({'op': 'set_auxiliaries', 'auxiliaries': [
            {'ref': {'kind': 'upload', 'uploadId': image}, 'role': 'lighting' if index == 0 else 'composition'}
            for index, image in enumerate(images[1:])]})
    selected = repo.patch_task_context('conversation', AgentTaskContextPatch(expectedRevision=snapshot['revision'],
        branchRoundId=None, taskRevision=snapshot['taskContext']['revision'], operations=operations))
    state = selected['taskContext']
    value = {'requestId': 'direct', 'expectedRevision': selected['revision'], 'branchRoundId': None,
             'taskId': state['taskId'], 'taskRevision': state['revision'], 'promptVersionId': state['selectedPromptVersionId'],
             'configRevision': repo.config()['revision'], 'imageCount': count, 'confirmed': True,
             'params': {'size': '1024x1024', 'quality': 'auto', 'output_format': 'jpeg', 'output_compression': 0}}
    return value, images


def mock_provider(monkeypatch, *, native=False, error=False):
    calls = []
    def respond(request):
        assert request.method == 'POST' and request.url.host == '127.0.0.1'
        content_type = request.headers.get('content-type', '')
        if 'multipart/form-data' in content_type:
            parts = BytesParser(policy=default).parsebytes(('Content-Type: ' + content_type + '\r\n\r\n').encode() + request.content)
            value = [(part.get_param('name', header='content-disposition'), part.get_payload(decode=True)) for part in parts.iter_parts()]
        else:
            value = json.loads(request.content)
        calls.append((request.url.path, value))
        if error == 'quota':
            return httpx.Response(402, json={'error': {'code': 'insufficient_quota', 'message': 'Synthetic known failure'}})
        if error:
            raise httpx.ReadTimeout('Synthetic ambiguous submission', request=request)
        if native:
            assert request.url.path == '/v1/responses'
            return httpx.Response(200, json={'id': 'native-response', 'status': 'completed', 'output': [
                {'id': 'native-image', 'type': 'image_generation_call', 'status': 'completed',
                 'result': base64.b64encode(image_bytes('orange')).decode()}]})
        assert request.url.path in {'/v1/images/edits', '/v1/images/generations'}
        return httpx.Response(200, json={'data': [{'b64_json': base64.b64encode(image_bytes('orange')).decode()}]})
    monkeypatch.setattr(httpx, 'HTTPTransport', lambda **kw: httpx.MockTransport(respond))
    return calls


@pytest.mark.parametrize('native', [False, True])
@pytest.mark.parametrize('count', [1, 3, 5, 10])
def test_direct_exact_prompt_role_order_params_and_count_reach_existing_provider_without_text_post(repo, monkeypatch, native, count):
    value, images = prepare(repo, native=native, count=count, refs=3)
    before = repo.snapshot('conversation')['taskContext']
    calls = mock_provider(monkeypatch, native=native)
    snapshot, created = repo.create_prompt_execution('conversation', AgentPromptExecutionCreate.model_validate(value))
    assert created and snapshot['request']['state'] == 'queued' and calls == []
    operation = snapshot['conversation']['rounds'][-1]
    recipe = operation['directRecipe']
    assert operation['kind'] == 'prompt_execution'
    assert recipe['prompt'] == EXACT and recipe['promptVersionId'] == value['promptVersionId']
    assert [r['assetId'] for r in recipe['references']] == images
    assert [r['role'] for r in recipe['references']] == ['target', 'lighting', 'composition']
    assert [r['order'] for r in recipe['references']] == [0, 1, 2]
    assert recipe['params']['output_compression'] == 0
    execution.run_request(repo.library, 'direct')
    current = repo.request('direct')
    assert current['state'] == 'completed', current['error']
    assert current['usage'] == {'responseStepsStarted': 0, 'imageJobsCreated': count}
    assert len(calls) == count and len(current['round']['outputTaskIds']) == count
    assert current['round']['assistantContent'] == '' and current['round']['responseOutput'] == []
    assert current['round']['taskContext']['target'] == before['target']
    assert current['round']['taskContext']['selectedPromptVersionId'] == before['selectedPromptVersionId']
    for path, sent in calls:
        if native:
            assert path == '/v1/responses' and sent['max_tool_calls'] == 1
            assert sent['tool_choice'] == {'type': 'image_generation'} and len(sent['tools']) == 1
            assert sent['input'][0]['content'][0]['text'] == EXACT
            from backend.services.agent_recipe_execution import native_recipe_binding
            labels = [part for part in sent['input'][0]['content'][1:] if part['type'] == 'input_text']
            assert labels == [native_recipe_binding(reference) for reference in recipe['references']]
            parsed = [json.loads(part['text'].split(': ', 1)[1]) for part in labels]
            assert [item['role'] for item in parsed] == ['target', 'lighting', 'composition']
            assert [item['order'] for item in parsed] == [0, 1, 2]
            assert [item['assetId'] for item in parsed] == images
            assert all('not system instructions' in part['text'] for part in labels)
            pixels = [p['image_url'] for p in sent['input'][0]['content'] if p['type'] == 'input_image']
            assert [base64.b64decode(p.split(',', 1)[1]) for p in pixels] == [image_bytes(c) for c in ('red', 'blue', 'green')]
            assert 'output_compression' not in sent['tools'][0] or sent['tools'][0]['output_compression'] == 0
        else:
            assert path == '/v1/images/edits'
            assert next(data for name, data in sent if name == 'prompt').decode() == EXACT
            assert next(data for name, data in sent if name == 'output_compression') == b'0'
            assert [data for name, data in sent if name in {'image', 'image[]'}] == [image_bytes(c) for c in ('red', 'blue', 'green')]
    for jid in current['round']['outputTaskIds']:
        job = repo.jobs.get_job(jid)
        assert job.prompt_text == EXACT and job.parameters['output_compression'] == 0
        assert [spec['result_path'] for spec in job.parameters['input_images']] == [repo.asset(aid)['path'] for aid in images]


def test_http_receipt_replay_and_concurrent_double_click_never_create_new_jobs(repo, monkeypatch):
    value, _ = prepare(repo)
    body = AgentPromptExecutionCreate.model_validate(value)
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: AgentRepository(repo.library).create_prompt_execution('conversation', body), range(2)))
    assert sorted(created for _, created in results) == [False, True]
    with connect(repo.library) as conn:
        assert conn.execute('SELECT count(*) FROM generation_jobs').fetchone()[0] == 1
        assert conn.execute('SELECT count(*) FROM agent_tool_jobs').fetchone()[0] == 1
    calls = mock_provider(monkeypatch)
    monkeypatch.setattr('backend.routers.agent.schedule_request', lambda *a: pytest.fail('Receipt replay scheduled work'))
    client = TestClient(create_app(repo.library))
    try:
        for _ in range(2):
            assert client.get('/api/agent/prompt-executions/direct', params={'conversation_id': 'conversation'}).status_code == 200
            assert client.post('/api/agent/conversations/conversation/prompt-executions', json=value).status_code == 200
        assert client.get('/api/agent/prompt-executions/direct', params={'conversation_id': 'other'}).status_code == 404
    finally:
        client.close()
    assert calls == []
    changed = {**value, 'imageCount': 3}
    with pytest.raises(AgentError) as conflict:
        repo.create_prompt_execution('conversation', AgentPromptExecutionCreate.model_validate(changed))
    assert conflict.value.code == 'request_id_conflict'


@pytest.mark.parametrize('mutation', ['revision', 'task', 'prompt', 'config', 'unresolved', 'missing', 'corrupt'])
def test_invalid_recipe_never_creates_partial_receipt_or_dispatches(repo, monkeypatch, mutation):
    value, images = prepare(repo)
    if mutation == 'revision': value['expectedRevision'] += 1
    elif mutation == 'task': value['taskRevision'] += 1
    elif mutation == 'prompt': value['promptVersionId'] = 'candidate-not-selected'
    elif mutation == 'config': value['configRevision'] += 1
    elif mutation == 'unresolved':
        snapshot = repo.snapshot('conversation')
        changed = repo.patch_task_context('conversation', AgentTaskContextPatch(expectedRevision=snapshot['revision'],
            taskRevision=snapshot['taskContext']['revision'], operations=[{'op': 'set_unresolved', 'items': ['Which target?']}]))
        value.update(expectedRevision=changed['revision'], taskRevision=changed['taskContext']['revision'])
    elif mutation == 'missing': (repo.library / repo.asset(images[0])['path']).unlink()
    else: (repo.library / repo.asset(images[0])['path']).write_bytes(image_bytes('purple'))
    calls = mock_provider(monkeypatch)
    with pytest.raises(AgentError):
        repo.create_prompt_execution('conversation', AgentPromptExecutionCreate.model_validate(value))
    with connect(repo.library) as conn:
        assert conn.execute('SELECT count(*) FROM agent_requests').fetchone()[0] == 0
        assert conn.execute('SELECT count(*) FROM generation_jobs').fetchone()[0] == 0
    assert calls == []


@pytest.mark.parametrize('native', [False, True])
def test_ambiguous_paid_outcome_keeps_target_and_identity_and_never_replays(repo, monkeypatch, native):
    value, _ = prepare(repo, native=native)
    before = repo.snapshot('conversation')['taskContext']['target']
    calls = mock_provider(monkeypatch, native=native, error=True)
    repo.create_prompt_execution('conversation', AgentPromptExecutionCreate.model_validate(value))
    execution.run_request(repo.library, 'direct')
    current = repo.request('direct')
    assert current['state'] == 'unknown', current['error']
    assert len(calls) == 1 and current['round']['taskContext']['target'] == before
    state = current['round']['taskContext']
    assert next(p for p in state['promptVersions'] if p['id'] == state['executedPromptVersionId'])['text'] == EXACT
    snapshot, created = repo.create_prompt_execution('conversation', AgentPromptExecutionCreate.model_validate(value))
    assert not created and snapshot['request']['state'] == 'unknown'
    execution.run_request(repo.library, 'direct')
    assert len(calls) == 1
    with pytest.raises(AgentError): repo.resume('direct', 'unsafe')


def test_http_creation_schedules_once_and_only_uses_server_selected_prompt(repo, monkeypatch):
    value, _ = prepare(repo)
    scheduled = []
    monkeypatch.setattr('backend.routers.agent.schedule_request', lambda *args: scheduled.append(args))
    client = TestClient(create_app(repo.library))
    try:
        assert client.post('/api/agent/conversations/conversation/prompt-executions', json={**value, 'prompt': 'Override'}).status_code == 422
        assert client.post('/api/agent/conversations/conversation/prompt-executions', json={**value, 'confirmed': False}).status_code == 422
        response = client.post('/api/agent/conversations/conversation/prompt-executions', json=value)
        assert response.status_code == 202, response.text
        assert len(scheduled) == 1
        assert response.json()['conversation']['rounds'][-1]['directRecipe']['prompt'] == EXACT
        for _ in range(2):
            assert client.post('/api/agent/conversations/conversation/prompt-executions', json=value).status_code == 200
            assert client.get('/api/agent/prompt-executions/direct', params={'conversation_id': 'conversation'}).status_code == 200
        assert len(scheduled) == 1
    finally:
        client.close()


def test_profile_change_and_missing_asset_after_enqueue_fail_before_provider_post(repo, monkeypatch):
    from backend.services.openai_compatible import OpenAICompatibleConfig
    value, _ = prepare(repo)
    repo.create_prompt_execution('conversation', AgentPromptExecutionCreate.model_validate(value))
    store = OpenAICompatibleConfig(library_path=repo.library)
    store.save({'model': 'different-model'}, profile_id='image_a')
    calls = mock_provider(monkeypatch)
    execution.run_request(repo.library, 'direct')
    assert calls == [] and repo.request('direct')['state'] == 'failed'
    assert repo.request('direct')['error']['code'] == 'profile_changed'
    assert repo.request('direct')['round']['taskContext']['executedPromptVersionId'] is None


@pytest.mark.parametrize('native', [False, True])
def test_queued_recipe_bytes_changed_before_provider_claim_never_submit(repo, monkeypatch, native):
    value, images = prepare(repo, native=native)
    repo.create_prompt_execution('conversation', AgentPromptExecutionCreate.model_validate(value))
    current = repo.request('direct')
    (repo.library / repo.asset(images[0])['path']).write_bytes(image_bytes('purple'))
    calls = mock_provider(monkeypatch, native=native)
    job_id = current['round']['outputTaskIds'][0]
    with pytest.raises(AgentError):
        if native: execution.NativeAgentImageProvider().run_job(repo.library, job_id)
        else: execution.run_compatible_agent_job(repo.library, job_id)
    assert calls == []
    assert repo.request('direct')['round']['taskContext']['executedPromptVersionId'] is None


def test_native_late_duplicate_claim_never_restarts_a_failed_paid_job(repo, monkeypatch):
    from backend.services.generation_jobs import GenerationJobRepository, GenerationJobConflict
    value, _ = prepare(repo, native=True)
    repo.create_prompt_execution('conversation', AgentPromptExecutionCreate.model_validate(value))
    job_id = repo.request('direct')['round']['outputTaskIds'][0]
    original = GenerationJobRepository.mark_running
    claims = []
    def raced(self, selected_id, *, queued_only=False):
        claims.append(queued_only)
        self.mark_failed(selected_id, 'Another worker already finished this paid attempt', diagnostics={'http_status': 402})
        return original(self, selected_id, queued_only=queued_only)
    monkeypatch.setattr(GenerationJobRepository, 'mark_running', raced)
    calls = mock_provider(monkeypatch, native=True)
    with pytest.raises(GenerationJobConflict):
        execution.NativeAgentImageProvider().run_job(repo.library, job_id)
    assert claims == [True] and calls == [] and repo.jobs.get_job(job_id).status == 'failed'


@pytest.mark.parametrize('native', [False, True])
def test_actual_dispatch_and_retry_keep_source_version_without_overwriting_new_task(repo, monkeypatch, native):
    from backend.services.agent_image_retry import AgentImageRetryCreate, AgentImageRetryRepository, run_agent_image_retry
    value, _ = prepare(repo, native=native)
    failed_calls = mock_provider(monkeypatch, native=native, error='quota')
    repo.create_prompt_execution('conversation', AgentPromptExecutionCreate.model_validate(value))
    execution.run_request(repo.library, 'direct')
    source = repo.request('direct')
    assert source['state'] == 'failed' and len(failed_calls) == 1
    source_job = repo.jobs.get_job(source['round']['outputTaskIds'][0])
    provenance = source_job.metadata['recipeDispatch']
    assert provenance['promptVersionId'] == value['promptVersionId']
    assert provenance['executedPromptVersionId'] == source['round']['taskContext']['executedPromptVersionId']
    snapshot = repo.snapshot('conversation')
    latest = repo.patch_task_context('conversation', AgentTaskContextPatch(expectedRevision=snapshot['revision'],
        branchRoundId=source['round_id'], taskRevision=snapshot['taskContext']['revision'], operations=[
            {'op': 'new_task', 'text': 'New current task', 'taskType': 'prompt'},
            {'op': 'set_prompt', 'text': 'New selected wording', 'kind': 'selected'}]))['taskContext']
    retry_body = AgentImageRetryCreate.model_validate({'retryId': 'explicit-retry', 'conversationId': 'conversation',
        'configRevision': repo.config()['revision'], 'imageConfig': {'model': 'gpt-image-agent'}, 'params': value['params'], 'confirmed': True})
    retry, created = AgentImageRetryRepository(repo.library).create(source_job.id, retry_body)
    assert created
    assert retry['job'].metadata['agentRetry']['confirmedRecipe']['promptVersionId'] == value['promptVersionId']
    successful_calls = mock_provider(monkeypatch, native=native)
    result = run_agent_image_retry(repo.library, retry['job'].id)
    assert result.status == 'succeeded' and len(successful_calls) == 1
    assert result.prompt_text == EXACT and result.metadata['recipeDispatch']['promptVersionId'] == value['promptVersionId']
    if native:
        before_content = failed_calls[0][1]['input'][0]['content']
        after_content = successful_calls[0][1]['input'][0]['content']
        assert after_content == before_content
        assert [json.loads(part['text'].split(': ', 1)[1])['role'] for part in after_content[1:] if part['type'] == 'input_text'] == ['target', 'lighting']
    assert repo.snapshot('conversation')['taskContext'] == latest
    source_state = repo.request('direct')['round']['taskContext']
    assert next(p for p in source_state['promptVersions'] if p['id'] == source_state['executedPromptVersionId'])['text'] == EXACT


def test_confirmed_full_recipe_can_execute_without_deleting_chat_evidence(repo, monkeypatch):
    value, _ = prepare(repo)
    from backend.services.agent_repository import encoded
    snapshot = repo.snapshot('conversation')
    with connect(repo.library) as conn:
        saved = dict(snapshot['taskContext'], completeness='history_required',
                     historyDependencies=[{'roundId': 'historical-evidence', 'reason': 'unreconciled_user_addition'}])
        conn.execute('UPDATE agent_conversations SET editing_tasks=? WHERE id=?',
            (encoded({'__root__': {'_kind': 'agent-task-context-v1', 'taskContext': saved,
                                   'editingTask': snapshot['editingTask']}}), 'conversation'))
    calls = mock_provider(monkeypatch)
    created, _ = repo.create_prompt_execution('conversation', AgentPromptExecutionCreate.model_validate(value))
    assert created['conversation']['rounds'][-1]['directRecipe']['confirmation']['completeRecipe']
    execution.run_request(repo.library, 'direct')
    assert len(calls) == 1 and repo.request('direct')['state'] == 'completed'
    assert repo.request('direct')['round']['taskContext']['historyDependencies'] == saved['historyDependencies']


@pytest.mark.parametrize('reason', ['target_changed_requires_prior_evidence', 'legacy_requirements_in_history', 'legacy_context_missing'])
def test_confirmed_prompt_cannot_hide_necessary_visual_or_overflow_evidence(repo, monkeypatch, reason):
    from backend.services.agent_repository import encoded
    value, _ = prepare(repo)
    snapshot = repo.snapshot('conversation')
    with connect(repo.library) as conn:
        saved = dict(snapshot['taskContext'], completeness='history_required', historyDependencies=[{'roundId': 'source', 'reason': reason}])
        conn.execute('UPDATE agent_conversations SET editing_tasks=? WHERE id=?', (encoded({'__root__': {
            '_kind': 'agent-task-context-v1', 'taskContext': saved, 'editingTask': snapshot['editingTask']}}), 'conversation'))
    calls = mock_provider(monkeypatch)
    with pytest.raises(AgentError) as incomplete:
        repo.create_prompt_execution('conversation', AgentPromptExecutionCreate.model_validate(value))
    assert incomplete.value.code == 'task_incomplete' and calls == []


def test_current_api_direct_mode_reports_explicit_limitation_without_switching_protocol(repo, monkeypatch):
    set_mode(repo, 'off')
    value, _ = prepare(repo)
    calls = mock_provider(monkeypatch)
    with pytest.raises(AgentError) as unsupported:
        repo.create_prompt_execution('conversation', AgentPromptExecutionCreate.model_validate(value))
    assert unsupported.value.code == 'capability_unsupported'
    assert 'Current API' in unsupported.value.message and '普通会话' in unsupported.value.message
    assert calls == []


def test_native_mask_source_is_rejected_without_silent_protocol_or_pixel_change(repo, monkeypatch):
    from backend.agent_schemas import AgentMask, AgentRef
    from test_agent_image_selection import body
    set_mode(repo, 'native')
    image = repo.store_asset(image_bytes('red'), None)['id']
    mask = repo.store_asset(image_bytes((0, 0, 0, 0), 'RGBA'), None, 'mask')['id']
    original = body(repo, 'masked').model_copy(update={'prompt': 'Edit the masked image',
        'refs': [AgentRef(kind='upload', uploadId=image)], 'mask': AgentMask(targetRefIndex=0, uploadId=mask)})
    repo.create_round('conversation', original)
    repo.update('masked', state='completed', outcome='known')
    snapshot = repo.snapshot('conversation')
    selected = repo.patch_task_context('conversation', AgentTaskContextPatch(expectedRevision=snapshot['revision'],
        branchRoundId=snapshot['conversation']['activeRoundId'], taskRevision=snapshot['taskContext']['revision'],
        operations=[{'op': 'set_prompt', 'text': 'Selected exact masked edit', 'kind': 'selected'}]))
    task = selected['taskContext']
    value = AgentPromptExecutionCreate.model_validate({'requestId': 'masked-direct', 'expectedRevision': selected['revision'],
        'branchRoundId': selected['conversation']['activeRoundId'], 'taskId': task['taskId'], 'taskRevision': task['revision'],
        'promptVersionId': task['selectedPromptVersionId'], 'configRevision': repo.config()['revision'],
        'params': {'size': '1024x1024', 'quality': 'auto'}, 'imageCount': 1, 'confirmed': True})
    calls = mock_provider(monkeypatch, native=True)
    with pytest.raises(AgentError) as unsupported:
        repo.create_prompt_execution('conversation', value)
    assert unsupported.value.code == 'capability_unsupported' and calls == []


@pytest.mark.parametrize('native', [False, True])
def test_prompt_only_recipe_submits_exact_text_without_any_implicit_image(repo, monkeypatch, native):
    exact = '  Prompt-only selected wording\nKeep exact line breaks.  '
    value, _ = prepare(repo, native=native, refs=0, exact=exact)
    calls = mock_provider(monkeypatch, native=native)
    repo.create_prompt_execution('conversation', AgentPromptExecutionCreate.model_validate(value))
    execution.run_request(repo.library, 'direct')
    assert repo.request('direct')['state'] == 'completed' and len(calls) == 1
    path, sent = calls[0]
    if native:
        assert sent['input'][0]['content'] == [{'type': 'input_text', 'text': exact}]
    else:
        assert path == '/v1/images/generations' and sent['prompt'] == exact
    recipe = repo.request('direct')['round']['directRecipe']
    assert recipe['references'] == [] and recipe['prompt'] == exact
