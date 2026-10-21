from io import BytesIO

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from backend import db
from backend.main import create_app
from backend.repositories import ItemRepository
from backend.services.generation_jobs import GenerationJobRepository
from backend.schemas import GenerationJobCreate
from backend.services.library_archives import backup_library, restore_library, verify_backup, LibraryArchiveError


def image_bytes(color="orange"):
    output = BytesIO()
    Image.new("RGB", (12, 18), color).save(output, format="PNG")
    return output.getvalue()


def create_item(client, title="Synthetic two images", **overrides):
    payload = {"title": title, "cluster_name": "Synthetic collection", "tags": ["synthetic"],
               "prompts": [{"language": "en", "text": "  Original\n\n whitespace  ", "is_original": True}],
               "favorite": True, "notes": "Keep metadata", "author": "Fixture"}
    payload.update(overrides)
    response = client.post("/api/items", json=payload)
    assert response.status_code == 200
    item = response.json()
    for role, color in (("reference_image", "blue"), ("result_image", "orange")):
        uploaded = client.post(f"/api/items/{item['id']}/images", data={"role": role},
                               files={"file": (f"{color}.png", image_bytes(color), "image/png")})
        assert uploaded.status_code == 200
    return client.get(f"/api/items/{item['id']}").json()


def test_trash_restore_preserves_two_originals_order_metadata_and_hides_library_views(tmp_path):
    library = tmp_path / "library"
    client = TestClient(create_app(library_path=library))
    before = create_item(client)
    item_id = before["id"]
    paths = {image[key]: (library / image[key]).read_bytes() for image in before["images"]
             for key in ("original_path", "thumb_path", "preview_path")}
    deleted = client.delete(f"/api/items/{item_id}")
    assert deleted.status_code == 200
    stamp = deleted.json()["deleted_at"]
    assert stamp
    assert client.delete(f"/api/items/{item_id}").json()["deleted_at"] == stamp
    for query in ({}, {"q": "Original"}, {"q": "archived:any"}, {"archived": True},
                  {"cluster": before["cluster"]["id"]}, {"tag": "synthetic"}, {"favorite": True}):
        assert client.get("/api/items", params=query).json()["total"] == 0
    assert client.get("/api/clusters").json() == []
    assert all(tag["count"] == 0 for tag in client.get("/api/tags").json())
    trash = client.get("/api/items", params={"trashed": True}).json()
    assert trash["total"] == 1
    assert trash["items"][0]["deleted_at"] == stamp
    assert client.get(f"/api/items/{item_id}").json()["images"] == before["images"]
    with pytest.raises(KeyError):
        ItemRepository(library).get_image(before["images"][0]["id"])
    assert client.patch(f"/api/items/{item_id}", json={"title": "Overwrite"}).status_code == 404
    assert client.post(f"/api/items/{item_id}/favorite").status_code == 404
    assert client.post(f"/api/items/{item_id}/images", files={"file": ("no.png", b"bad", "image/png")}).status_code == 404
    restored = client.post(f"/api/items/{item_id}/restore")
    assert restored.status_code == 200
    assert restored.json() == before
    assert client.post(f"/api/items/{item_id}/restore").json() == before
    assert client.get("/api/items", params={"trashed": True}).json()["total"] == 0
    assert client.get("/api/items", params={"q": "Original"}).json()["total"] == 1
    assert client.get("/api/clusters").json()[0]["id"] == before["cluster"]["id"]
    assert {path: (library / path).read_bytes() for path in paths} == paths
    with db.connect(library) as conn:
        assert conn.execute("SELECT COUNT(*) FROM generation_jobs").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM capture_organizer_jobs").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM gallery_title_jobs").fetchone()[0] == 0


def test_archived_trash_visible_and_restored_with_archived_state(tmp_path):
    client = TestClient(create_app(library_path=tmp_path / "library"))
    item = create_item(client, archived=True)
    client.delete(f"/api/items/{item['id']}")
    assert client.get("/api/items", params={"trashed": True, "archived": False}).json()["total"] == 1
    assert client.get("/api/items", params={"trashed": True, "q": "archived:false"}).json()["total"] == 1
    assert client.post(f"/api/items/{item['id']}/restore").json() == item
    assert client.get("/api/items").json()["total"] == 0
    assert client.get("/api/items", params={"archived": True}).json()["total"] == 1


def test_permanent_delete_requires_separate_confirmation_and_protects_shared_media(tmp_path):
    library = tmp_path / "library"
    client = TestClient(create_app(library_path=library))
    first = create_item(client)
    second = create_item(client, title="Keep shared media")
    paths = {image[key] for image in first["images"] for key in ("original_path", "thumb_path", "preview_path")}
    assert paths == {image[key] for image in second["images"] for key in ("original_path", "thumb_path", "preview_path")}
    url = f"/api/items/{first['id']}/permanent"
    assert client.delete(url).status_code == 400
    assert client.delete(url, params={"confirmed": True}).status_code == 409
    assert client.get(f"/api/items/{first['id']}").json() == first
    for item in (first, second):
        assert client.delete(f"/api/items/{item['id']}").status_code == 200
    assert client.delete(url, params={"confirmed": False}).status_code == 400
    assert client.delete(url, params={"confirmed": True}).status_code == 200
    assert client.get(f"/api/items/{first['id']}").status_code == 404
    assert all((library / path).is_file() for path in paths)
    assert client.post(f"/api/items/{second['id']}/restore").json() == second
    client.delete(f"/api/items/{second['id']}")
    assert client.delete(f"/api/items/{second['id']}/permanent", params={"confirmed": True}).status_code == 200
    assert all((library / path).is_file() for path in paths)
    assert client.post(f"/api/items/{first['id']}/restore").status_code == 404
    assert client.delete(url, params={"confirmed": True}).status_code == 404


