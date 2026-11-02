"""Provider extraction contracts: real transports are synthetic, identities stay stable."""
import base64
from contextlib import contextmanager
from copy import deepcopy
from email.parser import BytesParser
from email.policy import default
import json

import httpx
import pytest

from backend.services.providers.base import ImageResult, ModelCapabilities
from backend.services.providers.errors import ProviderError
from backend.services.providers.params import CanonicalImageRequest, OpenAIImageParamMapper
from backend.services.providers import registry
from backend.services.openai_compatible import OpenAICompatibleConfig, OpenAICompatibleProvider
from backend.services.model_catalog import ModelCatalogCache, connection_fingerprint
from test_openai_compatible import png


@pytest.fixture(autouse=True)
def no_external_network(monkeypatch):
    monkeypatch.setattr(httpx.HTTPTransport, 'handle_request',
                        lambda *args, **kwargs: pytest.fail('No external provider requests'))


@pytest.fixture
def config(tmp_path, monkeypatch):
    value = OpenAICompatibleConfig(tmp_path/'private'/'profiles.json', tmp_path/'library')
    monkeypatch.setenv('IMAGE_PROMPT_LIBRARY_OPENAI_COMPATIBLE_CONFIG_PATH', str(value.path))
    value.save({'base_url': 'https://synthetic.invalid/v1', 'api_key': 'fixture-only-key',
                'model': 'custom-alias'}, profile_id='test')
    return value


def test_registered_executors_preserve_oauth_and_native_types():
    from backend.services.generation_queue import AUTOMATED_PROVIDER_IDS, _provider_for
    from backend.services.openai_codex_native import OpenAICodexNativeProvider
    from backend.services.xai_grok_oauth import XaiGrokOAuthProvider
    from backend.services.agent_execution import NativeAgentImageProvider
    from backend.services.providers.job_runner import ApiProfileExecutor
    expected = {'openai_compatible': ApiProfileExecutor,
                'openai_codex_oauth_native': OpenAICodexNativeProvider,
                'xai_grok_oauth': XaiGrokOAuthProvider,
                'agent_native_batch': NativeAgentImageProvider}
    assert AUTOMATED_PROVIDER_IDS == frozenset(expected)
    for identity, cls in expected.items():
        assert type(_provider_for(identity)) is cls
    assert {'gemini_native','seedream_native'}.isdisjoint(AUTOMATED_PROVIDER_IDS)
    assert registry.get_provider('xai_grok_oauth').image_factory is None
    assert registry.get_provider('openai_codex_oauth_native').legacy_executor


@pytest.mark.parametrize('profile', [{'protocol': 'unsupported'}, {'protocol': ''},
    {'protocol': None}, {'protocol': 'xai_grok_oauth'}])
def test_unknown_or_non_api_protocol_is_not_inferred_or_replayed(profile):
    with pytest.raises(ProviderError) as caught:
        registry.image_provider_for_profile({**profile, 'model': 'gpt-image-custom'})
    assert caught.value.outcome == 'not_sent'


def test_profile_without_protocol_has_original_provider_and_no_write(config):
    # Exercise a real pre-protocol document, not a newly saved v2 profile.
    document = json.loads(config.path.read_text(encoding='utf-8'))
    document['profiles']['test'].pop('protocol', None)
    config.path.write_text(json.dumps(document), encoding='utf-8')
    before = config.path.read_bytes()
    settings = config.read('test')
    provider = registry.image_provider_for_profile(settings, config=config)
    assert type(provider) is OpenAICompatibleProvider
    assert config.path.read_bytes() == before
    assert settings.get('protocol', 'openai_compatible') == 'openai_compatible'
    assert 'protocol' not in json.loads(config.path.read_text(encoding='utf-8'))['profiles']['test']
    assert ModelCapabilities().image_generation is None
    assert ImageResult(b'image', 'image.png', {}) == (b'image', 'image.png', {})


