"""Exercise production request construction and stream persistence without providers."""
import copy
import json

import httpx
import pytest

from backend.agent_schemas import AgentRoundCreate
from backend.services.agent_execution import build_input, call_responses
from backend.services.agent_skills import selected_skill_sections
from test_agent_response_details import SECRET, repo, mock_transport, response


def new_request(repo, prompt):
    repo.update("request", state="completed", outcome="known")
    repo.create_round("conversation", AgentRoundCreate.model_validate({
        "requestId": "task", "expectedRevision": repo.snapshot("conversation")["revision"],
        "prompt": prompt, "configRevision": repo.config()["revision"],
        "authorization": {"scope": "this_request", "allowImageGeneration": False, "maxToolRounds": 5, "maxImageJobs": 0},
    }))


@pytest.mark.parametrize("prompt", ["帮我生成一段城市夜景的图片提示词", "优化提示词：一只橙色猫咪"])
def test_skill_body_is_in_first_post_even_without_tool_read(repo, monkeypatch, prompt):
    new_request(repo, prompt)
    calls = []
    mock_transport(monkeypatch, response(), calls)
    call_responses(repo, "task", 1, {})
    sections = selected_skill_sections(prompt)
    assert sections and len(calls) == 1
    assert all(s["content"] in calls[0]["instructions"] for s in sections)
    assert [t["name"] for t in calls[0]["tools"]] == ["read_agent_skill"]
    stored = repo.request("task")["round"]["responseDetails"]["skills"]
    assert {(s["skill"], s["section"]) for s in stored} == {(s["skill"], s["section"]) for s in sections}
    assert all("content" not in s for s in stored)
    call_responses(repo, "task", 2, {})
    assert len(repo.request("task")["round"]["responseDetails"]["skills"]) == len(sections)
    assert not repo.request("task")["body"]["authorization"]["allowImageGeneration"]


def test_greeting_does_not_preload_skill_content(repo, monkeypatch):
    new_request(repo, "你好")
    calls = []
    mock_transport(monkeypatch, response(), calls)
    call_responses(repo, "task", 1, {})
    assert "sections are already loaded" not in calls[0]["instructions"]
    assert not repo.request("task")["round"]["responseDetails"].get("skills")


def test_ui_mention_label_is_not_a_skill_instruction(repo, monkeypatch):
    from backend.services import agent_execution
    new_request(repo, '你好\u2065图片反推收藏\u2064\u2063')
    prompts = []
    monkeypatch.setattr(agent_execution, "selected_skill_sections", lambda prompt, *args: prompts.append(prompt) or [])
    mock_transport(monkeypatch, response(), [])
    call_responses(repo, "task", 1, {})
    assert prompts == ['你好']


