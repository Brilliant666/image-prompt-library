"""Measure the real Agent/SSE/image-queue chain against an offline provider.

All libraries and pictures are synthetic and temporary. Socket access is blocked.
Mock delays and usage values exercise measurement, not provider performance,
tokenization, pricing or prompt-cache efficacy. Only aggregate data is printed.
"""
from __future__ import annotations

import argparse
import base64
from collections import Counter
import gc
import json
from pathlib import Path
import platform
import sys
import tempfile
import time
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx

from backend.agent_schemas import AgentRoundCreate
from backend.db import connect
from backend.services.agent_execution import build_input, refs_for_request, run_request
from backend.services.agent_repository import AgentRepository, encoded
from backend.services.agent_skills import read_agent_skill
from backend.services.generation_queue import drain_generation_jobs
from scripts.diagnose_agent_context import asset_inventory, body_metrics, common_input_prefix, isolated_repository, measure
from scripts.diagnose_agent_result_snapshots import synthetic_png


DEFAULT_DELAYS_MS = {"model_headers": 5, "model_first_event": 5, "model_terminal": 5, "image_response": 10}


class SyntheticStream(httpx.SyncByteStream):
    def __init__(self, payload, delays):
        self.payload, self.delays = payload, delays

    def __iter__(self):
        time.sleep(self.delays["model_first_event"] / 1000)
        yield ("data: " + json.dumps({"type": "response.created", "response": {"id": self.payload["id"]}}) + "\n\n").encode()
        time.sleep(self.delays["model_terminal"] / 1000)
        yield ("data: " + json.dumps({"type": "response.completed", "response": self.payload}) + "\n\n").encode()


class SyntheticProvider:
    """Capture wire bodies in memory only; never connect to a provider."""
    def __init__(self, delays):
        self.delays = delays
        self.calls = Counter()
        self.round_number = self.step = 0
        self.reference = None
        self.needs_followup = False
        self.bodies = []

    def begin(self, number, reference, needs_followup):
        self.round_number, self.reference = number, reference
        self.needs_followup, self.step, self.bodies = needs_followup, 0, []
        self.round_start_calls = self.calls.copy()

    def handle(self, request):
        assert request.url.host == "127.0.0.1" and request.url.port == 1
        assert request.method == "POST"
        if request.url.path == "/v1/responses":
            self.calls["responses"] += 1
            self.step += 1
            body = json.loads(request.content)
            assert body["stream"] is True
            self.bodies.append((body, len(request.content)))
            # Deliberately exercise missing cached_tokens separately from 0.
            # These numbers are fixture data, not estimated actual token usage.
            usage = {"input_tokens": 120, "output_tokens": 20, "total_tokens": 140}
            if self.round_number % 2 == 0:
                usage["input_tokens_details"] = {"cached_tokens": 0}
            if self.step == 1:
                output = [{"type": "function_call", "call_id": f"draw-{self.round_number}",
                           "name": "generate_image", "arguments": encoded({
                               "id": "single", "prompt": f'Synthetic geometry with soft blue lighting <ref id="{self.reference}" />',
                               "finish_after_generation": not self.needs_followup})}]
            else:
                assert self.step == 2 and self.needs_followup
                output = [{"type": "message", "id": f"answer-{self.round_number}", "role": "assistant",
                           "content": [{"type": "output_text", "text": "Synthetic image stored."}]}]
            payload = {"id": f"response-{self.round_number}-{self.step}", "status": "completed",
                       "model": "mock-model", "usage": usage, "output": output}
            time.sleep(self.delays["model_headers"] / 1000)
            return httpx.Response(200, headers={"content-type": "text/event-stream"}, stream=SyntheticStream(payload, self.delays))
        assert request.url.path == "/v1/images/edits", "Unexpected provider endpoint"
        self.calls["images"] += 1
        time.sleep(self.delays["image_response"] / 1000)
        return httpx.Response(200, json={"data": [{"b64_json": base64.b64encode(synthetic_png(self.round_number)).decode()}]})


