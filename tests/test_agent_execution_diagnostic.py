"""Exercise the offline diagnostic through real Agent and queue persistence."""
import json

import pytest

from scripts import diagnose_agent_execution as diagnostic


@pytest.fixture(scope="module")
def baseline():
    return diagnostic.run(checkpoints=(1, 2), repeats=1)


def test_real_queue_results_and_stage_measurements(baseline):
    assert baseline["provider_calls"] == {"responses": 4, "images": 2}
    assert baseline["mutating_execution_repeats"] == 1
    first, second = baseline["rows"]
    for row in (first, second):
        assert row["provider_calls_this_round"] == {"responses": 2, "images": 1}
        execution, image = row["execution"], row["image_execution"]
        assert execution["phase"] == image["phase"] == "completed"
        assert len(execution["modelSteps"]) == 2
        for step in execution["modelSteps"]:
            assert step["state"] == "completed"
            assert 0 <= step["headersMs"] <= step["firstEventMs"] <= step["responseMs"]
        assert all(value is not None and value >= 0 for value in execution["timings"].values())
        assert all(value is not None and value >= 0 for value in image["timings"].values())
        for name in ("create_round_once", "request_read", "context_including_request_and_refs", "run_request_once", "snapshot"):
            measured = row[name]
            assert measured["connections"] > 0
            assert measured["statements"] >= measured["selects"] > 0
            assert measured["min_ms"] <= measured["median_ms"] <= measured["max_ms"]
    assert second["request_json_bytes"] > first["request_json_bytes"]
    assert second["snapshot_json_bytes"] > first["snapshot_json_bytes"]


def test_usage_missing_is_not_reported_zero_or_real_cache_evidence(baseline):
    first, second = baseline["rows"]
    assert baseline["provider_cache"] == "not measured"
    assert baseline["synthetic_cached_token_reports"] == {"missing": 2, "reported_zero": 2}
    assert all(step["usage"]["cachedInputTokens"] is None for step in first["reported_usage_steps"])
    assert all(step["usage"]["cachedInputTokens"] == 0 for step in second["reported_usage_steps"])
    assert all(step["usage"]["reasoningTokens"] is None for row in baseline["rows"] for step in row["reported_usage_steps"])
    assert "synthetic" in first["usage_source"]
    assert baseline["simulated_provider_delays_ms"] == diagnostic.DEFAULT_DELAYS_MS


def test_image_and_skill_bytes_prefixes_are_measured_without_dropping_history(baseline):
    first, second = baseline["rows"]
    for row in (first, second):
        n = row["rounds"]
        assert row["image_occurrences"] == n
        assert row["attached_image_bytes"] == n * first["attached_image_bytes"]
        assert row["frozen_original_files"] == row["agent_asset_rows"] == n + 1
        assert row["duplicate_physical_image_files"] == row["missing_agent_asset_files"] == 0
        assert row["unreferenced_agent_files"] == 0
        followup = row["tool_followup"]
        assert followup["image_occurrences"] == n + 1
        if n == 1:
            # The first preload moves from instructions into durable guidance
            # on the next call. Report that prefix change rather than hiding it.
            assert followup["equal_leading_input_items"] == 0
            assert not followup["instructions_equal"]
        else:
            assert followup["equal_leading_input_items"] == row["input_items"]
            assert followup["instructions_equal"]
        # Exhausting image authorization intentionally removes image tools.
        assert not followup["tools_equal"]
        assert followup["tools_json_bytes"] < row["tools_json_bytes"]
        assert set(row["skills"]["selected_sections"]) == {"gpt-image/overview", "gpt-image/editing"}
        assert row["skills"]["selected_section_utf8_bytes"] > 0
    comparison, = baseline["prefix_comparisons"]
    assert not comparison["instructions_equal"] and comparison["tools_equal"]
    assert comparison["equal_leading_input_items"] == 0
    assert first["skills"]["section_occurrences_in_instructions"] == 2
    assert second["skills"]["section_occurrences_in_instructions"] == 0
    assert second["skills"]["section_occurrences_in_input"] == 2
    # Do not leak the fake key, local filesystem, raw prompts or images into stdout.
    report = json.dumps(baseline)
    assert "synthetic-diagnostic-only" not in report and "base64," not in report
    assert "Synthetic geometry with soft blue lighting" not in report
