"""Only isolated libraries and fake transports; never call a paid model."""
from io import BytesIO
from concurrent.futures import ThreadPoolExecutor
import base64
import json
import threading
from types import SimpleNamespace
import uuid

import httpx
from fastapi.testclient import TestClient
from PIL import Image
import pytest

from backend.config import resolve_capture_organizer_config_path, validate_app_owned_paths
from backend.db import connect, init_db
from backend.main import create_app
from backend.repositories import ItemRepository
from backend.schemas import ItemUpdate, PromptIn
from backend.services import capture_organizer as service
from backend.services.quick_capture import CaptureFields, capture_item
from backend.services.library_archives import LibraryOperationLock, LibraryArchiveError
import backend.routers.captures as capture_routes
import backend.main as app_module

TARGET = "http://127.0.0.1:8123"
SECRET = "fixture-secret-not-real-abcde"
REAL_ENQUEUE = service.enqueue_jobs


@pytest.fixture
def setup(tmp_path, monkeypatch):
    monkeypatch.setenv("IMAGE_PROMPT_LIBRARY_CAPTURE_ORGANIZER_CONFIG_PATH", str(tmp_path / "external" / "organizer.json"))
    monkeypatch.setenv("IMAGE_PROMPT_LIBRARY_CAPTURE_CLIENTS_PATH", str(tmp_path / "external" / "pairings.json"))
    library = tmp_path / "library"
    app = create_app(library)
    monkeypatch.setattr(service, "enqueue_jobs", lambda library: None)
    client = TestClient(app, base_url=TARGET, client=("127.0.0.1", 54321))
    return library, client


def configure(library, **options):
    return service.OrganizerConfig(library).save({"enabled": True, "base_url": "https://example.invalid/v1/v1/",
                                              "api_key": SECRET, **options})


def capture(library, title="", request_id=None):
    stream = BytesIO()
    Image.new("RGBA", (12, 8), (120, 20, 30, 60)).save(stream, "PNG")
    fields = CaptureFields(request_id=request_id or str(uuid.uuid4()), prompt_text="  白色蕾丝\r\n\n untouched  ", title=title)
    item = capture_item(library, fields, stream.getvalue())
    return item, fields, stream.getvalue()


def test_config_is_scoped_secret_and_check_is_local(setup, monkeypatch, tmp_path):
    library, client = setup
    monkeypatch.setattr(httpx.Client, "stream", lambda *a, **k: pytest.fail("check must not access network"))
    first = client.get("/api/capture-organizer/config", headers={"Origin": TARGET}).json()
    assert first["enabled"] is False and first["model"] == "gpt-6-luna" and not first["configured"]
    saved = client.put("/api/capture-organizer/config", headers={"Origin": TARGET}, json={
        "base_url": "https://example.invalid/v1/v1/", "api_key": SECRET,
    })
    assert saved.status_code == 200
    assert saved.headers["cache-control"] == "no-store"
    assert SECRET not in saved.text and saved.json()["has_api_key"]
    assert saved.json()["base_url"] == "https://example.invalid/v1"
    checked = client.post("/api/capture-organizer/check", headers={"Origin": TARGET})
    assert checked.json()["configured"] and checked.json()["last_result"] is None
    assert "no model request" in checked.json()["message"]
    changed = client.put("/api/capture-organizer/config", headers={"Origin": TARGET}, json={"base_url": "https://other.invalid", "api_key": ""})
    assert changed.status_code == 422 and SECRET not in changed.text
    assert service.OrganizerConfig(library).read()["api_key"] == SECRET
    other = tmp_path / "other"
    init_db(other)
    assert resolve_capture_organizer_config_path(library) != resolve_capture_organizer_config_path(other)
    assert not service.OrganizerConfig(other).public()["configured"]


