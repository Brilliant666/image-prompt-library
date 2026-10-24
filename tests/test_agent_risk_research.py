"""Offline risk probes, including explicit characterizations of unfixed behavior.

Passing a test named ``characterizes`` confirms the documented limitation; it
does not establish that the desired behavior is implemented. No provider calls.
"""
import base64
from concurrent.futures import ThreadPoolExecutor
import json
import sqlite3
from threading import Barrier

import httpx
import pytest

from backend.agent_schemas import AgentRoundCreate
from backend.db import connect
from backend.services import agent_execution as execution
from backend.services.agent_repository import AgentError
from test_agent_image_selection import repo, body, set_mode
from test_agent_workspaces import image_bytes


class ScriptedStream(httpx.SyncByteStream):
    def __init__(self, chunks, after=None, error=None):
        self.chunks, self.after, self.error = chunks, after, error

    def __iter__(self):
        yield from self.chunks
        if self.after:
            self.after()
        if self.error:
            raise self.error


def stream_event(value):
    return ("data: " + json.dumps(value) + "\n\n").encode()


def transport(monkeypatch, *, events=None, payload=None, after=None, error=None):
    calls = []

    def handler(request):
        assert request.url.host == "127.0.0.1" and request.url.path == "/v1/responses"
        calls.append(json.loads(request.content))
        chunks = [stream_event(event) for event in events] if events is not None else [json.dumps(payload).encode()]
        return httpx.Response(200, stream=ScriptedStream(chunks, after, error),
                              headers={"content-type": "text/event-stream" if events is not None else "application/json"})

    monkeypatch.setattr(httpx, "HTTPTransport", lambda **kwargs: httpx.MockTransport(handler))
    return calls


def start(repo, *, native=False):
    if native:
        set_mode(repo, "native")
    value = body(repo)
    repo.create_round("conversation", value)
    return value


def native_result():
    return {"id": "image-call", "type": "image_generation_call", "status": "completed",
            "result": base64.b64encode(image_bytes()).decode()}


def text_result(text="complete"):
    return {"id": "message", "type": "message", "role": "assistant",
            "content": [{"type": "output_text", "text": text}]}


def job_count(repo):
    with connect(repo.library) as conn:
        return conn.execute("SELECT count(*) FROM generation_jobs").fetchone()[0]


@pytest.mark.parametrize("stream", [False, True])
def test_json_and_duplicate_sse_native_receipts_create_one_image(repo, monkeypatch, stream):
    value = start(repo, native=True)
    item = native_result()
    complete = {"id": "response", "status": "completed", "output": [item]}
    events = ([{"type": "response.output_item.done", "item": item}] * 2 +
              [{"type": "response.completed", "response": complete}] * 2) if stream else None
    calls = transport(monkeypatch, events=events, payload=complete)
    execution.run_request(repo.library, "request")
    request = repo.request("request")
    assert request["state"] == "completed" and request["usage"]["imageJobsCreated"] == 1
    assert job_count(repo) == 1 and len(calls) == 1
    assert repo.jobs.get_job(request["round"]["outputTaskIds"][0]).status == "succeeded"
    # The same client request and recovery scan must not create another POST.
    assert repo.create_round("conversation", value)[1] is False
    execution.recover_agent_requests(repo.library)
    assert len(calls) == 1 and job_count(repo) == 1


@pytest.mark.parametrize("failure", [httpx.ReadTimeout("synthetic timeout"), httpx.ReadError("synthetic disconnect"), None])
def test_incomplete_native_stream_is_unknown_without_paid_replay(repo, monkeypatch, failure):
    value = start(repo, native=True)
    events = [{"type": "response.output_item.added", "item": {
        "id": "image-call", "type": "image_generation_call", "status": "in_progress"}}]
    calls = transport(monkeypatch, events=events, error=failure)
    execution.run_request(repo.library, "request")
    request = repo.request("request")
    assert request["state"] == "unknown" and job_count(repo) == 1
    assert repo.jobs.get_job(request["round"]["outputTaskIds"][0]).status == "failed"
    assert repo.create_round("conversation", value)[1] is False
    execution.recover_agent_requests(repo.library)
    with pytest.raises(AgentError, match="无法安全恢复"):
        repo.resume("request", "resume")
    assert len(calls) == 1


