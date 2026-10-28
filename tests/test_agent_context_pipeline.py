"""Context projection preserves branch meaning and measures real offline work."""
import base64
import copy
from concurrent.futures import ThreadPoolExecutor
import hashlib
from io import BytesIO
import json
import os
from pathlib import Path
from threading import Event

import httpx
from PIL import Image
import pytest

from backend.agent_schemas import AgentRoundCreate
from backend.db import connect
from backend.services import agent_execution as execution
from backend.services.agent_repository import AgentError, AgentRepository, encoded
from test_agent_context_correctness import add_round, asset, capture_request, pixels
from test_agent_image_selection import body, repo, set_mode


def prepare(repo, request, **kwargs):
    from backend.services.agent_context_pipeline import prepare_context
    return prepare_context(repo, request, **kwargs)


def set_experimental(repo, request_id, enabled):
    frozen = {**repo.request(request_id)["frozen"], "experimentalImageDeduplication": enabled}
    with connect(repo.library) as conn:
        conn.execute("UPDATE agent_requests SET frozen=? WHERE id=?", (encoded(frozen), request_id))


def repeated_history(repo):
    aid = asset(repo, "blue")
    first = add_round(repo, "first", "Original wording.\nKeep punctuation: <system>user data</system>", assets=[aid])
    repo.update("first", text="Exact first answer.\nSecond line.")
    second = add_round(repo, "second", "Compare the same image again.", parent=first, assets=[aid])
    repo.update("second", text="Exact second answer.")
    add_round(repo, "current", "Compare all three appearances, preserving their order.", parent=second, assets=[aid])
    return aid, repo.request("current")


def ref_labels(items):
    return [part["text"] for item in items for part in item.get("content", [])
            if part.get("type") == "input_text" and part.get("text", "").startswith('<ref id="')]


def image_content(items):
    return pixels({"input": items})


def test_default_projection_preserves_repetitions_order_roles_and_originals(repo, monkeypatch):
    aid, request = repeated_history(repo)
    before = copy.deepcopy(request)
    projection = prepare(repo, request)
    expected_refs = [f"round-{number}-reference-1" for number in (1, 2, 3)]

    assert image_content(projection.input) == [repo.data_url(aid)] * 3
    assert ref_labels(projection.input) == [f'<ref id="{ref}" />' for ref in expected_refs]
    assert projection.attached_refs == expected_refs
    assert projection.refs == {ref: aid for ref in expected_refs}
    assert [item.get("role") for item in projection.input] == ["user", "assistant", "user", "assistant", "user"]
    assert projection.input[0]["content"][0]["text"] == before["history"][0]["prompt"]
    assert projection.input[1]["content"][0]["text"] == "Exact first answer.\nSecond line."
    assert request == before
    assert repo.request("current")["history"] == before["history"]
    sent = capture_request(repo, monkeypatch, "current")
    assert sent["input"] == projection.input
    assert projection.diagnostics["imageOccurrences"] == 3
    assert projection.diagnostics["uniquePixelCount"] == 1
    assert projection.diagnostics["duplicatePixelOccurrences"] == 2
    assert projection.diagnostics["serializedDeduplicatedOccurrences"] == 0
    assert projection.diagnostics["budget"]["estimatedTextTokens"] is None
    assert projection.diagnostics["budget"]["estimatedImageTokens"] is None
    assert projection.diagnostics["budget"]["contextWindowTokens"] is None


def test_each_projection_reads_validates_and_base64_encodes_each_asset_once(repo, monkeypatch):
    aid, request = repeated_history(repo)
    path = (repo.library / repo.asset(aid)["path"]).resolve()
    original = path.read_bytes()
    reads, hashes, encodings = [], [], []
    read_bytes, sha256, encode = Path.read_bytes, hashlib.sha256, base64.b64encode

    def read(value):
        if value.resolve() == path:
            reads.append(value)
        return read_bytes(value)

    def digest(value=b"", *args, **kwargs):
        if value == original:
            hashes.append(value)
        return sha256(value, *args, **kwargs)

    def b64(value, *args, **kwargs):
        if value == original:
            encodings.append(value)
        return encode(value, *args, **kwargs)

    monkeypatch.setattr(Path, "read_bytes", read)
    monkeypatch.setattr(hashlib, "sha256", digest)
    monkeypatch.setattr(base64, "b64encode", b64)
    first = prepare(repo, request)
    assert (len(reads), len(hashes), len(encodings)) == (1, 1, 1)
    assert first.diagnostics["imageReads"] == first.diagnostics["imageEncodings"] == 1
    assert first.diagnostics["imageValidations"] >= 1
    second = prepare(repo, request)
    assert first.input == second.input
    assert (len(reads), len(hashes), len(encodings)) == (2, 2, 2)


