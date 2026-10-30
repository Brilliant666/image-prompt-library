"""The bundled skill reader is finite, side-effect-free and independently usable."""
import copy
import json
import socket
import subprocess
from pathlib import Path

import pytest

from backend.services.agent_skills import read_agent_skill, default_skill_sections, skill_catalog_instructions, skill_tool


@pytest.mark.parametrize("skill,sections", [
    ("image-prompt-reverse", ("overview", "analysis", "illustration")),
    ("gpt-image", ("overview", "composition", "editing", "text")),
])
def test_each_supported_slice_has_fixed_provenance_and_bounded_content(skill, sections):
    schema = skill_tool()["parameters"]
    assert skill in schema["properties"]["skill"]["enum"]
    for section in sections:
        result = read_agent_skill(skill, section)
        assert result["skill"] == skill and result["section"] == section
        assert section in schema["properties"]["section"]["enum"]
        assert len(result["revision"]) == 40
        assert result["source"].startswith("https://github.com/")
        assert result["license"] in {"GPL-3.0", "MIT"}
        assert 500 < len(result["content"]) < 5000
        assert "does not authorize image generation or search" in result["content"]
        assert "read keys" in result["content"]
        assert json.loads(json.dumps(result, ensure_ascii=False)) == result


@pytest.mark.parametrize("skill,section", [
    ("../../credentials", "overview"),
    ("https://example.invalid/skill", "overview"),
    ("gpt-image", "../../.env"),
    ("gpt-image", "illustration"),
    ("image-prompt-reverse", "editing"),
    ("GPT-IMAGE", "overview"),
    (None, "overview"),
    ([], "overview"),
    ("gpt-image", []),
    ("gpt-image", None),
])
def test_invalid_skill_or_section_cannot_escape_allowlist(skill, section):
    with pytest.raises(ValueError, match="^Unknown .+Agent skill\\.$") as exc:
        read_agent_skill(skill, section)
    assert "credentials" not in str(exc.value)
    assert "example.invalid" not in str(exc.value)
    assert ".env" not in str(exc.value)


def test_reading_does_not_access_files_network_processes_or_environment(monkeypatch):
    def forbidden(*args, **kwargs):
        pytest.fail("Skill reader must not access external capabilities")

    monkeypatch.setattr(Path, "read_text", forbidden)
    monkeypatch.setattr(Path, "read_bytes", forbidden)
    monkeypatch.setattr(socket, "create_connection", forbidden)
    monkeypatch.setattr(subprocess, "Popen", forbidden)
    monkeypatch.setattr("os.getenv", forbidden)
    assert read_agent_skill("image-prompt-reverse")["section"] == "overview"
    assert read_agent_skill("gpt-image", "editing")["section"] == "editing"
    assert len(default_skill_sections()) == 2


def test_results_and_tool_schema_cannot_mutate_shared_skill_state():
    original = read_agent_skill("gpt-image")
    result = read_agent_skill("gpt-image")
    result["content"] = "Changed by a caller"
    result["revision"] = "untrusted"
    assert read_agent_skill("gpt-image") == original
    tool = skill_tool()
    pristine = copy.deepcopy(tool)
    tool["parameters"]["properties"]["skill"]["enum"].append("arbitrary")
    assert skill_tool() == pristine
    assert pristine["strict"] is True
    assert pristine["parameters"]["additionalProperties"] is False
    assert set(pristine["parameters"]["required"]) == {"skill", "section"}


def test_catalog_describes_semantic_chapter_access_without_embedding_all_guidance_or_cli():
    catalog = skill_catalog_instructions()
    assert len(catalog) < 1800
    assert "answer naturally" in catalog and "without forcing a prompt template" in catalog
    assert "read_agent_skill" in catalog
    assert "OPENAI_API_KEY" not in catalog
    assert "uvx" not in catalog
    assert "overview" in catalog and "already" in catalog
    for skill in ("image-prompt-reverse", "gpt-image"):
        assert read_agent_skill(skill)["content"] not in catalog


def test_adaptation_keeps_edit_constraints_without_upstream_execution_defaults():
    editing = read_agent_skill("gpt-image", "editing")["content"]
    assert "必须保留" in editing
    assert "多参考图" in editing
    assert "原文" in editing
    text = read_agent_skill("gpt-image", "text")["content"]
    assert "保留用户原文" in text
    assert "质量档位保持用户当前设置" in text
    for section in ("overview", "composition", "editing", "text"):
        content = read_agent_skill("gpt-image", section)["content"]
        assert "gpt-image-2.5" not in content
        assert "OPENAI_API_KEY" not in content
        assert "uvx --from" not in content


def test_default_foundations_are_fixed_bounded_overviews_without_prompt_routing():
    sections = default_skill_sections()
    assert sections == [read_agent_skill('image-prompt-reverse'), read_agent_skill('gpt-image')]
    assert [(item['skill'], item['section']) for item in sections] == [
        ('image-prompt-reverse', 'overview'), ('gpt-image', 'overview')]
    assert len(json.dumps(sections, ensure_ascii=False).encode('utf-8')) < 7000
    assert all('does not authorize image generation' in item['content'] for item in sections)
    # The API has no prompt/image/context input to classify or trigger on.
    import inspect
    assert not inspect.signature(default_skill_sections).parameters


def test_default_foundations_return_independent_results():
    original = default_skill_sections()
    first = default_skill_sections()
    first[0]['content'] = 'modified by caller'
    first[1]['revision'] = 'untrusted'
    first.append({'skill': 'arbitrary'})
    assert default_skill_sections() == original