@pytest.mark.parametrize("changes", [
    {"base_url": "https://user:password@example.invalid"}, {"base_url": "https://example.invalid/?key=x"},
    {"base_url": "http://remote.invalid"}, {"timeout_seconds": 121}, {"timeout_seconds": 1},
    {"api_key": "secret\r\ninjected"}, {"model": "private\nheader"}, {"enabled": "false"}, {"base_url": 42},
])
def test_validation_never_echoes_submitted_values(setup, changes):
    _, client = setup
    response = client.put("/api/capture-organizer/config", headers={"Origin": TARGET}, json=changes)
    assert response.status_code == 422
    assert "secret" not in response.text and "password" not in response.text


def test_management_requires_loopback_same_origin_and_pairing_is_insufficient(setup):
    _, client = setup
    assert client.get("/api/capture-organizer/config").status_code == 403
    assert client.put("/api/capture-organizer/config", headers={"Origin": "https://hostile.invalid"}, json={}).status_code == 403
    extension_id = "abcdefghijklmnopabcdefghijklmnop"
    pairing = client.post("/api/capture-clients", json={"extension_id": extension_id}, headers={"Origin": TARGET}).json()
    headers = {"Origin": "chrome-extension://" + extension_id, "X-Capture-Token": pairing["token"], "X-Capture-Instance": pairing["instance_id"]}
    for path in ("/api/capture-organizer/config", "/api/capture-organizer/check", "/api/capture-organizer/test"):
        assert client.post(path, headers=headers, json={}).status_code == 403
        assert client.get(path, headers=headers).status_code == 403
    assert client.post("/api/captures/connection", headers=headers).json()["organizer"] == {"enabled": False, "configured": False}


def test_credential_path_inside_library_rejected(setup, monkeypatch):
    library, _ = setup
    monkeypatch.setenv("IMAGE_PROMPT_LIBRARY_CAPTURE_ORGANIZER_CONFIG_PATH", str(library / "unsafe.json"))
    with pytest.raises(ValueError, match="outside"):
        validate_app_owned_paths(library)


def test_new_capture_enriches_once_without_changing_prompt_or_original(setup, monkeypatch):
    library, _ = setup
    configure(library)
    item, fields, original = capture(library)
    calls = []
    def metadata(settings, prompt, title, image, collections):
        calls.append(prompt)
        assert prompt == fields.prompt_text and image.startswith("data:image/jpeg;base64,")
        return {"title": "冷光窗影下的白色 Lolita", "collection": "冷光与窗影"}
    monkeypatch.setattr(service, "request_metadata", metadata)
    service.run_job(library, str(fields.request_id))
    service.run_job(library, str(fields.request_id))
    replay = capture_item(library, fields, original)
    assert len(calls) == 1
    assert replay.id == item.id and replay.title == "冷光窗影下的白色 Lolita"
    assert replay.cluster.name == "冷光与窗影"
    assert replay.prompts[0].text == fields.prompt_text
    assert (library / replay.images[0].original_path).read_bytes() == original
    assert service.receipt_status(library, fields.request_id)["status"] == "succeeded"
    assert SECRET.encode() not in (library / "db.sqlite").read_bytes()


def test_disabled_capture_never_becomes_paid_on_replay(setup, monkeypatch):
    library, _ = setup
    item, fields, original = capture(library)
    configure(library)
    monkeypatch.setattr(service, "request_metadata", lambda *a: pytest.fail("old capture must not be enriched"))
    assert capture_item(library, fields, original).id == item.id
    service.run_job(library, str(fields.request_id))
    assert service.receipt_status(library, fields.request_id)["status"] == "disabled"


def test_corrupt_config_does_not_prevent_durable_capture(setup):
    library, _ = setup
    path = resolve_capture_organizer_config_path(library)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text('[' * 2000 + ']' * 2000, encoding="utf-8")
    item, fields, _ = capture(library)
    assert item.id and service.receipt_status(library, fields.request_id)["category"] == "configuration"


