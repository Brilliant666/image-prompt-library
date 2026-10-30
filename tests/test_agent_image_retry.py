import base64
import hashlib
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
import json
from threading import Event

import httpx
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from backend.agent_schemas import AgentRoundCreate
from backend.db import connect
from backend.main import create_app
from backend.services.agent_execution import create_image_job
from backend.services.agent_image_retry import AgentImageRetryCreate, AgentImageRetryRepository
from backend.services.agent_repository import AgentError, AgentRepository
from backend.services.generation_jobs import GenerationJobConflict
from backend.services.generation_queue import _run_provider_job
from backend.services.openai_compatible import OpenAICompatibleConfig, OpenAICompatibleProvider
from test_agent_workspaces import configure, image_bytes, isolated, payload


def mask_bytes():
    with Image.open(BytesIO(image_bytes('white'))) as original:
        buffer = BytesIO()
        original.convert('RGBA').save(buffer, format='PNG')
        return buffer.getvalue()


@pytest.fixture
def source(isolated, monkeypatch, request):
    # Endpoint tests explicitly drive the existing queue dispatcher; no thread
    # or real network can race an assertion or submit an unexpected request.
    monkeypatch.setattr('backend.routers.agent_image_retry.enqueue_generation_jobs', lambda *a, **k: None)
    monkeypatch.setattr('backend.routers.generation_jobs.enqueue_metadata_jobs', lambda *a, **k: None)
    client = TestClient(create_app(isolated))
    native = getattr(request, 'param', None) in {'native', 'native_batch', 'native_mask'}
    config = configure(client, isolated, 'http://127.0.0.1:1/v1', 'native' if native else 'hybrid')
    store = OpenAICompatibleConfig(library_path=isolated)
    store.save({'base_url': 'http://127.0.0.1:2/v1', 'api_key': 'qa-key-b', 'model': 'gpt-image-b', 'display_name': 'Synthetic B'}, profile_id='mock-b')
    repo = AgentRepository(isolated)
    snapshot = client.post('/api/agent/conversations', json={'id': 'conv'}).json()
    image = repo.store_asset(image_bytes('blue'), None)
    body = payload(snapshot, config, prompt='User question differs from execution prompt')
    body['refs'] = [{'kind': 'upload', 'uploadId': image['id']}]
    refs = {'round-1-reference-1': image['id']}
    execution_prompt = '  EXACT execution\n<ref id="round-1-reference-1" />  '
    if getattr(request, 'param', None) == 'native_mask':
        mask = repo.store_asset(mask_bytes(), None)
        body['mask'] = {'targetRefIndex': 0, 'uploadId': mask['id']}
    if getattr(request, 'param', None) == 'two-images':
        second = repo.store_asset(image_bytes('red'), None)
        body['refs'].append({'kind': 'upload', 'uploadId': second['id']})
        refs['round-1-reference-2'] = second['id']
        execution_prompt = '  Blend <ref id="round-1-reference-2" />\nwith <ref id="round-1-reference-1" />, retain <ref id="round-1-reference-2" />.  '
    submitted, _ = repo.create_round('conv', AgentRoundCreate(**body))
    job = create_image_job(repo, 'req_1', 1, 'synthetic-call', 'single', execution_prompt, refs, native=native)
    if native:
        metadata = {**job.metadata, 'response': {'revised_prompt': execution_prompt}, 'agent': {**job.metadata['agent'],
            'nativeReferenceSnapshot': {'version': 1, 'complete': True, 'count': len(job.parameters['input_images']),
                'references': [{'ref': spec['name'], 'assetId': refs[spec['name']], 'path': spec['result_path'],
                                'sha256': repo.asset(refs[spec['name']])['sha256']} for spec in job.parameters['input_images']]}}}
        with connect(isolated) as conn:
            conn.execute('UPDATE generation_jobs SET metadata=? WHERE id=?', (json.dumps(metadata), job.id))
        job = repo.jobs.get_job(job.id)
    if getattr(request, 'param', None) == 'native_batch':
        with connect(isolated) as conn:
            conn.execute("UPDATE generation_jobs SET provider='agent_native_batch' WHERE id=?", (job.id,))
        job = repo.jobs.get_job(job.id)
    repo.jobs.mark_failed(job.id, 'Synthetic quota', diagnostics={'http_status': 402, 'error': {'code': 'insufficient_quota'}})
    repo.update('req_1', state='failed', outcome='known', error={'code': 'image_job_failed', 'message': 'Synthetic quota'})
    retry = {'retryId': 'retry-1', 'conversationId': 'conv', 'configRevision': config['revision'],
             'imageConfig': {'profileId': None if native else 'mock-b', 'model': 'gpt-image-b'},
             'params': {'size': '1024x1024', 'quality': 'auto', 'output_format': 'png'}, 'confirmed': True}
    calls = []
    def mock(request):
        calls.append((str(request.url), request.read()))
        assert '/responses' not in str(request.url)
        return httpx.Response(200, json={'data': [{'b64_json': base64.b64encode(image_bytes('green')).decode()}]})
    mock_client = httpx.Client(transport=httpx.MockTransport(mock))
    original = OpenAICompatibleProvider.__init__
    def mock_init(self, config=None, http_client=None):
        original(self, config=config, http_client=mock_client)
    monkeypatch.setattr(OpenAICompatibleProvider, '__init__', mock_init)
    yield client, repo, job, retry, calls
    mock_client.close()
    client.close()


