"""Task context is verified at the actual outgoing Responses wire boundary."""
import copy
import json

from backend.agent_schemas import AgentRoundCreate
from backend.db import connect
from backend.services.agent_repository import encoded
from test_agent_image_selection import body, repo
from test_agent_context_correctness import asset, capture_request, pixels


def test_prompt_history_locators_do_not_duplicate_long_source_quotes_or_mutate_storage():
    from backend.services.agent_context_scope import task_data
    from backend.services.agent_task_state import new
    state = new('Original user text', 'source-round')
    state['promptVersions'].append({'id': 'previous-candidate', 'kind': 'candidate', 'text': 'Old candidate',
        'source': {'kind': 'model', 'roundId': 'source-round', 'messageId': 'source-message',
                   'userInstruction': {'quote': 'Long original instruction ' * 4000}}})
    state['promptVersions'].append({'id': 'current-candidate', 'kind': 'candidate', 'text': 'Current candidate',
                                   'source': {'kind': 'model', 'roundId': 'current-round'}})
    state['workingPromptVersionId'] = 'current-candidate'
    original = copy.deepcopy(state)
    view = task_data(state, {})
    old = next(p for p in view['promptHistory'] if p['id'] == 'previous-candidate')
    assert old['source'] == {'kind': 'model', 'roundId': 'source-round', 'messageId': 'source-message'}
    assert len(json.dumps(view['promptHistory'])) < 1000
    assert state == original
    assert state['promptVersions'][1]['source']['userInstruction']['quote']


def turn(repo, request_id, prompt, *, parent=None, assets=(), scope="task", history=()):
    value = body(repo, request_id, images=False).model_dump()
    value.update(prompt=prompt, parentRoundId=parent,
                 refs=[{"kind": "upload", "uploadId": aid} for aid in assets],
                 contextScope=scope, historyRoundIds=list(history))
    repo.create_round("conversation", AgentRoundCreate.model_validate(value))
    repo.update(request_id, state="completed", outcome="known")
    return repo.request(request_id)["round_id"]


def patch_task(repo, branch, operations):
    from backend.agent_schemas import AgentTaskContextPatch
    snapshot = repo.snapshot("conversation")
    value = {"expectedRevision": snapshot["revision"], "branchRoundId": branch, "operations": operations}
    if snapshot.get("taskContext"):
        value["taskRevision"] = snapshot["taskContext"]["revision"]
    return repo.patch_task_context("conversation", AgentTaskContextPatch.model_validate(value))


def text(payload):
    return "\n".join(part.get("text", "") for item in payload["input"] for part in item.get("content", []))


def test_completed_unrelated_tasks_do_not_reenter_current_target_and_auxiliary_wire(repo, monkeypatch):
    older, target, auxiliary = [asset(repo, color) for color in ("red", "blue", "yellow")]
    root = turn(repo, "old", "OLD_TASK_PRIVATE_WORDING: 帮她修改红色衣服。", assets=[older])
    old = copy.deepcopy(repo.request("old"))
    patch_task(repo, root, [{"op": "new_task", "text": "CURRENT_TASK: keep the pose.", "taskType": "image_edit"},
        {"op": "set_target", "ref": {"kind": "upload", "uploadId": target}},
        {"op": "set_auxiliaries", "auxiliaries": [{"ref": {"kind": "upload", "uploadId": auxiliary}, "role": "lighting"}]}])
    turn(repo, "current", "Keep the selected target and lighting reference; change only the socks.",
         parent=root, assets=[target, auxiliary])
    before = copy.deepcopy(repo.request("current")["history"])
    sent = capture_request(repo, monkeypatch, "current")
    assert set(pixels(sent)) == {repo.data_url(target), repo.data_url(auxiliary)}
    assert repo.data_url(older) not in json.dumps(sent)
    assert "OLD_TASK_PRIVATE_WORDING" not in text(sent)
    assert "CURRENT_TASK" in text(sent)
    assert repo.request("current")["history"] == before
    assert repo.request("old")["round"] == old["round"]


