"""Regression tests for media ownership, credential binding and SQLite contention."""

import sqlite3
import threading
from io import BytesIO

import httpx
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from backend.db import connect
from backend.main import create_app
from backend.repositories import ItemRepository, StoredImageInput
from backend.schemas import GenerationJobCreate, ItemCreate
from backend.services.generation_jobs import GenerationJobRepository
from backend.services.image_store import store_image
from backend.services.library_cleanup import LibraryCleanupService
from backend.services.openai_compatible import (
    OpenAICompatibleApiKeyRequired, OpenAICompatibleConfig, OpenAICompatibleProvider,
)


def png(color="red"):
    output = BytesIO()
    Image.new("RGB", (24, 16), color).save(output, "PNG")
    return output.getvalue()


def add_stored_image(repo, library, data):
    item = repo.create_item(ItemCreate(title="Fixture"))
    stored = store_image(library, data, "fixture.png")
    repo.add_image(item.id, StoredImageInput(
        stored.original_path, stored.thumb_path, stored.preview_path,
        width=stored.width, height=stored.height, file_sha256=stored.file_sha256,
    ))
    return item, stored


def test_cleanup_apply_keeps_files_referenced_again_after_preview(tmp_path):
    library = tmp_path / "library"
    repo = ItemRepository(library)
    first, stored = add_stored_image(repo, library, png())
    repo.delete_item(first.id)
    repo.purge_item(first.id)
    service = LibraryCleanupService(library)
    preview = service.preview()
    assert stored.original_path in {record.path for record in preview.unreferenced_files}

    # Content-addressed storage maps the same bytes to the same files.
    second, again = add_stored_image(repo, library, png())
    assert again.original_path == stored.original_path
    result = service.apply(preview, remove_broken_image_records=False, remove_unreferenced_files=True)

    assert result.removed_unreferenced_files == 0
    for path in (again.original_path, again.thumb_path, again.preview_path):
        assert (library / path).is_file()
    assert repo.get_item(second.id).images[0].original_path == stored.original_path


def test_cleanup_apply_keeps_broken_record_repaired_after_preview(tmp_path):
    library = tmp_path / "library"
    repo = ItemRepository(library)
    item, stored = add_stored_image(repo, library, png("blue"))
    original = library / stored.original_path
    data = original.read_bytes()
    original.unlink()
    service = LibraryCleanupService(library)
    preview = service.preview()
    assert [record.item_id for record in preview.broken_image_records] == [item.id]

    original.write_bytes(data)
    result = service.apply(preview, remove_broken_image_records=True, remove_unreferenced_files=False)

    assert result.removed_broken_image_records == 0
    assert len(repo.get_item(item.id).images) == 1


def import_client(tmp_path):
    return TestClient(create_app(library_path=tmp_path / "library"))


def draft(media):
    return {"source_type": "repository", "title": "Imported", "prompts": [{"language": "en", "text": "Imported prompt"}], "media": media}


def test_import_draft_cannot_read_a_file_outside_the_staging_folder(tmp_path):
    c = import_client(tmp_path)
    outside = tmp_path / "private.png"
    outside.write_bytes(png("green"))
    for staged_path in (str(outside), "../private.png", "originals/../../private.png", "db.sqlite"):
        created = c.post("/api/import-drafts", json=draft([{"original_path": "x.png", "staged_path": staged_path}])).json()
        response = c.post(f"/api/import-drafts/{created['id']}/accept")
        assert response.status_code == 409, staged_path
    assert c.get("/api/items").json()["total"] == 0
    assert not list((tmp_path / "library" / "originals").rglob("*.png"))


def test_import_draft_original_path_never_becomes_a_deletable_library_path(tmp_path):
    c = import_client(tmp_path)
    library = tmp_path / "library"
    victim = library / "keep-me.txt"
    victim.write_text("keep")
    created = c.post("/api/import-drafts", json=draft([{"original_path": "keep-me.txt", "kind": "local_file"}])).json()
    accepted = c.post(f"/api/import-drafts/{created['id']}/accept").json()
    assert accepted["item"]["images"] == []
    c.delete(f"/api/items/{accepted['item']['id']}")
    assert c.delete(f"/api/items/{accepted['item']['id']}/permanent", params={"confirmed": True}).status_code == 200
    assert victim.read_text() == "keep"


@pytest.mark.parametrize("path", ["db.sqlite", "keep-me.txt", "../outside.png", "generation-results/job/result.png"])
def test_image_rows_only_own_library_media_paths(tmp_path, path):
    library = tmp_path / "library"
    repo = ItemRepository(library)
    item = repo.create_item(ItemCreate(title="Fixture"))
    with pytest.raises(ValueError, match="media folders"):
        repo.add_image(item.id, StoredImageInput(original_path=path))
    assert repo._safe_library_file(path) is None


