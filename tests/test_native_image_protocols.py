"""Native API protocols reuse real tasks, frozen inputs and paid-result recovery."""
import base64
from contextlib import closing
import hashlib
from io import BytesIO
import json

import httpx
import pytest
from PIL import Image

from backend.db import connect
from backend.schemas import GenerationJobCreate
from backend.services.generation_jobs import GenerationJobRepository, GenerationJobConflict
from backend.services.openai_compatible import OpenAICompatibleConfig, OpenAICompatibleError, OpenAICompatibleApiKeyRequired
from backend.services.providers.registry import image_provider_for_profile, catalog_for_profile, executor_for
from backend.services.providers.profiles import normalize_profile_url
from backend.services.providers.native_params import GeminiParamMapper, SeedreamParamMapper
from backend.services.providers.adapters.native_images import UnexpectedFinalImages
from backend.services.agent_repository import profile_digest, public_profile_digest
from test_generation_result_recovery import fail_result_database


def picture(color='red', size=(24, 16), fmt='PNG'):
    stream = BytesIO()
    Image.new('RGB', size, color).save(stream, fmt)
    return stream.getvalue()


def gemini_result(data=None):
    return {'candidates': [{'finishReason': 'STOP', 'content': {'role': 'model', 'parts': [
        {'text': 'Synthetic final'}, {'inlineData': {'mimeType': 'image/png', 'data': base64.b64encode(data or picture()).decode()}}]}}],
        'usageMetadata': {'promptTokenCount': 12, 'candidatesTokenCount': 3}}


def seedream_result(data=None):
    return {'data': [{'b64_json': base64.b64encode(data or picture()).decode()}], 'usage': {'generated_images': 1}}


@pytest.fixture(autouse=True)
def isolated_transport(monkeypatch):
    monkeypatch.setattr(httpx.HTTPTransport, 'handle_request', lambda *a, **k: pytest.fail('External network is forbidden'))


@pytest.fixture
def native_case(tmp_path, monkeypatch):
    library = tmp_path/'library'
    config = OpenAICompatibleConfig(tmp_path/'private'/'profiles.json', library)
    monkeypatch.setenv('IMAGE_PROMPT_LIBRARY_OPENAI_COMPATIBLE_CONFIG_PATH', str(config.path))
    def save(protocol='gemini_native', **extra):
        value = {'display_name': 'Synthetic native API', 'base_url': 'https://native.example',
                 'protocol': protocol, 'api_key': 'native-fixture-only-key',
                 'model': 'gemini-nano-banana-2.1' if protocol == 'gemini_native' else 'doubao-seedream-4-5-251128', **extra}
        config.save(value, profile_id='native')
        return config.read('native')
    return library, config, save


@pytest.mark.parametrize('protocol,url,expected', [
    ('gemini_native', 'https://native.example', 'https://native.example/v1beta'),
    ('gemini_native', 'https://native.example/v1beta/', 'https://native.example/v1beta'),
    ('gemini_native', 'https://native.example/v1', 'https://native.example/v1'),
    ('seedream_native', 'https://native.example', 'https://native.example/api/v3'),
    ('seedream_native', 'https://native.example/api/v3/', 'https://native.example/api/v3'),
])
def test_explicit_version_root_is_not_duplicated(protocol, url, expected):
    assert normalize_profile_url(url, 'versioned', protocol) == expected
    assert normalize_profile_url('https://native.example/custom', 'custom', protocol) == 'https://native.example/custom'


@pytest.mark.parametrize('url', ['https://user:key@example.org', 'https://native.example?key=private',
    'https://native.example/models/x:generateContent', 'https://native.example/images/generations'])
def test_native_profile_rejects_embedded_credentials_or_endpoint(url):
    with pytest.raises(OpenAICompatibleError): normalize_profile_url(url, 'versioned', 'gemini_native')


