"""Gallery naming uses isolated libraries and synthetic, mocked model responses."""
import base64
import json
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
from threading import Event

import httpx
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from backend.db import connect
from backend.main import create_app
from backend.services import capture_organizer as service
from backend.routers import generation_jobs as routes

PROMPT = "  Synthetic red result\r\n\n original whitespace  "
SECRET = "synthetic-gallery-title-key"
REAL_ENQUEUE = service.enqueue_jobs
REAL_HTTP_STREAM = httpx.Client.stream


def png(color):
    output = BytesIO()
    Image.new("RGB", (16, 12), color).save(output, "PNG")
    return output.getvalue()


@pytest.fixture
def setup(tmp_path, monkeypatch):
    monkeypatch.setenv("IMAGE_PROMPT_LIBRARY_CAPTURE_ORGANIZER_CONFIG_PATH", str(tmp_path / "config" / "organizer.json"))
    monkeypatch.setenv("IMAGE_PROMPT_LIBRARY_CAPTURE_CLIENTS_PATH", str(tmp_path / "config" / "pairings.json"))
    monkeypatch.setattr(routes, "enqueue_metadata_jobs", lambda library: None)
    monkeypatch.setattr(service, "enqueue_jobs", lambda library: None)
    monkeypatch.setattr(httpx.Client, "stream", lambda *a, **k: pytest.fail("No real model request allowed"))
    library = tmp_path / "library"
    client = TestClient(create_app(library))
    service.OrganizerConfig(library).save({
        "enabled": True, "base_url": "https://example.invalid", "api_key": SECRET,
        "generate_title": False, "assign_collection": True,
    })
    return library, client


def accept(client, payload=None, reference=False):
    job = client.post("/api/generation-jobs", json={
        "provider": "manual_upload", "prompt_text": PROMPT, "mode": "image_edit" if reference else "text_to_image",
        "parameters": {"input_images": [{"name": "reference.png", "data_url":
            "data:image/png;base64," + base64.b64encode(png("blue")).decode()}]} if reference else {},
    }).json()
    uploaded = client.post(f"/api/generation-jobs/{job['id']}/result",
                          files={"file": ("result.png", png("red"), "image/png")})
    assert uploaded.status_code == 200
    response = client.post(f"/api/generation-jobs/{job['id']}/accept-as-new-item", json=payload or {})
    assert response.status_code == 200, response.text
    return job, response.json()["item"]


def status(library, item):
    return service.gallery_title_status(library, item["id"])


def test_explicit_title_only_names_result_once_and_preserves_originals(setup, monkeypatch):
    library, client = setup
    job, item = accept(client, {"auto_title": True, "cluster_name": "Manual collection"}, reference=True)
    assert status(library, item)["status"] == "pending"
    assert len(item["images"]) == 2
    calls = []

    def metadata(settings, prompt, title, image_url, collections):
        calls.append(prompt)
        assert prompt == PROMPT and settings["_title_only"] and not settings["allow_new_collections"]
        assert collections == []
        image = Image.open(BytesIO(base64.b64decode(image_url.split(",")[1])))
        r, g, b = image.getpixel((0, 0))
        assert r > 200 and b < 30  # Result, never the first blue reference.
        return {"title": "Synthetic red image", "collection": "Ignored classification"}

    monkeypatch.setattr(service, "request_metadata", metadata)
    before = {i["original_path"]: (library / i["original_path"]).read_bytes() for i in item["images"]}
    service.run_gallery_title(library, item["id"])
    service.run_gallery_title(library, item["id"])
    updated = client.get(f"/api/items/{item['id']}").json()
    assert len(calls) == 1 and updated["title"] == "Synthetic red image"
    assert updated["cluster"]["name"] == "Manual collection"
    assert updated["prompts"] == item["prompts"] and updated["images"] == item["images"]
    assert updated["prompts"][0]["text"] == PROMPT
    assert before == {path: (library / path).read_bytes() for path in before}
    assert client.get(f"/api/items/{item['id']}/gallery-title-status").json() == {"status": "succeeded", "category": ""}
    assert SECRET.encode() not in (library / "db.sqlite").read_bytes()
    assert client.post(f"/api/generation-jobs/{job['id']}/accept-as-new-item", json={"auto_title": True}).status_code == 409
    assert len(calls) == 1


