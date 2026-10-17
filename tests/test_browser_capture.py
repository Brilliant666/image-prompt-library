"""Browser capture uses a narrow capability, never a general library API key."""
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
import hashlib
import json
import tarfile
import uuid

from fastapi.testclient import TestClient
from PIL import Image
import pytest

from backend.db import connect
from backend.main import create_app
from backend.services.library_archives import backup_library, verify_backup

TARGET = "http://127.0.0.1:8123"
EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop"
ORIGIN = "chrome-extension://" + EXTENSION_ID


@pytest.fixture
def setup_capture(tmp_path, monkeypatch):
    library = tmp_path / "library"
    credentials = tmp_path / "external" / "capture-clients.json"
    monkeypatch.setenv("IMAGE_PROMPT_LIBRARY_CAPTURE_CLIENTS_PATH", str(credentials))
    for variable in ("IMAGE_PROMPT_LIBRARY_AUTH_PATH", "IMAGE_PROMPT_LIBRARY_GROK_AUTH_PATH", "IMAGE_PROMPT_LIBRARY_CONFIG_PATH"):
        monkeypatch.setenv(variable, str(tmp_path / "external" / (variable + ".json")))
    app = create_app(library_path=library)
    client = TestClient(app, base_url=TARGET, client=("127.0.0.1", 54321))
    return client, library, credentials


def pair(client, extension_id=EXTENSION_ID):
    response = client.post("/api/capture-clients", json={"extension_id": extension_id, "name": "Test capture"}, headers={"Origin": TARGET})
    assert response.status_code == 201, response.text
    assert response.headers["cache-control"] == "no-store"
    return response.json()


def authorization(pairing):
    return {"Origin": "chrome-extension://" + pairing["extension_id"], "X-Capture-Token": pairing["token"], "X-Capture-Instance": pairing["instance_id"]}


def png():
    stream = BytesIO()
    Image.new("RGBA", (32, 24), (30, 60, 90, 64)).save(stream, "PNG")
    return stream.getvalue()


def submit(client, headers, request_id=None, prompt="  简体中文\nA test\r\n\t ", image=None, **fields):
    return client.post("/api/captures", headers=headers,
                       data={"request_id": request_id or str(uuid.uuid4()), "prompt_text_json": json.dumps(prompt, ensure_ascii=False), **fields},
                       files={"file": ("test.png", png() if image is None else image, "image/png")})


def test_pairing_requires_explicit_loopback_same_origin_authorization(setup_capture):
    client, _, _ = setup_capture
    for origin in (None, "https://hostile.example", ORIGIN, "http://localhost:8123", "http://127.0.0.1:5177"):
        response = client.post("/api/capture-clients", json={"extension_id": EXTENSION_ID}, headers={"Origin": origin} if origin else {})
        assert response.status_code == 403
    assert client.get("/api/capture-clients").status_code == 403
    assert client.get("/api/capture-clients", headers={"Sec-Fetch-Site": "same-origin"}).json() == {"clients": [], "instance_id": None}
    pairing = pair(client)
    assert pairing["target_origin"] == TARGET
    assert pairing["extension_id"] == EXTENSION_ID
    listing = client.get("/api/capture-clients", headers={"Origin": TARGET}).json()
    assert listing["instance_id"] == pairing["instance_id"]
    assert set(listing["clients"][0]) == {"client_id", "extension_id", "name", "created_at"}
    assert pairing["token"] not in json.dumps(listing)


@pytest.mark.parametrize("base_url,peer", [("http://192.168.1.20:8123", "127.0.0.1"), (TARGET, "192.168.1.20")])
def test_pairing_rejects_lan_host_and_remote_peer(setup_capture, base_url, peer):
    client, _, _ = setup_capture
    remote = TestClient(client.app, base_url=base_url, client=(peer, 54321))
    response = remote.post("/api/capture-clients", json={"extension_id": EXTENSION_ID}, headers={"Origin": base_url})
    assert response.status_code == 403


def test_credentials_are_hashed_external_and_excluded_from_backup(setup_capture, tmp_path):
    client, library, credentials = setup_capture
    pairing = pair(client)
    assert pairing["token"] not in credentials.read_text(encoding="utf-8")
    digest = hashlib.sha256(pairing["token"].encode()).hexdigest()
    assert digest in credentials.read_text(encoding="utf-8")
    assert submit(client, authorization(pairing)).status_code == 200
    archive = backup_library(library, tmp_path / "backup.tar.gz")
    assert verify_backup(archive)["total_size"] > 0
    with tarfile.open(archive, "r:gz") as packaged:
        content = b"".join(packaged.extractfile(member).read() for member in packaged.getmembers() if member.isfile())
        assert pairing["token"].encode() not in content
        assert digest.encode() not in content
        assert "capture-clients.json" not in "\n".join(packaged.getnames())


