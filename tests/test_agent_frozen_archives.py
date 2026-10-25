"""Portable backups preserve legacy and shared frozen image ownership.

All images, provider configuration and conversations are synthetic. Networking
is blocked by the diagnostic fixture; no execution worker is dispatched.
"""
import base64
import gc
import hashlib
import tarfile

import pytest

from backend import db
from backend.agent_schemas import AgentConversationCreate, AgentRoundCreate
from backend.schemas import GenerationJobAcceptAsNewItemRequest, GenerationJobCreate
from backend.services.agent_execution import build_input, create_image_job, refs_for_request
from backend.services.agent_repository import AgentRepository
from backend.services.library_archives import (
    LibraryArchiveError, backup_library, restore_library, verify_backup,
)
from scripts.diagnose_agent_context import isolated_repository
from scripts.diagnose_agent_result_snapshots import synthetic_png


def add_round(repo, request_id, parent=None, refs=(), conversation="synthetic"):
    snapshot, created = repo.create_round(conversation, AgentRoundCreate.model_validate({
        "requestId": request_id,
        "expectedRevision": repo.snapshot(conversation)["revision"],
        "parentRoundId": parent,
        "prompt": "Compare the lighting of the previous images with this reference.",
        "configRevision": repo.config()["revision"],
        "refs": list(refs),
        "authorization": {"scope": "this_request", "allowImageGeneration": True,
                          "maxImageJobs": 1, "maxToolRounds": 1},
    }))
    assert created
    repo.update(request_id, state="completed", text="Synthetic answer.", outcome="known")
    return snapshot["conversation"]["activeRoundId"]


def stage_output(repo, request_id, image):
    repo.update(request_id, state="running", outcome="known")
    job = create_image_job(repo, request_id, 1, "synthetic-output", "single",
                           "Synthetic geometric image", {}, native=True)
    repo.jobs.stage_result(job.id, image, "synthetic.png")
    repo.update(request_id, state="completed", outcome="known")
    return job.id


def image_payloads(repo, request_id):
    request = repo.request(request_id)
    return [part["image_url"] for item in build_input(repo, request, refs_for_request(repo, request))
            for part in item.get("content", []) if part.get("type") == "input_image"]


def test_portable_archive_restores_shared_frozen_branches_gallery_and_library(tmp_path):
    with isolated_repository(tmp_path / "source") as repo:
        image = synthetic_png(1)
        root = add_round(repo, "root")
        job_id = stage_output(repo, "root", image)
        gallery = repo.jobs.create_job(GenerationJobCreate(prompt_text="  Original\nsynthetic prompt.\n"))
        repo.jobs.stage_result(gallery.id, synthetic_png(2), "synthetic.png")
        accepted = repo.jobs.accept_result_as_new_item(gallery.id, GenerationJobAcceptAsNewItemRequest(
            title="Synthetic archived item", auto_title=False,
        ))
        library_image = accepted.item.images[0]
        library_ref = {"kind": "library", "imageId": library_image.id}
        first = add_round(repo, "branch-one", root, [library_ref])
        second = add_round(repo, "branch-two", root, [library_ref])
        left, right = repo.request("branch-one"), repo.request("branch-two")
        frozen = left["history"][0]["frozenOutputImages"][0]
        assert frozen == right["history"][0]["frozenOutputImages"][0]
        assert left["round"]["inputImageIds"] == right["round"]["inputImageIds"]
        # Uploads remain independent even if bytes happen to match a result.
        legacy = repo.store_asset(image, None)["id"]
        assert legacy != frozen
        repo.create_conversation(AgentConversationCreate(id="peer"))
        add_round(repo, "peer-request", refs=[{"kind": "job", "jobId": job_id}], conversation="peer")
        assert repo.request("peer-request")["round"]["inputImageIds"] == [frozen]
        repo.jobs.discard_job(job_id)
        before = {request_id: image_payloads(repo, request_id)
                  for request_id in ("branch-one", "branch-two", "peer-request")}
        expected_paths = {repo.asset(aid)["path"] for aid in (frozen, legacy, left["round"]["inputImageIds"][0])}
        assert any("/frozen/" in path for path in expected_paths)
        assert any("/frozen/" not in path for path in expected_paths)
        external = tmp_path / "source" / "config" / "outside-oauth.json"
        external.write_text("external-oauth-secret-canary", encoding="utf-8")
        archive = backup_library(repo.library, tmp_path / "shared.tar.gz")
        manifest = verify_backup(archive)
        entries = {row["path"]: row for row in manifest["files"]}
        for path in expected_paths:
            assert entries["library/" + path]["sha256"] == hashlib.sha256((repo.library / path).read_bytes()).hexdigest()
        with tarfile.open(archive, "r:gz") as packaged:
            content = b"".join(packaged.extractfile(member).read() for member in packaged.getmembers() if member.isfile())
            assert b"external-oauth-secret-canary" not in content
            assert b"synthetic-diagnostic-only" not in content
            assert all(name == "manifest.json" or name.startswith("library/") for name in packaged.getnames())
        destination = tmp_path / "restored"
        restore_library(archive, destination, confirm=True)
        restored = AgentRepository(destination)
        for request_id, payloads in before.items():
            assert image_payloads(restored, request_id) == payloads
        assert restored.asset(frozen)["sha256"] == hashlib.sha256(image).hexdigest()
        assert base64.b64decode(restored.data_url(frozen).split(",", 1)[1]) == image
        assert {row["id"] for row in restored.snapshot("synthetic")["conversation"]["rounds"]} == {root, first, second}
        assert restored.jobs.get_job(job_id).result_path is None
        assert restored.jobs.get_job(gallery.id).status == "accepted"
        item = restored.jobs.items.get_item(accepted.item.id)
        assert item.title == accepted.item.title
        assert item.prompts[0].text == "  Original\nsynthetic prompt.\n"
        assert (destination / item.images[0].original_path).read_bytes() == synthetic_png(2)
        # Deleting a branch or conversation cannot invalidate another owner.
        restored.delete("synthetic", first)
        restored.delete("synthetic")
        assert image_payloads(restored, "peer-request") == before["peer-request"]
        with db.connect(destination) as conn:
            assert conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
            assert conn.execute("PRAGMA foreign_key_check").fetchall() == []
        conn.close()
    gc.collect()