@pytest.mark.parametrize('format,compression', [('png', 0), ('jpeg', 0), ('webp', 100)])
@pytest.mark.parametrize('edits', [False, True])
@pytest.mark.parametrize('stream', [False, True])
def test_registered_wire_contract_is_exact(config, format, compression, edits, stream):
    config.save({'stream': stream, 'partial_images': 0, 'response_format': 'b64_json'}, profile_id='test')
    parameters = {'compatible_profile_id': 'test', 'model': 'custom-alias',
        'size': '1024x1536', 'quality': 'max', 'background': 'opaque',
        'output_format': format, 'output_compression': compression, 'moderation': 'auto'}
    original = deepcopy(parameters)
    prompt = '  Exact synthetic prompt.\n  Preserve whitespace.  '
    expected = {key: parameters[key] for key in ('model', 'size', 'quality', 'background', 'output_format', 'moderation')}
    if format != 'png': expected['output_compression'] = compression
    expected.update(prompt=prompt, n=1, response_format='b64_json')
    if stream: expected.update(stream=True, partial_images=0)
    inputs = [('first.png', png(), 'image/png'), ('second.png', png('red'), 'image/png')] if edits else []
    calls = []
    def reply(request):
        calls.append(request)
        assert request.method == 'POST'
        assert str(request.url) == 'https://synthetic.invalid/v1/images/' + ('edits' if edits else 'generations')
        assert request.headers['authorization'] == 'Bearer fixture-only-key'
        assert request.headers['accept'] == ('text/event-stream, application/json' if stream else 'application/json')
        if edits:
            mime = BytesParser(policy=default).parsebytes(
                ('Content-Type: ' + request.headers['content-type'] + '\r\n\r\n').encode() + request.content)
            fields, images = {}, []
            for part in mime.iter_parts():
                key = part.get_param('name', header='content-disposition')
                if part.get_filename():
                    images.append((key, part.get_filename(), part.get_payload(decode=True), part.get_content_type()))
                else:
                    fields[key] = part.get_payload(decode=True).decode()
            assert fields == {key: str(value).lower() if type(value) is bool else str(value) for key, value in expected.items()}
            assert images == [('image[]', name, data, mime) for name, data, mime in inputs]
        else:
            assert json.loads(request.content) == expected
        return httpx.Response(200, json={'data': [{'b64_json': base64.b64encode(png()).decode()}]})
    with httpx.Client(transport=httpx.MockTransport(reply)) as client:
        provider = registry.image_provider_for_profile(config.read('test'), config=config, http_client=client)
        data, _, metadata = provider.generate(prompt, parameters, inputs)
    assert len(calls) == 1 and data == png()
    assert parameters == original
    assert metadata['requested']['prompt'] == prompt
    assert metadata['request_diagnostics']['response_transport'] == 'json'


def test_mapping_keeps_unknown_history_and_does_not_mutate_original(config):
    parameters = {'model': 'custom-alias', 'quality': 'auto', 'size': 'auto',
        'requested_aspect_ratio': '9:16', 'aspect_ratio_prompt_injection': True,
        'historical_extension': {'keep': [0, False]}}
    original = deepcopy(parameters)
    mapped = OpenAIImageParamMapper().to_wire(CanonicalImageRequest('Original', parameters), config.read('test'))
    assert mapped.normalized['historical_extension'] == original['historical_extension']
    mapped.normalized['historical_extension']['keep'].append(1)
    assert parameters == original
    assert mapped.payload['prompt'] == 'Original\n\nRequested output aspect ratio: 9:16 (width:height). Compose the image in this aspect ratio.'
    assert 'historical_extension' not in mapped.payload  # Existing transport allowlist, not a new rewrite.


def test_v1_catalog_is_read_without_mutation_and_next_write_uses_v2(config):
    settings = config.read('test')
    fp = connection_fingerprint(settings, settings['base_url'])
    catalog = {'models': [{'id': 'unknown-image-name', 'image_generation': None}],
               'fetched_at': None, 'checked_at': None, 'error': None}
    cache = ModelCatalogCache(config.path)
    cache.path.write_text(json.dumps({'version': 1, 'profiles': {'test': {'fingerprint': fp, 'catalog': catalog}}}), encoding='utf-8')
    original = cache.path.read_bytes()
    assert cache.read('test', fp) == catalog
    assert cache.path.read_bytes() == original
    cache.write('test', fp, catalog, ['test'], config.library_path)
    assert json.loads(cache.path.read_bytes())['version'] == 2
    assert cache.read('test', fp) == catalog
    assert 'fixture-only-key' not in cache.path.read_text()


def test_registry_catalog_keeps_manual_model_and_separate_output_claims(config):
    settings = config.read('test')
    before = config.path.read_bytes()
    with httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(200, json={'data': [
        {'id': 'vision', 'input_modalities': ['image']}, {'id': 'output', 'output_modalities': ['image']},
    ]}))) as client:
        models = registry.catalog_for_profile(settings).discover_models(settings['base_url'], settings['api_key'], client)
    assert models == [{'id': 'vision', 'image_generation': None}, {'id': 'output', 'image_generation': True}]
    assert config.path.read_bytes() == before


@pytest.mark.parametrize('terminal', [True, False])
def test_registered_responses_transport_preserves_terminal_over_teardown(terminal):
    from backend.services.agent_responses import response_stream
    calls = []
    class Client:
        @contextmanager
        def stream(self, *args, **kwargs):
            calls.append((args, kwargs))
            yield 'response'
            raise httpx.ReadTimeout('synthetic close failure')
    def execute():
        with response_stream(Client(), 'POST', 'https://synthetic.invalid/v1/responses',
                is_complete=lambda: terminal, text_provider=registry.text_provider_for_profile({}),
                json={'model': 'text-model', 'input': []}) as response:
            assert response == 'response'
    if terminal: execute()
    else:
        with pytest.raises(httpx.ReadTimeout): execute()
    assert calls == [(('POST', 'https://synthetic.invalid/v1/responses'), {'json': {'model': 'text-model', 'input': []}})]
