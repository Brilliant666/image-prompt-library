"""Saved API policy reaches real routes/workers, with only synthetic transports."""
import base64
import json
from uuid import uuid4

import httpx
import pytest
from fastapi.testclient import TestClient

from backend.db import connect
from backend.main import create_app
from backend.services import agent_execution, agent_image_retry, api_network, capture_organizer, model_catalog
from backend.services import openai_compatible as compatible
from backend.services.agent_repository import AgentRepository, encoded, fingerprint
from backend.services.generation_queue import _run_provider_job
from test_agent_image_retry import post as post_retry, source
from test_agent_workflow_execution import answer, image_reply
from test_agent_workspaces import configure, image_bytes, isolated, payload


ROOT = '/api/generation-providers/openai-compatible/profiles'
ORIGIN = 'http://127.0.0.1:8123'
KEY = 'integration-api-key-not-real'
PROXY = 'http://synthetic-user:synthetic-password@proxy.invalid:8080'
REAL_PROVIDER_INIT = compatible.OpenAICompatibleProvider.__init__
POLICIES = [{'network_mode': mode, 'proxy_url': PROXY if mode == 'proxy' else ''}
            for mode in ('direct', 'environment', 'proxy')]
CHANGED_PROXY = {**POLICIES[2], 'proxy_url': PROXY.replace('password', 'changed-password')}


@pytest.fixture(autouse=True)
def offline_only(isolated, monkeypatch):
    monkeypatch.setattr(httpx.HTTPTransport, 'handle_request', lambda *a, **k: pytest.fail('Unexpected real network'))


@pytest.fixture
def app(isolated, monkeypatch):
    for target in ('backend.routers.agent.schedule_request',
                   'backend.routers.agent_image_retry.enqueue_generation_jobs',
                   'backend.routers.generation_jobs.enqueue_generation_jobs',
                   'backend.routers.generation_jobs.enqueue_metadata_jobs',
                   'backend.routers.captures.enqueue_jobs', 'backend.services.capture_organizer.enqueue_jobs'):
        monkeypatch.setattr(target, lambda *a, **k: None)
    client = TestClient(create_app(isolated), base_url=ORIGIN, client=('127.0.0.1', 54321))
    yield isolated, client
    client.close()


def factory_spy(monkeypatch, handler):
    """Run the real policy factory; replace only the resulting client's I/O."""
    selections, requests = [], []
    real_factory = api_network.create_api_client

    def receive(request):
        requests.append(request)
        assert 'proxy-authorization' not in request.headers
        assert 'synthetic-password' not in str(request.headers)
        return handler(request)

    for module in (agent_execution, agent_image_retry, compatible, capture_organizer, model_catalog):
        def selected(settings, *, timeout, client_factory=None, owner=module.__name__):
            def mock_client(**kwargs):
                transport = kwargs.get('transport')
                proxy = getattr(getattr(transport, '_pool', None), '_proxy_url', None)
                selections.append({'owner': owner, 'settings': dict(settings), 'trust_env': kwargs['trust_env'],
                                   'proxy_host': proxy.host.decode() if proxy else None})
                if transport is not None:
                    transport.close()
                return httpx.Client(transport=httpx.MockTransport(receive), timeout=kwargs['timeout'], trust_env=False)
            return real_factory(settings, timeout=timeout, client_factory=mock_client)
        monkeypatch.setattr(module, 'create_api_client', selected)
    return selections, requests


def assert_policy(selections, policy):
    assert selections
    for selected in selections:
        assert {key: selected['settings'][key] for key in policy} == policy
        assert selected['trust_env'] is (policy['network_mode'] == 'environment')
        assert selected['proxy_host'] == ('proxy.invalid' if policy['network_mode'] == 'proxy' else None)


def freeze_round(app, policy, *, mode='hybrid', images=True):
    library, client = app
    config = configure(client, library, 'https://provider.invalid/v1', mode)
    store = compatible.OpenAICompatibleConfig(library_path=library)
    store.save(policy, profile_id='mock')
    snapshot = client.post('/api/agent/conversations', json={'id': 'conv'}).json()
    body = payload(snapshot, config, images=images)
    response = client.post('/api/agent/conversations/conv/rounds', json=body)
    assert response.status_code == 202, response.text
    return store, body