def test_stop_before_late_native_receipt_does_not_create_result(repo, monkeypatch):
    start(repo, native=True)
    calls = transport(monkeypatch, payload={"status": "completed", "output": [native_result()]},
                      after=lambda: repo.stop("request"))
    execution.run_request(repo.library, "request")
    assert repo.request("request")["state"] == "stopped"
    assert job_count(repo) == 0 and len(calls) == 1


def test_characterizes_json_text_receipt_written_after_stop(repo, monkeypatch):
    """Known limitation: JSON completion can publish text after the stop flag."""
    start(repo)
    calls = transport(monkeypatch, payload={"status": "completed", "output": [text_result("late text")]},
                      after=lambda: repo.stop("request"))
    execution.run_request(repo.library, "request")
    request = repo.request("request")
    assert request["state"] == "stopped"
    assert request["round"]["assistantContent"] == "late text"
    assert job_count(repo) == 0 and len(calls) == 1


def test_characterizes_duplicate_delta_when_completion_omits_output(repo, monkeypatch):
    """Known limitation: repeated sequence numbers are appended again."""
    start(repo)
    delta = {"type": "response.output_text.delta", "item_id": "message", "output_index": 0,
             "content_index": 0, "sequence_number": 7, "delta": "hello"}
    calls = transport(monkeypatch, events=[delta, delta, {"type": "response.completed", "response": {
        "id": "response", "status": "completed"}}])
    execution.run_request(repo.library, "request")
    request = repo.request("request")
    assert request["state"] == "completed" and request["round"]["assistantContent"] == "hellohello"
    assert len(calls) == 1 and job_count(repo) == 0


def test_characterizes_timeout_after_completion_marks_request_unknown(repo, monkeypatch):
    """Known limitation: terminal payload is received, but EOF is still required."""
    start(repo, native=True)
    calls = transport(monkeypatch, events=[{"type": "response.completed", "response": {
        "id": "response", "status": "completed", "output": [native_result()]}}],
        error=httpx.ReadTimeout("timeout after terminal receipt"))
    execution.run_request(repo.library, "request")
    request = repo.request("request")
    assert request["state"] == "unknown" and job_count(repo) == 1
    assert repo.jobs.get_job(request["round"]["outputTaskIds"][0]).status == "succeeded"
    assert len(calls) == 1


@pytest.mark.parametrize("status", ["failed", "incomplete"])
def test_characterizes_native_batch_ignoring_unsuccessful_response_status(repo, monkeypatch, status):
    """Known limitation: an embedded image turns a failed response into success."""
    start(repo, native=True)
    job = execution.create_image_job(repo, "request", 1, "batch", "one", "synthetic square", {}, native=True)
    with connect(repo.library) as conn:
        conn.execute("UPDATE generation_jobs SET provider='agent_native_batch' WHERE id=?", (job.id,))
    calls = transport(monkeypatch, payload={"id": "response", "status": status,
                      "error": {"message": "synthetic failure"}, "output": [native_result()]})
    execution.NativeAgentImageProvider().run_job(repo.library, job.id)
    assert repo.jobs.get_job(job.id).status == "succeeded"
    with pytest.raises(AgentError):
        execution.NativeAgentImageProvider().run_job(repo.library, job.id)
    assert len(calls) == 1 and job_count(repo) == 1