def post(source, body=None):
    client, _, job, retry, _ = source
    value = body or retry
    return client.post(f'/api/generation-jobs/{job.id}/retry-current', json={**value, 'params': {**retry['params'], **value.get('params', {})}})


def test_retry_real_queue_is_image_only_preserves_prompt_pixels_and_lineage(source):
    client, repo, original, body, calls = source
    response = post(source)
    assert response.status_code == 202, response.text
    created = response.json()['job']
    assert created['prompt_text'] == original.prompt_text
    assert created['model'] == 'gpt-image-b'
    assert created['parameters']['size'] == original.parameters['size']
    assert created['parameters']['compatible_profile_id'] == 'mock-b'
    assert 'agent' not in created['metadata']
    link = created['metadata']['agentRetry']
    assert link['sourceJobId'] == original.id
    assert link['roundId'] == repo.request('req_1')['round_id']
    for old, new in zip(original.parameters['input_images'], created['parameters']['input_images']):
        assert (repo.library / old['result_path']).read_bytes() == (repo.library / new['result_path']).read_bytes()
    result = _run_provider_job(repo.library, created['id'], 'openai_compatible')
    assert result.status == 'succeeded'
    assert len(calls) == 1 and calls[0][0].endswith('/images/edits')
    assert b'gpt-image-b' in calls[0][1]
    assert image_bytes('blue') in calls[0][1]
    assert repo.jobs.get_job(original.id).status == 'failed'
    receipt = client.get('/api/generation-jobs/retry-submissions/retry-1', params={'conversation_id': 'conv'})
    assert receipt.status_code == 200 and receipt.json()['job']['status'] == 'succeeded'
    assert len(calls) == 1


def test_retry_same_identity_returns_receipt_after_config_changes(source):
    client, repo, job, body, calls = source
    first = post(source)
    assert first.status_code == 202, first.text
    config = client.get('/api/agent/config').json()
    client.put('/api/agent/config', json={'expectedRevision': config['revision'], 'config': {**config['config'], 'imageModel': 'other'}})
    second = post(source)
    assert second.status_code == 200
    assert second.json()['job']['id'] == first.json()['job']['id']
    changed = post(source, {**body, 'params': {'quality': 'high'}})
    assert changed.status_code == 409
    assert not calls


def test_retry_concurrent_identity_creates_one_job(source):
    _, repo, job, body, calls = source
    def create(_):
        return AgentImageRetryRepository(repo.library).create(job.id, AgentImageRetryCreate(**body))
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(create, range(2)))
    assert len({r[0]['job'].id for r in results}) == 1
    assert sum(r[1] for r in results) == 1
    assert not calls


def test_retry_concurrent_different_identities_claim_source_once(source):
    _, repo, job, body, calls = source
    def create(index):
        try:
            return AgentImageRetryRepository(repo.library).create(job.id, AgentImageRetryCreate(**{**body, 'retryId': f'click-{index}'}))
        except AgentError as exc:
            return exc.code
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(create, range(2)))
    assert sum(isinstance(r, tuple) and r[1] for r in results) == 1
    assert results.count('retry_pending') == 1
    assert not calls


def test_retry_cannot_bypass_running_descendant_from_root(source):
    client, repo, original, body, calls = source
    first = post(source).json()['job']
    repo.jobs.mark_failed(first['id'], 'Synthetic quota', diagnostics={'http_status': 402, 'error': {'code': 'insufficient_quota'}})
    second = client.post(f"/api/generation-jobs/{first['id']}/retry-current", json={**body, 'retryId': 'retry-child'})
    assert second.status_code == 202, second.text
    assert repo.jobs.get_job(original.id).metadata['latestRetryJobId'] == second.json()['job']['id']
    root_retry = post(source, {**body, 'retryId': 'bypass-root'})
    assert root_retry.status_code == 409
    assert root_retry.json()['detail']['code'] == 'retry_pending'
    assert not calls


def test_retry_new_identity_requires_previous_known_failure(source):
    _, repo, _, body, calls = source
    first = post(source).json()['job']
    assert post(source, {**body, 'retryId': 'retry-2'}).status_code == 409
    repo.jobs.mark_failed(first['id'], 'Synthetic network', diagnostics={'category': 'read_timeout'})
    assert post(source, {**body, 'retryId': 'retry-2'}).status_code == 409
    repo.jobs.mark_failed(first['id'], 'Synthetic quota', diagnostics={'http_status': 402, 'error': {'code': 'insufficient_quota'}})
    assert post(source, {**body, 'retryId': 'retry-2'}).status_code == 202
    assert not calls


@pytest.mark.parametrize('mutation', [
    {'confirmed': False}, {'params': {'input_images': []}}, {'params': {'prompt': 'replacement'}},
    {'params': {'api_key': 'synthetic'}}, {'params': {'compatible_profile_id': 'mock'}},
])
def test_retry_rejects_unapproved_fields(source, mutation):
    assert post(source, {**source[3], **mutation}).status_code == 422
    assert not source[4]


