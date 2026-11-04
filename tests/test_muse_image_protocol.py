"""Muse uses the existing image lifecycle, with explicit connection adaptation.

All pictures, credentials and HTTP responses are synthetic. The multipart
assertions intentionally parse real provider requests, rather than mapper state.
"""
import base64
from email.parser import BytesParser
from email.policy import default
from io import BytesIO
import json

import httpx
import pytest
from PIL import Image

from backend.agent_schemas import AgentConfigSave, AgentPromptExecutionCreate
from backend.schemas import GenerationJobCreate
from backend.services import agent_execution as execution
from backend.services.agent_repository import AgentError, profile_digest, public_profile_digest
from backend.services.api_connections import discover_connection_draft
from backend.services.generation_jobs import GenerationJobRepository, GenerationJobConflict
from backend.services.model_catalog import connection_fingerprint
from backend.services.openai_compatible import OpenAICompatibleConfig, OpenAICompatibleError, OpenAICompatibleProvider
from test_agent_image_selection import repo, body
from test_agent_recipe_execution import prepare, EXACT
from test_agent_workspaces import image_bytes


def picture(color='orange'):
    output = BytesIO()
    Image.new('RGB', (24, 16), color).save(output, 'PNG')
    return output.getvalue()


def final_image(data=None):
    return {'data': [{'b64_json': base64.b64encode(data or picture()).decode()}]}


def multipart(request):
    message = BytesParser(policy=default).parsebytes(
        ('Content-Type: ' + request.headers['content-type'] + '\r\n\r\n').encode() + request.content)
    return [(part.get_param('name', header='content-disposition'), part.get_payload(decode=True))
            for part in message.iter_parts()]


@pytest.fixture(autouse=True)
def no_live_network(monkeypatch):
    monkeypatch.setattr(httpx.HTTPTransport, 'handle_request',
                        lambda *a, **kw: pytest.fail('Real network is forbidden'))


@pytest.fixture
def config(tmp_path, monkeypatch):
    value = OpenAICompatibleConfig(tmp_path / 'private' / 'profiles.json', tmp_path / 'library')
    monkeypatch.setenv('IMAGE_PROMPT_LIBRARY_OPENAI_COMPATIBLE_CONFIG_PATH', str(value.path))
    value.save({'display_name': 'Synthetic Muse', 'base_url': 'https://muse.invalid',
                'api_key': 'fixture-only-secret', 'model': 'muse-image', 'service_preset': 'muse'}, profile_id='muse')
    return value


def test_explicit_preset_is_saved_and_isolated_from_other_protocols(config):
    saved = config.read('muse')
    assert saved['service_preset'] == 'muse'
    public = config.public('muse')
    assert public['service_preset'] == 'muse' and public['api_key_present'] is True
    assert 'fixture-only-secret' not in json.dumps(public)
    assert public['image_capabilities']['max_input_images'] == 4
    assert public['image_capabilities']['stream'] is False
    for changes in ({'service_preset': 'unknown'}, {'protocol': 'gemini_native'},
                    {'stream': True}, {'partial_images': 1}):
        before = config.path.read_bytes()
        with pytest.raises(OpenAICompatibleError):
            config.save(changes, profile_id='muse')
        assert config.path.read_bytes() == before


def test_preset_participates_in_catalog_and_execution_identity(config):
    settings = config.read('muse')
    generic = {**settings, 'service_preset': 'generic'}
    assert connection_fingerprint(settings, settings['base_url']) != connection_fingerprint(generic, generic['base_url'])
    assert profile_digest(settings) != profile_digest(generic)
    assert public_profile_digest(settings) != public_profile_digest(generic)
    # Old generic profiles retain their frozen identity after the optional field is introduced.
    absent = {key: value for key, value in generic.items() if key != 'service_preset'}
    assert profile_digest(generic) == profile_digest(absent)
    assert public_profile_digest(generic) == public_profile_digest(absent)
    assert connection_fingerprint(generic, generic['base_url']) == connection_fingerprint(absent, absent['base_url'])