def test_fast_completion_receipt_pairs_final_title_and_terminal_state(setup, monkeypatch):
    library, client = setup
    configure(library)
    monkeypatch.setattr(service, "request_metadata", lambda *a: {"title": "窗影白裙", "collection": "窗影"})
    def synchronous_queue(library):
        with connect(library) as conn:
            ids = [row[0] for row in conn.execute("SELECT request_id FROM capture_organizer_jobs WHERE status='pending'")]
        for request_id in ids:
            service.run_job(library, request_id)
    monkeypatch.setattr(capture_routes, "enqueue_jobs", synchronous_queue)
    pairing = client.post("/api/capture-clients", headers={"Origin": TARGET}, json={"extension_id": "abcdefghijklmnopabcdefghijklmnop"}).json()
    headers = {"Origin": "chrome-extension://" + pairing["extension_id"], "X-Capture-Token": pairing["token"], "X-Capture-Instance": pairing["instance_id"]}
    stream = BytesIO()
    Image.new("RGBA", (12, 8), (120, 20, 30, 60)).save(stream, "PNG")
    request_id = str(uuid.uuid4())
    result = client.post("/api/captures", headers=headers, data={"request_id": request_id, "prompt_text": "原文"},
                         files={"file": ("image.png", stream.getvalue(), "image/png")})
    assert result.status_code == 200
    assert result.json()["title"] == "窗影白裙" and result.json()["organizer"]["status"] == "succeeded"
    assert client.post("/api/captures/receipts/" + request_id, headers=headers).json() == result.json()


def test_atomic_claim_allows_only_one_concurrent_remote_attempt(setup, monkeypatch):
    library, _ = setup
    configure(library)
    _, fields, _ = capture(library)
    entered, release = threading.Event(), threading.Event()
    calls = []
    def remote(*args):
        calls.append(1)
        entered.set()
        assert release.wait(3)
        return {"title": "窗影白裙", "collection": None}
    monkeypatch.setattr(service, "request_metadata", remote)
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(service.run_job, library, str(fields.request_id))
        assert entered.wait(3)
        second = pool.submit(service.run_job, library, str(fields.request_id))
        second.result(timeout=3)
        release.set()
        first.result(timeout=3)
    assert len(calls) == 1


def test_new_configuration_is_not_reported_as_previously_verified(setup, monkeypatch):
    library, _ = setup
    configure(library)
    _, fields, _ = capture(library)
    monkeypatch.setattr(service, "request_metadata", lambda *a: {"title": "窗影白裙", "collection": None})
    service.run_job(library, str(fields.request_id))
    assert service.OrganizerConfig(library).public()["last_result"]["status"] == "succeeded"
    configure(library, model="another-model")
    assert service.OrganizerConfig(library).public()["last_result"] is None


@pytest.mark.parametrize("startup_failure", [False, True])
def test_shutdown_keeps_library_lease_until_active_request_settles(setup, monkeypatch, startup_failure):
    library, client = setup
    configure(library)
    _, first, _ = capture(library)
    _, second, _ = capture(library)
    entered, release, closing, closed = (threading.Event() for _ in range(4))
    calls = []
    def remote(*args):
        calls.append(1)
        entered.set()
        assert release.wait(5)
        return {"title": "窗影白裙", "collection": None}
    monkeypatch.setattr(service, "request_metadata", remote)
    monkeypatch.setattr(service, "enqueue_jobs", REAL_ENQUEUE)
    if startup_failure:
        def fail_recovery(*args, **kwargs):
            assert entered.wait(3)
            closing.set()
            raise RuntimeError("fixture startup failure")
        monkeypatch.setattr(app_module, "recover_interrupted_generation_jobs", fail_recovery)
    def lifecycle():
        if startup_failure:
            with pytest.raises(RuntimeError, match="fixture startup failure"):
                with client:
                    pass
        else:
            with client:
                assert entered.wait(3)
                closing.set()
        closed.set()
    with ThreadPoolExecutor(max_workers=1) as pool:
        lifecycle_future = pool.submit(lifecycle)
        try:
            assert closing.wait(3)
            assert not closed.wait(0.1)
            with pytest.raises(LibraryArchiveError):
                with LibraryOperationLock(library):
                    pass
        finally:
            release.set()
        lifecycle_future.result(timeout=5)
    assert closed.is_set() and len(calls) == 1
    assert service.receipt_status(library, first.request_id)["status"] == "succeeded"
    assert service.receipt_status(library, second.request_id)["status"] == "pending"
    with LibraryOperationLock(library):
        pass


