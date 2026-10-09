import base64
import json
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import httpx
import pytest
from PIL import Image

from backend.services.openai_compatible import OpenAICompatibleConfig, OpenAICompatibleError, OpenAICompatibleProvider, normalize_base_url


def png(color="blue"):
    buffer = BytesIO()
    Image.new("RGB", (8, 6), color).save(buffer, "PNG")
    return buffer.getvalue()


@pytest.fixture
def config(tmp_path):
    cfg = OpenAICompatibleConfig(tmp_path / "private" / "config.json", tmp_path / "library")
    cfg.save({"base_url": "https://images.example/v1/v1/", "api_key": "test-only-secret", "model": "requested-model"})
    return cfg


def test_config_preserves_blank_key_and_blocks_library(tmp_path, config):
    config.save({"api_key": "", "display_name": "Example"})
    assert config.read()["api_key"] == "test-only-secret"
    assert "test-only-secret" not in json.dumps(config.public())
    assert config.public()["api_key_present"]
    config.save({"remove_api_key": True})
    assert not config.public()["api_key_present"]
    with pytest.raises(OpenAICompatibleError):
        OpenAICompatibleConfig(tmp_path / "library" / "config.json", tmp_path / "library")


@pytest.mark.parametrize("url", ["https://images.example", "https://images.example/v1/", "https://images.example/v1/v1"])
def test_url_normalization(url):
    assert normalize_base_url(url) == "https://images.example/v1"


def test_decodes_image_and_separates_requested_response(config):
    calls = []
    def handler(request):
        calls.append(request)
        payload = json.loads(request.content)
        assert payload["n"] == 1
        assert request.url.path == "/v1/images/generations"
        return httpx.Response(200, json={"data": [{"b64_json": base64.b64encode(png()).decode(), "model": "returned-model", "size": "8x6"}], "usage": {"total_tokens": 2}})
    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        data, _, metadata = OpenAICompatibleProvider(config, client).generate("Test prompt", {})
    assert len(calls) == 1 and data == png()
    assert metadata["requested"]["model"] == "requested-model"
    assert metadata["response"]["model"] == "returned-model"
    assert metadata["response"]["quality"] is None
    assert metadata["decoded_image"]["width"] == 8


@pytest.mark.parametrize("ratio,size", [("auto", "auto"), ("1:1", "1024x1024"), ("3:4", "864x1152"), ("9:16", "720x1280"), ("4:3", "1152x864"), ("16:9", "1280x720")])
def test_aspect_ratio_translates_only_at_transport(config, ratio, size):
    def handler(request):
        payload = json.loads(request.content)
        assert payload["size"] == size
        assert "requested_aspect_ratio" not in payload
        return httpx.Response(200, json={"data": [{"b64_json": base64.b64encode(png()).decode()}]})
    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        _, _, metadata = OpenAICompatibleProvider(config, client).generate("Test", {"requested_aspect_ratio": ratio})
    assert metadata["requested"]["requested_aspect_ratio"] == ratio
    assert metadata["requested"]["size"] == size
    assert metadata["response"]["size"] is None
    assert metadata["decoded_image"]["width"] == 8


def test_legacy_size_and_invalid_ratio(config):
    from backend.services.openai_compatible import requested_image_size
    assert requested_image_size({"size": "1024x1536"}) == "1024x1536"
    assert requested_image_size({}) == "auto"
    with httpx.Client(transport=httpx.MockTransport(lambda request: pytest.fail("Must not submit invalid ratio"))) as client:
        with pytest.raises(OpenAICompatibleError):
            OpenAICompatibleProvider(config, client).generate("Test", {"requested_aspect_ratio": "bad"})


