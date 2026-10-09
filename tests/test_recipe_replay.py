"""Saved recipe replay against an isolated library and a non-network transport."""
import base64
from email import policy
from email.parser import BytesParser
from io import BytesIO
import json

import httpx
from fastapi.testclient import TestClient
from PIL import Image
import pytest

from backend.main import create_app
from backend.schemas import GenerationJobCreate
from backend.services.generation_jobs import GenerationJobRepository
from backend.services.openai_compatible import OpenAICompatibleConfig, OpenAICompatibleError, OpenAICompatibleProvider


def png(color):
    output = BytesIO()
    Image.new("RGB", (24, 16), color).save(output, "PNG")
    return output.getvalue()


@pytest.fixture
def replay(tmp_path, monkeypatch):
    library = tmp_path / "library"
    config_path = tmp_path / "provider.json"
    config_path.write_text(json.dumps({"base_url": "https://example.invalid/v1", "api_key": "test-only", "model": "gpt-image-2.5-flare"}))
    monkeypatch.setenv("IMAGE_PROMPT_LIBRARY_OPENAI_COMPATIBLE_CONFIG_PATH", str(config_path))
    monkeypatch.setattr("backend.routers.generation_jobs.enqueue_generation_jobs", lambda *a, **k: None)
    monkeypatch.setattr("backend.routers.generation_jobs._continue_generation_queue", lambda *a, **k: None)
    client = TestClient(create_app(library_path=library))
    return library, client, GenerationJobRepository(library), OpenAICompatibleConfig(config_path)


def saved_recipe(replay, count, inline=False):
    library, client, repo, _ = replay
    originals = [png(color) for color in ("red", "blue")[:count]]
    specs = []
    source_paths = []
    for index, data in enumerate(originals):
        if inline:
            specs.append({"name": f"reference-{index}.png", "data_url": "data:image/png;base64," + base64.b64encode(data).decode()})
            continue
        source = repo.create_job(GenerationJobCreate(prompt_text="Synthetic source"))
        staged = repo.stage_result(source.id, data, f"source-{index}.png")
        specs.append({"name": f"reference-{index}.png", "result_path": staged.result_path})
        source_paths.append(library / staged.result_path)
    settings = {"size": "1024x1536", "quality": "xhigh", "background": "transparent", "output_format": "webp", "output_compression": 0}
    created = client.post("/api/generation-jobs", json={
        "provider": "openai_compatible", "model": "gpt-image-2.5-flare", "mode": "image_edit" if count else "text_to_image",
        "prompt_text": "Change only the synthetic color", "parameters": {**settings, "input_images": specs},
    })
    assert created.status_code == 200, created.text
    job = created.json()
    # Input snapshots remain usable after transient source results disappear.
    for path in source_paths:
        path.unlink()
    repo.stage_result(job["id"], png("green"), "result.png", {"requested": {"model": job["model"], **settings}})
    accepted = client.post(f"/api/generation-jobs/{job['id']}/accept-as-new-item")
    assert accepted.status_code == 200, accepted.text
    image_id = accepted.json()["job"]["accepted_image_id"]
    recipe = client.get(f"/api/generation-jobs/for-image/{image_id}")
    assert recipe.status_code == 200
    return recipe.json(), originals, settings


@pytest.mark.parametrize("count", [0, 1, 2])
@pytest.mark.parametrize("inline", [False, True])
def test_saved_recipe_submits_original_input_bytes_in_order(replay, count, inline):
    library, client, repo, config = replay
    recipe, originals, settings = saved_recipe(replay, count, inline)
    restored = []
    for spec in recipe["parameters"]["input_images"]:
        image = client.get("/media/" + spec["result_path"])
        assert image.status_code == 200
        restored.append({"name": spec["name"], "data_url": "data:image/png;base64," + base64.b64encode(image.content).decode()})
    submitted = client.post("/api/generation-jobs", json={
        "provider": recipe["provider"], "model": recipe["model"], "mode": recipe["mode"],
        "prompt_text": recipe["prompt_text"], "parameters": {**recipe["parameters"], "input_images": restored},
    })
    assert submitted.status_code == 200, submitted.text
    requests = []

    def respond(request):
        requests.append(request)
        assert request.url.path == ("/v1/images/edits" if count else "/v1/images/generations")
        if count:
            message = BytesParser(policy=policy.default).parsebytes(
                b"Content-Type: " + request.headers["content-type"].encode() + b"\r\n\r\n" + request.content)
            parts = list(message.iter_parts())
            images = [p.get_payload(decode=True) for p in parts if p.get_param("name", header="content-disposition") == "image[]"]
            assert images == originals
            payload = {p.get_param("name", header="content-disposition"): p.get_payload(decode=True).decode() for p in parts if p.get_filename() is None}
        else:
            payload = json.loads(request.content)
        assert payload["model"] == "gpt-image-2.5-flare"
        assert all(str(payload[key]) == str(value) for key, value in settings.items())
        return httpx.Response(200, json={"data": [{"b64_json": base64.b64encode(png("green")).decode()}]})

    with httpx.Client(transport=httpx.MockTransport(respond)) as transport:
        result = OpenAICompatibleProvider(config, transport).run_job(library, submitted.json()["id"])
    assert result.status == "succeeded"
    assert len(requests) == 1
    assert repo.get_job(result.id).mode == recipe["mode"]


