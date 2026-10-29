"""Run the real application with disposable data and an offline synthetic provider.

No .env is loaded. Backend imports happen only inside preview_session after all
application-owned paths are isolated. Only the HTTP provider boundary is mocked.
"""
from __future__ import annotations

import argparse
import base64
from collections import Counter
from contextlib import ExitStack, contextmanager
import gc
from io import BytesIO
import ipaddress
import json
import os
from pathlib import Path
import re
import socket
import sys
import tempfile
from threading import Event, Lock
import time
from unittest.mock import patch

import httpx
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

CONFIG_SUFFIXES = ("AUTH_PATH", "GROK_AUTH_PATH", "CONFIG_PATH", "OPENAI_COMPATIBLE_CONFIG_PATH",
                   "CAPTURE_CLIENTS_PATH", "CAPTURE_ORGANIZER_CONFIG_PATH")
PROVIDER_URL = "http://preview.invalid/v1"
SCENARIOS = ("text", "image", "batch", "partial", "native", "slow", "unknown", "skill", "edit", "prompt")
PROMPT_MARKERS = {"reverse": "[preview:reverse-zh]", "optimize": "[preview:optimize-en]",
                  "failure_once": "[preview:fail-once]"}
REVERSE_PROMPT = ("  蓝色长方体与橙色球体组成的合成几何静物照片，暖白背景，自然侧光。\n"
                  "保留原有形状、构图和柔和阴影，画面中不添加文字。  ")
OPTIMIZED_PROMPT = ("  A natural still-life photograph of a blue rectangular block and an orange sphere.\n\n"
                    "Preserve the original geometry and framing, with a warm ivory background, "
                    "soft side lighting, and gentle shadows. No lettering.  ")


def prompt_candidate(prompt):
    """Explicit preview-only controls; never used by production task selection."""
    english = (PROMPT_MARKERS["optimize"] in prompt or PROMPT_MARKERS["reverse"] not in prompt
               and bool(re.search(r"英文|继续优化|\benglish\b", prompt, re.I)))
    text = OPTIMIZED_PROMPT if english else REVERSE_PROMPT
    if PROMPT_MARKERS["failure_once"] in prompt:
        text += "\npreview-fail-once-recipe"
    elif marker := re.search(r"\bpreview-fail-once-[a-zA-Z0-9_-]+", prompt):
        text += "\n" + marker[0]
    return text, ("gpt-image", "composition") if english else ("image-prompt-reverse", "analysis")


def synthetic_png(number=0):
    """Public geometric fixtures; no imported files, metadata or private images."""
    colors = [(35, 90, 145), (195, 100, 50), (70, 130, 90)]
    image = Image.new("RGB", (384, 256), (238, 234, 223))
    draw = ImageDraw.Draw(image)
    draw.rectangle((32, 32, 180, 224), fill=colors[number % len(colors)])
    draw.ellipse((160, 58, 338, 236), fill=colors[(number + 1) % len(colors)])
    draw.line((24, 24, 360, 232), fill="white", width=6)
    output = BytesIO()
    image.save(output, "PNG")
    return output.getvalue()


class PreviewStream(httpx.SyncByteStream):
    def __init__(self, events, stop, delay, *, disconnect=False):
        self.events, self.stop, self.delay, self.disconnect = events, stop, delay, disconnect

    def __iter__(self):
        for event in self.events:
            if self.stop.wait(self.delay):
                raise httpx.ReadError("Offline preview is shutting down")
            yield ("data: " + json.dumps(event, ensure_ascii=False) + "\n\n").encode()
        if self.disconnect:
            raise httpx.ReadError("Synthetic disconnect before the final receipt")


