import base64
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
import json
from pathlib import Path
from threading import Thread
import time

from fastapi.testclient import TestClient
from PIL import Image
import pytest

from backend.db import connect
from backend.main import create_app
from backend.services.agent_repository import AgentRepository
from backend.services.agent_execution import recover_agent_requests
from backend.services.openai_compatible import OpenAICompatibleConfig


def image_bytes(color="orange", mode="RGB"):
    out = BytesIO()
    Image.new(mode, (24, 16), color).save(out, "PNG")
    return out.getvalue()


@contextmanager
def provider(mode="hybrid"):
    requests = []
    echo = mode.startswith("echo_")
    mode = mode.removeprefix("echo_")
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            requests.append((self.path, body))
            if self.path.endswith("/images/generations"):
                response = {"data": [{"b64_json": base64.b64encode(image_bytes()).decode()}]}
            elif self.path.endswith("/responses"):
                calls = sum(path.endswith("/responses") for path, _ in requests)
                if mode in {"native", "native_sse", "slow_native", "native_empty"} or (mode == "native_batch" and body.get("tool_choice")):
                    output = [{"id": "ig_1", "type": "image_generation_call", "status": "completed", "result": base64.b64encode(image_bytes()).decode()}]
                    if mode == "native_empty":
                        output[0].pop("result")
                elif mode in {"batch", "native_batch"} and calls == 1:
                    output = [{"id": "fc_1", "call_id": "call_batch", "type": "function_call", "name": "generate_image_batch",
                               "arguments": json.dumps({"images": [{"id": "one", "prompt": "one"}, {"id": "two", "prompt": "two"}]})}]
                elif mode in {"hybrid", "forbidden"} and calls == 1:
                    output = [{"id": "fc_1", "call_id": "call_one", "type": "function_call", "name": "generate_image", "arguments": json.dumps({"id": "one", "prompt": "one orange square"})}]
                else:
                    output = [{"id": f"msg_{calls}", "type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "完成"}]}]
                response = {"id": f"resp_{calls}", "output": output}
                if mode == "json_failed":
                    response.update(status="failed", error={"message": "unit-test-key-not-real"})
            else:
                self.send_error(404)
                return
            if echo:
                response["id"] = "resp_unit-test-key-not-real"
                for item in response.get("output", []):
                    item["id"] += "-unit-test-key-not-real"
                    if item["type"] == "image_generation_call":
                        item["revised_prompt"] = "draw unit-test-key-not-real"
                    elif item["type"] == "function_call" and mode == "hybrid":
                        item["arguments"] = json.dumps({"id": "one", "prompt": "draw unit-test-key-not-real"}).replace("unit-test-key-not-real", "\\u0075nit-test-key-not-real")
            if mode in {"native_sse", "slow_native"}:
                image = response["output"][0]
                message = {"id": "message_1", "type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "unit-test-key-not-real" if echo else "先说明，再生成。"}]}
                response["output"] = [{k: v for k, v in message.items() if k != "id"}, image]
                events = [
                    {"type": "response.output_item.added", "output_index": 0, "item": {**message, "content": []}},
                    {"type": "response.output_text.delta", "delta": "unit-test-key-" if echo else "先说明，再生成。"},
                    {"type": "response.output_text.delta", "delta": "not-real" if echo else ""},
                    {"type": "response.output_item.done", "output_index": 0, "item": message},
                    {"type": "response.output_item.added", "output_index": 1, "item": {"id": image["id"], "type": "image_generation_call", "status": "in_progress"}},
                    {"type": "response.image_generation_call.partial_image", "item_id": image["id"], "partial_image_b64": image["result"]},
                    {"type": "response.output_item.done", "output_index": 1, "item": image},
                    {"type": "response.completed", "response": response},
                ]
                data = "".join("data: " + json.dumps(event) + "\n\n" for event in events).encode()
            else:
                data = json.dumps(response).encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream" if mode in {"native_sse", "slow_native"} else "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            if mode == "slow_native":
                split = data.index(b'data: {"type": "response.output_item.done", "output_index": 1')
                self.wfile.write(data[:split])
                self.wfile.flush()
                time.sleep(1)
                with __import__("contextlib").suppress(ConnectionError):
                    self.wfile.write(data[split:])
            else:
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


@pytest.fixture
def isolated(tmp_path, monkeypatch):
    for suffix in ("AUTH_PATH", "GROK_AUTH_PATH", "CONFIG_PATH", "OPENAI_COMPATIBLE_CONFIG_PATH", "CAPTURE_CLIENTS_PATH", "CAPTURE_ORGANIZER_CONFIG_PATH"):
        monkeypatch.setenv("IMAGE_PROMPT_LIBRARY_" + suffix, str(tmp_path / "config" / (suffix.lower() + ".json")))
    # A test cannot accidentally reach a real provider even if its config regresses.
    import httpx
    original = httpx.HTTPTransport.handle_request
    def local_only(self, request):
        assert request.url.host in {"127.0.0.1", "localhost"}
        return original(self, request)
    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", local_only)
    return tmp_path / "library"


def configure(client, library, url, mode="hybrid"):
    OpenAICompatibleConfig(library_path=library).save({"base_url": url, "api_key": "unit-test-key-not-real", "model": "gpt-image-2", "display_name": "Local mock"}, profile_id="mock")
    document = client.get("/api/agent/config").json()
    config = {**document["config"], "textProfileId": "mock", "imageProfileId": "mock", "textModel": "mock-text", "imageModel": "gpt-image-2", "apiConfigMode": mode, "stream": False}
    saved = client.put("/api/agent/config", json={"expectedRevision": document["revision"], "config": config})
    assert saved.status_code == 200, saved.text
    return saved.json()


def payload(snapshot, config, rid="req_1", prompt="画一只猫", images=True, parent=None):
    return {"requestId": rid, "expectedRevision": snapshot["revision"], "parentRoundId": parent, "origin": "send", "prompt": prompt,
            "refs": [], "configRevision": config["revision"], "params": {"size": "1024x1024", "quality": "auto", "output_format": "png", "output_compression": 0},
            "authorization": {"scope": "this_request", "allowImageGeneration": images, "allowWebSearch": False, "maxToolRounds": 5, "maxImageJobs": 4 if images else 0}}


def wait_request(client, request_id):
    deadline = time.monotonic() + 12
    while time.monotonic() < deadline:
        response = client.get("/api/agent/requests/" + request_id)
        assert response.status_code == 200, response.text
        result = response.json()
        if result["request"]["state"] not in {"queued", "running", "waiting_for_jobs", "stop_requested"}:
            return result
        time.sleep(0.03)
    raise AssertionError("Agent request did not finish: " + json.dumps(result, ensure_ascii=False))


@pytest.mark.parametrize(("mode", "count"), [("hybrid", 1), ("batch", 2), ("native", 1), ("native_sse", 1), ("native_batch", 2)])
def test_real_http_tools_share_jobs_store_and_durable_replay(isolated, mode, count):
    with provider(mode) as (url, requests), TestClient(create_app(isolated)) as client:
        config = configure(client, isolated, url, "native" if mode.startswith("native") else "hybrid")
        snapshot = client.post("/api/agent/conversations", json={"id": "conv"}).json()
        body = payload(snapshot, config)
        first = client.post("/api/agent/conversations/conv/rounds", json=body)
        assert first.status_code == 202, first.text
        result = wait_request(client, body["requestId"])
        assert result["request"]["state"] == "completed", result
        assert len(result["jobs"]) == count
        assert all(job["status"] == "succeeded" for job in result["jobs"])
        assert all((isolated / job["result_path"]).read_bytes() == image_bytes() for job in result["jobs"])
        assert result["request"]["params"]["output_compression"] == 0
        assert "unit-test-key-not-real" not in json.dumps(result)
        sent = len(requests)
        replay = client.post("/api/agent/conversations/conv/rounds", json=body)
        assert replay.status_code == 200
        assert len(requests) == sent
        assert len(client.get("/api/generation-jobs").json()["jobs"]) == count
        conflict = client.post("/api/agent/conversations/conv/rounds", json={**body, "prompt": "changed"})
        assert conflict.status_code == 409
        assert conflict.json()["detail"]["code"] == "request_id_conflict"
        image_calls = [r for r in requests if r[0].endswith("/images/generations")]
        assert len(image_calls) == (0 if mode.startswith("native") else count)
        if mode.startswith("native"):
            for path, sent_body in requests:
                assert sent_body["model"] == "mock-text"
                image_tools = [tool for tool in sent_body.get("tools", []) if tool["type"] == "image_generation"]
                if image_tools:
                    assert image_tools[0]["model"] == "gpt-image-2"
                    assert 1 <= sent_body["max_tool_calls"] <= 4
                    assert "output_compression" not in image_tools[0]
        if mode == "native_sse":
            outputs = result["conversation"]["rounds"][0]["responseOutput"]
            assert [o["type"] for o in outputs] == ["message", "image_generation_call"]
            assert result["conversation"]["messages"][1]["content"] == "先说明，再生成。"
            assert "result" not in outputs[1]
            assert result["jobs"][0]["metadata"]["agent"]["partialImageId"]
            assert result["jobs"][0]["metadata"]["agent"]["partialImageId"] in {image["id"] for image in result["images"]}
        if mode in {"hybrid", "batch", "native_batch"}:
            continuation = [b for path, b in requests if path.endswith("/responses")][-1]
            assert any(i.get("type") == "function_call_output" for i in continuation["input"])


def test_text_authorization_cannot_be_bypassed_by_tool_output(isolated):
    with provider("forbidden") as (url, requests), TestClient(create_app(isolated)) as client:
        config = configure(client, isolated, url)
        snapshot = client.post("/api/agent/conversations", json={"id": "conv"}).json()
        response = client.post("/api/agent/conversations/conv/rounds", json=payload(snapshot, config, images=False))
        assert response.status_code == 202
        result = wait_request(client, "req_1")
        assert result["request"]["state"] == "failed", result
        assert not result["jobs"]
        assert len(requests) == 1
        assert requests[0][1]["tools"] == []


def test_branch_path_and_original_prompt_survive_reload(isolated):
    with provider("text") as (url, requests), TestClient(create_app(isolated)) as client:
        config = configure(client, isolated, url)
        snapshot = client.post("/api/agent/conversations", json={"id": "conv"}).json()
        def send(rid, prompt, parent):
            nonlocal snapshot
            result = client.post("/api/agent/conversations/conv/rounds", json=payload(snapshot, config, rid, prompt, False, parent))
            assert result.status_code == 202, result.text
            snapshot = wait_request(client, rid)
            return snapshot["request"]["roundId"]
        root = send("root", "ROOT", None)
        left = send("left", "LEFT\n\n  ORIGINAL  ", root)
        send("right", "RIGHT_SIBLING", root)
        send("leaf", "LEAF", left)
        upstream = json.dumps(requests[-1][1]["input"])
        assert "LEFT" in upstream and "RIGHT_SIBLING" not in upstream
        round_data = next(r for r in snapshot["conversation"]["rounds"] if r["id"] == left)
        assert round_data["prompt"] == "LEFT\n\n  ORIGINAL  "
        reloaded = client.get("/api/agent/conversations/conv").json()
        assert reloaded["conversation"] == snapshot["conversation"]


def test_uploads_freeze_original_bytes_and_backups_include_agent_state(isolated, tmp_path):
    from backend.services.library_archives import backup_library, verify_backup, restore_library
    with provider("text") as (url, requests), TestClient(create_app(isolated)) as client:
        config = configure(client, isolated, url)
        upload = client.post("/api/agent/uploads", files={"file": ("ref.png", image_bytes(), "image/png")}).json()
        snapshot = client.post("/api/agent/conversations", json={"id": "conv"}).json()
        body = payload(snapshot, config, prompt="查看 @图1", images=False)
        body["refs"] = [{"kind": "upload", "uploadId": upload["uploadId"]}]
        assert client.post("/api/agent/conversations/conv/rounds", json=body).status_code == 202
        result = wait_request(client, "req_1")
        assert result["request"]["state"] == "completed", result
        data_url = next(p["image_url"] for i in requests[0][1]["input"] for p in i.get("content", []) if p.get("type") == "input_image")
        assert base64.b64decode(data_url.split(",", 1)[1]) == image_bytes()
        assert client.get(upload["image"]["url"]).content == image_bytes()
        preview = client.get("/api/cleanup/preview").json()
        applied = client.post("/api/cleanup/apply", json={"preview_token": preview["preview_token"], "remove_broken_image_records": True, "remove_unreferenced_files": True})
        assert applied.status_code == 200
        assert client.get(upload["image"]["url"]).content == image_bytes()
    archive = backup_library(isolated, tmp_path / "agent-backup.tar.gz")
    manifest = verify_backup(archive, isolated)
    assert "014_agent_workspaces.sql" in manifest["migrations"]
    with connect(isolated) as conn:
        assert conn.execute("SELECT count(*) FROM agent_requests").fetchone()[0] == 1
    restored = tmp_path / "restored-agent-library"
    restore_library(archive, restored, confirm=True)
    restored_repo = AgentRepository(restored)
    assert restored_repo.snapshot("conv")["conversation"] == result["conversation"]
    assert base64.b64decode(restored_repo.data_url(upload["uploadId"]).split(",", 1)[1]) == image_bytes()
    import tarfile
    with tarfile.open(archive) as packed:
        assert all(b"unit-test-key-not-real" not in packed.extractfile(member).read() for member in packed.getmembers() if member.isfile())


def test_restart_marks_sent_request_unknown_without_replay(isolated, monkeypatch):
    monkeypatch.setattr("backend.routers.agent.schedule_request", lambda *args: None)
    with provider("text") as (url, requests), TestClient(create_app(isolated)) as client:
        config = configure(client, isolated, url)
        snapshot = client.post("/api/agent/conversations", json={"id": "conv"}).json()
        body = payload(snapshot, config, images=False)
        assert client.post("/api/agent/conversations/conv/rounds", json=body).status_code == 202
        with connect(isolated) as conn:
            conn.execute("UPDATE agent_requests SET state='running',upstream_outcome='unknown'")
        recover_agent_requests(isolated)
        result = client.get("/api/agent/requests/req_1").json()
        assert result["request"]["state"] == "unknown"
        assert not result["request"]["canResume"]
        assert client.post("/api/agent/requests/req_1/resume", json={"resumeId": "resume"}).status_code == 409
        assert not requests


def test_regeneration_reuses_frozen_job_reference_and_zero_compression(isolated):
    from backend.schemas import GenerationJobCreate
    from backend.services.generation_jobs import GenerationJobRepository
    jobs = GenerationJobRepository(isolated)
    job = jobs.create_job(GenerationJobCreate(provider="manual_upload", prompt_text="reference"))
    original = jobs.stage_result(job.id, image_bytes(), "ref.png")
    with provider("text") as (url, requests), TestClient(create_app(isolated)) as client:
        config = configure(client, isolated, url)
        snapshot = client.post("/api/agent/conversations", json={"id": "conv"}).json()
        body = payload(snapshot, config, prompt="查看 @图1", images=False)
        body["refs"] = [{"kind": "job", "jobId": job.id}]
        assert client.post("/api/agent/conversations/conv/rounds", json=body).status_code == 202
        first = wait_request(client, "req_1")
        # The original job can be discarded after a conversation froze its bytes.
        jobs.discard_job(job.id)
        again = {**body, "requestId": "regenerate", "expectedRevision": first["revision"], "origin": "regenerate", "derivedFromRoundId": first["request"]["roundId"]}
        response = client.post("/api/agent/conversations/conv/rounds", json=again)
        assert response.status_code == 202, response.text
        second = wait_request(client, "regenerate")
        assert second["request"]["state"] == "completed", second
        assert second["request"]["params"]["output_compression"] == 0
        assert second["conversation"]["rounds"][0]["inputImageIds"] == second["conversation"]["rounds"][1]["inputImageIds"]
        assert requests[0][1]["input"] == requests[1][1]["input"]


def test_stop_preserves_partial_preview_and_never_replays(isolated):
    with provider("slow_native") as (url, requests), TestClient(create_app(isolated)) as client:
        config = configure(client, isolated, url, "native")
        snapshot = client.post("/api/agent/conversations", json={"id": "conv"}).json()
        body = payload(snapshot, config)
        assert client.post("/api/agent/conversations/conv/rounds", json=body).status_code == 202
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            result = client.get("/api/agent/requests/req_1").json()
            if result["jobs"] and result["jobs"][0]["metadata"]["agent"].get("partialImageId"):
                break
            time.sleep(0.01)
        assert result["request"]["state"] == "running"
        stopped = client.post("/api/agent/requests/req_1/stop").json()
        assert stopped["request"]["state"] == "stopped"
        assert stopped["request"]["upstreamMayContinue"]
        assert stopped["jobs"][0]["status"] == "cancelled"
        assert client.post("/api/agent/requests/req_1/stop").status_code == 200
        assert client.post("/api/agent/conversations/conv/rounds", json=body).status_code == 200
        assert len(requests) == 1


def test_budget_rejects_entire_batch_before_image_dispatch(isolated):
    with provider("batch") as (url, requests), TestClient(create_app(isolated)) as client:
        config = configure(client, isolated, url)
        snapshot = client.post("/api/agent/conversations", json={"id": "conv"}).json()
        body = payload(snapshot, config)
        body["authorization"]["maxImageJobs"] = 1
        assert client.post("/api/agent/conversations/conv/rounds", json=body).status_code == 202
        result = wait_request(client, "req_1")
        assert result["request"]["state"] == "failed"
        assert result["request"]["error"]["code"] == "budget_exhausted"
        assert not result["jobs"] and len(requests) == 1


def test_native_missing_image_is_failed_and_not_retried(isolated):
    with provider("native_empty") as (url, requests), TestClient(create_app(isolated)) as client:
        config = configure(client, isolated, url, "native")
        snapshot = client.post("/api/agent/conversations", json={"id": "conv"}).json()
        assert client.post("/api/agent/conversations/conv/rounds", json=payload(snapshot, config)).status_code == 202
        result = wait_request(client, "req_1")
        assert result["request"]["state"] == "failed", result
        assert result["jobs"][0]["status"] == "failed"
        assert len(requests) == 1


def test_safe_resume_idempotency_and_changed_profiles_block_dispatch(isolated, monkeypatch):
    import backend.routers.agent as routes
    schedule = routes.schedule_request
    monkeypatch.setattr(routes, "schedule_request", lambda *args: None)
    with provider("text") as (url, requests), TestClient(create_app(isolated)) as client:
        config = configure(client, isolated, url)
        snapshot = client.post("/api/agent/conversations", json={"id": "conv"}).json()
        assert client.post("/api/agent/conversations/conv/rounds", json=payload(snapshot, config, images=False)).status_code == 202
        AgentRepository(isolated).update("req_1", state="interrupted", outcome="not_sent")
        monkeypatch.setattr(routes, "schedule_request", schedule)
        assert client.post("/api/agent/requests/req_1/resume", json={"resumeId": "safe"}).status_code == 202
        first = wait_request(client, "req_1")
        assert first["request"]["state"] == "completed"
        assert client.post("/api/agent/requests/req_1/resume", json={"resumeId": "safe"}).status_code == 200
        assert len(requests) == 1
        monkeypatch.setattr(routes, "schedule_request", lambda *args: None)
        body = payload(first, config, "changed", images=False)
        assert client.post("/api/agent/conversations/conv/rounds", json=body).status_code == 202
        OpenAICompatibleConfig(library_path=isolated).save({"model": "changed-model"}, profile_id="mock")
        schedule(isolated, "changed")
        failed = wait_request(client, "changed")
        assert failed["request"]["state"] == "failed"
        assert failed["request"]["error"]["code"] == "profile_changed"
        assert len(requests) == 1


def test_restart_holds_unstarted_child_job_until_explicit_resume(isolated, monkeypatch):
    import backend.routers.agent as routes
    from backend.services.agent_execution import create_image_job
    from backend.services.generation_queue import enqueue_generation_jobs
    schedule = routes.schedule_request
    monkeypatch.setattr(routes, "schedule_request", lambda *args: None)
    with provider("text") as (url, requests), TestClient(create_app(isolated)) as client:
        config = configure(client, isolated, url)
        snapshot = client.post("/api/agent/conversations", json={"id": "conv"}).json()
        assert client.post("/api/agent/conversations/conv/rounds", json=payload(snapshot, config)).status_code == 202
        repo = AgentRepository(isolated)
        call = {"id": "function_1", "type": "function_call", "call_id": "call_1", "name": "generate_image", "arguments": json.dumps({"id": "one", "prompt": "one image"})}
        child = create_image_job(repo, "req_1", 1, "call_1", "single", "one image", {})
        with connect(isolated) as conn:
            conn.execute("INSERT INTO agent_steps(request_id,step,state,output) VALUES('req_1',1,'completed',?)", (json.dumps([call]),))
            conn.execute("UPDATE agent_requests SET usage=? WHERE id='req_1'", (json.dumps({"responseStepsStarted": 1, "imageJobsCreated": 1}),))
        repo.update("req_1", state="waiting_for_jobs", outcome="known", output=[call])
        recover_agent_requests(isolated)
        enqueue_generation_jobs(isolated, provider="openai_compatible")
        assert repo.jobs.get_job(child.id).status == "queued"
        assert not repo.jobs.next_queued_provider_jobs("openai_compatible", limit=5)
        assert not requests
        monkeypatch.setattr(routes, "schedule_request", schedule)
        assert client.post("/api/agent/requests/req_1/resume", json={"resumeId": "continue"}).status_code == 202
        finished = wait_request(client, "req_1")
        assert finished["request"]["state"] == "completed", finished
        assert [job["id"] for job in finished["jobs"]] == [child.id]
        assert finished["request"]["usage"] == {"responseStepsStarted": 2, "imageJobsCreated": 1}
        assert len(requests) == 2
        assert client.post("/api/agent/requests/req_1/resume", json={"resumeId": "continue"}).status_code == 200
        assert len(requests) == 2


def test_json_failure_is_not_reported_as_success_or_retried(isolated):
    with provider("json_failed") as (url, requests), TestClient(create_app(isolated)) as client:
        config = configure(client, isolated, url)
        snapshot = client.post("/api/agent/conversations", json={"id": "conv"}).json()
        assert client.post("/api/agent/conversations/conv/rounds", json=payload(snapshot, config, images=False)).status_code == 202
        result = wait_request(client, "req_1")
        assert result["request"]["state"] == "failed"
        assert result["request"]["upstreamOutcome"] == "known"
        assert "unit-test-key-not-real" not in json.dumps(result)
        assert len(requests) == 1


def test_mask_targets_first_image_and_rejects_missing_alpha_before_post(isolated):
    with provider("native") as (url, requests), TestClient(create_app(isolated)) as client:
        config = configure(client, isolated, url, "native")
        def upload(data):
            return client.post("/api/agent/uploads", files={"file": ("ref.png", data, "image/png")}).json()["uploadId"]
        first, target, mask = upload(image_bytes()), upload(image_bytes("blue")), upload(image_bytes((0, 0, 0, 0), "RGBA"))
        snapshot = client.post("/api/agent/conversations", json={"id": "conv"}).json()
        body = payload(snapshot, config)
        body["refs"] = [{"kind": "upload", "uploadId": first}, {"kind": "upload", "uploadId": target}]
        body["mask"] = {"uploadId": first, "targetRefIndex": 1}
        assert client.post("/api/agent/conversations/conv/rounds", json=body).status_code == 400
        assert not requests
        body["mask"]["uploadId"] = mask
        assert client.post("/api/agent/conversations/conv/rounds", json=body).status_code == 202
        assert wait_request(client, "req_1")["request"]["state"] == "completed"
        sent = requests[0][1]
        input_images = [part["image_url"] for item in sent["input"] for part in item.get("content", []) if part.get("type") == "input_image"]
        assert base64.b64decode(input_images[0].split(",", 1)[1]) == image_bytes("blue")
        assert sent["tools"][0]["input_image_mask"]["image_url"].startswith("data:image/png;base64,")
        assert not any(tool.get("name") == "generate_image_batch" for tool in sent["tools"])


@pytest.mark.parametrize("mode", ["echo_native", "echo_native_sse", "echo_native_batch", "echo_hybrid"])
def test_provider_echoes_never_persist_secrets_in_snapshots_or_backup(isolated, tmp_path, monkeypatch, mode):
    secret = "unit-test-key-not-real"
    original_update = AgentRepository.update
    def checked_update(self, request_id, **kwargs):
        assert secret not in json.dumps(kwargs), "provider secret crossed persistence boundary"
        return original_update(self, request_id, **kwargs)
    monkeypatch.setattr(AgentRepository, "update", checked_update)
    with provider(mode) as (url, requests), TestClient(create_app(isolated)) as client:
        config = configure(client, isolated, url, "hybrid" if mode == "echo_hybrid" else "native")
        snapshot = client.post("/api/agent/conversations", json={"id": "conv"}).json()
        assert client.post("/api/agent/conversations/conv/rounds", json=payload(snapshot, config)).status_code == 202
        result = wait_request(client, "req_1")
        assert result["request"]["state"] == "completed", result
        assert secret not in json.dumps(result)
        assert all((isolated / job["result_path"]).read_bytes() == image_bytes() for job in result["jobs"])
        assert secret not in json.dumps(client.get("/api/generation-jobs").json())
    from backend.services.library_archives import backup_library
    import tarfile
    archive = backup_library(isolated, tmp_path / "echo-backup.tar.gz")
    with tarfile.open(archive) as packed:
        assert all(secret.encode() not in packed.extractfile(member).read() for member in packed.getmembers() if member.isfile())


@pytest.mark.parametrize("mutation", ["conversation", "round", "new_request"])
def test_resume_cannot_schedule_deleted_or_concurrently_active_conversations(isolated, monkeypatch, mutation):
    scheduled = []
    monkeypatch.setattr("backend.routers.agent.schedule_request", lambda *args: scheduled.append(args))
    with provider("text") as (url, requests), TestClient(create_app(isolated)) as client:
        config = configure(client, isolated, url)
        snapshot = client.post("/api/agent/conversations", json={"id": "conv"}).json()
        response = client.post("/api/agent/conversations/conv/rounds", json=payload(snapshot, config, images=False))
        assert response.status_code == 202
        repo = AgentRepository(isolated)
        repo.update("req_1", state="interrupted", outcome="not_sent")
        snapshot = repo.snapshot("conv")
        if mutation == "conversation":
            assert client.delete("/api/agent/conversations/conv").status_code == 200
        elif mutation == "round":
            assert client.delete("/api/agent/conversations/conv/rounds/" + snapshot["request"]["roundId"]).status_code == 200
        else:
            assert client.post("/api/agent/conversations/conv/rounds", json=payload(snapshot, config, "new", images=False)).status_code == 202
        count = len(scheduled)
        resume = client.post("/api/agent/requests/req_1/resume", json={"resumeId": "blocked"})
        assert resume.status_code in {404, 409}, resume.text
        assert len(scheduled) == count
        assert repo.request("req_1")["state"] == "interrupted"
        assert not requests


@pytest.mark.parametrize("native", [False, True])
def test_queued_child_is_submitted_once_and_losing_worker_cannot_fail_owner(isolated, monkeypatch, native):
    from backend.services import generation_queue
    from backend.services.agent_execution import create_image_job, run_compatible_agent_job, NativeAgentImageProvider
    monkeypatch.setattr("backend.routers.agent.schedule_request", lambda *args: None)
    with provider("text") as (url, requests), TestClient(create_app(isolated)) as client:
        config = configure(client, isolated, url, "native" if native else "hybrid")
        snapshot = client.post("/api/agent/conversations", json={"id": "conv"}).json()
        assert client.post("/api/agent/conversations/conv/rounds", json=payload(snapshot, config)).status_code == 202
        repo = AgentRepository(isolated)
        child = create_image_job(repo, "req_1", 1, "call_1", "single", "one image", {}, native=native)
        queued_provider = "agent_native_batch" if native else "openai_compatible"
        if native:
            with connect(isolated) as conn:
                conn.execute("UPDATE generation_jobs SET provider=? WHERE id=?", (queued_provider, child.id))
        submitted = []
        class HeldExecutor:
            def submit(self, *args):
                submitted.append(args)
        with monkeypatch.context() as hold:
            hold.setattr(generation_queue, "_executor", HeldExecutor())
            try:
                generation_queue.enqueue_generation_jobs(isolated, provider=queued_provider)
                generation_queue.enqueue_generation_jobs(isolated, provider=queued_provider)
                assert len(submitted) == 1
                repo.jobs.mark_running(child.id)
                with pytest.raises(Exception):
                    (NativeAgentImageProvider().run_job if native else run_compatible_agent_job)(isolated, child.id)
                assert repo.jobs.get_job(child.id).status == "running"
                assert not requests
            finally:
                with generation_queue._lock:
                    generation_queue._active.discard(child.id)
                    generation_queue._active_providers.pop(child.id, None)


def test_unspecified_native_model_and_png_compression_are_not_claimed_as_sent(isolated):
    with provider("native") as (url, requests), TestClient(create_app(isolated)) as client:
        config = configure(client, isolated, url, "native")
        config["config"]["imageModel"] = ""
        config = client.put("/api/agent/config", json={"expectedRevision": config["revision"], "config": config["config"]}).json()
        snapshot = client.post("/api/agent/conversations", json={"id": "conv"}).json()
        assert client.post("/api/agent/conversations/conv/rounds", json=payload(snapshot, config)).status_code == 202
        result = wait_request(client, "req_1")
        assert result["request"]["state"] == "completed"
        job = result["jobs"][0]
        assert job["model"] is None
        assert "model" not in job["parameters"]
        assert "model" not in job["metadata"]["requested"]
        assert "output_compression" not in job["metadata"]["requested"]
        assert result["request"]["params"]["output_compression"] == 0
        assert "model" not in requests[0][1]["tools"][0]
        assert "native-image-generation" not in json.dumps(result)