def assert_public(value):
    serialized = json.dumps(value)
    for secret in (KEY, 'unit-test-key-not-real', 'synthetic-user', 'synthetic-password', 'changed-password', PROXY):
        assert secret not in serialized
    assert '"proxy_url"' not in serialized


def test_capture_connection_failure_before_sending_is_known_configuration_error(app, monkeypatch):
    library, client = app
    saved = client.put('/api/capture-organizer/config', headers={'Origin': ORIGIN}, json={
        'enabled': True, 'base_url': 'https://organizer.invalid/v1', 'api_key': KEY,
        'model': 'synthetic-vision', **POLICIES[0]})
    assert saved.status_code == 200

    def reject_connection(*args, **kwargs):
        raise api_network.ApiNetworkError('Direct network route cannot be confirmed.')

    monkeypatch.setattr(capture_organizer, 'create_api_client', reject_connection)
    result = capture_organizer.test_saved_configuration(library)
    assert result['status'] == 'failed'
    assert result['category'] == 'configuration'
    assert result['http_status'] is None
    assert_public(result)


def test_profile_and_organizer_http_saves_copy_and_reads_are_local_and_redacted(app, monkeypatch):
    library, client = app
    selected, requests = factory_spy(monkeypatch, lambda r: pytest.fail('Saving settings must not call an API'))
    store = compatible.OpenAICompatibleConfig(library_path=library)
    store.path.parent.mkdir(parents=True, exist_ok=True)
    store.path.write_text(json.dumps({'base_url': 'https://legacy.invalid/v1', 'api_key': KEY, 'model': 'legacy-model'}))
    before = store.path.read_bytes()
    old = client.get(ROOT).json()['profiles'][0]
    assert old['network_mode'] == 'direct' and old['model'] == 'legacy-model'
    assert store.path.read_bytes() == before and store.read('legacy')['api_key'] == KEY
    saved = client.put(ROOT + '/legacy', json=POLICIES[2])
    assert saved.status_code == 200, saved.text
    assert_public(saved.json())
    assert store.read('legacy')['api_key'] == KEY and store.read('legacy')['model'] == 'legacy-model'
    copied = client.post(ROOT + '/legacy/copy', json={'id': 'copy'})
    assert copied.status_code == 200, copied.text
    assert_public(copied.json())
    assert store.read('copy')['proxy_url'] == PROXY
    assert client.put(ROOT + '/copy', json={'proxy_url': '', 'model': 'copied-model'}).status_code == 200
    assert store.read('copy')['proxy_url'] == PROXY and store.read('legacy')['model'] == 'legacy-model'
    assert client.put(ROOT + '/copy', json={'network_mode': 'direct', 'remove_proxy_url': True}).status_code == 200
    assert store.read('copy')['proxy_url'] == '' and store.read('legacy')['proxy_url'] == PROXY
    organizer = client.put('/api/capture-organizer/config', headers={'Origin': ORIGIN}, json={
        'base_url': 'https://organizer.invalid/v1', 'api_key': KEY, 'model': 'synthetic-vision',
    })
    assert organizer.status_code == 200, organizer.text
    organizer_store = capture_organizer.OrganizerConfig(library)
    legacy_organizer = json.loads(organizer_store.path.read_text())
    for key in api_network.NETWORK_DEFAULTS:
        legacy_organizer.pop(key, None)
    organizer_store.path.write_text(json.dumps(legacy_organizer))
    before = organizer_store.path.read_bytes()
    assert client.get('/api/capture-organizer/config', headers={'Origin': ORIGIN}).json()['network_mode'] == 'direct'
    assert organizer_store.path.read_bytes() == before
    organizer = client.put('/api/capture-organizer/config', headers={'Origin': ORIGIN}, json=POLICIES[2])
    assert organizer.status_code == 200, organizer.text
    assert_public(organizer.json())
    assert client.put('/api/capture-organizer/config', headers={'Origin': ORIGIN}, json={'network_mode': 'environment'}).status_code == 200
    current = capture_organizer.OrganizerConfig(library).read()
    assert current['api_key'] == KEY and current['model'] == 'synthetic-vision' and current['proxy_url'] == PROXY
    assert_public(client.get('/api/capture-organizer/config', headers={'Origin': ORIGIN}).json())
    assert_public(client.get('/api/generation-providers').json())
    assert selected == requests == []


