"""Check offline diagnostic measurements, not provider latency/cache efficacy."""
import json
import hashlib
import os
from pathlib import Path
import socket
import sqlite3

import httpx
import pytest

from scripts import diagnose_agent_context as diagnostic
from scripts import diagnose_agent_result_snapshots as result_diagnostic


@pytest.fixture(scope="module")
def small_baseline():
    return diagnostic.run(checkpoints=(1, 3), repeats=1)


@pytest.mark.parametrize("fails", [False, True])
def test_measure_closes_connections_even_when_callback_fails(fails):
    # Retain a strong reference so collection cannot hide a leaked SQLite handle.
    connections = []
    original_connect = sqlite3.connect

    def callback():
        conn = sqlite3.connect(":memory:")
        connections.append(conn)
        with conn:
            value = conn.execute("SELECT 42").fetchone()[0]
        if fails:
            raise ValueError("measured operation failed")
        return value

    if fails:
        with pytest.raises(ValueError, match="measured operation failed"):
            diagnostic.measure(callback, 1)
    else:
        value, cost = diagnostic.measure(callback, 1)
        assert value == 42
        assert cost["connections"] == cost["statements"] == cost["selects"] == 1
    assert sqlite3.connect is original_connect
    assert len(connections) == 1
    with pytest.raises(sqlite3.ProgrammingError, match="closed"):
        connections[0].execute("SELECT 1")


def test_real_context_and_snapshot_grow_without_claiming_provider_cache(small_baseline):
    assert small_baseline["provider_cache"] == "not measured"
    assert small_baseline["network"] == "blocked; MockTransport only"
    for scenario in small_baseline["scenarios"]:
        first, third = scenario["rows"]
        assert [first["rounds"], third["rounds"]] == [1, 3]
        # Both foundations stay in instructions; history remains the five
        # real conversation items without a synthetic leading guidance message.
        assert [first["input_items"], third["input_items"]] == [1, 5]
        for field in ("request_json_bytes", "snapshot_json_bytes", "stored_history_json_bytes_all_requests"):
            assert third[field] > first[field] > 0
        for row in (first, third):
            for operation in ("request_read", "context_including_request_and_refs", "snapshot"):
                cost = row[operation]
                assert cost["connections"] > 0
                assert cost["statements"] >= cost["selects"] > 0
                assert cost["min_ms"] <= cost["median_ms"] <= cost["max_ms"]
            assert row["build_input_only"]["median_ms"] >= 0
        comparison, = scenario["prefix_comparisons"]
        assert comparison["equal_leading_input_items"] == first["input_items"]
        assert comparison["instructions_equal"] and comparison["tools_equal"]


def test_image_payload_counts_actual_repeated_bytes(small_baseline):
    text, images = small_baseline["scenarios"]
    assert all(row["attached_image_bytes"] == 0 for row in text["rows"])
    first, third = images["rows"]
    assert [first["image_occurrences"], third["image_occurrences"]] == [1, 3]
    assert third["attached_image_bytes"] == 3 * first["attached_image_bytes"] > 0
    assert third["historical_image_bytes"] == 2 * first["attached_image_bytes"]
    assert third["image_base64_bytes"] == 3 * first["image_base64_bytes"]
    assert third["request_json_bytes"] > third["image_base64_bytes"] > third["attached_image_bytes"]
    assert third["context_including_request_and_refs"]["connections"] > first["context_including_request_and_refs"]["connections"]
    probes = {p["intent"]: p for p in third["reference_scope_probes"]}
    assert probes["new_image_with_implicit_history"]["image_occurrences"] == 3
    # The explicitly selected ancestor and the newly attached current image
    # retain their distinct roles; a greeting needs only the current attachment.
    assert probes["exact_reference_only"]["image_occurrences"] == 2
    assert probes["greeting"]["image_occurrences"] == 1


def test_tool_followups_preserve_history_and_measure_skill_repetition(small_baseline):
    for scenario in small_baseline["scenarios"]:
        last = scenario["rows"][-1]
        followups = scenario["tool_followups"]
        assert [row["simulated_image_jobs_used"] for row in followups] == [0, 1, 2]
        for row in followups:
            # An overview tool receipt points to the existing instructions body;
            # all original conversation items and their order remain exact.
            assert row["repeated_leading_input_items"] == last["input_items"]
            assert row["unchanged_input_item_occurrences"] == last["input_items"]
            assert row["input_items"] == last["input_items"] + 2
            assert row["skill_tool_output_bytes"] > 0
            assert row["attached_image_bytes"] == last["attached_image_bytes"]
        assert followups[0]["same_tools_as_first_call"]
        assert not followups[-1]["same_tools_as_first_call"]
        assert followups[-1]["tools_json_bytes"] < followups[0]["tools_json_bytes"]
        assert scenario["task_switch"]["instructions_equal"]
        assert followups[0]["same_instructions_as_first_call"]
        assert not followups[-1]["same_instructions_as_first_call"]  # Remaining quota metadata changed.


