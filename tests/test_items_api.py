import pytest
from fastapi.testclient import TestClient
from io import BytesIO
from PIL import Image
from backend.main import create_app
from backend.db import connect


def client(tmp_path):
    return TestClient(create_app(library_path=tmp_path / "library"))


def png_bytes(size=(32, 24), color=(120, 40, 220)):
    buf = BytesIO()
    Image.new("RGB", size, color).save(buf, format="PNG")
    return buf.getvalue()


def create_payload(**overrides):
    payload = {
        "title": "Dream Glass Teahouse",
        "model": "ChatGPT Image2",
        "cluster_name": "Architecture",
        "tags": ["glass", "vista"],
        "prompts": [
            {"language": "zh_hant", "text": "夢幻玻璃茶室，晨光穿過霧氣", "is_primary": True},
            {"language": "en", "text": "A dreamy glass teahouse in morning mist"},
        ],
        "source_name": "fixture",
        "source_url": "https://example.test/item",
    }
    payload.update(overrides)
    return payload


def test_api_rejects_explicit_prompt_provenance_without_exactly_one_original(tmp_path):
    c = client(tmp_path)
    zero_original = create_payload(prompts=[
        {"language": "en", "text": "English prompt", "is_original": False, "provenance": {"kind": "manual"}},
        {"language": "zh_hant", "text": "中文 prompt", "is_original": False, "provenance": {"kind": "manual"}},
    ])
    multiple_originals = create_payload(prompts=[
        {"language": "en", "text": "English prompt", "is_original": True, "provenance": {"kind": "manual"}},
        {"language": "zh_hant", "text": "中文 prompt", "is_original": True, "provenance": {"kind": "manual"}},
    ])

    assert c.post("/api/items", json=zero_original).status_code == 400
    assert c.post("/api/items", json=multiple_originals).status_code == 400


def test_item_prompt_provenance_redacts_credentials_on_create_and_update(tmp_path):
    c = client(tmp_path)
    created = c.post("/api/items", json=create_payload(prompts=[{
        "language": "en",
        "text": "Safe prompt text with access_token=example as ordinary content",
        "is_primary": True,
        "is_original": True,
        "provenance": {
            "kind": "manual",
            "note": "access_token=create-canary",
            "safe_note": "authorization settings are managed outside the library",
        },
    }]))

    assert created.status_code == 200
    item = created.json()
    prompt = item["prompts"][0]
    assert "access_token=example" in prompt["text"]
    assert prompt["provenance"]["note"] == "[redacted credential data]"
    assert prompt["provenance"]["safe_note"] == "authorization settings are managed outside the library"

    updated = c.patch(f"/api/items/{item['id']}", json={"prompts": [{
        "language": "en",
        "text": prompt["text"],
        "is_primary": True,
        "is_original": True,
        "provenance": {"kind": "manual", "note": "client_secret=update-canary"},
    }]})

    assert updated.status_code == 200
    updated_prompt = updated.json()["prompts"][0]
    assert updated_prompt["provenance"]["note"] == "[redacted credential data]"
    with connect(tmp_path / "library") as conn:
        stored = conn.execute("SELECT provenance FROM prompts WHERE item_id=?", (item["id"],)).fetchone()[0]
    assert "create-canary" not in stored
    assert "update-canary" not in stored

    created = c.post("/api/items", json=create_payload(prompts=[
        {"language": "en", "text": "English prompt", "is_original": True, "provenance": {"kind": "manual"}},
        {"language": "zh_hant", "text": "中文 prompt", "is_original": False, "provenance": {"kind": "manual"}},
    ])).json()
    assert sum(1 for prompt in created["prompts"] if prompt["is_original"]) == 1


def test_item_api_redacts_legacy_prompt_provenance_without_rewriting_prompt_text(tmp_path):
    c = client(tmp_path)
    item = c.post("/api/items", json=create_payload(prompts=[{
        "language": "en",
        "text": "Render UI label accessToken=example",
        "is_primary": True,
        "is_original": True,
        "provenance": {"kind": "manual"},
    }])).json()
    with connect(tmp_path / "library") as conn:
        conn.execute(
            "UPDATE prompts SET provenance=? WHERE item_id=?",
            (
                '{"accessToken":"legacy-canary","auth_mode":"codex_oauth_native",'
                '"nested_note":{"message":"clientSecret=legacy-nested-canary"},"safe":"kept"}',
                item["id"],
            ),
        )
        conn.commit()

    detail_prompt = c.get(f"/api/items/{item['id']}").json()["prompts"][0]
    listed_prompt = c.get("/api/items").json()["items"][0]["prompts"][0]

    for prompt in (detail_prompt, listed_prompt):
        assert prompt["text"] == "Render UI label accessToken=example"
        assert prompt["provenance"] == {
            "auth_mode": "codex_oauth_native",
            "nested_note": {"message": "[redacted credential data]"},
            "safe": "kept",
        }