def test_missing_reference_never_falls_back_to_generations(replay):
    library, client, repo, config = replay
    recipe, _, _ = saved_recipe(replay, 2)
    # A reference lost after submit must fail before any paid HTTP request.
    submitted = client.post("/api/generation-jobs", json={key: recipe[key] for key in ("provider", "model", "mode", "prompt_text", "parameters")})
    assert submitted.status_code == 200
    (library / recipe["parameters"]["input_images"][1]["result_path"]).unlink()
    requests = []
    with httpx.Client(transport=httpx.MockTransport(lambda request: requests.append(request))) as transport:
        with pytest.raises(OpenAICompatibleError):
            OpenAICompatibleProvider(config, transport).run_job(library, submitted.json()["id"])
    assert requests == []
    assert repo.get_job(submitted.json()["id"]).status == "failed"
    assert client.get("/media/" + recipe["parameters"]["input_images"][1]["result_path"]).status_code == 404
    # Nor may a stale persisted reference be silently dropped at job creation.
    rejected = client.post("/api/generation-jobs", json={key: recipe[key] for key in ("provider", "model", "mode", "prompt_text", "parameters")})
    assert rejected.status_code == 409


def test_legacy_inline_recipe_is_recoverable_without_exposing_data_urls(replay):
    from backend.db import connect

    library, client, repo, _ = replay
    recipe, originals, _ = saved_recipe(replay, 2, inline=True)
    stored = repo.get_job(recipe["id"])
    parameters = dict(stored.parameters)
    for spec in parameters["input_images"]:
        (library / spec.pop("result_path")).unlink()
        spec.pop("preview_path")
    with connect(library) as conn:
        conn.execute("UPDATE generation_jobs SET parameters=? WHERE id=?", (json.dumps(parameters), stored.id))
        conn.commit()
    for url in (f"/api/generation-jobs/for-image/{stored.accepted_image_id}", f"/api/generation-jobs/{stored.id}", "/api/generation-jobs"):
        response = client.get(url)
        assert response.status_code == 200
        visible = response.json()
        if "jobs" in visible:
            visible = next(job for job in visible["jobs"] if job["id"] == stored.id)
        inputs = visible["parameters"]["input_images"]
        assert all("data_url" not in spec for spec in inputs)
        assert [client.get("/media/" + spec["result_path"]).content for spec in inputs] == originals
    # Presentation repair does not alter historical request records.
    assert repo.get_job(stored.id).parameters == parameters


@pytest.mark.parametrize("source", ["copies", "ids"])
def test_legacy_reference_fallback_preserves_order_and_missing_slots(replay, source):
    from backend.db import connect

    library, client, repo, _ = replay
    recipe, originals, _ = saved_recipe(replay, 2, inline=True)
    stored = repo.get_job(recipe["id"])
    refs = [image for image in repo.items.get_item(repo.items.get_image(stored.accepted_image_id).item_id).images if image.role == "reference_image"]
    # Establish expected order explicitly, independent of item display ordering.
    refs = sorted(refs, key=lambda image: originals.index((library / image.original_path).read_bytes()))
    copies = [{"copied_path": spec["result_path"]} for spec in stored.parameters["input_images"]]
    parameters = {key: value for key, value in stored.parameters.items() if key != "input_images"}
    with connect(library) as conn:
        conn.execute("UPDATE generation_jobs SET parameters=?, metadata=?, reference_image_ids=? WHERE id=?", (
            json.dumps(parameters), json.dumps({"reference_image_copies": copies} if source == "copies" else {}), json.dumps([ref.id for ref in refs]), stored.id))
        conn.commit()
    visible = client.get(f"/api/generation-jobs/{stored.id}").json()
    inputs = visible["parameters"]["input_images"]
    assert [client.get("/media/" + spec["result_path"]).content for spec in inputs] == originals
    if source == "copies":
        (library / copies[1]["copied_path"]).unlink()
    else:
        (library / refs[1].original_path).unlink()
    missing = client.get(f"/api/generation-jobs/{stored.id}").json()["parameters"]["input_images"]
    assert len(missing) == 2
    assert client.get("/media/" + missing[0]["result_path"]).content == originals[0]
    assert "result_path" not in missing[1] or client.get("/media/" + missing[1]["result_path"]).status_code == 404


def test_inline_bytes_take_precedence_over_conflicting_nonlibrary_path(replay):
    from backend.db import connect

    library, client, repo, _ = replay
    recipe, originals, _ = saved_recipe(replay, 2, inline=True)
    stored = repo.get_job(recipe["id"])
    parameters = stored.parameters
    parameters["input_images"][0]["result_path"] = parameters["input_images"][1]["result_path"]
    with connect(library) as conn:
        conn.execute("UPDATE generation_jobs SET parameters=? WHERE id=?", (json.dumps(parameters), stored.id))
        conn.commit()
    recovered = client.get(f"/api/generation-jobs/{stored.id}").json()["parameters"]["input_images"]
    assert client.get("/media/" + recovered[0]["result_path"]).content == originals[0]
    created = client.post("/api/generation-jobs", json={"provider": "openai_compatible", "model": stored.model, "prompt_text": "Synthetic", "mode": "image_edit", "parameters": parameters})
    assert created.status_code == 200
    assert client.get("/media/" + created.json()["parameters"]["input_images"][0]["result_path"]).content == originals[0]
    parameters["input_images"][0]["data_url"] = "data:image/png;base64,not-valid"
    with connect(library) as conn:
        conn.execute("UPDATE generation_jobs SET parameters=? WHERE id=?", (json.dumps(parameters), stored.id))
        conn.commit()
    broken = client.get(f"/api/generation-jobs/{stored.id}").json()["parameters"]["input_images"]
    assert len(broken) == 2
    assert "result_path" not in broken[0]
