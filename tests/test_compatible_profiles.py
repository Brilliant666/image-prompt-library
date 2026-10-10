"""Third-party profile routing and secret isolation without network requests."""
import base64
import json
from io import BytesIO

import httpx
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from backend.main import create_app
from backend.schemas import GenerationJobCreate
from backend.services.generation_jobs import GenerationJobConflict, GenerationJobRepository
from backend.services.openai_compatible import OpenAICompatibleConfig, OpenAICompatibleError, OpenAICompatibleProvider


@pytest.fixture
def profiles(tmp_path, monkeypatch):
    library = tmp_path / 'library'
    path = tmp_path / 'private' / 'profiles.json'
    monkeypatch.setenv('IMAGE_PROMPT_LIBRARY_OPENAI_COMPATIBLE_CONFIG_PATH', str(path))
    config = OpenAICompatibleConfig(path, library)
    config.save({'display_name': 'Original', 'base_url': 'https://first.example', 'api_key': 'test-first', 'model': 'model-first'})
    config.save({'display_name': 'Second', 'base_url': 'https://second.example', 'api_key': 'test-second', 'model': 'model-second'}, profile_id='second')
    return library, config, GenerationJobRepository(library)


def test_legacy_read_is_nonmutating_and_keys_are_per_profile(tmp_path):
    path = tmp_path / 'settings.json'
    raw = '{"base_url":"https://legacy.example/v1","api_key":"test-legacy","model":"model"}'
    path.write_text(raw)
    config = OpenAICompatibleConfig(path, tmp_path / 'library')
    assert config.public_profiles()['default_profile_id'] == 'legacy'
    assert path.read_text() == raw
    config.save({'base_url':'https://second.example', 'model':'', 'api_key':''}, profile_id='second')
    assert config.read('legacy')['api_key'] == 'test-legacy'
    assert config.read('second')['api_key'] == ''
    config.save({'api_key':''}, profile_id='legacy')
    assert config.read('legacy')['api_key'] == 'test-legacy'
    assert 'test-legacy' not in json.dumps(config.public_profiles())


def test_queue_pins_selected_profile_model_and_no_secret(profiles):
    library, config, repo = profiles
    job = repo.create_job(GenerationJobCreate(provider='openai_compatible', prompt_text='Synthetic', parameters={'compatible_profile_id':'second'}))
    assert job.model == 'model-second'
    config.set_default('legacy')
    config.save({'model':'model-changed'}, profile_id='second')
    requests = []
    def reply(request):
        requests.append(request)
        assert request.url.host == 'second.example'
        assert request.headers['authorization'] == 'Bearer test-second'
        assert json.loads(request.content)['model'] == 'model-second'
        buffer = BytesIO()
        Image.new('RGB', (8,8)).save(buffer, 'PNG')
        return httpx.Response(200, json={'data':[{'b64_json':base64.b64encode(buffer.getvalue()).decode()}]})
    with httpx.Client(transport=httpx.MockTransport(reply)) as client:
        result = OpenAICompatibleProvider(config, client).run_job(library, job.id)
    assert len(requests) == 1
    assert result.metadata['requested']['compatible_profile_id'] == 'second'
    assert result.metadata['requested']['compatible_profile_name'] == 'Second'
    assert 'test-second' not in json.dumps(result.model_dump())


def test_missing_profile_never_falls_back_at_create_execute_or_retry(profiles):
    library, config, repo = profiles
    job = repo.create_job(GenerationJobCreate(provider='openai_compatible', prompt_text='Synthetic', parameters={'compatible_profile_id':'second'}))
    config.delete('second')
    with pytest.raises(OpenAICompatibleError, match='no longer exists'):
        repo.create_job(GenerationJobCreate(provider='openai_compatible', prompt_text='Synthetic', parameters={'compatible_profile_id':'second'}))
    calls = []
    with httpx.Client(transport=httpx.MockTransport(lambda request: calls.append(request))) as client:
        with pytest.raises(OpenAICompatibleError, match='no longer exists'):
            OpenAICompatibleProvider(config, client).run_job(library, job.id)
    assert calls == []
    with pytest.raises(GenerationJobConflict, match='no longer exists'):
        repo.retry_failed_job(job.id)


