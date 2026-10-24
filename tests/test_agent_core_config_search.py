"""Agent configuration isolation and server-side conversation search regressions."""
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from threading import Thread
import time

from fastapi.testclient import TestClient
import httpx
import pytest

from backend.db import connect
from backend.main import create_app
from backend.services.agent_repository import AgentRepository, encoded
from backend.services.openai_compatible import OpenAICompatibleConfig


@pytest.fixture
def library(tmp_path, monkeypatch):
    for name in ("AUTH_PATH", "GROK_AUTH_PATH", "CONFIG_PATH", "OPENAI_COMPATIBLE_CONFIG_PATH",
                 "CAPTURE_CLIENTS_PATH", "CAPTURE_ORGANIZER_CONFIG_PATH"):
        monkeypatch.setenv("IMAGE_PROMPT_LIBRARY_" + name, str(tmp_path / "config" / (name + ".json")))
    original = httpx.HTTPTransport.handle_request

    def local_only(self, request):
        assert request.url.host in {"127.0.0.1", "localhost"}
        assert request.url.port != 8000
        return original(self, request)

    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", local_only)
    return tmp_path / "library"


@contextmanager
def text_provider():
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            requests.append((self.path, body))
            assert self.path == "/v1/responses"
            data = encoded({"id": "response", "output": [{"type": "message", "role": "assistant",
                "content": [{"type": "output_text", "text": "A searchable answer: 青绿色"}]}]}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/v1", requests
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def configure(client, library, url, **changes):
    profiles = OpenAICompatibleConfig(library_path=library)
    profiles.save({"base_url": url, "api_key": "synthetic-text-key", "model": "other-default",
                   "make_default": True}, profile_id="text")
    profiles.save({"base_url": url, "api_key": "synthetic-image-key", "model": "image-default"}, profile_id="image")
    document = client.get("/api/agent/config").json()
    config = {**document["config"], "apiConfigMode": "hybrid", "textProfileId": "text",
              "imageProfileId": "image", "textModel": "text-model", "imageModel": "", "stream": False, **changes}
    saved = client.put("/api/agent/config", json={"expectedRevision": document["revision"], "config": config})
    assert saved.status_code == 200, saved.text
    return saved.json(), profiles


def round_body(snapshot, config, *, images=False, request_id="request"):
    return {"requestId": request_id, "expectedRevision": snapshot["revision"], "configRevision": config["revision"],
            "prompt": "A user prompt: 深蓝色", "refs": [], "params": {},
            "authorization": {"scope": "this_request", "allowImageGeneration": images,
                              "maxToolRounds": 3, "maxImageJobs": 1 if images else 0}}


def wait_request(client, request_id="request"):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        result = client.get("/api/agent/requests/" + request_id).json()
        if result["request"]["state"] not in {"queued", "running", "waiting_for_jobs", "stop_requested"}:
            return result
        time.sleep(0.02)
    raise AssertionError("Local mock Agent request did not complete")


@pytest.mark.parametrize("missing", ["deleted", "unselected", "credentials"])
def test_hybrid_text_only_works_without_image_profile_and_reports_image_readiness(library, missing):
    with text_provider() as (url, requests), TestClient(create_app(library)) as client:
        config, profiles = configure(client, library, url, **({"imageProfileId": None} if missing == "unselected" else {}))
        if missing == "deleted":
            profiles.delete("image")
        elif missing == "credentials":
            profiles.save({"remove_api_key": True}, profile_id="image")
        snapshot = client.post("/api/agent/conversations", json={"id": "conv"}).json()
        response = client.post("/api/agent/conversations/conv/rounds", json=round_body(snapshot, config))
        assert response.status_code == 202, response.text
        result = wait_request(client)
        assert result["request"]["state"] == "completed", result
        assert result["jobs"] == []
        assert len(requests) == 1 and requests[0][1]["model"] == "text-model"
        assert not any(t.get("name", "").startswith("generate_image") or t["type"] == "image_generation"
                       for t in requests[0][1].get("tools", []))
        frozen = AgentRepository(library).request("request")["frozen"]
        assert set(frozen["_profileDigests"]) == {"text"}
        assert frozen["imageProfileId"] is None
        document = client.get("/api/agent/config").json()
        assert document["ready"] is True and document["issues"] == []
        assert document["imageReady"] is False
        assert [issue["field"] for issue in document["imageIssues"]] == ["imageProfileId"]
        assert "synthetic-" not in encoded(result)
        for query in ("深蓝色", "青绿色"):
            found = client.get("/api/agent/conversations", params={"q": query}).json()
            assert [c["id"] for c in found["conversations"]] == ["conv"]


@pytest.mark.parametrize("missing", ["deleted", "unselected", "credentials", "model"])
def test_hybrid_image_authorization_requires_its_selected_profile_without_default_fallback(library, missing, monkeypatch):
    import backend.routers.agent as routes
    scheduled = []
    monkeypatch.setattr(routes, "schedule_request", lambda *args: scheduled.append(args))
    with TestClient(create_app(library)) as client:
        config, profiles = configure(client, library, "http://127.0.0.1:1/v1",
                                     **({"imageProfileId": None} if missing == "unselected" else {}))
        if missing == "deleted":
            profiles.delete("image")
        elif missing == "credentials":
            profiles.save({"remove_api_key": True}, profile_id="image")
        elif missing == "model":
            profiles.save({"model": ""}, profile_id="image")
        snapshot = client.post("/api/agent/conversations", json={"id": "conv"}).json()
        result = client.post("/api/agent/conversations/conv/rounds", json=round_body(snapshot, config, images=True))
        assert result.status_code == 400, result.text
        assert result.json()["detail"]["code"] == "configuration_incomplete"
        assert scheduled == []
        document = client.get("/api/agent/config").json()
        assert document["ready"] is True and document["imageReady"] is False
        assert document["imageIssues"][0]["field"] == ("imageModel" if missing == "model" else "imageProfileId")


def test_hybrid_image_model_fallback_and_frozen_profile_are_provider_specific(library, monkeypatch):
    import backend.routers.agent as routes
    monkeypatch.setattr(routes, "schedule_request", lambda *args: None)
    with TestClient(create_app(library)) as client:
        config, profiles = configure(client, library, "http://127.0.0.1:1/v1")
        assert config["ready"] is True and config["imageReady"] is True and config["imageIssues"] == []
        snapshot = client.post("/api/agent/conversations", json={"id": "conv"}).json()
        result = client.post("/api/agent/conversations/conv/rounds", json=round_body(snapshot, config, images=True))
        assert result.status_code == 202, result.text
        repo = AgentRepository(library)
        request = repo.request("request")
        assert request["frozen"]["imageModel"] == "image-default"
        assert request["frozen"]["imageProfileId"] == "image"
        assert set(request["frozen"]["_profileDigests"]) == {"image", "text"}
        profiles.save({"model": "changed-image"}, profile_id="image")
        from backend.services.agent_repository import AgentError
        with pytest.raises(AgentError, match="本轮 API 配置已改变"):
            repo.verified_profile(request, image=True)


@pytest.mark.parametrize("mode", ["native", "off"])
def test_native_and_current_profile_modes_do_not_require_a_separate_image_profile(library, mode, monkeypatch):
    import backend.routers.agent as routes
    monkeypatch.setattr(routes, "schedule_request", lambda *args: None)
    with TestClient(create_app(library)) as client:
        config, profiles = configure(client, library, "http://127.0.0.1:1/v1", apiConfigMode=mode, imageProfileId="deleted")
        profiles.delete("image")
        assert config["ready"] is True and config["imageReady"] is True and config["imageIssues"] == []
        snapshot = client.post("/api/agent/conversations", json={"id": "conv"}).json()
        body = {**round_body(snapshot, config, images=True), "activeProfileId": "text"}
        result = client.post("/api/agent/conversations/conv/rounds", json=body)
        assert result.status_code == 202, result.text
        assert result.json()["request"]["frozenConfig"]["imageProfileId"] == "text"


def test_text_only_resume_survives_image_profile_removal_but_still_checks_text_profile(library, monkeypatch):
    import backend.routers.agent as routes
    schedule = routes.schedule_request
    monkeypatch.setattr(routes, "schedule_request", lambda *args: None)
    with text_provider() as (url, requests), TestClient(create_app(library)) as client:
        config, profiles = configure(client, library, url)
        snapshot = client.post("/api/agent/conversations", json={"id": "conv"}).json()
        assert client.post("/api/agent/conversations/conv/rounds", json=round_body(snapshot, config)).status_code == 202
        repo = AgentRepository(library)
        repo.update("request", state="interrupted", outcome="not_sent")
        profiles.delete("image")
        monkeypatch.setattr(routes, "schedule_request", schedule)
        assert client.post("/api/agent/requests/request/resume", json={"resumeId": "resume"}).status_code == 202
        result = wait_request(client)
        assert result["request"]["state"] == "completed", result
        assert len(requests) == 1
        monkeypatch.setattr(routes, "schedule_request", lambda *args: None)
        body = round_body(result, config, request_id="changed")
        assert client.post("/api/agent/conversations/conv/rounds", json=body).status_code == 202
        repo.update("changed", state="interrupted", outcome="not_sent")
        profiles.save({"model": "new-text-default"}, profile_id="text")
        monkeypatch.setattr(routes, "schedule_request", schedule)
        assert client.post("/api/agent/requests/changed/resume", json={"resumeId": "resume_changed"}).status_code == 202
        result = wait_request(client, "changed")
        assert result["request"]["error"]["code"] == "profile_changed"
        assert len(requests) == 1


def seed_conversation(conn, cid, *, title="新对话", prompt="", answer="", tool="", updated=1, deleted=0, round_deleted=0):
    conn.execute("INSERT INTO agent_conversations(id,title,created_at,updated_at,deleted) VALUES(?,?,1,?,?)",
                 (cid, title, updated, deleted))
    data = {"prompt": prompt, "assistantContent": answer, "responseOutput": [{"type": "function_call", "arguments": tool}]}
    conn.execute("INSERT INTO agent_rounds(id,conversation_id,request_id,data,deleted) VALUES(?,?,?,?,?)",
                 ("round_" + cid, cid, "request_" + cid, encoded(data), round_deleted))


def test_searches_all_conversations_and_body_fields_with_existing_pagination(library):
    with TestClient(create_app(library)) as client:
        with connect(library) as conn:
            for i in range(130):
                seed_conversation(conn, f"recent_{i:03d}", updated=1000 + i)
            seed_conversation(conn, "title", title="Target topic", updated=30)
            seed_conversation(conn, "prompt", prompt="A TARGET prompt", updated=20)
            seed_conversation(conn, "answer", answer="The target answer", updated=10)
            seed_conversation(conn, "tool", tool="target", updated=40)
            seed_conversation(conn, "deleted_conversation", prompt="target", deleted=1)
            seed_conversation(conn, "deleted_round", answer="target", round_deleted=1)
        initial = client.get("/api/agent/conversations", params={"limit": 100}).json()
        assert "answer" not in {c["id"] for c in initial["conversations"]}
        first = client.get("/api/agent/conversations", params={"q": " target ", "limit": 2}).json()
        assert [c["id"] for c in first["conversations"]] == ["title", "prompt"]
        assert first["nextCursor"] == "2"
        second = client.get("/api/agent/conversations", params={"q": "target", "limit": 2, "cursor": first["nextCursor"]}).json()
        assert [c["id"] for c in second["conversations"]] == ["answer"]
        assert second["nextCursor"] is None
        assert all(set(c) == {"id", "title", "activeRoundId", "createdAt", "updatedAt", "revision", "roundCount", "runningRequestId"}
                   for c in first["conversations"] + second["conversations"])
        assert client.get("/api/agent/conversations", params={"q": "   ", "limit": 100}).json() == initial


@pytest.mark.parametrize("query", ["%", "_", "\\", "' OR 1=1 --", "青绿色", "x" * 200])
def test_search_treats_wildcards_and_sql_as_literal_text(library, query):
    with TestClient(create_app(library)) as client:
        with connect(library) as conn:
            seed_conversation(conn, "match", answer="before " + query + " after")
            seed_conversation(conn, "other", title="Another conversation")
        result = client.get("/api/agent/conversations", params={"q": query})
        assert result.status_code == 200, result.text
        assert [c["id"] for c in result.json()["conversations"]] == ["match"]


def test_search_rejects_oversized_query(library):
    with TestClient(create_app(library)) as client:
        assert client.get("/api/agent/conversations", params={"q": "x" * 201}).status_code == 422