@pytest.mark.parametrize("ratio", ["1:1", "3:4", "9:16", "4:3", "16:9"])
@pytest.mark.parametrize("use_edits", [False, True])
def test_ratio_prompt_hint_keeps_auto_size_and_original_prompt(config, ratio, use_edits):
    original_prompt = "A small geometric shape.\nKeep the margins clear."
    parameters = {"aspect_ratio_prompt_injection": True, "requested_aspect_ratio": ratio, "quality": "auto"}
    expected_prompt = original_prompt + f"\n\nRequested output aspect ratio: {ratio} (width:height). Compose the image in this aspect ratio."
    calls = []

    def handler(request):
        calls.append(request)
        if use_edits:
            assert request.url.path == "/v1/images/edits"
            assert expected_prompt.encode() in request.content
            assert b'name="size"\r\n\r\nauto' in request.content
            assert b"aspect_ratio_prompt_injection" not in request.content
        else:
            payload = json.loads(request.content)
            assert payload["prompt"] == expected_prompt
            assert payload["size"] == "auto"
            assert "aspect_ratio_prompt_injection" not in payload
        return httpx.Response(200, json={"data": [{"b64_json": base64.b64encode(png()).decode()}]})

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        _, _, metadata = OpenAICompatibleProvider(config, client).generate(
            original_prompt, parameters, [("reference.png", png(), "image/png")] if use_edits else None,
        )
    assert len(calls) == 1
    assert original_prompt == "A small geometric shape.\nKeep the margins clear."
    assert parameters == {"aspect_ratio_prompt_injection": True, "requested_aspect_ratio": ratio, "quality": "auto"}
    assert metadata["requested"]["prompt"] == expected_prompt
    assert metadata["original_prompt"] == original_prompt
    assert metadata["requested"]["aspect_ratio_prompt_injection"] is True
    assert metadata["requested"]["requested_aspect_ratio"] == ratio
    assert metadata["requested"]["size"] == "auto"


@pytest.mark.parametrize("parameters", [
    {"aspect_ratio_prompt_injection": True, "requested_aspect_ratio": "auto"},
    {"aspect_ratio_prompt_injection": False, "requested_aspect_ratio": "9:16", "size": "auto"},
    {"requested_aspect_ratio": "9:16", "size": "auto"},
])
def test_ratio_hint_leaves_auto_and_legacy_prompts_unchanged(config, parameters):
    def handler(request):
        assert json.loads(request.content)["prompt"] == "Original prompt"
        return httpx.Response(200, json={"data": [{"b64_json": base64.b64encode(png()).decode()}]})
    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        _, _, metadata = OpenAICompatibleProvider(config, client).generate("Original prompt", parameters)
    assert metadata["requested"]["prompt"] == "Original prompt"


def test_ratio_hint_rejects_unsupported_ratio_before_request(config):
    with httpx.Client(transport=httpx.MockTransport(lambda request: pytest.fail("Must not submit invalid ratio"))) as client:
        with pytest.raises(OpenAICompatibleError, match="Unsupported requested aspect ratio"):
            OpenAICompatibleProvider(config, client).generate("Test", {
                "aspect_ratio_prompt_injection": True, "requested_aspect_ratio": "bad", "size": "auto",
            })


def test_ratio_retry_restores_flag_and_does_not_duplicate_hint(config, tmp_path):
    from backend.schemas import GenerationJobRecord
    from backend.services.generation_jobs import GenerationJobRepository

    sent_prompts = []
    def handler(request):
        sent_prompts.append(json.loads(request.content)["prompt"])
        return httpx.Response(200, json={"data": [{"b64_json": base64.b64encode(png()).decode()}]})

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        provider = OpenAICompatibleProvider(config, client)
        _, _, metadata = provider.generate("Original draft", {
            "aspect_ratio_prompt_injection": True, "requested_aspect_ratio": "9:16", "size": "auto",
        })
        # Restore even when only response provenance retains the ratio control flag.
        job = GenerationJobRecord(id="test", status="succeeded", provider="openai_compatible",
                                  prompt_text="Original draft", parameters={}, metadata=metadata,
                                  created_at="2026-01-01", updated_at="2026-01-01")
        restored = GenerationJobRepository(tmp_path / "library")._restore_compatible_request(job)
        assert restored.prompt_text == "Original draft"
        assert restored.parameters["aspect_ratio_prompt_injection"] is True
        _, _, retried_metadata = provider.generate(restored.prompt_text, restored.parameters)
    assert len(sent_prompts) == 2
    assert sent_prompts[0] == sent_prompts[1]
    assert sent_prompts[1].count("Requested output aspect ratio:") == 1
    assert retried_metadata["original_prompt"] == "Original draft"


