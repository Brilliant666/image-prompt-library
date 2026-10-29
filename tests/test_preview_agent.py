"""Offline preview exercises real HTTP routes, workers and persistence."""
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import time

from fastapi.testclient import TestClient
import httpx
import pytest

from scripts.preview_agent import main, preview_session, PROMPT_MARKERS, prompt_candidate


@pytest.fixture
def preview(tmp_path):
    with preview_session(tmp_path / "preview", delay=0, slow_delay=0.03) as (app, provider, seeds):
        with TestClient(app, base_url="http://127.0.0.1:8766", client=("127.0.0.1", 45678)) as client:
            yield client, provider, seeds, app.state.library_path


def submit(client, request_id, prompt, *, images=False, count=1, parent=None, refs=()):
    snapshot = client.get("/api/agent/conversations/preview").json()
    config = client.get("/api/agent/config").json()
    body = {"requestId": request_id, "expectedRevision": snapshot["revision"], "parentRoundId": parent,
            "prompt": prompt, "configRevision": config["revision"], "imageCount": count, "refs": list(refs),
            "authorization": {"scope": "this_request", "allowImageGeneration": images,
                              "maxToolRounds": 5, "maxImageJobs": count if images else 0}}
    response = client.post("/api/agent/conversations/preview/rounds", json=body)
    assert response.status_code == 202, response.text
    return body


def wait_request(client, request_id):
    until = time.monotonic() + 12
    while time.monotonic() < until:
        response = client.get("/api/agent/requests/" + request_id)
        assert response.status_code == 200, response.text
        snapshot = response.json()
        if snapshot["request"]["state"] not in {"queued", "running", "waiting_for_jobs", "stop_requested"}:
            return snapshot
        time.sleep(0.02)
    pytest.fail("Preview request did not settle: " + json.dumps(snapshot, ensure_ascii=False))


def test_startup_isolates_config_blocks_external_and_keeps_diagnostics_readonly(tmp_path, monkeypatch):
    sentinel = tmp_path / "production-config.json"
    sentinel.write_text("private sentinel", encoding="utf-8")
    monkeypatch.setenv("IMAGE_PROMPT_LIBRARY_AUTH_PATH", str(sentinel))
    monkeypatch.setenv("OPENAI_API_KEY", "must-not-enter-preview")
    original_connect = socket.socket.connect
    with preview_session(tmp_path / "preview", delay=0) as (app, provider, seeds):
        assert os.environ["IMAGE_PROMPT_LIBRARY_AUTH_PATH"] != str(sentinel)
        assert "OPENAI_API_KEY" not in os.environ
        with httpx.Client() as outbound:
            with pytest.raises(RuntimeError, match="cannot contact"):
                outbound.post("https://api.openai.com/v1/responses", json={})
        with socket.socket() as outbound:
            with pytest.raises(RuntimeError, match="cannot contact"):
                outbound.connect(("203.0.113.1", 443))
            with pytest.raises(RuntimeError, match="cannot contact"):
                outbound.connect(("127.0.0.1", 8000))
        with TestClient(app, base_url="http://127.0.0.1:8766", client=("127.0.0.1", 12345)) as client:
            diagnostics = client.get("/__preview__/diagnostics")
            assert diagnostics.status_code == 200 and diagnostics.json()["seeds"] == seeds
            assert client.post("/__preview__/diagnostics").status_code == 405
            assert len(client.get("/api/items").json()["items"]) == 3
            assert client.get(seeds["images"][0]["url"]).status_code == 200
        with TestClient(app, base_url="http://127.0.0.1:8766", client=("203.0.113.7", 12345)) as remote:
            assert remote.get("/__preview__/diagnostics").status_code == 403
    assert socket.socket.connect is original_connect
    assert os.environ["OPENAI_API_KEY"] == "must-not-enter-preview"
    assert sentinel.read_text(encoding="utf-8") == "private sentinel"


