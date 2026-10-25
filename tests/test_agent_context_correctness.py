"""Actual outgoing image bytes, using synthetic assets and a mock Responses API."""
import json

import httpx
import pytest

from backend.agent_schemas import AgentRoundCreate
from backend.services import agent_execution as execution
from backend.services.agent_repository import AgentError
from test_agent_image_selection import repo, body
from test_agent_workspaces import image_bytes


def asset(repo, color):
    return repo.store_asset(image_bytes(color), {"kind": "upload", "uploadId": color})["id"]


def add_round(repo, name, prompt, *, parent=None, assets=()):
    value = body(repo, request_id=name, images=False).model_dump()
    value.update(prompt=prompt, parentRoundId=parent,
                 refs=[{"kind": "upload", "uploadId": aid} for aid in assets])
    repo.create_round("conversation", AgentRoundCreate.model_validate(value))
    request = repo.request(name)
    repo.update(name, state="completed", outcome="known")
    return request["round_id"]


def capture_request(repo, monkeypatch, request_id):
    calls = []

    def respond(request):
        assert request.method == "POST" and request.url.path == "/v1/responses"
        calls.append(json.loads(request.content))
        return httpx.Response(200, json={"id": "synthetic-response", "status": "completed", "output": [
            {"id": "synthetic-message", "type": "message", "role": "assistant",
             "content": [{"type": "output_text", "text": "Synthetic observation."}]}]})

    monkeypatch.setattr(httpx, "HTTPTransport", lambda **kw: httpx.MockTransport(respond))
    repo.update(request_id, state="running", outcome="known")
    request = repo.request(request_id)
    execution.call_responses(repo, request_id, 1, execution.refs_for_request(repo, request))
    assert len(calls) == 1
    return calls[0]


def pixels(payload):
    return [part["image_url"] for item in payload["input"]
            for part in item.get("content", []) if part["type"] == "input_image"]


@pytest.mark.parametrize("prompt", [
    "Match the lighting of the portrait we discussed on this photo.",
    "新照片沿用讨论过的人像灯光。",
    "参考前面那张图，保持之前的光线。",
    "两张图做风格对比。",
    "Combine @图1 with <ref id=\"round-1-reference-1\" />.",
    "Edit @图1 to match the lighting of the portrait we discussed.",
    "把 @图1 的灯光改成讨论过的人像效果。",
])
def test_outgoing_request_keeps_historical_pixels_when_scope_is_uncertain(repo, monkeypatch, prompt):
    older, current = asset(repo, "blue"), asset(repo, "orange")
    root = add_round(repo, "older", "The portrait establishes the lighting.", assets=[older])
    add_round(repo, "current", prompt, parent=root, assets=[current])
    before = repo.request("current")["history"]
    payload = capture_request(repo, monkeypatch, "current")
    assert pixels(payload) == [repo.data_url(older), repo.data_url(current)]
    assert "available_ref" not in json.dumps(payload["input"])
    assert repo.request("current")["history"] == before


def test_exact_reference_only_sends_the_bound_asset_not_other_history(repo, monkeypatch):
    older, other = asset(repo, "blue"), asset(repo, "green")
    root = add_round(repo, "older", "Two distinct reference images.", assets=[older, other])
    add_round(repo, "current", '<ref id="round-1-reference-1" />', parent=root)
    payload = capture_request(repo, monkeypatch, "current")
    assert pixels(payload) == [repo.data_url(older)]
    assert repo.data_url(other) not in json.dumps(payload)