@pytest.mark.parametrize("status", [302, 401, 429, 500])
def test_no_retry_or_redirect_and_errors_do_not_leak(config, status):
    calls = []
    def handler(request):
        calls.append(request)
        return httpx.Response(status, headers={"Location": "https://other.example/"}, text="test-only-secret")
    with httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=True) as client:
        with pytest.raises(OpenAICompatibleError) as caught:
            OpenAICompatibleProvider(config, client).generate("Test", {})
    assert len(calls) == 1
    assert "test-only-secret" not in str(caught.value)
    assert "example" not in str(caught.value)


def test_invalid_image_is_not_success(config):
    with httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(200, json={"data": [{"b64_json": base64.b64encode(b"not image").decode()}]}))) as client:
        with pytest.raises(OpenAICompatibleError):
            OpenAICompatibleProvider(config, client).generate("Test", {})


def test_edits_are_ordered_multipart(config):
    def handler(request):
        assert request.url.path == "/v1/images/edits"
        assert "multipart/form-data" in request.headers["content-type"]
        assert request.content.index(b'filename="first.png"') < request.content.index(b'filename="second.png"')
        return httpx.Response(200, json={"data": [{"b64_json": base64.b64encode(png()).decode()}]})
    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        _, _, metadata = OpenAICompatibleProvider(config, client).generate("Test", {}, [("first.png", png(), "image/png"), ("second.png", png("red"), "image/png")])
    assert metadata["response"]["model"] is None
    assert metadata["input_image_count"] == 2


def test_job_failure_is_terminal_and_redacted(config, tmp_path):
    job = SimpleNamespace(provider="openai_compatible", status="queued", prompt_text="Test", edited_prompt_text=None, parameters={})
    with patch("backend.services.openai_compatible.GenerationJobRepository") as repository:
        repository.return_value.get_job.return_value = job
        provider = OpenAICompatibleProvider(config)
        with patch.object(provider, "generate", side_effect=RuntimeError("test-only-secret")):
            with pytest.raises(OpenAICompatibleError):
                provider.run_job(tmp_path / "library", "job-1")
        repository.return_value.mark_failed.assert_called_once()
        assert "test-only-secret" not in str(repository.return_value.mark_failed.call_args)


def test_invalid_config_does_not_break_provider_listing(config):
    config.path.write_text('{"model": ["invalid"]}', encoding="utf-8")
    assert config.status()["status"] == "auth_error"
    assert not config.status()["available"]


def test_response_requires_exactly_one_image(config):
    item = {"b64_json": base64.b64encode(png()).decode()}
    with httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(200, json={"data": [item, item]}))) as client:
        with pytest.raises(OpenAICompatibleError):
            OpenAICompatibleProvider(config, client).generate("Test", {})


def test_response_size_does_not_overwrite_decoded_size(config):
    item = {"b64_json": base64.b64encode(png()).decode(), "model": {"invalid": True}, "size": "99x99"}
    with httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(200, json={"data": [item]}))) as client:
        _, _, metadata = OpenAICompatibleProvider(config, client).generate("Test", {})
    assert metadata["response"]["model"] is None
    assert metadata["response"]["size"] == "99x99"
    assert metadata["decoded_image"]["width"] == 8


def test_job_uses_queued_model_and_requires_reference(config, tmp_path):
    from backend.schemas import GenerationJobRecord
    job = GenerationJobRecord(id="job-1", provider="openai_compatible", status="queued", prompt_text="Test", model="queued-model", created_at="now", updated_at="now")
    provider = OpenAICompatibleProvider(config)
    with patch("backend.services.openai_compatible.GenerationJobRepository") as repository:
        repository.return_value.get_job.return_value = job
        with patch.object(provider, "generate", return_value=(png(), "image.png", {})) as generate:
            provider.run_job(tmp_path / "library", job.id)
            assert generate.call_args.args[1]["model"] == "queued-model"
        job.mode = "image_edit"
        with patch.object(provider, "generate") as generate:
            with pytest.raises(OpenAICompatibleError):
                provider.run_job(tmp_path / "library", job.id)
            generate.assert_not_called()