def test_template_tag_is_derived_from_prompt_variables_on_create_and_update(tmp_path):
    c = client(tmp_path)
    created = c.post("/api/items", json=create_payload(
        tags=["glass", "template"],
        prompts=[{"language": "en", "text": "Portrait of {{主體}} in {{ style }}", "is_primary": True}],
    )).json()
    assert {tag["name"] for tag in created["tags"]} == {"glass", "template"}
    assert c.get("/api/items", params={"tag": "template"}).json()["total"] == 1

    removed = c.patch(f"/api/items/{created['id']}", json={
        "tags": ["glass", "template"],
        "prompts": [{"language": "en", "text": "Portrait without variables", "is_primary": True, "is_original": True}],
    }).json()
    assert {tag["name"] for tag in removed["tags"]} == {"glass"}
    assert c.get("/api/items", params={"tag": "template"}).json()["total"] == 0

    added = c.patch(f"/api/items/{created['id']}", json={
        "tags": ["glass"],
        "prompts": [{"language": "en", "text": r"Literal \{{ignored}} but real {{subject}}", "is_primary": True, "is_original": True}],
    }).json()
    assert {tag["name"] for tag in added["tags"]} == {"glass", "template"}


def test_template_tag_ignores_escaped_empty_and_nested_placeholders(tmp_path):
    c = client(tmp_path)
    created = c.post("/api/items", json=create_payload(
        tags=["template"],
        prompts=[{"language": "en", "text": r"Literal \{{ignored}} empty {{   }} nested {{a{{b}}}", "is_primary": True}],
    )).json()
    assert {tag["name"] for tag in created["tags"]} == set()


def test_create_get_search_and_filter_item(tmp_path):
    c = client(tmp_path)
    created = c.post("/api/items", json=create_payload()).json()
    assert created["title"] == "Dream Glass Teahouse"
    assert created["cluster"]["name"] == "Architecture"
    assert {t["name"] for t in created["tags"]} == {"glass", "vista"}

    detail = c.get(f"/api/items/{created['id']}").json()
    assert len(detail["prompts"]) == 2
    listed = c.get("/api/items").json()["items"][0]
    assert {p["language"]: p["text"] for p in listed["prompts"]} == {
        "zh_hant": "夢幻玻璃茶室，晨光穿過霧氣",
        "en": "A dreamy glass teahouse in morning mist",
    }

    assert c.get("/api/items", params={"q": "Teahouse"}).json()["total"] == 1
    assert c.get("/api/items", params={"q": "玻璃茶室"}).json()["total"] == 1
    assert c.get("/api/items", params={"q": "morning mist"}).json()["total"] == 1
    assert c.get("/api/items", params={"tag": "vista"}).json()["total"] == 1
    assert c.get("/api/items", params={"cluster": created["cluster"]["id"]}).json()["total"] == 1


def test_item_list_sorts_by_created_and_title_without_rating_ui(tmp_path):
    c = client(tmp_path)
    alpha = c.post("/api/items", json=create_payload(title="Alpha Sort", source_url="https://example.test/alpha")).json()
    zebra = c.post("/api/items", json=create_payload(title="Zebra Sort", source_url="https://example.test/zebra")).json()
    beta = c.post("/api/items", json=create_payload(title="Beta Sort", source_url="https://example.test/beta")).json()
    with connect(tmp_path / "library") as conn:
        conn.execute("UPDATE items SET created_at=?, updated_at=? WHERE id=?", ("2026-01-01T00:00:00+00:00", "2026-01-04T00:00:00+00:00", alpha["id"]))
        conn.execute("UPDATE items SET created_at=?, updated_at=? WHERE id=?", ("2026-01-03T00:00:00+00:00", "2026-01-02T00:00:00+00:00", zebra["id"]))
        conn.execute("UPDATE items SET created_at=?, updated_at=? WHERE id=?", ("2026-01-02T00:00:00+00:00", "2026-01-03T00:00:00+00:00", beta["id"]))
        conn.commit()

    assert [item["title"] for item in c.get("/api/items", params={"sort": "updated_desc"}).json()["items"]] == ["Alpha Sort", "Beta Sort", "Zebra Sort"]
    assert [item["title"] for item in c.get("/api/items", params={"sort": "created_desc"}).json()["items"]] == ["Zebra Sort", "Beta Sort", "Alpha Sort"]
    assert [item["title"] for item in c.get("/api/items", params={"sort": "title_asc"}).json()["items"]] == ["Alpha Sort", "Beta Sort", "Zebra Sort"]


def test_structured_query_filters_keywords_and_has_filters(tmp_path):
    c = client(tmp_path)
    library = tmp_path / "library"
    apple = c.post("/api/items", json=create_payload(
        title="Apple Package",
        cluster_name="Packaging",
        tags=["template", "fruit"],
        prompts=[{"language": "en", "text": "Apple {{package}}", "is_primary": True}],
        model="gpt-image-2",
        source_name="awesome-gpt-image-2",
        source_url="https://example.test/apple",
    )).json()
    poster = c.post("/api/items", json=create_payload(
        title="Poster Study",
        cluster_name="Poster",
        tags=["poster"],
        model="other-model",
        source_name="manual",
        source_url="https://example.test/poster",
    )).json()
    c.post(
        f"/api/items/{apple['id']}/images",
        data={"role": "result_image"},
        files={"file": ("result.png", png_bytes(), "image/png")},
    )
    c.post(
        f"/api/items/{poster['id']}/images",
        data={"role": "reference_image"},
        files={"file": ("reference.png", png_bytes(color=(1, 2, 3)), "image/png")},
    )
    with connect(library) as conn:
        conn.execute("UPDATE items SET created_at=?, updated_at=? WHERE id=?", ("2000-01-01T01:00:00+00:00", "2000-01-01T02:00:00+00:00", poster["id"]))
        conn.commit()

    assert c.get("/api/items", params={"q": "tag:template apple"}).json()["total"] == 1
    assert c.get("/api/items", params={"q": "collection:Packaging apple"}).json()["total"] == 1
    assert c.get("/api/items", params={"q": "model:gpt-image-2 source:awesome apple"}).json()["total"] == 1
    assert c.get("/api/items", params={"q": "created:30d apple"}).json()["total"] == 1
    assert c.get("/api/items", params={"q": "has:result apple"}).json()["total"] == 1
    assert c.get("/api/items", params={"q": "has:prompt apple"}).json()["total"] == 1
    assert c.get("/api/items", params={"q": "has:reference apple"}).json()["total"] == 0
    assert c.get("/api/items", params={"q": "creator:edward apple"}).json()["total"] == 0


