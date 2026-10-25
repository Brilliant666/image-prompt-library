"""Professional workflow configuration remains local and backward compatible."""
import json

import pytest
from fastapi.testclient import TestClient

from backend.agent_schemas import AgentConfig, AgentConfigSave
from backend.db import connect
from backend.main import create_app
from backend.services.agent_repository import AgentRepository
from backend.services.openai_compatible import OpenAICompatibleConfig
from test_agent_image_selection import repo, body, set_mode


def test_old_configuration_defaults_to_workflows_without_rewriting_saved_values(repo):
    saved = repo.config()
    legacy = {key: value for key, value in saved["config"].items() if key != "professionalPromptWorkflows"}
    with connect(repo.library) as conn:
        conn.execute("UPDATE agent_config SET config=? WHERE singleton=1", (json.dumps(legacy),))
    loaded = AgentRepository(repo.library).config()
    assert AgentConfig().professionalPromptWorkflows is True
    assert loaded["revision"] == saved["revision"]
    assert loaded["config"] == {**legacy, "professionalPromptWorkflows": True}
    with connect(repo.library) as conn:
        assert json.loads(conn.execute("SELECT config FROM agent_config WHERE singleton=1").fetchone()[0]) == legacy


@pytest.mark.parametrize("mode", ["off", "native", "hybrid"])
def test_settings_api_roundtrip_preserves_profiles_models_limits_and_creates_no_requests(repo, mode):
    set_mode(repo, mode)
    profiles = OpenAICompatibleConfig(library_path=repo.library)
    before_profiles = {key: profiles.read(key) for key in ("text", "image_a", "image_b")}
    client = TestClient(create_app(repo.library))
    try:
        saved = client.get("/api/agent/config").json()
        original = saved["config"]
        assert original["professionalPromptWorkflows"] is True
        for enabled in (False, True):
            response = client.put("/api/agent/config", json={
                "expectedRevision": saved["revision"],
                "config": {**original, "professionalPromptWorkflows": enabled},
            })
            assert response.status_code == 200, response.text
            saved = response.json()
            assert saved["config"] == {**original, "professionalPromptWorkflows": enabled}
            assert client.get("/api/agent/config").json()["config"] == saved["config"]
            assert AgentRepository(repo.library).config()["config"] == saved["config"]
    finally:
        client.close()
    assert {key: profiles.read(key) for key in before_profiles} == before_profiles
    with connect(repo.library) as conn:
        assert conn.execute("SELECT count(*) FROM generation_jobs").fetchone()[0] == 0
        assert conn.execute("SELECT count(*) FROM agent_requests").fetchone()[0] == 0


def test_workflow_toggle_does_not_change_frozen_requests_or_conversation_data(repo):
    repo.create_round("conversation", body(repo, "first", images=False))
    first = repo.request("first")
    repo.update("first", state="completed", outcome="known")
    before = repo.request("first")
    saved = repo.config()
    repo.save_config(AgentConfigSave.model_validate({
        "expectedRevision": saved["revision"],
        "config": {**saved["config"], "professionalPromptWorkflows": False},
    }))
    assert repo.request("first") == before
    assert first["frozen"]["professionalPromptWorkflows"] is True
    repo.create_round("conversation", body(repo, "second", images=False))
    assert repo.request("second")["frozen"]["professionalPromptWorkflows"] is False
    assert repo.request("first")["frozen"] == before["frozen"]


def test_old_client_save_uses_enabled_default_without_overwriting_other_config(repo):
    saved = repo.config()
    legacy = {key: value for key, value in saved["config"].items() if key != "professionalPromptWorkflows"}
    result = repo.save_config(AgentConfigSave.model_validate({"expectedRevision": saved["revision"], "config": legacy}))
    assert result["config"] == {**legacy, "professionalPromptWorkflows": True}