def test_prompt_iteration_carries_exact_versions_and_addition_without_pixels(repo, monkeypatch):
    older = asset(repo, "red")
    root = turn(repo, "old", "Earlier image analysis.", assets=[older])
    original = "  ORIGINAL prompt\nKeep punctuation: <system>user data</system>  "
    selected = "SELECTED prompt\nKeep amber light, use a teal background."
    patch_task(repo, root, [{"op": "new_task", "text": original, "taskType": "prompt"},
        {"op": "set_prompt", "text": "CANDIDATE prompt: monochrome", "kind": "candidate"},
        {"op": "set_prompt", "text": selected, "kind": "selected"},
        {"op": "add_constraint", "text": "Keep the natural snapshot composition."}])
    turn(repo, "current", "LATEST addition: preserve the original line breaks.", parent=root)
    before = copy.deepcopy(repo.request("current"))
    sent = capture_request(repo, monkeypatch, "current")
    assert pixels(sent) == []
    serialized = text(sent)
    assert "ORIGINAL prompt" in serialized and "SELECTED prompt" in serialized
    assert "LATEST addition" in serialized and "Keep the natural snapshot composition." in serialized
    state = before["round"]["taskContext"]
    versions = {row["id"]: row for row in state["promptVersions"]}
    assert versions[state["originalPromptVersionId"]]["text"] == original
    assert versions[state["selectedPromptVersionId"]]["text"] == selected
    assert state["executedPromptVersionId"] is None
    assert repo.request("current")["round"]["prompt"] == before["round"]["prompt"]


def test_explicit_whole_branch_comparison_keeps_every_required_image(repo, monkeypatch):
    parent, expected = None, []
    for number, color in enumerate(("red", "blue", "yellow", "green", "orange", "purple"), 1):
        aid = asset(repo, color)
        expected.append(repo.data_url(aid))
        parent = turn(repo, f"compare-{number}", "Every image in this comparison remains necessary.",
                      parent=parent, assets=[aid], scope="branch")
    sent = capture_request(repo, monkeypatch, "compare-6")
    assert pixels(sent) == expected
    assert len(pixels(sent)) == 6


def test_unresolved_task_safely_retains_necessary_branch_evidence(repo, monkeypatch):
    older = asset(repo, "red")
    root = turn(repo, "old", "NECESSARY earlier composition.", assets=[older])
    patch_task(repo, root, [{"op": "set_unresolved", "items": ["Which earlier composition should be preserved?"]}])
    turn(repo, "current", "Keep the earlier composition; target is unresolved.", parent=root)
    sent = capture_request(repo, monkeypatch, "current")
    assert repo.data_url(older) in pixels(sent)
    assert "NECESSARY earlier composition" in text(sent)


def test_selected_history_scope_excludes_unselected_ancestor_pixels(repo, monkeypatch):
    first, other, current = [asset(repo, color) for color in ("red", "blue", "yellow")]
    root = turn(repo, "first", "Selected historical source.", assets=[first])
    middle = turn(repo, "other", "Unselected source.", parent=root, assets=[other])
    turn(repo, "current", "Compare these explicitly selected sources.", parent=middle,
         assets=[current], scope="selected", history=[root])
    sent = capture_request(repo, monkeypatch, "current")
    assert set(pixels(sent)) == {repo.data_url(first), repo.data_url(current)}
    assert repo.data_url(other) not in json.dumps(sent)


def test_numeric_round_locator_cannot_silently_ignore_missing_branch_source(repo, monkeypatch):
    import pytest
    from backend.services.agent_repository import AgentError
    current = asset(repo, 'blue')
    turn(repo, 'current', '参考第 99 轮的光线，修改这张图片。', assets=[current])
    with pytest.raises(AgentError, match='当前授权分支') as missing:
        capture_request(repo, monkeypatch, 'current')
    assert missing.value.code == 'reference_missing'


def test_genuine_legacy_request_retains_history_without_inventing_task_state(repo, monkeypatch):
    first, current = asset(repo, "red"), asset(repo, "blue")
    root = turn(repo, "first", "Legacy image requirement.", assets=[first])
    turn(repo, "current", "Continue the old visual task.", parent=root, assets=[current])
    request = repo.request("current")
    old_round = {key: value for key, value in request["round"].items() if key != "taskContext"}
    old_history = [{key: value for key, value in row.items() if key != "taskContext"} for row in request["history"]]
    with connect(repo.library) as conn:
        conn.execute("UPDATE agent_rounds SET data=? WHERE id=?", (encoded(old_round), request["round_id"]))
        conn.execute("UPDATE agent_requests SET history=? WHERE id=?", (encoded(old_history), "current"))
    sent = capture_request(repo, monkeypatch, "current")
    assert set(pixels(sent)) == {repo.data_url(first), repo.data_url(current)}
    assert repo.request("current")["round"].get("taskContext") is None


