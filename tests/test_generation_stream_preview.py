from io import BytesIO
import json
import sqlite3

from PIL import Image
import pytest

from backend.db import connect
from backend.schemas import GenerationJobCreate
from backend.services.generation_jobs import (
    GenerationJobConflict,
    GenerationJobRepository,
    resolve_generation_input_image_path,
)
from backend.services.generation_queue import recover_interrupted_generation_jobs


def image_bytes(color="orange", format="PNG"):
    output = BytesIO()
    Image.new("RGB", (18, 12), color).save(output, format=format)
    return output.getvalue()


def running_job(tmp_path):
    repo = GenerationJobRepository(tmp_path / "library")
    job = repo.create_job(GenerationJobCreate(provider="manual_upload", prompt_text="Synthetic stream lifecycle"))
    repo.mark_running(job.id)
    return repo, job


def test_preview_replaces_only_transient_bytes_and_does_not_publish_result(tmp_path):
    repo, job = running_job(tmp_path)
    repo.stage_stream_preview(job.id, image_bytes(), {"partial_image_index": 0, "api_key": "must-not-persist"})
    first = repo.get_job(job.id).metadata["stream_preview"]
    assert (repo.library_path / first["path"]).read_bytes() == image_bytes()
    updated = image_bytes("blue", "WEBP")
    repo.stage_stream_preview(job.id, updated, {"partial_image_index": 1})
    current = repo.get_job(job.id)
    preview = current.metadata["stream_preview"]
    assert current.status == "running"
    assert current.result_path is None
    assert current.result_width is None and current.result_height is None
    assert current.completed_at is None
    assert set(preview) == {"path", "width", "height", "index", "version"}
    assert (preview["width"], preview["height"], preview["index"]) == (18, 12, 1)
    assert preview["version"] != first["version"]
    assert (repo.library_path / preview["path"]).read_bytes() == updated
    assert not (repo.library_path / first["path"]).exists()
    assert list((repo.library_path / "generation-results" / job.id / "stream-preview").iterdir()) == [repo.library_path / preview["path"]]
    listed = repo.list_jobs().jobs[0]
    assert listed.metadata["stream_preview"] == preview
    with pytest.raises(GenerationJobConflict, match="unfinished stream preview"):
        resolve_generation_input_image_path(repo.library_path, preview["path"])


@pytest.mark.parametrize("finish", ["success", "failure", "cancel", "restart"])
def test_preview_is_cleared_on_terminal_transition_and_late_callback_cannot_restore_it(tmp_path, finish):
    repo, job = running_job(tmp_path)
    repo.stage_stream_preview(job.id, image_bytes(), {"partial_image_index": 0})
    preview = repo.get_job(job.id).metadata["stream_preview"]
    if finish == "success":
        final_bytes = image_bytes("green")
        current = repo.stage_result(job.id, final_bytes, "final.png", {"response": {"safe": True}, "stream_preview": {"path": "injected"}})
        assert (repo.library_path / current.result_path).read_bytes() == final_bytes
        assert (current.result_width, current.result_height) == (18, 12)
    elif finish == "failure":
        current = repo.mark_failed(job.id, "Stream ended before a final image")
        assert current.result_path is None
    elif finish == "cancel":
        current = repo.cancel_job(job.id)
    else:
        current = recover_interrupted_generation_jobs(repo.library_path, provider="manual_upload")[0]
        assert current.status == "failed" and current.result_path is None
    assert "stream_preview" not in current.metadata
    assert not (repo.library_path / preview["path"]).exists()
    repo.stage_stream_preview(job.id, image_bytes("purple"), {"partial_image_index": 1})
    assert "stream_preview" not in repo.get_job(job.id).metadata
    assert not (repo.library_path / preview["path"]).exists()


def test_bulk_cancel_cleans_previews_and_preserves_unrelated_result_files(tmp_path):
    repo, job = running_job(tmp_path)
    repo.stage_stream_preview(job.id, image_bytes(), {})
    other = repo.library_path / "generation-results" / job.id / "result-user.png"
    other.write_bytes(image_bytes("red"))
    assert repo.cancel_active_jobs() == 1
    assert "stream_preview" not in repo.get_job(job.id).metadata
    assert other.read_bytes() == image_bytes("red")
    assert not list((other.parent / "stream-preview").iterdir())


def test_terminal_cleanup_ignores_metadata_paths_outside_reserved_preview_directory(tmp_path):
    repo, job = running_job(tmp_path)
    other = repo.library_path / "private-image.png"
    other.write_bytes(image_bytes())
    with connect(repo.library_path) as conn:
        conn.execute("UPDATE generation_jobs SET metadata=? WHERE id=?", (json.dumps({"stream_preview": {"path": "private-image.png"}}), job.id))
        conn.commit()
    repo.mark_failed(job.id, "synthetic failure")
    assert other.read_bytes() == image_bytes()
    assert "stream_preview" not in repo.get_job(job.id).metadata


