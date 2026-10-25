"""Immutable Agent snapshots, using only synthetic images and isolated libraries."""
import hashlib
import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import httpx
import pytest

from backend.agent_schemas import AgentRoundCreate
from backend.db import connect
from backend.services import agent_execution as execution
from backend.services import agent_repository as repository
from backend.services.agent_repository import AgentError, encoded
from test_agent_image_selection import repo, body, set_mode
from test_agent_workspaces import image_bytes


def add_round(repo, name, parent=None, *, prompt="Keep the previous lighting.", refs=()):
    value = body(repo, name).model_dump()
    value.update(parentRoundId=parent, prompt=prompt, refs=list(refs))
    payload = AgentRoundCreate.model_validate(value)
    repo.create_round("conversation", payload)
    return repo.request(name), payload


def completed_output(repo, name, parent=None, color="blue"):
    request, _ = add_round(repo, name, parent)
    job = execution.create_image_job(repo, name, 1, "output", "single", "Synthetic image", {})
    repo.jobs.stage_result(job.id, image_bytes(color), "fixture.png")
    repo.update(name, state="completed", outcome="known")
    return request["round_id"], job.id


def counts(repo):
    with connect(repo.library) as conn:
        rows = conn.execute("SELECT count(*) FROM agent_assets").fetchone()[0]
    files = [path for path in (repo.library / "generation-references" / "agent").rglob("*") if path.is_file()]
    return rows, len(files)


def test_history_freezes_each_source_once_and_replay_creates_nothing(repo):
    parent = None
    for n in range(1, 6):
        parent, _ = completed_output(repo, f"r{n}", parent, color=(n * 30, 20, 100))
    assert counts(repo) == (4, 4)
    request, payload = add_round(repo, "r6", parent)
    frozen = request["history"][0]["frozenOutputImages"][0]
    before = counts(repo)
    replay, created = repo.create_round("conversation", payload)
    assert not created and replay["request"]["id"] == "r6"
    assert counts(repo) == before == (5, 5)
    assert repo.request("r5")["history"][0]["frozenOutputImages"][0] == frozen


def test_new_round_keeps_frozen_output_after_gallery_cleanup(repo):
    root, job = completed_output(repo, "root")
    child, _ = add_round(repo, "child", root)
    frozen = child["history"][0]["frozenOutputImages"][0]
    repo.update("child", state="completed", outcome="known")
    repo.jobs.discard_job(job)
    next_request, _ = add_round(repo, "next", child["round_id"], prompt="Use @第1轮图1.")
    assert next_request["history"][0]["frozenOutputImages"] == [frozen]
    refs = execution.refs_for_request(repo, next_request)
    outgoing = execution.build_input(repo, next_request, refs)
    assert repo.data_url(frozen) in json.dumps(outgoing)
    assert counts(repo) == (1, 1)


def test_identical_bytes_from_distinct_sources_keep_distinct_provenance(repo):
    root, first = completed_output(repo, "first")
    _, second = completed_output(repo, "second", root)
    first_id = repo.resolve_ref({"kind": "job", "jobId": first})
    second_id = repo.resolve_ref({"kind": "job", "jobId": second})
    assert first_id != second_id
    assert repo.asset(first_id)["sha256"] == repo.asset(second_id)["sha256"]
    assert json.loads(repo.asset(first_id)["source"]) == {"kind": "job", "jobId": first}
    assert json.loads(repo.asset(second_id)["source"]) == {"kind": "job", "jobId": second}
    assert counts(repo) == (2, 2)


def test_partial_preview_is_never_adopted_as_final_frozen_output(repo):
    _, job = completed_output(repo, "root", color="blue")
    source = {"kind": "job", "jobId": job}
    preview = repo.store_asset(image_bytes("red"), source)["id"]
    frozen = repo.resolve_ref(source)
    assert preview != frozen
    assert (repo.library / repo.asset(frozen)["path"]).read_bytes() == image_bytes("blue")


def test_first_freeze_is_independent_and_source_changes_never_overwrite_it(repo):
    _, job_id = completed_output(repo, "root")
    job = repo.jobs.get_job(job_id)
    source = {"kind": "job", "jobId": job_id}
    frozen = repo.resolve_ref(source)
    original = repo.library / job.result_path
    snapshot = repo.library / repo.asset(frozen)["path"]
    assert original.resolve() != snapshot.resolve()
    original.write_bytes(image_bytes("red"))
    assert repo.resolve_ref(source) == frozen
    assert snapshot.read_bytes() == image_bytes("blue")