def test_isolation_restores_environment_blocks_network_and_keeps_cache_unknown(tmp_path, monkeypatch):
    sentinel = tmp_path / "existing-config.json"
    sentinel.write_text("must remain untouched", encoding="utf-8")
    variables = ["IMAGE_PROMPT_LIBRARY_" + suffix for suffix in diagnostic.CONFIG_SUFFIXES]
    variables.append("IMAGE_PROMPT_LIBRARY_PATH")
    for variable in variables:
        monkeypatch.setenv(variable, str(sentinel))
    isolated = tmp_path / "diagnostic"
    original_connect = socket.socket.connect
    with diagnostic.isolated_repository(isolated) as repo:
        assert repo.library == isolated / "library"
        for variable in variables:
            assert Path(os.environ[variable]).is_relative_to(isolated)
        with socket.socket() as client:
            with pytest.raises(AssertionError, match="must not access the network"):
                client.connect(("127.0.0.1", 1))
            with pytest.raises(AssertionError, match="must not access the network"):
                client.connect_ex(("127.0.0.1", 1))
        with httpx.Client(trust_env=False) as client:
            with pytest.raises(AssertionError, match="must not access the network"):
                client.get("http://127.0.0.1:1/")
        diagnostic.create_round(repo, 1, None)
        body, wire_bytes = diagnostic.capture(repo, "request-1")
        assert wire_bytes > 0 and body["model"] == "mock-model"
        details = repo.request("request-1")["round"]["responseDetails"]
        assert details["steps"][0]["usage"]["cachedInputTokens"] is None
        assert "synthetic-diagnostic-only" not in json.dumps(body)
    assert socket.socket.connect is original_connect
    assert all(os.environ[variable] == str(sentinel) for variable in variables)
    assert sentinel.read_text(encoding="utf-8") == "must remain untouched"


def test_output_snapshot_counts_actual_frozen_original_copies():
    result = result_diagnostic.run(checkpoints=(1, 3), repeats=1)
    assert result["network"] == "blocked; no provider or queue dispatch"
    assert result["provider_cache"] == "not measured"
    for row in result["rows"]:
        n = row["rounds"]
        copies = n - 1
        assert row["completed_output_jobs"] == row["result_original_files"] == n
        assert row["agent_asset_rows"] == row["frozen_original_files"] == copies
        assert row["distinct_frozen_image_hashes"] == n - 1
        assert row["frozen_original_file_bytes"] == copies * row["synthetic_png_bytes_per_result"]
        assert row["distinct_physical_image_hashes"] == copies
        assert row["duplicate_physical_image_files"] == 0
        assert row["unreferenced_agent_files"] == row["missing_agent_asset_files"] == 0
        assert row["cumulative_new_frozen_original_files"] == copies
        assert row["new_frozen_original_files_this_round"] == (1 if n > 1 else 0)
        assert row["request_replay_new_files"] == 0
        assert row["image_occurrences"] == copies
        assert row["attached_image_bytes"] == copies * row["synthetic_png_bytes_per_result"]
        assert row["request_json_bytes"] > row["image_base64_bytes"]
        assert row["result_original_file_bytes"] == n * row["synthetic_png_bytes_per_result"]
        for operation in ("create_round_once", "snapshot", "request_replay"):
            cost = row[operation]
            assert cost["connections"] > 0
            assert cost["statements"] >= cost["selects"] > 0


def test_inventory_counts_nested_files_duplicate_bytes_and_unreferenced_files(tmp_path):
    with diagnostic.isolated_repository(tmp_path / "isolated") as repo:
        original = result_diagnostic.synthetic_png(42)
        asset = repo.store_asset(original, None)
        path = repo.library / repo.asset(asset["id"])["path"]
        duplicate = path.parent / "nested" / "deep" / "unreferenced.png"
        duplicate.parent.mkdir(parents=True)
        duplicate.write_bytes(original)
        inventory, paths = diagnostic.asset_inventory(repo)
        assert inventory["agent_asset_rows"] == 1
        assert inventory["frozen_original_files"] == len(paths) == 2
        assert inventory["distinct_frozen_image_hashes"] == 1
        assert inventory["distinct_physical_image_hashes"] == 1
        assert inventory["duplicate_physical_image_files"] == 1
        assert inventory["unreferenced_agent_files"] == 1
        assert inventory["frozen_original_file_bytes"] == 2 * len(original)
        assert repo.asset(asset["id"])["sha256"] == hashlib.sha256(original).hexdigest()
        path.unlink()
        inventory, paths = diagnostic.asset_inventory(repo)
        assert inventory["frozen_original_files"] == 1
        assert inventory["missing_agent_asset_files"] == 1
