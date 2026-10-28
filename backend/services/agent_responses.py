"""Responses protocol receipts and output assembly, independent of execution.

The adapter does not schedule work, choose models or retry HTTP requests. Native
JSON/SSE finality and text identity are validated here; the executor owns durable
writes and the existing Gallery adapter owns image assets.
"""
from __future__ import annotations

import json
from contextlib import contextmanager, suppress
import httpx
from backend.services.agent_repository import AgentError, encoded

MAX_RESPONSE_BYTES = 80 * 1024 * 1024


@contextmanager
def response_stream(client, *args, is_complete, **kwargs):
    """A validated terminal receipt outranks subsequent transport teardown."""
    try:
        with client.stream(*args, **kwargs) as response:
            yield response
    except httpx.TransportError:
        if not is_complete():
            raise


def validate_response_payload(payload, *, require_completed=False):
    if not isinstance(payload, dict) or not isinstance(payload.get("output", []), list):
        raise AgentError("upstream_error", "Responses 返回格式无效。")
    status = payload.get("status")
    if payload.get("error") or status not in ({"completed"} if require_completed else {None, "completed"}):
        raise AgentError("upstream_error", "Responses 未成功完成；不会自动重试。", diagnostics={'error': payload.get('error')})
    return payload


def read_native_response(response, check_running):
    """Read one bounded response without retrying or accepting partial images."""
    size = 0
    if "text/event-stream" not in response.headers.get("content-type", ""):
        chunks = []
        for chunk in response.iter_bytes():
            check_running()
            size += len(chunk)
            if size > MAX_RESPONSE_BYTES:
                raise AgentError("upstream_error", "原生图片数据过大。")
            chunks.append(chunk)
        return validate_response_payload(json.loads(b"".join(chunks)), require_completed=True)

    data_lines, output = [], {}

    def consume():
        if not data_lines:
            return None
        data = "\n".join(data_lines)
        data_lines.clear()
        if data == "[DONE]":
            return None
        event = json.loads(data)
        check_running()
        kind = event.get("type")
        if kind in {"error", "response.failed", "response.incomplete"}:
            source = event.get('response') if isinstance(event.get('response'), dict) else event
            raise AgentError("upstream_error", "原生图片响应未成功完成；不会自动重试。", diagnostics={'error': source.get('error')})
        if kind == "response.output_item.done":
            item = event.get("item")
            if isinstance(item, dict) and item.get("id"):
                output[item["id"]] = item
        if kind == "response.completed":
            payload = validate_response_payload(event.get("response"), require_completed=True)
            return payload if "output" in payload else {**payload, "output": list(output.values())}
        return None

    for line in response.iter_lines():
        size += len(line.encode("utf-8"))
        if size > MAX_RESPONSE_BYTES:
            raise AgentError("upstream_error", "原生图片数据过大。")
        if not line:
            payload = consume()
            if payload is not None:
                return payload
        elif line.startswith("data:"):
            data_lines.append(line[5:].lstrip(" "))
    payload = consume()
    if payload is None:
        raise AgentError("upstream_outcome_unknown", "原生图片流已断开，未收到最终结果；不会自动重试。")
    return payload


def redact(value, secrets=()):
    if isinstance(value, str):
        for secret in secrets:
            if secret:
                value = value.replace(secret, "[redacted]")
        return value
    if isinstance(value, list):
        return [redact(item, secrets) for item in value]
    if isinstance(value, dict):
        return {redact(key, secrets): redact(item, secrets) for key, item in value.items()
                if str(key).lower() not in {"api_key", "apikey", "authorization", "headers"}}
    return value


def safe_output(items, secrets=()):
    result = []
    for raw in items if isinstance(items, list) else []:
        if not isinstance(raw, dict) or not isinstance(raw.get("type"), str):
            continue
        item = redact(dict(raw), secrets)
        if item["type"] == "image_generation_call":
            item.pop("result", None)
        if item["type"] == "function_call" and isinstance(item.get("arguments"), str):
            with suppress(ValueError, TypeError):
                # Tool arguments are JSON nested inside a string. Decode first
                # so escaped credential echoes cannot bypass exact redaction.
                item["arguments"] = encoded(redact(json.loads(item["arguments"]), secrets))
        result.append(item)
    return result


def merge_output(previous, updates):
    result = list(previous)
    for value in updates:
        identity = value.get("id") or value.get("call_id")
        index = next((i for i, old in enumerate(result) if identity and old.get("type") == value.get("type") and (old.get("id") or old.get("call_id")) == identity), None)
        if index is None:
            result.append(value)
        else:
            result[index] = value
    return result


def output_text(items):
    parts = []
    for item in items:
        if item.get("type") != "message":
            continue
        for part in item.get("content", []):
            if not isinstance(part, dict):
                continue
            text = part.get("text") or part.get("refusal") or ""
            if not isinstance(text, str):
                continue
            # Keep the upstream citation alongside the corresponding text block.
            links = []
            for annotation in part.get("annotations", []):
                if isinstance(annotation, dict) and annotation.get("type") == "url_citation":
                    url = annotation.get("url", "")
                    if isinstance(url, str) and url.startswith(("https://", "http://")):
                        title = str(annotation.get("title") or url).replace("[", "\\[").replace("]", "\\]")
                        links.append(f"[{title}]({url.replace(')', '%29')})")
            parts.append(text + ("\n\n" + " · ".join(dict.fromkeys(links)) if links else ""))
    return "\n\n".join(parts)


