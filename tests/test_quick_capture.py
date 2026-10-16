from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
from pathlib import Path
import json
import sqlite3
import threading
import uuid

from fastapi.testclient import TestClient
from PIL import Image
import pytest

from backend.db import connect
from backend.main import create_app
from backend.repositories import ItemRepository
from backend.schemas import ItemUpdate, PromptIn
from backend.services.prompt_language import detect_prompt_language
from backend.services.library_archives import LibraryArchiveError, backup_library, restore_library
from backend.services.quick_capture import CaptureFields, capture_item
import backend.services.quick_capture as capture_service


@pytest.fixture
def capture_client(tmp_path, monkeypatch):
    for variable, name in (
        ("IMAGE_PROMPT_LIBRARY_AUTH_PATH", "oauth.json"),
        ("IMAGE_PROMPT_LIBRARY_GROK_AUTH_PATH", "grok.json"),
        ("IMAGE_PROMPT_LIBRARY_CONFIG_PATH", "config.json"),
    ):
        monkeypatch.setenv(variable, str(tmp_path / name))
    library = tmp_path / "library"
    return TestClient(create_app(library_path=library)), library


def image_bytes(format="PNG", mode="RGBA", color=(30, 90, 120, 64)):
    output = BytesIO()
    Image.new(mode, (32, 24), color).save(output, format=format)
    return output.getvalue()


def capture(client, *, data=None, image=None, filename="image.png", headers=None):
    fields = {"request_id": str(uuid.uuid4()), "prompt_text": "A peaceful landscape with soft golden light"}
    fields.update(data or {})
    return client.post("/api/captures", data=fields, files={"file": (filename, image_bytes() if image is None else image, "image/png")}, headers=headers)


def counts(library):
    with connect(library) as conn:
        return {table: conn.execute(f"SELECT count(*) FROM {table}").fetchone()[0]
                for table in ("items", "prompts", "images", "item_search", "capture_requests")}


def test_capture_keeps_exact_original_and_alpha_as_ordinary_searchable_item(capture_client):
    client, library = capture_client
    prompt = "  \n柔和灯光下的书店，红色背景。\n\tPBR 8K；保留空行。\n\n  "
    original = image_bytes()
    response = capture(client, image=original, data={"prompt_text": prompt, "source_name": "Fixture source", "source_url": "https://example.invalid/prompt", "notes": "Local fixture notes"})
    assert response.status_code == 200
    item = response.json()
    assert item["model"] == ""
    assert item["source_name"] == "Fixture source"
    assert item["notes"] == "Local fixture notes"
    assert len(item["prompts"]) == 1
    assert item["prompts"][0]["text"] == prompt
    assert item["prompts"][0]["language"] == "zh_hans"
    assert item["prompts"][0]["is_primary"] is True
    assert item["prompts"][0]["is_original"] is True
    stored = item["images"][0]
    assert (library / stored["original_path"]).read_bytes() == original
    assert stored["width"] == 32 and stored["height"] == 24
    for field in ("original_path", "thumb_path", "preview_path"):
        with Image.open(library / stored[field]) as decoded:
            assert "A" in decoded.getbands()
            assert decoded.getchannel("A").getextrema()[0] < 255
        assert client.get("/media/" + stored[field]).status_code == 200
    assert client.get("/api/items", params={"q": "书店"}).json()["total"] == 1
    reopened = client.get("/api/items/" + item["id"]).json()
    assert reopened["prompts"][0]["text"] == prompt
    assert counts(library) == dict.fromkeys(("items", "prompts", "images", "item_search", "capture_requests"), 1)


@pytest.mark.parametrize(("format", "mode", "color", "extension"), [
    ("PNG", "RGBA", (1, 2, 3, 64), ".png"),
    ("JPEG", "RGB", (1, 2, 3), ".jpg"),
    ("WEBP", "RGBA", (1, 2, 3, 64), ".webp"),
    ("GIF", "RGB", (1, 2, 3), ".gif"),
])
def test_capture_detects_actual_format_and_keeps_bytes(capture_client, format, mode, color, extension):
    client, library = capture_client
    original = image_bytes(format, mode, color)
    result = capture(client, image=original, filename="misleading.svg")
    assert result.status_code == 200
    path = result.json()["images"][0]["original_path"]
    assert path.endswith(extension)
    assert (library / path).read_bytes() == original