def test_second_step_text_is_structured_before_completion_and_not_duplicated(repo, monkeypatch):
    base = [{"id": "first", "type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "Planning."}]},
            {"id": "call", "type": "function_call", "call_id": "tool", "name": "read_agent_skill", "arguments": "{}"},
            {"type": "function_call_output", "call_id": "tool", "output": "{}"}]
    repo.update("request", output=base, text="Planning.")
    observed = []
    class Stream(httpx.SyncByteStream):
        def __iter__(self):
            events = [
                {"type": "response.output_item.added", "item": {"id": "second", "type": "message", "role": "assistant", "content": []}},
                {"type": "response.output_text.delta", "item_id": "second", "content_index": 0, "delta": "Partial"},
                {"type": "response.output_text.delta", "item_id": "second", "content_index": 0, "delta": " answer"},
                {"type": "response.completed", "response": {"id": "result", "output": [{"id": "second", "type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "Partial answer"}]}]}},
            ]
            for event in events:
                yield ("data: " + json.dumps(event) + "\n\n").encode()
                observed.append(copy.deepcopy(repo.request("request")["round"]))
    monkeypatch.setattr(httpx, "HTTPTransport", lambda **kw: httpx.MockTransport(lambda request: httpx.Response(200, stream=Stream(), headers={"content-type": "text/event-stream"})))
    output, _ = call_responses(repo, "request", 2, {})
    assert observed[1]["responseOutput"][-1]["content"][0]["text"] == "Partial"
    assert observed[2]["responseOutput"][-1]["content"][0]["text"] == "Partial answer"
    final = repo.request("request")["round"]
    assert final["assistantContent"] == "Planning.\n\nPartial answer"
    assert final["responseOutput"][:3] == base
    assert len(final["responseOutput"]) == 4 and len(output) == 1


def test_gateway_late_message_id_does_not_duplicate_partial_text(repo, monkeypatch):
    calls = []
    mock_transport(monkeypatch, [
        {"type": "response.output_text.delta", "delta": "Hello"},
        {"type": "response.output_item.done", "item": {"id": "real-id", "type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "Hello"}]}},
        {"type": "response.completed", "response": {"id": "done"}},
    ], calls, stream=True)
    output, _ = call_responses(repo, "request", 1, {})
    assert len(output) == 1 and output[0]["id"] == "real-id"
    assert repo.request("request")["round"]["assistantContent"] == "Hello"


def test_gateway_without_output_index_keeps_distinct_completed_messages(repo, monkeypatch):
    events = [{"type": "response.output_item.done", "item": {"id": identity, "type": "message", "role": "assistant", "content": [{"type": "output_text", "text": identity}]}}
              for identity in ("first", "second")]
    events.append({"type": "response.completed", "response": {"id": "done"}})
    mock_transport(monkeypatch, events, [], stream=True)
    output, _ = call_responses(repo, "request", 1, {})
    assert [o["id"] for o in output] == ["first", "second"]
    assert repo.request("request")["round"]["assistantContent"] == "first\n\nsecond"


@pytest.mark.parametrize("bind_event", ["done", "delta"])
def test_late_real_message_identity_cannot_bypass_secret_redaction(repo, monkeypatch, bind_event):
    message = {"id": "echo-" + SECRET, "type": "message", "role": "assistant", "content": [{"type": "output_text", "text": SECRET}]}
    events = [{"type": "response.output_text.delta", "delta": "safe prefix"}]
    if bind_event == "delta":
        events.append({"type": "response.output_text.delta", "item_id": message["id"], "delta": " " + SECRET})
    events.extend([{"type": "response.output_item.done", "item": message}, {"type": "response.completed", "response": {"id": "complete"}}])
    updates = []
    original = repo.update
    def observe(*args, **kwargs):
        updates.append(copy.deepcopy(kwargs))
        return original(*args, **kwargs)
    monkeypatch.setattr(repo, "update", observe)
    mock_transport(monkeypatch, events, [], stream=True)
    output, _ = call_responses(repo, "request", 1, {})
    assert SECRET not in json.dumps(updates)
    assert SECRET not in json.dumps(output)
    assert len(output) == 1 and output[0]["id"] == "echo-[redacted]"
    assert repo.request("request")["round"]["assistantContent"] == "[redacted]"


@pytest.mark.parametrize(("prompt", "expected"), [("根据参考图修改背景", ["old", "generated", "current"]), ("你好", []), ("比较之前的图片", ["old", "generated", "current"])])
def test_actual_input_preserves_uncertain_images_text_and_tool_pairs(prompt, expected):
    class Images:
        def data_url(self, aid):
            return "data:image/png;base64," + aid
    old = {"index": 1, "prompt": "Original exact prompt\n  whitespace", "inputImageIds": ["old"], "outputTaskIds": ["job"],
           "responseOutput": [{"type": "function_call", "call_id": "c", "name": "generate_image", "arguments": "{}"},
                              {"type": "function_call_output", "call_id": "c", "output": "{}"},
                              {"type": "reasoning", "encrypted_content": "continuation"}]}
    current = {"index": 2, "prompt": prompt, "inputImageIds": [] if prompt == "你好" else ["current"], "outputTaskIds": []}
    request = {"history": [old], "round": current}
    before = copy.deepcopy(request)
    body = build_input(Images(), request, {"round-1-reference-1": "old", "round-1-image-1": "generated", "round-2-reference-1": "current"})
    images = [p["image_url"].split(",")[-1] for m in body for p in m.get("content", []) if p["type"] == "input_image"]
    assert images == expected
    assert body[0]["content"][0]["text"] == old["prompt"]
    assert [o for o in body if o.get("type")] == old["responseOutput"]
    assert "removed_ref" not in json.dumps(body)
    assert request == before
