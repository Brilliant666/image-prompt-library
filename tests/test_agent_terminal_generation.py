"""Exercise terminal image calls through the real app and local HTTP providers."""
import base64
from contextlib import contextmanager, suppress
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from threading import Event, Lock, Thread

from fastapi.testclient import TestClient
import pytest

from backend.main import create_app
from test_agent_workspaces import configure, image_bytes, isolated, payload, wait_request


_MISSING = object()


def image_call(name="generate_image", flag=True, *, count=1, call_id="draw-one", prompt="A blue circle"):
    arguments = ({"images": [{"id": f"image-{i}", "prompt": prompt} for i in range(count)]}
                 if name == "generate_image_batch" else {"id": "one", "prompt": prompt})
    if flag is not _MISSING:
        arguments["finish_after_generation"] = flag
    return {"id": "item-" + call_id, "call_id": call_id, "type": "function_call", "name": name,
            "arguments": json.dumps(arguments)}


@contextmanager
def scripted_provider(script, *, fail_images=(), hold_images=False):
    """Only loopback JSON/SSE-independent requests; image bytes are synthetic."""
    requests, counts = [], {"text": 0, "image": 0}
    lock, image_started, release_image = Lock(), Event(), Event()
    if not hold_images:
        release_image.set()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            raw = self.rfile.read(int(self.headers["Content-Length"]))
            is_text = self.path.endswith("/responses")
            is_image = self.path.endswith(("/images/generations", "/images/edits"))
            if not (is_text or is_image):
                self.send_error(404)
                return
            body = json.loads(raw) if "application/json" in self.headers.get("Content-Type", "") else raw
            kind = "text" if is_text else "image"
            with lock:
                requests.append((self.path, body))
                counts[kind] += 1
                number = counts[kind]
            status = 200
            if is_text:
                output = script[number - 1] if number <= len(script) else [{
                    "id": f"message-{number}", "type": "message", "role": "assistant",
                    "content": [{"type": "output_text", "text": "Synthetic final analysis."}],
                }]
                response = {"id": f"response-{number}", "model": "mock-text", "status": "completed", "output": output,
                            "usage": {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15}}
            else:
                image_started.set()
                release_image.wait(5)
                if number in fail_images:
                    status, response = 400, {"error": {"message": "Synthetic image failure."}}
                else:
                    response = {"data": [{"b64_json": base64.b64encode(image_bytes()).decode()}]}
            data = json.dumps(response).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            with suppress(ConnectionError):
                self.wfile.write(data)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/v1", requests, image_started, release_image
    finally:
        release_image.set()
        server.shutdown()
        server.server_close()
        thread.join()


def text_requests(requests):
    return [body for path, body in requests if path.endswith("/responses")]


def image_requests(requests):
    return [(path, body) for path, body in requests if "/images/" in path]


def start(client, library, url, *, prompt="画一个蓝色圆形"):
    config = configure(client, library, url)
    snapshot = client.post("/api/agent/conversations", json={"id": "conv"}).json()
    body = payload(snapshot, config, prompt=prompt)
    response = client.post("/api/agent/conversations/conv/rounds", json=body)
    assert response.status_code == 202, response.text
    return config, body


@pytest.mark.parametrize("name,count", [("generate_image", 1), ("generate_image_batch", 1), ("generate_image_batch", 2)])
def test_terminal_image_call_skips_summary_persists_result_and_replays_once(isolated, name, count):
    call = image_call(name, count=count)
    with scripted_provider([[call]]) as (url, requests, _, _), TestClient(create_app(isolated)) as client:
        config, body = start(client, isolated, url)
        finished = wait_request(client, body["requestId"])
        assert finished["request"]["state"] == "completed", finished
        assert finished["request"]["usage"]["responseStepsStarted"] == 1
        assert len(text_requests(requests)) == 1
        assert len(image_requests(requests)) == count
        assert len(finished["jobs"]) == count
        assert all(job["status"] == "succeeded" for job in finished["jobs"])
        assert all((isolated / job["result_path"]).read_bytes() == image_bytes() for job in finished["jobs"])
        output = finished["conversation"]["rounds"][0]["responseOutput"]
        pairs = [item for item in output if item["type"] == "function_call_output" and item["call_id"] == call["call_id"]]
        assert len(pairs) == 1
        result = json.loads(pairs[0]["output"])
        results = result["images"] if name.endswith("batch") else [result]
        assert all(item["status"] == "done" for item in results)
        sent = len(requests)
        assert client.post("/api/agent/conversations/conv/rounds", json=body).status_code == 200
        assert len(requests) == sent

        # Early completion must still provide valid tool context to the next turn.
        again = payload(finished, config, rid="followup", prompt="你好", images=False, parent=finished["request"]["roundId"])
        assert client.post("/api/agent/conversations/conv/rounds", json=again).status_code == 202
        followup = wait_request(client, "followup")
        assert followup["request"]["state"] == "completed", followup
        continued = text_requests(requests)[-1]["input"]
        assert sum(item.get("type") == "function_call" and item.get("call_id") == call["call_id"] for item in continued) == 1
        assert sum(item.get("type") == "function_call_output" and item.get("call_id") == call["call_id"] for item in continued) == 1
        assert len(text_requests(requests)) == 2 and len(image_requests(requests)) == count