@pytest.mark.parametrize('category', ['read_timeout', 'connection_error', 'incomplete_stream', 'unknown'])
def test_retry_does_not_replay_unknown_outcome(source, category):
    _, repo, job, _, calls = source
    repo.jobs.mark_failed(job.id, 'Synthetic uncertain', diagnostics={'category': category})
    response = post(source)
    assert response.status_code == 409
    assert response.json()['detail']['code'] == 'retry_outcome_unknown'
    assert not calls


@pytest.mark.parametrize('mode', ['native', 'off'])
def test_retry_cannot_change_protocol(source, mode):
    client, _, _, body, calls = source
    config = client.get('/api/agent/config').json()
    saved = client.put('/api/agent/config', json={'expectedRevision': config['revision'], 'config': {**config['config'], 'apiConfigMode': mode}}).json()
    response = post(source, {**body, 'configRevision': saved['revision']})
    assert response.status_code == 400
    assert response.json()['detail']['code'] == 'capability_unsupported'
    assert not calls


def test_retry_native_source_rejected(source):
    _, repo, job, _, calls = source
    with connect(repo.library) as conn:
        conn.execute("UPDATE generation_jobs SET provider='agent_native_batch' WHERE id=?", (job.id,))
    assert post(source).status_code == 400
    assert not calls


@pytest.mark.parametrize('corrupt', [False, True])
def test_retry_missing_or_changed_original_pixels_rejected(source, corrupt):
    _, repo, job, _, calls = source
    path = repo.library / job.parameters['input_images'][0]['result_path']
    if corrupt:
        path.write_bytes(image_bytes('red'))
    else:
        path.unlink()
    response = post(source)
    assert response.status_code == 400
    assert response.json()['detail']['code'] == 'reference_missing'
    assert not calls


def test_retry_connection_change_after_enqueue_never_posts(source):
    _, repo, _, _, calls = source
    created = post(source).json()['job']
    OpenAICompatibleConfig(library_path=repo.library).save({'base_url': 'http://127.0.0.1:3/v1', 'api_key': 'qa-key-b'}, profile_id='mock-b')
    with pytest.raises(AgentError, match='连接已改变'):
        _run_provider_job(repo.library, created['id'], 'openai_compatible')
    failed = repo.jobs.get_job(created['id'])
    assert failed.status == 'failed'
    assert failed.metadata['failure']['outcomeUnknown'] is False
    assert failed.metadata['execution']['phase'] == 'failed'
    assert all(value is None for value in failed.metadata['execution']['timings'].values())
    assert not calls


def test_retry_pixels_removed_after_enqueue_report_known_failure_without_timings(source):
    _, repo, original, _, calls = source
    created = post(source).json()['job']
    (repo.library / original.parameters['input_images'][0]['result_path']).unlink()
    with pytest.raises(AgentError, match='冻结参考图片'):
        _run_provider_job(repo.library, created['id'], 'openai_compatible')
    failed = repo.jobs.get_job(created['id'])
    assert failed.status == 'failed'
    assert failed.metadata['failure']['kind'] == 'reference_missing'
    assert failed.metadata['failure']['outcomeUnknown'] is False
    assert failed.metadata['execution']['phase'] == 'failed'
    assert all(value is None for value in failed.metadata['execution']['timings'].values())
    assert not calls


def test_retry_missing_snapshot_cannot_fall_back_to_live_library_image(source):
    _, repo, job, _, calls = source
    with connect(repo.library) as conn:
        conn.execute("UPDATE generation_jobs SET mode='text_to_image',parameters=?,reference_image_ids=? WHERE id=?",
                     (json.dumps({**job.parameters, 'input_images': []}), json.dumps(['live-library-image']), job.id))
    response = post(source)
    assert response.status_code == 400
    assert response.json()['detail']['code'] == 'reference_missing'
    assert not calls


@pytest.mark.parametrize('delete_conversation', [False, True])
def test_retry_owner_deleted_while_queued_never_posts(source, delete_conversation):
    _, repo, _, _, calls = source
    created = post(source).json()['job']
    if delete_conversation:
        repo.delete('conv')
    else:
        repo.delete('conv', repo.request('req_1')['round_id'])
    with pytest.raises(AgentError, match='已删除'):
        _run_provider_job(repo.library, created['id'], 'openai_compatible')
    assert repo.jobs.get_job(created['id']).status == 'failed'
    assert not calls


def test_retry_can_override_valid_params_without_replacing_source(source):
    _, repo, original, body, calls = source
    response = post(source, {**body, 'params': {'quality': 'high', 'output_format': 'jpeg', 'output_compression': None}})
    assert response.status_code == 202, response.text
    assert response.json()['job']['parameters']['quality'] == 'high'
    assert response.json()['job']['parameters']['output_format'] == 'jpeg'
    assert 'output_compression' not in response.json()['job']['parameters']
    assert response.json()['job']['prompt_text'] == original.prompt_text
    assert repo.jobs.get_job(original.id).parameters == original.parameters
    assert not calls


def test_retry_explicit_null_override_has_distinct_submission_identity(source):
    _, _, _, body, calls = source
    assert post(source, {**body, 'params': {'moderation': None}}).status_code == 202
    assert post(source, {**body, 'params': {}}).status_code == 409
    assert not calls


