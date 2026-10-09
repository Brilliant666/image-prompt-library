import json
import base64
from collections import deque
from io import BytesIO

import pytest
import httpx
from fastapi.testclient import TestClient
from PIL import Image

from backend.config import validate_app_owned_paths
from backend.main import create_app
from backend.schemas import GenerationJobCreate
from backend.services.generation_jobs import GenerationJobRepository


def test_config_api_never_returns_key_and_keeps_oauth(tmp_path, monkeypatch):
    private = tmp_path / 'private.json'
    monkeypatch.setenv('IMAGE_PROMPT_LIBRARY_OPENAI_COMPATIBLE_CONFIG_PATH', str(private))
    monkeypatch.setenv('IMAGE_PROMPT_LIBRARY_AUTH_PATH', str(tmp_path / 'oauth.json'))
    monkeypatch.setenv('IMAGE_PROMPT_LIBRARY_GROK_AUTH_PATH', str(tmp_path / 'grok.json'))
    client = TestClient(create_app(library_path=tmp_path / 'library'))
    response = client.put('/api/generation-providers/openai-compatible/config', json={
        'display_name': 'Test images', 'base_url': 'https://images.example/v1/v1',
        'model': 'requested', 'api_key': 'private-test-key', 'timeout': 30,
    })
    assert response.status_code == 200
    assert response.json()['api_key_present'] is True
    assert 'private-test-key' not in response.text
    assert response.json()['base_url'] == 'https://images.example/v1'
    assert client.put('/api/generation-providers/openai-compatible/config', json={'api_key': ''}).status_code == 200
    assert json.loads(private.read_text())['api_key'] == 'private-test-key'
    providers = client.get('/api/generation-providers').json()
    assert {p['provider'] for p in providers} >= {'openai_compatible', 'openai_codex_oauth_native', 'xai_grok_oauth'}
    compatible = next(p for p in providers if p['provider'] == 'openai_compatible')
    assert compatible['can_generate'] and not compatible['features']['title_suggestion']
    assert 'private-test-key' not in json.dumps(providers)
    invalid = client.put('/api/generation-providers/openai-compatible/config', json={'base_url': 'https://user:private-test-key@images.example'})
    assert invalid.status_code == 400 and 'private-test-key' not in invalid.text


def test_credentials_rejected_inside_library(tmp_path, monkeypatch):
    library = tmp_path / 'library'
    monkeypatch.setenv('IMAGE_PROMPT_LIBRARY_OPENAI_COMPATIBLE_CONFIG_PATH', str(library / 'key.json'))
    with pytest.raises(ValueError, match='IMAGE_PROMPT_LIBRARY_OPENAI_COMPATIBLE_CONFIG_PATH'):
        validate_app_owned_paths(library)


@pytest.mark.parametrize('reported_model', [None, 'actual-model'])
def test_real_repository_preview_save_preserves_requested_and_actual(tmp_path, reported_model):
    repo = GenerationJobRepository(tmp_path / 'library')
    job = repo.create_job(GenerationJobCreate(provider='openai_compatible', model='requested-model',
        prompt_text='A test image', parameters={'size': '1024x1024', 'quality': 'low'}))
    data = BytesIO()
    Image.new('RGB', (18, 12), 'blue').save(data, 'PNG')
    staged = repo.stage_result(job.id, data.getvalue(), 'test.png', {
        'requested': {'model': 'requested-model', 'size': '1024x1024', 'quality': 'low'},
        'response': {'model': reported_model, 'size': '18x12'},
    })
    assert staged.status == 'succeeded'
    assert (staged.result_width, staged.result_height) == (18, 12)
    accepted = repo.accept_result_as_new_item(job.id)
    assert accepted.job.status == 'accepted'
    assert accepted.item.images[0].generation_model == reported_model
    provenance = accepted.item.prompts[0].provenance
    assert provenance['requested_model'] == 'requested-model'
    assert provenance['model'] == reported_model
    assert provenance['response']['size'] == '18x12'
    assert provenance['requested']['size'] == '1024x1024'


@pytest.mark.parametrize('count', [3, 5, 10])
def test_compatible_generation_set_uses_single_image_jobs_without_retry(tmp_path, monkeypatch, count):
    from backend.services import generation_queue
    from backend.services.openai_compatible import OpenAICompatibleConfig, OpenAICompatibleProvider

    library = tmp_path / 'library'
    config = OpenAICompatibleConfig(tmp_path / 'private.json', library)
    config.save({'base_url': 'https://images.example', 'api_key': 'test-only-key', 'model': 'test-model'})
    image = BytesIO()
    Image.new('RGB', (8, 6), 'blue').save(image, 'PNG')
    requests = []

    def respond(request):
        payload = json.loads(request.content)
        requests.append(payload)
        assert request.url.path == '/v1/images/generations'
        assert payload['n'] == 1
        # A paid-request failure must not retry or prevent sibling jobs completing.
        if len(requests) == 2:
            return httpx.Response(429, json={'error': {'message': 'Rate limited'}})
        return httpx.Response(200, json={'data': [{'b64_json': base64.b64encode(image.getvalue()).decode()}]})

    pending = deque()

    class ControlledExecutor:
        def submit(self, function, *args):
            pending.append((function, args))

    monkeypatch.setattr(generation_queue, '_executor', ControlledExecutor())
    monkeypatch.setattr(generation_queue, '_active', set())
    monkeypatch.setattr(generation_queue, '_active_providers', {})
    with httpx.Client(transport=httpx.MockTransport(respond)) as transport:
        provider = OpenAICompatibleProvider(config, transport)
        monkeypatch.setattr(generation_queue, 'OpenAICompatibleProvider', lambda: provider)
        client = TestClient(create_app(library_path=library))
        created = client.post('/api/generation-jobs/sets', json={
            'count': count,
            'job': {'provider': 'openai_compatible', 'model': 'test-model',
                    'prompt_text': 'A blue cup', 'parameters': {'quality': 'low'}},
        })
        assert created.status_code == 200
        group = created.json()
        assert len(group['jobs']) == count
        assert len(pending) == min(count, generation_queue.MAX_CONCURRENT_GENERATION_JOBS)
        while pending:
            function, args = pending.popleft()
            function(*args)
        completed = client.get('/api/generation-jobs/sets/' + group['generation_group_id']).json()
        assert completed['succeeded'] == count - 1
        assert completed['failed'] == 1
        assert completed['queued'] == completed['running'] == 0
        assert len(requests) == count
        assert len({job['id'] for job in completed['jobs']}) == count
        generation_queue.enqueue_generation_jobs(library, provider='openai_compatible')
        assert not pending
        assert len(requests) == count