def test_trash_preserves_gallery_receipt_and_restore_does_not_resubmit(tmp_path):
    library = tmp_path / "library"
    client = TestClient(create_app(library_path=library))
    job = client.post("/api/generation-jobs", json={"provider": "manual_upload", "prompt_text": "Original"}).json()
    client.post(f"/api/generation-jobs/{job['id']}/result", files={"file": ("image.png", image_bytes(), "image/png")})
    endpoint = f"/api/generation-jobs/{job['id']}/accept-as-new-item"
    item = client.post(endpoint).json()["item"]
    before = client.get(f"/api/generation-jobs/{job['id']}").json()
    client.delete(f"/api/items/{item['id']}")
    assert client.get(f"/api/generation-jobs/{job['id']}").json() == before
    assert client.post(endpoint).status_code == 409
    assert client.post(f"/api/items/{item['id']}/restore").json() == item
    assert client.get(f"/api/generation-jobs/{job['id']}").json() == before
    with db.connect(library) as conn:
        assert conn.execute("SELECT COUNT(*) FROM generation_jobs").fetchone()[0] == 1
        assert conn.execute("SELECT COUNT(*) FROM gallery_title_jobs").fetchone()[0] == 0


def test_failed_new_acceptance_physically_rolls_back_incomplete_item(tmp_path, monkeypatch):
    library = tmp_path / "library"
    repo = GenerationJobRepository(library)
    job = repo.create_job(GenerationJobCreate(provider="manual_upload", prompt_text="Original"))
    repo.stage_result(job.id, image_bytes(), "image.png")
    def fail_add(*args, **kwargs):
        raise OSError("injected image record failure")
    monkeypatch.setattr(repo.items, "add_image", fail_add)
    with pytest.raises(OSError, match="injected"):
        repo.accept_result_as_new_item(job.id)
    with db.connect(library) as conn:
        assert conn.execute("SELECT COUNT(*) FROM items").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM item_search").fetchone()[0] == 0
    assert repo.get_job(job.id).status == "succeeded"


def test_migration_17_preserves_existing_data_and_runs_once(tmp_path, monkeypatch):
    library = tmp_path / "library"
    with monkeypatch.context() as old:
        old.setattr(db, "MIGRATIONS", db.MIGRATIONS[:16])
        db.init_db(library)
        with db.connect(library) as conn:
            conn.execute("INSERT INTO items(id,title,slug,created_at,updated_at) VALUES ('legacy','Keep me','legacy','then','then')")
            conn.commit()
    db.init_db(library)
    db.init_db(library)
    with db.connect(library) as conn:
        item = conn.execute("SELECT * FROM items WHERE id='legacy'").fetchone()
        assert item["title"] == "Keep me"
        assert item["deleted_at"] is None
        assert conn.execute("SELECT COUNT(*) FROM schema_migrations WHERE version='017_library_trash.sql'").fetchone()[0] == 1


def test_backup_restore_preserves_trash_and_rejects_missing_trash_schema(tmp_path):
    library = tmp_path / "library"
    client = TestClient(create_app(library_path=library))
    before = create_item(client)
    deleted = client.delete(f"/api/items/{before['id']}").json()
    archive = backup_library(library, tmp_path / "backup.tar.gz")
    verify_backup(archive)
    destination = tmp_path / "restored"
    restore_library(archive, destination, confirm=True)
    restored_client = TestClient(create_app(library_path=destination))
    assert restored_client.get("/api/items").json()["total"] == 0
    assert restored_client.get(f"/api/items/{before['id']}").json() == deleted
    assert restored_client.post(f"/api/items/{before['id']}/restore").json() == before
    for image in before["images"]:
        assert (destination / image["original_path"]).read_bytes() == (library / image["original_path"]).read_bytes()
    with db.connect(destination) as conn:
        conn.execute("DROP INDEX idx_items_deleted_at")
        conn.execute("ALTER TABLE items DROP COLUMN deleted_at")
        conn.commit()
    with pytest.raises(LibraryArchiveError, match="items.deleted_at"):
        backup_library(destination, tmp_path / "broken.tar.gz")


