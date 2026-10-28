"""Benchmark real Agent request construction using only temporary synthetic data.

Example: python scripts/benchmark_agent_pipeline.py --rounds 5 25 50 100 --repeats 5
Use the same interpreter and this script with --source-root OTHER_CHECKOUT for a
baseline comparison. The report records source, lock and script fingerprints.
Cold means the existing image-encoding cache is cleared before each sample;
warm means it is primed before sampling. OS filesystem caches are not flushed.
No model service is contacted: network sockets are blocked and the production
Responses path is captured by MockTransport. Reports contain aggregate values,
never request bodies, API keys, image data URLs or personal library contents.
"""
from __future__ import annotations

import argparse
import base64
from collections import Counter
from contextlib import contextmanager
import gc
import hashlib
from importlib.metadata import version
from io import BytesIO
import json
from pathlib import Path
import platform
import sqlite3
import statistics
import subprocess
import sys
import tempfile
import time
from unittest.mock import patch


def load_source(source_root):
    source_root = Path(source_root).resolve()
    sys.path.insert(0, str(source_root))
    from scripts import diagnose_agent_context as diagnostic
    from backend.services import agent_execution as execution
    from backend.services import agent_image_encoding as encoding
    from backend.services.agent_repository import AgentRepository, encoded
    from backend.agent_schemas import AgentRoundCreate
    from backend.db import connect
    import httpx
    from PIL import Image
    for module in (diagnostic, execution, encoding, sys.modules[AgentRepository.__module__]):
        if not Path(module.__file__).resolve().is_relative_to(source_root):
            raise RuntimeError("A different source checkout is already imported; compare checkouts in separate Python processes")
    return diagnostic, execution, encoding, AgentRepository, encoded, AgentRoundCreate, connect, httpx, Image


@contextmanager
def observed_work(repo, payloads, encoding):
    """Count externally observed operations; do not trust implementation counters."""
    counters = Counter({key: 0 for key in (
        "image_file_reads", "image_file_bytes", "image_sha256_calls", "sha256_calls",
        "base64_encode_calls", "base64_input_bytes", "png_recompress_calls",
        "sql_connections", "sql_statements", "sql_selects", "request_calls", "snapshot_calls",
    )})
    image_root = (repo.library / "generation-references").resolve()
    read_bytes, sha256, b64encode = Path.read_bytes, hashlib.sha256, base64.b64encode
    sqlite_connect = sqlite3.connect
    request_method, snapshot_method = type(repo).request, type(repo).snapshot
    recompress = encoding._recompress_png

    def read(path):
        data = read_bytes(path)
        if path.resolve().is_relative_to(image_root):
            counters["image_file_reads"] += 1
            counters["image_file_bytes"] += len(data)
        return data

    def digest(data=b"", *args, **kwargs):
        counters["sha256_calls"] += 1
        if isinstance(data, bytes) and data in payloads:
            counters["image_sha256_calls"] += 1
        return sha256(data, *args, **kwargs)

    def encode(data, *args, **kwargs):
        counters["base64_encode_calls"] += 1
        counters["base64_input_bytes"] += len(data)
        return b64encode(data, *args, **kwargs)

    def compress(data):
        counters["png_recompress_calls"] += 1
        return recompress(data)

    def traced_connect(*args, **kwargs):
        conn = sqlite_connect(*args, **kwargs)
        counters["sql_connections"] += 1
        def trace(statement):
            counters["sql_statements"] += 1
            counters["sql_selects"] += statement.lstrip().upper().startswith("SELECT")
        conn.set_trace_callback(trace)
        return conn

    def request(instance, *args, **kwargs):
        counters["request_calls"] += 1
        return request_method(instance, *args, **kwargs)

    def snapshot(instance, *args, **kwargs):
        counters["snapshot_calls"] += 1
        return snapshot_method(instance, *args, **kwargs)

    with patch.object(Path, "read_bytes", read), patch.object(hashlib, "sha256", digest), \
            patch.object(base64, "b64encode", encode), patch.object(sqlite3, "connect", traced_connect), \
            patch.object(type(repo), "request", request), patch.object(type(repo), "snapshot", snapshot), \
            patch.object(encoding, "_recompress_png", compress):
        yield counters


def summarize(samples):
    return {"samples": len(samples), **{
        key: {"median": statistics.median(sample[key] for sample in samples),
              "min": min(sample[key] for sample in samples),
              "max": max(sample[key] for sample in samples)}
        for key in samples[0]
    }}