def test_cli_rejects_production_port_and_existing_data(tmp_path):
    with pytest.raises(SystemExit) as error:
        main(["--port", "8000"])
    assert error.value.code == 2
    sentinel = tmp_path / "keep.txt"
    sentinel.write_text("retain")
    with pytest.raises(ValueError, match="new or empty"):
        with preview_session(tmp_path):
            pytest.fail("Existing data must not be opened")
    assert sentinel.read_text() == "retain"


def test_import_is_inert_and_default_cli_cleans_only_its_temporary_data(tmp_path, monkeypatch):
    result = subprocess.run([sys.executable, "-c",
        "import sys; import scripts.preview_agent; assert 'backend.main' not in sys.modules"],
        cwd=Path(__file__).resolve().parents[1], capture_output=True, text=True, timeout=10)
    assert result.returncode == 0, result.stderr
    frontend = tmp_path / "dist"
    frontend.mkdir()
    (frontend / "index.html").write_text("Synthetic frontend fixture", encoding="utf-8")
    import uvicorn
    observed = []

    def inspect_without_listening(app, **options):
        observed.append(app.state.library_path.parent)
        assert options["host"] == "127.0.0.1" and options["port"] == 8766
        assert (app.state.library_path / "db.sqlite").is_file()

    monkeypatch.setattr(uvicorn, "run", inspect_without_listening)
    main(["--frontend-dist", str(frontend)])
    assert len(observed) == 1 and not observed[0].exists()


@pytest.mark.parametrize("scenario,steps", [("text", 1), ("skill", 2)])
def test_text_and_skill_are_executed_and_saved_through_real_routes(preview, scenario, steps):
    client, provider, _, library = preview
    body = submit(client, "text", f"[preview:{scenario}] 合成测试")
    result = wait_request(client, "text")
    assert result["request"]["state"] == "completed"
    assert provider.counts["responses"] == steps and provider.counts["images"] == 0
    from backend.services.agent_repository import AgentRepository
    saved = AgentRepository(library).request("text")
    assert saved["round"]["assistantContent"]
    if scenario == "skill":
        assert any(s["section"] == "editing" for s in saved["round"]["responseDetails"]["skills"])
        assert {item["type"] for item in saved["round"]["responseOutput"]} >= {"function_call", "function_call_output"}
    replay = client.post("/api/agent/conversations/preview/rounds", json=body)
    assert replay.status_code == 200
    assert provider.counts["responses"] == steps


@pytest.mark.parametrize("marker,skill,section,task_type", [
    (PROMPT_MARKERS["reverse"], "image-prompt-reverse", "analysis", "reverse"),
    (PROMPT_MARKERS["optimize"], "gpt-image", "composition", "prompt_optimization"),
])
def test_prompt_candidate_follows_real_skill_and_records_state_in_the_same_answer(preview, marker, skill, section, task_type):
    client, provider, seeds, library = preview
    prompt = "[preview:prompt] " + marker + " 保留参考图的构图"
    submit(client, "prompt", prompt, refs=[{"kind": "upload", "uploadId": seeds["images"][0]["uploadId"]}])
    result = wait_request(client, "prompt")
    assert result["request"]["state"] == "completed", result
    from backend.services.agent_repository import AgentRepository
    from backend.services.agent_skills import read_agent_skill
    row = AgentRepository(library).request("prompt")["round"]
    exact, _ = prompt_candidate(prompt)
    assert re.search(r"```prompt\n(.*?)\n```", row["assistantContent"], re.S).group(1) == exact
    calls = {item["call_id"]: item for item in row["responseOutput"] if item["type"] == "function_call"}
    receipt = next(item for item in row["responseOutput"] if item["type"] == "function_call_output"
                   and calls[item["call_id"]]["name"] == "read_agent_skill")
    assert json.loads(receipt["output"]) == read_agent_skill(skill, section)
    state = row["taskContext"]
    candidates = [version for version in state["promptVersions"] if version["kind"] == "candidate"]
    assert len(candidates) == 1 and candidates[0]["text"] == exact
    assert candidates[0]["source"]["kind"] == "model" and candidates[0]["confirmedBy"] is None
    assert state["taskType"] == task_type and state["selectedPromptVersionId"] is None
    assert state["promptVersions"][0]["text"] == prompt
    assert provider.counts["responses"] == 2 and provider.counts["images"] == 0
    assert [calls[item["call_id"]]["name"] for item in row["responseOutput"]
            if item["type"] == "function_call_output"] == ["read_agent_skill", "update_task_context"]