def test_manual_title_wins_and_new_collections_can_be_disabled(setup, monkeypatch):
    library, _ = setup
    configure(library, allow_new_collections=False)
    item, fields, _ = capture(library, title="用户的名字")
    monkeypatch.setattr(service, "request_metadata", lambda *a: {"title": "模型的名字", "collection": "不该创建"})
    service.run_job(library, str(fields.request_id))
    final = ItemRepository(library).get_item(item.id)
    assert final.title == "用户的名字" and final.cluster is None


def test_existing_collection_deleted_during_analysis_is_not_recreated(setup, monkeypatch):
    library, _ = setup
    configure(library)
    item, fields, _ = capture(library)
    with connect(library) as conn:
        ItemRepository(library).ensure_cluster(conn, "已删除的分类")
        conn.commit()
    def remote(settings, prompt, title, image, collections):
        assert "已删除的分类" in collections
        with connect(library) as conn:
            conn.execute("DELETE FROM clusters WHERE name='已删除的分类'")
            conn.commit()
        return {"title": "窗影白裙", "collection": "已删除的分类"}
    monkeypatch.setattr(service, "request_metadata", remote)
    service.run_job(library, str(fields.request_id))
    assert ItemRepository(library).get_item(item.id).cluster is None
    with connect(library) as conn:
        assert not conn.execute("SELECT id FROM clusters WHERE name='已删除的分类'").fetchone()


@pytest.mark.parametrize("edit", ["title", "prompt", "collection", "image"])
def test_manual_edits_during_remote_call_are_never_overwritten(setup, monkeypatch, edit):
    library, _ = setup
    configure(library)
    item, fields, _ = capture(library)
    def metadata(*args):
        with connect(library) as conn:
            if edit == "title":
                conn.execute("UPDATE items SET title='手动标题' WHERE id=?", (item.id,))
            elif edit == "prompt":
                conn.execute("UPDATE prompts SET text='手动改词' WHERE item_id=?", (item.id,))
            elif edit == "collection":
                cluster = ItemRepository(library).ensure_cluster(conn, "用户分类")
                conn.execute("UPDATE items SET cluster_id=? WHERE id=?", (cluster, item.id))
            else:
                conn.execute("UPDATE images SET sort_order=9 WHERE item_id=?", (item.id,))
            conn.commit()
        return {"title": "不应该覆盖", "collection": "不应该创建"}
    monkeypatch.setattr(service, "request_metadata", metadata)
    service.run_job(library, str(fields.request_id))
    final = ItemRepository(library).get_item(item.id)
    assert final.title != "不应该覆盖"
    assert service.receipt_status(library, fields.request_id)["status"] == "skipped"
    with connect(library) as conn:
        assert not conn.execute("SELECT id FROM clusters WHERE name='不应该创建'").fetchone()


