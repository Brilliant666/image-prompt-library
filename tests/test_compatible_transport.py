"""Profile transport options and streaming use synthetic bytes and MockTransport only."""
import base64
import json
from io import BytesIO

import httpx
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from backend.main import create_app
from backend.services import image_api_stream
from backend.services.openai_compatible import OpenAICompatibleConfig, OpenAICompatibleError, OpenAICompatibleProvider, normalize_base_url


def image_bytes(color="blue"):
    output = BytesIO()
    Image.new("RGBA", (8, 6), color).save(output, "PNG")
    return output.getvalue()


def encoded(color="blue"):
    return base64.b64encode(image_bytes(color)).decode()


@pytest.fixture
def config(tmp_path, monkeypatch):
    config = OpenAICompatibleConfig(tmp_path / "private.json", tmp_path / "library")
    monkeypatch.setenv("IMAGE_PROMPT_LIBRARY_OPENAI_COMPATIBLE_CONFIG_PATH", str(config.path))
    config.save({"base_url": "https://images.invalid/custom", "api_key": "synthetic-secret", "model": "example"})
    return config


class Chunks(httpx.SyncByteStream):
    def __init__(self, data, size=7, error=None):
        self.data, self.size, self.error = data, size, error
        self.closed = False

    def __iter__(self):
        for start in range(0, len(self.data), self.size):
            yield self.data[start:start + self.size]
        if self.error:
            raise self.error

    def close(self):
        self.closed = True


def event(kind, data, separator="\n", named=True):
    value = json.dumps({"type": kind, **data}, ensure_ascii=False)
    return ((f"event: {kind}{separator}" if named else "") + f"data: {value}{separator}{separator}").encode()


def test_old_config_defaults_do_not_rewrite_and_new_options_copy_reorder(config):
    original = {"base_url": "https://images.invalid/v1", "api_key": "synthetic-secret", "model": "example"}
    config.path.write_text(json.dumps(original))
    before = config.path.read_bytes()
    public = config.public()
    assert public["models"] == [] and public["stream"] is False
    assert public["partial_images"] == 0 and public["response_format"] == "auto"
    assert public["base_url_mode"] == "versioned"
    assert config.path.read_bytes() == before
    config.save({"base_url_mode": "custom", "base_url": "https://images.invalid/gateway/", "api_key": "synthetic-secret", "stream": True,
                 "partial_images": 2, "response_format": "b64_json", "models": [" first ", "second", "first"]})
    config.copy_profile("legacy", "copy")
    config.reorder_profiles(["copy", "legacy"])
    reloaded = OpenAICompatibleConfig(config.path, config.library_path)
    for profile in reloaded.public_profiles()["profiles"]:
        assert profile["models"] == ["first", "second"]
        assert profile["base_url"] == "https://images.invalid/gateway"
        assert profile["base_url_mode"] == "custom" and profile["stream"] is True
        assert profile["partial_images"] == 2 and profile["response_format"] == "b64_json"
        assert "api_key" not in profile
    assert reloaded.read("copy")["api_key"] == "synthetic-secret"
    assert reloaded.status()["available"] is True


@pytest.mark.parametrize("payload", [
    {"stream": "true"}, {"stream": 1}, {"partial_images": True}, {"partial_images": 1.5},
    {"partial_images": -1}, {"partial_images": 4}, {"response_format": "url"},
    {"base_url_mode": "other"}, {"models": "model"}, {"models": [""]},
    {"models": [3]}, {"models": ["invalid\nmodel"]}, {"models": ["model"] * 101},
])
def test_invalid_options_never_write_or_echo_secret(config, payload):
    before = config.path.read_bytes()
    client = TestClient(create_app(library_path=config.library_path))
    response = client.put("/api/generation-providers/openai-compatible/profiles/legacy",
                          json={**payload, "api_key": "secret-never-echo"})
    assert response.status_code == 400
    assert "secret-never-echo" not in response.text
    assert config.path.read_bytes() == before


def test_url_modes_keep_old_normalization_and_custom_root():
    assert normalize_base_url("https://images.invalid/v1/v1/") == "https://images.invalid/v1"
    assert normalize_base_url("https://images.invalid/gateway/v2/", "custom") == "https://images.invalid/gateway/v2"
    assert normalize_base_url("https://images.invalid/", "custom") == "https://images.invalid"
    for value in ["https://user:secret@images.invalid", "https://images.invalid?token=secret", "https://images.invalid#secret"]:
        with pytest.raises(OpenAICompatibleError):
            normalize_base_url(value, "custom")