def test_legacy_backup_upgrades_only_restored_database_and_reuses_old_frozen_bytes(tmp_path, monkeypatch):
    with isolated_repository(tmp_path / "source") as repo:
        image = synthetic_png(3)
        root = add_round(repo, "root")
        job_id = stage_output(repo, "root", image)
        # Reproduce the old UUID file/row behavior without copying current
        # storage semantics into the legacy fixture.
        def legacy_resolve(ref, **kwargs):
            assert ref == {"kind": "job", "jobId": job_id}
            return repo.store_asset(image, ref)["id"]
        with monkeypatch.context() as patch:
            patch.setattr(repo, "resolve_ref", legacy_resolve)
            child = add_round(repo, "legacy-child", root)
        request = repo.request("legacy-child")
        frozen = request["history"][0]["frozenOutputImages"][0]
        original_path = repo.asset(frozen)["path"]
        assert "/frozen/" not in original_path
        repo.jobs.discard_job(job_id)
        with db.connect(repo.library) as conn:
            conn.execute("DROP TABLE agent_frozen_sources")
            conn.execute("DROP INDEX idx_agent_assets_source_kind")
            conn.execute("DELETE FROM schema_migrations WHERE version=?", (db.MIGRATIONS[-1],))
        conn.close()
        archive = backup_library(repo.library, tmp_path / "legacy.tar.gz")
        assert verify_backup(archive)["migrations"] == db.MIGRATIONS[:-1]
        destination = tmp_path / "upgraded"
        restore_library(archive, destination, confirm=True)
        restored = AgentRepository(destination)
        assert restored.request("legacy-child")["history"] == request["history"]
        assert restored.asset(frozen)["path"] == original_path
        assert base64.b64decode(restored.data_url(frozen).split(",", 1)[1]) == image
        add_round(restored, "new-child", child)
        assert restored.request("new-child")["history"][0]["frozenOutputImages"] == [frozen]
        assert len(list((destination / "generation-references" / "agent").rglob("*.png"))) == 1
        with db.connect(destination) as conn:
            assert [row[0] for row in conn.execute("SELECT version FROM schema_migrations ORDER BY rowid")] == db.MIGRATIONS
            assert conn.execute("SELECT asset_id FROM agent_frozen_sources").fetchall()[0][0] == frozen
        conn.close()
        with db.connect(repo.library) as conn:
            assert [row[0] for row in conn.execute("SELECT version FROM schema_migrations ORDER BY rowid")] == db.MIGRATIONS[:-1]
        conn.close()
    gc.collect()


@pytest.mark.parametrize("mutation, message", [
    ("DROP TABLE agent_frozen_sources", "missing required table: agent_frozen_sources"),
    ("ALTER TABLE agent_frozen_sources RENAME COLUMN source_key TO broken_key", "missing required column: agent_frozen_sources.source_key"),
])
def test_archive_rejects_incomplete_frozen_source_schema(tmp_path, mutation, message):
    library = tmp_path / "library"
    db.init_db(library)
    with db.connect(library) as conn:
        conn.execute(mutation)
    conn.close()
    with pytest.raises(LibraryArchiveError, match=message):
        backup_library(library, tmp_path / "invalid.tar.gz")