def test_extended_item_sort_modes(tmp_path):
    c = client(tmp_path)
    alpha = c.post("/api/items", json=create_payload(title="Alpha Sort", model="Model B", source_name="Source B", source_url="https://example.test/alpha")).json()
    beta = c.post("/api/items", json=create_payload(title="Beta Sort", model="Model A", source_name="Source C", source_url="https://example.test/beta")).json()
    gamma = c.post("/api/items", json=create_payload(title="Gamma Sort", model="Model C", source_name="Source A", source_url="https://example.test/gamma")).json()
    with connect(tmp_path / "library") as conn:
        conn.execute("UPDATE items SET created_at=?, updated_at=? WHERE id=?", ("2026-01-01T00:00:00+00:00", "2026-01-04T00:00:00+00:00", alpha["id"]))
        conn.execute("UPDATE items SET created_at=?, updated_at=? WHERE id=?", ("2026-01-02T00:00:00+00:00", "2026-01-03T00:00:00+00:00", beta["id"]))
        conn.execute("UPDATE items SET created_at=?, updated_at=? WHERE id=?", ("2026-01-03T00:00:00+00:00", "2026-01-02T00:00:00+00:00", gamma["id"]))
        conn.commit()

    assert [item["title"] for item in c.get("/api/items", params={"sort": "created_asc"}).json()["items"]] == ["Alpha Sort", "Beta Sort", "Gamma Sort"]
    assert [item["title"] for item in c.get("/api/items", params={"sort": "title_desc"}).json()["items"]] == ["Gamma Sort", "Beta Sort", "Alpha Sort"]
    assert [item["title"] for item in c.get("/api/items", params={"sort": "source_asc"}).json()["items"]] == ["Gamma Sort", "Alpha Sort", "Beta Sort"]
    assert [item["title"] for item in c.get("/api/items", params={"sort": "model_asc"}).json()["items"]] == ["Beta Sort", "Alpha Sort", "Gamma Sort"]


def test_items_list_limit_allows_gallery_overview_scale(tmp_path):
    c = client(tmp_path)
    for idx in range(230):
        c.post("/api/items", json=create_payload(title=f"Overview Item {idx}", cluster_name=f"Cluster {idx % 7}"))
    listed = c.get("/api/items", params={"limit": 300}).json()
    assert listed["total"] == 230
    assert listed["limit"] == 300
    assert len(listed["items"]) == 230


def test_batch_archive_favorite_tag_and_move_items(tmp_path):
    c = client(tmp_path)
    first = c.post("/api/items", json=create_payload(title="Batch One", source_url="https://example.test/batch-one")).json()
    second = c.post("/api/items", json=create_payload(title="Batch Two", source_url="https://example.test/batch-two")).json()

    archived = c.post("/api/items/batch", json={"item_ids": [first["id"], second["id"]], "action": "archive"}).json()
    assert archived["requested"] == 2
    assert archived["changed"] == 2
    assert c.get("/api/items").json()["total"] == 0
    assert c.get("/api/items", params={"q": "archived:true"}).json()["total"] == 2
    assert c.get("/api/items", params={"archived": True}).json()["total"] == 2

    unarchived = c.post("/api/items/batch", json={"item_ids": [first["id"], second["id"]], "action": "unarchive"}).json()
    assert unarchived["changed"] == 2
    assert c.get("/api/items").json()["total"] == 2

    favorite = c.post("/api/items/batch", json={"item_ids": [first["id"], second["id"]], "action": "favorite"}).json()
    assert favorite["changed"] == 2
    assert c.get("/api/items", params={"favorite": True}).json()["total"] == 2

    tagged = c.post("/api/items/batch", json={"item_ids": [first["id"], second["id"]], "action": "add_tags", "tags": ["batch", "cleanup"]}).json()
    assert tagged["changed"] == 2
    assert c.get("/api/items", params={"q": "tag:batch"}).json()["total"] == 2

    moved = c.post("/api/items/batch", json={"item_ids": [first["id"], second["id"]], "action": "move_collection", "cluster_name": "Batch Review"}).json()
    assert moved["changed"] == 2
    assert c.get("/api/items", params={"q": "collection:Batch"}).json()["total"] == 2

    removed = c.post("/api/items/batch", json={"item_ids": [first["id"], second["id"]], "action": "remove_tags", "tags": ["cleanup"]}).json()
    assert removed["changed"] == 2
    assert c.get("/api/items", params={"q": "tag:cleanup"}).json()["total"] == 0

    assert c.post("/api/items/batch", json={"item_ids": [first["id"]], "action": "add_tags"}).status_code == 400
    assert c.post("/api/items/batch", json={"item_ids": [first["id"]], "action": "move_collection"}).status_code == 400
    assert c.post("/api/items/batch", json={"item_ids": [first["id"]], "action": "move_collection", "cluster_name": "   "}).status_code == 400
    assert c.post("/api/items/batch", json={"item_ids": [first["id"]], "action": "move_collection", "cluster_id": "clu_missing"}).status_code == 400