@pytest.mark.parametrize('params', [
    {'size': 'negative'}, {'quality': 'invalid'}, {'output_compression': 101},
    {'output_format': 'jpeg', 'background': 'transparent'},
])
def test_retry_invalid_parameters_do_not_create_task(source, params):
    _, repo, _, body, calls = source
    assert post(source, {**body, 'params': params}).status_code in (400, 422)
    with connect(repo.library) as conn:
        assert conn.execute("SELECT COUNT(*) FROM generation_jobs WHERE id LIKE 'gen_retry_%'").fetchone()[0] == 0
    assert not calls


def test_gallery_legacy_retry_cannot_bypass_agent_retry_claim(source):
    _, repo, original, _, calls = source
    first = post(source).json()['job']
    with pytest.raises(GenerationJobConflict, match='Agent'):
        repo.jobs.retry_failed_job(original.id)
    repo.jobs.mark_failed(first['id'], 'Synthetic quota', diagnostics={'http_status': 402})
    with pytest.raises(GenerationJobConflict, match='Agent'):
        repo.jobs.retry_failed_job(first['id'])
    assert not calls


def test_retry_success_duplicate_dispatch_never_posts_twice(source):
    _, repo, _, _, calls = source
    first = post(source).json()['job']
    assert _run_provider_job(repo.library, first['id'], 'openai_compatible').status == 'succeeded'
    OpenAICompatibleConfig(library_path=repo.library).save({'base_url': 'http://127.0.0.1:3/v1', 'api_key': 'qa-key-b'}, profile_id='mock-b')
    assert _run_provider_job(repo.library, first['id'], 'openai_compatible').status == 'succeeded'
    assert len(calls) == 1


def test_retry_result_visible_after_reload_and_library_reference_reusable(source):
    client, repo, original, _, calls = source
    retry = post(source).json()['job']
    _run_provider_job(repo.library, retry['id'], 'openai_compatible')
    snapshot = client.get('/api/agent/conversations/conv').json()
    round_value = snapshot['conversation']['rounds'][0]
    assert round_value['outputTaskIds'] == [original.id]
    assert round_value['retryTaskIds'] == [retry['id']]
    assert any(row['id'] == retry['id'] and row['status'] == 'succeeded' for row in snapshot['jobs'])
    assert 'output_' + retry['id'] in {row['id'] for row in snapshot['images']}
    saved = client.post(f"/api/generation-jobs/{retry['id']}/accept-as-new-item", json={
        'title': 'Synthetic retry result', 'auto_title': False})
    assert saved.status_code == 200, saved.text
    item = saved.json()['item']
    assert item['prompts'][0]['text'] == '  EXACT execution\n【参考图1】  '
    assert item['prompts'][0]['provenance']['agent_reference_prompt']['raw_text'] == original.prompt_text
    result_image = next(row for row in item['images'] if row['id'] == saved.json()['job']['accepted_image_id'])
    asset_id = AgentRepository(repo.library).resolve_ref({'kind': 'library', 'imageId': result_image['id']})
    assert repo.data_url(asset_id).endswith(base64.b64encode(image_bytes('green')).decode())
    assert repo.jobs.get_job(original.id).status == 'failed'
    assert repo.jobs.get_job(retry['id']).prompt_text == original.prompt_text
    assert len(calls) == 1


def test_retry_cannot_cross_conversations(source):
    response = post(source, {**source[3], 'conversationId': 'other'})
    assert response.status_code == 404
    assert not source[4]


@pytest.mark.parametrize('source', ['two-images'], indirect=True)
@pytest.mark.parametrize('retry_again', [False, True])
def test_retry_library_humanization_preserves_order_recipe_and_real_root_link(source, retry_again):
    client, repo, original, body, calls = source
    before = repo.request('req_1')
    created = post(source).json()['job']
    if retry_again:
        repo.jobs.mark_failed(created['id'], 'Synthetic quota', diagnostics={'http_status': 402})
        response = client.post(f"/api/generation-jobs/{created['id']}/retry-current", json={**body, 'retryId': 'second'})
        assert response.status_code == 202, response.text
        created = response.json()['job']
    _run_provider_job(repo.library, created['id'], 'openai_compatible')
    saved = client.post(f"/api/generation-jobs/{created['id']}/accept-as-new-item", json={'auto_title': False})
    assert saved.status_code == 200, saved.text
    item = saved.json()['item']
    prompt = item['prompts'][0]
    assert prompt['text'] == '  Blend 【参考图1】\nwith 【参考图2】, retain 【参考图1】.  '
    assert prompt['provenance']['agent_reference_prompt'] == {
        'raw_text': original.prompt_text,
        'references': [
            {'id': 'round-1-reference-2', 'label': '参考图1', 'input_index': 1, 'sha256': hashlib.sha256(image_bytes('red')).hexdigest()},
            {'id': 'round-1-reference-1', 'label': '参考图2', 'input_index': 2, 'sha256': hashlib.sha256(image_bytes('blue')).hexdigest()},
        ],
    }
    assert [(repo.library / image['original_path']).read_bytes() for image in item['images']
            if image['role'] == 'reference_image'] == [image_bytes('red'), image_bytes('blue')]
    assert repo.jobs.get_job(created['id']).prompt_text == original.prompt_text
    assert repo.jobs.get_job(created['id']).parameters == created['parameters']
    assert repo.request('req_1')['body'] == before['body'] and repo.request('req_1')['history'] == before['history']
    with connect(repo.library) as conn:
        assert conn.execute('SELECT COUNT(*) FROM agent_tool_jobs WHERE job_id=?', (created['id'],)).fetchone()[0] == 0
        assert conn.execute('SELECT COUNT(*) FROM agent_tool_jobs WHERE job_id=?', (original.id,)).fetchone()[0] == 1
    assert len(calls) == 1