@pytest.mark.parametrize('change', [POLICIES[1], POLICIES[2], CHANGED_PROXY])
def test_catalog_network_change_discards_inflight_response_and_refreshes_current(app, monkeypatch, change):
    library, client = app
    store = compatible.OpenAICompatibleConfig(library_path=library)
    initial = POLICIES[2] if 'changed-password' in change.get('proxy_url', '') else POLICIES[0]
    store.save({'base_url': 'https://provider.invalid', 'api_key': KEY, 'model': 'manual', **initial}, profile_id='one')
    def reply(request):
        assert request.method == 'GET' and request.url.path == '/v1/models'
        if len(requests) == 2:
            store.save(change, profile_id='one')
        return httpx.Response(200, json={'data': [{'id': f'model-{len(requests)}'}]})
    selected, requests = factory_spy(monkeypatch, reply)
    endpoint = ROOT + '/one/models/refresh'
    assert client.post(endpoint).json()['models'][0]['id'] == 'model-1'
    stale = client.post(endpoint)
    assert stale.status_code == 200 and stale.json()['error'] == model_catalog.ERRORS['changed']
    assert stale.json()['models'] == []
    assert client.get(ROOT + '/one/models').json() == model_catalog.empty_catalog()
    fresh = client.post(endpoint).json()
    assert fresh['models'][0]['id'] == 'model-3' and fresh['error'] is None
    assert selected[-1]['settings']['network_mode'] == change['network_mode']
    assert selected[-1]['settings']['proxy_url'] == change['proxy_url']
    assert_public(fresh)


@pytest.mark.parametrize('policy', POLICIES, ids=['direct', 'environment', 'proxy'])
@pytest.mark.parametrize('mode', ['native', 'hybrid'])
def test_agent_real_round_and_image_dispatch_use_saved_policy(app, monkeypatch, policy, mode):
    library, client = app
    def reply(request):
        if request.url.path.endswith('/responses'):
            return httpx.Response(200, json=image_reply(mode))
        assert request.url.path.endswith('/images/generations')
        return httpx.Response(200, json={'data': [{'b64_json': base64.b64encode(image_bytes()).decode()}]})
    selected, requests = factory_spy(monkeypatch, reply)
    _, body = freeze_round(app, policy, mode=mode)
    agent_execution.run_request(library, body['requestId'])
    result = client.get('/api/agent/requests/' + body['requestId']).json()
    assert result['request']['state'] == 'completed', result['request']
    assert len(result['jobs']) == 1 and result['jobs'][0]['status'] == 'succeeded'
    assert len(requests) == (1 if mode == 'native' else 2)
    assert_policy(selected, policy)
    assert {row['owner'] for row in selected} == {agent_execution.__name__}
    assert_public(result)
    assert client.post('/api/agent/conversations/conv/rounds', json=body).status_code == 200
    agent_execution.run_request(library, body['requestId'])
    assert len(requests) == (1 if mode == 'native' else 2)


@pytest.mark.parametrize('mode', ['native', 'hybrid'])
def test_agent_unknown_outcome_is_not_replayed_by_network_mode(app, monkeypatch, mode):
    library, client = app
    def fail(request):
        raise httpx.ReadTimeout('synthetic-password private transport error', request=request)
    selected, requests = factory_spy(monkeypatch, fail)
    _, body = freeze_round(app, POLICIES[2], mode=mode)
    agent_execution.run_request(library, body['requestId'])
    agent_execution.run_request(library, body['requestId'])
    result = client.get('/api/agent/requests/' + body['requestId']).json()
    assert result['request']['state'] == 'unknown' and result['request']['upstreamOutcome'] == 'unknown'
    assert len(requests) == 1
    assert_policy(selected, POLICIES[2])
    assert_public(result)