def prefix_comparison(previous, current, previous_round, current_round):
    shared = common_input_prefix(previous["input"], current["input"])
    def without_task_state(items):
        return [{**item, 'content': [part for part in item['content'] if not (
            part.get('type') == 'input_text' and part.get('text', '').startswith('Current creative task ('))]}
            if isinstance(item.get('content'), list) else item for item in items]
    stable_input = common_input_prefix(without_task_state(previous['input']), without_task_state(current['input']))
    return {"from_round": previous_round, "to_round": current_round,
            "instructions_equal": previous["instructions"] == current["instructions"],
            "tools_equal": previous["tools"] == current["tools"],
            "previous_input_items": len(previous["input"]), "equal_leading_input_items": shared,
            "equal_leading_items_without_current_task_state": stable_input,
            "equal_leading_input_json_bytes": len(encoded(previous["input"][:shared]).encode()),
            "first_different_input_index": shared if shared < len(previous["input"]) else None}


def skill_bytes(body, details):
    sections = [read_agent_skill(skill["skill"], skill["section"]) for skill in details.get("skills", [])]
    instructions = body["instructions"]
    inputs = encoded(body["input"])
    return {"selected_sections": [f"{part['skill']}/{part['section']}" for part in sections],
            "selected_section_utf8_bytes": sum(len(part["content"].encode()) for part in sections),
            "section_occurrences_in_instructions": sum(instructions.count(part["content"]) for part in sections),
            "section_occurrences_in_input": sum(inputs.count(encoded(part["content"])[1:-1]) for part in sections)}