def sample_operation(callback, restore, repo, payloads, encoding, repeats):
    result = {}
    value = None
    for temperature in ("cold", "warm"):
        if temperature == "warm":
            restore()
            callback()
        samples = []
        for _ in range(repeats):
            restore()
            if temperature == "cold":
                encoding._cache.clear()
            started = time.perf_counter()
            value = callback()
            elapsed = (time.perf_counter() - started) * 1000
            restore()
            if temperature == "cold":
                encoding._cache.clear()
            with observed_work(repo, payloads, encoding) as counters:
                started = time.perf_counter()
                value = callback()
                instrumented = (time.perf_counter() - started) * 1000
            samples.append({"elapsed_ms": round(elapsed, 4),
                            "instrumented_elapsed_ms": round(instrumented, 4), **counters})
        result[temperature] = summarize(samples)
    return value, result


def image_urls(items):
    return [part["image_url"] for item in items for part in item.get("content", [])
            if isinstance(part, dict) and part.get("type") == "input_image"]


def payload_metrics(body, wire_bytes):
    urls = image_urls(body["input"])
    return {"request_json_bytes": wire_bytes, "input_items": len(body["input"]),
            "image_occurrences": len(urls), "unique_image_payloads": len(set(urls)),
            "image_base64_bytes": sum(len(url.split(",", 1)[1]) for url in urls),
            "ref_alias_occurrences": sum(part.get("text", "").count('<ref id="')
                for item in body["input"] for part in item.get("content", []) if isinstance(part, dict)),
            "tool_calls": sum(item.get("type") == "function_call" for item in body["input"]),
            "tool_results": sum(item.get("type") == "function_call_output" for item in body["input"]),
            "roles": dict(Counter(item.get("role", "tool") for item in body["input"])),
            "input_sha256": hashlib.sha256(json.dumps(body["input"], ensure_ascii=False,
                sort_keys=True, separators=(",", ":")).encode()).hexdigest()}


def synthetic_png(Image, index, *, mask=False):
    output = BytesIO()
    if mask:
        image = Image.new("RGBA", (256, 256), (index % 256, 50, 90, 80))
    else:
        image = Image.new("RGB", (256, 256), (index % 256, (index * 17) % 256, (index * 43) % 256))
    image.save(output, "PNG", compress_level=0)
    return output.getvalue()


def benchmark_checkpoint(repo, request_id, payloads, modules, repeats, experimental, verify_body=None):
    diagnostic, execution, encoding, _, encoded, _, connect, httpx, _ = modules
    frozen_request = repo.request(request_id)
    frozen = {**frozen_request["frozen"], "experimentalImageDeduplication": experimental}
    original_round = encoded(frozen_request["round"])
    with connect(repo.library) as conn:
        conn.execute("UPDATE agent_requests SET frozen=? WHERE id=?", (encoded(frozen), request_id))
    conn.close()

    def restore():
        with connect(repo.library) as conn:
            conn.execute("UPDATE agent_rounds SET data=? WHERE id=?", (original_round, frozen_request["round_id"]))
            conn.execute("UPDATE agent_requests SET state='running',upstream_outcome='known' WHERE id=?", (request_id,))
        conn.close()

    def projection():
        request = repo.request(request_id)
        refs = execution.refs_for_request(repo, request)
        attached, skills = [], []
        return execution.build_input(repo, request, refs, attached_refs=attached, skill_receipts=skills)

    def capture():
        captured = []
        def respond(request):
            assert request.url == "http://127.0.0.1:1/v1/responses"
            captured.append((json.loads(request.content), len(request.content)))
            return httpx.Response(200, json={"id": "mock-response", "status": "completed", "output": []})
        request = repo.request(request_id)
        with patch.object(httpx, "HTTPTransport", lambda **kwargs: httpx.MockTransport(respond)):
            execution.call_responses(repo, request_id, 1, execution.refs_for_request(repo, request))
        assert len(captured) == 1
        return captured[0]

    _, projection_cost = sample_operation(projection, restore, repo, payloads, encoding, repeats)
    (body, wire_bytes), post_cost = sample_operation(capture, restore, repo, payloads, encoding, repeats)
    _, snapshot_cost = sample_operation(lambda: repo.snapshot(request_id=request_id), restore,
                                       repo, payloads, encoding, repeats)
    restore()
    if verify_body:
        verify_body(body)
    return {"experimental_deduplication": experimental,
            "projection": projection_cost, "mock_responses": post_cost, "snapshot": snapshot_cost,
            **payload_metrics(body, wire_bytes)}


