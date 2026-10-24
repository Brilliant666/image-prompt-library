"""The bundled skill reader is finite, side-effect-free and independently usable."""
import copy
import json
import socket
import subprocess
from pathlib import Path

import pytest

from backend.services.agent_skills import read_agent_skill, selected_skill_sections, skill_catalog_instructions, skill_tool


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
    assert selected_skill_sections("请优化这段提示词", False)


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


def test_ordinary_turn_catalog_does_not_embed_full_guidance_or_cli():
    catalog = skill_catalog_instructions()
    assert len(catalog) < 1800
    assert "ordinary chat" in catalog
    assert "read_agent_skill" in catalog
    assert "OPENAI_API_KEY" not in catalog
    assert "uvx" not in catalog
    assert "Apply preloaded sections directly" in catalog
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


@pytest.mark.parametrize("prompt,images,skill,section", [
    ("根据图生成提示词", True, "image-prompt-reverse", "analysis"),
    ("根据参考图片，帮我写出可还原画面的提示词", True, "image-prompt-reverse", "analysis"),
    ("帮我反推这张照片", True, "image-prompt-reverse", "analysis"),
    ("这张图的提示词是什么", True, "image-prompt-reverse", "analysis"),
    ("Reverse-engineer a prompt from this image", True, "image-prompt-reverse", "analysis"),
    ("Extract the image-generation prompt from this photo", True, "image-prompt-reverse", "analysis"),
    ("请优化这段提示词：蓝色小鸟，灰色背景。", False, "gpt-image", "composition"),
    ("请帮我生成一段提示词", False, "gpt-image", "composition"),
    ("Refine this prompt for a watercolor bird", False, "gpt-image", "composition"),
    ("Generate a prompt for a poster with exact text", False, "gpt-image", "text"),
    ("帮我完善这个文字海报的排版提示词", False, "gpt-image", "text"),
    ("生成一张图片：一个橙色方块", False, "gpt-image", "composition"),
    ("帮我画一只蓝色的小鸟", False, "gpt-image", "composition"),
    ("Create an image of an orange square", False, "gpt-image", "composition"),
    ("请修改这张图，保留主体", True, "gpt-image", "editing"),
    ("把这张照片的背景换成蓝色", True, "gpt-image", "editing"),
    ("背景改成红色，保持人物不变", True, "gpt-image", "editing"),
    ("Edit this image to change the sky", True, "gpt-image", "editing"),
    ("Change the background to blue", True, "gpt-image", "editing"),
])
def test_explicit_tasks_preload_a_bounded_overview_and_relevant_section(prompt, images, skill, section):
    results = selected_skill_sections(prompt, images)
    assert [(item["skill"], item["section"]) for item in results] == [(skill, "overview"), (skill, section)]
    assert results == [read_agent_skill(skill, "overview"), read_agent_skill(skill, section)]
    assert all("does not authorize image generation" in item["content"] for item in results)


@pytest.mark.parametrize("prompt,images", [
    ("你好", False), ("你好", True), ("", True), (None, True),
    ("你是什么模型", True), ("这张图片里有什么？", True),
    ("描述一下这张照片", True), ("请只提取图片上的文字", True),
    ("Please OCR this image", True), ("Describe this image", True),
    ("What is in this picture?", True), ("How do I generate an image?", False),
    ("解释一下如何生成图片", False), ("这个生图API怎么配置？", True),
    ("反推图片提示词", False),
    ("根据图生成提示词", False), ("帮我反推图片并生成提示词", False),
    ("介绍一下图片反推的原理", True), ("How can I reverse-engineer this image?", True),
    ("请只提取图片上的提示词文字", True), ("提取图片中的提示词", True),
    ("Transcribe the prompt from this image", True),
    ("不要使用技能，帮我优化这段提示词", False),
    ("不使用技能，帮我生成图片", False),
    ("Don't use skills. Generate an image of a blue square.", False),
    ("Optimize this prompt without skills", False),
])
def test_plain_chat_attachments_and_opt_out_do_not_activate_skills(prompt, images):
    assert selected_skill_sections(prompt, images) == []


def test_only_explicit_continuations_inherit_previous_task():
    previous = "请优化这段提示词：蓝色小鸟"
    assert selected_skill_sections("继续优化", False, previous) == selected_skill_sections(previous, False)
    assert selected_skill_sections("Refine it further", False, previous) == selected_skill_sections(previous, False)
    assert selected_skill_sections("你好", True, previous) == []
    assert selected_skill_sections("描述一下图片", True, previous) == []
    assert selected_skill_sections("继续优化数据库索引", False, previous) == []
    assert selected_skill_sections("Continue explaining the database", False, previous) == []
    assert selected_skill_sections("继续优化，但不要使用技能", True, previous) == []
    assert selected_skill_sections("继续", False, "你好") == []
    # A clear current task wins over an unrelated prior one.
    current = "把这张图片的背景换成蓝色"
    assert selected_skill_sections(current, True, previous)[1]["section"] == "editing"


def test_preload_returns_independent_results_and_does_not_echo_prompt():
    prompt = "请优化这段提示词：synthetic-private-marker"
    first = selected_skill_sections(prompt, False)
    first[0]["content"] = "modified by caller"
    next_result = selected_skill_sections(prompt, False)
    assert next_result[0] == read_agent_skill("gpt-image")
    assert "synthetic-private-marker" not in json.dumps(next_result)