def run(checkpoints=(5, 25, 50, 100), repeats=3, delays=None):
    delays = dict(DEFAULT_DELAYS_MS if delays is None else delays)
    rows, comparisons = [], []
    provider = SyntheticProvider(delays)
    usage_reports = Counter()
    previous_body, previous_round = None, None
    with tempfile.TemporaryDirectory(prefix="ipl-agent-execution-diagnostic-") as temporary:
        with isolated_repository(Path(temporary)) as repo:
            # The baseline repository uses a persisted fake profile and config;
            # the production request builder and queue resolve them normally.
            asset = repo.store_asset(synthetic_png(0), None)
            parent = None
            try:
                with patch.object(httpx, "HTTPTransport", lambda **kwargs: httpx.MockTransport(provider.handle)):
                    for n in range(1, max(checkpoints) + 1):
                        request_id = f"execution-{n}"
                        payload = AgentRoundCreate.model_validate({
                            "requestId": request_id, "expectedRevision": repo.snapshot("synthetic")["revision"],
                            "parentRoundId": parent, "prompt": "保持几何主体，修改图片背景为蓝色，生成一张图片。",
                            "configRevision": repo.config()["revision"],
                            "refs": [{"kind": "upload", "uploadId": asset["id"]}] if n == 1 else [],
                            "authorization": {"scope": "this_request", "allowImageGeneration": True,
                                              "maxImageJobs": 1, "maxToolRounds": 2},
                        })
                        (snapshot, created), creation_cost = measure(lambda: repo.create_round("synthetic", payload), 1)
                        assert created
                        parent = snapshot["conversation"]["activeRoundId"]
                        request = repo.request(request_id)
                        fixed_refs = refs_for_request(repo, request)
                        if n in checkpoints:
                            _, request_cost = measure(lambda: repo.request(request_id), repeats)
                            _, build_cost = measure(lambda: build_input(repo, request, fixed_refs), repeats)
                            def prepare_context():
                                current = repo.request(request_id)
                                return build_input(repo, current, refs_for_request(repo, current))
                            _, context_cost = measure(prepare_context, repeats)
                        reference = "round-1-reference-1" if n == 1 else f"round-{n - 1}-image-1"
                        provider.begin(n, reference, n in checkpoints)
                        _, execution_cost = measure(lambda: run_request(repo.library, request_id), 1)
                        stored = AgentRepository(repo.library).request(request_id)
                        assert stored["state"] == "completed", stored.get("error")
                        round_data = stored["round"]
                        jobs = [repo.jobs.get_job(jid) for jid in round_data["outputTaskIds"]]
                        assert len(jobs) == 1 and jobs[0].status == "succeeded"
                        details = round_data["responseDetails"]
                        for step in details["steps"]:
                            cached = step["usage"]["cachedInputTokens"]
                            usage_reports["missing" if cached is None else "reported_zero" if cached == 0 else "reported_positive"] += 1
                        if n not in checkpoints:
                            continue
                        snapshot, snapshot_cost = measure(lambda: repo.snapshot(request_id=request_id), repeats)
                        with connect(repo.library) as conn:
                            history_bytes = conn.execute("SELECT sum(length(CAST(history AS BLOB))) FROM agent_requests").fetchone()[0]
                        conn.close()
                        body, wire_bytes = provider.bodies[0]
                        inventory, _ = asset_inventory(repo)
                        row = {"rounds": n, **body_metrics(body, wire_bytes), **inventory,
                               "request_read": request_cost, "create_round_once": creation_cost,
                               "build_input_only": build_cost, "context_including_request_and_refs": context_cost,
                               "run_request_once": execution_cost, "snapshot": snapshot_cost,
                               "snapshot_json_bytes": len(encoded(snapshot).encode()),
                               "stored_history_json_bytes_all_requests": history_bytes,
                               "execution": round_data["execution"],
                               "image_execution": jobs[0].metadata["execution"],
                               "usage_source": "fixed synthetic provider reports; not actual model usage",
                               "reported_usage_steps": [{"step": step["step"], "usage": step["usage"]} for step in details["steps"]],
                               "skills": skill_bytes(body, details),
                               "provider_calls_this_round": dict(provider.calls - provider.round_start_calls),
                               "tool_followup": {**body_metrics(*provider.bodies[1]),
                                                 **prefix_comparison(body, provider.bodies[1][0], n, n),
                                                 "skills": skill_bytes(provider.bodies[1][0], details)}}
                        rows.append(row)
                        if previous_body is not None:
                            comparisons.append(prefix_comparison(previous_body, body, previous_round, n))
                        previous_body, previous_round = body, n
            finally:
                drain_generation_jobs(repo.library)
        gc.collect()
    return {"schema": 1, "environment": {"os": platform.system(), "python": platform.python_version(),
            "execution_clock_resolution_ms": time.get_clock_info("monotonic").resolution * 1000,
            "benchmark_clock_resolution_ms": time.get_clock_info("perf_counter").resolution * 1000},
            "network": "blocked; MockTransport only; real Agent and image queue",
            "scenario": "one initial synthetic input, one distinct image result per round; checkpoint rounds include a post-tool model call",
            "repeats": repeats, "mutating_execution_repeats": 1, "simulated_provider_delays_ms": delays,
            "timing_note": "Header/first-event/response are cumulative milestones per model call, not additive phases; first event is not first visible token. Preparation includes request creation. Tools include queue and polling. run_request minus image time is not model time. Sub-resolution mock waits can measure 0; this is distinct from an unmeasured null.",
            "provider_cache": "not measured", "provider_calls": dict(provider.calls),
            "synthetic_cached_token_reports": dict(usage_reports), "rows": rows, "prefix_comparisons": comparisons}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rounds", type=int, nargs="+", default=[5, 25, 50, 100])
    parser.add_argument("--repeats", type=int, default=3)
    args = parser.parse_args()
    if not 1 <= args.repeats <= 10 or any(not 1 <= n <= 100 for n in args.rounds):
        parser.error("Use 1..100 rounds and 1..10 repeats")
    print(json.dumps(run(tuple(sorted(set(args.rounds))), args.repeats), ensure_ascii=False, indent=2))