def test_uncertain_and_restarted_requests_are_not_retried(setup, monkeypatch):
    library, _ = setup
    configure(library)
    _, fields, _ = capture(library)
    calls = []
    def timeout(*args):
        calls.append(1)
        raise service.RemoteFailure("timeout")
    monkeypatch.setattr(service, "request_metadata", timeout)
    service.run_job(library, str(fields.request_id))
    service.recover_jobs(library)
    service.run_job(library, str(fields.request_id))
    assert len(calls) == 1 and service.receipt_status(library, fields.request_id)["status"] == "uncertain"
    _, other, _ = capture(library)
    with connect(library) as conn:
        conn.execute("UPDATE capture_organizer_jobs SET status='running' WHERE request_id=?", (str(other.request_id),))
        conn.commit()
    service.recover_jobs(library)
    service.run_job(library, str(other.request_id))
    assert len(calls) == 1 and service.receipt_status(library, other.request_id)["category"] == "interrupted"


@pytest.mark.parametrize("kind,category", [("redirect", "http_error"), ("auth", "authentication"),
    ("oversize", "response_too_large"), ("invalid", "invalid_response"), ("secret", "invalid_response"),
    ("timeout", "timeout"), ("success", None)])
def test_actual_transport_is_bounded_no_redirect_or_retry_and_redacts_errors(setup, monkeypatch, kind, category):
    library, _ = setup
    configure(library)
    calls = []
    original_client = httpx.Client
    def handler(request):
        calls.append(request)
        assert str(request.url) == "https://example.invalid/v1/chat/completions"
        assert request.headers["authorization"] == "Bearer " + SECRET
        body = json.loads(request.content)
        assert body["model"] == "gpt-6-luna" and body["messages"][1]["content"][0]["text"]
        if kind == "redirect":
            return httpx.Response(307, headers={"Location": "https://evil.invalid/"})
        if kind == "auth":
            return httpx.Response(401, text=SECRET)
        if kind == "oversize":
            return httpx.Response(200, content=b"x" * (service._MAX_RESPONSE + 1))
        if kind == "invalid":
            return httpx.Response(200, json={"message": SECRET})
        if kind == "timeout":
            raise httpx.ReadTimeout(SECRET)
        return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps({"title": SECRET if kind == "secret" else "窗影白裙", "collection": None})}}]})
    monkeypatch.setattr(httpx, "Client", lambda **kwargs: original_client(transport=httpx.MockTransport(handler), **kwargs))
    settings = service.OrganizerConfig(library).read()
    if category:
        with pytest.raises(service.RemoteFailure) as raised:
            service.request_metadata(settings, "prompt", "title", "data:image/png;base64,AA==", [])
        assert raised.value.category == category and SECRET not in str(raised.value)
    else:
        assert service.request_metadata(settings, "prompt", "title", "data:image/png;base64,AA==", [])["title"] == "窗影白裙"
    assert len(calls) == 1


def _install_transport(monkeypatch, handler):
    original_client = httpx.Client
    def client(**kwargs):
        assert kwargs["follow_redirects"] is False
        return original_client(transport=httpx.MockTransport(handler), **kwargs)
    monkeypatch.setattr(httpx, "Client", client)


def _metadata_response(title="合成色块连接测试"):
    return httpx.Response(200, json={"choices": [{"message": {
        "content": json.dumps({"title": title, "collection": None})}}]})


