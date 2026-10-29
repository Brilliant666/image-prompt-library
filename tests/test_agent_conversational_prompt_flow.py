"""Actual HTTP/worker flow without manual task controls; only provider IO is mocked."""
import base64
import copy
import json
import httpx
from scripts.preview_agent import synthetic_png
from test_preview_agent import preview, submit, wait_request
from test_agent_recipe_asset_cycle import capture_provider, multipart_value, wait_retry

ZH = "  蓝色方体与橙色球体，暖白背景。\n保留构图，自然侧光。  "
EN = "  A blue block and orange sphere on ivory.\nKeep framing and natural side light.  "
SOFT = "  A blue block and orange sphere on ivory.\nKeep framing; use soft light.  \npreview-fail-once-conversational"


def conversational_model(provider, monkeypatch):
    original, captured = provider.handle, []
    answers = {"反推这张图": (ZH, "reverse", ("image-prompt-reverse", "analysis")),
               "改成英文": (EN, "prompt_optimization", ("gpt-image", "composition")),
               "光线柔和一点，其他保持": (SOFT, "prompt_optimization", None)}
    def handle(request):
        if not request.url.path.endswith("/responses"):
            return original(request)
        body = json.loads(request.read())
        captured.append(copy.deepcopy(body))
        prompt, followups, _ = provider.current_turn(body)
        with provider.lock:
            provider.counts["responses"] += 1
            n = provider.counts["responses"]
        message = {"id": f"message-{n}", "type": "message", "role": "assistant",
                   "content": [{"type": "output_text", "text": "继续讨论构图，没有生成新图。"}]}
        output = [message]
        if prompt in answers:
            exact, task_type, skill = answers[prompt]
            task = provider.task_context(body)
            assert task
            if skill and not provider.skill_completed(followups, *skill):
                output = [{"id": f"skill-{n}", "call_id": f"skill-{n}", "type": "function_call",
                           "name": "read_agent_skill",
                           "arguments": json.dumps({"skill": skill[0], "section": skill[1]})}]
            else:
                fence = chr(96) * 3
                message["content"][0]["text"] = "提示词候选：\n\n" + fence + "prompt\n" + exact + "\n" + fence
                output.append({"id": f"state-{n}", "call_id": f"state-{n}", "type": "function_call",
                    "name": "update_task_context", "arguments": json.dumps({
                    "taskId": task["taskId"], "taskRevision": task["revision"], "branchRoundId": task["branchRoundId"],
                    "operations": [{"op": "set_task_type", "taskType": task_type},
                                   {"op": "set_prompt", "text": exact, "kind": "candidate"}]}, ensure_ascii=False)})
        return httpx.Response(200, json={"id": f"response-{n}", "status": "completed",
                                        "model": "offline-conversational", "output": output})
    monkeypatch.setattr(provider, "handle", handle)
    return captured


def select_block(client, row, exact):
    current = client.get("/api/agent/conversations/preview").json()
    return client.patch("/api/agent/conversations/preview/task-context", json={
        "expectedRevision": current["revision"], "branchRoundId": current["conversation"]["activeRoundId"],
        "taskRevision": current["taskContext"]["revision"], "operations": [{
            "op": "set_prompt", "kind": "selected", "text": exact, "source": {
            "kind": "model", "roundId": row["id"], "messageId": row["assistantMessageId"]}}]})


def pixels(body):
    return [base64.b64decode(p["image_url"].split(",", 1)[1]) for item in body["input"]
            for p in item.get("content", []) if p.get("type") == "input_image"]


