"""Free, end-to-end request/queue/history contracts for compatible images."""
import base64
from io import BytesIO
import json

from fastapi.testclient import TestClient
import httpx
from PIL import Image
import pytest

from backend.main import create_app
from backend.schemas import GenerationJobCreate
from backend.services.generation_jobs import GenerationJobRepository, GenerationJobConflict
from backend.services.openai_compatible import OpenAICompatibleConfig, OpenAICompatibleProvider


@pytest.fixture
def setup(tmp_path, monkeypatch):
    config_path = tmp_path / "provider.json"
    config_path.write_text(json.dumps({"base_url": "https://example.invalid/v1", "api_key": "test-only", "model": "gpt-image-2.5-flare"}))
    monkeypatch.setenv("IMAGE_PROMPT_LIBRARY_OPENAI_COMPATIBLE_CONFIG_PATH", str(config_path))
    monkeypatch.setattr("backend.routers.generation_jobs.enqueue_generation_jobs", lambda *a, **k: None)
    monkeypatch.setattr("backend.routers.generation_jobs._continue_generation_queue", lambda *a, **k: None)
    library = tmp_path / "library"
    return library, config_path, TestClient(create_app(library_path=library))


@pytest.mark.parametrize("quality", ["auto", "low", "medium", "high", "xhigh", "max"])
def test_http_batch_freezes_complete_recipe_and_preserves_prompt(setup, quality):
    library, path, client = setup
    prompt = "  First line\n\n原文。  \n"
    settings = {"requested_aspect_ratio": "9:16", "size": "2160x3840", "quality": quality,
                "background": "transparent", "output_format": "webp", "output_compression": 0}
    result = client.post("/api/generation-jobs/sets", json={"count": 3, "job": {
        "provider": "openai_compatible", "prompt_text": prompt, "parameters": settings}})
    assert result.status_code == 200, result.text
    jobs = result.json()["jobs"]
    assert len(jobs) == 3
    config = json.loads(path.read_text())
    config["model"] = "gpt-image-2.5-sunburst"
    path.write_text(json.dumps(config))
    output = BytesIO()
    Image.new("RGBA", (32, 32), (0, 0, 0, 0)).save(output, "PNG")
    sent = []

    def respond(request):
        sent.append(json.loads(request.content))
        return httpx.Response(200, json={"data": [{"b64_json": base64.b64encode(output.getvalue()).decode()}]})

    provider = OpenAICompatibleProvider(OpenAICompatibleConfig(path), httpx.Client(transport=httpx.MockTransport(respond)))
    for job in jobs:
        stored = GenerationJobRepository(library).get_job(job["id"])
        assert stored.model == "gpt-image-2.5-flare"
        assert stored.parameters == {**settings, "model": stored.model}
        provider.run_job(library, stored.id)
    assert len(sent) == 3
    assert all(p == {"model": "gpt-image-2.5-flare", "prompt": prompt, "n": 1,
                     **{k: v for k, v in settings.items() if k != "requested_aspect_ratio"}} for p in sent)
    accepted = client.post(f"/api/generation-jobs/{jobs[0]['id']}/accept-as-new-item")
    assert accepted.status_code == 200, accepted.text
    item = accepted.json()["item"]
    assert item["prompts"][0]["text"] == prompt
    assert item["prompts"][0]["provenance"]["request_diagnostics"]["endpoint"].endswith("/images/generations")
    assert item["prompts"][0]["provenance"]["request_diagnostics"]["elapsed_seconds"] >= 0
    restarted = TestClient(create_app(library_path=library))
    recipe = restarted.get(f"/api/generation-jobs/for-image/{item['images'][0]['id']}").json()
    assert recipe["metadata"]["requested"]["quality"] == quality
    assert recipe["metadata"]["requested"]["size"] == "2160x3840"
    assert recipe["metadata"]["decoded_image"]["has_transparent_pixels"] is True
    assert recipe["metadata"]["mismatches"]


@pytest.mark.parametrize("settings", [
    {"size": "2880x3840"}, {"size": "1025x1024"},
    {"background": "transparent", "output_format": "jpeg"},
    {"output_format": "webp", "output_compression": 101},
])
def test_invalid_http_request_creates_no_jobs(setup, settings):
    library, _, client = setup
    result = client.post("/api/generation-jobs", json={"provider": "openai_compatible", "prompt_text": "test", "parameters": settings})
    assert result.status_code == 400
    assert GenerationJobRepository(library).list_jobs().total == 0


def test_retry_uses_recorded_request_over_old_conflicting_parameters(setup):
    library, _, _ = setup
    repo = GenerationJobRepository(library)
    job = repo.create_job(GenerationJobCreate(provider="openai_compatible", prompt_text="same", parameters={"requested_aspect_ratio": "9:16"}))
    repo.mark_failed(job.id, "failure", diagnostics={"category": "read_timeout", "http_status": 504})
    from backend.db import connect
    snapshot = {"requested": {"model": "gpt-image-2.5-sunburst", "size": "2160x3840", "quality": "max", "output_format": "webp", "output_compression": 0, "background": "transparent"}}
    with connect(library) as conn:
        conn.execute("UPDATE generation_jobs SET metadata=? WHERE id=?", (json.dumps(snapshot), job.id))
        conn.commit()
    retry = repo.retry_failed_job(job.id)
    assert retry.model == snapshot["requested"]["model"]
    assert all(retry.parameters[k] == v for k, v in snapshot["requested"].items())
    repo.mark_running(retry.id)
    with pytest.raises(GenerationJobConflict, match="Elapsed time alone"):
        repo.mark_stale_running_failed(retry.id)