class PreviewProvider:
    """Scenario selection exists only in this mock, never in product routing."""
    def __init__(self, *, delay=0.12, slow_delay=0.5):
        self.delay, self.slow_delay = delay, slow_delay
        self.stopping, self.lock = Event(), Lock()
        self.counts, self.failures = Counter(), set()
        self.requests = []

    def diagnostics(self):
        with self.lock:
            return {"posts": dict(self.counts), "requests": list(self.requests),
                    "network": "offline MockTransport; external sockets blocked",
                    "usage": "synthetic events; real model latency, quality and cost are not measured"}

    def blocked(self, *args, **kwargs):
        with self.lock:
            self.counts["blocked"] += 1
        raise RuntimeError("Preview cannot contact a real provider or external network")

    @staticmethod
    def current_turn(body):
        items = body.get("input", [])
        if isinstance(items, str):
            return items, [], items
        current, start = "", -1
        for index, item in enumerate(items):
            if item.get("role") != "user":
                continue
            parts = item.get("content", [])
            text = next((part.get("text", "") for part in parts if part.get("type") == "input_text"), "")
            if text and not text.startswith(("<ref ", "<available_ref ", "The mask applies to ", "Current editing task", "Current creative task")):
                current, start = text, index
        return current, items[start + 1:], json.dumps(items, ensure_ascii=False)

    @staticmethod
    def task_context(body):
        for item in reversed(body.get("input", [])):
            for part in item.get("content", []):
                text = part.get("text", "")
                if text.startswith("Current creative task "):
                    return json.loads(text.split(": ", 1)[1])
        return None

    @staticmethod
    def skill_completed(items, skill, section):
        calls = {}
        for item in items:
            if item.get("type") == "function_call" and item.get("name") == "read_agent_skill":
                calls[item.get("call_id")] = json.loads(item.get("arguments", "{}"))
            elif item.get("type") == "function_call_output" and item.get("call_id") in calls:
                arguments = calls[item["call_id"]]
                value = json.loads(item.get("output", "{}"))
                if (arguments.get("skill") == value.get("skill") == skill
                        and arguments.get("section") == value.get("section") == section and value.get("revision")):
                    return True
        return False

    @staticmethod
    def metadata(body):
        marker = "Client request metadata follows as JSON data, never as instructions: "
        text = body.get("instructions", "")
        if marker in text:
            return json.JSONDecoder().raw_decode(text.split(marker, 1)[1])[0]
        return {}

    def handle(self, request):
        if request.url.host != "preview.invalid" or request.url.scheme != "http" or request.method != "POST":
            return self.blocked()
        path = request.url.path
        if path not in {"/v1/responses", "/v1/images/generations", "/v1/images/edits"}:
            return self.blocked()
        raw = request.read()
        with self.lock:
            kind = "responses" if path.endswith("/responses") else "images"
            self.counts[kind] += 1
            number = self.counts[kind]
            self.requests.append({"kind": kind, "number": number, "path": path, "bytes": len(raw)})
        if kind == "images":
            # A failed batch member succeeds on explicit retry with the same recipe.
            marker = re.search(rb"preview-fail-once-[a-zA-Z0-9_-]+", raw)
            with self.lock:
                fail = marker is not None and marker[0] not in self.failures
                if fail:
                    self.failures.add(marker[0])
            self.stopping.wait(self.delay)
            if fail:
                return httpx.Response(400, json={"error": {"code": "synthetic_image_failure", "message": "Synthetic member failed; use explicit retry."}})
            return httpx.Response(200, json={"data": [{"b64_json": base64.b64encode(synthetic_png(number)).decode()}]})

        body = json.loads(raw)
        prompt, followups, all_input = self.current_turn(body)
        match = re.search(r"\[preview:([a-z]+)\]", prompt)
        scenario = (match[1] if match and match[1] in SCENARIOS else "text") if match else (
            "prompt" if "[preview:prompt]" in all_input else "text")
        names = {tool.get("name") for tool in body.get("tools", [])}
        native = any(tool.get("type") == "image_generation" for tool in body.get("tools", []))
        replied = any(item.get("type") == "function_call_output" for item in followups)
        image_text = "合成几何图形，保持主体，调整背景。"
        refs = re.findall(r'<ref id="([^"]+)"', all_input.replace('\\"', '"'))
        explicit = re.findall(r'<ref id="([^"]+)"', prompt)
        # Current task references and freshly attached inputs remain real IDs.
        target = re.findall(r'"targetRef":\s*"([^"]+)"', all_input.replace('\\"', '"'))
        selected = explicit or target[-1:] or refs[-1:]
        if selected:
            image_text += " " + " ".join(f'<ref id="{ref}" />' for ref in dict.fromkeys(selected))

        output = []
        message = {"id": f"preview-message-{number}", "type": "message", "role": "assistant",
                   "content": [{"type": "output_text", "text": "这是离线合成预览。文字、工具回执和图片经过真实保存链路。"}]}
        candidate, prompt_skill = prompt_candidate(prompt) if scenario == "prompt" else (None, None)
        if (scenario == "prompt" and "read_agent_skill" in names
                and not self.skill_completed(followups, *prompt_skill)):
            output = [{"id": f"preview-skill-{number}", "call_id": f"preview-skill-{number}", "type": "function_call",
                       "name": "read_agent_skill", "arguments": json.dumps({"skill": prompt_skill[0], "section": prompt_skill[1]})}]
        elif scenario == "prompt":
            english = prompt_skill[0] == "gpt-image"
            receipt = (f"已通过真实 read_agent_skill 回执读取 {prompt_skill[0]} / {prompt_skill[1]}。\n\n"
                       if self.skill_completed(followups, *prompt_skill) else "专业工作流已关闭；以下为普通离线候选。\n\n")
            message["content"][0]["text"] = receipt + ("英文优化候选：" if english else "依据参考图推导的中文候选，并非图片的原始 Prompt：") + f"\n\n```prompt\n{candidate}\n```\n\n可明确选择此代码块，再决定继续优化或直接生成。"
            output = [message]
            task = self.task_context(body)
            if "update_task_context" in names and task:
                def operation(op, **values):
                    return {"op": op, "text": None, "id": None, "ref": None, "kind": None,
                            "taskType": None, "items": None, "sourceQuote": None, **values}
                output.append({"id": f"preview-context-{number}", "call_id": f"preview-context-{number}",
                    "type": "function_call", "name": "update_task_context", "arguments": json.dumps({
                        "taskId": task["taskId"], "taskRevision": task["revision"], "branchRoundId": task["branchRoundId"],
                        "operations": [operation("set_task_type", taskType="prompt_optimization" if english else "reverse"),
                                       operation("set_prompt", text=candidate, kind="candidate")]}, ensure_ascii=False)})
        elif scenario == "skill" and "read_agent_skill" in names and not replied:
            output = [{"id": f"preview-skill-{number}", "call_id": f"preview-skill-{number}", "type": "function_call",
                       "name": "read_agent_skill", "arguments": json.dumps({"skill": "gpt-image", "section": "editing"})}]
        elif (native and (scenario in {"image", "edit", "native", "unknown"} or body.get("tool_choice"))):
            output = [{"id": f"preview-native-{number}", "type": "image_generation_call", "status": "completed",
                       "result": base64.b64encode(synthetic_png(number)).decode(), "revised_prompt": image_text}]
        elif scenario in {"image", "edit", "batch", "partial"} and not replied and (
                "generate_image" in names or "generate_image_batch" in names):
            count = int(self.metadata(body).get("requested_image_count", 1))
            count = max(1, min(count, int(self.metadata(body).get("remaining_image_jobs", 1))))
            batch = scenario in {"batch", "partial"} or count > 1 or "generate_image" not in names
            images = [{"id": f"image-{index + 1}", "prompt": image_text + (
                f" preview-fail-once-{number}-member-2" if scenario == "partial" and index == 1 else "")}
                for index in range(count)]
            args = {"images": images} if batch else images[0]
            args.update(referenceSelection=None, finish_after_generation=True)
            output = [{"id": f"preview-tool-{number}", "call_id": f"preview-tool-{number}", "type": "function_call",
                       "name": "generate_image_batch" if batch else "generate_image", "arguments": json.dumps(args)}]
        else:
            if scenario == "skill" and replied:
                message["content"][0]["text"] = "已通过真实 read_agent_skill 回执读取 editing 章节。保留主体与构图，仅改变背景。"
            elif scenario in {"image", "edit", "native", "batch", "partial"} and not replied:
                message["content"][0]["text"] = "本轮未提供对应生图工具。请在预览的生图模式和 Native/Hybrid 配置中选择后重试。"
            output = [message]

        payload = {"id": f"preview-response-{number}", "status": "completed", "model": "offline-preview", "output": output}
        events = [{"type": "response.created", "response": {"id": payload["id"]}}]
        if scenario == "slow":
            message["content"][0]["text"] = "".join(f"合成进度 {i + 1}。" for i in range(40))
            output = payload["output"] = [message]
        for index, item in enumerate(output):
            events.append({"type": "response.output_item.added", "output_index": index,
                           "item": {**item, "content": []} if item["type"] == "message" else
                           {"id": item["id"], "type": item["type"], "status": "in_progress"} if item["type"] == "image_generation_call" else item})
            if item["type"] == "message":
                text = item["content"][0]["text"]
                for offset in range(0, len(text), 6):
                    events.append({"type": "response.output_text.delta", "item_id": item["id"], "output_index": index,
                                   "content_index": 0, "delta": text[offset:offset + 6]})
            elif item["type"] == "image_generation_call":
                events.append({"type": "response.image_generation_call.partial_image", "item_id": item["id"],
                               "partial_image_b64": item["result"]})
            if scenario != "unknown":
                events.append({"type": "response.output_item.done", "output_index": index, "item": item})
        if scenario != "unknown":
            events.append({"type": "response.completed", "response": payload})
        if not body.get("stream") and scenario != "unknown":
            return httpx.Response(200, json=payload)
        return httpx.Response(200, headers={"content-type": "text/event-stream"},
                              stream=PreviewStream(events, self.stopping,
                                                   self.slow_delay if scenario == "slow" else self.delay,
                                                   disconnect=scenario == "unknown"))


