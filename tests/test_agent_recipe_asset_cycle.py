"""Real HTTP, workers, queue and Library cycle; only provider transport is mocked."""
import base64
import copy
from email.parser import BytesParser
from email.policy import default
import hashlib
import json
import time

from scripts.preview_agent import PROMPT_MARKERS, prompt_candidate, synthetic_png
from test_preview_agent import preview, submit, wait_request


def patch_context(client, operations):
    current = client.get("/api/agent/conversations/preview").json()
    response = client.patch("/api/agent/conversations/preview/task-context", json={
        "expectedRevision": current["revision"], "branchRoundId": current["conversation"]["activeRoundId"],
        "taskRevision": current["taskContext"]["revision"], "operations": operations})
    assert response.status_code == 200, response.text
    return response.json()


def wait_retry(client, retry_id):
    until = time.monotonic() + 12
    while time.monotonic() < until:
        response = client.get("/api/generation-jobs/retry-submissions/" + retry_id,
                              params={"conversation_id": "preview"})
        assert response.status_code == 200, response.text
        receipt = response.json()
        if receipt["job"]["status"] not in {"queued", "running"}:
            return receipt
        time.sleep(0.02)
    raise AssertionError("Offline retry did not settle")


def capture_provider(provider, monkeypatch):
    calls, original = [], provider.handle
    def handle(request):
        content_type = request.headers.get("content-type", "")
        raw = request.read()
        if "multipart/form-data" in content_type:
            message = BytesParser(policy=default).parsebytes(("Content-Type: " + content_type + "\r\n\r\n").encode() + raw)
            value = [(part.get_param("name", header="content-disposition"), part.get_payload(decode=True))
                     for part in message.iter_parts()]
        else:
            value = json.loads(raw)
        calls.append((request.url.path, value))
        return original(request)
    monkeypatch.setattr(provider, "handle", handle)
    return calls


def multipart_value(parts, key):
    return next(value for name, value in parts if name == key)


def test_native_preview_direct_recipe_sends_one_image_only_response_with_ordered_pixels(preview, monkeypatch):
    client, provider, seeds, library = preview
    from backend.services.agent_repository import AgentRepository
    calls = capture_provider(provider, monkeypatch)
    config = client.get("/api/agent/config").json()
    saved = client.put("/api/agent/config", json={"expectedRevision": config["revision"],
        "config": {**config["config"], "apiConfigMode": "native"}})
    assert saved.status_code == 200, saved.text
    exact = "  Exact user-selected Native Prompt.\nPreserve the target and lighting.  "
    selected = patch_context(client, [{"op": "new_task", "text": "Native original", "taskType": "prompt"},
        {"op": "set_prompt", "text": exact, "kind": "selected"},
        {"op": "set_target", "ref": {"kind": "upload", "uploadId": seeds["images"][0]["uploadId"]}},
        {"op": "set_auxiliaries", "auxiliaries": [{"role": "lighting", "ref": {
            "kind": "upload", "uploadId": seeds["images"][1]["uploadId"]}}]}])
    task = selected["taskContext"]
    response = client.post("/api/agent/conversations/preview/prompt-executions", json={
        "requestId": "direct-native", "expectedRevision": selected["revision"],
        "branchRoundId": selected["conversation"]["activeRoundId"], "taskId": task["taskId"],
        "taskRevision": task["revision"], "promptVersionId": task["selectedPromptVersionId"],
        "configRevision": saved.json()["revision"], "imageCount": 1, "confirmed": True,
        "params": {"size": "1024x1024", "quality": "auto", "output_format": "png"}})
    assert response.status_code == 202, response.text
    result = wait_request(client, "direct-native")
    assert result["request"]["state"] == "completed", result
    assert provider.counts["responses"] == 1 and provider.counts["images"] == 0
    assert len(calls) == 1 and calls[0][0] == "/v1/responses"
    body = calls[0][1]
    assert body["tool_choice"] == {"type": "image_generation"} and body["max_tool_calls"] == 1
    assert len(body["tools"]) == 1 and body["tools"][0]["type"] == "image_generation"
    content = body["input"][0]["content"]
    assert content[0]["text"] == exact
    assert [base64.b64decode(part["image_url"].split(",", 1)[1]) for part in content if part["type"] == "input_image"] == [
        synthetic_png(0), synthetic_png(1)]
    repo = AgentRepository(library)
    request = repo.request("direct-native")
    assert request["usage"]["responseStepsStarted"] == 0
    assert [ref["role"] for ref in request["round"]["directRecipe"]["references"]] == ["target", "lighting"]
    assert request["round"]["assistantContent"] == ""
    recorded = request["round"]["taskContext"]
    assert recorded["selectedPromptVersionId"] == task["selectedPromptVersionId"]
    assert next(version for version in recorded["promptVersions"]
                if version["id"] == recorded["executedPromptVersionId"])["text"] == exact
    job = repo.jobs.get_job(request["round"]["outputTaskIds"][0])
    assert job.prompt_text == exact and job.status == "succeeded"
    assert (library / job.result_path).read_bytes() == synthetic_png(1)