def scenario(root, name, checkpoints, repeats, experimental, modules):
    diagnostic, _, _, _, _, _, _, _, Image = modules
    rows = []
    with diagnostic.isolated_repository(root) as repo:
        payloads, assets = set(), []
        if name != "text":
            for index in range(1 if name == "repeated_image" else max(checkpoints)):
                raw = synthetic_png(Image, index + 7)
                payloads.add(raw)
                assets.append(repo.store_asset(raw, None)["id"])
        initial_files = {path: hashlib.sha256(path.read_bytes()).hexdigest()
                         for path in (repo.library / "generation-references").rglob("*") if path.is_file()}
        parent = None
        for number in range(1, max(checkpoints) + 1):
            asset = assets[0 if name == "repeated_image" else number - 1] if assets else None
            snapshot, _ = diagnostic.create_round(repo, number, parent, asset)
            request_id = f"request-{number}"
            parent = snapshot["conversation"]["activeRoundId"]
            if number in checkpoints:
                rows.append({"rounds": number, **benchmark_checkpoint(
                    repo, request_id, payloads, modules, repeats, experimental)})
                print(f"Measured {name}: {number} rounds", file=sys.stderr, flush=True)
            repo.update(request_id, state="completed", text=diagnostic.ANSWER, outcome="known")
        assert all(path.is_file() and hashlib.sha256(path.read_bytes()).hexdigest() == digest
                   for path, digest in initial_files.items())
        return {"scenario": name, "original_assets_unchanged": True, "rows": rows}


def semantic_probes(root, modules, experimental):
    diagnostic, _, _, _, _, AgentRoundCreate, _, _, Image = modules
    results = []

    def turn(repo, request_id, prompt, *, parent=None, assets=(), mask=None):
        value = {"requestId": request_id, "expectedRevision": repo.snapshot("synthetic")["revision"],
                 "parentRoundId": parent, "prompt": prompt, "configRevision": repo.config()["revision"],
                 "refs": [{"kind": "upload", "uploadId": aid} for aid in assets],
                 "authorization": {"scope": "this_request", "allowImageGeneration": True,
                                   "maxImageJobs": 2, "maxToolRounds": 5}}
        if mask:
            value["mask"] = mask
        snapshot, _ = repo.create_round("synthetic", AgentRoundCreate.model_validate(value))
        repo.update(request_id, state="completed", outcome="known")
        return snapshot["conversation"]["activeRoundId"]

    with diagnostic.isolated_repository(root / "mask") as repo:
        from backend.agent_schemas import AgentConfigSave
        config = repo.config()
        repo.save_config(AgentConfigSave.model_validate({"expectedRevision": config["revision"],
            "config": {**config["config"], "apiConfigMode": "native"}}))
        raw = [synthetic_png(Image, index) for index in (21, 22)]
        raw.append(synthetic_png(Image, 23, mask=True))
        auxiliary, target = [repo.store_asset(data, None)["id"] for data in raw[:2]]
        mask = repo.store_asset(raw[2], None, "mask")["id"]
        turn(repo, "mask", "Create a synthetic orange square.",
             assets=(auxiliary, target), mask={"uploadId": mask, "targetRefIndex": 1})
        def verify_mask(body):
            assert image_urls(body["input"]) == [repo.data_url(aid) for aid in (target, auxiliary, target)]
            tool = next(tool for tool in body["tools"] if tool["type"] == "image_generation")
            url = tool["input_image_mask"]["image_url"]
            with Image.open(BytesIO(base64.b64decode(url.split(",", 1)[1]))) as transmitted:
                assert transmitted.mode == "RGBA"
                assert transmitted.getpixel((0, 0)) == (23, 50, 90, 80)
        results.append({"case": "mask", "target_first_and_alpha_preserved": True,
            **benchmark_checkpoint(repo, "mask", set(raw), modules, 1, experimental, verify_mask)})

    with diagnostic.isolated_repository(root / "branch") as repo:
        raw = [synthetic_png(Image, index) for index in (31, 32, 33)]
        ancestor, sibling, current = [repo.store_asset(data, None)["id"] for data in raw]
        first = turn(repo, "ancestor", "Ancestor reference.", assets=(ancestor,))
        turn(repo, "sibling", "Sibling reference.", parent=first, assets=(sibling,))
        turn(repo, "current", "Compare the current image with the ancestor.", parent=first, assets=(current,))
        def verify_branch(body):
            assert image_urls(body["input"]) == [repo.data_url(aid) for aid in (ancestor, current)]
            assert repo.data_url(sibling) not in json.dumps(body)
        results.append({"case": "branch", "sibling_excluded": True,
            **benchmark_checkpoint(repo, "current", set(raw), modules, 1, experimental, verify_branch)})

    with diagnostic.isolated_repository(root / "tools") as repo:
        first = turn(repo, "first", "Explain the first tool result.")
        repo.update("first", output=[
            {"type": "function_call", "name": "library_search", "call_id": "shared", "arguments": '{"query":"one"}'},
            {"type": "function_call_output", "call_id": "shared", "output": '{"items":["one"]}'},
            {"type": "function_call", "name": "library_search", "call_id": "orphan", "arguments": '{}'},
        ])
        second = turn(repo, "second", "Explain the second tool result.", parent=first)
        repo.update("second", output=[
            {"type": "function_call", "name": "library_search", "call_id": "shared", "arguments": '{"query":"two"}'},
            {"type": "function_call_output", "call_id": "shared", "output": '{"items":["two"]}'},
            {"type": "function_call_output", "call_id": "orphan", "output": '{"cross_round":true}'},
        ])
        turn(repo, "current", "Compare the completed results.", parent=second)
        def verify_tools(body):
            tools = [item for item in body["input"] if item.get("type") in {"function_call", "function_call_output"}]
            assert [item.get("arguments", item.get("output")) for item in tools] == [
                '{"query":"one"}', '{"items":["one"]}', '{"query":"two"}', '{"items":["two"]}']
        results.append({"case": "tool_pairing", "round_boundaries_preserved": True,
            **benchmark_checkpoint(repo, "current", set(), modules, 1, experimental, verify_tools)})
    return results