def test_reference_specs_support_clones_and_legacy_ids(config, tmp_path):
    from backend.schemas import GenerationJobRecord
    job = GenerationJobRecord(id="job-1", provider="openai_compatible", status="queued", prompt_text="Test", created_at="now", updated_at="now")
    image = tmp_path / "reference.png"
    image.write_bytes(png())
    provider = OpenAICompatibleProvider(config)
    with patch("backend.services.openai_compatible.resolve_generation_input_image_path", return_value=(image, "image/png")) as resolve:
        job.parameters = {"input_images": [{"source": "library", "image_id": "id-1", "result_path": "generation-references/job-1/reference.png"}]}
        assert len(provider._input_images(job, tmp_path)) == 1
        assert resolve.call_args.kwargs["allowed_roots"] == {"generation-references"}
        job.parameters = {}
        job.metadata = {"reference_image_copies": [{"copied_path": "generation-references/job-1/reference.png"}]}
        assert len(provider._input_images(job, tmp_path)) == 1
    job.metadata = {}
    job.reference_image_ids = ["id-1"]
    with patch("backend.services.openai_compatible.GenerationJobRepository") as repository:
        repository.return_value.resolve_library_reference.return_value = (None, image, "image/png")
        assert len(provider._input_images(job, tmp_path)) == 1
        repository.return_value.resolve_library_reference.assert_called_once_with("id-1")

@pytest.mark.parametrize('model', ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'gpt-image-2.5-flare-2026-09-08', 'gpt-image-2.5-sunburst-2026-09-08'])
@pytest.mark.parametrize('quality', ['auto', 'low', 'medium', 'high', 'xhigh', 'max'])
def test_image25_settings_reach_transport_unchanged(config, model, quality):
    prompt = '  Complete prompt\nwith trailing whitespace  '
    def handler(request):
        payload = json.loads(request.content)
        assert payload == {'model': model, 'quality': quality, 'size': '2160x3840', 'background': 'transparent', 'output_format': 'webp', 'output_compression': 0, 'prompt': prompt, 'n': 1}
        return httpx.Response(200, json={'data': [{'b64_json': base64.b64encode(png()).decode()}]})
    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        _, _, meta = OpenAICompatibleProvider(config, client).generate(prompt, {'model': model, 'quality': quality, 'requested_aspect_ratio': '9:16', 'size': '2160x3840', 'background': 'transparent', 'output_format': 'webp', 'output_compression': 0})
    assert meta['requested']['prompt'] == prompt
    assert {item['field'] for item in meta['mismatches']} == {'size', 'background', 'output_format'}


@pytest.mark.parametrize('size', ['2880x3840', '3841x1024', '1025x1024', '512x512', '3840x1024', '0x1024', '-1024x1024'])
def test_image25_invalid_dimensions_prevent_network(config, size):
    with httpx.Client(transport=httpx.MockTransport(lambda request: pytest.fail('Must reject before POST'))) as client:
        with pytest.raises(OpenAICompatibleError):
            OpenAICompatibleProvider(config, client).generate('Test', {'model': 'gpt-image-2.5-flare', 'size': size})


@pytest.mark.parametrize('size', ['auto', '1024x1024', '1536x1024', '1024x1536', '2048x2048', '2048x1152', '3840x2160', '2160x3840', '1024x640'])
def test_image25_legal_dimensions(size):
    from backend.services.openai_compatible import normalize_image_parameters
    assert normalize_image_parameters({'model': 'gpt-image-2.5-flare', 'size': size})['size'] == size


@pytest.mark.parametrize('compression', [0, 100])
@pytest.mark.parametrize('fmt', ['png', 'jpeg', 'webp'])
def test_compression_and_transparency_validation(fmt, compression):
    from backend.services.openai_compatible import normalize_image_parameters
    normalized = normalize_image_parameters({'output_format': fmt, 'output_compression': compression}, 'gpt-image-2.5-flare')
    assert normalized.get('output_compression') == (None if fmt == 'png' else compression)
    if fmt == 'jpeg':
        with pytest.raises(OpenAICompatibleError, match='Transparent'):
            normalize_image_parameters({'output_format': fmt, 'background': 'transparent'}, 'gpt-image-2.5-flare')


