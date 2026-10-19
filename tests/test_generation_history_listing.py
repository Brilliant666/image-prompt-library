"""History reads stay lightweight while explicit recipe reads preserve originals."""
import base64
from io import BytesIO
import json

from fastapi.testclient import TestClient
from PIL import Image
import pytest

from backend.db import connect
from backend.main import create_app
from backend.schemas import GenerationJobCreate
from backend.services.generation_jobs import GenerationJobRepository


def image_data():
    output = BytesIO()
    Image.new("RGBA", (12, 8), (50, 80, 120, 96)).save(output, "PNG")
    return output.getvalue()


def test_metadata_history_does_not_repair_or_read_reference_images(tmp_path, monkeypatch):
    library = tmp_path / "library"
    client = TestClient(create_app(library_path=library))
    repository = GenerationJobRepository(library)
    original = image_data()
    job = repository.create_job(GenerationJobCreate(
        prompt_text="  Preserve original text\nsecond line  ",
        parameters={"input_images": [{"name": "reference.png", "data_url":
            "data:image/png;base64," + base64.b64encode(original).decode()}]},
    ))
    # Include one old inline-only record and one already-persisted reference.
    prepared = repository.prepare_recipe_references(job)
    snapshot = library / prepared.parameters["input_images"][0]["result_path"]
    with connect(library) as connection:
        connection.execute("UPDATE generation_jobs SET parameters=? WHERE id=?",
                           (json.dumps(prepared.parameters), job.id))
        connection.commit()
    legacy = repository.create_job(GenerationJobCreate(
        prompt_text="Legacy recipe", parameters=job.parameters,
    ))
    before = {path.relative_to(library).as_posix(): path.stat().st_mtime_ns
              for path in (library / "generation-references").rglob("*") if path.is_file()}

    def no_image_io(*_args, **_kwargs):
        raise AssertionError("Metadata history must not decode, hash or repair images")

    with monkeypatch.context() as patch:
        patch.setattr(GenerationJobRepository, "prepare_recipe_references", no_image_io)
        patch.setattr(Image, "open", no_image_io)
        for _ in range(2):
            response = client.get("/api/generation-jobs", params={"prepare_references": "false"})
            assert response.status_code == 200
            rows = {row["id"]: row for row in response.json()["jobs"]}
            assert rows[job.id]["prompt_text"] == job.prompt_text
            existing = rows[job.id]["parameters"]["input_images"][0]
            assert existing["result_path"] == prepared.parameters["input_images"][0]["result_path"]
            assert existing["has_data_url"] and existing["data_url_redacted"]
            assert "data_url" not in existing
            missing = rows[legacy.id]["parameters"]["input_images"][0]
            assert "result_path" not in missing and "data_url" not in missing

    after = {path.relative_to(library).as_posix(): path.stat().st_mtime_ns
             for path in (library / "generation-references").rglob("*") if path.is_file()}
    assert before == after
    assert snapshot.read_bytes() == original
    # Only the user's explicit recipe read repairs the old inline-only record.
    detail = client.get(f"/api/generation-jobs/{legacy.id}")
    assert detail.status_code == 200
    restored = detail.json()["parameters"]["input_images"][0]
    assert client.get("/media/" + restored["result_path"]).content == original
    assert repository.get_job(legacy.id).parameters == legacy.parameters


def test_metadata_history_does_not_bypass_validation_on_recipe_read(tmp_path):
    library = tmp_path / "library"
    client = TestClient(create_app(library_path=library))
    repository = GenerationJobRepository(library)
    job = repository.create_job(GenerationJobCreate(prompt_text="Broken legacy reference"))
    parameters = {"input_images": [{"data_url": "data:image/png;base64,not-an-image",
        "result_path": "generation-references/other/reference.png", "preview_path": "../private.png"}]}
    with connect(library) as connection:
        connection.execute("UPDATE generation_jobs SET parameters=? WHERE id=?", (json.dumps(parameters), job.id))
        connection.commit()
    assert client.get("/api/generation-jobs?prepare_references=false").status_code == 200
    detail = client.get(f"/api/generation-jobs/{job.id}")
    assert detail.status_code == 200
    spec = detail.json()["parameters"]["input_images"][0]
    assert "data_url" not in spec and "result_path" not in spec and "preview_path" not in spec
    assert not (library / "generation-references").exists()


def test_success_history_filters_before_pagination_and_includes_accepted(tmp_path):
    library = tmp_path / "library"
    client = TestClient(create_app(library_path=library))
    repository = GenerationJobRepository(library)
    records = {}
    for index, status in enumerate(("succeeded", "accepted", "failed", "failed")):
        job = repository.create_job(GenerationJobCreate(prompt_text=f"Synthetic history {index}"))
        records.setdefault(status, []).append(job.id)
        with connect(library) as connection:
            connection.execute("UPDATE generation_jobs SET status=?, created_at=? WHERE id=?",
                               (status, f"2026-01-0{index + 1}T00:00:00+00:00", job.id))
            connection.commit()
    for offset, expected_status in ((0, "accepted"), (1, "succeeded")):
        response = client.get("/api/generation-jobs", params={
            "statuses": "succeeded, accepted,succeeded", "limit": 1, "offset": offset,
            "prepare_references": "false",
        })
        assert response.status_code == 200
        result = response.json()
        assert result["total"] == 2
        assert [row["id"] for row in result["jobs"]] == records[expected_status]
        assert result["status_counts"]["failed"] == 2
        assert result["status_counts"]["accepted"] == 1
        assert result["status_counts"]["succeeded"] == 1
    assert client.get("/api/generation-jobs").json()["total"] == 4
    assert client.get("/api/generation-jobs?status=failed").json()["total"] == 2


@pytest.mark.parametrize("parameters", [
    {"statuses": ""}, {"statuses": "accepted,"}, {"statuses": "successful"},
    {"statuses": "succeeded,unknown"}, {"statuses": "succeeded", "status": "failed"},
])
def test_history_rejects_invalid_or_ambiguous_status_filters(tmp_path, parameters):
    client = TestClient(create_app(library_path=tmp_path / "library"))
    response = client.get("/api/generation-jobs", params=parameters)
    assert response.status_code == 422