def test_batch_delete_uses_server_side_delete_and_reports_missing_items(tmp_path):
    c = client(tmp_path)
    library = tmp_path / "library"
    item = c.post("/api/items", json=create_payload(title="Batch Delete")).json()
    uploaded = c.post(
        f"/api/items/{item['id']}/images",
        data={"role": "result_image"},
        files={"file": ("result.png", png_bytes(), "image/png")},
    ).json()
    stored_paths = [library / uploaded[key] for key in ("original_path", "thumb_path", "preview_path")]
    result = c.post("/api/items/batch", json={"item_ids": [item["id"], "missing"], "action": "delete"}).json()

    assert result["requested"] == 2
    assert result["changed"] == 1
    assert result["failed"] == 1
    assert "missing" in result["errors"]
    assert c.get("/api/items").json()["total"] == 0
    assert all(path.exists() for path in stored_paths)
    assert c.get("/api/items", params={"trashed": True}).json()["total"] == 1


def test_patch_favorite_and_delete_item(tmp_path):
    c = client(tmp_path)
    library = tmp_path / "library"
    created = c.post("/api/items", json=create_payload()).json()
    uploaded = c.post(
        f"/api/items/{created['id']}/images",
        data={"role": "result_image"},
        files={"file": ("result.png", png_bytes(), "image/png")},
    ).json()
    stored_paths = [library / uploaded[key] for key in ("original_path", "thumb_path", "preview_path")]
    assert all(path.exists() for path in stored_paths)

    patched = c.patch(f"/api/items/{created['id']}", json={"title": "Updated", "favorite": True, "rating": 4}).json()
    assert patched["title"] == "Updated"
    assert patched["favorite"] is True
    assert patched["rating"] == 4
    toggled = c.post(f"/api/items/{created['id']}/favorite").json()
    assert toggled["favorite"] is False

    deleted = c.delete(f"/api/items/{created['id']}").json()
    assert deleted["id"] == created["id"]
    assert deleted["deleted_at"]
    assert all(path.exists() for path in stored_paths)
    assert c.delete(f"/api/items/{created['id']}/permanent", params={"confirmed": True}).status_code == 200
    assert c.get(f"/api/items/{created['id']}").status_code == 404
    assert c.get("/api/items").json()["total"] == 0
    assert c.get("/api/items", params={"archived": True}).json()["total"] == 0
    assert c.get("/api/clusters").json() == []
    assert all(path.exists() for path in stored_paths)
    with connect(library) as conn:
        assert conn.execute("SELECT COUNT(*) FROM items WHERE id=?", (created["id"],)).fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM images WHERE item_id=?", (created["id"],)).fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM prompts WHERE item_id=?", (created["id"],)).fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM item_tags WHERE item_id=?", (created["id"],)).fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM item_search WHERE item_id=?", (created["id"],)).fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM clusters").fetchone()[0] == 0
    assert {tag["name"]: tag["count"] for tag in c.get("/api/tags").json()} == {"glass": 0, "vista": 0}


def test_cross_origin_browser_writes_are_rejected_without_mutating_the_library(tmp_path):
    c = client(tmp_path)

    blocked = c.post(
        "/api/items",
        json=create_payload(title="Blocked cross-origin write"),
        headers={"Origin": "https://example.invalid", "Sec-Fetch-Site": "cross-site"},
    )
    blocked_null_origin = c.post(
        "/api/items",
        json=create_payload(title="Blocked opaque origin write"),
        headers={"Origin": "null"},
    )

    assert blocked.status_code == 403
    assert blocked_null_origin.status_code == 403
    assert c.get("/api/items").json()["total"] == 0


@pytest.mark.parametrize(
    ("base_url", "headers"),
    (
        ("http://testserver", {"Origin": "http://testserver", "Sec-Fetch-Site": "same-origin"}),
        ("http://192.168.1.25:8000", {"Origin": "http://192.168.1.25:8000", "Sec-Fetch-Site": "same-origin"}),
        ("http://testserver", {"Origin": "http://127.0.0.1:5177", "Sec-Fetch-Site": "cross-site"}),
        ("http://testserver", {}),
    ),
)
def test_supported_same_origin_dev_and_cli_writes_remain_available(tmp_path, base_url, headers):
    c = TestClient(create_app(library_path=tmp_path / "library"), base_url=base_url)

    created = c.post("/api/items", json=create_payload(title="Allowed write"), headers=headers)

    assert created.status_code == 200
    assert c.get("/api/items").json()["total"] == 1


def test_configured_development_origin_can_write_without_weakening_other_origins(tmp_path, monkeypatch):
    monkeypatch.setenv("IMAGE_PROMPT_LIBRARY_DEVELOPMENT_ORIGINS", "http://127.0.0.1:5178")
    c = TestClient(create_app(library_path=tmp_path / "library"), base_url="http://testserver")

    allowed = c.post(
        "/api/items",
        json=create_payload(title="Allowed preview write"),
        headers={"Origin": "http://127.0.0.1:5178", "Sec-Fetch-Site": "cross-site"},
    )
    blocked = c.post(
        "/api/items",
        json=create_payload(title="Blocked unrelated write"),
        headers={"Origin": "http://127.0.0.1:5179", "Sec-Fetch-Site": "cross-site"},
    )

    assert allowed.status_code == 200
    assert blocked.status_code == 403
    assert c.get("/api/items").json()["total"] == 1