def test_muse_discovery_annotations_are_documented_and_do_not_invent_models(config):
    requests = []
    def respond(request):
        requests.append(request)
        assert request.method == 'GET'
        return httpx.Response(200, json={'data': [{'id': name} for name in
            ('muse-image', 'muse-spark', 'muse-video', 'custom-alias')]})
    before = config.path.read_bytes()
    with httpx.Client(transport=httpx.MockTransport(respond)) as client:
        result = discover_connection_draft(config, {'profile_id': 'muse', 'protocol': 'openai_compatible',
            'service_preset': 'muse', 'base_url': 'https://muse.invalid', 'base_url_mode': 'versioned'}, client)
    assert len(requests) == 1 and result['generation_checked'] is False
    models = {model['id']: model for model in result['models']}
    assert models['muse-image']['image_generation'] is True
    assert models['muse-spark']['text_generation'] is True and models['muse-spark']['image_generation'] is False
    assert models['muse-video']['image_generation'] is False and models['muse-video']['text_generation'] is False
    assert models['muse-image']['capability_source'] == 'documentation'
    assert models['custom-alias']['image_generation'] is None
    assert config.path.read_bytes() == before


@pytest.mark.parametrize('editing', [False, True])
def test_provider_sends_exact_prompt_reference_bytes_and_supported_fields(config, editing):
    calls = []
    inputs = [('red.png', picture('red'), 'image/png'), ('blue.png', picture('blue'), 'image/png')]
    exact = '  Synthetic prompt\nPreserve punctuation and spaces.  '
    def respond(request):
        calls.append(request)
        assert request.url.path == ('/v1/images/edits' if editing else '/v1/images/generations')
        if editing:
            sent = multipart(request)
            assert [data for name, data in sent if name == 'image'] == [entry[1] for entry in inputs]
            assert not any(name == 'image[]' for name, _ in sent)
            values = {name: data.decode() for name, data in sent if name != 'image'}
            assert values['n'] == '1'
        else:
            values = json.loads(request.content)
            assert values['n'] == 1
        assert values['prompt'] == exact
        assert values['model'] == 'muse-image'
        assert values['aspect_ratio'] == '3:4'
        assert not {'quality', 'background', 'output_format', 'output_compression', 'moderation',
                    'stream', 'partial_images'} & values.keys()
        return httpx.Response(200, json=final_image())
    with httpx.Client(transport=httpx.MockTransport(respond)) as client:
        data, _, _ = OpenAICompatibleProvider(config, client).generate(exact, {
            'compatible_profile_id': 'muse', 'service_preset': 'muse', 'model': 'muse-image', 'size': 'auto',
            'requested_aspect_ratio': '3:4', 'quality': 'max', 'background': 'auto',
            'output_format': 'jpeg', 'output_compression': 0, 'moderation': 'low'}, inputs if editing else None)
    assert data == picture() and len(calls) == 1


def test_generic_connection_keeps_array_multipart_even_for_muse_named_model(config):
    config.save({'service_preset': 'generic'}, profile_id='muse')
    calls = []
    def respond(request):
        calls.append(request)
        assert [data for name, data in multipart(request) if name == 'image[]'] == [picture()]
        return httpx.Response(200, json=final_image())
    with httpx.Client(transport=httpx.MockTransport(respond)) as client:
        OpenAICompatibleProvider(config, client).generate('Synthetic generic',
            {'compatible_profile_id': 'muse'}, [('image.png', picture(), 'image/png')])
    assert len(calls) == 1


@pytest.mark.parametrize('size,ratio', [('2480x3296', '3:4'), ('1600x900', '16:9'), ('1024x1024', '1:1')])
def test_existing_pixel_settings_are_mapped_to_documented_muse_ratio(config, size, ratio):
    calls = []
    def respond(request):
        calls.append(request)
        sent = json.loads(request.content)
        assert sent['size'] == 'auto' and sent['aspect_ratio'] == ratio
        return httpx.Response(200, json=final_image())
    with httpx.Client(transport=httpx.MockTransport(respond)) as client:
        OpenAICompatibleProvider(config, client).generate('Synthetic aspect ratio',
            {'compatible_profile_id': 'muse', 'service_preset': 'muse', 'size': size})
    assert len(calls) == 1