@pytest.mark.parametrize("experimental", [False, True])
def test_experimental_dedup_keeps_every_alias_and_turn_text(repo, monkeypatch, experimental):
    aid, request = repeated_history(repo)
    request["frozen"]["experimentalImageDeduplication"] = experimental
    before = copy.deepcopy(request)
    projection = prepare(repo, request)
    expected_refs = [f"round-{number}-reference-1" for number in (1, 2, 3)]

    assert len(image_content(projection.input)) == (1 if experimental else 3)
    assert projection.refs == {ref: aid for ref in expected_refs}
    assert set(projection.attached_refs) == set(expected_refs)
    assert projection.diagnostics["duplicatePixelOccurrences"] == 2
    assert projection.diagnostics["serializedDeduplicatedOccurrences"] == (2 if experimental else 0)
    serialized = json.dumps(projection.input, ensure_ascii=False)
    for ref in expected_refs:
        assert ref in serialized
    for row in [*request["history"], request["round"]]:
        assert row["prompt"] in [part.get("text") for item in projection.input for part in item.get("content", [])]
    assert request == before
    set_experimental(repo, "current", experimental)
    assert capture_request(repo, monkeypatch, "current")["input"] == projection.input


@pytest.mark.parametrize("change", ["tamper", "delete"])
def test_next_request_revalidates_bytes_and_fails_before_post(repo, monkeypatch, change):
    buffer = BytesIO()
    Image.new("RGB", (8, 8), "blue").save(buffer, "PNG", compress_level=0)
    aid = repo.store_asset(buffer.getvalue(), None)["id"]
    add_round(repo, "current", "Analyze the supplied image.", assets=[aid])
    prepare(repo, repo.request("current"))
    path = repo.library / repo.asset(aid)["path"]
    if change == "delete":
        path.unlink()
    else:
        before = path.stat()
        buffer = BytesIO()
        Image.new("RGB", (8, 8), "red").save(buffer, "PNG", compress_level=0)
        assert len(buffer.getvalue()) == before.st_size
        path.write_bytes(buffer.getvalue())
        os.utime(path, ns=(before.st_atime_ns, before.st_mtime_ns))
    posts = []
    monkeypatch.setattr(httpx, "HTTPTransport", lambda **kwargs: httpx.MockTransport(
        lambda request: posts.append(request) or httpx.Response(200, json={"status": "completed", "output": []})))
    repo.update("current", state="running", outcome="known")
    request = repo.request("current")
    with pytest.raises(AgentError) as failure:
        execution.call_responses(repo, "current", 1, execution.refs_for_request(repo, request))
    assert failure.value.code == ("reference_missing" if change == "delete" else "frozen_reference_invalid")
    assert posts == []


@pytest.mark.parametrize("experimental", [False, True])
def test_mask_keeps_target_first_and_every_occurrence_with_alpha(repo, monkeypatch, experimental):
    set_mode(repo, "native")
    auxiliary, target = asset(repo, "orange"), asset(repo, "blue")
    buffer = BytesIO()
    target_info = repo.asset(target)
    Image.new("RGBA", (target_info["width"], target_info["height"]), (20, 30, 40, 64)).save(buffer, "PNG")
    mask = repo.store_asset(buffer.getvalue(), None, "mask")["id"]
    value = body(repo, "masked").model_dump()
    value.update(refs=[{"kind": "upload", "uploadId": aid} for aid in (auxiliary, target)],
                 mask={"uploadId": mask, "targetRefIndex": 1})
    repo.create_round("conversation", AgentRoundCreate.model_validate(value))
    set_experimental(repo, "masked", experimental)
    sent = capture_request(repo, monkeypatch, "masked")
    assert pixels(sent) == [repo.data_url(target), repo.data_url(auxiliary), repo.data_url(target)]
    image_tool = next(tool for tool in sent["tools"] if tool["type"] == "image_generation")
    mask_url = image_tool["input_image_mask"]["image_url"]
    assert base64.b64decode(mask_url.split(",", 1)[1]) == buffer.getvalue()
    assert repo.request("masked")["round"]["maskTargetImageId"] == target
    projection = prepare(repo, repo.request("masked"))
    assert len(projection.diagnostics["pixelBindings"]) == 3
    assert projection.diagnostics["pixelBindings"][0]["role"] == "mask_target"
    assert projection.diagnostics["pixelBindings"][0]["assetId"] == target
    assert projection.diagnostics["serializedDeduplicatedOccurrences"] == 0