@pytest.mark.parametrize("edits", [False, True])
@pytest.mark.parametrize("explicit", [False, True])
def test_json_transport_options_reach_one_request(config, edits, explicit):
    config.save({"base_url": "https://images.invalid/gateway/", "base_url_mode": "custom", "api_key": "synthetic-secret",
                 "stream": explicit, "partial_images": 2, "response_format": "b64_json" if explicit else "auto"})
    calls = []
    def reply(request):
        calls.append(request)
        assert request.url.path == "/gateway/images/" + ("edits" if edits else "generations")
        if edits:
            assert (b'name="response_format"' in request.content) is explicit
            assert (b'name="stream"\r\n\r\ntrue\r\n' in request.content) is explicit
            assert b"True" not in request.content
        else:
            body = json.loads(request.content)
            assert ("response_format" in body) is explicit
            assert ("stream" in body) is explicit
            assert ("partial_images" in body) is explicit
            if explicit:
                assert body["stream"] is True and body["partial_images"] == 2 and body["response_format"] == "b64_json"
        return httpx.Response(200, json={"data": [{"b64_json": encoded()}]})
    with httpx.Client(transport=httpx.MockTransport(reply)) as client:
        result, _, meta = OpenAICompatibleProvider(config, client).generate("Synthetic", {}, [("ref.png", image_bytes(), "image/png")] if edits else None)
    assert result == image_bytes() and len(calls) == 1
    assert meta["requested"]["base_url_mode"] == "custom"
    assert meta["request_diagnostics"]["response_transport"] == "json"


@pytest.mark.parametrize("edits", [False, True])
@pytest.mark.parametrize("separator", ["\n", "\r\n", "\r"])
def test_sse_partial_and_completion_across_chunks(config, edits, separator):
    config.save({"stream": True, "partial_images": 2})
    kind = "image_edit" if edits else "image_generation"
    wire = b": heartbeat\n\n" + event(kind + ".partial_image", {"b64_json": encoded("red"), "partial_image_index": 0}, separator)
    wire += event(kind + ".partial_image", {"b64_json": encoded("red"), "partial_image_index": 0}, separator)
    wire += event(kind + ".completed", {"b64_json": encoded(), "revised_prompt": "合成图", "usage": {"total_tokens": 3}}, separator, named=False).rstrip(b"\r\n")
    stream = Chunks(wire, size=1)
    calls, partials = [], []
    def reply(request):
        calls.append(request)
        return httpx.Response(200, headers={"content-type": "text/event-stream"}, stream=stream)
    with httpx.Client(transport=httpx.MockTransport(reply)) as client:
        result, _, meta = OpenAICompatibleProvider(config, client).generate("Synthetic", {}, [("ref.png", image_bytes(), "image/png")] if edits else None,
                                                                          on_partial=lambda data, details: partials.append((data, details)))
    assert result == image_bytes() and len(calls) == 1 and stream.closed
    assert partials == [(image_bytes("red"), {"width": 8, "height": 6, "partial_image_index": 0, "output_format": "png"})]
    assert meta["response"]["usage"] == {"total_tokens": 3}
    assert meta["request_diagnostics"]["response_transport"] == "sse"


@pytest.mark.parametrize("wire,category", [
    (b"data: [DONE]\n\n", "incomplete_stream"),
    (b"data: broken\n\n", "invalid_stream"),
    (b"data: []\n\n", "invalid_stream"),
    (b"data: \xff\n\n", "invalid_stream"),
    (event("image_generation.completed", {}), "missing_image"),
    (event("image_generation.partial_image", {"b64_json": encoded(), "partial_image_index": True}), "invalid_stream"),
    (event("image_generation.partial_image", {"b64_json": "YWJj", "partial_image_index": 0}), "image_decode"),
])
def test_invalid_streams_fail_once_without_success_or_retry(config, wire, category):
    config.save({"stream": True, "partial_images": 1})
    calls = []
    def reply(request):
        calls.append(request)
        return httpx.Response(200, headers={"content-type": "text/event-stream"}, stream=Chunks(wire))
    with httpx.Client(transport=httpx.MockTransport(reply)) as client:
        with pytest.raises(OpenAICompatibleError) as caught:
            OpenAICompatibleProvider(config, client).generate("Synthetic", {})
    assert caught.value.diagnostics["category"] == category and len(calls) == 1
    assert "synthetic-secret" not in str(caught.value)


def test_sse_error_preserves_only_safe_moderation_and_no_retry(config):
    config.save({"stream": True})
    wire = event("error", {"error": {"message": "refused synthetic-secret", "code": "content_policy_violation",
        "moderation_details": {"moderation_stage": "output", "categories": ["sexual", "private-prompt"], "prompt": "never-record"},
        "api_key": "synthetic-secret"}})
    with httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(200, headers={"content-type": "text/event-stream"}, stream=Chunks(wire)))) as client:
        with pytest.raises(OpenAICompatibleError) as caught:
            OpenAICompatibleProvider(config, client).generate("Synthetic", {})
    error = caught.value.diagnostics["error"]
    assert error["moderation_details"] == {"moderation_stage": "output", "categories": ["sexual"]}
    assert "synthetic-secret" not in str(caught.value) and "never-record" not in str(caught.value)