@pytest.mark.parametrize("damage", ["missing", "changed"])
def test_established_snapshot_damage_is_explicit_not_replaced_by_live_source(repo, damage):
    root, job = completed_output(repo, "root")
    frozen = repo.resolve_ref({"kind": "job", "jobId": job})
    path = repo.library / repo.asset(frozen)["path"]
    if damage == "missing":
        path.unlink()
    else:
        path.write_bytes(image_bytes("red"))
    with pytest.raises(AgentError, match="已冻结") as failure:
        add_round(repo, "child", root)
    assert failure.value.code == "frozen_reference_invalid"
    with connect(repo.library) as conn:
        assert conn.execute("SELECT count(*) FROM agent_requests WHERE id='child'").fetchone()[0] == 0


def test_source_deleted_before_any_freeze_reports_missing_without_creating_asset(repo):
    root, job = completed_output(repo, "root")
    repo.jobs.discard_job(job)
    with pytest.raises(AgentError) as failure:
        add_round(repo, "child", root, prompt="Use @第1轮图1.")
    assert failure.value.code == "reference_missing"
    assert counts(repo) == (0, 0)


def test_concurrent_first_freeze_uses_one_complete_file_and_one_asset(repo):
    _, job = completed_output(repo, "root")
    source = {"kind": "job", "jobId": job}
    barrier = Barrier(5)

    def freeze(_):
        local = repository.AgentRepository(repo.library)
        barrier.wait(timeout=10)
        return local.resolve_ref(source)

    with ThreadPoolExecutor(max_workers=5) as pool:
        ids = list(pool.map(freeze, range(5)))
    assert len(set(ids)) == 1
    assert counts(repo) == (1, 1)
    assert (repo.library / repo.asset(ids[0])["path"]).read_bytes() == image_bytes("blue")


def test_database_failure_rolls_back_identity_and_retry_reuses_deterministic_file(repo):
    _, job = completed_output(repo, "root")
    source = {"kind": "job", "jobId": job}
    with connect(repo.library) as conn:
        conn.execute("CREATE TRIGGER reject_freeze BEFORE INSERT ON agent_frozen_sources BEGIN SELECT RAISE(ABORT,'synthetic failure'); END")
    with pytest.raises(sqlite3.IntegrityError, match="synthetic failure"):
        repo.resolve_ref(source)
    assert counts(repo) == (0, 1)
    before = set((repo.library / "generation-references" / "agent").rglob("*"))
    with connect(repo.library) as conn:
        assert conn.execute("SELECT count(*) FROM agent_frozen_sources").fetchone()[0] == 0
        conn.execute("DROP TRIGGER reject_freeze")
    frozen = repo.resolve_ref(source)
    assert counts(repo) == (1, 1)
    assert set((repo.library / "generation-references" / "agent").rglob("*")) == before
    assert hashlib.sha256((repo.library / repo.asset(frozen)["path"]).read_bytes()).hexdigest() == repo.asset(frozen)["sha256"]


def test_interruption_after_atomic_file_write_has_no_visible_mapping_and_safe_retry(repo, monkeypatch):
    _, job = completed_output(repo, "root")
    source = {"kind": "job", "jobId": job}
    write = repository._atomic_write_bytes

    def interrupt(path, data):
        write(path, data)
        raise RuntimeError("synthetic write interruption")

    with monkeypatch.context() as patch:
        patch.setattr(repository, "_atomic_write_bytes", interrupt)
        with pytest.raises(RuntimeError, match="synthetic write interruption"):
            repo.resolve_ref(source)
    assert counts(repo) == (0, 1)
    frozen = repo.resolve_ref(source)
    assert counts(repo) == (1, 1)
    assert repo.resolve_ref(source) == frozen