class ResponseOutput:
    """One model step's sanitized stream, including provisional message identity."""

    def __init__(self, request_id, step, previous=(), secrets=()):
        self.request_id, self.step = request_id, step
        self.base_output = list(previous)
        self.secrets = secrets
        self.current_output = []
        self.stream_item_ids = {}
        self.provisional_message_ids = set()
        self.seen_delta_events, self.completed_message_ids = set(), set()

    def publish(self, items):
        clean = safe_output(items, self.secrets)
        for i, item in enumerate(clean):
            if not item.get("id") and not item.get("call_id") and i < len(self.current_output) and self.current_output[i].get("type") == item.get("type"):
                if self.current_output[i].get("id"):
                    item["id"] = self.current_output[i]["id"]
                self.current_output[i] = item
            else:
                if not item.get("id") and not item.get("call_id"):
                    item["id"] = f"agent-output-{self.request_id}-{self.step}-{i}"
                self.current_output = merge_output(self.current_output, [item])
        combined = merge_output(self.base_output, self.current_output)
        return combined

    def delta(self, event, event_id=None):
        delta = str(event.get("delta", ""))
        slot = event.get("output_index", 0)
        index = event.get("content_index", 0)
        if not isinstance(slot, int) or isinstance(slot, bool) or not 0 <= slot < 4096:
            raise AgentError("upstream_error", "Responses 输出索引无效。")
        if not isinstance(index, int) or isinstance(index, bool) or not 0 <= index < 256:
            raise AgentError("upstream_error", "Responses 文本片段索引无效。")
        sequence = event.get("sequence_number")
        label = event_id or event.get("event_id")
        event_key = ("sequence", sequence, slot, index) if isinstance(sequence, int) and not isinstance(sequence, bool) and sequence >= 0 else (
            ("event", label, slot, index) if isinstance(label, str) and label else None)
        # Content is not an identity: two legitimate events may
        # contain the same words. Slots survive late message IDs.
        duplicate = event_key is not None and event_key in self.seen_delta_events
        if event_key is not None:
            self.seen_delta_events.add(event_key)
        previous_id = self.stream_item_ids.get(slot)
        identity = redact(event.get("item_id"), self.secrets) or self.stream_item_ids.get(slot)
        if identity and previous_id in self.provisional_message_ids and identity != previous_id:
            self.current_output[:] = [{**o, "id": identity} if o.get("id") == previous_id else o for o in self.current_output]
            self.provisional_message_ids.discard(previous_id)
            self.stream_item_ids[slot] = identity
        if duplicate:
            # A retransmission can still establish a late ID.
            return self.publish([])
        if identity in self.completed_message_ids:
            return
        message = next((o for o in reversed(self.current_output) if o.get("type") == "message" and o.get("id") == identity), None)
        message = dict(message) if message else {"id": identity or f"agent-output-{self.request_id}-{self.step}-text-{slot}", "type": "message", "role": "assistant"}
        if not identity:
            self.provisional_message_ids.add(message["id"])
        self.stream_item_ids[slot] = message["id"]
        content = [dict(p) for p in message.get("content", [])]
        while len(content) <= index:
            content.append({"type": "output_text", "text": ""})
        content[index] = {**content[index], "type": "output_text", "text": content[index].get("text", "") + delta}
        message["content"] = content
        return self.publish([message])

    def item(self, event):
        item, kind = event['item'], event['type']
        item = safe_output([item], self.secrets)[0]
        slot = event.get("output_index", 0)
        provisional = self.stream_item_ids.get(slot)
        if item.get("type") == "message" and kind == "response.output_item.added":
            prior_ids = {item.get("id")}
            if provisional in self.provisional_message_ids:
                prior_ids.add(provisional)
            prior = next((o for o in self.current_output if o.get("id") in prior_ids and o.get("type") == "message"), {})
            if prior.get("content"):
                item = {**item, "content": prior["content"]}
        if item.get("type") == "message" and item.get("id") and provisional in self.provisional_message_ids and provisional != item["id"]:
            # Some gateways omit IDs from deltas but supply
            # them on done. Replace the provisional node in
            # place, including when completion omits output.
            if kind == "response.output_item.added" and not item.get("content"):
                prior = next((o for o in self.current_output if o.get("id") == provisional), {})
                item = {**item, "content": prior.get("content", [])}
            self.current_output[:] = [item if o.get("id") == provisional and o.get("type") == "message" else o for o in self.current_output]
            self.provisional_message_ids.discard(provisional)
        if item.get("id"):
            self.stream_item_ids[slot] = item["id"]
            if kind == "response.output_item.done" and item.get("type") == "message":
                self.completed_message_ids.add(item["id"])
        return self.publish([item])

    def complete(self, output):
        clean = safe_output(output, self.secrets)
        for i, item in enumerate(clean):
            if not item.get("id") and not item.get("call_id"):
                candidate = self.current_output[i] if i < len(self.current_output) and self.current_output[i].get("type") == item.get("type") else None
                item["id"] = candidate.get("id") if candidate and candidate.get("id") else f"agent-output-{self.request_id}-{self.step}-{i}"
        self.current_output = clean
        combined = merge_output(self.base_output, self.current_output)
        return combined