@pytest.mark.parametrize("streaming", [False, True])
def test_response_limits_apply_to_stream_and_json(config, monkeypatch, streaming):
    monkeypatch.setattr(image_api_stream, "MAX_IMAGE_JSON_BYTES", 80)
    monkeypatch.setattr(image_api_stream, "MAX_IMAGE_STREAM_BYTES", 160)
    config.save({"stream": streaming})
    wire = event("image_generation.completed", {"b64_json": encoded()}) if streaming else json.dumps({"data": [{"b64_json": encoded()}]}).encode()
    with httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(200, headers={"content-type": "text/event-stream" if streaming else "application/json"}, stream=Chunks(wire)))) as client:
        with pytest.raises(OpenAICompatibleError) as caught:
            OpenAICompatibleProvider(config, client).generate("Synthetic", {})
    assert caught.value.diagnostics["category"] == "response_too_large"


def test_stream_timeout_keeps_uncertain_result_and_one_post(config):
    config.save({"stream": True})
    calls = []
    def reply(request):
        calls.append(request)
        return httpx.Response(200, headers={"content-type": "text/event-stream"}, stream=Chunks(b": waiting\n\n", error=httpx.ReadTimeout("private response")))
    with httpx.Client(transport=httpx.MockTransport(reply)) as client:
        with pytest.raises(OpenAICompatibleError) as caught:
            OpenAICompatibleProvider(config, client).generate("Synthetic", {})
    assert caught.value.diagnostics["category"] == "read_timeout" and len(calls) == 1
    assert "private response" not in str(caught.value)


def test_preview_arrives_before_reading_completion_and_never_becomes_final(config):
    config.save({"stream": True, "partial_images": 1})
    received = []
    class LiveStream(httpx.SyncByteStream):
        def __iter__(self):
            yield event("image_generation.partial_image", {"b64_json": encoded("red"), "partial_image_index": 0})
            assert received == [image_bytes("red")]
            yield b"data: [DONE]\n\n"
    with httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(200, headers={"content-type": "text/event-stream"}, stream=LiveStream()))) as client:
        with pytest.raises(OpenAICompatibleError) as caught:
            OpenAICompatibleProvider(config, client).generate("Synthetic", {}, on_partial=lambda data, meta: received.append(data))
    assert caught.value.diagnostics["category"] == "incomplete_stream"


def test_queued_frozen_transport_overrides_later_profile_edits(config):
    config.save({"stream": True, "partial_images": 3, "response_format": "b64_json", "base_url_mode": "custom"})
    def reply(request):
        body = json.loads(request.content)
        assert "stream" not in body and "partial_images" not in body and "response_format" not in body
        assert request.url.path == "/custom/v1/images/generations"
        return httpx.Response(200, json={"data": [{"b64_json": encoded()}]})
    with httpx.Client(transport=httpx.MockTransport(reply)) as client:
        OpenAICompatibleProvider(config, client).generate("Synthetic", {
            "stream": False, "partial_images": 0, "response_format": "auto", "base_url_mode": "versioned"})


def test_config_read_rejects_corrupted_transport_without_rewrite(config):
    source = json.loads(config.path.read_text())
    source["profiles"]["legacy"]["stream"] = "false"
    config.path.write_text(json.dumps(source))
    before = config.path.read_bytes()
    assert config.status()["status"] == "auth_error"
    assert config.path.read_bytes() == before


def test_sse_multiline_json_and_utf8_bom(config):
    config.save({"stream": True})
    wire = ('\ufeffdata: {"type":"image_generation.completed",\n'
            'data: "b64_json":"' + encoded() + '","revised_prompt":"合成"}\n\n').encode()
    with httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(200, headers={"content-type": "text/event-stream"}, stream=Chunks(wire, size=1)))) as client:
        data, _, meta = OpenAICompatibleProvider(config, client).generate("Synthetic", {})
    assert data == image_bytes() and meta["response"]["revised_prompt"] == "合成"


def test_partial_only_job_fails_and_cleans_preview_without_final_result(config):
    from backend.schemas import GenerationJobCreate
    from backend.services.generation_jobs import GenerationJobRepository
    config.save({"stream": True, "partial_images": 1})
    repo = GenerationJobRepository(config.library_path)
    job = repo.create_job(GenerationJobCreate(provider="openai_compatible", prompt_text="Synthetic", parameters={}))
    class PartialOnly(httpx.SyncByteStream):
        def __iter__(self):
            yield event("image_generation.partial_image", {"b64_json": encoded(), "partial_image_index": 0})
            current = repo.get_job(job.id)
            assert current.status == "running" and current.result_path is None
            assert current.metadata.get("stream_preview")
            yield b"data: [DONE]\n\n"
    with httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(200, headers={"content-type": "text/event-stream"}, stream=PartialOnly()))) as client:
        with pytest.raises(OpenAICompatibleError) as caught:
            OpenAICompatibleProvider(config, client).run_job(config.library_path, job.id)
    assert caught.value.diagnostics["category"] == "incomplete_stream"
    failed = repo.get_job(job.id)
    assert failed.status == "failed" and failed.result_path is None
    assert "stream_preview" not in failed.metadata