@pytest.mark.parametrize("host", ["evil.example:8000", "localhost.evil.example", "127.0.0.1.evil.example", "localhost@evil.example", "localhost/path", "localhost\\evil.example"])
@pytest.mark.parametrize("path", ["/api/items", "/api/health", "/media/originals/test.png", "/"])
def test_unknown_hosts_cannot_read_or_write_even_with_matching_origin(tmp_path, host, path):
    c = client(tmp_path)
    headers = {"Host": host, "Origin": f"http://{host}"}
    assert c.get(path, headers=headers).status_code == 400
    assert c.post("/api/items", json=create_payload(), headers=headers).status_code == 400
    headers["Origin"] = "http://127.0.0.1:5177"
    assert c.post("/api/items", json=create_payload(), headers=headers).status_code == 400
    assert c.get("/api/items").json()["total"] == 0


@pytest.mark.parametrize("host", ["localhost:8000", "LOCALHOST.:8000", "127.0.0.1:8000", "192.168.1.25:8000", "[::1]:8000", "[fd12::1]:8000"])
def test_local_and_literal_ip_hosts_remain_available(tmp_path, host):
    c = client(tmp_path)
    assert c.get("/api/health", headers={"Host": host}).status_code == 200
    assert c.post("/api/items", json=create_payload(), headers={"Host": host, "Origin": f"http://{host}"}).status_code == 200


def test_custom_hostname_is_explicit_and_exact(tmp_path, monkeypatch):
    monkeypatch.setenv("IMAGE_PROMPT_LIBRARY_ALLOWED_HOSTS", "library.home")
    c = client(tmp_path)
    assert c.get("/api/health", headers={"Host": "library.home:8000"}).status_code == 200
    assert c.get("/api/health", headers={"Host": "other.library.home:8000"}).status_code == 400
    assert c.get("/api/health", headers={"Host": "testserver"}).status_code == 400


def test_production_host_defaults_without_test_configuration(tmp_path, monkeypatch):
    monkeypatch.delenv("IMAGE_PROMPT_LIBRARY_ALLOWED_HOSTS", raising=False)
    c = client(tmp_path)
    for host in ("localhost:8000", "127.0.0.1:8000", "192.168.1.25:8000", "[::1]:8000"):
        assert c.get("/api/health", headers={"Host": host}).status_code == 200
    for host in ("testserver", "evil.example", ""):
        assert c.get("/api/health", headers={"Host": host}).status_code == 400


@pytest.mark.parametrize("configured", ["*", "*.home", "http://library.home", "library.home:8000"])
def test_invalid_allowed_hostname_configuration_fails_closed(tmp_path, monkeypatch, configured):
    monkeypatch.setenv("IMAGE_PROMPT_LIBRARY_ALLOWED_HOSTS", configured)
    with pytest.raises(ValueError, match="exact hostnames"):
        create_app(library_path=tmp_path / "library")


def test_duplicate_host_headers_are_rejected(tmp_path):
    c = client(tmp_path)
    assert c.get("/api/health", headers=[("Host", "localhost"), ("Host", "evil.example")]).status_code == 400


def test_deleting_item_keeps_media_files_still_used_by_another_item(tmp_path):
    c = client(tmp_path)
    library = tmp_path / "library"
    first = c.post("/api/items", json=create_payload(title="Shared Media A")).json()
    second = c.post("/api/items", json=create_payload(title="Shared Media B")).json()
    first_image = c.post(
        f"/api/items/{first['id']}/images",
        data={"role": "result_image"},
        files={"file": ("shared.png", png_bytes(), "image/png")},
    ).json()
    second_image = c.post(
        f"/api/items/{second['id']}/images",
        data={"role": "result_image"},
        files={"file": ("shared.png", png_bytes(), "image/png")},
    ).json()
    assert first_image["original_path"] == second_image["original_path"]
    stored_paths = [library / first_image[key] for key in ("original_path", "thumb_path", "preview_path")]

    assert c.delete(f"/api/items/{first['id']}").status_code == 200

    assert all(path.exists() for path in stored_paths)
    assert c.get(f"/api/items/{second['id']}").status_code == 200


def test_clusters_tags_and_config(tmp_path):
    c = client(tmp_path)
    item = c.post("/api/items", json=create_payload()).json()
    clusters = c.get("/api/clusters").json()
    assert clusters[0]["name"] == "Architecture"
    assert clusters[0]["count"] == 1
    tags = c.get("/api/tags").json()
    assert {t["name"] for t in tags} >= {"glass", "vista"}
    cfg = c.get("/api/config").json()
    assert cfg["database_path"].endswith("db.sqlite")
    assert c.get("/api/health").json()["ok"] is True


def test_media_route_does_not_expose_database(tmp_path):
    c = client(tmp_path)
    c.post("/api/items", json=create_payload())
    assert c.get("/media/db.sqlite").status_code == 404


def test_media_route_does_not_follow_allowed_dir_symlink_to_database(tmp_path):
    c = client(tmp_path)
    c.post("/api/items", json=create_payload())
    library = tmp_path / "library"
    leak = library / "originals" / "leak"
    leak.parent.mkdir(parents=True, exist_ok=True)
    try:
        leak.symlink_to(library / "db.sqlite")
    except (OSError, NotImplementedError) as exc:
        pytest.skip(f"symlink creation is not available: {exc}")
    assert c.get("/media/originals/leak").status_code == 404


