"""Documented setup targets must match the actual source and safety boundaries."""
import ast
import json
from pathlib import Path
import re

import pytest

ROOT = Path(__file__).resolve().parents[1]
README_NAMES = ('README.md', 'README_zh-CN.md', 'README_zh-TW.md')


def read(path):
    return (ROOT / path).read_text(encoding='utf-8')


@pytest.mark.parametrize('name', README_NAMES)
def test_readmes_offer_source_development_and_explicit_static_routes(name):
    text = read(name)
    for required in ('docs/QUICK_START.md', 'docs/DEVELOPMENT.md', 'docs/DEPLOYMENT.md',
                     'docs/API_CONNECTIONS.md', 'docs/NATIVE_IMAGE_PROVIDERS.md',
                     'git clone https://github.com/Brilliant666/image-prompt-library.git',
                     'Python 3.10+', 'Node.js 24', 'uv==0.12.16', '--locked', 'npm ci',
                     'npm run build', '--workers 1', 'Cloudflare', 'Vercel', 'frontend/dist',
                     'vite build --mode demo --base /', 'Other', 'openai_compatible',
                     'gemini_native', 'seedream_native'):
        assert required in text, (name, required)
    assert 'raw.githubusercontent.com/EddieTYP' not in text
    assert '16,000,000' not in text
    constants = ast.parse(read('backend/services/image_store.py'))
    limit = next(node.value.value for node in constants.body if isinstance(node, ast.Assign)
                 and any(isinstance(t, ast.Name) and t.id == 'MAX_IMAGE_PIXELS' for t in node.targets))
    assert f'{limit:,}' in text


def test_quickstart_has_isolated_paths_and_real_archive_cli():
    text = read('docs/QUICK_START.md')
    for suffix in ('PATH', 'AUTH_PATH', 'GROK_AUTH_PATH', 'CONFIG_PATH',
                   'OPENAI_COMPATIBLE_CONFIG_PATH', 'CAPTURE_CLIENTS_PATH',
                   'CAPTURE_ORGANIZER_CONFIG_PATH'):
        assert f'IMAGE_PROMPT_LIBRARY_{suffix}' in text
        assert f'IMAGE_PROMPT_LIBRARY_{suffix}' in read('backend/config.py')
    for required in ('--port 8010', '--port 5177 --strictPort', 'BACKEND_PORT',
                     'IMAGE_PROMPT_LIBRARY_DEVELOPMENT_ORIGINS', '不必修改系统执行策略',
                     '不会自动读取', 'scripts/library-archive.py backup',
                     'scripts/library-archive.py verify-backup', 'WAL'):
        assert required in text
    script = read('scripts/library-archive.py')
    assert '"backup"' in script and '"verify-backup"' in script


def test_static_instructions_match_build_inputs_without_changing_existing_default():
    deployment = read('docs/DEPLOYMENT.md')
    package = json.loads(read('package.json'))
    assert package['scripts']['build:demo'].endswith('--base /image-prompt-library/')
    assert 'root: \'frontend\'' in read('vite.config.ts')
    assert "outDir: 'dist'" in read('vite.config.ts')
    assert 'VITE_DEMO_MODE=true' in read('frontend/.env.demo')
    assert 'npx vite build --mode demo --base /' in deployment
    assert '`frontend/dist`' in deployment
    assert 'NODE_VERSION=24' in deployment
    assert 'SKIP_DEPENDENCY_INSTALL=1' in deployment
    json_blocks = re.findall(r'```json\n(.*?)\n```', deployment, re.S)
    config = next(json.loads(block) for block in json_blocks if 'outputDirectory' in block)
    assert config['framework'] is None
    assert config['installCommand'] == 'npm ci'
    assert config['outputDirectory'] == 'frontend/dist'
    assert '--mode demo --base /' in config['buildCommand']
    assert 'functions' not in config and 'rewrites' not in config


def test_cloud_guide_distinguishes_framework_support_from_project_adaptation():
    text = read('docs/DEPLOYMENT.md')
    for required in ('FastAPI', 'SQLite', '进程内后台队列', '--workers 1',
                     '127.0.0.1', 'Access', 'Protect with Access',
                     'IMAGE_PROMPT_LIBRARY_ALLOWED_HOSTS', '不是完整用户登录',
                     '当前仓库未实现', 'VITE_API_BASE_URL', '不会',
                     'vercel.com/docs/functions/runtimes',
                     'developers.cloudflare.com/workers/languages/python/packages/fastapi/',
                     'developers.cloudflare.com/pages/configuration/build-configuration/'):
        assert required in text, required
    assert 'sqlite3.connect()' in text and 'D1' in text
    assert '2026-11-02' in text


def test_current_source_notes_do_not_misrepresent_upstream_as_new_distribution():
    text = read('docs/releases/unreleased.md')
    assert 'independent source edition' in text
    assert 'no standalone Release' in text and 'source-only' in text
    assert '../API_CONNECTIONS.md' in text and '../DEPLOYMENT.md' in text
    assert 'No unreleased changes' not in text
    install = read('docs/INSTALLATION.md')
    assert install.index('## Current source edition') < install.index('## Native Windows')
    assert 'Historical upstream installer' in install


def test_new_guides_do_not_embed_real_machine_paths_or_private_configuration():
    for name in (*README_NAMES, 'docs/QUICK_START.md', 'docs/DEPLOYMENT.md'):
        text = read(name)
        assert 'C:\\Users\\' not in text and 'C:/Users/' not in text, name