@pytest.mark.parametrize(("prompt", "expected"), [
    ("A beautiful portrait with soft cinematic lighting and detailed fabric", "en"),
    ("柔和灯光下的红色书店，远处的人物与树叶。", "zh_hans"),
    ("柔和燈光下的紅色書店，遠處的人物與樹葉。", "zh_hant"),
    ("柔和灯光下的红色书店，PBR 8K HDR ISO 100", "zh_hans"),
    ("柔和燈光下的紅色書店，PBR 8K", "zh_hant"),
    ("山水人像", "und"),
    ("红色", "und"),
    ("柔和灯光下的紅色書店", "und"),
    ("A detailed landscape in soft light with mountains，红色书店", "und"),
    ("1234, 8K, PBR", "und"),
    ("", "und"),
    ("Une belle maison au bord du lac", "und"),
    ("Bonjour une image de maison", "und"),
    ("hola una foto de una persona", "und"),
    ("美しい風景と青い空", "und"),
])
def test_language_detection_is_conservative_and_offline(capture_client, prompt, expected):
    client, _ = capture_client
    direct = detect_prompt_language(prompt)
    response = client.post("/api/captures/detect-language", json={"text": prompt})
    assert response.status_code == 200
    assert response.json() == direct.model_dump()
    assert direct.language == expected
    assert direct.uncertain is (expected == "und")


@pytest.mark.parametrize("language", ["en", "zh_hans", "zh_hant", "und"])
def test_capture_manual_language_override(capture_client, language):
    client, _ = capture_client
    prompt = " 山水\n\n"
    response = capture(client, data={"prompt_text": prompt, "language": language})
    assert response.status_code == 200
    result = response.json()["prompts"]
    assert len(result) == 1
    assert result[0]["language"] == language
    assert result[0]["text"] == prompt
    assert result[0]["is_original"]
    assert result[0]["provenance"]["language_detection"]["mode"] == "manual"


def test_capture_unknown_is_not_original_language(capture_client):
    client, _ = capture_client
    response = capture(client, data={"prompt_text": "山水人像"})
    assert response.json()["prompts"][0]["language"] == "und"
    assert response.json()["prompts"][0]["is_original"] is True


def test_json_prompt_preserves_mixed_line_endings_and_unicode(capture_client):
    client, library = capture_client
    prompt = '  \n简体中文，\r\n\t"quotes" \\ slash\r孤立回车 😀\n\n  '
    request_id = str(uuid.uuid4())
    response = client.post("/api/captures", data={"request_id": request_id, "prompt_text_json": json.dumps(prompt, ensure_ascii=False)},
                           files={"file": ("image.png", image_bytes(), "image/png")})
    assert response.status_code == 200
    item = response.json()
    assert item["prompts"][0]["text"] == prompt
    with connect(library) as conn:
        assert conn.execute("SELECT text FROM prompts WHERE item_id=?", (item["id"],)).fetchone()[0] == prompt


@pytest.mark.parametrize(("encoded", "status"), [('{"text":"not a string"}', 400), ('123', 400), ('["array"]', 400), ('null', 400), ('invalid', 400), ('"\\ud800"', 422)])
def test_json_prompt_rejects_invalid_representation(capture_client, encoded, status):
    client, library = capture_client
    response = client.post("/api/captures", data={"request_id": str(uuid.uuid4()), "prompt_text_json": encoded},
                           files={"file": ("image.png", image_bytes())})
    assert response.status_code == status
    assert not any(counts(library).values())