def test_punctuation_only_search_does_not_error(tmp_path):
    c = client(tmp_path)
    c.post("/api/items", json=create_payload())
    response = c.get("/api/items", params={"q": '"'})
    assert response.status_code == 200
    assert response.json()["total"] == 0


def test_missing_item_mutations_return_404(tmp_path):
    c = client(tmp_path)
    assert c.delete("/api/items/missing").status_code == 404
    assert c.post("/api/items/missing/favorite").status_code == 404
    assert c.patch("/api/items/missing", json={"tags": ["ghost"]}).status_code == 404
    assert c.patch("/api/items/missing", json={"prompts": [{"language": "en", "text": "ghost"}]}).status_code == 404


def test_upload_to_missing_item_returns_404_without_orphan_files(tmp_path):
    c = client(tmp_path)
    response = c.post("/api/items/missing/images", files={"file": ("sample.png", b"not an image", "image/png")})
    assert response.status_code == 404
    library = tmp_path / "library"
    assert not [p for name in ("originals", "thumbs", "previews") if (library / name).exists() for p in (library / name).rglob("*")]


def test_image_upload_persists_result_and_reference_roles(tmp_path):
    c = client(tmp_path)
    item = c.post("/api/items", json=create_payload()).json()
    result = c.post(
        f"/api/items/{item['id']}/images",
        data={"role": "result_image"},
        files={"file": ("result.png", png_bytes(), "image/png")},
    )
    reference = c.post(
        f"/api/items/{item['id']}/images",
        data={"role": "reference_image"},
        files={"file": ("reference.png", png_bytes(color=(1, 2, 3)), "image/png")},
    )
    invalid = c.post(
        f"/api/items/{item['id']}/images",
        data={"role": "other"},
        files={"file": ("other.png", png_bytes(color=(4, 5, 6)), "image/png")},
    )
    detail = c.get(f"/api/items/{item['id']}").json()
    assert result.status_code == 200
    assert reference.status_code == 200
    assert invalid.status_code == 400
    assert [image["role"] for image in detail["images"]] == ["result_image", "reference_image"]


def test_result_image_is_primary_even_when_reference_uploaded_first(tmp_path):
    c = client(tmp_path)
    item = c.post("/api/items", json=create_payload()).json()
    reference = c.post(
        f"/api/items/{item['id']}/images",
        data={"role": "reference_image"},
        files={"file": ("reference.png", png_bytes(color=(1, 2, 3)), "image/png")},
    ).json()
    result = c.post(
        f"/api/items/{item['id']}/images",
        data={"role": "result_image"},
        files={"file": ("result.png", png_bytes(color=(4, 5, 6)), "image/png")},
    ).json()

    listed = c.get("/api/items").json()["items"][0]
    detail = c.get(f"/api/items/{item['id']}").json()
    cluster = c.get("/api/clusters").json()[0]

    assert reference["role"] == "reference_image"
    assert result["role"] == "result_image"
    assert listed["first_image"]["id"] == result["id"]
    assert detail["first_image"]["id"] == result["id"]
    assert detail["images"][0]["id"] == result["id"]
    assert cluster["preview_images"] == [result["thumb_path"]]
    assert cluster["preview_item_ids"] == [item["id"]]


def test_item_images_can_be_reordered_reclassified_and_removed_atomically(tmp_path):
    c = client(tmp_path)
    library = tmp_path / "library"
    item = c.post("/api/items", json=create_payload()).json()
    first = c.post(
        f"/api/items/{item['id']}/images",
        data={"role": "result_image"},
        files={"file": ("first.png", png_bytes(color=(1, 2, 3)), "image/png")},
    ).json()
    removed = c.post(
        f"/api/items/{item['id']}/images",
        data={"role": "result_image"},
        files={"file": ("removed.png", png_bytes(color=(4, 5, 6)), "image/png")},
    ).json()
    primary = c.post(
        f"/api/items/{item['id']}/images",
        data={"role": "result_image"},
        files={"file": ("primary.png", png_bytes(color=(7, 8, 9)), "image/png")},
    ).json()
    reference = c.post(
        f"/api/items/{item['id']}/images",
        data={"role": "reference_image"},
        files={"file": ("reference.png", png_bytes(color=(10, 11, 12)), "image/png")},
    ).json()

    response = c.put(f"/api/items/{item['id']}/images", json={"images": [
        {"id": primary["id"], "role": "result_image"},
        {"id": first["id"], "role": "reference_image"},
        {"id": reference["id"], "role": "reference_image"},
    ]})

    assert response.status_code == 200
    detail = response.json()
    assert [image["id"] for image in detail["images"]] == [primary["id"], first["id"], reference["id"]]
    assert [image["role"] for image in detail["images"]] == ["result_image", "reference_image", "reference_image"]
    assert detail["first_image"]["id"] == primary["id"]
    assert not (library / removed["original_path"]).exists()
    assert not (library / removed["thumb_path"]).exists()
    assert not (library / removed["preview_path"]).exists()


