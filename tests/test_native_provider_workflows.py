"""Native protocols use production Agent/queue/Library paths with synthetic HTTP."""
import base64
from contextlib import closing
from io import BytesIO
import json

import httpx
import pytest
from PIL import Image
from fastapi.testclient import TestClient

from backend.agent_schemas import AgentConfigSave, AgentPromptExecutionCreate
from backend.main import create_app
from backend.services import agent_execution as execution
from backend.services.openai_compatible import OpenAICompatibleConfig, OpenAICompatibleError
from backend.services.providers.registry import image_provider_for_profile, executor_for
from backend.services.providers.native_params import GeminiParamMapper, SeedreamParamMapper
from test_agent_image_selection import repo, body
from test_agent_recipe_execution import prepare, EXACT
from test_agent_workspaces import image_bytes
from test_native_image_protocols import native_case, gemini_result, seedream_result, picture, isolated_transport


def configure_native(repo, protocol):
    store = OpenAICompatibleConfig(library_path=repo.library)
    model = 'gemini-nano-banana-2.1' if protocol == 'gemini_native' else 'doubao-seedream-4-5-251128'
    store.save({'protocol': protocol, 'base_url': 'http://127.0.0.1:1',
                'api_key': 'native-synthetic-key', 'model': model}, profile_id='image_a')
    current = repo.config()
    repo.save_config(AgentConfigSave(expectedRevision=current['revision'],
        config={**current['config'], 'imageModel': model}))
    return store


def image_response(protocol):
    return gemini_result(image_bytes('green')) if protocol == 'gemini_native' else seedream_result(image_bytes('green'))


def wire_pixels(protocol, payload):
    if protocol == 'gemini_native':
        return [base64.b64decode(part['inlineData']['data']) for part in payload['contents'][0]['parts'][1:]]
    return [base64.b64decode(value.split(',', 1)[1]) for value in payload.get('image', [])]


@pytest.mark.parametrize('protocol', ['gemini_native', 'seedream_native'])
def test_confirmed_recipe_reaches_native_protocol_without_text_post_and_reuses_receipt(repo, monkeypatch, protocol):
    configure_native(repo, protocol)
    value, assets = prepare(repo, refs=2)
    value['params'] = {'size': 'auto', 'quality': 'auto', 'output_format': 'auto',
                      'provider_options': {'aspect_ratio': '3:4'} if protocol == 'gemini_native' else {'watermark': False}}
    calls = []
    def handler(request):
        calls.append(request)
        assert request.method == 'POST' and '/responses' not in request.url.path
        payload = json.loads(request.content)
        prompt = payload['contents'][0]['parts'][0]['text'] if protocol == 'gemini_native' else payload['prompt']
        assert prompt == EXACT
        assert wire_pixels(protocol, payload) == [image_bytes('red'), image_bytes('blue')]
        return httpx.Response(200, json=image_response(protocol))
    monkeypatch.setattr(httpx, 'HTTPTransport', lambda **kwargs: httpx.MockTransport(handler))
    payload = AgentPromptExecutionCreate.model_validate(value)
    _, created = repo.create_prompt_execution('conversation', payload)
    assert created and calls == []
    execution.run_request(repo.library, 'direct')
    result = repo.request('direct')
    assert result['state'] == 'completed', result['error']
    assert result['usage'] == {'responseStepsStarted': 0, 'imageJobsCreated': 1}
    job = repo.jobs.get_job(result['round']['outputTaskIds'][0])
    assert job.status == 'succeeded' and job.parameters['protocol'] == protocol
    assert (repo.library / job.result_path).read_bytes() == image_bytes('green')
    assert [ref['assetId'] for ref in result['round']['directRecipe']['references']] == assets
    assert not repo.create_prompt_execution('conversation', payload)[1]
    execution.run_request(repo.library, 'direct')
    assert len(calls) == 1
    accepted = repo.jobs.accept_result_as_new_item(job.id)
    assert accepted.item.images and accepted.item.prompts[0].text == EXACT
    assert (repo.library / accepted.item.images[0].original_path).read_bytes() == image_bytes('green')


@pytest.mark.parametrize('protocol', ['gemini_native', 'seedream_native'])
def test_normal_hybrid_round_keeps_responses_text_and_dispatches_native_image(repo, monkeypatch, protocol):
    configure_native(repo, protocol)
    calls = []
    def handler(request):
        calls.append(request)
        payload = json.loads(request.content)
        if request.url.path.endswith('/responses'):
            return httpx.Response(200, json={'status': 'completed', 'output': [{
                'type': 'function_call', 'id': 'fc_native', 'call_id': 'call_native',
                'name': 'generate_image_batch', 'arguments': json.dumps({'images': [{'id': 'one', 'prompt': '  Exact native output\n'}], 'finish_after_generation': True})}]})
        return httpx.Response(200, json=image_response(protocol))
    monkeypatch.setattr(httpx, 'HTTPTransport', lambda **kwargs: httpx.MockTransport(handler))
    payload = body(repo).model_copy(update={'params': body(repo).params.model_copy(update={
        'size': 'auto', 'output_format': 'auto', 'provider_options': {}})})
    repo.create_round('conversation', payload)
    execution.run_request(repo.library, 'request')
    result = repo.request('request')
    assert result['state'] == 'completed', result['error']
    assert sum(call.url.path.endswith('/responses') for call in calls) == 1
    assert len(calls) == 2
    job = repo.jobs.get_job(result['round']['outputTaskIds'][0])
    assert job.status == 'succeeded' and job.parameters['protocol'] == protocol