def test_saved_configuration_test_uses_synthetic_inputs_once_without_library_reads_or_mutations(setup, monkeypatch):
    library, client = setup
    configure(library, enabled=False, model="gpt6-luna")
    config_path = resolve_capture_organizer_config_path(library)
    config_before, database_before = config_path.read_bytes(), (library / "db.sqlite").read_bytes()
    calls = []
    def handler(request):
        calls.append(request)
        assert request.method == "POST" and str(request.url) == "https://example.invalid/v1/chat/completions"
        body = json.loads(request.content)
        assert body["model"] == "gpt6-luna"  # Existing alias is not silently migrated.
        content = body["messages"][1]["content"]
        instruction = json.loads(content[0]["text"])
        assert instruction["existing_collections"] == [] and instruction["existing_title"] == ""
        assert "synthetic connection test" in instruction["original_prompt"]
        assert "private prompt" not in json.dumps(body)
        image_url = content[1]["image_url"]["url"]
        assert image_url.startswith("data:image/png;base64,")
        with Image.open(BytesIO(base64.b64decode(image_url.split(",", 1)[1]))) as image:
            image.load()
            assert image.size == (64, 64) and image.mode == "RGB"
            assert image.getpixel((12, 20)) != image.getpixel((40, 20))
        return _metadata_response()
    _install_transport(monkeypatch, handler)
    monkeypatch.setattr(service, "connect", lambda *a, **k: pytest.fail("Connection test must not read library DB"))
    response = client.post("/api/capture-organizer/test", headers={"Origin": TARGET}, json={"prompt": "private prompt"})
    assert response.status_code == 200 and response.headers["cache-control"] == "no-store"
    result = response.json()
    assert set(result) == {"status", "model", "elapsed_seconds", "category", "http_status"}
    assert result["status"] == "succeeded" and result["category"] == "" and result["http_status"] == 200
    assert result["model"] == "gpt6-luna" and result["elapsed_seconds"] >= 0
    assert SECRET not in response.text and "合成色块" not in response.text
    assert len(calls) == 1
    assert config_path.read_bytes() == config_before and (library / "db.sqlite").read_bytes() == database_before


@pytest.mark.parametrize("case,category,status", [
    ("authentication", "authentication", 401), ("rate_limit", "rate_limit", 429),
    ("model", "model", 404), ("endpoint", "http_error", 404),
    ("redirect", "http_error", 307), ("upstream", "http_error", 503),
    ("invalid_json", "invalid_response", 200), ("secret_result", "invalid_response", 200),
    ("oversize", "invalid_response", 200), ("timeout", "timeout", None),
    ("connection", "connection", None),
])
def test_saved_configuration_test_sanitizes_diagnostics_and_never_retries(setup, monkeypatch, case, category, status):
    library, client = setup
    configure(library)
    calls = []
    def handler(request):
        calls.append(request)
        if case == "timeout":
            raise httpx.ReadTimeout("credential=" + SECRET)
        if case == "connection":
            raise httpx.ConnectError("credential=" + SECRET)
        if case == "invalid_json":
            return httpx.Response(200, json={"choices": [{"message": {"content": SECRET}}]})
        if case == "secret_result":
            return _metadata_response(SECRET)
        if case == "oversize":
            return httpx.Response(200, content=b"x" * (service._MAX_RESPONSE + 1))
        if case == "model":
            return httpx.Response(status, json={"error": {"code": "model_not_found", "message": SECRET}})
        if case == "endpoint":
            return httpx.Response(status, json={"error": {"code": "not_found", "message": "model " + SECRET}})
        return httpx.Response(status, text=SECRET, headers={"Location": "https://hostile.invalid/"})
    _install_transport(monkeypatch, handler)
    result = client.post("/api/capture-organizer/test", headers={"Origin": TARGET})
    assert result.status_code == 200
    assert result.json()["status"] == "failed" and result.json()["category"] == category
    assert result.json()["http_status"] == status and result.json()["elapsed_seconds"] >= 0
    assert SECRET not in result.text and "hostile.invalid" not in result.text
    assert len(calls) == 1
    with connect(library) as conn:
        assert conn.execute("SELECT count(*) FROM capture_organizer_jobs").fetchone()[0] == 0


def test_saved_configuration_test_missing_or_corrupt_config_has_no_external_request(setup, monkeypatch):
    library, client = setup
    monkeypatch.setattr(service, "request_metadata", lambda *a, **k: pytest.fail("No model call without valid configuration"))
    response = client.post("/api/capture-organizer/test", headers={"Origin": TARGET})
    assert response.json()["category"] == "configuration" and response.json()["model"] == "gpt-6-luna"
    path = resolve_capture_organizer_config_path(library)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("credential=" + SECRET, encoding="utf-8")
    response = client.post("/api/capture-organizer/test", headers={"Origin": TARGET})
    assert response.json()["category"] == "configuration" and response.json()["http_status"] is None
    assert SECRET not in response.text