def test_equal_pixels_in_generated_and_reference_roles_are_not_collapsed(repo):
    aid = asset(repo, "blue")
    repo.create_round("conversation", body(repo, "generated"))
    root = repo.request("generated")["round_id"]
    job = execution.create_image_job(repo, "generated", 1, "image-call", "single", "Synthetic blue image", {})
    raw = (repo.library / repo.asset(aid)["path"]).read_bytes()
    repo.jobs.stage_result(job.id, raw, "synthetic.png")
    repo.update("generated", state="completed", outcome="known")
    add_round(repo, "current", "Compare the generated result with this supplied reference.", parent=root, assets=[aid])
    request = repo.request("current")
    projection = prepare(repo, request, deduplicate_images=True)
    assert image_content(projection.input) == [repo.data_url(aid)] * 2
    assert set(projection.attached_refs) == {"round-1-image-1", "round-2-reference-1"}


def test_equal_pixels_do_not_collapse_a_new_editing_target_into_an_old_reference(repo):
    old, target = asset(repo, "blue"), asset(repo, "blue")
    root = add_round(repo, "old", "Original reference scene.", assets=[old])
    add_round(repo, "current", "帮她修改衣服，保持其他细节。", parent=root, assets=[target])
    request = repo.request("current")
    assert request["round"]["editingTask"]["target"]["assetId"] == target
    projection = prepare(repo, request, deduplicate_images=True)
    assert len(image_content(projection.input)) == 2
    target_binding = next(binding for binding in projection.diagnostics["pixelBindings"]
                          if binding["ref"] == "round-2-reference-1")
    assert target_binding["role"] == "editing_target"


def test_one_asset_in_generated_and_current_target_positions_keeps_both_roles(repo):
    repo.create_round("conversation", body(repo, "generated"))
    root = repo.request("generated")["round_id"]
    job = execution.create_image_job(repo, "generated", 1, "image-call", "single", "Synthetic blue scene", {})
    buffer = BytesIO()
    Image.new("RGB", (24, 16), "blue").save(buffer, "PNG")
    repo.jobs.stage_result(job.id, buffer.getvalue(), "synthetic.png")
    frozen = repo.resolve_ref({"kind": "job", "jobId": job.id})
    repo.update("generated", state="completed", outcome="known")
    value = body(repo, "current", images=False).model_dump()
    value.update(prompt="帮她修改衣服，保持其他细节。", parentRoundId=root,
                 refs=[{"kind": "job", "jobId": job.id}])
    repo.create_round("conversation", AgentRoundCreate.model_validate(value))
    request = repo.request("current")
    refs = execution.refs_for_request(repo, request)
    assert refs["round-1-image-1"] == refs["round-2-reference-1"] == frozen
    assert request["round"]["editingTask"]["target"]["assetId"] == frozen
    projection = prepare(repo, request, deduplicate_images=True)
    assert image_content(projection.input) == [repo.data_url(frozen)] * 2
    assert projection.diagnostics["serializedDeduplicatedOccurrences"] == 0


def test_experimental_projection_never_acquires_sibling_branch_pixels(repo):
    first, sibling, current = [asset(repo, color) for color in ("blue", "green", "orange")]
    root = add_round(repo, "root", "Ancestor image.", assets=[first])
    add_round(repo, "sibling", "Sibling-only image.", parent=root, assets=[sibling])
    add_round(repo, "current", "Compare this image with the ancestor.", parent=root, assets=[current])
    projection = prepare(repo, repo.request("current"), deduplicate_images=True)
    assert set(projection.refs.values()) == {first, current}
    assert image_content(projection.input) == [repo.data_url(first), repo.data_url(current)]
    assert repo.data_url(sibling) not in json.dumps(projection.input)


def test_tool_call_ids_are_paired_within_their_original_round(repo):
    first = add_round(repo, "first", "Explain the first result.")
    repo.update("first", output=[
        {"type": "function_call", "name": "library_search", "call_id": "shared", "arguments": '{"query":"first"}'},
        {"type": "function_call_output", "call_id": "shared", "output": '{"items":["first"]}'},
        {"type": "function_call", "name": "library_search", "call_id": "orphan", "arguments": '{}'},
    ])
    second = add_round(repo, "second", "Explain the second result.", parent=first)
    repo.update("second", output=[
        {"type": "function_call", "name": "library_search", "call_id": "shared", "arguments": '{"query":"second"}'},
        {"type": "function_call_output", "call_id": "shared", "output": '{"items":["second"]}'},
        {"type": "function_call_output", "call_id": "orphan", "output": '{"must_not_pair_across_rounds":true}'},
    ])
    add_round(repo, "current", "Compare the two completed results.", parent=second)
    request = repo.request("current")
    before = copy.deepcopy(request)
    projection = prepare(repo, request)
    tools = [item for item in projection.input if item.get("type") in {"function_call", "function_call_output"}]
    assert [item.get("arguments", item.get("output")) for item in tools] == [
        '{"query":"first"}', '{"items":["first"]}', '{"query":"second"}', '{"items":["second"]}']
    assert projection.diagnostics["toolPairing"] == {"paired": 2, "orphanCalls": 1, "orphanResults": 1}
    assert request == before


