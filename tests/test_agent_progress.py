"""Durable model identities and read-only Agent progress delivery."""
import json

from fastapi.testclient import TestClient
import pytest

from backend.db import connect
from backend.main import create_app
from backend.services.agent_repository import AgentRepository
from backend.services.agent_progress import limited_view
from backend.services.openai_compatible import OpenAICompatibleConfig
from test_agent_workspaces import configure, isolated, payload, provider, wait_request


def small_snapshot(revision=1, state='running', text=''):
    return {'schemaVersion': 1, 'revision': revision,
            'conversation': {'id': 'conv', 'title': 'Synthetic', 'activeRoundId': 'round', 'createdAt': 1, 'updatedAt': revision,
                             'rounds': [{'id': 'round', 'inputImageIds': [], 'outputTaskIds': []}],
                             'messages': [{'id': 'message', 'roundId': 'round', 'role': 'assistant', 'content': text}]},
            'request': {'id': 'req', 'conversationId': 'conv', 'roundId': 'round', 'state': state},
            'images': [], 'jobs': [], 'editingTask': None}


@pytest.mark.parametrize("api_mode", ["off", "native", "hybrid"])
@pytest.mark.parametrize("stream", [False, True])
@pytest.mark.parametrize("returned_model", [None, "actual-served-model"])
def test_round_model_identity_uses_frozen_request_and_actual_upstream_metadata(isolated, api_mode, stream, returned_model):
    with provider("text", response_model=returned_model, stream_text=stream) as (url, requests), TestClient(create_app(isolated)) as client:
        config = configure(client, isolated, url, api_mode)
        config = client.put("/api/agent/config", json={"expectedRevision": config["revision"],
                            "config": {**config["config"], "stream": stream}}).json()
        snapshot = client.post("/api/agent/conversations", json={"id": "conv"}).json()
        body = payload(snapshot, config, images=False)
        if api_mode == "off":
            body["activeProfileId"] = "mock"
        assert client.post("/api/agent/conversations/conv/rounds", json=body).status_code == 202
        result = wait_request(client, body["requestId"])
        assert result["request"]["state"] == "completed", result
        expected = {"requestedModel": "mock-text", "providerName": "Local mock",
                    "returnedModels": [returned_model] if returned_model else []}
        assert result["request"]["modelInfo"] == expected
        assert result["conversation"]["rounds"][0]["modelInfo"] == expected
        assert requests[0][1]["model"] == "mock-text"
        assert len(requests) == 1
        profiles = OpenAICompatibleConfig(library_path=isolated)
        profiles.save({"display_name": "Renamed later", "model": "later-default"}, profile_id="mock")
        restored = AgentRepository(isolated).snapshot("conv")
        assert restored["request"]["modelInfo"] == expected
        assert restored["conversation"]["rounds"][0]["modelInfo"] == expected
        assert "unit-test-key-not-real" not in json.dumps(restored)


def test_sse_created_model_is_preserved_without_completion_model_and_is_redacted(isolated):
    with provider("text", stream_text=True, created_model="served-unit-test-key-not-real\nmodel") as (url, requests), TestClient(create_app(isolated)) as client:
        config = configure(client, isolated, url)
        snapshot = client.post("/api/agent/conversations", json={"id": "conv"}).json()
        assert client.post("/api/agent/conversations/conv/rounds", json=payload(snapshot, config, images=False)).status_code == 202
        result = wait_request(client, "req_1")
        assert result["request"]["modelInfo"]["returnedModels"] == ["served-[redacted]model"]
        assert "unit-test-key-not-real" not in json.dumps(result)
        with connect(isolated) as conn:
            saved = conn.execute("SELECT data FROM agent_rounds").fetchone()[0]
        assert "unit-test-key-not-real" not in saved
        assert len(requests) == 1