def test_write_interruption_then_source_deletion_fails_without_adopting_uncommitted_file(repo, monkeypatch):
    _, job = completed_output(repo, "root")
    source = {"kind": "job", "jobId": job}
    write = repository._atomic_write_bytes

    def interrupt(path, data):
        write(path, data)
        raise RuntimeError("synthetic interruption")

    with monkeypatch.context() as patch:
        patch.setattr(repository, "_atomic_write_bytes", interrupt)
        with pytest.raises(RuntimeError):
            repo.resolve_ref(source)
    repo.jobs.discard_job(job)
    with pytest.raises(AgentError) as failure:
        repo.resolve_ref(source)
    assert failure.value.code == "reference_missing"
    assert counts(repo) == (0, 1)


def legacy_child(repo, root, monkeypatch):
    def old_freeze(ref, legacy_asset_id=None):
        job = repo.jobs.get_job(ref["jobId"])
        return repo.store_asset((repo.library / job.result_path).read_bytes(), ref)["id"]

    with monkeypatch.context() as patch:
        patch.setattr(repo, "_freeze_source", old_freeze)
        child, _ = add_round(repo, "legacy", root)
    repo.update("legacy", state="completed", outcome="known")
    return child


def test_legacy_parent_snapshot_is_lazily_adopted_without_rewriting_history(repo, monkeypatch):
    root, job = completed_output(repo, "root")
    preview = repo.store_asset(image_bytes("red"), {"kind": "job", "jobId": job})["id"]
    child = legacy_child(repo, root, monkeypatch)
    legacy = child["history"][0]["frozenOutputImages"][0]
    repo.jobs.discard_job(job)
    before = counts(repo)
    next_request, _ = add_round(repo, "next", child["round_id"], prompt="Use @第1轮图1.")
    assert next_request["history"][0]["frozenOutputImages"] == [legacy]
    assert legacy != preview
    assert counts(repo) == before == (2, 2)
    assert repo.request("legacy")["history"] == child["history"]
    with connect(repo.library) as conn:
        assert conn.execute("SELECT asset_id FROM agent_frozen_sources").fetchone()[0] == legacy


def test_legacy_damaged_snapshot_is_not_replaced_with_a_preview_or_other_copy(repo, monkeypatch):
    root, job = completed_output(repo, "root")
    child = legacy_child(repo, root, monkeypatch)
    legacy = child["history"][0]["frozenOutputImages"][0]
    (repo.library / repo.asset(legacy)["path"]).unlink()
    repo.store_asset(image_bytes("red"), {"kind": "job", "jobId": job})
    with pytest.raises(AgentError) as failure:
        add_round(repo, "next", child["round_id"])
    assert failure.value.code == "frozen_reference_invalid"


def test_shared_ancestor_survives_sibling_delete_but_sibling_image_is_not_in_context(repo):
    root, root_job = completed_output(repo, "root")
    sibling, sibling_job = completed_output(repo, "sibling", root, "red")
    child, _ = add_round(repo, "child", root)
    ancestor = child["history"][0]["frozenOutputImages"][0]
    repo.update("child", state="completed", outcome="known")
    repo.delete("conversation", sibling)
    repo.jobs.discard_job(root_job)
    request, _ = add_round(repo, "next", child["round_id"])
    refs = execution.refs_for_request(repo, request)
    assert refs["round-1-image-1"] == ancestor
    assert all(json.loads(repo.asset(aid)["source"]).get("jobId") != sibling_job for aid in refs.values() if aid)
    assert repo.data_url(ancestor) in json.dumps(execution.build_input(repo, request, refs))


def test_uploads_and_masks_keep_their_original_ids_without_source_mapping(repo):
    image = repo.store_asset(image_bytes("blue"), None)["id"]
    mask = repo.store_asset(image_bytes((0, 0, 0, 0), mode="RGBA"), None, "mask")["id"]
    assert repo.resolve_ref({"kind": "upload", "uploadId": image}) == image
    assert repo.resolve_ref({"kind": "upload", "uploadId": mask}) == mask
    with connect(repo.library) as conn:
        assert conn.execute("SELECT count(*) FROM agent_frozen_sources").fetchone()[0] == 0
    assert counts(repo) == (2, 2)


def test_library_reference_can_be_reused_after_item_is_deleted(repo):
    _, job = completed_output(repo, "root")
    accepted = repo.jobs.accept_result_as_new_item(job)
    image = next(image for image in accepted.item.images if image.role != "reference_image")
    source = {"kind": "library", "imageId": image.id}
    first = repo.resolve_ref(source)
    repo.jobs.items.delete_item(accepted.item.id)
    assert repo.resolve_ref(source) == first
    assert (repo.library / repo.asset(first)["path"]).read_bytes() == image_bytes("blue")