@pytest.mark.parametrize('corruption', [
    'retryId', 'rootSourceJobId', 'sourceRequestId', 'roundId', 'conversationId', 'sourceJobId',
    'registration', 'tool-link', 'reference-name', 'reference-bytes',
])
def test_retry_forged_lineage_or_reference_mapping_does_not_rewrite_prompt(source, corruption):
    client, repo, original, _, calls = source
    created = post(source).json()['job']
    metadata, parameters = created['metadata'], created['parameters']
    with connect(repo.library) as conn:
        if corruption == 'registration':
            conn.execute('UPDATE generation_jobs SET metadata=? WHERE id=?', (json.dumps(original.metadata), original.id))
        elif corruption == 'tool-link':
            conn.execute('DELETE FROM agent_tool_jobs WHERE job_id=?', (original.id,))
        elif corruption == 'reference-name':
            parameters['input_images'][0]['name'] = 'round-99-reference-1'
        elif corruption == 'reference-bytes':
            changed = repo.store_asset(image_bytes('red'), None)
            parameters['input_images'][0]['result_path'] = repo.asset(changed['id'])['path']
        else:
            metadata['agentRetry'][corruption] = 'unrelated'
        conn.execute('UPDATE generation_jobs SET metadata=?,parameters=? WHERE id=?',
                     (json.dumps(metadata), json.dumps(parameters), created['id']))
    repo.jobs.stage_result(created['id'], image_bytes('green'), 'synthetic.png')
    accepted = client.post(f"/api/generation-jobs/{created['id']}/accept-as-new-item", json={'auto_title': False})
    assert accepted.status_code == 200, accepted.text
    prompt = accepted.json()['item']['prompts'][0]
    assert prompt['text'] == original.prompt_text
    assert 'agent_reference_prompt' not in prompt['provenance']
    assert repo.jobs.get_job(created['id']).prompt_text == original.prompt_text
    assert not calls


@pytest.mark.parametrize('accepted', [False, True])
def test_retry_successful_image_keeps_original_result_and_uses_current_controls(source, accepted):
    client, repo, original, body, calls = source
    repo.jobs.mark_running(original.id)
    repo.jobs.stage_result(original.id, image_bytes('yellow'), 'old.png')
    if accepted:
        saved = client.post(f'/api/generation-jobs/{original.id}/accept-as-new-item', json={'auto_title': False})
        assert saved.status_code == 200, saved.text
    before = repo.jobs.get_job(original.id)
    response = post(source, {**body, 'params': {'size': '1536x1024', 'quality': 'high', 'output_format': 'webp'}})
    assert response.status_code == 202, response.text
    created = response.json()['job']
    assert created['parameters']['size'] == '1536x1024'
    assert created['parameters']['quality'] == 'high'
    assert created['parameters']['output_format'] == 'webp'
    assert created['prompt_text'] == before.prompt_text
    assert _run_provider_job(repo.library, created['id'], created['provider']).status == 'succeeded'
    after = repo.jobs.get_job(original.id)
    for key in ('status', 'result_path', 'result_sha256', 'accepted_image_id', 'prompt_text', 'parameters'):
        assert getattr(after, key) == getattr(before, key)
    assert (repo.library / before.result_path).read_bytes() == image_bytes('yellow')
    assert len(calls) == 1


def test_retry_current_controls_never_inherit_old_optional_or_ratio_settings(source):
    _, repo, job, body, _ = source
    with connect(repo.library) as conn:
        parameters = {**job.parameters, 'moderation': 'low', 'background': 'transparent', 'output_compression': 12,
                      'requested_aspect_ratio': '16:9', 'aspect_ratio_prompt_injection': True}
        metadata = {**repo.jobs.get_job(job.id).metadata, 'requested': {'size': '2048x1024', 'quality': 'high', 'moderation': 'low'}}
        conn.execute('UPDATE generation_jobs SET parameters=?,metadata=? WHERE id=?', (json.dumps(parameters), json.dumps(metadata), job.id))
    response = post(source)
    assert response.status_code == 202, response.text
    params = response.json()['job']['parameters']
    assert params['size'] == body['params']['size']
    assert params['quality'] == 'auto' and params['background'] == 'auto'
    assert not {'moderation', 'output_compression', 'requested_aspect_ratio', 'aspect_ratio_prompt_injection'} & params.keys()


