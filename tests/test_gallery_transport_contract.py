"""Exercise the production TS serializer through HTTP, queue and mocked upstream."""
import base64
from io import BytesIO
import json
from pathlib import Path
import subprocess

import httpx
from fastapi.testclient import TestClient
from PIL import Image
import pytest

from backend.main import create_app
from backend.schemas import GenerationJobCreate
from backend.services.generation_jobs import GenerationJobRepository
from backend.services.openai_compatible import OpenAICompatibleConfig, OpenAICompatibleProvider


DEFAULTS = dict(base_url_mode="versioned", stream=False, partial_images=0, response_format="auto")
ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.parametrize("mode", ["custom", "versioned"])
@pytest.mark.parametrize("stream", [False, True])
@pytest.mark.parametrize("source", ["requested", "parameters", "legacy"])
def test_gallery_restored_payload_retains_historical_transport(tmp_path, monkeypatch, mode, stream, source):
    library = tmp_path / "library"
    config_path = tmp_path / "provider.json"
    historical = dict(base_url_mode=mode, stream=stream, partial_images=2 if stream else 0,
                      response_format="b64_json" if stream else "auto")
    current = dict(base_url_mode="versioned" if mode == "custom" else "custom", stream=not stream,
                   partial_images=0 if stream else 2, response_format="auto" if stream else "b64_json")
    config_path.write_text(json.dumps(dict(base_url="https://synthetic.invalid/gateway", api_key="synthetic-only",
                                          model="synthetic-model", **historical)))
    monkeypatch.setenv("IMAGE_PROMPT_LIBRARY_OPENAI_COMPATIBLE_CONFIG_PATH", str(config_path))
    monkeypatch.setattr("backend.routers.generation_jobs.enqueue_generation_jobs", lambda *a, **kw: None)
    monkeypatch.setattr("backend.routers.generation_jobs._continue_generation_queue", lambda *a, **kw: None)
    repo = GenerationJobRepository(library)
    original = repo.create_job(GenerationJobCreate(provider="openai_compatible", prompt_text="synthetic original"))
    job = original.model_dump(mode="json")
    if source == "requested":
        job["parameters"].update(current)
        job["metadata"]["requested"] = historical
    elif source == "legacy":
        for key in DEFAULTS:
            job["parameters"].pop(key)
    # Same profile has since acquired opposite defaults. No real endpoint exists.
    config = json.loads(config_path.read_text())
    config.update(current)
    config_path.write_text(json.dumps(config))
    prompt = "  synthetic edited prompt\n\n原文空白。  \n"
    serialized = subprocess.run(
        ["node", str(ROOT / "tests/helpers/gallery-transport-payload.mjs")],
        input=json.dumps({"job": job, "promptText": prompt}), text=True, encoding="utf-8",
        cwd=ROOT, capture_output=True, check=True, timeout=30,
    )
    payload = json.loads(serialized.stdout)
    expected = DEFAULTS if source == "legacy" else historical
    assert {key: payload["parameters"][key] for key in DEFAULTS} == expected
    assert "api_key" not in serialized.stdout and "synthetic-only" not in serialized.stdout
    response = TestClient(create_app(library_path=library)).post("/api/generation-jobs", json=payload)
    assert response.status_code == 200, response.text
    created = response.json()
    stored = repo.get_job(created["id"])
    assert {key: stored.parameters[key] for key in DEFAULTS} == expected
    output = BytesIO()
    Image.new("RGB", (8, 6), "blue").save(output, "PNG")
    requests = []

    def reply(request):
        body = json.loads(request.content)
        requests.append(body)
        assert body["prompt"] == prompt
        assert "base_url_mode" not in body
        assert "transportLegacyDerived" not in body
        assert request.url.path == "/gateway" + ("/v1" if expected["base_url_mode"] == "versioned" else "") + "/images/generations"
        assert ("stream" in body) is expected["stream"]
        assert ("partial_images" in body) is expected["stream"]
        if expected["stream"]:
            assert body["stream"] is True and body["partial_images"] == expected["partial_images"]
        assert ("response_format" in body) is (expected["response_format"] == "b64_json")
        if "response_format" in body:
            assert body["response_format"] == "b64_json"
        return httpx.Response(200, json={"data": [{"b64_json": base64.b64encode(output.getvalue()).decode()}]})

    with httpx.Client(transport=httpx.MockTransport(reply)) as http:
        OpenAICompatibleProvider(OpenAICompatibleConfig(config_path), http).run_job(library, stored.id)
    assert len(requests) == 1
    completed = repo.get_job(stored.id)
    assert completed.status == "succeeded"
    assert {key: completed.metadata["requested"][key] for key in DEFAULTS} == expected