@pytest.mark.parametrize('parameters', [{'size': '123x456'}, {'size': 'auto', 'requested_aspect_ratio': '2:3'}])
def test_unsupported_muse_ratio_is_not_silently_rewritten(config, parameters):
    with httpx.Client(transport=httpx.MockTransport(lambda request: pytest.fail('Must not POST unsupported ratio'))) as client:
        with pytest.raises(OpenAICompatibleError):
            OpenAICompatibleProvider(config, client).generate('Synthetic unsupported ratio',
                {'compatible_profile_id': 'muse', 'service_preset': 'muse', **parameters})


@pytest.mark.parametrize('model', ['muse-spark', 'muse-video'])
def test_non_image_muse_models_are_rejected_without_post(config, model):
    with httpx.Client(transport=httpx.MockTransport(lambda request: pytest.fail('Must not POST'))) as client:
        with pytest.raises(OpenAICompatibleError):
            OpenAICompatibleProvider(config, client).generate('Synthetic',
                {'compatible_profile_id': 'muse', 'service_preset': 'muse', 'model': model})


@pytest.mark.parametrize('overflow', ['count', 'single', 'total'])
def test_reference_limits_are_checked_before_post(config, overflow):
    one = picture()
    inputs = [('image.png', one, 'image/png')] * 5 if overflow == 'count' else [
        ('image.png', one + b'\0' * (10 * 1024 * 1024 + 1 - len(one)), 'image/png')]
    if overflow == 'total':
        inputs = [('image.png', one + b'\0' * (9 * 1024 * 1024 - len(one)), 'image/png')] * 3
    with httpx.Client(transport=httpx.MockTransport(lambda request: pytest.fail('Must not POST oversized references'))) as client:
        with pytest.raises(OpenAICompatibleError):
            OpenAICompatibleProvider(config, client).generate('Synthetic',
                {'compatible_profile_id': 'muse', 'service_preset': 'muse'}, inputs)


def test_queued_job_cannot_silently_use_new_preset(config):
    jobs = GenerationJobRepository(config.library_path)
    job = jobs.create_job(GenerationJobCreate(provider='openai_compatible', prompt_text='Synthetic frozen task',
        parameters={'compatible_profile_id': 'muse'}))
    assert job.parameters['service_preset'] == 'muse'
    config.save({'service_preset': 'generic'}, profile_id='muse')
    with httpx.Client(transport=httpx.MockTransport(lambda request: pytest.fail('Changed preset must not POST'))) as client:
        with pytest.raises(OpenAICompatibleError):
            OpenAICompatibleProvider(config, client).run_job(config.library_path, job.id)
    assert jobs.get_job(job.id).status == 'failed'


def test_upstream_failure_does_not_replay_paid_post(config):
    jobs = GenerationJobRepository(config.library_path)
    job = jobs.create_job(GenerationJobCreate(provider='openai_compatible', prompt_text='Synthetic rejected request',
        parameters={'compatible_profile_id': 'muse'}))
    calls = []
    def reject(request):
        calls.append(request)
        return httpx.Response(402, json={'error': {'code': 'insufficient_quota'}})
    with httpx.Client(transport=httpx.MockTransport(reject)) as client:
        provider = OpenAICompatibleProvider(config, client)
        with pytest.raises(OpenAICompatibleError):
            provider.run_job(config.library_path, job.id)
        with pytest.raises(GenerationJobConflict):
            provider.run_job(config.library_path, job.id)
    assert len(calls) == 1 and jobs.get_job(job.id).status == 'failed'


def configure_muse(repo):
    store = OpenAICompatibleConfig(library_path=repo.library)
    store.save({'service_preset': 'muse', 'model': 'muse-image'}, profile_id='image_a')
    current = repo.config()
    repo.save_config(AgentConfigSave(expectedRevision=current['revision'],
        config={**current['config'], 'imageModel': 'muse-image'}))
    return store