def test_protocol_switch_requires_reentry_and_legacy_fingerprint_stays_stable(native_case):
    library, config, save = native_case
    config.save({'base_url': 'https://native.example/custom', 'base_url_mode': 'custom',
                 'api_key': 'native-fixture-only-key', 'model': 'alias'}, profile_id='native')
    old = config.read('native')
    legacy = {key: value for key, value in old.items() if key != 'protocol'}
    assert profile_digest(old) == profile_digest(legacy)
    assert public_profile_digest(old) == public_profile_digest(legacy)
    before = config.path.read_bytes()
    with pytest.raises(OpenAICompatibleApiKeyRequired):
        config.save({'protocol': 'gemini_native'}, profile_id='native')
    assert config.path.read_bytes() == before
    config.save({'protocol': 'gemini_native', 'api_key': 'native-fixture-only-key'}, profile_id='native')
    assert profile_digest(config.read('native')) != profile_digest(old)
    assert public_profile_digest(config.read('native')) != public_profile_digest(old)
    assert 'native-fixture-only-key' not in json.dumps(config.public_profiles())


@pytest.mark.parametrize('protocol', ['gemini_native', 'seedream_native'])
@pytest.mark.parametrize('references', [False, True])
def test_real_native_json_body_and_ordered_reference_bytes(native_case, protocol, references):
    library, config, save = native_case
    settings = save(protocol)
    params = {'compatible_profile_id': 'native', 'quality': 'auto', 'background': 'auto', 'output_format': 'auto', 'size': 'auto',
              'provider_options': {'aspect_ratio': '9:16', 'resolution': '2K'} if protocol == 'gemini_native' else {'watermark': False}}
    inputs = [('first.png', picture(), 'image/png'), ('second.png', picture('blue'), 'image/png')] if references else []
    prompt = '  Exact native prompt\n  Keep these spaces.  '
    calls = []
    def handler(request):
        calls.append(request)
        body = json.loads(request.content)
        assert request.method == 'POST'
        if protocol == 'gemini_native':
            assert request.headers['x-goog-api-key'] == 'native-fixture-only-key'
            assert 'authorization' not in request.headers
            assert str(request.url) == 'https://native.example/v1beta/models/gemini-nano-banana-2.1:generateContent'
            assert body['generationConfig'] == {'responseModalities': ['TEXT', 'IMAGE'], 'candidateCount': 1,
                'imageConfig': {'aspectRatio': '9:16', 'imageSize': '2K'}}
            assert body['contents'][0]['parts'][0] == {'text': prompt}
            assert [base64.b64decode(part['inlineData']['data']) for part in body['contents'][0]['parts'][1:]] == [entry[1] for entry in inputs]
            assert set(body) == {'contents', 'generationConfig'}
            return httpx.Response(200, json=gemini_result())
        assert request.headers['authorization'] == 'Bearer native-fixture-only-key'
        assert str(request.url) == 'https://native.example/api/v3/images/generations'
        assert body['prompt'] == prompt and body['watermark'] is False
        assert body['sequential_image_generation'] == 'disabled'
        assert [base64.b64decode(value.split(',', 1)[1]) for value in body.get('image', [])] == [entry[1] for entry in inputs]
        assert not any(key in body for key in ('quality', 'background', 'n', 'output_compression'))
        return httpx.Response(200, json=seedream_result())
    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        result = image_provider_for_profile(settings, config=config, http_client=client).generate(prompt, params, inputs)
    assert result.data == picture() and result.metadata['requested']['prompt'] == prompt
    assert result.metadata['protocol'] == protocol and len(calls) == 1
    assert 'native-fixture-only-key' not in json.dumps(result.metadata)


@pytest.mark.parametrize('field,value', [('quality', 'max'), ('background', 'transparent'),
    ('output_compression', 0), ('stream', True), ('provider_options', {'headers': {'Authorization': 'bad'}})])
def test_native_does_not_silently_drop_incompatible_explicit_parameters(native_case, field, value):
    library, config, save = native_case
    settings = save()
    calls = []
    with httpx.Client(transport=httpx.MockTransport(lambda request: calls.append(request))) as client:
        with pytest.raises(OpenAICompatibleError):
            image_provider_for_profile(settings, config=config, http_client=client).generate(
                'Synthetic', {'compatible_profile_id': 'native', 'size': 'auto', 'output_format': 'auto', field: value})
    assert calls == []


