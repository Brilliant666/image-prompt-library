"""Offline, synthetic Agent context baseline; never opens an existing library.

Run from a development checkout: python scripts/diagnose_agent_context.py
Only aggregate measurements are printed. All provider calls use MockTransport;
socket connections are blocked, and all files live in a TemporaryDirectory.
This is a diagnostic, not a performance threshold or a provider cache test.
"""
from __future__ import annotations

import argparse
import base64
from collections import Counter
from contextlib import contextmanager
from io import BytesIO
import json
import hashlib
import os
from pathlib import Path
import platform
import random
import socket
import sqlite3
import statistics
import sys
import tempfile
import time
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx
from PIL import Image

from backend.agent_schemas import AgentConfigSave, AgentConversationCreate, AgentRoundCreate
from backend.db import connect
from backend.services.agent_execution import build_input, call_responses, refs_for_request
from backend.services.agent_repository import AgentRepository, encoded
from backend.services.agent_skills import read_agent_skill, selected_skill_sections, skill_catalog_instructions
from backend.services.openai_compatible import OpenAICompatibleConfig


CONFIG_SUFFIXES = (
    "AUTH_PATH", "GROK_AUTH_PATH", "CONFIG_PATH", "OPENAI_COMPATIBLE_CONFIG_PATH",
    "CAPTURE_CLIENTS_PATH", "CAPTURE_ORGANIZER_CONFIG_PATH",
)
PROMPT = "优化提示词，比较之前所有构图要求，保留差异。 " + "Synthetic geometric study. " * 8
ANSWER = "Synthetic answer: preserve the geometry, lighting and requested composition. " * 8


def block_network(*args, **kwargs):
    raise AssertionError("The Agent diagnostic must not access the network")


@contextmanager
def isolated_repository(root):
    environment = {"IMAGE_PROMPT_LIBRARY_" + key: str(root / "config" / (key + ".json")) for key in CONFIG_SUFFIXES}
    environment["IMAGE_PROMPT_LIBRARY_PATH"] = str(root / "library")
    with patch.dict(os.environ, environment), patch.object(socket.socket, "connect", block_network), \
            patch.object(socket.socket, "connect_ex", block_network), patch.object(httpx.HTTPTransport, "handle_request", block_network):
        repo = AgentRepository(root / "library")
        OpenAICompatibleConfig(library_path=repo.library).save({
            "base_url": "http://127.0.0.1:1/v1", "api_key": "synthetic-diagnostic-only",
            "model": "mock-model", "display_name": "Offline synthetic provider",
        }, profile_id="mock")
        config = repo.config()
        repo.save_config(AgentConfigSave.model_validate({
            "expectedRevision": config["revision"], "config": {**config["config"],
            "textProfileId": "mock", "textModel": "mock-model", "imageProfileId": "mock", "imageModel": "gpt-image-mock"},
        }))
        repo.create_conversation(AgentConversationCreate(id="synthetic"))
        yield repo


def measure(callback, repeats):
    """Count actual SQLite connections/statements without retaining SQL values."""
    samples = []
    original = sqlite3.connect
    for _ in range(repeats):
        counts = {"connections": 0, "statements": 0, "selects": 0}

        def traced_connect(*args, **kwargs):
            conn = original(*args, **kwargs)
            counts["connections"] += 1

            def trace(statement):
                counts["statements"] += 1
                counts["selects"] += statement.lstrip().upper().startswith("SELECT")
            conn.set_trace_callback(trace)
            return conn

        with patch.object(sqlite3, "connect", traced_connect):
            start = time.perf_counter()
            value = callback()
            elapsed = (time.perf_counter() - start) * 1000
        samples.append({"ms": round(elapsed, 3), **counts})
    return value, {"median_ms": statistics.median(s["ms"] for s in samples),
                   "min_ms": min(s["ms"] for s in samples), "max_ms": max(s["ms"] for s in samples),
                   **{key: statistics.median(s[key] for s in samples) for key in counts}}


def capture(repo, request_id, step=1):
    captured = []

    def handle(request):
        assert request.url == "http://127.0.0.1:1/v1/responses"
        captured.append((json.loads(request.content), len(request.content)))
        return httpx.Response(200, json={"id": f"mock-response-{step}", "status": "completed", "output": []})

    request = repo.request(request_id)
    with patch.object(httpx, "HTTPTransport", lambda **kwargs: httpx.MockTransport(handle)):
        call_responses(repo, request_id, step, refs_for_request(repo, request))
    assert len(captured) == 1
    return captured[0]


def body_metrics(body, wire_bytes):
    images = [part["image_url"] for item in body["input"] for part in item.get("content", [])
              if isinstance(part, dict) and part.get("type") == "input_image"]
    return {"request_json_bytes": wire_bytes, "input_items": len(body["input"]), "image_occurrences": len(images),
            "attached_image_bytes": sum(len(base64.b64decode(url.split(",", 1)[1])) for url in images),
            "image_base64_bytes": sum(len(url.split(",", 1)[1]) for url in images),
            "instructions_utf8_bytes": len(body["instructions"].encode()),
            "skill_catalog_utf8_bytes": len(skill_catalog_instructions().encode()),
            "tools_json_bytes": len(encoded(body["tools"]).encode())}