def test_benchmark_reports_decoded_wire_coverage_and_actual_mock_calls():
    from scripts import benchmark_agent_task_context as benchmark
    from pathlib import Path
    report = benchmark.run(Path(__file__).resolve().parents[1], rounds=(3,), repeats=1)
    a, b, c = [scenario["rows"][0] for scenario in report["scenarios"]]
    assert report["provider_latency_and_cache"] == "not measured"
    assert report["state_capability"] == "task_state"
    assert all(row["task_state_bytes"] > 0 for row in (a, b, c))
    assert [row["required_images"] for row in (a, b, c)] == [2, 3, 0]
    assert all(row["required_coverage_complete"] for row in (a, b, c))
    assert all(row["unnecessary_unique_images"] == 0 for row in (a, b, c))
    assert a["wire_image_occurrences"] == 2 and b["wire_image_occurrences"] == 3
    assert c["wire_image_occurrences"] == 0
    for row in (a, b, c):
        for temperature in ("cold", "warm"):
            sample = row["mock_post"][temperature]
            assert sample["mock_model_calls"]["median"] == 1
            assert row["build"][temperature]["mock_model_calls"]["median"] == 0
            assert sample["elapsed_ms"]["min"] <= sample["elapsed_ms"]["median"] <= sample["elapsed_ms"]["max"]
            assert sample["sql_connections"]["median"] > 0


def test_unselected_working_prompt_is_transmitted_beyond_recent_history_without_old_pixels(repo, monkeypatch):
    from test_agent_task_state import state_arguments
    older = asset(repo, 'red')
    first = turn(repo, 'reverse', '反推这张图', assets=[older])
    repo.update('reverse', state='running')
    request = repo.request('reverse')
    candidate = '  WORKING_CANDIDATE_EXACT\n  preserve whitespace  '
    state = repo.update_task_context('reverse', state_arguments(request, [
        {'op': 'set_task_type', 'taskType': 'prompt_optimization'},
        {'op': 'set_prompt', 'text': candidate, 'kind': 'candidate'}]), {})
    repo.update('reverse', state='completed', outcome='known')
    parent = first
    for index in range(4):
        parent = turn(repo, f'continue-{index}', '继续优化这份提示词', parent=parent)
    sent = capture_request(repo, monkeypatch, 'continue-3')
    assert pixels(sent) == []
    serialized = next(part['text'] for item in sent['input'] for part in item.get('content', [])
                      if part.get('text', '').startswith('Current creative task'))
    projected = json.loads(serialized.partition('): ')[2])
    assert projected['workingPromptVersionId'] == state['workingPromptVersionId']
    assert next(p for p in projected['promptVersions'] if p['id'] == projected['workingPromptVersionId'])['text'] == candidate
    assert repo.request('continue-3')['round']['taskContext']['selectedPromptVersionId'] is None


def test_new_reverse_task_one_upload_excludes_ended_pixels_without_controls(repo, monkeypatch):
    old, current = asset(repo, 'red'), asset(repo, 'blue')
    first = turn(repo, 'old-reverse', '\u53cd\u63a8\u8fd9\u5f20\u56fe', assets=[old])
    turn(repo, 'new-reverse', '\u4e0e\u524d\u9762\u7684\u56fe\u65e0\u5173\uff0c\u53cd\u63a8\u8fd9\u5f20\u65b0\u56fe', parent=first, assets=[current])
    request = repo.request('new-reverse')
    assert request['round']['taskContext']['target']['assetId'] == current
    assert request['round']['taskContext']['historyDependencies'] == []
    assert request['round']['taskContext']['taskId'] != request['history'][0]['taskContext']['taskId']
    sent = capture_request(repo, monkeypatch, 'new-reverse')
    assert pixels(sent) == [repo.data_url(current)]
    assert repo.data_url(old) not in json.dumps(sent)


def test_automatic_current_target_explicit_old_round_keeps_both_pixels(repo, monkeypatch):
    old, current = asset(repo, 'red'), asset(repo, 'blue')
    first = turn(repo, 'old', '\u53cd\u63a8\u8fd9\u5f20\u56fe', assets=[old])
    turn(repo, 'current', '\u4fee\u6539\u8fd9\u5f20\u65b0\u56fe\uff0c\u53c2\u8003\u7b2c 1 \u8f6e\u7684\u5149\u7ebf', parent=first, assets=[current])
    request = repo.request('current')
    assert request['round']['taskContext']['target']['assetId'] == current
    sent = capture_request(repo, monkeypatch, 'current')
    assert set(pixels(sent)) == {repo.data_url(old), repo.data_url(current)}