def test_editing_captured_original_does_not_add_automatic_translation(capture_client):
    client, _ = capture_client
    item = capture(client, data={"prompt_text": "柔和灯光下的红色书店"}).json()
    prompt = item["prompts"][0]
    prompt["text"] = "  \n红色书店里的阳光\n\n "
    updated = client.patch("/api/items/" + item["id"], json={"prompts": [prompt]})
    assert updated.status_code == 200
    assert len(updated.json()["prompts"]) == 1
    assert updated.json()["prompts"][0]["text"] == prompt["text"]
    assert updated.json()["prompts"][0]["language"] == "zh_hans"
    assert updated.json()["prompts"][0]["is_original"] is True


@pytest.mark.parametrize(("data", "image", "expected"), [
    ({"prompt_text": "  \n\t"}, None, 400),
    ({"language": "original"}, None, 400),
    ({"request_id": "../../bad"}, None, 422),
    ({"title": "x" * 301}, None, 422),
    ({"prompt_text": "x" * 200001}, None, 422),
    ({}, b"", 400),
    ({}, b"not an image", 400),
    ({}, b'<svg xmlns="http://www.w3.org/2000/svg"></svg>', 400),
])
def test_invalid_capture_creates_nothing(capture_client, data, image, expected):
    client, library = capture_client
    result = capture(client, data=data, image=image)
    assert result.status_code == expected
    assert not any(counts(library).values())


def test_capture_rejects_truncated_and_unsupported_images(capture_client):
    client, library = capture_client
    truncated = image_bytes()[:45]
    assert capture(client, image=truncated).status_code == 400
    assert capture(client, image=image_bytes("BMP", "RGB", (0, 0, 0))).status_code == 415
    assert not any(counts(library).values())


def test_capture_limits_image_pixels_and_bytes(capture_client, monkeypatch):
    client, library = capture_client
    monkeypatch.setattr(capture_service, "MAX_IMAGE_PIXELS", 100)
    assert capture(client).status_code == 413
    monkeypatch.setattr(capture_service, "MAX_IMAGE_PIXELS", 16_000_000)
    monkeypatch.setattr(capture_service, "MAX_CAPTURE_BYTES", 20)
    assert capture(client).status_code == 413
    assert not any(counts(library).values())


def test_capture_requires_exactly_one_image(capture_client):
    client, library = capture_client
    response = client.post("/api/captures", data={"request_id": str(uuid.uuid4()), "prompt_text": "Fixture prompt"},
                           files=[("file", ("one.png", image_bytes())), ("file", ("two.png", image_bytes()))])
    assert response.status_code == 400
    assert not any(counts(library).values())


def test_capture_replays_after_restart_and_after_edit(capture_client):
    client, library = capture_client
    fields = {"request_id": str(uuid.uuid4())}
    first = capture(client, data=fields).json()
    ItemRepository(library).update_item(first["id"], ItemUpdate(title="An edited title", prompts=[
        PromptIn(language="en", text="Replacement prompt", is_original=True),
    ]))
    restarted = TestClient(create_app(library_path=library))
    replay = capture(restarted, data=fields)
    assert replay.status_code == 200
    assert replay.json()["id"] == first["id"]
    assert replay.json()["title"] == "An edited title"
    assert counts(library)["items"] == 1
    assert counts(library)["capture_requests"] == 1
    assert capture(restarted, data={**fields, "prompt_text": "Different prompt"}).status_code == 409
    assert capture(restarted, data=fields, image=image_bytes(color=(99, 99, 99, 100))).status_code == 409


def test_capture_retry_after_deletion_does_not_recreate_item(capture_client):
    client, library = capture_client
    fields = {"request_id": str(uuid.uuid4())}
    item = capture(client, data=fields).json()
    assert client.delete("/api/items/" + item["id"]).status_code == 200
    assert capture(client, data=fields).status_code == 410
    assert counts(library)["items"] == 0
    assert counts(library)["capture_requests"] == 1


def test_concurrent_same_request_commits_exactly_once(capture_client):
    _, library = capture_client
    fields = CaptureFields(request_id=uuid.uuid4(), prompt_text="A soft landscape with golden light")
    original = image_bytes()
    barrier = threading.Barrier(4)

    def submit(_):
        barrier.wait(timeout=10)
        return capture_item(library, fields, original)

    with ThreadPoolExecutor(max_workers=4) as executor:
        items = list(executor.map(submit, range(4)))
    assert len({item.id for item in items}) == 1
    assert counts(library) == dict.fromkeys(("items", "prompts", "images", "item_search", "capture_requests"), 1)
    assert len(list((library / "originals").rglob("*.png"))) == 1