def test_reverse_optimize_confirm_direct_failure_retry_accept_and_reference_preserve_recipe(preview, monkeypatch):
    client, provider, _, library = preview
    from backend.services.agent_repository import AgentRepository
    repo = AgentRepository(library)
    calls = capture_provider(provider, monkeypatch)
    raw = synthetic_png(7)
    uploaded = client.post("/api/agent/uploads", files={"file": ("geometric-reference.png", raw, "image/png")})
    assert uploaded.status_code == 200, uploaded.text
    upload_id = uploaded.json()["uploadId"]
    source_asset = repo.asset(upload_id)
    source_path = library / source_asset["path"]
    source_digest = hashlib.sha256(raw).hexdigest()
    assert source_path.read_bytes() == raw and source_asset["sha256"] == source_digest

    reverse_prompt = "[preview:prompt] " + PROMPT_MARKERS["reverse"] + " 根据上传图反推中文提示词"
    submit(client, "reverse", reverse_prompt, refs=[{"kind": "upload", "uploadId": upload_id}])
    reverse = wait_request(client, "reverse")
    assert reverse["request"]["state"] == "completed"
    reverse_row = repo.request("reverse")["round"]
    assert "并非图片的原始 Prompt" in reverse_row["assistantContent"]
    assert reverse_row["taskContext"]["selectedPromptVersionId"] is None
    original_version = copy.deepcopy(reverse_row["taskContext"]["promptVersions"][0])
    assert original_version["text"] == reverse_prompt

    english_prompt = "[preview:prompt] " + PROMPT_MARKERS["optimize"] + " " + PROMPT_MARKERS["failure_once"] + " 优化成英文并保留构图"
    submit(client, "english", english_prompt, parent=reverse["request"]["roundId"])
    optimized = wait_request(client, "english")
    assert optimized["request"]["state"] == "completed"
    english_row = repo.request("english")["round"]
    exact, _ = prompt_candidate(english_prompt)
    assert exact in english_row["assistantContent"] and "```prompt\n" in english_row["assistantContent"]
    assert english_row["taskContext"]["selectedPromptVersionId"] is None
    assert provider.counts["responses"] == 4 and provider.counts["images"] == 0
    assert {call["name"] for call in english_row["responseOutput"] if call.get("type") == "function_call"} == {
        "read_agent_skill", "update_task_context"}

    # This is the user's explicit selection of the exact answer block and role,
    # using the same public API as the UI. A model candidate never selects itself.
    selected = patch_context(client, [
        {"op": "set_prompt", "text": exact, "kind": "selected", "source": {
            "kind": "model", "roundId": english_row["id"], "messageId": english_row["assistantMessageId"]}},
        {"op": "set_target", "ref": {"kind": "upload", "uploadId": upload_id}}])
    task = selected["taskContext"]
    source_version_id = task["selectedPromptVersionId"]
    source_version = next(version for version in task["promptVersions"] if version["id"] == source_version_id)
    assert source_version["text"] == exact and source_version["confirmedBy"] == "user"
    assert source_version["source"]["roundId"] == english_row["id"]
    assert next(version for version in task["promptVersions"] if version["id"] == task["originalPromptVersionId"]) == original_version
    value = {"requestId": "confirmed-recipe", "expectedRevision": selected["revision"],
        "branchRoundId": selected["conversation"]["activeRoundId"], "taskId": task["taskId"],
        "taskRevision": task["revision"], "promptVersionId": source_version_id,
        "configRevision": client.get("/api/agent/config").json()["revision"],
        "imageCount": 1, "confirmed": True,
        "params": {"size": "1024x1024", "quality": "auto", "output_format": "png"}}
    response = client.post("/api/agent/conversations/preview/prompt-executions", json=value)
    assert response.status_code == 202, response.text
    failed = wait_request(client, "confirmed-recipe")
    assert failed["request"]["state"] == "failed", failed
    root_round = repo.request("confirmed-recipe")["round"]
    recipe = copy.deepcopy(root_round["directRecipe"])
    root_job_id = root_round["outputTaskIds"][0]
    root_job = repo.jobs.get_job(root_job_id)
    assert root_job.status == "failed" and root_job.prompt_text == exact
    assert recipe["prompt"] == exact and recipe["promptVersionId"] == source_version_id
    assert recipe["promptSource"] == source_version["source"]
    assert [(ref["assetId"], ref["role"], ref["sha256"]) for ref in recipe["references"]] == [(upload_id, "target", source_digest)]
    assert root_job.metadata["agent"]["recipeFingerprint"] == recipe["fingerprint"]
    assert repo.request("confirmed-recipe")["usage"]["responseStepsStarted"] == 0
    assert provider.counts["responses"] == 4 and provider.counts["images"] == 1
    first_parts = next(parts for path, parts in calls if path == "/v1/images/edits")
    assert multipart_value(first_parts, "prompt").decode() == exact
    assert [data for name, data in first_parts if name in {"image", "image[]"}] == [raw]
    assert client.post("/api/agent/conversations/preview/prompt-executions", json=value).status_code == 200
    assert client.get("/api/agent/prompt-executions/confirmed-recipe", params={"conversation_id": "preview"}).status_code == 200
    assert provider.counts["images"] == 1

    # Changing the current image configuration creates a new, explicit attempt.
    # The failed job and its confirmed recipe remain the original receipt.
    config = client.get("/api/agent/config").json()
    configured = client.put("/api/agent/config", json={"expectedRevision": config["revision"],
        "config": {**config["config"], "imageProfileId": "preview-retry", "imageModel": "gpt-image-preview-retry"}})
    assert configured.status_code == 200, configured.text
    retry_value = {"retryId": "recipe-retry", "conversationId": "preview", "confirmed": True,
        "configRevision": configured.json()["revision"],
        "imageConfig": {"profileId": "preview-retry", "model": "gpt-image-preview-retry"},
        "params": {"size": "1536x1024", "quality": "low", "output_format": "png"}}
    response = client.post(f"/api/generation-jobs/{root_job_id}/retry-current", json=retry_value)
    assert response.status_code == 202, response.text
    retried = wait_retry(client, "recipe-retry")
    assert retried["job"]["status"] == "succeeded", retried
    retry_job = repo.jobs.get_job(retried["job"]["id"])
    assert retry_job.prompt_text == exact and retry_job.parameters["compatible_profile_id"] == "preview-retry"
    assert retry_job.model == "gpt-image-preview-retry"
    lineage = retry_job.metadata["agentRetry"]
    assert lineage["sourceJobId"] == lineage["rootSourceJobId"] == root_job_id
    assert lineage["confirmedRecipe"]["promptVersionId"] == source_version_id
    assert lineage["confirmedRecipe"]["recipeFingerprint"] == recipe["fingerprint"]
    assert lineage["confirmedRecipe"]["promptSource"] == source_version["source"]
    assert provider.counts["responses"] == 4 and provider.counts["images"] == 2
    image_calls = [parts for path, parts in calls if path == "/v1/images/edits"]
    assert len(image_calls) == 2
    assert multipart_value(image_calls[-1], "prompt").decode() == exact
    assert multipart_value(image_calls[-1], "model") == b"gpt-image-preview-retry"
    assert multipart_value(image_calls[-1], "size") == b"1536x1024"
    assert [data for name, data in image_calls[-1] if name in {"image", "image[]"}] == [raw]
    assert client.post(f"/api/generation-jobs/{root_job_id}/retry-current", json=retry_value).status_code == 200
    assert provider.counts["images"] == 2
    root_after = repo.request("confirmed-recipe")["round"]
    assert root_after["directRecipe"] == recipe
    executed = next(version for version in root_after["taskContext"]["promptVersions"]
                    if version["id"] == root_after["taskContext"]["executedPromptVersionId"])
    assert executed["text"] == exact and executed["kind"] == "executed"
    assert root_after["taskContext"]["selectedPromptVersionId"] == source_version_id
    assert repo.jobs.get_job(root_job_id).status == "failed"

    generated = (library / retry_job.result_path).read_bytes()
    accepted = client.post(f"/api/generation-jobs/{retry_job.id}/accept-as-new-item",
                           json={"title": "Offline confirmed recipe", "auto_title": False})
    assert accepted.status_code == 200, accepted.text
    item = accepted.json()["item"]
    assert item["prompts"][0]["text"] == exact
    assert item["prompts"][0]["provenance"]["source_generation_job_id"] == retry_job.id
    reference_images = [image for image in item["images"] if image["role"] == "reference_image"]
    assert reference_images and any((library / image["original_path"]).read_bytes() == raw for image in reference_images)
    accepted_id = accepted.json()["job"]["accepted_image_id"]
    result_image = next(image for image in item["images"] if image["id"] == accepted_id)
    assert client.get("/media/" + result_image["original_path"]).content == generated
    assert len(client.get("/api/items").json()["items"]) == 4

    submit(client, "reference-again", "[preview:text] 描述已收录结果，不生成图片", parent=root_round["id"],
           refs=[{"kind": "library", "imageId": accepted_id}])
    final = wait_request(client, "reference-again")
    assert final["request"]["state"] == "completed"
    new_input = repo.request("reference-again")["round"]["inputImageIds"][0]
    frozen = repo.asset(new_input)
    assert json.loads(frozen["source"]) == {"kind": "library", "imageId": accepted_id}
    assert (library / frozen["path"]).read_bytes() == generated
    sent = next(body for path, body in reversed(calls) if path == "/v1/responses")
    actual_pixels = [base64.b64decode(part["image_url"].split(",", 1)[1]) for row in sent["input"]
                     for part in row.get("content", []) if part.get("type") == "input_image"]
    assert generated in actual_pixels
    assert provider.counts["responses"] == 5 and provider.counts["images"] == 2 and provider.counts["blocked"] == 0
    assert source_path.read_bytes() == raw and hashlib.sha256(source_path.read_bytes()).hexdigest() == source_digest
    assert repo.request("reverse")["round"]["prompt"] == reverse_prompt
    assert repo.request("confirmed-recipe")["round"]["directRecipe"] == recipe