@pytest.mark.parametrize("flag", [_MISSING, False, None, "true", 1], ids=["missing", "false", "null", "string", "number"])
def test_non_boolean_or_absent_terminal_flag_keeps_normal_summary(isolated, flag):
    with scripted_provider([[image_call(flag=flag)]]) as (url, requests, _, _), TestClient(create_app(isolated)) as client:
        _, body = start(client, isolated, url)
        finished = wait_request(client, body["requestId"])
        assert finished["request"]["state"] == "completed", finished
        assert len(text_requests(requests)) == 2 and len(image_requests(requests)) == 1
        assert finished["request"]["usage"]["responseStepsStarted"] == 2
        assert any(item.get("type") == "function_call_output" for item in text_requests(requests)[1]["input"])
        assert finished["conversation"]["messages"][-1]["content"] == "Synthetic final analysis."


@pytest.mark.parametrize("prompt", ["生成一张图，再分析图片", "Generate an image and compare its colors.",
                                     "先画一个圆形，再画一个不同的版本", "先画一个圆形。\n再画一个不同的版本。"])
def test_extra_deliverables_override_an_incorrect_terminal_flag(isolated, prompt):
    with scripted_provider([[image_call()]]) as (url, requests, _, _), TestClient(create_app(isolated)) as client:
        _, body = start(client, isolated, url, prompt=prompt)
        finished = wait_request(client, body["requestId"])
        assert finished["request"]["state"] == "completed", finished
        assert len(text_requests(requests)) == 2
        assert finished["conversation"]["messages"][-1]["content"] == "Synthetic final analysis."


def test_dependent_generation_continues_and_passes_real_frozen_image(isolated):
    first = image_call(call_id="first")
    continuation = {"id": "item-next", "call_id": "next", "type": "function_call", "name": "continue_generation",
                    "arguments": json.dumps({"reason": "Use the completed prerequisite."})}
    second = image_call(call_id="second", prompt='Change the blue circle in <ref id="round-1-image-1" /> to red.')
    with scripted_provider([[first], [continuation], [second]]) as (url, requests, _, _), TestClient(create_app(isolated)) as client:
        _, body = start(client, isolated, url, prompt="先画蓝色圆形，再根据这张图画红色版本")
        finished = wait_request(client, body["requestId"])
        assert finished["request"]["state"] == "completed", finished
        assert len(text_requests(requests)) == 4
        assert len(finished["jobs"]) == 2 and all(job["status"] == "succeeded" for job in finished["jobs"])
        edits = [raw for path, raw in image_requests(requests) if path.endswith("/images/edits")]
        assert len(edits) == 1 and image_bytes() in edits[0]
        assert any(item.get("type") == "function_call_output" and item.get("call_id") == "next" for item in text_requests(requests)[2]["input"])


def test_mixed_tool_step_cannot_finish_early(isolated):
    continuation = {"id": "item-next", "call_id": "next", "type": "function_call", "name": "continue_generation",
                    "arguments": json.dumps({"reason": "Need another model step."})}
    with scripted_provider([[image_call(), continuation]]) as (url, requests, _, _), TestClient(create_app(isolated)) as client:
        _, body = start(client, isolated, url)
        finished = wait_request(client, body["requestId"])
        assert finished["request"]["state"] == "completed", finished
        assert len(text_requests(requests)) == 2
        assert {item["call_id"] for item in text_requests(requests)[1]["input"] if item.get("type") == "function_call_output"} == {"draw-one", "next"}


@pytest.mark.parametrize("name,count,failed", [("generate_image", 1, (1,)), ("generate_image_batch", 2, (2,))])
def test_failed_or_partial_image_batch_never_reports_terminal_success(isolated, name, count, failed):
    with scripted_provider([[image_call(name, count=count)]], fail_images=failed) as (url, requests, _, _), TestClient(create_app(isolated)) as client:
        _, body = start(client, isolated, url)
        finished = wait_request(client, body["requestId"])
        assert finished["request"]["state"] == "failed", finished
        assert finished["request"]["error"]["code"] == "image_job_failed"
        assert len(text_requests(requests)) == 1 and len(image_requests(requests)) == count
        assert sum(job["status"] == "succeeded" for job in finished["jobs"]) == count - len(failed)
        assert any(job["status"] == "failed" for job in finished["jobs"])
        sent = len(requests)
        assert client.post("/api/agent/conversations/conv/rounds", json=body).status_code == 200
        assert len(requests) == sent


def test_stop_during_terminal_image_call_never_completes_or_sends_summary(isolated):
    from backend.services import agent_execution

    with scripted_provider([[image_call()]], hold_images=True) as (url, requests, started, release), TestClient(create_app(isolated)) as client:
        _, body = start(client, isolated, url)
        assert started.wait(5), "Synthetic image provider was not called."
        with agent_execution._lock:
            worker = agent_execution._futures[agent_execution.key_for(isolated, body["requestId"])]
        try:
            stopped = client.post("/api/agent/requests/" + body["requestId"] + "/stop")
            assert stopped.status_code == 200, stopped.text
            assert stopped.json()["request"]["state"] == "stopped"
        finally:
            release.set()
        # Wait for the real request worker, so a late terminal transition cannot
        # escape an assertion made immediately after the stop endpoint returns.
        worker.result(timeout=5)
        finished = wait_request(client, body["requestId"])
        assert finished["request"]["state"] == "stopped", finished
        assert all(job["status"] == "cancelled" for job in finished["jobs"])
        assert len(text_requests(requests)) == 1 and len(image_requests(requests)) == 1
