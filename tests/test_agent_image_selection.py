"""Turn-local image choices use isolated configuration and never contact a provider."""
import json

import httpx
import pytest
from pydantic import ValidationError

from backend.agent_schemas import AgentConfigSave, AgentConversationCreate, AgentRoundCreate
from backend.db import connect
from backend.services.agent_execution import create_image_job, tools_for
from backend.services.agent_repository import AgentError, AgentRepository
from backend.services.openai_compatible import OpenAICompatibleConfig


@pytest.fixture
def repo(tmp_path, monkeypatch):
    for suffix in ("AUTH_PATH", "GROK_AUTH_PATH", "CONFIG_PATH", "OPENAI_COMPATIBLE_CONFIG_PATH",
                   "CAPTURE_CLIENTS_PATH", "CAPTURE_ORGANIZER_CONFIG_PATH"):
        monkeypatch.setenv("IMAGE_PROMPT_LIBRARY_" + suffix, str(tmp_path / "config" / (suffix + ".json")))

    def no_network(*args, **kwargs):
        raise AssertionError("Image-selection tests must not make network requests")

    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", no_network)
    library = tmp_path / "library"
    store = OpenAICompatibleConfig(library_path=library)
    for profile_id, model in (("text", "mock-text"), ("image_a", "gpt-image-a"), ("image_b", "gpt-image-b")):
        store.save({"base_url": "http://127.0.0.1:1/v1", "api_key": "synthetic-" + profile_id,
                    "display_name": profile_id, "model": model}, profile_id=profile_id)
    repository = AgentRepository(library)
    set_mode(repository, "hybrid")
    repository.create_conversation(AgentConversationCreate(id="conversation"))
    return repository


def set_mode(repo, mode):
    document = repo.config()
    return repo.save_config(AgentConfigSave.model_validate({
        "expectedRevision": document["revision"],
        "config": {**document["config"], "apiConfigMode": mode, "textProfileId": "text",
                   "textModel": "mock-text", "imageProfileId": "image_a", "imageModel": "gpt-image-agent"},
    }))


def body(repo, request_id="request", *, selection=None, images=True):
    values = {"requestId": request_id, "expectedRevision": repo.snapshot("conversation")["revision"],
              "prompt": "Create a synthetic orange square", "configRevision": repo.config()["revision"],
              "activeProfileId": "text", "params": {"size": "1024x1024", "quality": "auto"},
              "authorization": {"scope": "this_request", "allowImageGeneration": images,
                                "maxToolRounds": 5, "maxImageJobs": 2 if images else 0}}
    if selection is not None:
        values["imageConfig"] = selection
    return AgentRoundCreate.model_validate(values)


def test_turn_selection_freezes_actual_job_without_changing_global_config(repo):
    before = repo.config()
    original = body(repo, "original")
    repo.create_round("conversation", original)
    first = create_image_job(repo, "original", 1, "call_a", "single", "orange square", {})
    assert first.model == "gpt-image-agent"
    assert first.parameters["compatible_profile_id"] == "image_a"
    repo.update("original", state="completed", outcome="known")

    selected = body(repo, "selected", selection={"profileId": "image_b", "model": "gpt-image-explicit"})
    snapshot, created = repo.create_round("conversation", selected)
    assert created
    frozen = snapshot["request"]["frozenConfig"]
    assert frozen["textProfileId"] == "text" and frozen["textModel"] == "mock-text"
    assert frozen["imageProfileId"] == "image_b" and frozen["imageModel"] == "gpt-image-explicit"
    assert "synthetic-" not in json.dumps(snapshot)
    assert "_profileDigests" not in frozen
    job = create_image_job(repo, "selected", 1, "call_b", "single", "orange square", {})
    assert job.model == "gpt-image-explicit"
    assert job.parameters["model"] == "gpt-image-explicit"
    assert job.parameters["compatible_profile_id"] == "image_b"
    assert job.metadata["agent"]["conversationId"] == "conversation"
    assert job.metadata["agent"]["roundId"] == snapshot["request"]["roundId"]
    assert repo.verified_profile(repo.request("selected"), image=True)["id"] == "image_b"
    assert repo.config() == before


@pytest.mark.parametrize("selection,expected_profile,expected_model", [
    ({"profileId": "image_b", "model": "  "}, "image_b", "gpt-image-b"),
    ({"model": "gpt-image-manual"}, "image_a", "gpt-image-manual"),
    ({"profileId": None, "model": ""}, "image_a", "gpt-image-a"),
])
def test_hybrid_profile_and_model_fallback_are_explicit(repo, selection, expected_profile, expected_model):
    snapshot, _ = repo.create_round("conversation", body(repo, selection=selection))
    assert snapshot["request"]["frozenConfig"]["imageProfileId"] == expected_profile
    assert snapshot["request"]["frozenConfig"]["imageModel"] == expected_model