def test_retry_requires_current_parameter_snapshot(source):
    client, _, job, body, calls = source
    for params in (None, {}, {'size': '1024x1024'}):
        request = {k: v for k, v in body.items() if k != 'params'}
        if params is not None:
            request['params'] = params
        assert client.post(f'/api/generation-jobs/{job.id}/retry-current', json=request).status_code == 422
    assert not calls


@pytest.mark.parametrize('status', ['queued', 'running', 'cancelled', 'discarded'])
def test_retry_requires_known_terminal_source(source, status):
    _, repo, job, _, calls = source
    with connect(repo.library) as conn:
        conn.execute('UPDATE generation_jobs SET status=? WHERE id=?', (status, job.id))
    response = post(source)
    assert response.status_code == 409 and response.json()['detail']['code'] == 'retry_not_terminal'
    assert not calls


def test_retry_success_result_missing_never_submits(source):
    _, repo, job, _, calls = source
    repo.jobs.mark_running(job.id)
    result = repo.jobs.stage_result(job.id, image_bytes('yellow'), 'old.png')
    (repo.library / result.result_path).unlink()
    response = post(source)
    assert response.status_code == 400 and response.json()['detail']['code'] == 'reference_missing'
    assert not calls


def test_retry_completed_descendant_allows_next_attempt_but_queued_descendant_blocks(source):
    _, repo, original, body, calls = source
    first = post(source).json()['job']
    _run_provider_job(repo.library, first['id'], first['provider'])
    second = post(source, {**body, 'retryId': 'retry-2'})
    assert second.status_code == 202, second.text
    assert repo.jobs.get_job(original.id).metadata['latestRetryJobId'] == second.json()['job']['id']
    blocked = post(source, {**body, 'retryId': 'retry-3'})
    assert blocked.status_code == 409 and blocked.json()['detail']['code'] == 'retry_pending'
    assert len(calls) == 1


def mock_native_client(monkeypatch, handler):
    original = httpx.Client
    monkeypatch.setattr('backend.services.agent_image_retry.httpx.Client', lambda **kwargs: original(
        **{**kwargs, 'transport': httpx.MockTransport(handler)}))


@pytest.mark.parametrize('source', ['native', 'native_batch', 'native_mask'], indirect=True)
@pytest.mark.parametrize('successful_source', [False, True])
def test_retry_native_single_forced_tool_preserves_prompt_references_and_current_config(source, monkeypatch, successful_source):
    client, repo, original, body, image_calls = source
    if successful_source:
        repo.jobs.mark_running(original.id)
        repo.jobs.stage_result(original.id, image_bytes('yellow'), 'before.png')
    document = client.get('/api/agent/config').json()
    saved = client.put('/api/agent/config', json={'expectedRevision': document['revision'],
        'config': {**document['config'], 'textProfileId': 'mock-b', 'textModel': 'current-responses-model'}}).json()
    body = {**body, 'configRevision': saved['revision'], 'params': {'size': '1536x1024', 'quality': 'high', 'output_format': 'webp'}}
    native_calls = []
    def handler(request):
        native_calls.append((str(request.url), json.loads(request.content)))
        return httpx.Response(200, json={'id': 'native-retry-result', 'status': 'completed', 'output': [
            {'id': 'image-retry-result', 'type': 'image_generation_call', 'status': 'completed',
             'revised_prompt': 'Unrequested provider rewrite', 'result': base64.b64encode(image_bytes('green')).decode()}]})
    mock_native_client(monkeypatch, handler)
    response = post(source, body)
    assert response.status_code == 202, response.text
    created = response.json()['job']
    assert created['provider'] == 'agent_native_batch'
    result = _run_provider_job(repo.library, created['id'], created['provider'])
    assert result.status == 'succeeded'
    assert len(native_calls) == 1 and native_calls[0][0] == 'http://127.0.0.1:2/v1/responses'
    wire = native_calls[0][1]
    assert wire['model'] == 'current-responses-model'
    assert wire['tool_choice'] == {'type': 'image_generation'} and wire['max_tool_calls'] == 1
    assert len(wire['tools']) == 1 and wire['tools'][0]['model'] == 'gpt-image-b'
    assert wire['tools'][0]['size'] == '1536x1024' and wire['tools'][0]['quality'] == 'high'
    assert wire['input'][0]['content'][0]['text'] == original.prompt_text
    assert base64.b64decode(wire['input'][0]['content'][1]['image_url'].split(',')[1]) == image_bytes('blue')
    if repo.request('req_1')['round']['maskImageId']:
        assert base64.b64decode(wire['tools'][0]['input_image_mask']['image_url'].split(',')[1]) == mask_bytes()
    assert result.prompt_text == original.prompt_text
    assert result.metadata['response']['revised_prompt'] == 'Unrequested provider rewrite'
    assert repo.jobs.get_job(original.id).status == ('succeeded' if successful_source else 'failed')
    snapshot = client.get('/api/agent/conversations/conv').json()
    assert created['id'] in snapshot['conversation']['rounds'][0]['retryTaskIds']
    with connect(repo.library) as conn:
        assert conn.execute('SELECT COUNT(*) FROM agent_tool_jobs WHERE job_id=?', (created['id'],)).fetchone()[0] == 0
    assert not image_calls