def test_database_failure_rolls_back_item_prompt_search_and_files(capture_client, monkeypatch):
    client, library = capture_client
    fields = {"request_id": str(uuid.uuid4())}
    original_method = ItemRepository.add_image_in_transaction

    def fail(*args, **kwargs):
        raise sqlite3.OperationalError("synthetic disk full")

    monkeypatch.setattr(ItemRepository, "add_image_in_transaction", fail)
    response = capture(client, data=fields)
    assert response.status_code == 503
    assert "synthetic disk full" not in response.text
    assert not any(counts(library).values())
    assert not [path for root in ("originals", "thumbs", "previews") for path in (library / root).rglob("*") if path.is_file()]
    monkeypatch.setattr(ItemRepository, "add_image_in_transaction", original_method)
    assert capture(client, data=fields).status_code == 200
    assert counts(library)["items"] == 1


def test_image_file_failure_rolls_back_without_empty_card(capture_client, monkeypatch):
    client, library = capture_client
    original_write = capture_service._atomic_write_bytes
    writes = 0

    def fail_second(path, data):
        nonlocal writes
        writes += 1
        if writes == 2:
            raise OSError("synthetic no space")
        return original_write(path, data)

    monkeypatch.setattr(capture_service, "_atomic_write_bytes", fail_second)
    assert capture(client).status_code == 503
    assert not any(counts(library).values())
    assert not [path for path in library.rglob("*") if path.suffix in {".png", ".webp"}]


def test_lost_response_is_recoverable_with_same_request(capture_client, monkeypatch):
    _, library = capture_client
    fields = CaptureFields(request_id=uuid.uuid4(), prompt_text="A landscape with soft light")
    original_get = ItemRepository.get_item
    with monkeypatch.context() as patch:
        patch.setattr(ItemRepository, "get_item", lambda *_: (_ for _ in ()).throw(OSError("response lost")))
        with pytest.raises(OSError):
            capture_item(library, fields, image_bytes())
    assert ItemRepository.get_item is original_get
    item = capture_item(library, fields, image_bytes())
    assert (library / item.images[0].original_path).is_file()
    assert counts(library)["items"] == 1


def test_cross_origin_capture_and_detection_are_rejected(capture_client):
    client, library = capture_client
    headers = {"Origin": "https://example.invalid"}
    assert capture(client, headers=headers).status_code == 403
    assert client.post("/api/captures/detect-language", json={"text": "A soft image"}, headers=headers).status_code == 403
    assert not any(counts(library).values())


def test_backup_restore_keeps_captured_bytes_prompt_and_retry_identity(capture_client, tmp_path):
    client, library = capture_client
    fields = {"request_id": str(uuid.uuid4()), "prompt_text": "  A landscape with soft light\n\n "}
    original = image_bytes()
    item = capture(client, data=fields, image=original).json()
    archive = backup_library(library, tmp_path / "capture-fixture.tar.gz")
    restored = tmp_path / "restored"
    restore_library(archive, restored, confirm=True)
    restored_client = TestClient(create_app(library_path=restored))
    result = capture(restored_client, data=fields, image=original)
    assert result.status_code == 200
    assert result.json()["id"] == item["id"]
    assert result.json()["prompts"][0]["text"] == fields["prompt_text"]
    assert (restored / result.json()["images"][0]["original_path"]).read_bytes() == original
    assert counts(restored)["items"] == 1


def test_archive_rejects_missing_capture_ledger(capture_client, tmp_path):
    _, library = capture_client
    with connect(library) as conn:
        conn.execute("DROP TABLE capture_requests")
    with pytest.raises(LibraryArchiveError, match="capture_requests"):
        backup_library(library, tmp_path / "invalid-fixture.tar.gz")