def test_permanent_delete_keeps_files_for_upload_waiting_to_add_shared_reference(tmp_path):
    from backend.repositories import StoredImageInput
    from backend.services.image_store import store_image
    library = tmp_path / "library"
    client = TestClient(create_app(library_path=library))
    first = create_item(client)
    target = client.post("/api/items", json={"title": "Pending upload"}).json()
    # Real upload order: store bytes first, then insert the image reference.
    pending = store_image(library, image_bytes(), "orange.png")
    client.delete(f"/api/items/{first['id']}")
    assert client.delete(f"/api/items/{first['id']}/permanent", params={"confirmed": True}).status_code == 200
    repository = ItemRepository(library)
    image = repository.add_image(target["id"], StoredImageInput(
        pending.original_path, pending.thumb_path, pending.preview_path,
        width=pending.width, height=pending.height, file_sha256=pending.file_sha256,
    ))
    assert (library / image.original_path).read_bytes() == image_bytes()
    assert all((library / path).is_file() for path in (image.thumb_path, image.preview_path))
    assert client.get(f"/api/items/{target['id']}").json()["images"][0]["id"] == image.id


def test_restore_winning_before_permanent_delete_final_check_is_not_deleted(tmp_path, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event
    library = tmp_path / "library"
    client = TestClient(create_app(library_path=library))
    item = create_item(client)
    repository = ItemRepository(library)
    repository.delete_item(item["id"])
    read, release = Event(), Event()
    original_get = repository.get_item
    def pause_after_read(*args, **kwargs):
        value = original_get(*args, **kwargs)
        read.set()
        assert release.wait(5)
        return value
    monkeypatch.setattr(repository, "get_item", pause_after_read)
    with ThreadPoolExecutor(max_workers=1) as executor:
        pending = executor.submit(repository.purge_item, item["id"])
        try:
            assert read.wait(5)
            assert ItemRepository(library).restore_item(item["id"]).deleted_at is None
        finally:
            release.set()
        with pytest.raises(ValueError, match="no longer"):
            pending.result(timeout=5)
    assert client.get(f"/api/items/{item['id']}").json() == item


def test_permanent_delete_serializes_restore_after_its_final_check(tmp_path, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from contextlib import contextmanager
    from threading import Event
    import sqlite3
    from backend import repositories
    library = tmp_path / "library"
    client = TestClient(create_app(library_path=library))
    item = create_item(client)
    repository = ItemRepository(library)
    repository.delete_item(item["id"])
    checked, release = Event(), Event()
    real_connect = repositories.connect
    class PausingConnection:
        def __init__(self, connection): self.connection = connection
        def execute(self, sql, *args):
            if sql == "DELETE FROM item_search WHERE item_id=?":
                checked.set()
                assert release.wait(5)
            return self.connection.execute(sql, *args)
        def __getattr__(self, name): return getattr(self.connection, name)
    @contextmanager
    def connect(path):
        with real_connect(path) as connection:
            connection.execute("PRAGMA busy_timeout=0")
            yield PausingConnection(connection)
    monkeypatch.setattr(repositories, "connect", connect)
    with ThreadPoolExecutor(max_workers=1) as executor:
        pending = executor.submit(repository.purge_item, item["id"])
        try:
            assert checked.wait(5)
            # Restore cannot commit between the checked state and DELETE.
            with pytest.raises(sqlite3.OperationalError, match="locked"):
                repository.restore_item(item["id"])
        finally:
            release.set()
        assert pending.result(timeout=5).id == item["id"]
    with pytest.raises(KeyError):
        repository.restore_item(item["id"])


def test_existing_generation_can_be_saved_as_new_after_source_is_trashed(tmp_path):
    library = tmp_path / "library"
    client = TestClient(create_app(library_path=library))
    source = create_item(client)
    reference = source["images"][1]
    with db.connect(library) as conn:
        conn.execute("UPDATE images SET generation_provider='manual_upload',generation_model='synthetic-image' WHERE id=?", (reference["id"],))
        conn.commit()
    payload = {"source_item_id": source["id"], "provider": "manual_upload", "prompt_text": "Keep generated result",
               "parameters": {"input_images": [{"source": "library", "image_id": reference["id"]}]}}
    queued = client.post("/api/generation-jobs", json=payload)
    assert queued.status_code == 200
    job = queued.json()
    assert client.post(f"/api/generation-jobs/{job['id']}/result", files={"file": ("result.png", image_bytes("green"), "image/png")}).status_code == 200
    client.delete(f"/api/items/{source['id']}")
    assert client.post("/api/generation-jobs", json=payload).status_code == 404
    reference_only = {**payload, "source_item_id": None}
    assert client.post("/api/generation-jobs", json=reference_only).status_code == 409
    saved = client.post(f"/api/generation-jobs/{job['id']}/accept-as-new-item")
    assert saved.status_code == 200
    item = saved.json()["item"]
    assert item["id"] != source["id"]
    assert item["prompts"][0]["text"] == "Keep generated result"
    assert [image["role"] for image in item["images"]] == ["result_image", "reference_image"]
    assert item["images"][1]["generation_model"] == "synthetic-image"
    assert (library / item["images"][1]["original_path"]).read_bytes() == image_bytes("blue")
    assert client.get("/api/items").json()["total"] == 1
    assert client.get("/api/items", params={"trashed": True}).json()["total"] == 1