def test_credentials_cannot_be_configured_inside_library(setup_capture, monkeypatch):
    _, library, _ = setup_capture
    monkeypatch.setenv("IMAGE_PROMPT_LIBRARY_CAPTURE_CLIENTS_PATH", str(library / "capture-clients.json"))
    with pytest.raises(ValueError, match="IMAGE_PROMPT_LIBRARY_CAPTURE_CLIENTS_PATH"):
        create_app(library_path=library)


def test_capture_validates_real_bytes_preserves_original_and_replays(setup_capture):
    client, library, _ = setup_capture
    pairing = pair(client)
    headers = authorization(pairing)
    assert client.get("/api/captures/connection", headers=headers).json() == {"instance_id": pairing["instance_id"], "client_id": pairing["client_id"], "organizer": {"enabled": False, "configured": False}}
    request_id = str(uuid.uuid4())
    prompt = "  红色天空\nEnglish line\r\n\t "
    result = submit(client, headers, request_id, prompt)
    assert result.status_code == 200, result.text
    receipt = result.json()
    assert set(receipt) == {"request_id", "item_id", "title", "created_at", "organizer"}
    assert receipt["organizer"] == {"status": "disabled", "category": "", "collection": None}
    assert receipt["request_id"] == request_id
    assert submit(client, headers, request_id, prompt).json() == receipt
    assert submit(client, headers, request_id, prompt + "changed").status_code == 409
    assert client.get(f"/api/captures/receipts/{request_id}", headers=headers).json() == receipt
    item = client.get("/api/items/" + receipt["item_id"]).json()
    assert receipt["title"] == item["title"]
    assert receipt["created_at"] == item["created_at"]
    assert item["prompts"][0]["text"] == prompt
    assert (library / item["images"][0]["original_path"]).read_bytes() == png()
    for key in ("preview_path", "thumb_path"):
        with Image.open(library / item["images"][0][key]) as preview:
            assert "A" in preview.getbands()
            assert preview.getchannel("A").getextrema()[0] < 255
    with connect(library) as conn:
        assert conn.execute("SELECT count(*) FROM items").fetchone()[0] == 1
    assert submit(client, headers, image=b"https://example.invalid/image.png").status_code == 400


@pytest.mark.parametrize("query_method", ["GET", "POST"])
def test_receipt_reports_only_own_saved_title_and_utc_creation_time(setup_capture, query_method):
    client, library, _ = setup_capture
    headers = authorization(pair(client))
    other_client = authorization(pair(client, "p" * 32))
    request_id = str(uuid.uuid4())
    result = submit(client, headers, request_id, original_filename="书店角落.png")
    assert result.status_code == 200
    receipt = result.json()
    assert set(receipt) == {"request_id", "item_id", "title", "created_at", "organizer"}
    assert receipt["organizer"] == {"status": "disabled", "category": "", "collection": None}
    assert receipt["title"] == "书店角落"
    assert receipt["created_at"].endswith("+00:00")
    assert client.request(query_method, f"/api/captures/receipts/{request_id}", headers=headers).json() == receipt
    assert client.request(query_method, f"/api/captures/receipts/{request_id}", headers=other_client).status_code == 404
    edited = client.patch("/api/items/" + receipt["item_id"], json={"title": "后续手动整理的标题"})
    assert edited.status_code == 200
    replay = submit(client, headers, request_id, original_filename="书店角落.png").json()
    assert replay["title"] == "后续手动整理的标题"
    assert replay["created_at"] == receipt["created_at"]
    assert client.request(query_method, f"/api/captures/receipts/{request_id}", headers=headers).json() == replay
    with connect(library) as conn:
        assert conn.execute("SELECT count(*) FROM items").fetchone()[0] == 1


@pytest.mark.parametrize("query_method", ["GET", "POST"])
def test_same_request_id_is_scoped_to_each_client_and_receipt_survives_restart(setup_capture, query_method):
    client, library, _ = setup_capture
    first = authorization(pair(client))
    second = authorization(pair(client, "p" * 32))
    request_id = str(uuid.uuid4())
    result = submit(client, first, request_id).json()
    assert client.request(query_method, f"/api/captures/receipts/{request_id}", headers=second).status_code == 404
    second_result = submit(client, second, request_id, "Other prompt").json()
    assert result["item_id"] != second_result["item_id"]
    restarted = TestClient(create_app(library_path=library), base_url=TARGET, client=("127.0.0.1", 54321))
    assert restarted.request(query_method, f"/api/captures/receipts/{request_id}", headers=first).json() == result
    assert submit(restarted, first, request_id).json() == result