@pytest.mark.parametrize('status,category', [(401,'authentication'), (403,'permission_or_group'), (404,'route_or_model'), (429,'rate_limit'), (503,'upstream_error'), (200,'api_error')])
def test_structured_safe_diagnostics(config, status, category):
    calls = []
    def handler(request):
        calls.append(request)
        return httpx.Response(status, headers={'x-request-id':'request-123', 'retry-after':'12'}, json={'error': {'type':'service_error', 'code':'test', 'param':'model', 'message':'test-only-secret Bearer abc https://example.test/a?signature=secret'}})
    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(OpenAICompatibleError) as caught:
            OpenAICompatibleProvider(config, client).generate('Test', {})
    diagnostic = caught.value.diagnostics
    assert diagnostic['category'] == category
    assert diagnostic['request_id'] == 'request-123'
    assert diagnostic['retry_after'] == '12'
    assert diagnostic['error']['param'] == 'model'
    assert not any(secret in str(caught.value) for secret in ['test-only-secret','abc','signature=secret'])
    assert len(calls) == 1


@pytest.mark.parametrize('body,category', [(b'<html>Login</html>','non_json_response'), (b'{"data": []}','missing_image'), (b'{"data":[{"b64_json":"bad*"}]}','base64_decode')])
def test_decode_error_categories(config, body, category):
    with httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(200, content=body))) as client:
        with pytest.raises(OpenAICompatibleError) as caught:
            OpenAICompatibleProvider(config, client).generate('Test', {})
    assert caught.value.diagnostics['category'] == category


def test_whitespace_json_preserves_service_differences_and_alpha(config):
    buffer = BytesIO()
    Image.new('RGBA',(8,6),(1,2,3,0)).save(buffer,'PNG')
    body = {'model':'top-model','quality':'high','background':'opaque', 'data':[{'b64_json':base64.b64encode(buffer.getvalue()).decode(), 'quality':'max','background':'transparent','revised_prompt':'Adjusted'}]}
    with httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(200, content='\n \r\n'+json.dumps(body), headers={'x-request-id':'abc'}))) as client:
        data, _, metadata = OpenAICompatibleProvider(config, client).generate('Original', {'background':'transparent'})
    assert data == buffer.getvalue()
    assert metadata['decoded_image']['has_alpha']
    assert metadata['decoded_image']['has_transparent_pixels']
    assert metadata['response']['quality'] == 'max'
    assert metadata['response']['top_level']['quality'] == 'high'
    assert metadata['response']['revised_prompt'] == 'Adjusted'
    assert metadata['response']['request_id'] == 'abc'
    assert metadata['mismatches'] == [{'field': 'quality', 'requested': 'low', 'actual': 'max'}]


def test_configuration_does_not_claim_live_verification(config):
    assert config.status()['verification'] == {'configuration_complete':True,'connectivity_verified':False,'image_generation_verified':False}


@pytest.mark.parametrize('exception,category', [(httpx.ConnectTimeout('secret'), 'connect_timeout'), (httpx.ReadTimeout('secret'), 'read_timeout'), (httpx.ConnectError('secret'), 'connection_error')])
def test_network_failures_are_safe_and_not_retried(config, exception, category):
    calls = []
    def handler(request):
        calls.append(request)
        raise exception
    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(OpenAICompatibleError) as caught:
            OpenAICompatibleProvider(config, client).generate('Test', {})
    assert caught.value.diagnostics['category'] == category
    assert len(calls) == 1
    assert 'secret' not in str(caught.value)

@pytest.mark.parametrize('settings', [{'model':'gpt-image-2','quality':'max'}, {'model':'gpt-image-2.5-flare','quality':'unknown'}, {'model':'gpt-image-2.5-flare','output_format':'jpeg','output_compression':101}, {'model':'gpt-image-2.5-flare','output_format':'webp','output_compression':True}])
def test_model_scoped_and_typed_validation(settings):
    from backend.services.openai_compatible import normalize_image_parameters
    with pytest.raises(OpenAICompatibleError):
        normalize_image_parameters(settings)


def test_edits_include_full_settings_and_compression_zero(config):
    calls = []
    def handler(request):
        calls.append(request)
        assert request.url.path == '/v1/images/edits'
        for name, value in [('model','gpt-image-2.5-sunburst'),('quality','xhigh'),('background','transparent'),('size','2048x2048'),('output_format','webp'),('output_compression','0')]:
            assert f'name="{name}"\r\n\r\n{value}\r\n'.encode() in request.content
        return httpx.Response(200, json={'data':[{'b64_json':base64.b64encode(png()).decode()}]})
    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        OpenAICompatibleProvider(config,client).generate(' Test ', {'model':'gpt-image-2.5-sunburst','quality':'xhigh','size':'2048x2048','background':'transparent','output_format':'webp','output_compression':0}, [('input.png',png(),'image/png')])
    assert len(calls) == 1