def test_legacy_round_model_does_not_invent_provider_name_or_returned_model(isolated):
    with provider("text") as (url, requests), TestClient(create_app(isolated)) as client:
        config = configure(client, isolated, url)
        snapshot = client.post("/api/agent/conversations", json={"id": "conv"}).json()
        assert client.post("/api/agent/conversations/conv/rounds", json=payload(snapshot, config, images=False)).status_code == 202
        wait_request(client, "req_1")
        with connect(isolated) as conn:
            frozen = json.loads(conn.execute("SELECT frozen FROM agent_requests").fetchone()[0])
            frozen.pop("_textProviderName")
            conn.execute("UPDATE agent_requests SET frozen=?", (json.dumps(frozen),))
            data = json.loads(conn.execute("SELECT data FROM agent_rounds").fetchone()[0])
            data.pop("modelInfo", None)
            conn.execute("UPDATE agent_rounds SET data=?", (json.dumps(data),))
        result = client.get("/api/agent/conversations/conv").json()
        expected = {"requestedModel": "mock-text", "providerName": None, "returnedModels": []}
        assert result["request"]["modelInfo"] == expected
        assert result["conversation"]["rounds"][0]["modelInfo"] == expected
        assert len(requests) == 1


def test_progress_endpoint_replays_terminal_snapshot_without_upstream_requests(isolated, monkeypatch):
    import backend.routers.agent as routes
    with provider("text", response_model="served-model") as (url, requests), TestClient(create_app(isolated)) as client:
        config = configure(client, isolated, url)
        assert config["capabilities"]["progressTransport"] == "sse"
        snapshot = client.post("/api/agent/conversations", json={"id": "conv"}).json()
        assert client.post("/api/agent/conversations/conv/rounds", json=payload(snapshot, config, images=False)).status_code == 202
        result = wait_request(client, "req_1")
        monkeypatch.setattr(routes, "schedule_request", lambda *args: pytest.fail("A progress read scheduled provider work"))
        monkeypatch.setattr(routes, "stop_request", lambda *args: pytest.fail("A progress read stopped provider work"))
        epochs = []
        for cursor in ('expired:999999', 'foreign-backend:0'):
            response = client.get("/api/agent/requests/req_1/events", headers={'Last-Event-ID': cursor})
            assert response.status_code == 200
            assert response.headers["content-type"].startswith("text/event-stream")
            assert response.headers["cache-control"] == "no-store"
            assert response.text.count("event: snapshot") == 1
            restored = json.loads(response.text.split("data: ", 1)[1])
            stream = restored.pop('stream')
            assert stream['version'] == 1 and stream['sequence'] == 0
            epochs.append(stream['epoch'])
            assert stream['view'] == limited_view(result)
            assert restored == result
        assert epochs[0] != epochs[1]
        assert len(requests) == 1
        assert client.get("/api/agent/requests/missing/events").status_code == 404
        assert client.get("/api/agent/requests/req_1/events", headers={"host": "untrusted.invalid"}).status_code == 400
        assert client.get("/api/agent/requests/req_1/events", headers={"origin": "chrome-extension://untrusted"}).status_code == 403


def test_progress_stream_coalesces_changes_heartbeats_and_closes_on_terminal(monkeypatch):
    import asyncio
    import backend.routers.agent as routes
    monkeypatch.setattr(routes, "PROGRESS_INTERVAL", 0.001)
    monkeypatch.setattr(routes, "PROGRESS_HEARTBEAT", 0)
    snapshots = [small_snapshot(), small_snapshot(2, 'completed', 'A finished answer')]
    class Request:
        async def is_disconnected(self):
            return False
    class Repository:
        reads = 0
        snapshots = 0
        def progress_token(self, _request_id):
            self.reads += 1
            return 1 if self.reads == 1 else 2
        def snapshot(self, **_kwargs):
            self.snapshots += 1
            pytest.fail('Normal progress assembled full history')
        def progress_structure(self, _request_id):
            return 'stable'
        def progress_view(self, _request_id):
            return limited_view(snapshots[1])
    repository = Repository()
    async def observe():
        return [event async for event in routes.progress_events(Request(), repository, "req", 1, snapshots[0])]
    events = asyncio.run(observe())
    assert [event.splitlines()[0] for event in events] == ["event: snapshot", "event: heartbeat", "event: heartbeat", "event: patch"]
    patch = json.loads(events[-1].split('data: ', 1)[1])
    assert patch['sequence'] == 1 and patch['baseSequence'] == 0
    assert {'op': 'replace', 'path': ['request', 'state'], 'value': 'completed'} in patch['operations']
    assert any(op['path'] == ['messages', 0, 'content'] and op['value'] == 'A finished answer' for op in patch['operations'])
    assert repository.snapshots == 0