def test_concurrent_identical_request_replay_freezes_only_once(repo, monkeypatch):
    root, _ = completed_output(repo, "root")
    value = body(repo, "concurrent").model_dump()
    value.update(parentRoundId=root)
    payload = AgentRoundCreate.model_validate(value)
    resolve = repo.resolve_config
    barrier = Barrier(2)

    def synchronized_config(body):
        result = resolve(body)
        barrier.wait(timeout=10)
        return result

    monkeypatch.setattr(repo, "resolve_config", synchronized_config)
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: repo.create_round("conversation", payload), range(2)))
    assert sorted(created for _, created in results) == [False, True]
    assert counts(repo) == (1, 1)
    with connect(repo.library) as conn:
        assert conn.execute("SELECT count(*) FROM agent_requests WHERE id='concurrent'").fetchone()[0] == 1
        assert conn.execute("SELECT count(*) FROM generation_jobs").fetchone()[0] == 1


def test_mask_request_still_uses_exact_target_and_mask_bytes(repo):
    set_mode(repo, "native")
    target = repo.store_asset(image_bytes("blue"), None)["id"]
    mask = repo.store_asset(image_bytes((0, 0, 0, 0), mode="RGBA"), None, "mask")["id"]
    value = body(repo, "masked").model_dump()
    value.update(refs=[{"kind": "upload", "uploadId": target}],
                 mask={"uploadId": mask, "targetRefIndex": 0})
    repo.create_round("conversation", AgentRoundCreate.model_validate(value))
    request = repo.request("masked")
    inputs = execution.build_input(repo, request, execution.refs_for_request(repo, request))
    assert inputs[0]["content"][1]["image_url"] == repo.data_url(target)
    native_tool = next(tool for tool in execution.tools_for(request, repo.data_url(mask)) if tool["type"] == "image_generation")
    assert native_tool["input_image_mask"]["image_url"] == repo.data_url(mask)
    assert request["round"]["maskTargetImageId"] == target
    with connect(repo.library) as conn:
        assert conn.execute("SELECT count(*) FROM agent_frozen_sources").fetchone()[0] == 0


def test_legacy_library_input_is_adopted_after_source_item_deletion(repo, monkeypatch):
    root, job = completed_output(repo, "root")
    accepted = repo.jobs.accept_result_as_new_item(job)
    image = next(image for image in accepted.item.images if image.role != "reference_image")
    source = {"kind": "library", "imageId": image.id}
    freeze = repo._freeze_source

    def old_library_freeze(ref, legacy_asset_id=None):
        if ref["kind"] != "library":
            return freeze(ref, legacy_asset_id)
        _, path, _ = repo.jobs.resolve_library_reference(ref["imageId"])
        return repo.store_asset(path.read_bytes(), ref)["id"]

    with monkeypatch.context() as patch:
        patch.setattr(repo, "_freeze_source", old_library_freeze)
        old, _ = add_round(repo, "old-input", root, refs=[source])
    repo.update("old-input", state="completed", outcome="known")
    legacy = old["round"]["inputImageIds"][0]
    repo.jobs.items.delete_item(accepted.item.id)
    before = counts(repo)
    current, _ = add_round(repo, "new-input", old["round_id"], refs=[source])
    assert current["round"]["inputImageIds"] == [legacy]
    assert counts(repo) == before


def test_saved_request_detects_changed_snapshot_before_any_upstream_post(repo, monkeypatch):
    root, _ = completed_output(repo, "root")
    request, _ = add_round(repo, "saved", root)
    frozen = request["history"][0]["frozenOutputImages"][0]
    (repo.library / repo.asset(frozen)["path"]).write_bytes(image_bytes("red"))
    posts = []

    def unexpected_post(req):
        posts.append(req)
        return httpx.Response(200, json={"status": "completed", "output": []})

    monkeypatch.setattr(httpx, "HTTPTransport", lambda **kwargs: httpx.MockTransport(unexpected_post))
    with pytest.raises(AgentError) as failure:
        execution.call_responses(repo, "saved", 1, execution.refs_for_request(repo, request))
    assert failure.value.code == "frozen_reference_invalid"
    assert posts == []
    assert repo.request("saved")["upstream_outcome"] == "not_sent"
    assert repo.jobs.get_job(repo.request("root")["round"]["outputTaskIds"][0]).status == "succeeded"