def test_parallel_same_tool_identity_rolls_back_duplicate_job(repo, monkeypatch):
    """Both workers miss the initial read; the SQL key still prevents duplicates."""
    start(repo)
    barrier = Barrier(2)

    class Lookup:
        def __init__(self, cursor):
            self.cursor = cursor

        def fetchone(self):
            value = self.cursor.fetchone()
            assert value is None
            barrier.wait(timeout=5)
            return value

    class Connection:
        def __init__(self):
            self.conn = connect(repo.library)

        def __enter__(self):
            self.conn.__enter__()
            return self

        def __exit__(self, *args):
            try:
                return self.conn.__exit__(*args)
            finally:
                self.conn.close()

        def execute(self, sql, *args):
            cursor = self.conn.execute(sql, *args)
            return Lookup(cursor) if sql.startswith("SELECT job_id FROM agent_tool_jobs") else cursor

        def __getattr__(self, name):
            return getattr(self.conn, name)

    monkeypatch.setattr(execution, "connect", lambda *args: Connection())
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(execution.create_image_job, repo, "request", 1, "same", "single", "square", {}) for _ in range(2)]
        results, errors = [], []
        for future in futures:
            try:
                results.append(future.result(timeout=10))
            except sqlite3.IntegrityError as exc:
                errors.append(exc)
    assert len(results) == len(errors) == 1
    assert job_count(repo) == 1 and repo.request("request")["usage"]["imageJobsCreated"] == 1


@pytest.mark.parametrize("prompt", ["Match the lighting of the portrait we discussed on this photo.", "新照片沿用讨论过的人像灯光。"])
def test_characterizes_current_attachment_hiding_implicit_historical_pixels(repo, prompt):
    """Known semantic gap: current attachment alone is treated as full scope."""
    older = repo.store_asset(image_bytes("blue"), {"kind": "upload", "uploadId": "older"})["id"]
    current = repo.store_asset(image_bytes("orange"), {"kind": "upload", "uploadId": "current"})["id"]
    request = {"history": [{"index": 1, "prompt": "The blue portrait establishes the lighting.",
                           "inputImageIds": [older], "outputTaskIds": [], "responseOutput": [], "assistantContent": ""}],
               "round": {"index": 2, "prompt": prompt, "inputImageIds": [current], "outputTaskIds": []}}
    refs = {"round-1-reference-1": older, "round-2-reference-1": current}
    built = execution.build_input(repo, request, refs)
    attached = [part["image_url"] for item in built for part in item["content"] if part["type"] == "input_image"]
    assert attached == [repo.data_url(current)]
    assert 'available_ref id="round-1-reference-1"' in json.dumps(built).replace('\\"', '"')
    assert repo.data_url(older) not in attached


def test_branch_path_keeps_current_and_ancestor_images_not_sibling_images(repo):
    blue = repo.store_asset(image_bytes("blue"), {"kind": "upload", "uploadId": "blue"})["id"]
    green = repo.store_asset(image_bytes("green"), {"kind": "upload", "uploadId": "green"})["id"]
    orange = repo.store_asset(image_bytes("orange"), {"kind": "upload", "uploadId": "orange"})["id"]

    def add(request_id, parent=None, asset=None):
        value = body(repo, request_id=request_id).model_dump()
        value.update(parentRoundId=parent, prompt="Compare with the previous portrait.",
                     refs=[{"kind": "upload", "uploadId": asset}] if asset else [])
        repo.create_round("conversation", AgentRoundCreate.model_validate(value))
        request = repo.request(request_id)
        repo.update(request_id, state="completed", outcome="known")
        return request["round_id"]

    root = add("root")
    left = add("left", root, blue)
    add("right", root, green)
    add("leaf", left, orange)
    request = repo.request("leaf")
    refs = execution.refs_for_request(repo, request)
    assert refs == {"round-2-reference-1": blue, "round-3-reference-1": orange}
    built = execution.build_input(repo, request, refs)
    serialized = json.dumps(built)
    assert repo.data_url(blue) in serialized and repo.data_url(orange) in serialized
    assert repo.data_url(green) not in serialized
    # A model tool cannot invent a tag outside the frozen branch allowlist.
    repo.update("leaf", state="running")
    with pytest.raises(AgentError, match="不属于当前分支"):
        execution.create_image_job(repo, "leaf", 1, "bad", "single", '<ref id="round-9-image-1" />', refs)
    assert job_count(repo) == 0