@pytest.mark.parametrize('source', ['native'], indirect=True)
def test_retry_native_unknown_receipt_or_dispatch_never_reposts(source, monkeypatch):
    client, repo, _, body, image_calls = source
    calls = []
    def handler(request):
        calls.append(request)
        raise httpx.ReadTimeout('synthetic response missing', request=request)
    mock_native_client(monkeypatch, handler)
    created = post(source).json()['job']
    with pytest.raises(httpx.ReadTimeout):
        _run_provider_job(repo.library, created['id'], created['provider'])
    assert _run_provider_job(repo.library, created['id'], created['provider']).status == 'failed'
    receipt = client.get('/api/generation-jobs/retry-submissions/retry-1', params={'conversation_id': 'conv'})
    assert receipt.status_code == 200 and receipt.json()['job']['metadata']['failure']['outcomeUnknown'] is True
    assert post(source).status_code == 200
    fresh = post(source, {**body, 'retryId': 'next-click'})
    assert fresh.status_code == 409 and fresh.json()['detail']['code'] == 'retry_outcome_unknown'
    assert len(calls) == 1 and not image_calls


@pytest.mark.parametrize('source', ['native'], indirect=True)
def test_retry_native_accepts_completed_sse_without_second_request(source, monkeypatch):
    _, repo, _, _, _ = source
    calls = []
    def handler(request):
        calls.append(request)
        payload = {'id': 'final', 'status': 'completed', 'output': [{'id': 'image', 'type': 'image_generation_call',
            'status': 'completed', 'result': base64.b64encode(image_bytes('green')).decode()}]}
        stream = 'data: ' + json.dumps({'type': 'response.completed', 'response': payload}) + '\n\ndata: [DONE]\n\n'
        return httpx.Response(200, text=stream, headers={'content-type': 'text/event-stream'})
    mock_native_client(monkeypatch, handler)
    created = post(source).json()['job']
    assert _run_provider_job(repo.library, created['id'], created['provider']).status == 'succeeded'
    assert _run_provider_job(repo.library, created['id'], created['provider']).status == 'succeeded'
    assert len(calls) == 1


@pytest.mark.parametrize('source', ['native_mask'], indirect=True)
def test_retry_native_changed_mask_after_enqueue_never_posts(source, monkeypatch):
    _, repo, _, _, _ = source
    calls = []
    mock_native_client(monkeypatch, lambda request: calls.append(request))
    created = post(source).json()['job']
    mask_path = created['metadata']['agentRetry']['maskReference']['path']
    (repo.library / mask_path).write_bytes(image_bytes('black'))
    with pytest.raises(AgentError, match='冻结蒙版'):
        _run_provider_job(repo.library, created['id'], created['provider'])
    assert repo.jobs.get_job(created['id']).status == 'failed'
    assert not calls


@pytest.mark.parametrize('source', ['native'], indirect=True)
def test_retry_native_concurrent_dispatch_posts_once(source, monkeypatch):
    _, repo, _, _, _ = source
    entered, release, calls = Event(), Event(), []
    def handler(request):
        calls.append(request)
        entered.set()
        assert release.wait(5)
        return httpx.Response(200, json={'status': 'completed', 'output': [{'id': 'image', 'type': 'image_generation_call',
            'status': 'completed', 'result': base64.b64encode(image_bytes('green')).decode()}]})
    mock_native_client(monkeypatch, handler)
    created = post(source).json()['job']
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(_run_provider_job, repo.library, created['id'], created['provider'])
        try:
            assert entered.wait(5)
            duplicate = pool.submit(_run_provider_job, repo.library, created['id'], created['provider'])
            assert duplicate.result(timeout=5).status == 'running'
        finally:
            release.set()
        assert first.result(timeout=5).status == 'succeeded'
    assert len(calls) == 1


@pytest.mark.parametrize('source', ['native'], indirect=True)
def test_retry_native_known_rejection_can_create_new_identity(source, monkeypatch):
    _, repo, _, body, _ = source
    calls = []
    def handler(request):
        calls.append(request)
        return httpx.Response(402, json={'error': {'code': 'insufficient_quota'}})
    mock_native_client(monkeypatch, handler)
    created = post(source).json()['job']
    with pytest.raises(AgentError, match='HTTP 402'):
        _run_provider_job(repo.library, created['id'], created['provider'])
    failed = repo.jobs.get_job(created['id'])
    assert failed.metadata['failure']['kind'] == 'quota'
    assert failed.metadata['failure']['outcomeUnknown'] is False
    assert post(source, {**body, 'retryId': 'next-click'}).status_code == 202
    assert len(calls) == 1


@pytest.mark.parametrize('source', ['native'], indirect=True)
def test_retry_native_default_image_model_is_not_replaced_with_text_profile_model(source, monkeypatch):
    _, repo, _, body, _ = source
    calls = []
    def handler(request):
        calls.append(json.loads(request.content))
        return httpx.Response(200, json={'status': 'completed', 'output': [{'id': 'image', 'type': 'image_generation_call',
            'status': 'completed', 'result': base64.b64encode(image_bytes('green')).decode()}]})
    mock_native_client(monkeypatch, handler)
    response = post(source, {**body, 'imageConfig': {'profileId': None, 'model': ''}})
    assert response.status_code == 202, response.text
    created = response.json()['job']
    assert created['model'] is None
    assert _run_provider_job(repo.library, created['id'], created['provider']).status == 'succeeded'
    assert 'model' not in calls[0]['tools'][0]
    assert calls[0]['model'] == 'mock-text'