def test_preview_validation_rejects_invalid_payload_and_does_not_change_job(tmp_path, monkeypatch):
    repo, job = running_job(tmp_path)
    with pytest.raises(GenerationJobConflict, match="invalid"):
        repo.stage_stream_preview(job.id, b"not-image", {})
    with pytest.raises(GenerationJobConflict, match="index"):
        repo.stage_stream_preview(job.id, image_bytes(), {"partial_image_index": -1})
    monkeypatch.setattr("backend.services.generation_jobs.STREAM_PREVIEW_MAX_BYTES", 10)
    with pytest.raises(GenerationJobConflict, match="size limit"):
        repo.stage_stream_preview(job.id, image_bytes(), {})
    current = repo.get_job(job.id)
    assert current.status == "running" and current.result_path is None
    assert "stream_preview" not in current.metadata


def test_new_compatible_job_freezes_profile_transport_settings(tmp_path, monkeypatch):
    config = {"id": "profile-a", "display_name": "Synthetic service", "model": "image-model", "base_url_mode": "custom", "stream": True, "partial_images": 2, "response_format": "b64_json"}
    monkeypatch.setattr("backend.services.openai_compatible.OpenAICompatibleConfig.read", lambda *args, **kwargs: dict(config))
    repo = GenerationJobRepository(tmp_path / "library")
    job = repo.create_job(GenerationJobCreate(provider="openai_compatible", prompt_text="Synthetic frozen request"))
    config.update(stream=False, partial_images=0, response_format="auto", base_url_mode="versioned")
    loaded = repo.get_job(job.id)
    assert {key: loaded.parameters[key] for key in ("stream", "partial_images", "response_format", "base_url_mode")} == {"stream": True, "partial_images": 2, "response_format": "b64_json", "base_url_mode": "custom"}


@pytest.mark.parametrize("failure_point", ["update", "commit", "auto-rollback"])
@pytest.mark.parametrize("previous_format", [None, "PNG", "WEBP"])
def test_failed_preview_database_write_removes_first_frame_or_restores_previous_frame(tmp_path, monkeypatch, failure_point, previous_format):
    repo, job = running_job(tmp_path)
    if previous_format:
        repo.stage_stream_preview(job.id, image_bytes("blue", previous_format), {"partial_image_index": 0})
    before = repo.get_job(job.id)
    result_root = repo.library_path / "generation-results" / job.id
    result_root.mkdir(parents=True, exist_ok=True)
    final_file = result_root / "result-keep.png"
    final_file.write_bytes(image_bytes("red"))
    other_preview = repo.library_path / "generation-results" / "other-job" / "stream-preview" / "image.png"
    other_preview.parent.mkdir(parents=True, exist_ok=True)
    other_preview.write_bytes(image_bytes("green"))

    class FailingConnection:
        def __init__(self, connection):
            self.connection = connection

        def __getattr__(self, name):
            return getattr(self.connection, name)

        def __enter__(self):
            self.connection.__enter__()
            return self

        def __exit__(self, *args):
            return self.connection.__exit__(*args)

        def execute(self, sql, *args):
            if failure_point in {"update", "auto-rollback"} and sql.startswith("UPDATE generation_jobs SET metadata="):
                if failure_point == "auto-rollback":
                    self.connection.rollback()
                raise sqlite3.OperationalError("injected preview update failure")
            return self.connection.execute(sql, *args)

        def commit(self):
            if failure_point == "commit":
                raise sqlite3.OperationalError("injected preview commit failure")
            return self.connection.commit()

    with monkeypatch.context() as patch:
        patch.setattr("backend.services.generation_jobs.connect", lambda library: FailingConnection(connect(library)))
        with pytest.raises(sqlite3.OperationalError, match="injected preview"):
            repo.stage_stream_preview(job.id, image_bytes("orange"), {"partial_image_index": 1})
    after = repo.get_job(job.id)
    assert after.status == "running" and after.result_path is None
    assert after.metadata == before.metadata
    preview_files = list((result_root / "stream-preview").iterdir())
    if previous_format:
        previous_path = repo.library_path / before.metadata["stream_preview"]["path"]
        assert preview_files == [previous_path]
        assert previous_path.read_bytes() == image_bytes("blue", previous_format)
    else:
        assert preview_files == []
    assert final_file.read_bytes() == image_bytes("red")
    assert other_preview.read_bytes() == image_bytes("green")


@pytest.mark.parametrize("finish", ["failure", "cancel", "restart", "clear"])
def test_terminal_cleanup_removes_reserved_orphan_without_metadata(tmp_path, finish):
    repo, job = running_job(tmp_path)
    preview_path = repo.library_path / "generation-results" / job.id / "stream-preview" / "image.png"
    preview_path.parent.mkdir(parents=True, exist_ok=True)
    preview_path.write_bytes(image_bytes())
    final_file = preview_path.parent.parent / "result-keep.png"
    final_file.write_bytes(image_bytes("red"))
    assert "stream_preview" not in repo.get_job(job.id).metadata
    if finish == "failure":
        repo.mark_failed(job.id, "Synthetic interrupted preview transaction")
    elif finish == "cancel":
        repo.cancel_job(job.id)
    elif finish == "restart":
        recover_interrupted_generation_jobs(repo.library_path, provider="manual_upload")
    else:
        with connect(repo.library_path) as conn:
            conn.execute("UPDATE generation_jobs SET status='failed' WHERE id=?", (job.id,))
            conn.commit()
        repo.clear_stream_preview(job.id)
    assert not preview_path.exists()
    assert final_file.read_bytes() == image_bytes("red")