@pytest.mark.parametrize("query_method", ["GET", "POST"])
def test_connection_and_receipt_queries_require_full_identity_and_never_create_items(setup_capture, query_method):
    client, library, _ = setup_capture
    pairing = pair(client)
    headers = authorization(pairing)
    request_id = str(uuid.uuid4())
    paths = ("/api/captures/connection", f"/api/captures/receipts/{request_id}")
    for path in paths:
        for changes in ({"Origin": None}, {"Origin": "null"}, {"Origin": TARGET},
                        {"Origin": "chrome-extension://" + "p" * 32},
                        {"X-Capture-Instance": "wrong-instance"}, {"X-Capture-Token": "invalid"}):
            invalid = {key: value for key, value in {**headers, **changes}.items() if value is not None}
            assert client.request(query_method, path, headers=invalid).status_code == 401
    assert client.request(query_method, paths[0], headers=headers).json() == {"instance_id": pairing["instance_id"], "client_id": pairing["client_id"], "organizer": {"enabled": False, "configured": False}}
    assert client.request(query_method, paths[1], headers=headers).status_code == 404
    with connect(library) as conn:
        assert conn.execute("SELECT count(*) FROM items").fetchone()[0] == 0
        assert conn.execute("SELECT count(*) FROM capture_requests").fetchone()[0] == 0
    receipt = submit(client, headers, request_id).json()
    for _ in range(3):
        assert client.request(query_method, paths[0], headers=headers).status_code == 200
        assert client.request(query_method, paths[1], headers=headers).json() == receipt
    with connect(library) as conn:
        assert conn.execute("SELECT count(*) FROM items").fetchone()[0] == 1
        assert conn.execute("SELECT count(*) FROM capture_requests").fetchone()[0] == 1
    assert client.delete("/api/capture-clients/" + pairing["client_id"], headers={"Origin": TARGET}).status_code == 204
    for path in paths:
        assert client.request(query_method, path, headers=headers).status_code == 401


def test_query_post_alias_preflights_do_not_expand_capture_permission(setup_capture):
    client, _, _ = setup_capture
    paired = authorization(pair(client))
    headers = {"Origin": ORIGIN, "Access-Control-Request-Method": "POST",
               "Access-Control-Request-Headers": "content-type,x-capture-token,x-capture-instance"}
    for path in ("/api/captures/connection", f"/api/captures/receipts/{uuid.uuid4()}"):
        response = client.options(path, headers=headers)
        assert response.status_code == 204
        assert response.headers["access-control-allow-origin"] == ORIGIN
        assert response.headers["access-control-allow-methods"] == "POST"
        assert client.post(path, headers={"Origin": ORIGIN}).status_code == 401
        assert client.options(path, headers={**headers, "Origin": "null"}).status_code in {400, 403}
        assert client.options(path, headers={**headers, "Origin": "chrome-extension://" + "p" * 32}).status_code == 403
        assert client.options(path, headers={**headers, "Access-Control-Request-Method": "DELETE"}).status_code == 403
    for path in ("/api/captures/receipts", "/api/captures/connection/extra", "/api/config", "/api/items"):
        assert client.post(path, headers=paired).status_code == 403
        assert client.options(path, headers=headers).status_code == 403


def test_simultaneous_paired_submission_creates_one_item(setup_capture):
    client, library, _ = setup_capture
    headers = authorization(pair(client))
    request_id = str(uuid.uuid4())

    def upload(_):
        # Separate connections exercise the DB transaction, not a serialized
        # extension click handler or a shared in-memory response cache.
        connection = TestClient(client.app, base_url=TARGET, client=("127.0.0.1", 54321))
        return submit(connection, headers, request_id)

    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(upload, range(4)))
    assert all(response.status_code == 200 for response in results)
    assert all(response.json() == results[0].json() for response in results)
    with connect(library) as conn:
        assert conn.execute("SELECT count(*) FROM items").fetchone()[0] == 1
        assert conn.execute("SELECT count(*) FROM capture_requests").fetchone()[0] == 1


def test_corrupt_pairing_storage_fails_without_exposing_contents(setup_capture):
    client, _, credentials = setup_capture
    pairing = pair(client)
    credentials.write_text('{"secret-fixture": "not valid json', encoding="utf-8")
    response = client.get("/api/capture-clients", headers={"Origin": TARGET})
    assert response.status_code == 503
    assert "secret-fixture" not in response.text
    assert pairing["token"] not in response.text


@pytest.mark.parametrize("path,method", [
    ("/api/items", "GET"), ("/api/config", "GET"), ("/api/generation/providers", "GET"),
    ("/api/generation/jobs", "POST"), ("/api/capture-clients", "GET"),
    ("/api/capture-clients", "POST"), ("/api/items/any", "DELETE"),
    ("/media/originals/any.png", "GET"), ("/api/health", "GET"),
])
def test_pairing_cannot_access_unrelated_routes_even_without_extension_origin(setup_capture, path, method):
    client, _, _ = setup_capture
    pairing = pair(client)
    for headers in (authorization(pairing), {"X-Capture-Token": pairing["token"]},
                    {**authorization(pairing), "Origin": TARGET}, {"Authorization": "Bearer " + pairing["token"]}):
        response = client.request(method, path, headers=headers)
        assert response.status_code == 403
        assert pairing["token"] not in response.text