@pytest.mark.parametrize('size', [(4096, 4096), (3584, 4800), (1536, 12288)])
def test_documented_4k_outputs_are_accepted_without_mutating_pixels(native_case, size):
    from backend.schemas import GenerationJobCreate
    from backend.services.generation_jobs import GenerationJobRepository
    library, config, save = native_case
    save()
    jobs = GenerationJobRepository(library)
    data = picture(size=size)
    job = jobs.create_job(GenerationJobCreate(provider='openai_compatible', prompt_text='Synthetic 4K',
        parameters={'compatible_profile_id': 'native', 'size': 'auto', 'output_format': 'auto',
                    'provider_options': {'resolution': '4K'}}))
    jobs.stage_result(job.id, data, '4k.png')
    accepted = jobs.accept_result_as_new_item(job.id)
    assert (accepted.item.images[0].width, accepted.item.images[0].height) == size
    assert (library / accepted.item.images[0].original_path).read_bytes() == data
    from backend.services.generation_jobs import _validate_storeable_image_bytes
    assert _validate_storeable_image_bytes(data)[1:] == size


@pytest.mark.parametrize('model,options', [
    ('gemini-3-pro-image', {'resolution': '512'}),
    ('gemini-3-pro-image-preview', {'aspect_ratio': '1:8'}),
    ('gemini-nano-banana-2.1', {'resolution': '512'}),
    ('gemini-3.1-flash-lite-image', {'resolution': '4K'}),
    ('gemini-2.5-flash-image', {'resolution': '2K'}),
])
def test_known_gemini_model_rejects_unsupported_options_before_any_post(model, options):
    with pytest.raises(OpenAICompatibleError):
        GeminiParamMapper().normalize({'model': model, 'output_format': 'auto', 'provider_options': options})


@pytest.mark.parametrize('options', [[], False, {'mask': 'x'}, {'resolution': 0}])
def test_malformed_or_unmapped_native_options_never_silently_disappear(options):
    with pytest.raises(OpenAICompatibleError):
        GeminiParamMapper().normalize({'model': 'alias', 'provider_options': options})


def test_unexpected_candidate_failure_preserves_other_valid_paid_final(native_case, monkeypatch):
    from backend.schemas import GenerationJobCreate
    from backend.services.generation_jobs import GenerationJobRepository, GenerationJobConflict
    library, config, save = native_case
    save()
    jobs = GenerationJobRepository(library)
    job = jobs.create_job(GenerationJobCreate(provider='openai_compatible', prompt_text='One synthetic',
        parameters={'compatible_profile_id': 'native', 'size': 'auto', 'output_format': 'auto'}))
    payload = gemini_result()
    payload['candidates'].append({'finishReason': 'SAFETY', 'content': {'parts': []}})
    calls = []
    def handler(request):
        calls.append(request)
        return httpx.Response(200, json=payload)
    monkeypatch.setattr(httpx, 'HTTPTransport', lambda **kwargs: httpx.MockTransport(handler))
    pending = executor_for('openai_compatible').run_job(library, job.id)
    assert pending.metadata['local_result_recovery']['state'] == 'blocked'
    files = list((library/'generation-results'/job.id).glob('result-*'))
    assert len(files) == 1 and files[0].read_bytes() == picture()
    with pytest.raises(GenerationJobConflict): jobs.retry_failed_job(job.id)
    assert len(calls) == 1


def test_new_protocol_profile_round_trip_through_http_does_not_generate(repo):
    client = TestClient(create_app(library_path=repo.library))
    payload = {'display_name': 'Synthetic Gemini', 'base_url': 'https://native.example',
        'protocol': 'gemini_native', 'api_key': 'only-test-key', 'model': 'manual-native-alias'}
    response = client.put('/api/generation-providers/openai-compatible/profiles/native', json=payload)
    assert response.status_code == 200, response.text
    saved = next(value for value in response.json()['profiles'] if value['id'] == 'native')
    assert saved['protocol'] == 'gemini_native' and saved['model'] == 'manual-native-alias'
    assert saved['api_key_present'] and 'only-test-key' not in response.text
    assert repo.jobs.list_jobs().total == 0