def test_hybrid_direct_recipe_reuses_queue_library_and_receipt_without_text_post(repo, monkeypatch):
    configure_muse(repo)
    value, assets = prepare(repo, refs=2)
    value['params'] = {'size': 'auto', 'requested_aspect_ratio': '3:4', 'quality': 'auto', 'output_format': 'png'}
    calls = []
    def respond(request):
        calls.append(request)
        assert request.method == 'POST' and request.url.path == '/v1/images/edits'
        sent = multipart(request)
        assert next(data.decode() for name, data in sent if name == 'prompt') == EXACT
        assert [data for name, data in sent if name == 'image'] == [image_bytes('red'), image_bytes('blue')]
        return httpx.Response(200, json=final_image())
    monkeypatch.setattr(httpx, 'HTTPTransport', lambda **kw: httpx.MockTransport(respond))
    payload = AgentPromptExecutionCreate.model_validate(value)
    _, created = repo.create_prompt_execution('conversation', payload)
    assert created and calls == []
    execution.run_request(repo.library, 'direct')
    result = repo.request('direct')
    assert result['state'] == 'completed', result['error']
    assert result['usage'] == {'responseStepsStarted': 0, 'imageJobsCreated': 1}
    job = repo.jobs.get_job(result['round']['outputTaskIds'][0])
    assert job.status == 'succeeded' and job.parameters['service_preset'] == 'muse'
    assert (repo.library / job.result_path).read_bytes() == picture()
    assert [ref['assetId'] for ref in result['round']['directRecipe']['references']] == assets
    accepted = repo.jobs.accept_result_as_new_item(job.id)
    assert accepted.item.prompts[0].text == EXACT
    assert (repo.library / accepted.item.images[0].original_path).read_bytes() == picture()
    assert not repo.create_prompt_execution('conversation', payload)[1]
    execution.run_request(repo.library, 'direct')
    assert len(calls) == 1


def test_muse_is_not_silently_accepted_as_agent_tool_controller(repo, monkeypatch):
    configure_muse(repo)
    config = repo.config()
    calls = []
    monkeypatch.setattr(httpx, 'HTTPTransport', lambda **kw: httpx.MockTransport(
        lambda request: calls.append(request) or httpx.Response(200, json={})))
    with pytest.raises(AgentError):
        repo.save_config(AgentConfigSave(expectedRevision=config['revision'], config={
            **config['config'], 'textProfileId': 'image_a', 'textModel': 'muse-spark'}))
        repo.create_round('conversation', body(repo))
    assert calls == []


def test_hybrid_keeps_independent_responses_controller_and_muse_images(repo, monkeypatch):
    configure_muse(repo)
    calls = []
    def respond(request):
        calls.append(request)
        if request.url.path == '/v1/responses':
            return httpx.Response(200, json={'status': 'completed', 'output': [{
                'type': 'function_call', 'id': 'fc_muse', 'call_id': 'call_muse',
                'name': 'generate_image_batch', 'arguments': json.dumps({
                    'images': [{'id': 'one', 'prompt': '  Synthetic Muse image\n'}],
                    'finish_after_generation': True})}]})
        assert request.url.path == '/v1/images/generations'
        sent = json.loads(request.content)
        assert sent['model'] == 'muse-image' and sent['prompt'] == '  Synthetic Muse image\n'
        assert 'quality' not in sent
        return httpx.Response(200, json=final_image())
    monkeypatch.setattr(httpx, 'HTTPTransport', lambda **kw: httpx.MockTransport(respond))
    repo.create_round('conversation', body(repo))
    execution.run_request(repo.library, 'request')
    result = repo.request('request')
    assert result['state'] == 'completed', result['error']
    assert len(calls) == 2 and sum(r.url.path == '/v1/responses' for r in calls) == 1
    job = repo.jobs.get_job(result['round']['outputTaskIds'][0])
    assert job.status == 'succeeded' and job.parameters['service_preset'] == 'muse'


def test_agent_queued_recipe_cannot_silently_change_image_adaptation(repo, monkeypatch):
    store = configure_muse(repo)
    value, _ = prepare(repo, refs=1)
    value['params'] = {'size': 'auto', 'quality': 'auto'}
    repo.create_prompt_execution('conversation', AgentPromptExecutionCreate.model_validate(value))
    store.save({'service_preset': 'generic'}, profile_id='image_a')
    calls = []
    monkeypatch.setattr(httpx, 'HTTPTransport', lambda **kw: httpx.MockTransport(
        lambda request: calls.append(request) or httpx.Response(200, json=final_image())))
    execution.run_request(repo.library, 'direct')
    result = repo.request('direct')
    assert result['state'] != 'completed' and result['error']
    assert calls == []