def test_item_images_must_keep_one_result_and_belong_to_the_item(tmp_path):
    c = client(tmp_path)
    item = c.post("/api/items", json=create_payload()).json()
    other = c.post("/api/items", json=create_payload(title="Other item")).json()
    result = c.post(
        f"/api/items/{item['id']}/images",
        data={"role": "result_image"},
        files={"file": ("result.png", png_bytes(), "image/png")},
    ).json()
    other_result = c.post(
        f"/api/items/{other['id']}/images",
        data={"role": "result_image"},
        files={"file": ("other.png", png_bytes(color=(1, 2, 3)), "image/png")},
    ).json()

    no_result = c.put(f"/api/items/{item['id']}/images", json={"images": [
        {"id": result["id"], "role": "reference_image"},
    ]})
    wrong_item = c.put(f"/api/items/{item['id']}/images", json={"images": [
        {"id": other_result["id"], "role": "result_image"},
    ]})

    assert no_result.status_code == 400
    assert wrong_item.status_code == 400
    detail = c.get(f"/api/items/{item['id']}").json()
    assert [(image["id"], image["role"]) for image in detail["images"]] == [(result["id"], "result_image")]


def test_cluster_preview_item_ids_disambiguate_deduplicated_image_paths(tmp_path):
    c = client(tmp_path)
    first = c.post("/api/items", json=create_payload(title="First shared image")).json()
    second = c.post("/api/items", json=create_payload(title="Second shared image")).json()
    shared = png_bytes(color=(8, 9, 10))
    first_image = c.post(
        f"/api/items/{first['id']}/images",
        files={"file": ("shared-first.png", shared, "image/png")},
    ).json()
    second_image = c.post(
        f"/api/items/{second['id']}/images",
        files={"file": ("shared-second.png", shared, "image/png")},
    ).json()

    cluster = c.get("/api/clusters").json()[0]

    assert first_image["thumb_path"] == second_image["thumb_path"]
    assert cluster["preview_images"] == [first_image["thumb_path"], second_image["thumb_path"]]
    assert set(cluster["preview_item_ids"]) == {first["id"], second["id"]}


def test_editing_last_item_out_of_collection_removes_empty_collection(tmp_path):
    c = client(tmp_path)
    created = c.post("/api/items", json=create_payload(cluster_name="Old Collection")).json()
    assert [cluster["name"] for cluster in c.get("/api/clusters").json()] == ["Old Collection"]

    patched = c.patch(f"/api/items/{created['id']}", json={"cluster_name": "New Collection"}).json()

    assert patched["cluster"]["name"] == "New Collection"
    assert [cluster["name"] for cluster in c.get("/api/clusters").json()] == ["New Collection"]
    with connect(tmp_path / "library") as conn:
        assert conn.execute("SELECT name FROM clusters").fetchall()[0]["name"] == "New Collection"


@pytest.mark.parametrize("clear_fields", [[], ["model"], ["source_url"], ["notes"], ["model", "source_url", "notes"]])
def test_item_metadata_clear_round_trip_preserves_other_fields_and_originals(tmp_path, clear_fields):
    c = client(tmp_path)
    library = tmp_path / "library"
    original_prompt = "  Synthetic original prompt\r\nKeep whitespace.\n\t "
    created = c.post("/api/items", json=create_payload(
        notes="Saved note", author="Synthetic author", favorite=True, rating=4,
        prompts=[{"language": "en", "text": original_prompt, "is_primary": True, "is_original": True}],
    )).json()
    item_id = created["id"]
    original_files = []
    for role, color in [("result_image", (120, 40, 220)), ("reference_image", (1, 2, 3))]:
        content = png_bytes(color=color)
        uploaded = c.post(f"/api/items/{item_id}/images", data={"role": role},
                          files={"file": (f"{role}.png", content, "image/png")})
        assert uploaded.status_code == 200
        original_files.append((library / uploaded.json()["original_path"], content))
    before = c.get(f"/api/items/{item_id}").json()
    cleared = {"model": "", "source_url": None, "notes": None}
    response = c.patch(f"/api/items/{item_id}", json={field: cleared[field] for field in clear_fields})
    assert response.status_code == 200
    persisted = c.get(f"/api/items/{item_id}").json()
    for field in ("title", "model", "source_name", "source_url", "notes", "author", "favorite", "rating", "archived", "cluster", "tags", "prompts", "images"):
        expected = cleared[field] if field in clear_fields else before[field]
        assert response.json()[field] == expected
        assert persisted[field] == expected
    assert persisted["prompts"][0]["text"] == original_prompt
    for path, content in original_files:
        assert path.read_bytes() == content


