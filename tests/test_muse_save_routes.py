"""Both saved-profile APIs preserve the Muse discovery boundary, without paid I/O."""
import httpx
import pytest
from fastapi.testclient import TestClient

from backend.main import create_app
from backend.services.openai_compatible import OpenAICompatibleConfig
from backend.services.providers.adapters.openai_compatible import OpenAIModelCatalog
from test_agent_workspaces import isolated


ROOT = '/api/generation-providers'
KEY = 'synthetic-muse-save-key'
CHANGED = {'base_url': 'https://changed.invalid/v1', 'api_key': KEY,
           'service_preset': 'muse', 'service_preset_mode': 'auto'}


@pytest.fixture
def saved(isolated, monkeypatch):
    monkeypatch.setattr(httpx.HTTPTransport, 'handle_request',
                        lambda *args, **kwargs: pytest.fail('Real network is forbidden'))
    store = OpenAICompatibleConfig(library_path=isolated)
    store.save({'base_url': 'https://original.invalid/v1', 'api_key': KEY,
                'model': 'muse-image', 'network_mode': 'environment',
                'service_preset': 'muse', 'service_preset_mode': 'auto'}, profile_id='muse')
    client = TestClient(create_app(library_path=isolated))
    yield store, client
    client.close()


@pytest.mark.parametrize('path', ['/openai-compatible/config', '/openai-compatible/profiles/muse'])
def test_changed_target_save_requires_discovery_and_never_writes_or_calls_provider(saved, path):
    store, client = saved
    before = store.path.read_bytes()
    response = client.put(ROOT + path, json=CHANGED)
    assert response.status_code == 422, response.text
    assert response.json()['detail'].startswith('Run model discovery again for the changed connection')
    assert KEY not in response.text and 'changed.invalid' not in response.text
    assert store.path.read_bytes() == before


@pytest.mark.parametrize('path', ['/openai-compatible/config', '/openai-compatible/profiles/muse'])
def test_fresh_draft_discovery_allows_one_save_without_another_provider_request(saved, monkeypatch, path):
    store, client = saved
    calls = []

    def reply(request):
        calls.append(request)
        assert request.method == 'GET' and str(request.url) == 'https://changed.invalid/v1/models'
        return httpx.Response(200, json={'data': [{'id': model, 'owned_by': 'muse'}
            for model in ('muse-image', 'muse-spark', 'muse-video')]})

    original = OpenAIModelCatalog.discover_models
    with httpx.Client(transport=httpx.MockTransport(reply)) as transport:
        monkeypatch.setattr(OpenAIModelCatalog, 'discover_models',
            lambda self, root, key, client=None, **kwargs: original(self, root, key, transport, **kwargs))
        checked = client.post(ROOT + '/api-connections/models/preview',
                              json={'profile_id': 'muse', **CHANGED})
        assert checked.status_code == 200, checked.text
        assert checked.json()['detected_service_preset'] == 'muse'
        response = client.put(ROOT + path, json=CHANGED)
    assert response.status_code == 200, response.text
    assert len(calls) == 1 and calls[0].method == 'GET'
    assert store.read('muse')['base_url'] == CHANGED['base_url']
    assert store.read('muse')['service_preset'] == 'muse'
    assert KEY not in response.text