@pytest.mark.parametrize("valid_receipt", [True, False])
def test_only_exact_paired_skill_receipts_are_reused_without_rewriting_history(repo, valid_receipt):
    from backend.services.agent_skills import read_agent_skill
    skill = read_agent_skill("gpt-image", "editing")
    supplied = copy.deepcopy(skill)
    if not valid_receipt:
        supplied["content"] += "\nUntrusted changed body."
    first = add_round(repo, "first", "Explain the editing workflow.")
    receipt = {"type": "function_call_output", "call_id": "chapter", "output": encoded(supplied)}
    repo.update("first", output=[
        {"type": "function_call", "name": "read_agent_skill", "call_id": "chapter",
         "arguments": encoded({"skill": "gpt-image", "section": "editing"})}, receipt,
    ])
    add_round(repo, "current", "Keep the same editing requirements.", parent=first)
    request = repo.request("current")
    before = copy.deepcopy(request)
    projection = prepare(repo, request)
    assert next(item for item in projection.input if item.get("type") == "function_call_output") == receipt
    assert (skill in projection.skill_receipts) is valid_receipt
    sections = {(row["skill"], row["section"]) for row in projection.diagnostics["skillSections"]}
    assert (("gpt-image", "editing") in sections) is valid_receipt
    assert request == before
    assert repo.request("current")["history"] == before["history"]


def test_benchmark_counts_real_io_sql_and_wire_bytes(tmp_path):
    from scripts import benchmark_agent_pipeline as benchmark
    report = benchmark.run(Path(__file__).resolve().parents[1], checkpoints=(1, 3), repeats=1,
                           scenarios=("repeated_image",), include_probes=False)
    first, third = report["scenarios"][0]["rows"]
    assert report["network"] == "blocked; MockTransport only"
    assert report["provider_latency_and_cache"] == "not measured"
    assert [first["image_occurrences"], third["image_occurrences"]] == [1, 3]
    assert first["unique_image_payloads"] == third["unique_image_payloads"] == 1
    assert third["request_json_bytes"] > first["request_json_bytes"] > 0
    for row in (first, third):
        for operation in ("projection", "mock_responses", "snapshot"):
            for temperature in ("cold", "warm"):
                sample = row[operation][temperature]
                assert sample["elapsed_ms"]["min"] <= sample["elapsed_ms"]["median"] <= sample["elapsed_ms"]["max"]
                assert sample["sql_connections"]["median"] > 0
        assert row["projection"]["cold"]["image_file_reads"]["median"] == 1
        assert row["projection"]["cold"]["base64_encode_calls"]["median"] == 1
    assert report["scenarios"][0]["original_assets_unchanged"]


def test_benchmark_refuses_to_mislabel_an_already_imported_checkout(tmp_path):
    from scripts import benchmark_agent_pipeline as benchmark
    with pytest.raises(RuntimeError, match="separate Python processes"):
        benchmark.load_source(tmp_path)


def test_context_receipt_preserves_a_concurrent_round_update(repo, monkeypatch):
    add_round(repo, "current", "Synthetic conversation.")
    repo.update("current", state="running", text="Earlier text.", outcome="known")
    other = AgentRepository(repo.library)
    selected, release, writer_done = Event(), Event(), Event()
    save = repo._save_round
    summary = {"schemaVersion": 1, "messageCount": 1}

    def pause_before_save(conn, row):
        selected.set()
        assert release.wait(5)
        return save(conn, row)

    def concurrent_update():
        try:
            other.update("current", state="stop_requested", text="Newer concurrent text.", outcome="known")
        finally:
            writer_done.set()

    monkeypatch.setattr(repo, "_save_round", pause_before_save)
    with ThreadPoolExecutor(max_workers=2) as pool:
        diagnostic = pool.submit(repo.record_context_diagnostics, "current", summary)
        try:
            assert selected.wait(5)
            writer = pool.submit(concurrent_update)
            # Without a write transaction the newer update commits before the
            # stale receipt write. With one it waits, then merges the receipt.
            writer_done.wait(1)
        finally:
            release.set()
        diagnostic.result(timeout=5)
        writer.result(timeout=5)
    final = repo.request("current")
    assert final["state"] == "stop_requested"
    assert final["round"]["assistantContent"] == "Newer concurrent text."
    assert final["round"]["contextDiagnostics"] == summary