@pytest.mark.parametrize("origin", [None, "https://hostile.invalid", "http://localhost:8123"])
def test_real_test_requires_explicit_same_origin_local_authorization(setup, monkeypatch, origin):
    _, client = setup
    monkeypatch.setattr(service, "request_metadata", lambda *a, **k: pytest.fail("Unauthorized request cannot call model"))
    response = client.post("/api/capture-organizer/test", headers={"Origin": origin} if origin else {})
    assert response.status_code == 403


def test_real_test_rejects_lan_peer(setup, monkeypatch):
    _, client = setup
    monkeypatch.setattr(service, "request_metadata", lambda *a, **k: pytest.fail("Remote peer cannot call model"))
    remote_client = TestClient(client.app, base_url=TARGET, client=("192.168.1.80", 54321))
    assert remote_client.post("/api/capture-organizer/test", headers={"Origin": TARGET}).status_code == 403


@pytest.mark.parametrize("first_fails", [False, True])
def test_real_test_serializes_same_library_clicks_and_releases_lock(setup, monkeypatch, first_fails):
    library, _ = setup
    configure(library)
    entered, release = threading.Event(), threading.Event()
    calls = []
    def handler(request):
        calls.append(request)
        if len(calls) == 1:
            entered.set()
            assert release.wait(3)
            if first_fails:
                raise httpx.ReadTimeout(SECRET)
        return _metadata_response()
    _install_transport(monkeypatch, handler)
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(service.test_saved_configuration, library)
        assert entered.wait(3)
        busy = service.test_saved_configuration(library)
        assert busy["status"] == "failed" and busy["category"] == "busy" and busy["http_status"] is None
        assert len(calls) == 1
        release.set()
        assert first.result(timeout=3)["status"] == ("failed" if first_fails else "succeeded")
    assert service.test_saved_configuration(library)["status"] == "succeeded"
    assert len(calls) == 2  # A later deliberate test is allowed; no automatic retry.


@pytest.mark.parametrize("status", [200, 404])
def test_small_response_chunks_enforce_elapsed_timeout_without_buffering(setup, monkeypatch, status):
    library, _ = setup
    configure(library, timeout_seconds=10)
    clock = SimpleNamespace(now=0.0)
    monkeypatch.setattr(service, "time", SimpleNamespace(monotonic=lambda: clock.now))
    emitted = []
    class SlowStream(httpx.SyncByteStream):
        def __iter__(self):
            for index in range(100):
                clock.now += 4
                emitted.append(index)
                yield b"x"
    calls = []
    def handler(request):
        calls.append(request)
        return httpx.Response(status, stream=SlowStream())
    _install_transport(monkeypatch, handler)
    with pytest.raises(service.RemoteFailure) as raised:
        service.request_metadata(service.OrganizerConfig(library).read(), "synthetic", "", "data:image/png;base64,AA==", [])
    assert raised.value.category == "timeout" and raised.value.http_status == status
    assert emitted == [0, 1, 2] and len(calls) == 1


def test_error_response_body_stops_at_bound_before_consuming_rest(setup, monkeypatch):
    library, _ = setup
    configure(library)
    emitted = []
    class ErrorStream(httpx.SyncByteStream):
        def __iter__(self):
            for index in range(100):
                emitted.append(index)
                yield b"x" * 4096
    _install_transport(monkeypatch, lambda request: httpx.Response(404, stream=ErrorStream()))
    with pytest.raises(service.RemoteFailure) as raised:
        service.request_metadata(service.OrganizerConfig(library).read(), "synthetic", "", "data:image/png;base64,AA==", [])
    assert raised.value.category == "http_error" and raised.value.http_status == 404
    assert emitted == [0, 1, 2, 3, 4]