def test_prompt_preview_respects_disabled_professional_workflows(preview):
    client, provider, _, library = preview
    config = client.get("/api/agent/config").json()
    assert client.put("/api/agent/config", json={"expectedRevision": config["revision"],
        "config": {**config["config"], "professionalPromptWorkflows": False}}).status_code == 200
    submit(client, "plain-prompt", "[preview:prompt] 普通候选")
    result = wait_request(client, "plain-prompt")
    assert result["request"]["state"] == "completed"
    from backend.services.agent_repository import AgentRepository
    row = AgentRepository(library).request("plain-prompt")["round"]
    assert "专业工作流已关闭" in row["assistantContent"]
    assert provider.counts["responses"] == 1 and provider.counts["images"] == 0


def test_continue_selected_prompt_inherits_preview_without_auto_selecting_the_new_candidate(preview):
    client, provider, _, library = preview
    prompt = "[preview:prompt] " + PROMPT_MARKERS["reverse"] + " " + PROMPT_MARKERS["failure_once"]
    submit(client, "first-candidate", prompt)
    first = wait_request(client, "first-candidate")
    from backend.services.agent_repository import AgentRepository
    repo = AgentRepository(library)
    first_row = repo.request("first-candidate")["round"]
    exact, _ = prompt_candidate(prompt)
    selected = client.patch("/api/agent/conversations/preview/task-context", json={
        "expectedRevision": first["revision"], "branchRoundId": first_row["id"],
        "taskRevision": first["taskContext"]["revision"], "operations": [{"op": "set_prompt", "kind": "selected",
            "text": exact, "source": {"kind": "model", "roundId": first_row["id"], "messageId": first_row["assistantMessageId"]}}]})
    assert selected.status_code == 200, selected.text
    old_selection = selected.json()["taskContext"]["selectedPromptVersionId"]
    # This is the ordinary text produced by the real Continue optimization button.
    continuation = "请继续优化以下明确选定的提示词，保留已确认的约束；提供候选版本，等待我明确选择。\n\n" + exact
    submit(client, "continue-candidate", continuation, parent=first_row["id"])
    result = wait_request(client, "continue-candidate")
    assert result["request"]["state"] == "completed"
    current = repo.request("continue-candidate")["round"]
    expected, _ = prompt_candidate(continuation)
    assert "A natural still-life photograph" in expected and "preview-fail-once-recipe" in expected
    assert expected in current["assistantContent"]
    assert current["taskContext"]["selectedPromptVersionId"] == old_selection
    assert current["taskContext"]["promptVersions"][-1]["kind"] == "candidate"
    assert provider.counts["responses"] == 4 and provider.counts["images"] == 0


def test_prompt_preview_still_returns_text_when_image_generation_is_enabled(preview):
    client, provider, _, library = preview
    submit(client, "prompt-not-image", "[preview:prompt] 反推中文候选", images=True)
    result = wait_request(client, "prompt-not-image")
    assert result["request"]["state"] == "completed"
    from backend.services.agent_repository import AgentRepository
    row = AgentRepository(library).request("prompt-not-image")["round"]
    assert "```prompt" in row["assistantContent"] and row["outputTaskIds"] == []
    assert provider.counts["responses"] == 2 and provider.counts["images"] == 0


