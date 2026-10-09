"""Independent source maintenance must not replace the customized runtime."""
import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.main import create_app
from backend.schemas import GenerationJobCreate
from backend.services.generation_jobs import GenerationJobRepository

ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.parametrize("platform", ["win32", "darwin", "linux"])
def test_source_marker_blocks_packaged_update_without_network_or_job_cancellation(tmp_path, monkeypatch, platform):
    from backend.routers import app_updates

    packaged = tmp_path / "packaged"
    packaged.mkdir()
    (packaged / "VERSION").write_text("v0.11.2", encoding="utf-8")
    shutil.copy2(ROOT / "SOURCE_MAINTENANCE.json", packaged)
    monkeypatch.setattr(app_updates, "app_root", lambda: packaged)
    monkeypatch.setattr(app_updates.sys, "platform", platform)
    def unexpected(*args, **kwargs):
        raise AssertionError("Source maintenance must not perform update I/O")
    monkeypatch.setattr(app_updates, "cached_latest_complete_release", unexpected)
    monkeypatch.setattr(app_updates, "run_installer_update", unexpected)
    monkeypatch.setattr(app_updates, "detect_service_mode", lambda: "not_applicable")
    library = tmp_path / "library"
    repo = GenerationJobRepository(library)
    job = repo.create_job(GenerationJobCreate(provider="manual_upload", prompt_text="test"))
    client = TestClient(create_app(library_path=library))
    status = client.get("/api/update-status?refresh=true").json()
    assert status["update_capability"] == "source"
    assert status["update_reason"] == "independent_source_maintenance"
    assert not status["update_available"]
    assert status["latest_version"] is None
    assert status["update_command"] is None
    response = client.post("/api/app-update/jobs", json={"target_version": "v99.0.0", "cancel_active_generation_jobs": True})
    assert response.status_code == 409
    assert repo.get_job(job.id).status == "queued"


@pytest.mark.skipif(sys.platform != "win32", reason="PowerShell installer is Windows-specific")
@pytest.mark.parametrize("script,args", [("install.ps1", ["-Prefix"]), ("appctl.ps1", ["update"])])
def test_windows_release_commands_reject_before_creating_prefix(tmp_path, monkeypatch, script, args):
    import os
    prefix = tmp_path / "never-created"
    env = os.environ.copy()
    env["IMAGE_PROMPT_LIBRARY_PREFIX"] = str(prefix)
    arguments = args + ([str(prefix)] if script == "install.ps1" else [])
    result = subprocess.run(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(ROOT / "scripts" / script), *arguments], capture_output=True, text=True, env=env)
    assert result.returncode != 0
    assert "Brilliant666/image-prompt-library" in result.stderr
    assert "disabled" in result.stderr
    assert not prefix.exists()


def test_source_marker_tracks_the_independent_repository():
    marker = json.loads((ROOT / "SOURCE_MAINTENANCE.json").read_text(encoding="utf-8"))
    assert marker["repository"] == "https://github.com/Brilliant666/image-prompt-library"
    assert marker["mode"] == "source"
    assert marker["release_installation_enabled"] is False


@pytest.mark.skipif(sys.platform != "win32", reason="PowerShell installer is Windows-specific")
def test_windows_source_install_rejects_explicit_upstream_release(tmp_path):
    prefix = tmp_path / "never-created"
    result = subprocess.run(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(ROOT / "scripts" / "install.ps1"), "-Prefix", str(prefix), "-ReleaseBaseUrl", "https://github.com/EddieTYP/image-prompt-library/releases/download/v99.0.0"], capture_output=True, text=True)
    assert result.returncode != 0
    assert "disabled" in result.stderr
    assert not prefix.exists()