@pytest.mark.parametrize("payload,expected", [
    ({}, {"status": "disabled", "category": "no_job"}),
    ({"auto_title": False}, {"status": "disabled", "category": "no_job"}),
    ({"auto_title": True, "title": "Manual name"}, {"status": "skipped", "category": "manual_title"}),
])
def test_default_off_and_manual_title_never_call_model(setup, monkeypatch, payload, expected):
    library, client = setup
    monkeypatch.setattr(service, "request_metadata", lambda *a: pytest.fail("Must not call naming"))
    _, item = accept(client, payload)
    service.run_gallery_title(library, item["id"])
    assert status(library, item) == expected
    assert client.get(f"/api/items/{item['id']}").json()["title"] == item["title"]


@pytest.mark.parametrize("change", ["disable", "model", "key", "title", "prompt", "delete", "permanent_delete"])
def test_late_response_cannot_override_user_or_configuration_changes(setup, monkeypatch, change):
    library, client = setup
    _, item = accept(client, {"auto_title": True})
    entered, release = Event(), Event()

    def metadata(*args):
        entered.set()
        assert release.wait(10)
        return {"title": "Late name", "collection": None}

    monkeypatch.setattr(service, "request_metadata", metadata)
    with ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(service.run_gallery_title, library, item["id"])
        assert entered.wait(10)
        if change in {"disable", "model", "key"}:
            service.OrganizerConfig(library).save({
                "disable": {"enabled": False}, "model": {"model": "different-model"},
                "key": {"api_key": "replacement-synthetic-key"},
            }[change])
        elif change in {"delete", "permanent_delete"}:
            assert client.delete(f"/api/items/{item['id']}").status_code == 200
            if change == "permanent_delete":
                assert client.delete(f"/api/items/{item['id']}/permanent", params={"confirmed": True}).status_code == 200
        else:
            patch = {"title": "My latest title"} if change == "title" else {
                "prompts": [{"text": "My new prompt", "is_original": True}]}
            assert client.patch(f"/api/items/{item['id']}", json=patch).status_code == 200
        release.set()
        pending.result(timeout=10)
    fetched = client.get(f"/api/items/{item['id']}")
    if change == "permanent_delete":
        assert fetched.status_code == 404
        assert client.get(f"/api/items/{item['id']}/gallery-title-status").status_code == 404
    else:
        if change == "delete":
            assert fetched.json()["deleted_at"]
            assert fetched.json()["title"] == item["title"]
        assert fetched.json()["title"] != "Late name"
        assert status(library, item)["status"] == "skipped"


def test_pending_changed_config_is_skipped_and_failures_never_replayed(setup, monkeypatch):
    library, client = setup
    _, first = accept(client, {"auto_title": True})
    service.OrganizerConfig(library).save({"enabled": False})
    monkeypatch.setattr(service, "request_metadata", lambda *a: pytest.fail("Changed configuration"))
    service.run_gallery_title(library, first["id"])
    assert status(library, first) == {"status": "skipped", "category": "configuration_changed"}
    _, disabled = accept(client, {"auto_title": True})
    assert status(library, disabled) == {"status": "skipped", "category": "configuration"}
    service.OrganizerConfig(library).save({"enabled": True})
    _, failed = accept(client, {"auto_title": True})
    calls = []

    def fail(*args):
        calls.append(1)
        raise service.RemoteFailure("timeout")

    monkeypatch.setattr(service, "request_metadata", fail)
    service.run_gallery_title(library, failed["id"])
    service.recover_jobs(library)
    service.run_gallery_title(library, failed["id"])
    assert len(calls) == 1 and status(library, failed)["status"] == "uncertain"
    assert client.get(f"/api/items/{failed['id']}").json()["title"] == failed["title"]