@pytest.mark.parametrize('change', [*POLICIES, CHANGED_PROXY])
def test_frozen_agent_legacy_direct_identity_survives_defaults_but_not_network_changes(app, monkeypatch, change):
    library, client = app
    selected, requests = factory_spy(monkeypatch, lambda r: httpx.Response(200, json=answer()))
    initial = POLICIES[2] if change == CHANGED_PROXY else POLICIES[0]
    store, body = freeze_round(app, initial, images=False)
    repo = AgentRepository(library)
    frozen = repo.request(body['requestId'])['frozen']
    if initial['network_mode'] == 'direct':
        legacy = {k: v for k, v in store.read('mock').items() if k not in api_network.NETWORK_DEFAULTS}
        frozen['_profileDigests']['mock'] = fingerprint(legacy)
    with connect(library) as conn:
        conn.execute('UPDATE agent_requests SET frozen=? WHERE id=?', (encoded(frozen), body['requestId']))
    store.save(change, profile_id='mock')
    agent_execution.run_request(library, body['requestId'])
    result = client.get('/api/agent/requests/' + body['requestId']).json()
    if change['network_mode'] == 'direct':
        assert result['request']['state'] == 'completed' and len(requests) == 1
        assert_policy(selected, change)
    else:
        assert result['request']['error']['code'] == 'profile_changed'
        assert selected == requests == []
    assert_public(result)


@pytest.mark.parametrize('policy', POLICIES, ids=['direct', 'environment', 'proxy'])
def test_gallery_http_job_uses_policy_without_exposing_connection_secrets(app, monkeypatch, policy):
    library, client = app
    store = compatible.OpenAICompatibleConfig(library_path=library)
    store.save({'base_url': 'https://provider.invalid/v1', 'api_key': KEY, 'model': 'synthetic-image', **policy}, profile_id='one')
    selected, requests = factory_spy(monkeypatch, lambda r: httpx.Response(200, json={
        'data': [{'b64_json': base64.b64encode(image_bytes()).decode()}]}))
    created = client.post('/api/generation-jobs', json={'provider': 'openai_compatible', 'prompt_text': 'Synthetic orange square',
        'parameters': {'compatible_profile_id': 'one'}})
    assert created.status_code == 200, created.text
    job = _run_provider_job(library, created.json()['id'], 'openai_compatible')
    assert job.status == 'succeeded' and len(requests) == 1
    assert requests[0].url.path.endswith('/images/generations')
    assert_policy(selected, policy)
    assert_public(job.model_dump())
    assert_public(client.get('/api/generation-jobs/' + job.id).json())


@pytest.mark.parametrize('source', ['native', 'hybrid'], indirect=True)
@pytest.mark.parametrize('policy', POLICIES, ids=['direct', 'environment', 'proxy'])
def test_explicit_retry_dispatch_uses_current_selected_policy_once(source, monkeypatch, policy):
    client, repo, old_job, body, fixture_requests = source
    monkeypatch.setattr(compatible.OpenAICompatibleProvider, '__init__', REAL_PROVIDER_INIT)
    native = old_job.provider == 'agent_native'
    profile_id = 'mock' if native else 'mock-b'
    compatible.OpenAICompatibleConfig(library_path=repo.library).save(policy, profile_id=profile_id)
    def reply(request):
        return httpx.Response(200, json=image_reply('native') if native else {
            'data': [{'b64_json': base64.b64encode(image_bytes()).decode()}]})
    selected, requests = factory_spy(monkeypatch, reply)
    created = post_retry(source)
    assert created.status_code == 202, created.text
    job = created.json()['job']
    completed = _run_provider_job(repo.library, job['id'], job['provider'])
    assert completed.status == 'succeeded'
    _run_provider_job(repo.library, job['id'], job['provider'])
    assert len(requests) == 1 and not fixture_requests
    assert requests[0].url.path.endswith('/responses' if native else '/images/edits')
    assert_policy(selected, policy)
    assert selected[0]['owner'] == (agent_image_retry.__name__ if native else compatible.__name__)
    assert_public(completed.model_dump())