@pytest.mark.parametrize('status', [401, 403, 429, 503])
def test_native_http_failure_never_retries_or_echoes_key(native_case, status):
    library, config, save = native_case
    settings = save()
    calls = []
    def handler(request):
        calls.append(request)
        return httpx.Response(status, json={'error': {'message': 'native-fixture-only-key private response'}}, headers={'retry-after': '7'})
    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(OpenAICompatibleError) as caught:
            image_provider_for_profile(settings, config=config, http_client=client).generate('Synthetic', {'compatible_profile_id': 'native'})
    assert len(calls) == 1
    assert 'native-fixture-only-key' not in str(caught.value) + json.dumps(caught.value.diagnostics)


@pytest.mark.parametrize('finish', ['MAX_TOKENS', 'SAFETY', None])
def test_gemini_incomplete_or_refused_image_is_not_success(native_case, finish):
    library, config, save = native_case
    settings = save()
    payload = gemini_result()
    payload['candidates'][0]['finishReason'] = finish
    with httpx.Client(transport=httpx.MockTransport(lambda _: httpx.Response(200, json=payload))) as client:
        with pytest.raises(OpenAICompatibleError):
            image_provider_for_profile(settings, config=config, http_client=client).generate('Synthetic', {'compatible_profile_id': 'native'})


def test_gemini_catalog_pages_are_bounded_and_embedding_is_not_chat(native_case):
    _, config, save = native_case
    settings = save()
    calls = []
    def handler(request):
        calls.append(request)
        assert request.method == 'GET' and request.headers['x-goog-api-key'] == 'native-fixture-only-key'
        if len(calls) == 1:
            return httpx.Response(200, json={'models': [
                {'name': 'models/gemini-nano-banana-2.1', 'supportedGenerationMethods': ['generateContent']},
                {'name': 'models/unknown-image-name', 'supportedGenerationMethods': ['generateContent']}], 'nextPageToken': 'page-two'})
        assert request.url.params['pageToken'] == 'page-two'
        return httpx.Response(200, json={'models': [{'name': 'models/embed-model', 'supportedGenerationMethods': ['embedContent']}]})
    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        models = catalog_for_profile(settings).discover_models(settings['base_url'], settings['api_key'], client)
    assert [entry['image_generation'] for entry in models] == [True, None, False]
    assert len(calls) == 2 and config.read('native')['model'] == settings['model']


def test_seedream_catalog_is_reference_only_without_an_upstream_request(native_case):
    _, config, save = native_case
    settings = save('seedream_native', model='ep-user-entered')
    with httpx.Client(transport=httpx.MockTransport(lambda _: pytest.fail('Curated list must not probe a model'))) as client:
        models = catalog_for_profile(settings).discover_models(settings['base_url'], settings['api_key'], client)
    assert models and config.read('native')['model'] == 'ep-user-entered'


def test_gallery_queue_resolves_frozen_protocol_and_retains_results_on_database_failure(native_case, monkeypatch):
    import backend.services.providers.adapters.native_images as native
    library, config, save = native_case
    save('seedream_native')
    repo = GenerationJobRepository(library)
    job = repo.create_job(GenerationJobCreate(provider='openai_compatible', prompt_text='Synthetic result',
        parameters={'compatible_profile_id': 'native', 'size': '2K', 'quality': 'auto', 'output_format': 'auto'}))
    calls = []
    def handler(request):
        calls.append(request)
        return httpx.Response(200, json=seedream_result())
    monkeypatch.setattr(native, 'create_api_client', lambda *a, **k: httpx.Client(transport=httpx.MockTransport(handler)))
    with fail_result_database(monkeypatch, 'update'):
        pending = executor_for('openai_compatible').run_job(library, job.id)
    assert pending.id == job.id and pending.metadata.get('local_result_recovery')
    assert repo.recover_local_result(job.id).status == 'succeeded'
    assert repo.recover_local_result(job.id).result_sha256 == hashlib.sha256(picture()).hexdigest()
    assert len(calls) == 1 and repo.list_jobs().total == 1