@pytest.fixture
def compatible(tmp_path, monkeypatch):
    config = OpenAICompatibleConfig(tmp_path / "private" / "config.json", tmp_path / "library")
    monkeypatch.setenv("IMAGE_PROMPT_LIBRARY_OPENAI_COMPATIBLE_CONFIG_PATH", str(config.path))
    config.save({"display_name": "Gateway", "base_url": "https://images.example/v1", "api_key": "test-only-secret", "model": "image-model"}, profile_id="p1")
    return config


def test_changing_base_url_requires_the_api_key_again(compatible):
    with pytest.raises(OpenAICompatibleApiKeyRequired):
        compatible.save({"base_url": "http://127.0.0.1:9/v1"}, profile_id="p1")
    assert compatible.read("p1")["base_url"] == "https://images.example/v1"
    # Equivalent spellings of the same address keep the key.
    compatible.save({"base_url": "https://images.example/v1/", "display_name": "Renamed"}, profile_id="p1")
    assert compatible.read("p1")["api_key"] == "test-only-secret"
    compatible.save({"base_url": "https://other.example/v1", "api_key": "test-only-other"}, profile_id="p1")
    assert compatible.read("p1")["api_key"] == "test-only-other"
    compatible.save({"base_url": "https://third.example/v1", "remove_api_key": True}, profile_id="p1")
    assert compatible.read("p1")["api_key"] == ""


def test_profile_route_reports_key_required_without_echoing_the_key(tmp_path, compatible):
    c = TestClient(create_app(library_path=tmp_path / "library"))
    response = c.put("/api/generation-providers/openai-compatible/profiles/p1", json={"base_url": "http://127.0.0.1:9/v1", "display_name": "Gateway"})
    assert response.status_code == 422
    assert response.json()["detail"].startswith("Enter the API key again when changing the Base URL")
    assert "test-only-secret" not in response.text


def test_stage_result_keeps_paid_image_when_database_is_locked(tmp_path, monkeypatch):
    monkeypatch.setattr("backend.db.BUSY_TIMEOUT_SECONDS", 0.2)
    repo = GenerationJobRepository(tmp_path / "library")
    job = repo.create_job(GenerationJobCreate(provider="manual_upload", prompt_text="Synthetic lock test"))
    repo.mark_running(job.id)
    holder = sqlite3.connect(tmp_path / "library" / "db.sqlite")
    holder.execute("BEGIN IMMEDIATE")
    try:
        with pytest.raises(sqlite3.OperationalError, match="locked"):
            repo.stage_result(job.id, png("purple"), "result.png")
    finally:
        holder.rollback()
        holder.close()
    kept = list((tmp_path / "library" / "generation-results" / job.id).glob("result-*.png"))
    assert len(kept) == 1 and kept[0].read_bytes() == png("purple")
    assert repo.get_job(job.id).status == "running"


def test_database_uses_wal_so_readers_do_not_block_the_writer(tmp_path):
    library = tmp_path / "library"
    ItemRepository(library)
    with connect(library) as conn:
        assert conn.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
    reader = sqlite3.connect(library / "db.sqlite")
    reader.execute("BEGIN")
    reader.execute("SELECT COUNT(*) FROM items").fetchone()
    try:
        ItemRepository(library).create_item(ItemCreate(title="Written while a read is open"))
    finally:
        reader.rollback()
        reader.close()


def test_stream_preview_storage_failure_does_not_abandon_the_paid_request(compatible, monkeypatch):
    import base64
    import json

    events = [
        {"type": "image_generation.partial_image", "partial_image_index": 0, "b64_json": base64.b64encode(png("gray")).decode()},
        {"type": "image_generation.completed", "b64_json": base64.b64encode(png("orange")).decode()},
    ]
    body = "".join(f"event: {event['type']}\ndata: {json.dumps(event)}\n\n" for event in events).encode()
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=body)

    compatible.save({"stream": True, "partial_images": 1}, profile_id="p1")
    repo = GenerationJobRepository(compatible.library_path)
    job = repo.create_job(GenerationJobCreate(provider="openai_compatible", prompt_text="Synthetic stream", parameters={"compatible_profile_id": "p1"}))

    def failing_preview(self, *args, **kwargs):
        raise sqlite3.OperationalError("database is locked")

    monkeypatch.setattr(GenerationJobRepository, "stage_stream_preview", failing_preview)
    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        OpenAICompatibleProvider(compatible, client).run_job(compatible.library_path, job.id)

    finished = repo.get_job(job.id)
    assert len(requests) == 1
    assert finished.status == "succeeded"
    assert (compatible.library_path / finished.result_path).read_bytes() == png("orange")