def git_revision(source_root):
    return subprocess.check_output(["git", "-C", str(source_root), "rev-parse", "HEAD"], text=True).strip()


def source_fingerprint(source_root):
    paths = sorted((source_root / "backend").rglob("*.py"))
    paths += [source_root / name for name in ("scripts/diagnose_agent_context.py", "pyproject.toml", "uv.lock")]
    digest = hashlib.sha256()
    for path in paths:
        digest.update(path.relative_to(source_root).as_posix().encode() + b"\0")
        digest.update(hashlib.sha256(path.read_bytes()).digest())
    return {"sha256": digest.hexdigest(), "files": len(paths)}


@contextmanager
def synthetic_workspace():
    with tempfile.TemporaryDirectory(prefix="ipl-agent-pipeline-benchmark-") as temporary:
        try:
            yield Path(temporary)
        finally:
            # SQLite connection cycles can outlive a with-block on Windows.
            gc.collect()


def run(source_root, *, checkpoints=(5, 25, 50, 100), repeats=5,
        scenarios=("text", "repeated_image", "unique_images"), experimental=False, include_probes=True):
    source_root = Path(source_root).resolve()
    identity = source_fingerprint(source_root)
    script_digest = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    modules = load_source(source_root)
    with synthetic_workspace() as temporary:
        probes = semantic_probes(temporary / "probes", modules, experimental) if include_probes else []
        report = {"schema": 1, "source_head": git_revision(source_root),
                "source_content": identity,
                "source_dirty": bool(subprocess.check_output(["git", "-C", str(source_root), "status", "--porcelain"], text=True).strip()),
                "tracked_diff_sha256": hashlib.sha256(subprocess.check_output(
                    ["git", "-C", str(source_root), "diff", "HEAD", "--binary"])).hexdigest(),
                "uv_lock_sha256": hashlib.sha256((source_root / "uv.lock").read_bytes()).hexdigest(),
                "benchmark_sha256": script_digest,
                "environment": {"python": sys.version, "platform": platform.platform(),
                    "python_executable_sha256": hashlib.sha256(Path(sys.executable).read_bytes()).hexdigest(),
                    "dependencies": {name: version(name) for name in ("httpx", "fastapi", "pillow", "pydantic")}},
                "network": "blocked; MockTransport only", "provider_latency_and_cache": "not measured",
                "cache_definition": {"cold": "encoding cache cleared before every sample",
                    "warm": "encoding cache primed before sampling", "filesystem_cache": "not flushed"},
                "timing": "elapsed_ms is uninstrumented; counters are collected in a separate restored call with the same cache temperature",
                "repeats": repeats, "scenarios": [scenario(Path(temporary) / name, name, checkpoints,
                    repeats, experimental, modules) for name in scenarios],
                "semantic_probes": probes}
        if identity != source_fingerprint(source_root) or script_digest != hashlib.sha256(Path(__file__).read_bytes()).hexdigest():
            raise RuntimeError("Source or benchmark changed during measurement; rerun against a stable checkout")
        return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--rounds", type=int, nargs="+", default=[5, 25, 50, 100])
    parser.add_argument("--repeats", type=int, default=5)
    parser.add_argument("--scenarios", choices=["text", "repeated_image", "unique_images"], nargs="+",
                        default=["text", "repeated_image", "unique_images"])
    parser.add_argument("--experimental-deduplication", action="store_true")
    parser.add_argument("--skip-probes", action="store_true", help="Omit mask, sibling-branch and tool-pair probes")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if not 1 <= args.repeats <= 10 or any(not 1 <= n <= 100 for n in args.rounds):
        parser.error("Use 1..100 rounds and 1..10 repeats")
    report = run(args.source_root, checkpoints=tuple(sorted(set(args.rounds))), repeats=args.repeats,
                 scenarios=args.scenarios, experimental=args.experimental_deduplication, include_probes=not args.skip_probes)
    result = json.dumps(report, ensure_ascii=False, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(result + "\n", encoding="utf-8")
        print(f"Wrote aggregate benchmark report: {args.output}")
    else:
        print(result)


if __name__ == "__main__":
    main()