def asset_inventory(repo):
    """Count actual recursive files separately from logical asset rows.

    Keep paths internal: stdout exposes only aggregate measurements. Hash real
    bytes so nested storage, unreferenced files and duplicate copies cannot make
    a storage optimization appear more effective than it is.
    """
    root = repo.library / "generation-references" / "agent"
    files = {path.relative_to(repo.library).as_posix(): path
             for path in root.rglob("*") if path.is_file()} if root.exists() else {}
    hashes = Counter(hashlib.sha256(path.read_bytes()).hexdigest() for path in files.values())
    with connect(repo.library) as conn:
        assets = conn.execute("SELECT path,sha256 FROM agent_assets").fetchall()
    conn.close()
    paths = {row[0] for row in assets}
    return {
        "agent_asset_rows": len(assets),
        "distinct_frozen_image_hashes": len({row[1] for row in assets}),
        "frozen_original_files": len(files),
        "distinct_physical_image_hashes": len(hashes),
        "frozen_original_file_bytes": sum(path.stat().st_size for path in files.values()),
        "duplicate_physical_image_files": sum(count - 1 for count in hashes.values()),
        "unreferenced_agent_files": len(set(files) - paths),
        "missing_agent_asset_files": sum(not (repo.library / row[0]).is_file() for row in assets),
    }, set(files)


def create_round(repo, n, parent, asset_id=None):
    return repo.create_round("synthetic", AgentRoundCreate.model_validate({
        "requestId": f"request-{n}", "expectedRevision": repo.snapshot("synthetic")["revision"],
        "parentRoundId": parent, "prompt": PROMPT + f"Round {n}.", "configRevision": repo.config()["revision"],
        "refs": [{"kind": "upload", "uploadId": asset_id}] if asset_id else [],
        "authorization": {"scope": "this_request", "allowImageGeneration": True, "maxImageJobs": 2, "maxToolRounds": 5},
    }))


def common_input_prefix(left, right):
    count = 0
    for first, second in zip(left, right):
        if first != second:
            break
        count += 1
    return count


def unchanged_input_item_occurrences(left, right):
    """Count exact preserved content, separately from cache-prefix order."""
    old = Counter(hashlib.sha256(encoded(item).encode()).digest() for item in left)
    new = Counter(hashlib.sha256(encoded(item).encode()).digest() for item in right)
    return sum((old & new).values())


def scope_probes(repo, request_id):
    """Measure real request construction for synthetic reference intents.

    Only this temporary diagnostic's round text is changed, then restored. No
    existing library is opened and no real provider receives these requests.
    """
    original = repo.request(request_id)["round"]
    rows = []
    try:
        for name, prompt in (
            ("new_image_with_implicit_history", "Match the lighting of the portrait we discussed on this photo."),
            ("exact_reference_only", '<ref id="round-1-reference-1" />'),
            ("greeting", "你好"),
        ):
            with connect(repo.library) as conn:
                conn.execute("UPDATE agent_rounds SET data=? WHERE id=?", (encoded({**original, "prompt": prompt}), original["id"]))
            conn.close()
            body, size = capture(repo, request_id)
            rows.append({"intent": name, **body_metrics(body, size)})
    finally:
        with connect(repo.library) as conn:
            conn.execute("UPDATE agent_rounds SET data=? WHERE id=?", (encoded(original), original["id"]))
        conn.close()
    return rows