def test_job_does_not_trim_original_prompt(config,tmp_path):
    job = SimpleNamespace(provider='openai_compatible',status='queued',prompt_text='  Original\n ',edited_prompt_text=None,parameters={'model':'requested-model'})
    with patch('backend.services.openai_compatible.GenerationJobRepository') as repository:
        repository.return_value.get_job.return_value = job
        provider = OpenAICompatibleProvider(config)
        with patch.object(provider,'generate',return_value=(png(),'test.png',{})) as generate:
            provider.run_job(tmp_path/'library','test-job')
        assert generate.call_args.args[0] == job.prompt_text


def test_authorization_cookie_error_redaction(config):
    message = 'Authorization: Bearer exposed-secret\nCookie: session=private-session'
    with httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(403,json={'error':{'message':message}}))) as client:
        with pytest.raises(OpenAICompatibleError) as caught:
            OpenAICompatibleProvider(config,client).generate('Test',{})
    assert 'exposed-secret' not in str(caught.value)
    assert 'private-session' not in str(caught.value)


def test_usage_counts_survive_redaction_with_secret_nested_values(config):
    body = {'data':[{'b64_json':base64.b64encode(png()).decode()}], 'usage':{'input_tokens':12,'output_tokens':34,'total_tokens':46,'input_tokens_details':{'image_tokens':8,'text_tokens':4,'access_token':'must-not-leak'},'access_token':'private-token','sk-abcdefcredential':1}}
    with httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(200,json=body))) as client:
        _,_,metadata = OpenAICompatibleProvider(config,client).generate('Test',{})
    usage = metadata['response']['usage']
    assert usage['input_tokens'] == 12
    assert usage['output_tokens'] == 34
    assert usage['total_tokens'] == 46
    assert usage['input_tokens_details'] == {'image_tokens':8,'text_tokens':4}
    assert not any(value in json.dumps(metadata) for value in ['must-not-leak','private-token','sk-abcdefcredential'])


def test_safe_metadata_depth_is_bounded():
    from backend.services.openai_compatible import _safe_value
    nested = {}
    nested['nested'] = nested
    assert 'NESTED VALUE OMITTED' in json.dumps(_safe_value(nested,'private'))


def test_legacy_queued_job_never_uses_changed_default_model(config,tmp_path):
    job = SimpleNamespace(provider='openai_compatible',status='queued',prompt_text='Test',edited_prompt_text=None,parameters={})
    with patch('backend.services.openai_compatible.GenerationJobRepository') as repository:
        repository.return_value.get_job.return_value = job
        provider = OpenAICompatibleProvider(config)
        with patch.object(provider,'generate') as generate:
            with pytest.raises(OpenAICompatibleError,match='no frozen request model'):
                provider.run_job(tmp_path/'library','legacy')
        generate.assert_not_called()


@pytest.mark.parametrize('error_body', [{'message':'password=privatepass client_secret=privateclient access_token=privateaccess refresh_token=privaterefresh','request_id':'nested-id'}, 123])
def test_body_request_ids_and_sensitive_error_assignments(config,error_body):
    body = {'error':error_body}
    if not isinstance(error_body,dict):
        body['request_id']='body-id'
    with httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(403,json=body))) as client:
        with pytest.raises(OpenAICompatibleError) as caught:
            OpenAICompatibleProvider(config,client).generate('Test',{})
    assert caught.value.diagnostics['request_id'] == ('nested-id' if isinstance(error_body,dict) else 'body-id')
    assert not any(secret in str(caught.value) for secret in ['privatepass','privateclient','privateaccess','privaterefresh'])


def test_json_embedded_error_credentials_are_redacted(config):
    message = '{"password":"privatepass","client_secret":"privateclient","access_token":"privateaccess"}'
    with httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(401,json={'error':{'message':message}}))) as client:
        with pytest.raises(OpenAICompatibleError) as caught:
            OpenAICompatibleProvider(config,client).generate('Test',{})
    assert not any(secret in str(caught.value) for secret in ['privatepass','privateclient','privateaccess'])
