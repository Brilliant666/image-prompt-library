# 快速开始：本地使用、开发和测试

适用于本独立仓库的源码版。英文开发细节见 [Development Guide](DEVELOPMENT.md)，
云端展示与完整服务的区别见 [部署指南](DEPLOYMENT.md)。本仓库尚未提供自己的
Release 安装包；不要用上游安装器覆盖当前版本。

## 1. 先选运行方式

| 目标 | 入口 | 数据在哪里 |
| --- | --- | --- |
| 在自己的电脑管理图片、提示词和生成结果 | 本文第 2～4 节，完整应用 | 你指定的图库；配置另存 |
| 修改代码、测试接口或界面 | 本文第 5～6 节，隔离开发 | `.local-work/dev`，不要使用日常数据 |
| 发布公开只读示例 | [Cloudflare Pages / Vercel](DEPLOYMENT.md#static-demo) | 构建时打包的公开示例，无私人后端 |
| 在服务器运行完整图库和 Agent | [持久化服务器](DEPLOYMENT.md#persistent-server) | 服务器的持久化磁盘，单实例 |

源码目录、图库目录、凭据目录是三件事。前端构建成功不代表已经有后端，
源码更新也不会自动更新另一份已安装的程序。

## 2. 准备源码和工具

需要 Git、Python **3.10+**、Node.js **24** 与 npm。推荐 Python 3.11，与 CI 一致。
先确认 `python --version`（macOS/Linux 使用 `python3 --version`）、`node --version`
和 `npm --version`。Windows 示例是 PowerShell，不是 CMD。

首次安装，在新的源码目录操作：

```sh
git clone https://github.com/Brilliant666/image-prompt-library.git
cd image-prompt-library
git rev-parse --short HEAD
```

已有 checkout 不要重新克隆覆盖。先检查 `git status`；已有安装服务不要与源码版
同时打开同一图库。当前默认开发分支为 `main`，具体更新见第 7 节。

### Windows PowerShell

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install uv==0.12.16
$env:UV_PROJECT_ENVIRONMENT = Join-Path (Get-Location) '.venv'
.\.venv\Scripts\python.exe -m uv sync --locked --extra dev --inexact --python .\.venv\Scripts\python.exe
npm ci
npm run build
```

不必激活虚拟环境，也不必修改系统执行策略。后续均使用 `.venv` 内的解释器。
若 Python 选择错误，在创建环境前改用明确的已安装解释器，例如 `py -3.11`。
依赖同步失败应先处理错误，不要接着启动。

### macOS / Linux

```bash
python3 -m venv .venv
.venv/bin/python -m pip install uv==0.12.16
export UV_PROJECT_ENVIRONMENT="$PWD/.venv"
.venv/bin/python -m uv sync --locked --extra dev --inexact --python .venv/bin/python
npm ci
npm run build
```

`uv.lock` 与 `package-lock.json` 是依赖依据。`--locked` 拒绝悄悄修改锁文件；
本地 `--inexact` 保留环境里的开发工具。不要用 `pip install -e .` 或 `npm update`
代替锁定安装，再把差异当作同一测试环境。已有 POSIX `scripts/setup.sh` 也使用相同
锁定依赖；说明见 [开发指南](DEVELOPMENT.md)。

## 3. 启动完整本地应用

以下为日常使用，监听本机 `127.0.0.1:8000`。先确认端口未被占用、图库没有其他
实例使用；若已经有正在使用的安装版，继续用它的管理入口，不要同时启动本例。

Windows，在刚才安装依赖的终端：

```powershell
$env:IMAGE_PROMPT_LIBRARY_PATH = Join-Path $HOME 'ImagePromptLibrary'
.\.venv\Scripts\python.exe -m uvicorn backend.main:app --host 127.0.0.1 --port 8000 --workers 1
```

macOS/Linux：

```bash
export IMAGE_PROMPT_LIBRARY_PATH="$HOME/ImagePromptLibrary"
.venv/bin/python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000 --workers 1
```

终端应保持开启。访问 <http://127.0.0.1:8000/>；新图库为空是正常现象。
另开终端检查 <http://127.0.0.1:8000/api/health>，应得到包含 `"ok": true`
及版本的 JSON。PowerShell 可用：

```powershell
Invoke-RestMethod http://127.0.0.1:8000/api/health
```

macOS/Linux 可用 `curl -fsS http://127.0.0.1:8000/api/health`。
停止时回到服务终端按 `Ctrl-C`，等待任务退出与图库锁释放；不要强杀所有 Python。
一个图库只运行一个服务进程，不启用多 worker 或多副本共享该目录。

### 数据与配置

| 内容 | 默认或本文指定位置 |
| --- | --- |
| 图片、SQLite、Prompt、Agent 与生成历史 | `$HOME/ImagePromptLibrary`，由 `IMAGE_PROMPT_LIBRARY_PATH` 决定 |
| OAuth、API 连接、配对及应用设置 | 用户主目录下 `.image-prompt-library`，不在图库内 |
| 代码、依赖和前端产物 | checkout、`.venv`、`node_modules`、`frontend/dist` |

仅有源码 clone 不会安装 `image-prompt-library` 全局命令。本文直接运行 Python。
已有安装版的 `status` / `doctor` / `start` / `stop` 只管理那份安装，不管理本文终端。
不要把配置放到图库或 `frontend/public` 内。可移植图库备份不包含外部凭据，
迁移时需单独、安全地备份外部配置。

直接调用 `uvicorn` **不会自动读取 checkout 的 `.env`**；环境变量只对当前终端及
其子进程生效，新终端需要重新设置。POSIX `start.sh` / `dev.sh` 会读 `.env`，
启动前应检查其中的图库、端口与配置路径，不要混用开发和日常设置。

## 4. 第一次使用与可选 AI 配置

先打开“快捷收录”，放入一张图片并粘贴原始提示词，再保存到 Library。
收录、浏览、复制提示词不需要 AI Key。Explore 用于参考浏览，Library 管理资产；
Gallery 保存生成任务，Agent 保存创作对话。

启用 AI 时，进入“设置 → API 配置 → API Key 配置”：

1. 添加连接，先选择官方预设或自定义服务的协议。
2. 填写名称、Base URL 与 Key；已有地址或协议变化时需提供适用的新 Key。
3. 可在保存前“识别模型”，也可直接手填完整模型 ID，再保存连接。
4. Gallery 选择图片连接和参数；Agent Hybrid 分别选择文字 Responses 连接与图片连接。

支持 `openai_compatible`、`gemini_native`、`seedream_native`，不按模型名称猜协议。
Seedream 的“查看参考模型”是静态文档列表，不是 Key 验证；其他目录的读取成功也
不等于已经测试生图。仅声明文字输出的模型不会替换默认图片模型。
保存、切换连接不会自动生成。实际发送 Prompt、参考图和会话上下文可能计费；
先检查所选供应商、模型、图片数和授权。详细行为见 [API 连接](API_CONNECTIONS.md)
及[原生图片协议](NATIVE_IMAGE_PROVIDERS.md)。

## 5. 隔离开发：不要碰日常图库和 Key

继续使用第 2 节的依赖环境，在空白的 `.local-work/dev` 中测试。重用旧测试目录前，
先检查是否有未完成队列；启动可能恢复工作。以下所有凭据路径都与开发图库并列，
不是放入图库子目录。不要复制真实 Key 或私人素材。

Windows：

```powershell
$devRoot = Join-Path (Get-Location) '.local-work/dev'
$env:IMAGE_PROMPT_LIBRARY_PATH = Join-Path $devRoot 'library'
$env:IMAGE_PROMPT_LIBRARY_AUTH_PATH = Join-Path $devRoot 'auth.json'
$env:IMAGE_PROMPT_LIBRARY_GROK_AUTH_PATH = Join-Path $devRoot 'grok-auth.json'
$env:IMAGE_PROMPT_LIBRARY_CONFIG_PATH = Join-Path $devRoot 'config.json'
$env:IMAGE_PROMPT_LIBRARY_OPENAI_COMPATIBLE_CONFIG_PATH = Join-Path $devRoot 'openai-compatible.json'
$env:IMAGE_PROMPT_LIBRARY_CAPTURE_CLIENTS_PATH = Join-Path $devRoot 'capture-clients.json'
$env:IMAGE_PROMPT_LIBRARY_CAPTURE_ORGANIZER_CONFIG_PATH = Join-Path $devRoot 'capture-organizer.json'
.\.venv\Scripts\python.exe -m uvicorn backend.main:app --reload --host 127.0.0.1 --port 8010
```

第二个 PowerShell 终端进入同一 checkout：

```powershell
$env:BACKEND_PORT = '8010'
npm run dev -- --host 127.0.0.1 --port 5177 --strictPort
```

macOS/Linux，第一个终端：

```bash
export IMAGE_PROMPT_LIBRARY_PATH="$PWD/.local-work/dev/library"
export IMAGE_PROMPT_LIBRARY_AUTH_PATH="$PWD/.local-work/dev/auth.json"
export IMAGE_PROMPT_LIBRARY_GROK_AUTH_PATH="$PWD/.local-work/dev/grok-auth.json"
export IMAGE_PROMPT_LIBRARY_CONFIG_PATH="$PWD/.local-work/dev/config.json"
export IMAGE_PROMPT_LIBRARY_OPENAI_COMPATIBLE_CONFIG_PATH="$PWD/.local-work/dev/openai-compatible.json"
export IMAGE_PROMPT_LIBRARY_CAPTURE_CLIENTS_PATH="$PWD/.local-work/dev/capture-clients.json"
export IMAGE_PROMPT_LIBRARY_CAPTURE_ORGANIZER_CONFIG_PATH="$PWD/.local-work/dev/capture-organizer.json"
.venv/bin/python -m uvicorn backend.main:app --reload --host 127.0.0.1 --port 8010
```

第二个终端：

```bash
BACKEND_PORT=8010 npm run dev -- --host 127.0.0.1 --port 5177 --strictPort
```

打开 <http://127.0.0.1:5177/>。Vite 将 `/api` 和 `/media` 转发到 8010；
`BACKEND_PORT` 在 **Vite 所在终端**设置。不要把 5177 的页面误连到日常 8000。
`--strictPort` 避免端口占用后悄悄换到未允许的开发来源。
若必须换前端端口，在后端环境中显式设置
`IMAGE_PROMPT_LIBRARY_DEVELOPMENT_ORIGINS=http://127.0.0.1:5178`，
保持主机名、协议、端口一致。不要设通配 CORS。

## 6. 测试与验收

在隔离配置已生效的终端、checkout 根目录执行。首次做前端和文档相关改动：

```sh
npm run test:frontend
npm run build:extension
npm run test:extension
npm run build
```

后端针对性回归（Windows；macOS/Linux 将解释器替换为 `.venv/bin/python`）：

```powershell
.\.venv\Scripts\python.exe -m pytest -q tests/test_api_connection_drafts.py tests/test_model_catalog.py
```

文档相关检查：

```powershell
.\.venv\Scripts\python.exe -m pytest -q tests/test_readme_contract.py tests/test_quickstart_deployment_docs.py
```

完整 `python -m pytest -q` 包含安装器、进程和平台环境测试，建议在独立 VM 或
CI runner 执行；不要为了全量测试修改日常 Windows PATH。
项目 CI 的三个 job 和确切命令见 [ci.yml](../.github/workflows/ci.yml)。
模拟供应商测试不证明真实权限、模型质量或账单。

纯手动浏览检查可先确认四个工作区可打开、上传合成素材、保存后刷新仍可见。
故障注入和模拟生图使用 [Agent 离线预览](AGENT_PREVIEW.md)，不要对日常图库制造锁库、
损坏文件或批量重放。只验证健康/页面不需要收费调用。

## 7. 源码更新、备份与排错

更新前记录当前 `git rev-parse HEAD`，查看 `git status` 并保留未提交修改。
先在候选环境检查目标代码与依赖，再进入维护窗口，不要运行中覆盖依赖和前端产物。
停服前确认没有活动、排队或结果未知的收费任务；备份数据库/媒体及外部配置，
按更新内容确认数据兼容，保留旧代码和依赖。不使用 `git reset --hard` 清掉现场。

源码版使用现有归档脚本，不要求安装全局管理命令。停服后，以下目录仅为示例，
请选择图库外、未占用的输出位置：

```powershell
.\.venv\Scripts\python.exe scripts/library-archive.py backup --library "$env:IMAGE_PROMPT_LIBRARY_PATH" --backup-dir "$HOME/ImagePromptLibraryBackups"
.\.venv\Scripts\python.exe scripts/library-archive.py verify-backup "$HOME/ImagePromptLibraryBackups/实际生成的文件名.tar.gz" --library "$env:IMAGE_PROMPT_LIBRARY_PATH"
```

macOS/Linux 使用 `.venv/bin/python` 和 `$IMAGE_PROMPT_LIBRARY_PATH`。
恢复是数据替换操作，不是日常验收步骤；先阅读[备份与恢复](BACKUP_AND_RESTORE.md)。
不要仅复制运行中的 `db.sqlite` 而忽略 WAL；旧程序也未必能读取更新后数据。

| 现象 | 优先核对 |
| --- | --- |
| 首页 404、提示 Frontend build not found | 是否在根目录执行 `npm run build`；它应生成 `frontend/dist/index.html` |
| 页面对 API 请求返回 HTML 或无数据 | 是否把完整前端误部署到静态平台；是否缺后端；见部署指南 |
| 页面一直是只读演示 | 是否运行过 `--mode demo`；完整应用重新使用普通 `npm run build`，不要设置 `VITE_DEMO_MODE=true` |
| 图库空白或和原来不同 | 后端的图库路径、工作目录、运行进程是否为目标实例，不要急着重新导入 |
| 数据目录被锁定 | 同图库已有实例或备份操作；正常停止对应进程，不删锁文件绕过保护 |
| 开发写请求 403 | 5177 开发来源与后端允许来源、Vite 的目标端口是否一致 |
| 模型识别失败 | 协议、地址、Key 和网络；可手填，失败不会授权自动生成 |

更多问题见 [Troubleshooting](TROUBLESHOOTING.md)。