def test_interrupted_running_job_not_replayed_and_status_reads_do_not_enqueue(setup, monkeypatch):
    library, client = setup
    _, item = accept(client, {"auto_title": True})
    with connect(library) as conn:
        conn.execute("UPDATE gallery_title_jobs SET status='running' WHERE item_id=?", (item["id"],))
        conn.commit()
    service.recover_jobs(library)
    monkeypatch.setattr(service, "request_metadata", lambda *a: pytest.fail("No replay"))
    service.run_gallery_title(library, item["id"])
    for _ in range(3):
        assert client.get(f"/api/items/{item['id']}/gallery-title-status").json() == {
            "status": "uncertain", "category": "interrupted"}
    plain = client.post("/api/items", json={"title": "Unrelated"}).json()
    assert client.get(f"/api/items/{plain['id']}/gallery-title-status").json() == {"status": "disabled", "category": "no_job"}


def test_atomic_claim_allows_one_model_call(setup, monkeypatch):
    library, client = setup
    _, item = accept(client, {"auto_title": True})
    entered, release = Event(), Event()
    calls = []

    def metadata(*args):
        calls.append(1)
        entered.set()
        assert release.wait(10)
        return {"title": "One name", "collection": None}

    monkeypatch.setattr(service, "request_metadata", metadata)
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(service.run_gallery_title, library, item["id"])
        assert entered.wait(10)
        second = pool.submit(service.run_gallery_title, library, item["id"])
        second.result(timeout=10)
        release.set()
        first.result(timeout=10)
    assert len(calls) == 1 and status(library, item)["status"] == "succeeded"


def test_http_acceptance_returns_while_background_model_is_pending(setup, monkeypatch):
    library, client = setup
    entered, release = Event(), Event()

    def metadata(*args):
        entered.set()
        assert release.wait(10)
        return {"title": "Background title", "collection": None}

    monkeypatch.setattr(service, "request_metadata", metadata)
    monkeypatch.setattr(routes, "enqueue_metadata_jobs", REAL_ENQUEUE)
    try:
        _, item = accept(client, {"auto_title": True})
        assert entered.wait(10)
        assert status(library, item)["status"] == "running"
        assert client.get(f"/api/items/{item['id']}").json()["title"] == item["title"]
    finally:
        release.set()
        service.drain_jobs(library)
    assert status(library, item)["status"] == "succeeded"


def test_mock_http_request_reuses_saved_vision_config_and_requests_title_only(setup, monkeypatch):
    library, client = setup
    _, item = accept(client, {"auto_title": True})
    requests = []
    original_client = httpx.Client
    monkeypatch.setattr(original_client, "stream", REAL_HTTP_STREAM)

    def handler(request):
        requests.append(request)
        body = json.loads(request.content)
        assert request.url == "https://example.invalid/v1/chat/completions"
        assert request.headers["Authorization"] == "Bearer " + SECRET
        assert body["model"] == "gpt-6-luna"
        assert "title-only" in body["messages"][0]["content"]
        content = body["messages"][1]["content"]
        instructions = json.loads(content[0]["text"])
        assert instructions["original_prompt"] == PROMPT
        assert instructions["allow_new_collections"] is False and instructions["existing_collections"] == []
        assert content[1]["type"] == "image_url"
        return httpx.Response(200, json={"choices": [{"message": {
            "content": json.dumps({"title": "Mocked HTTP title", "collection": "Must be ignored"})}}]})

    monkeypatch.setattr(httpx, "Client", lambda **kwargs: original_client(transport=httpx.MockTransport(handler), **kwargs))
    service.run_gallery_title(library, item["id"])
    assert len(requests) == 1 and status(library, item)["status"] == "succeeded"
    final = client.get(f"/api/items/{item['id']}").json()
    assert final["title"] == "Mocked HTTP title" and final["cluster"] is None


def test_recycle_bin_skips_pending_title_and_restore_does_not_restart(setup, monkeypatch):
    library, client = setup
    job, item = accept(client, {"auto_title": True}, reference=True)
    assert status(library, item)["status"] == "pending"
    monkeypatch.setattr(service, "request_metadata", lambda *args: pytest.fail("Trashed items must not call the title model"))
    assert client.delete(f"/api/items/{item['id']}").status_code == 200
    service.run_gallery_title(library, item["id"])
    assert status(library, item) == {"status": "skipped", "category": "content_changed"}
    assert client.post(f"/api/items/{item['id']}/restore").json() == item
    service.run_gallery_title(library, item["id"])
    assert status(library, item) == {"status": "skipped", "category": "content_changed"}
    assert client.get(f"/api/generation-jobs/{job['id']}").json()["status"] == "accepted"