@pytest.mark.parametrize('change', [*POLICIES, CHANGED_PROXY])
def test_explicit_retry_legacy_direct_digest_and_network_change_boundary(source, change):
    _, repo, _, _, calls = source
    store = compatible.OpenAICompatibleConfig(library_path=repo.library)
    if change == CHANGED_PROXY:
        store.save(POLICIES[2], profile_id='mock-b')
    created = post_retry(source)
    assert created.status_code == 202, created.text
    job = created.json()['job']
    metadata = repo.jobs.get_job(job['id']).metadata
    if change != CHANGED_PROXY:
        metadata['agentRetry']['profileDigest'] = fingerprint({k: v for k, v in store.read('mock-b').items()
                                                             if k not in api_network.NETWORK_DEFAULTS})
    with connect(repo.library) as conn:
        conn.execute('UPDATE generation_jobs SET metadata=? WHERE id=?', (encoded(metadata), job['id']))
    store.save(change, profile_id='mock-b')
    if change['network_mode'] == 'direct':
        assert _run_provider_job(repo.library, job['id'], job['provider']).status == 'succeeded'
        assert len(calls) == 1
    else:
        with pytest.raises(agent_image_retry.AgentError) as caught:
            _run_provider_job(repo.library, job['id'], job['provider'])
        assert caught.value.code == 'profile_changed' and not calls
        assert repo.jobs.get_job(job['id']).status == 'failed'


@pytest.mark.parametrize('policy', POLICIES, ids=['direct', 'environment', 'proxy'])
@pytest.mark.parametrize('failure', [False, True], ids=['success', 'unknown'])
def test_capture_http_to_metadata_worker_uses_saved_policy_and_never_replays(app, monkeypatch, policy, failure):
    library, client = app
    saved = client.put('/api/capture-organizer/config', headers={'Origin': ORIGIN}, json={
        'enabled': True, 'base_url': 'https://organizer.invalid/v1', 'api_key': KEY, 'model': 'synthetic-vision', **policy})
    assert saved.status_code == 200, saved.text
    def reply(request):
        assert request.url.path == '/v1/chat/completions'
        assert json.loads(request.content)['model'] == 'synthetic-vision'
        if failure:
            raise httpx.ReadTimeout('synthetic-password private transport error', request=request)
        return httpx.Response(200, json={'choices': [{'message': {'content': json.dumps({'title': 'Synthetic title', 'collection': None})}}]})
    selected, requests = factory_spy(monkeypatch, reply)
    pairing = client.post('/api/capture-clients', headers={'Origin': ORIGIN}, json={'extension_id': 'abcdefghijklmnopabcdefghijklmnop'}).json()
    headers = {'Origin': 'chrome-extension://' + pairing['extension_id'], 'X-Capture-Token': pairing['token'], 'X-Capture-Instance': pairing['instance_id']}
    request_id = str(uuid4())
    def capture():
        return client.post('/api/captures', headers=headers, data={'request_id': request_id, 'prompt_text': 'Synthetic original prompt'},
                           files={'file': ('synthetic.png', image_bytes(), 'image/png')})
    created = capture()
    assert created.status_code == 200, created.text
    with connect(library) as conn:
        internal_id = conn.execute('SELECT request_id FROM capture_organizer_jobs WHERE item_id=?',
                                   (created.json()['item_id'],)).fetchone()[0]
    capture_organizer.run_job(library, internal_id)
    assert capture().status_code == 200
    capture_organizer.run_job(library, internal_id)
    receipt = client.post('/api/captures/receipts/' + request_id, headers=headers).json()
    assert receipt['organizer']['status'] == ('uncertain' if failure else 'succeeded')
    assert len(requests) == 1
    assert_policy(selected, policy)
    assert_public(receipt)
    assert PROXY.encode() not in (library / 'db.sqlite').read_bytes()