@pytest.mark.parametrize("headers", [
    {"Origin": ORIGIN}, {"Origin": "chrome-extension://" + "p" * 32}, {},
])
def test_unpaired_extension_cannot_capture(setup_capture, headers):
    client, _, _ = setup_capture
    # A normal non-browser local caller retains its existing interface. The
    # plugin identity routes, unlike captures, always require a credential.
    assert client.get("/api/captures/connection", headers=headers).status_code in {401, 403}
    if headers:
        assert submit(client, headers).status_code == 401


def test_wrong_origin_token_instance_and_target_are_rejected(setup_capture):
    client, library, _ = setup_capture
    pairing = pair(client)
    headers = authorization(pairing)
    for changes in ({"Origin": TARGET}, {"Origin": "https://hostile.example"}, {"Origin": "chrome-extension://" + "p" * 32},
                    {"X-Capture-Token": "invalid"}, {"X-Capture-Instance": "wrong-instance"}):
        response = client.get("/api/captures/connection", headers={**headers, **changes})
        assert response.status_code == 401
    other_port = TestClient(client.app, base_url="http://127.0.0.1:8124", client=("127.0.0.1", 54321))
    assert other_port.get("/api/captures/connection", headers=headers).status_code == 401
    other_library = TestClient(create_app(library_path=library.parent / "other-library"), base_url=TARGET, client=("127.0.0.1", 54321))
    assert other_library.get("/api/captures/connection", headers=headers).status_code == 401


def test_revoke_denies_capture_and_receipt_without_deleting_assets(setup_capture):
    client, library, _ = setup_capture
    pairing = pair(client)
    headers = authorization(pairing)
    request_id = str(uuid.uuid4())
    receipt = submit(client, headers, request_id).json()
    revoked = client.delete("/api/capture-clients/" + pairing["client_id"], headers={"Origin": TARGET})
    assert revoked.status_code == 204
    for path in ("/api/captures/connection", f"/api/captures/receipts/{request_id}"):
        response = client.get(path, headers=headers)
        assert response.status_code == 401
        assert response.headers["access-control-allow-origin"] == ORIGIN
    assert submit(client, headers).status_code == 401
    assert client.get("/api/items/" + receipt["item_id"]).status_code == 200


def test_preflight_is_scoped_and_never_replaces_token_authentication(setup_capture):
    client, _, _ = setup_capture
    headers = {"Origin": ORIGIN, "Access-Control-Request-Method": "POST",
               "Access-Control-Request-Headers": "content-type,x-capture-token,x-capture-instance"}
    assert client.options("/api/captures", headers=headers).status_code == 403
    pair(client)
    allowed = client.options("/api/captures", headers=headers)
    assert allowed.status_code == 204
    assert allowed.headers["access-control-allow-origin"] == ORIGIN
    assert "access-control-allow-credentials" not in allowed.headers
    assert client.options("/api/config", headers={**headers, "Access-Control-Request-Method": "GET"}).status_code == 403
    assert client.options("/api/captures", headers={**headers, "Access-Control-Request-Headers": "authorization"}).status_code == 403
    assert submit(client, {"Origin": ORIGIN}).status_code == 401
    assert submit(client, {"Origin": "https://hostile.example"}).status_code == 403


@pytest.mark.parametrize("prompt", ["A quiet garden with soft light", "红色的花朵和宽阔的天空", "紅色的花朵與寬闊的天空", "一个 portrait with 繁體中文", "12345 !!!"])
def test_language_detection_and_capture_do_not_require_manual_language(setup_capture, prompt):
    client, _, _ = setup_capture
    headers = authorization(pair(client))
    response = client.post("/api/captures/detect-language", json={"text": prompt}, headers=headers)
    assert response.status_code == 200
    assert submit(client, headers, prompt=prompt).status_code == 200


@pytest.mark.parametrize("query_method", ["GET", "POST"])
def test_manual_language_override_and_deleted_receipt(setup_capture, query_method):
    client, _, _ = setup_capture
    headers = authorization(pair(client))
    request_id = str(uuid.uuid4())
    result = submit(client, headers, request_id, "123 mixed", language="zh_hant").json()
    assert client.get("/api/items/" + result["item_id"]).json()["prompts"][0]["language"] == "zh_hant"
    assert client.delete("/api/items/" + result["item_id"]).status_code == 200
    assert client.request(query_method, f"/api/captures/receipts/{request_id}", headers=headers).status_code == 410
    assert submit(client, headers, request_id, "123 mixed", language="zh_hant").status_code == 410