def test_profile_endpoints_and_optional_default_model(profiles):
    library, config, _ = profiles
    client = TestClient(create_app(library_path=library))
    root = '/api/generation-providers/openai-compatible/profiles'
    response = client.put(root+'/third', json={'display_name':'Third','base_url':'https://third.example','api_key':'test-third','model':'','make_default':True})
    assert response.status_code == 200
    assert response.json()['default_profile_id'] == 'third'
    assert next(p for p in response.json()['profiles'] if p['id']=='third')['configured'] is True
    assert 'test-third' not in response.text
    assert config.status()['can_generate'] is True
    assert client.put(root+'/second/default').json()['default_profile_id'] == 'second'
    assert client.delete(root+'/third').status_code == 200
    assert client.put(root+'/bad-id', json={'base_url':'https://user:secret@example.com','api_key':'must-not-echo'}).status_code == 400
    assert 'must-not-echo' not in client.get(root).text


def test_batch_freezes_profile_and_legacy_retry_does_not_follow_default(profiles):
    _, config, repo = profiles
    group = repo.create_job_set(GenerationJobCreate(provider='openai_compatible', prompt_text='Synthetic', parameters={'compatible_profile_id':'second'}), 3)
    assert all(job.parameters['compatible_profile_id']=='second' for job in group.jobs)
    job = repo.create_job(GenerationJobCreate(provider='openai_compatible', prompt_text='Old'))
    # Represent a historical single-provider record with no profile identity.
    historical = job.model_copy(update={'parameters':{'model':'model-first'}})
    config.set_default('second')
    restored = repo._restore_compatible_request(historical)
    assert restored.parameters['compatible_profile_id'] == 'legacy'


def test_legacy_execution_keeps_original_endpoint_after_default_changes(profiles):
    library, config, repo = profiles
    job = repo.create_job(GenerationJobCreate(provider='openai_compatible', prompt_text='Synthetic'))
    from backend.db import connect
    with connect(library) as connection:
        connection.execute('UPDATE generation_jobs SET parameters=? WHERE id=?', (json.dumps({'model':'model-first'}), job.id))
    config.set_default('second')
    calls = []
    def response(request):
        calls.append(request)
        assert request.url.host == 'first.example'
        buffer = BytesIO()
        Image.new('RGB', (8,8)).save(buffer, 'PNG')
        return httpx.Response(200, json={'data':[{'b64_json':base64.b64encode(buffer.getvalue()).decode()}]})
    with httpx.Client(transport=httpx.MockTransport(response)) as client:
        result = OpenAICompatibleProvider(config, client).run_job(library, job.id)
    assert len(calls) == 1
    assert result.metadata['requested']['compatible_profile_id'] == 'legacy'


@pytest.mark.parametrize('profile_id', [[], {}, '', '../outside'])
def test_invalid_profile_identity_is_rejected(profiles, profile_id):
    _, config, _ = profiles
    with pytest.raises(OpenAICompatibleError, match='Invalid provider profile ID'):
        config.read(profile_id)


def test_first_profile_becomes_default_without_phantom_legacy(tmp_path):
    config = OpenAICompatibleConfig(tmp_path / 'private.json', tmp_path / 'library')
    assert config.public_profiles() == {'profiles': [], 'default_profile_id': None}
    config.save({'base_url':'https://first.example','api_key':'test-first'}, profile_id='first')
    assert config.public_profiles()['default_profile_id'] == 'first'
    assert [profile['id'] for profile in config.public_profiles()['profiles']] == ['first']
    assert config.status()['available'] is True