def test_reverse_english_light_direct_retry_library_and_chat_without_task_panel(preview, monkeypatch):
    client, provider, _, library = preview
    from backend.services.agent_repository import AgentRepository
    repo = AgentRepository(library)
    bodies = conversational_model(provider, monkeypatch)
    calls = capture_provider(provider, monkeypatch)
    raw = synthetic_png(8)
    upload = client.post("/api/agent/uploads", files={"file": ("synthetic.png", raw, "image/png")})
    assert upload.status_code == 200, upload.text
    aid = upload.json()["uploadId"]
    parent = previous = original = task_id = None
    for rid, instruction, exact in [("reverse-natural", "反推这张图", ZH),
                                    ("english-natural", "改成英文", EN),
                                    ("light-natural", "光线柔和一点，其他保持", SOFT)]:
        offset = len(bodies)
        submit(client, rid, instruction, parent=parent,
               refs=[{"kind": "upload", "uploadId": aid}] if parent is None else [])
        result = wait_request(client, rid)
        assert result["request"]["state"] == "completed", result
        row, task = repo.request(rid)["round"], repo.request(rid)["round"]["taskContext"]
        assert task["target"]["assetId"] == aid
        assert task["selectedPromptVersionId"] is None
        working = next(p for p in task["promptVersions"] if p["id"] == task["workingPromptVersionId"])
        assert (working["text"], working["kind"], working["confirmedBy"]) == (exact, "candidate", None)
        if task_id is None:
            task_id, original = task["taskId"], copy.deepcopy(task["promptVersions"][0])
        assert task["taskId"] == task_id
        assert next(p for p in task["promptVersions"] if p["id"] == task["originalPromptVersionId"]) == original
        if previous:
            projected = provider.task_context(bodies[offset])
            assert any(p["text"] == previous for p in projected["promptVersions"])
            assert projected.get("selectedPromptVersionId") is None
        parent, previous = row["id"], exact
    assert len(bodies) == 5 and provider.counts["images"] == 0 and raw in pixels(bodies[0])
    # Only Generate's internal exact-block selection, never set_target/scope/completeness.
    selected = select_block(client, row, SOFT)
    assert selected.status_code == 200, selected.text
    selected, task = selected.json(), selected.json()["taskContext"]
    version = next(p for p in task["promptVersions"] if p["id"] == task["selectedPromptVersionId"])
    assert version["source"]["roundId"] == row["id"]
    assert version["source"]["messageId"] == row["assistantMessageId"]
    params = {"size": "1024x1024", "quality": "auto", "output_format": "jpeg", "output_compression": 0}
    body = {"requestId": "natural-direct", "expectedRevision": selected["revision"],
            "branchRoundId": selected["conversation"]["activeRoundId"], "taskId": task["taskId"],
            "taskRevision": task["revision"], "promptVersionId": task["selectedPromptVersionId"],
            "configRevision": client.get("/api/agent/config").json()["revision"],
            "imageCount": 1, "confirmed": True, "params": params}
    response = client.post("/api/agent/conversations/preview/prompt-executions", json=body)
    assert response.status_code == 202, response.text
    assert wait_request(client, "natural-direct")["request"]["state"] == "failed"
    request = repo.request("natural-direct")
    recipe = copy.deepcopy(request["round"]["directRecipe"])
    assert request["usage"]["responseStepsStarted"] == 0
    assert recipe["prompt"] == SOFT and recipe["params"]["output_compression"] == 0
    assert [(r["assetId"], r["role"]) for r in recipe["references"]] == [(aid, "target")]
    assert provider.counts["responses"] == 5 and provider.counts["images"] == 1
    assert client.post("/api/agent/conversations/preview/prompt-executions", json=body).status_code == 200
    assert client.get("/api/agent/prompt-executions/natural-direct", params={"conversation_id": "preview"}).status_code == 200
    assert provider.counts["images"] == 1
    job_id = request["round"]["outputTaskIds"][0]
    current_config = client.get("/api/agent/config").json()
    retry = {"retryId": "natural-retry", "conversationId": "preview", "confirmed": True,
             "configRevision": current_config["revision"], "params": params,
             "imageConfig": {"profileId": current_config["config"]["imageProfileId"],
                             "model": current_config["config"]["imageModel"]}}
    response = client.post(f"/api/generation-jobs/{job_id}/retry-current", json=retry)
    assert response.status_code == 202, response.text
    receipt = wait_retry(client, "natural-retry")
    assert receipt["job"]["status"] == "succeeded", receipt
    assert provider.counts["responses"] == 5 and provider.counts["images"] == 2
    image_calls = [parts for path, parts in calls if path == "/v1/images/edits"]
    assert len(image_calls) == 2
    assert all(multipart_value(parts, "prompt").decode() == SOFT for parts in image_calls)
    assert all([data for name, data in parts if name in {"image", "image[]"}] == [raw] for parts in image_calls)
    assert client.post(f"/api/generation-jobs/{job_id}/retry-current", json=retry).status_code == 200
    assert provider.counts["images"] == 2
    accepted = client.post(f"/api/generation-jobs/{receipt['job']['id']}/accept-as-new-item",
                           json={"title": "Synthetic conversational flow", "auto_title": False})
    assert accepted.status_code == 200, accepted.text
    item = accepted.json()["item"]
    assert item["prompts"][0]["text"] == SOFT
    assert item["prompts"][0]["provenance"]["source_generation_job_id"] == receipt["job"]["id"]
    accepted_id = accepted.json()["job"]["accepted_image_id"]
    image = next(i for i in item["images"] if i["id"] == accepted_id)
    generated = (library / image["original_path"]).read_bytes()
    assert any((library / i["original_path"]).read_bytes() == raw for i in item["images"] if i["role"] == "reference_image")
    submit(client, "continued-chat", "分析这张结果的构图，不生成", parent=request["round"]["id"],
           refs=[{"kind": "library", "imageId": accepted_id}])
    assert wait_request(client, "continued-chat")["request"]["state"] == "completed"
    assert generated in pixels(bodies[-1])
    assert provider.counts["responses"] == 6 and provider.counts["images"] == 2 and provider.counts["blocked"] == 0
    assert repo.request("natural-direct")["round"]["directRecipe"] == recipe
    assert repo.request("reverse-natural")["round"]["prompt"] == "反推这张图"
    assert (library / repo.asset(aid)["path"]).read_bytes() == raw



