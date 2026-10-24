from pathlib import Path

import pytest

from readme_contract import CONCEPTS, assert_source_maintenance_notice, assert_upstream_release_history


ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.parametrize("filename", CONCEPTS)
def test_readme_distribution_and_history_meaning(filename):
    text = (ROOT / filename).read_text(encoding="utf-8")
    assert_source_maintenance_notice(text, filename)
    assert_upstream_release_history(text, filename)


@pytest.mark.parametrize("filename", CONCEPTS)
@pytest.mark.parametrize("mutation", ("hide_notice", "offer_installer", "remove_history_link", "claim_current_release", "install_upstream"))
def test_readme_contract_rejects_misleading_distribution(filename, mutation):
    text = (ROOT / filename).read_text(encoding="utf-8")
    if mutation == "hide_notice":
        notice = next(part for part in text.split("\n\n") if "docs/INDEPENDENT_MAINTENANCE.md" in part)
        text = text.replace(notice, f"<!-- {notice} -->")
    elif mutation == "offer_installer":
        old, new = {
            "README.md": ("no release installer is offered", "a release installer is offered"),
            "README_zh-CN.md": ("尚无本仓库的 Releases 或发行安装包", "提供本仓库的 Releases 和发行安装包"),
            "README_zh-TW.md": ("尚未提供發行安裝程式", "已提供發行安裝程式"),
        }[filename]
        assert old in text
        text = text.replace(old, new)
    elif mutation == "remove_history_link":
        text = text.replace("docs/releases/v0.11.0.md", "docs/releases/missing.md")
    elif mutation == "claim_current_release":
        old, new = {
            "README.md": ("not current releases of this independent repository", "current releases of this independent repository"),
            "README_zh-CN.md": ("不是本独立仓库的当前发行版", "是本独立仓库的当前发行版"),
            "README_zh-TW.md": ("並非本獨立倉庫的目前發行版", "是本獨立倉庫的目前發行版"),
        }[filename]
        assert old in text
        text = text.replace(old, new)
    else:
        text += "\n```sh\ncurl -fsSL https://raw.githubusercontent.com/EddieTYP/image-prompt-library/main/scripts/install.sh | bash\n```\n"
    with pytest.raises(AssertionError):
        assert_source_maintenance_notice(text, filename)
        assert_upstream_release_history(text, filename)


def test_english_contract_allows_case_changes_and_model_candidates():
    text = (ROOT / "README.md").read_text(encoding="utf-8")
    text = text.replace("no release installer is offered", "No release installer is offered")
    text += "\nModel candidates are suggestions, not compatibility verification.\n"
    assert_source_maintenance_notice(text, "README.md")
    assert_upstream_release_history(text, "README.md")
