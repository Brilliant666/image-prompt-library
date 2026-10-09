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
