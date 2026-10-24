"""Public README contracts, expressed in each document's language.

These checks deliberately use related terms in the same visible paragraph,
not a shared English sentence or a hidden machine-only marker.
"""

import re


CONCEPTS = {
    "README.md": {
        "independent": r"independent(?:ly)?\s+maint(?:enance|ained)",
        "source": r"(?:source|checkout)",
        "no_installer": r"no\s+(?:release\s+)?installer\s+is\s+offered|no\s+releases\s+yet",
        "protect": r"do\s+not\s+overwrite.{0,90}upstream|do\s+not\s+use.{0,90}upstream",
        "history": r"upstream\s+history|historical\s+release\s+notes",
        "not_current": r"not\s+current\s+releases.{0,80}independent\s+repository",
        "default_provider": r"default\s+ai\s+provider",
        "title": r"suggest\s+title",
    },
    "README_zh-CN.md": {
        "independent": r"独立维护",
        "source": r"源码",
        "no_installer": r"(?:尚无|尚未提供).{0,30}(?:发行安装包|发行安装程序|Releases)",
        "protect": r"(?:请勿|不要).{0,50}上游.{0,40}(?:覆盖|覆写)",
        "history": r"上游历史|历史发行说明",
        "not_current": r"不是.{0,30}独立仓库.{0,15}当前发行版",
        "default_provider": r"默认\s*(?:AI\s*)?供应商",
        "title": r"建议标题",
    },
    "README_zh-TW.md": {
        "independent": r"獨立維護",
        "source": r"原始碼",
        "no_installer": r"(?:尚無|尚未提供).{0,30}(?:發行安裝程式|發行安裝包|Releases)",
        "protect": r"(?:請勿|不要).{0,50}上游.{0,40}(?:覆蓋|覆寫)",
        "history": r"上游歷史|歷史發行說明",
        "not_current": r"(?:並非|不是).{0,30}獨立倉庫.{0,15}(?:目前|當前)發行版",
        "default_provider": r"預設\s*(?:AI\s*)?供應商|default\s+ai\s+provider",
        "title": r"建議標題",
    },
}


def visible_paragraphs(markdown: str) -> list[str]:
    markdown = re.sub(r"<!--.*?-->", "", markdown, flags=re.S)
    markdown = re.sub(r"```.*?```", "", markdown, flags=re.S)
    return [re.sub(r"\s+", " ", part).strip() for part in re.split(r"\n\s*\n", markdown)]


def has_concept(text: str, filename: str, concept: str) -> bool:
    return bool(re.search(CONCEPTS[filename][concept], text, re.I))


def assert_source_maintenance_notice(markdown: str, filename: str) -> None:
    paragraphs = visible_paragraphs(markdown)
    maintenance = [part for part in paragraphs if re.search(
        r"\[[^\]]+\]\(docs/INDEPENDENT_MAINTENANCE\.md(?:#[^)]+)?\)", part
    )]
    assert any(all(has_concept(part, filename, concept) for concept in (
        "independent", "source", "no_installer", "protect"
    )) for part in maintenance), f"{filename}: linked maintenance notice must explain source-only distribution and protect it from upstream overwrites"
    assert "https://github.com/Brilliant666/image-prompt-library" in markdown
    assert "https://github.com/EddieTYP/image-prompt-library" in markdown
    # The README must not turn retained upstream history into an install entry.
    assert not re.search(r"(?:curl|irm|iwr|Invoke-WebRequest)[^\n]*raw\.githubusercontent\.com/EddieTYP", markdown, re.I)


def assert_upstream_release_history(markdown: str, filename: str) -> None:
    for version in ("v0.11.0", "v0.11.2"):
        linked = [part for part in visible_paragraphs(markdown) if re.search(
            rf"\[[^\]]*{re.escape(version)}[^\]]*\]\(docs/releases/{re.escape(version)}\.md\)", part
        )]
        assert linked, f"{filename}: missing visible {version} history link"
        assert any(has_concept(part, filename, "history") and has_concept(part, filename, "not_current") for part in linked), (
            f"{filename}: {version} must be identified as upstream history, not this repository's current release"
        )


def assert_grok_readme_features(markdown: str, filename: str) -> None:
    text = " ".join(visible_paragraphs(markdown))
    assert "Grok OAuth" in text and "via Grok" in text
    assert has_concept(text, filename, "default_provider"), filename
    assert has_concept(text, filename, "title"), filename