def trace_ancestry_reads(monkeypatch):
    queries = []
    connect_repository = repository.connect

    def traced(*args, **kwargs):
        connection = connect_repository(*args, **kwargs)
        connection.set_trace_callback(lambda sql: queries.append(sql) if sql.startswith("SELECT history FROM agent_requests WHERE conversation_id=") else None)
        return connection

    monkeypatch.setattr(repository, "connect", traced)
    return queries


def test_legacy_missing_parent_slots_recover_from_branch_ancestry_in_one_query(repo, monkeypatch):
    first, job_one = completed_output(repo, "first")

    def old_freeze(ref, legacy_asset_id=None):
        job = repo.jobs.get_job(ref["jobId"])
        return repo.store_asset((repo.library / job.result_path).read_bytes(), ref)["id"]

    with monkeypatch.context() as patch:
        patch.setattr(repo, "_freeze_source", old_freeze)
        second, job_two = completed_output(repo, "second", first, "red")
        known, _ = add_round(repo, "known", second)
    repo.update("known", state="completed", outcome="known")
    lost, _ = add_round(repo, "lost", known["round_id"])
    repo.update("lost", state="completed", outcome="known")
    # An old version discarded these slots after source cleanup even though an
    # earlier request on this same branch still owns valid independent snapshots.
    for historical in lost["history"]:
        historical["frozenOutputImages"] = [None] * len(historical["outputTaskIds"])
    with connect(repo.library) as conn:
        conn.execute("UPDATE agent_requests SET history=? WHERE id='lost'", (encoded(lost["history"]),))
        conn.execute("DELETE FROM agent_frozen_sources")
    repo.jobs.discard_job(job_one)
    repo.jobs.discard_job(job_two)
    before = counts(repo)
    queries = trace_ancestry_reads(monkeypatch)
    current, _ = add_round(repo, "recovered", lost["round_id"], prompt="Combine @第1轮图1 and @第2轮图1.")
    assert len(queries) == 1
    assert [item["frozenOutputImages"] for item in current["history"][:2]] == [item["frozenOutputImages"] for item in known["history"]]
    assert repo.request("lost")["history"] == lost["history"]
    assert repo.request("known")["history"] == known["history"]
    assert counts(repo) == before
    repo.update("recovered", state="completed", outcome="known")
    queries.clear()
    add_round(repo, "later", current["round_id"])
    assert queries == []
    assert counts(repo) == before


def test_legacy_fallback_never_adopts_a_sibling_branch_snapshot(repo, monkeypatch):
    root, _ = add_round(repo, "root")
    repo.update("root", state="completed", outcome="known")
    sibling, job = completed_output(repo, "sibling", root["round_id"])
    legacy_child(repo, sibling, monkeypatch)
    repo.jobs.discard_job(job)
    queries = trace_ancestry_reads(monkeypatch)
    with pytest.raises(AgentError) as failure:
        add_round(repo, "other-branch", root["round_id"], refs=[{"kind": "job", "jobId": job}])
    assert failure.value.code == "reference_missing"
    assert len(queries) == 1
    assert "'legacy'" not in queries[0] and "'sibling'" not in queries[0]


def test_normal_and_never_frozen_missing_sources_do_not_scan_ancestor_histories(repo, monkeypatch):
    root, job = completed_output(repo, "root")
    queries = trace_ancestry_reads(monkeypatch)
    child, _ = add_round(repo, "child", root)
    repo.update("child", state="completed", outcome="known")
    assert queries == []
    repo.jobs.discard_job(job)
    add_round(repo, "after-cleanup", child["round_id"])
    assert queries == []
    repo.update("after-cleanup", state="completed", outcome="known")
    other, missing_job = completed_output(repo, "other-root")
    repo.jobs.discard_job(missing_job)
    with pytest.raises(AgentError):
        add_round(repo, "never-frozen", other, prompt="Use @第1轮图1.")
    assert queries == []