@pytest.mark.parametrize("prompt", ["@第1轮图1", "把 @图1 与 @第1轮图1 组合，沿用历史结果的灯光。"])
def test_generated_historical_reference_uses_frozen_result_bytes(repo, monkeypatch, prompt):
    repo.create_round("conversation", body(repo, request_id="generated", images=True))
    root = repo.request("generated")["round_id"]
    job = execution.create_image_job(repo, "generated", 1, "generated-image", "single", "Synthetic blue image", {})
    repo.jobs.stage_result(job.id, image_bytes("blue"), "synthetic.png")
    repo.update("generated", state="completed", outcome="known")
    current = asset(repo, "orange")
    add_round(repo, "current", prompt, parent=root, assets=[] if prompt.startswith("@") else [current])
    request = repo.request("current")
    frozen_image = request["history"][0]["frozenOutputImages"][0]
    # Frozen bytes remain usable even if the original Gallery result is cleared.
    repo.jobs.discard_job(job.id)
    payload = capture_request(repo, monkeypatch, "current")
    expected = [repo.data_url(frozen_image)]
    if not prompt.startswith("@"):
        expected.append(repo.data_url(current))
    assert pixels(payload) == expected
    assert len(repo.snapshot("conversation")["jobs"]) == 1


@pytest.mark.parametrize("prompt", ['<ref id="round-99-reference-1" />', '<ref id="round-99-image-1" />',
                                     '<ref id="broken" />'])
def test_missing_explicit_reference_fails_before_post(repo, monkeypatch, prompt):
    older = asset(repo, "blue")
    root = add_round(repo, "older", "A reference image.", assets=[older])
    add_round(repo, "current", prompt, parent=root)
    posts = []
    def respond(req):
        posts.append(req)
        return httpx.Response(200, json={"id": "unexpected", "status": "completed", "output": []})
    monkeypatch.setattr(httpx, "HTTPTransport", lambda **kw: httpx.MockTransport(respond))
    repo.update("current", state="running", outcome="known")
    request = repo.request("current")
    with pytest.raises(AgentError) as error:
        execution.call_responses(repo, "current", 1, execution.refs_for_request(repo, request))
    assert error.value.code == "reference_missing"
    assert posts == []


def test_missing_historical_mention_is_rejected_when_creating_round(repo):
    root = add_round(repo, "older", "A reference image.", assets=[asset(repo, "blue")])
    with pytest.raises(AgentError) as error:
        add_round(repo, "current", "@第99轮图1", parent=root)
    assert error.value.code == "reference_missing"


def test_deleted_explicit_result_is_not_replaced_by_another_image(repo):
    current = asset(repo, "orange")
    request = {"history": [], "round": {"index": 2, "prompt": "修改 @第1轮图1", "inputImageIds": [current], "outputTaskIds": []}}
    with pytest.raises(AgentError) as error:
        execution.build_input(repo, request, {"round-1-image-1": None, "round-2-reference-1": current})
    assert error.value.code == "reference_missing"


def test_branch_request_includes_ancestors_but_never_sibling_pixels(repo, monkeypatch):
    root_image, sibling, current = asset(repo, "blue"), asset(repo, "green"), asset(repo, "orange")
    root = add_round(repo, "root", "Reference lighting.", assets=[root_image])
    add_round(repo, "sibling", "Unrelated branch image.", parent=root, assets=[sibling])
    add_round(repo, "current", "新照片沿用讨论过的人像灯光。", parent=root, assets=[current])
    payload = capture_request(repo, monkeypatch, "current")
    assert pixels(payload) == [repo.data_url(root_image), repo.data_url(current)]
    assert repo.data_url(sibling) not in json.dumps(payload)


def test_missing_current_asset_bytes_fail_without_substitution(repo, monkeypatch):
    missing, valid = asset(repo, "blue"), asset(repo, "orange")
    add_round(repo, "current", "分析 @图1", assets=[missing, valid])
    (repo.library / repo.asset(missing)["path"]).unlink()
    posts = []
    def respond(req):
        posts.append(req)
        return httpx.Response(200, json={"id": "unexpected", "status": "completed", "output": []})
    monkeypatch.setattr(httpx, "HTTPTransport", lambda **kw: httpx.MockTransport(respond))
    repo.update("current", state="running", outcome="known")
    request = repo.request("current")
    with pytest.raises(AgentError) as error:
        execution.call_responses(repo, "current", 1, execution.refs_for_request(repo, request))
    assert error.value.code == "reference_missing"
    assert posts == []