def test_queued_native_task_cannot_switch_connection_or_protocol(native_case, monkeypatch):
    library, config, save = native_case
    save()
    repo = GenerationJobRepository(library)
    job = repo.create_job(GenerationJobCreate(provider='openai_compatible', prompt_text='Synthetic',
        parameters={'compatible_profile_id': 'native', 'size': 'auto', 'output_format': 'auto'}))
    assert job.parameters['protocol'] == 'gemini_native'
    save('seedream_native')
    with pytest.raises(OpenAICompatibleError, match='protocol changed'):
        executor_for('openai_compatible').run_job(library, job.id)
    assert repo.get_job(job.id).status == 'failed'


def test_unexpected_extra_finals_are_retained_and_block_paid_replay(native_case, monkeypatch):
    import backend.services.providers.adapters.native_images as native
    library, config, save = native_case
    save()
    repo = GenerationJobRepository(library)
    job = repo.create_job(GenerationJobCreate(provider='openai_compatible', prompt_text='One synthetic image',
        parameters={'compatible_profile_id': 'native', 'size': 'auto', 'output_format': 'auto'}))
    payload = gemini_result()
    payload['candidates'][0]['content']['parts'].append({'inlineData': {'mimeType': 'image/png', 'data': base64.b64encode(picture('blue')).decode()}})
    calls = []
    def handler(request):
        calls.append(request)
        return httpx.Response(200, json=payload)
    monkeypatch.setattr(native, 'create_api_client', lambda *a, **k: httpx.Client(transport=httpx.MockTransport(handler)))
    returned = executor_for('openai_compatible').run_job(library, job.id)
    assert returned.metadata['local_result_recovery']['state'] == 'blocked'
    files = list((library/'generation-results'/job.id).glob('result-*'))
    assert {path.read_bytes() for path in files} == {picture(), picture('blue')}
    with pytest.raises(GenerationJobConflict): repo.retry_failed_job(job.id)
    assert len(calls) == 1


def test_exact_4k_square_survives_stage_library_accept_and_reference(native_case):
    from backend.services.image_store import MAX_IMAGE_PIXELS
    library, config, save = native_case
    save('seedream_native')
    assert 4096 * 4096 <= MAX_IMAGE_PIXELS <= 20_000_000
    data = picture(size=(4096, 4096))
    repo = GenerationJobRepository(library)
    job = repo.create_job(GenerationJobCreate(provider='openai_compatible', prompt_text='Synthetic 4K',
        parameters={'compatible_profile_id': 'native', 'size': '4K', 'output_format': 'auto'}))
    result = repo.stage_result(job.id, data, '4k.png')
    assert result.result_width == result.result_height == 4096
    assert (library/result.result_path).read_bytes() == data
    # The exact same validator is used when the result is frozen as an input.
    from backend.services.generation_jobs import _validate_storeable_image_bytes
    assert _validate_storeable_image_bytes(data)[1:] == (4096, 4096)


@pytest.mark.parametrize('model', ['doubao-seedream-5-0-lite-260128', 'doubao-seedream-5-0-pro-260628', 'doubao-seedream-5-0-flash-260915'])
def test_seedream_documented_model_queue_uses_native_parameters(native_case, monkeypatch, model):
    library, config, save = native_case
    save('seedream_native', model=model)
    repo = GenerationJobRepository(library)
    job = repo.create_job(GenerationJobCreate(provider='openai_compatible', prompt_text='  Exact model fixture\n',
        parameters={'compatible_profile_id': 'native', 'protocol': 'seedream_native', 'model': model,
                    'size': '2K', 'quality': 'auto', 'background': 'auto', 'output_format': 'auto',
                    'provider_options': {'watermark': False}, 'n': 1, 'input_images': []}))
    calls = []
    def handler(request):
        calls.append(request)
        payload = json.loads(request.content)
        assert payload['model'] == model and payload['size'] == '2K' and payload['watermark'] is False
        assert payload.get('sequential_image_generation') == ('disabled' if model.endswith('lite-260128') else None)
        return httpx.Response(200, json=seedream_result())
    monkeypatch.setattr(httpx, 'HTTPTransport', lambda **kwargs: httpx.MockTransport(handler))
    result = executor_for('openai_compatible').run_job(library, job.id)
    assert result.status == 'succeeded' and len(calls) == 1