@pytest.mark.parametrize("mode", ["native", "off"])
def test_native_selection_only_changes_image_tool_model(repo, mode):
    set_mode(repo, mode)
    with pytest.raises(AgentError, match="不能指定独立图片供应商") as error:
        repo.create_round("conversation", body(repo, selection={"profileId": "image_b", "model": "gpt-image-b"}))
    assert error.value.code == "capability_unsupported"
    snapshot, _ = repo.create_round("conversation", body(repo, selection={"model": "gpt-image-native"}))
    assert snapshot["request"]["frozenConfig"]["imageProfileId"] == "text"
    tool = next(tool for tool in tools_for(repo.request("request")) if tool["type"] == "image_generation")
    assert tool["model"] == "gpt-image-native"
    assert not any(tool.get("name") == "generate_image" for tool in tools_for(repo.request("request")))


def test_selecting_images_does_not_grant_authorization_or_reset_quota(repo):
    repo.create_round("conversation", body(repo, selection={"profileId": "image_b", "model": ""}, images=False))
    tools = tools_for(repo.request("request"))
    assert all(tool["type"] == "function" and tool.get("name") == "read_agent_skill" for tool in tools)
    assert not any(tool.get("type") in {"image_generation", "web_search"} or
                   tool.get("name") in {"generate_image", "generate_image_batch", "continue_generation"}
                   for tool in tools)
    with pytest.raises(AgentError) as error:
        create_image_job(repo, "request", 1, "call", "single", "orange square", {})
    assert error.value.code == "authorization_denied"
    with connect(repo.library) as conn:
        assert conn.execute("SELECT count(*) FROM generation_jobs").fetchone()[0] == 0
    repo.update("request", state="completed", outcome="known")
    repo.create_round("conversation", body(repo, "allowed", selection={"profileId": "image_b", "model": ""}))
    for index in range(2):
        create_image_job(repo, "allowed", 1, "call", str(index), "orange square", {})
    with pytest.raises(AgentError) as error:
        create_image_job(repo, "allowed", 1, "call", "third", "orange square", {})
    assert error.value.code == "budget_exhausted"


@pytest.mark.parametrize("change", [{"model": "gpt-image-changed"}, {"api_key": "synthetic-rotated"},
                                    {"base_url": "http://127.0.0.1:2/v1"}])
def test_changed_selected_connection_invalidates_frozen_profile(repo, change):
    repo.create_round("conversation", body(repo, selection={"profileId": "image_b", "model": ""}))
    OpenAICompatibleConfig(library_path=repo.library).save(change, profile_id="image_b")
    with pytest.raises(AgentError) as error:
        repo.verified_profile(repo.request("request"), image=True)
    assert error.value.code == "profile_changed"
    assert repo.verified_profile(repo.request("request"))["id"] == "text"


def test_turn_selection_keeps_revision_and_duplicate_request_protection(repo):
    selected = body(repo, selection={"profileId": "image_b", "model": "gpt-image-chosen"})
    first, created = repo.create_round("conversation", selected)
    assert created
    replay, created = repo.create_round("conversation", selected)
    assert not created and replay["request"]["roundId"] == first["request"]["roundId"]
    for selection in ({"profileId": "image_a", "model": "gpt-image-chosen"},
                      {"profileId": "image_b", "model": "gpt-image-other"}):
        with pytest.raises(AgentError) as error:
            repo.create_round("conversation", body(repo, selection=selection))
        assert error.value.code == "request_id_conflict"
    repo.update("request", state="completed", outcome="known")
    stale = body(repo, "stale", selection={"profileId": "image_b", "model": ""})
    set_mode(repo, "hybrid")
    with pytest.raises(AgentError) as error:
        repo.create_round("conversation", stale)
    assert error.value.code == "config_revision_conflict"


@pytest.mark.parametrize("profile_id", ["missing", "incomplete"])
def test_turn_selection_rejects_missing_or_incomplete_profile(repo, profile_id):
    if profile_id == "incomplete":
        OpenAICompatibleConfig(library_path=repo.library).save(
            {"base_url": "http://127.0.0.1:1/v1", "model": "gpt-image-b"}, profile_id=profile_id)
    with pytest.raises(AgentError) as error:
        repo.create_round("conversation", body(repo, selection={"profileId": profile_id, "model": ""}))
    assert error.value.code == "configuration_incomplete"
    with connect(repo.library) as conn:
        assert conn.execute("SELECT count(*) FROM agent_rounds").fetchone()[0] == 0


@pytest.mark.parametrize("selection", [{"profileId": "", "model": ""}, {"profileId": "../wrong", "model": ""},
                                      {"model": "x" * 201}, {"model": "", "base_url": "http://127.0.0.1:1"}])
def test_selection_rejects_unbounded_or_connection_fields(repo, selection):
    with pytest.raises(ValidationError):
        body(repo, selection=selection)