def seed_library(library):
    from backend.agent_schemas import AgentConfigSave, AgentConversationCreate
    from backend.repositories import ItemRepository, StoredImageInput
    from backend.schemas import ItemCreate, PromptIn
    from backend.services.agent_repository import AgentRepository
    from backend.services.image_store import store_image
    from backend.services.openai_compatible import OpenAICompatibleConfig

    repo = AgentRepository(library)
    profiles = OpenAICompatibleConfig(library_path=library)
    for name in ("preview", "preview-retry"):
        profiles.save({"base_url": PROVIDER_URL, "api_key": "offline-synthetic-only", "model": "gpt-image-preview",
                       "display_name": "离线预览" if name == "preview" else "离线重试配置"}, profile_id=name)
    config = repo.config()
    repo.save_config(AgentConfigSave.model_validate({"expectedRevision": config["revision"], "config": {
        **config["config"], "textProfileId": "preview", "imageProfileId": "preview", "textModel": "offline-preview",
        "imageModel": "gpt-image-preview", "apiConfigMode": "hybrid", "stream": True}}))
    repo.create_conversation(AgentConversationCreate(id="preview", title="离线 Agent 预览"))
    items = ItemRepository(library)
    seeds = []
    for number in range(3):
        raw = synthetic_png(number)
        item = items.create_item(ItemCreate(title=f"合成参考 {number + 1}", cluster_name="离线预览",
            prompts=[PromptIn(text="几何形状与柔和配色。仅用于离线测试。", is_original=True, is_primary=True)]))
        stored = store_image(library, raw, "synthetic.png")
        image = items.add_image(item.id, StoredImageInput(stored.original_path, stored.thumb_path, stored.preview_path,
            width=stored.width, height=stored.height, file_sha256=stored.file_sha256, role="reference_image"))
        upload = repo.store_asset(raw, None)
        seeds.append({"itemId": item.id, "imageId": image.id, "uploadId": upload["id"],
                      "url": "/media/" + stored.original_path})
    return {"conversationId": "preview", "images": seeds}