@pytest.mark.parametrize('source', ['native'], indirect=True)
@pytest.mark.parametrize('snapshot', [None, {'version': 1, 'complete': False, 'count': 1},
    {'version': 1, 'complete': True, 'count': 0}, {'version': 1, 'complete': True, 'count': 5}])
def test_retry_native_unproven_or_incomplete_original_recipe_never_submits(source, snapshot):
    _, repo, job, _, calls = source
    current = repo.jobs.get_job(job.id)
    metadata = {**current.metadata, 'agent': {**current.metadata['agent'], 'nativeReferenceSnapshot': snapshot}}
    with connect(repo.library) as conn:
        conn.execute('UPDATE generation_jobs SET metadata=? WHERE id=?', (json.dumps(metadata), job.id))
    response = post(source)
    assert response.status_code == 400 and response.json()['detail']['code'] == 'reference_missing'
    with connect(repo.library) as conn:
        assert conn.execute("SELECT count(*) FROM generation_jobs WHERE id LIKE 'gen_retry_%'").fetchone()[0] == 0
    assert not calls


@pytest.mark.parametrize('source', ['native'], indirect=True)
@pytest.mark.parametrize('terminal_status', ['failed', 'incomplete', 'cancelled', None])
def test_retry_native_terminal_failure_requires_final_receipt_evidence(source, terminal_status):
    _, repo, job, _, calls = source
    repo.jobs.mark_failed(job.id, 'Synthetic tool status', diagnostics={'error': {'code': 'image_generation_user_error'}})
    current = repo.jobs.get_job(job.id)
    metadata = {**current.metadata, 'agent': {**current.metadata['agent'], 'nativeTerminalStatus': terminal_status}}
    with connect(repo.library) as conn:
        conn.execute('UPDATE generation_jobs SET metadata=? WHERE id=?', (json.dumps(metadata), job.id))
    response = post(source)
    assert response.status_code == (202 if terminal_status == 'failed' else 409), response.text
    if terminal_status != 'failed':
        assert response.json()['detail']['code'] == 'retry_outcome_unknown'
    assert not calls


@pytest.mark.parametrize('source', ['native'], indirect=True)
@pytest.mark.parametrize('parent_status,tool_status', [('completed', 'failed'), ('completed', 'incomplete'), ('failed', 'failed')])
def test_retry_native_runner_records_only_confirmed_tool_failure(source, monkeypatch, parent_status, tool_status):
    _, repo, _, body, _ = source
    calls = []
    def handler(request):
        calls.append(request)
        return httpx.Response(200, json={'status': parent_status, 'output': [
            {'id': 'image', 'type': 'image_generation_call', 'status': tool_status, 'error': {'code': 'image_generation_user_error'}}]})
    mock_native_client(monkeypatch, handler)
    created = post(source).json()['job']
    with pytest.raises(AgentError):
        _run_provider_job(repo.library, created['id'], created['provider'])
    stored = repo.jobs.get_job(created['id'])
    confirmed = parent_status == 'completed' and tool_status == 'failed'
    assert (stored.metadata['agentRetry'].get('nativeTerminalStatus') == 'failed') is confirmed
    response = post(source, {**body, 'retryId': 'next-click'})
    assert response.status_code == (202 if confirmed else 409), response.text
    assert len(calls) == 1


@pytest.mark.parametrize('source', ['native'], indirect=True)
def test_retry_native_frozen_snapshot_digest_outranks_mutated_asset_record(source):
    _, repo, job, _, calls = source
    spec = job.parameters['input_images'][0]
    changed = image_bytes('red')
    (repo.library / spec['result_path']).write_bytes(changed)
    with connect(repo.library) as conn:
        conn.execute('UPDATE agent_assets SET sha256=? WHERE path=?', (hashlib.sha256(changed).hexdigest(), spec['result_path']))
    response = post(source)
    assert response.status_code == 400 and response.json()['detail']['code'] == 'reference_missing'
    assert not calls


@pytest.mark.parametrize('source', ['native'], indirect=True)
@pytest.mark.parametrize('revised', [None, '', '   ', {'text': 'invalid'}])
def test_retry_native_direct_without_actual_prompt_evidence_never_replays_user_turn(source, revised):
    _, repo, job, _, calls = source
    current = repo.jobs.get_job(job.id)
    metadata = {**current.metadata, 'response': {'revised_prompt': revised}}
    with connect(repo.library) as conn:
        conn.execute('UPDATE generation_jobs SET metadata=? WHERE id=?', (json.dumps(metadata), job.id))
    response = post(source)
    assert response.status_code == 400 and response.json()['detail']['code'] == 'prompt_unavailable'
    assert repo.jobs.get_job(job.id).prompt_text == job.prompt_text
    with connect(repo.library) as conn:
        assert conn.execute("SELECT count(*) FROM generation_jobs WHERE id LIKE 'gen_retry_%'").fetchone()[0] == 0
    assert not calls
