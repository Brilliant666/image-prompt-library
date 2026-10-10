import pytest


@pytest.fixture(autouse=True)
def allow_test_client_hostname(monkeypatch):
    monkeypatch.setenv("IMAGE_PROMPT_LIBRARY_ALLOWED_HOSTS", "testserver")


@pytest.fixture(autouse=True)
def isolate_compatible_provider_config(tmp_path, monkeypatch):
    """Repository/queue tests must never read a developer's real API credentials.

    Individual tests can override this path with their own isolated configuration.
    Leave the default path absent so first-run behavior is still exercised.
    """
    monkeypatch.setenv("IMAGE_PROMPT_LIBRARY_OPENAI_COMPATIBLE_CONFIG_PATH", str(tmp_path / "isolated-compatible-config.json"))


@pytest.fixture(scope="session")
def legacy_release_source(tmp_path_factory):
    """Exercise retained release mechanics in an unmarked, isolated fixture.

    Real source-maintained installations are covered by test_source_maintenance.
    No production flag disables that policy, and no user library is copied.
    """
    from pathlib import Path
    import shutil
    source = Path(__file__).resolve().parents[1]
    index = source / "frontend" / "dist" / "index.html"
    if not index.is_file() or "/image-prompt-library/assets/" in index.read_text(encoding="utf-8"):
        pytest.fail("Legacy installer fixtures require local app assets; run npm run build before pytest.")
    target = tmp_path_factory.mktemp("legacy-release-source")
    for name in ("backend", "scripts", "docs", "tests", "sample-data", ".github", "frontend"):
        shutil.copytree(source / name, target / name, ignore=shutil.ignore_patterns("__pycache__", "node_modules", ".pytest_cache"))
    for name in ("pyproject.toml", "package.json", "package-lock.json", "uv.lock", "LICENSE", "NOTICE", "SECURITY.md", "README.md", "README_zh-CN.md", "README_zh-TW.md", "AGENTS.md", "CONTRIBUTING.md", "ROADMAP.md", ".gitignore", ".env.example", "tsconfig.json", "vite.config.ts"):
        shutil.copy2(source / name, target / name)
    return target