def scenario(root, checkpoints, repeats, with_images):
    rows, comparisons = [], []
    # Valid deterministic PNG, not a personal image; no metadata or external file.
    buffer = BytesIO()
    Image.frombytes("RGB", (256, 256), random.Random(7).randbytes(256 * 256 * 3)).save(buffer, format="PNG")
    image = buffer.getvalue()
    with isolated_repository(root) as repo:
        parent, previous_body = None, None
        for n in range(1, max(checkpoints) + 1):
            aid = repo.store_asset(image, None)["id"] if with_images else None
            started = time.perf_counter()
            snapshot, _ = create_round(repo, n, parent, aid)
            create_ms = (time.perf_counter() - started) * 1000
            request_id = f"request-{n}"
            parent = snapshot["conversation"]["activeRoundId"]
            if n in checkpoints:
                request, request_cost = measure(lambda: repo.request(request_id), repeats)

                def context():
                    value = repo.request(request_id)
                    return build_input(repo, value, refs_for_request(repo, value))

                _, context_cost = measure(context, repeats)
                fixed_refs = refs_for_request(repo, request)
                _, build_cost = measure(lambda: build_input(repo, request, fixed_refs), repeats)
                snap, snapshot_cost = measure(lambda: repo.snapshot(request_id=request_id), repeats)
                body, wire_bytes = capture(repo, request_id)
                skills = selected_skill_sections(PROMPT + f"Round {n}.", with_images, PROMPT if n > 1 else None)
                with connect(repo.library) as conn:
                    history_bytes = conn.execute("SELECT sum(length(CAST(history AS BLOB))) FROM agent_requests").fetchone()[0]
                inventory, _ = asset_inventory(repo)
                rows.append({"scenario": "image_history" if with_images else "text_history", "rounds": n,
                    **inventory,
                    **body_metrics(body, wire_bytes), "historical_image_bytes": (n - 1) * len(image) if with_images else 0,
                    "preloaded_skill_sections": [f"{s['skill']}/{s['section']}" for s in skills],
                    "preloaded_skill_content_bytes": sum(len(s["content"].encode()) for s in skills),
                    "request_read": request_cost, "context_including_request_and_refs": context_cost,
                    "build_input_only": build_cost,
                    "snapshot": snapshot_cost, "snapshot_json_bytes": len(encoded(snap).encode()),
                    "create_round_once_ms": round(create_ms, 3), "stored_history_json_bytes_all_requests": history_bytes,
                    "database_file_bytes": (repo.library / "db.sqlite").stat().st_size})
                if with_images:
                    rows[-1]["reference_scope_probes"] = scope_probes(repo, request_id)
                if previous_body:
                    previous_n, old = previous_body
                    comparisons.append({"from_round": previous_n, "to_round": n,
                        "scenario": rows[-1]["scenario"], "instructions_equal": old["instructions"] == body["instructions"],
                        "tools_equal": old["tools"] == body["tools"],
                        "equal_leading_input_items": common_input_prefix(old["input"], body["input"]),
                        "previous_input_items": len(old["input"])})
                previous_body = (n, body)
            if n < max(checkpoints):
                repo.update(request_id, state="completed", text=ANSWER, outcome="known")

        # Real request construction after a deterministic tool receipt. No tool
        # dispatcher or image provider is run; only quota state is simulated.
        skill = read_agent_skill("gpt-image", "overview")
        repo.update(request_id, output=[
            {"type": "function_call", "name": "read_agent_skill", "call_id": "mock-skill-call",
             "arguments": encoded({"skill": "gpt-image", "section": "overview"})},
            {"type": "function_call_output", "call_id": "mock-skill-call", "output": encoded(skill)},
        ])
        followups = []
        for used in (0, 1, 2):
            with connect(repo.library) as conn:
                usage = repo.request(request_id)["usage"]
                usage["imageJobsCreated"] = used
                conn.execute("UPDATE agent_requests SET usage=? WHERE id=?", (encoded(usage), request_id))
            following, size = capture(repo, request_id, 2)
            followups.append({"simulated_image_jobs_used": used, **body_metrics(following, size),
                "same_instructions_as_first_call": following["instructions"] == body["instructions"],
                "same_tools_as_first_call": following["tools"] == body["tools"],
                "repeated_leading_input_items": common_input_prefix(body["input"], following["input"]),
                "unchanged_input_item_occurrences": unchanged_input_item_occurrences(body["input"], following["input"]),
                "skill_tool_output_bytes": len(encoded(skill).encode())})
        # Task changes can alter preloaded sections without changing configuration.
        with connect(repo.library) as conn:
            current = repo.request(request_id)
            usage = dict(current["usage"], imageJobsCreated=0)
            conn.execute("UPDATE agent_requests SET usage=? WHERE id=?", (encoded(usage), request_id))
            round_data = current["round"]
            round_data["prompt"] = "你好"
            conn.execute("UPDATE agent_rounds SET data=? WHERE id=?", (encoded(round_data), round_data["id"]))
        greeting, size = capture(repo, request_id, 3)
        return {"rows": rows, "prefix_comparisons": comparisons, "tool_followups": followups,
                "task_switch": {**body_metrics(greeting, size), "instructions_equal": greeting["instructions"] == body["instructions"],
                                "tools_equal": greeting["tools"] == body["tools"]}}


def run(checkpoints=(1, 5, 25, 50, 100), repeats=3):
    with tempfile.TemporaryDirectory(prefix="ipl-agent-diagnostic-") as temporary:
        root = Path(temporary)
        return {"schema": 1, "environment": {"os": platform.system(), "python": platform.python_version()},
                "repeats": repeats, "network": "blocked; MockTransport only", "provider_cache": "not measured",
                "scenarios": [scenario(root / name, checkpoints, repeats, images)
                              for name, images in (("text", False), ("images", True))]}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rounds", type=int, nargs="+", default=[1, 5, 25, 50, 100])
    parser.add_argument("--repeats", type=int, default=3)
    args = parser.parse_args()
    if not 1 <= args.repeats <= 10 or any(not 1 <= n <= 100 for n in args.rounds):
        parser.error("Use 1..100 rounds and 1..10 repeats")
    print(json.dumps(run(tuple(sorted(set(args.rounds))), args.repeats), ensure_ascii=False, indent=2))