def test_progress_stream_disconnect_does_not_change_durable_request(isolated, monkeypatch):
    import asyncio
    import backend.routers.agent as routes
    monkeypatch.setattr(routes, "schedule_request", lambda *args: None)
    monkeypatch.setattr(routes, "PROGRESS_INTERVAL", 0.001)
    with TestClient(create_app(isolated)) as client:
        config = configure(client, isolated, "http://127.0.0.1:1/v1")
        snapshot = client.post("/api/agent/conversations", json={"id": "conv"}).json()
        assert client.post("/api/agent/conversations/conv/rounds", json=payload(snapshot, config, images=False)).status_code == 202
        repository = AgentRepository(isolated)
        before = repository.request("req_1")
        class Request:
            disconnected = False
            async def is_disconnected(self):
                return self.disconnected
        async def observe():
            request = Request()
            stream = routes.progress_events(request, repository, "req_1", repository.progress_token("req_1"),
                                            repository.snapshot(request_id="req_1"))
            assert (await anext(stream)).startswith("event: snapshot")
            request.disconnected = True
            assert [event async for event in stream] == []
        asyncio.run(observe())
        assert repository.request("req_1") == before


def test_progress_reads_leave_event_loop_responsive_and_support_cancellation(monkeypatch):
    import asyncio
    from threading import Event
    import backend.routers.agent as routes
    monkeypatch.setattr(routes, "PROGRESS_INTERVAL", 0.001)
    started, released = Event(), Event()
    class Request:
        async def is_disconnected(self):
            return False
    class Repository:
        def progress_structure(self, _request_id):
            return 'stable'
        def progress_token(self, _request_id):
            started.set()
            assert released.wait(2), "Progress database read blocked the event loop"
            return 1
    async def observe():
        stream = routes.progress_events(Request(), Repository(), "req", 1, small_snapshot())
        await anext(stream)
        pending = asyncio.create_task(anext(stream))
        try:
            deadline = asyncio.get_running_loop().time() + 1
            while not started.is_set():
                assert asyncio.get_running_loop().time() < deadline
                await asyncio.sleep(0.001)
            # This task must be runnable while the synchronous read is blocked.
            released.set()
            pending.cancel()
            with pytest.raises(asyncio.CancelledError):
                await pending
        finally:
            released.set()
            await stream.aclose()
    asyncio.run(observe())


def test_progress_token_observes_job_changes_without_conversation_revision(isolated):
    with provider("hybrid") as (url, requests), TestClient(create_app(isolated)) as client:
        config = configure(client, isolated, url)
        snapshot = client.post("/api/agent/conversations", json={"id": "conv"}).json()
        assert client.post("/api/agent/conversations/conv/rounds", json=payload(snapshot, config)).status_code == 202
        result = wait_request(client, "req_1")
        repository = AgentRepository(isolated)
        before = repository.progress_token("req_1")
        with connect(isolated) as conn:
            conn.execute("UPDATE generation_jobs SET status='discarded' WHERE id=?", (result["jobs"][0]["id"],))
        after = repository.progress_token("req_1")
        assert before[0] == after[0]
        assert before[1] != after[1]


def test_model_metadata_keeps_distinct_step_models_bounded_and_never_guesses(isolated):
    with provider("text", stream_text=True, created_model="first-model", response_model="last-model") as (url, requests), TestClient(create_app(isolated)) as client:
        config = configure(client, isolated, url)
        snapshot = client.post("/api/agent/conversations", json={"id": "conv"}).json()
        assert client.post("/api/agent/conversations/conv/rounds", json=payload(snapshot, config, images=False)).status_code == 202
        result = wait_request(client, "req_1")
        assert result["request"]["modelInfo"]["returnedModels"] == ["first-model", "last-model"]
        repository = AgentRepository(isolated)
        repository.update("req_1", returned_model="last-model")
        repository.update("req_1", returned_model={"malformed": "ignored"})
        repository.update("req_1", returned_model="x" * 300)
        result = repository.snapshot("conv")
        assert result["request"]["modelInfo"]["returnedModels"] == ["first-model", "last-model", "x" * 256]
        assert len(requests) == 1