def test_clicked_candidate_keeps_exact_source_instead_of_last_candidate_and_rejects_other_branch(preview, monkeypatch):
    client, provider, _, library = preview
    from backend.services.agent_repository import AgentRepository
    repo = AgentRepository(library)
    first = "  First candidate.\nKeep exact whitespace.  "
    second = "Second candidate, deliberately different."
    original = provider.handle

    def answer(request):
        if not request.url.path.endswith("/responses"):
            return original(request)
        body = json.loads(request.read())
        task = provider.task_context(body)
        with provider.lock:
            provider.counts["responses"] += 1
            number = provider.counts["responses"]
        fence = chr(96) * 3
        output = [{"id": f"message-multi-{number}", "type": "message", "role": "assistant",
                   "content": [{"type": "output_text", "text":
                       fence + "prompt\n" + first + "\n" + fence + "\n\n" +
                       fence + "prompt\n" + second + "\n" + fence}]}]
        output.append({"id": f"state-multi-{number}", "call_id": f"state-multi-{number}",
                       "type": "function_call", "name": "update_task_context", "arguments": json.dumps({
                           "taskId": task["taskId"], "taskRevision": task["revision"], "branchRoundId": task["branchRoundId"],
                           "operations": [{"op": "set_task_type", "taskType": "prompt"},
                                          {"op": "set_prompt", "text": first, "kind": "candidate"},
                                          {"op": "set_prompt", "text": second, "kind": "candidate"}]})})
        return httpx.Response(200, json={"id": f"multi-{number}", "status": "completed", "output": output})

    monkeypatch.setattr(provider, "handle", answer)
    calls = capture_provider(provider, monkeypatch)
    submit(client, "two-candidates", "给我两个合成提示词方案")
    assert wait_request(client, "two-candidates")["request"]["state"] == "completed"
    row = repo.request("two-candidates")["round"]
    state = row["taskContext"]
    assert state["selectedPromptVersionId"] is None
    assert next(p["text"] for p in state["promptVersions"] if p["id"] == state["workingPromptVersionId"]) == second
    selected = select_block(client, row, first)
    assert selected.status_code == 200, selected.text
    selected = selected.json()
    task = selected["taskContext"]
    body = {"requestId": "first-candidate-direct", "expectedRevision": selected["revision"],
            "branchRoundId": row["id"], "taskId": task["taskId"], "taskRevision": task["revision"],
            "promptVersionId": task["selectedPromptVersionId"],
            "configRevision": client.get("/api/agent/config").json()["revision"],
            "imageCount": 1, "confirmed": True, "params": {"size": "1024x1024", "output_format": "png"}}
    response = client.post("/api/agent/conversations/preview/prompt-executions", json=body)
    assert response.status_code == 202, response.text
    assert wait_request(client, "first-candidate-direct")["request"]["state"] == "completed"
    assert provider.counts["responses"] == 1 and provider.counts["images"] == 1
    recipe = repo.request("first-candidate-direct")["round"]["directRecipe"]
    assert recipe["prompt"] == first and recipe["promptSource"]["roundId"] == row["id"]
    sent = next(value for path, value in calls if path == "/v1/images/generations")
    assert sent["prompt"] == first

    # Editing the original user message creates a different branch. The old
    # assistant block remains in stored history, but is not an authorized source.
    current = client.get("/api/agent/conversations/preview").json()
    branched = client.post("/api/agent/conversations/preview/rounds", json={
        "requestId": "other-branch", "expectedRevision": current["revision"],
        "origin": "edit", "derivedFromRoundId": row["id"], "parentRoundId": None,
        "prompt": "改成另一组独立的合成方案", "configRevision": client.get("/api/agent/config").json()["revision"],
        "authorization": {"scope": "this_request", "allowImageGeneration": False, "maxToolRounds": 5, "maxImageJobs": 0}})
    assert branched.status_code == 202, branched.text
    assert wait_request(client, "other-branch")["request"]["state"] == "completed"
    before = client.get("/api/agent/conversations/preview").json()
    invalid = select_block(client, row, first)
    assert invalid.status_code == 400 and invalid.json()["detail"]["code"] == "invalid_task_source", invalid.text
    after = client.get("/api/agent/conversations/preview").json()
    assert after["revision"] == before["revision"] and after["taskContext"] == before["taskContext"]
    assert provider.counts["responses"] == 2 and provider.counts["images"] == 1
