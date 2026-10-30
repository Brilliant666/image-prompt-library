from concurrent.futures import ThreadPoolExecutor
from io import BytesIO

from fastapi.testclient import TestClient
from PIL import Image
import pytest

from backend import db
from backend.db import init_db
from backend.main import create_app
from backend.services.generation_jobs import GenerationJobRepository


def staged(client, color="orange"):
    prompt = "  Synthetic title test\n\n keep original whitespace  "
    job = client.post("/api/generation-jobs", json={
        "provider": "manual_upload", "model": "synthetic-image",
        "prompt_text": prompt, "prompt_language": "en",
    }).json()
    buf = BytesIO()
    Image.new("RGB", (12, 18), color).save(buf, format="PNG")
    data = buf.getvalue()
    response = client.post(f"/api/generation-jobs/{job['id']}/result",
                           files={"file": ("result.png", data, "image/png")})
    assert response.status_code == 200
    return response.json(), prompt, data


def test_delete_library_item_releases_receipt_and_reaccepts_exact_original(tmp_path):
    library = tmp_path / "library"
    client = TestClient(create_app(library_path=library))
    job, prompt, data = staged(client)
    endpoint = f"/api/generation-jobs/{job['id']}/accept-as-new-item"
    first = client.post(endpoint).json()["item"]
    assert client.post(endpoint).status_code == 409
    assert client.delete(f"/api/items/{first['id']}").status_code == 200
    assert client.delete(f"/api/items/{first['id']}/permanent", params={"confirmed": True}).status_code == 200
    refreshed = client.get(f"/api/generation-jobs/{job['id']}").json()
    assert refreshed["status"] == "succeeded"
    assert refreshed["accepted_image_id"] is None
    assert refreshed["accepted_at"] is None
    assert (library / job["result_path"]).read_bytes() == data
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(lambda _: client.post(endpoint), range(2)))
    assert sorted(response.status_code for response in responses) == [200, 409]
    second = next(response.json()["item"] for response in responses if response.status_code == 200)
    assert second["id"] != first["id"]
    assert second["prompts"][0]["text"] == prompt
    assert (library / second["images"][0]["original_path"]).read_bytes() == data
    assert client.get("/api/items").json()["total"] == 1


def test_remove_only_accepted_image_allows_reaccept_into_existing_item(tmp_path):
    client = TestClient(create_app(library_path=tmp_path / "library"))
    first, _, _ = staged(client)
    item = client.post(f"/api/generation-jobs/{first['id']}/accept-as-new-item").json()["item"]
    second, _, _ = staged(client, "blue")
    saved = client.post(f"/api/generation-jobs/{second['id']}/accept-into-item",
                        json={"item_id": item["id"]}).json()
    removed = saved["job"]["accepted_image_id"]
    keep = [{"id": image["id"], "role": image["role"]} for image in saved["item"]["images"]
            if image["id"] != removed]
    assert client.put(f"/api/items/{item['id']}/images", json={"images": keep}).status_code == 200
    assert client.get(f"/api/generation-jobs/{second['id']}").json()["status"] == "succeeded"
    assert client.get(f"/api/generation-jobs/{first['id']}").json()["status"] == "accepted"
    assert client.post(f"/api/generation-jobs/{second['id']}/accept-into-item",
                       json={"item_id": item["id"]}).status_code == 200


@pytest.mark.parametrize("changed", [False, True])
def test_reaccept_cannot_save_missing_or_modified_staged_result(tmp_path, changed):
    library = tmp_path / "library"
    client = TestClient(create_app(library_path=library))
    job, _, _ = staged(client)
    endpoint = f"/api/generation-jobs/{job['id']}/accept-as-new-item"
    item = client.post(endpoint).json()["item"]
    client.delete(f"/api/items/{item['id']}")
    client.delete(f"/api/items/{item['id']}/permanent", params={"confirmed": True})
    path = library / job["result_path"]
    if changed:
        Image.new("RGB", (12, 18), "blue").save(path, format="PNG")
    else:
        path.unlink()
    assert client.post(endpoint).status_code == 409
    assert client.get("/api/items").json()["total"] == 0


def test_migration_repairs_legacy_deleted_receipt_once(tmp_path):
    library = tmp_path / "library"
    client = TestClient(create_app(library_path=library))
    job, _, _ = staged(client)
    item = GenerationJobRepository(library).accept_result_as_new_item(job["id"]).item
    # Recreate schema 014, before the 015 receipt trigger, including removal of
    # later schema objects. Merely rewinding its ledger does not create an old DB.
    # Current application writes must not be run against an obsolete schema.
    legacy_boundary = db.MIGRATIONS.index('015_generation_reaccept.sql')
    with db.connect(library) as conn:
        conn.execute("DROP INDEX idx_generation_agent_retry_conversation")
        conn.execute("ALTER TABLE agent_conversations DROP COLUMN editing_tasks")
        conn.execute("DROP TABLE agent_frozen_sources")
        conn.execute("DROP INDEX idx_agent_assets_source_kind")
        conn.execute("DROP INDEX idx_items_deleted_at")
        conn.execute("ALTER TABLE items DROP COLUMN deleted_at")
        conn.execute("DROP TABLE gallery_title_jobs")
        conn.execute("DROP TRIGGER generation_image_deleted")
        conn.executemany("DELETE FROM schema_migrations WHERE version=?", [(name,) for name in db.MIGRATIONS[legacy_boundary:]])
        conn.execute("DELETE FROM item_search WHERE item_id=?", (item.id,))
        conn.execute("DELETE FROM items WHERE id=?", (item.id,))
        conn.commit()
        row = conn.execute("SELECT status,accepted_image_id FROM generation_jobs WHERE id=?", (job["id"],)).fetchone()
        assert row["status"] == "accepted"
        assert row["accepted_image_id"] is None
        assert [row[0] for row in conn.execute('SELECT version FROM schema_migrations ORDER BY rowid')] == db.MIGRATIONS[:legacy_boundary]
        assert 'editing_tasks' not in {row[1] for row in conn.execute('PRAGMA table_info(agent_conversations)')}
    init_db(library)
    repaired = client.get(f"/api/generation-jobs/{job['id']}").json()
    assert repaired["status"] == "succeeded"
    assert repaired["accepted_at"] is None
    init_db(library)
    assert client.post(f"/api/generation-jobs/{job['id']}/accept-as-new-item").status_code == 200