def test_generated_image_edit_branch_and_library_accept_use_real_persistence(preview):
    client, provider, seeds, library = preview
    submit(client, "first", "[preview:image] 生成几何图片", images=True)
    first = wait_request(client, "first")
    assert first["request"]["state"] == "completed", first
    job = first["jobs"][0]
    assert job["status"] == "succeeded" and (library / job["result_path"]).is_file()
    accepted = client.post(f"/api/generation-jobs/{job['id']}/accept-as-new-item")
    assert accepted.status_code == 200, accepted.text
    assert len(client.get("/api/items").json()["items"]) == 4
    submit(client, "edit", "[preview:edit] 保持主体换背景", images=True,
           parent=first["request"]["roundId"], refs=[{"kind": "job", "jobId": job["id"]}])
    edited = wait_request(client, "edit")
    assert edited["request"]["state"] == "completed", edited
    assert edited["jobs"][-1]["parameters"]["input_images"]
    assert any(request["path"] == "/v1/images/edits" for request in provider.requests)
    submit(client, "branch", "[preview:text] 从第一轮分支", parent=first["request"]["roundId"])
    assert wait_request(client, "branch")["request"]["state"] == "completed"
    from backend.services.agent_repository import AgentRepository
    history = AgentRepository(library).request("branch")["history"]
    assert [round_data["requestId"] for round_data in history] == ["first"]


def test_partial_batch_and_explicit_retry_only_add_one_image_post(preview):
    client, provider, _, _ = preview
    submit(client, "partial", "[preview:partial] 三张独立图片", images=True, count=3)
    result = wait_request(client, "partial")
    assert result["request"]["state"] == "failed", result
    assert sorted(job["status"] for job in result["jobs"]) == ["failed", "succeeded", "succeeded"]
    failed = next(job for job in result["jobs"] if job["status"] == "failed")
    counts = provider.counts.copy()
    retry = client.post(f"/api/generation-jobs/{failed['id']}/retry-current", json={
        "retryId": "preview-retry", "conversationId": "preview", "confirmed": True,
        "configRevision": client.get("/api/agent/config").json()["revision"],
        "imageConfig": {"profileId": "preview-retry", "model": "gpt-image-preview"},
        "params": {"size": "1024x1024", "quality": "auto", "output_format": "png"}})
    assert retry.status_code == 202, retry.text
    until = time.monotonic() + 8
    while time.monotonic() < until:
        receipt = client.get("/api/generation-jobs/retry-submissions/preview-retry", params={"conversation_id": "preview"}).json()
        if receipt["job"]["status"] == "succeeded":
            break
        time.sleep(0.02)
    assert receipt["job"]["status"] == "succeeded", receipt
    assert provider.counts["images"] == counts["images"] + 1
    assert provider.counts["responses"] == counts["responses"]


def test_native_and_unknown_are_real_terminal_receipts(preview):
    client, provider, _, library = preview
    config = client.get("/api/agent/config").json()
    saved = client.put("/api/agent/config", json={"expectedRevision": config["revision"],
        "config": {**config["config"], "apiConfigMode": "native"}})
    assert saved.status_code == 200
    submit(client, "native", "[preview:native] 原生图片", images=True)
    result = wait_request(client, "native")
    assert result["request"]["state"] == "completed", result
    assert result["jobs"][0]["provider"] == "agent_native"
    assert provider.counts["images"] == 0
    submit(client, "unknown", "[preview:unknown] 最终回执前断线", images=True)
    result = wait_request(client, "unknown")
    assert result["request"]["state"] == "unknown", result
    assert result["request"]["upstreamOutcome"] == "unknown" and not result["request"]["canResume"]
    counts = provider.counts.copy()
    client.get("/api/agent/requests/unknown")
    assert provider.counts == counts


def test_slow_stream_can_be_stopped_without_another_post(preview):
    client, provider, _, _ = preview
    submit(client, "slow", "[preview:slow] 检查停止")
    until = time.monotonic() + 5
    while not provider.counts["responses"] and time.monotonic() < until:
        time.sleep(0.02)
    response = client.post("/api/agent/requests/slow/stop")
    assert response.status_code == 200, response.text
    assert wait_request(client, "slow")["request"]["state"] == "stopped"
    assert provider.counts["responses"] == 1 and provider.counts["images"] == 0