@pytest.mark.parametrize("collection_edit", ["omitted", "same_id", "other_id", "clear", "new_name"])
def test_item_collection_edit_contract_preserves_original_assets(tmp_path, collection_edit):
    c = client(tmp_path)
    library = tmp_path / "library"
    original_prompt = "  Synthetic portrait prompt\r\nKeep original whitespace.\n\t "
    created = c.post("/api/items", json=create_payload(
        cluster_name="Source collection",
        prompts=[{"language": "en", "text": original_prompt, "is_primary": True, "is_original": True}],
    )).json()
    source_id = created["cluster"]["id"]
    c.post("/api/items", json=create_payload(title="Keep source collection", cluster_id=source_id))
    target = c.post("/api/items", json=create_payload(title="Target member", cluster_name="Target collection")).json()
    target_id = target["cluster"]["id"]
    with connect(library) as conn:
        conn.execute("UPDATE clusters SET names=? WHERE id=?", ('{"zh_hans":"人物"}', source_id))
        conn.execute("UPDATE clusters SET names=? WHERE id=?", ('{"zh_hans":"环境人像"}', target_id))
        conn.commit()

    original_files = []
    for role, color in [("result_image", (120, 40, 220)), ("reference_image", (1, 2, 3))]:
        content = png_bytes(color=color)
        uploaded = c.post(
            f"/api/items/{created['id']}/images",
            data={"role": role},
            files={"file": (f"{role}.png", content, "image/png")},
        )
        assert uploaded.status_code == 200
        original_files.append((library / uploaded.json()["original_path"], content))
    before = c.get(f"/api/items/{created['id']}").json()
    assert next(prompt for prompt in before["prompts"] if prompt["is_original"])["text"] == original_prompt

    collection_payloads = {
        "omitted": {},
        "same_id": {"cluster_id": source_id},
        "other_id": {"cluster_id": target_id},
        "clear": {"cluster_id": None},
        "new_name": {"cluster_name": "New collection"},
    }
    response = c.patch(f"/api/items/{created['id']}", json=collection_payloads[collection_edit])
    assert response.status_code == 200
    after = response.json()
    persisted = c.get(f"/api/items/{created['id']}").json()
    assert persisted["cluster"] == after["cluster"]
    if collection_edit == "clear":
        assert after["cluster"] is None
    elif collection_edit == "new_name":
        assert after["cluster"]["name"] == "New collection"
        assert after["cluster"]["id"] not in {source_id, target_id}
    else:
        expected_id = target_id if collection_edit == "other_id" else source_id
        assert after["cluster"]["id"] == expected_id
        assert after["cluster"]["names"]["zh_hans"] == ("环境人像" if collection_edit == "other_id" else "人物")

    expected_collections = {"Source collection", "Target collection"}
    if collection_edit == "new_name":
        expected_collections.add("New collection")
    assert {cluster["name"] for cluster in c.get("/api/clusters").json()} == expected_collections
    for field in ("title", "model", "author", "notes", "source_name", "source_url", "prompts", "tags", "images"):
        assert after[field] == before[field]
        assert persisted[field] == before[field]
    for path, content in original_files:
        assert path.read_bytes() == content


def test_listing_clusters_hides_empty_collections_without_deleting_them(tmp_path):
    c = client(tmp_path)
    library = tmp_path / "library"
    c.post("/api/items", json=create_payload(cluster_name="Keep Collection"))
    old_name = "Legacy Empty Collection"
    with connect(library) as conn:
        conn.execute(
            "INSERT INTO clusters(id, name, created_at, updated_at) VALUES(?, ?, datetime('now'), datetime('now'))",
            ("clu_legacy_empty", old_name),
        )
        conn.commit()
        assert conn.execute("SELECT COUNT(*) FROM clusters WHERE name=?", (old_name,)).fetchone()[0] == 1

    clusters = c.get("/api/clusters").json()

    assert [cluster["name"] for cluster in clusters] == ["Keep Collection"]
    with connect(library) as conn:
        assert conn.execute("SELECT COUNT(*) FROM clusters WHERE name=?", (old_name,)).fetchone()[0] == 1


@pytest.mark.parametrize("batch", [False, True])
def test_archiving_last_collection_member_preserves_identity_and_metadata(tmp_path, batch):
    c = client(tmp_path)
    library = tmp_path / "library"
    created = c.post("/api/items", json=create_payload(cluster_name="Keep Me")).json()
    item_id, cluster_id = created["id"], created["cluster"]["id"]
    with connect(library) as conn:
        conn.execute("UPDATE clusters SET names=?, description=?, sort_order=? WHERE id=?",
                     ('{"zh_hans":"保留分类","en":"Keep Me"}', "Collection description", 7, cluster_id))
        conn.commit()
        before = dict(conn.execute("SELECT * FROM clusters WHERE id=?", (cluster_id,)).fetchone())

    if batch:
        assert c.post("/api/items/batch", json={"item_ids": [item_id], "action": "archive"}).json()["changed"] == 1
    else:
        assert c.patch(f"/api/items/{item_id}", json={"archived": True}).status_code == 200
    assert c.get("/api/clusters").json() == []
    archived = c.get(f"/api/items/{item_id}").json()
    assert archived["cluster"] is not None
    assert archived["cluster"]["id"] == cluster_id

    # Cleanup caused by another item's move must not remove archived references.
    other = c.post("/api/items", json=create_payload(title="Other item", cluster_name="Temporary")).json()
    assert c.patch(f"/api/items/{other['id']}", json={"cluster_id": None}).status_code == 200
    if batch:
        assert c.post("/api/items/batch", json={"item_ids": [item_id], "action": "unarchive"}).json()["changed"] == 1
    else:
        assert c.patch(f"/api/items/{item_id}", json={"archived": False}).status_code == 200
    restored = c.get(f"/api/items/{item_id}").json()
    assert restored["cluster"] == archived["cluster"]
    assert restored["prompts"] == archived["prompts"]
    listed = c.get("/api/clusters").json()
    assert len(listed) == 1
    assert listed[0]["id"] == cluster_id
    assert listed[0]["count"] == 1
    with connect(library) as conn:
        assert dict(conn.execute("SELECT * FROM clusters WHERE id=?", (cluster_id,)).fetchone()) == before


def test_create_simplified_prompt_adds_traditional_prompt(tmp_path):
    c = client(tmp_path)
    created = c.post("/api/items", json=create_payload(prompts=[{"language": "zh_hans", "text": "红龙云图"}])).json()
    prompts = {p["language"]: p["text"] for p in created["prompts"]}
    assert prompts["zh_hans"] == "红龙云图"
    assert prompts["zh_hant"] == "紅龍雲圖"
    assert c.get("/api/items", params={"q": "紅龍雲圖"}).json()["total"] == 1