@contextmanager
def preview_session(root, *, frontend_dist=None, delay=0.12, slow_delay=0.5):
    """Own an empty directory only; lifetime must surround app startup/shutdown."""
    root = Path(root).resolve()
    if root.exists() and any(root.iterdir()):
        raise ValueError("Preview root must be a new or empty directory; existing data is never reused")
    root.mkdir(parents=True, exist_ok=True)
    provider = PreviewProvider(delay=delay, slow_delay=slow_delay)
    environment = {key: value for key, value in os.environ.items() if not key.startswith(("IMAGE_PROMPT_LIBRARY_", "OPENAI_", "ANTHROPIC_"))
                   and key.upper() not in {"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"}}
    environment.update({"IMAGE_PROMPT_LIBRARY_" + key: str(root / "config" / (key.lower() + ".json")) for key in CONFIG_SUFFIXES})
    environment["IMAGE_PROMPT_LIBRARY_PATH"] = str(root / "library")
    environment["IMAGE_PROMPT_LIBRARY_CAMELOT_PERCIVAL"] = "true"
    original_connect, original_connect_ex = socket.socket.connect, socket.socket.connect_ex

    def local_runtime_only(original):
        def guarded(sock, address):
            # Windows asyncio creates a loopback socket pair. Browser requests
            # arrive from another process; no external outbound socket is needed.
            try:
                allowed = ipaddress.ip_address(address[0]).is_loopback and address[1] != 8000
            except (ValueError, TypeError, IndexError):
                allowed = False
            return original(sock, address) if allowed else provider.blocked()
        return guarded

    with ExitStack() as stack:
        stack.enter_context(patch.dict(os.environ, environment, clear=True))
        stack.enter_context(patch.object(socket.socket, "connect", local_runtime_only(original_connect)))
        stack.enter_context(patch.object(socket.socket, "connect_ex", local_runtime_only(original_connect_ex)))
        stack.enter_context(patch.object(httpx.HTTPTransport, "handle_request", provider.blocked))
        stack.enter_context(patch.object(httpx.AsyncHTTPTransport, "handle_async_request", provider.blocked))
        stack.enter_context(patch.object(httpx, "HTTPTransport", lambda **kwargs: httpx.MockTransport(provider.handle)))
        stack.enter_context(patch.object(httpx, "AsyncHTTPTransport", lambda **kwargs: httpx.MockTransport(provider.handle)))
        # main has a module-level app; even its first import is fully isolated.
        from backend.main import create_app
        from fastapi import HTTPException, Request
        from fastapi.routing import APIRoute
        from backend.services.agent_execution import drain_agent_requests
        from backend.services.generation_queue import drain_generation_jobs
        app = create_app(root / "library", frontend_dist_path=frontend_dist or ROOT / "frontend" / "dist")
        seeds = seed_library(root / "library")

        async def diagnostics(request):
            if not request.client or request.client.host not in {"127.0.0.1", "::1"}:
                raise HTTPException(403, "Preview diagnostics are loopback-only")
            return {"preview": True, **provider.diagnostics(), "seeds": seeds, "scenarios": list(SCENARIOS),
                    "promptMarkers": dict(PROMPT_MARKERS)}
        diagnostics.__annotations__["request"] = Request
        app.router.routes.insert(0, APIRoute("/__preview__/diagnostics", diagnostics, methods=["GET"]))
        try:
            yield app, provider, seeds
        finally:
            provider.stopping.set()
            drain_agent_requests(root / "library")
            drain_generation_jobs(root / "library")
            gc.collect()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8766)
    parser.add_argument("--frontend-dist", type=Path, default=ROOT / "frontend" / "dist")
    parser.add_argument("--data-dir", type=Path, help="Optional new/empty directory retained after exit; otherwise disposable temp data")
    parser.add_argument("--delay", type=float, default=0.12, help="Synthetic seconds per stream event")
    args = parser.parse_args(argv)
    if not 1024 <= args.port <= 65535 or args.port == 8000:
        parser.error("Use a non-production port in 1024..65535, excluding 8000")
    if not 0 <= args.delay <= 2:
        parser.error("--delay must be in 0..2 seconds")
    if not (args.frontend_dist / "index.html").is_file():
        parser.error("Build the frontend first (npm run build), or pass --frontend-dist with index.html")
    import uvicorn
    with ExitStack() as stack:
        root = args.data_dir or Path(stack.enter_context(tempfile.TemporaryDirectory(prefix="ipl-agent-preview-")))
        app, _, _ = stack.enter_context(preview_session(root, frontend_dist=args.frontend_dist, delay=args.delay))
        print(f"Offline preview: http://127.0.0.1:{args.port}/ | PID {os.getpid()} | Stop: Ctrl+C", flush=True)
        print(f"Synthetic data: {root} | Diagnostics: /__preview__/diagnostics", flush=True)
        uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
