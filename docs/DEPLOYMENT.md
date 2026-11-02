# 部署指南：完整应用与 Cloudflare / Vercel 静态展示

本文区分**本仓库实际实现**与**平台支持的通用能力**，不能把“支持 FastAPI”当作
“本项目已完成 serverless 适配”。平台说明核对日期：**2026-11-02**。
本地安装、开发和测试先看[快速开始](QUICK_START.md)。

## 选择部署方式

| 需求 | 本仓库对应方式 | 是否有可写私人图库 / Gallery / Agent |
| --- | --- | --- |
| 个人电脑使用 | Python 常驻后端 + 本地构建前端 | 有，数据在本机 |
| 自己的 VPS / 长期运行主机 | 单实例 FastAPI + 持久化磁盘 + 访问控制 | 有，数据在服务器 |
| Cloudflare Pages | 本文静态 demo，Node 构建 | 没有，只展示公开样例 |
| Vercel | 本文静态 demo，明确选择静态构建 | 没有，只展示公开样例 |
| Cloudflare Tunnel + Access | 给已有完整服务提供受控远程入口 | 有，应用仍运行在原主机 |
| Workers Python / Vercel Functions 托管整个应用 | 需要额外适配，不是本文的一键部署路径 | 当前仓库未实现持久化与任务生命周期适配 |

完整应用会使用文件系统中的 SQLite、原图与恢复文件、图库操作锁和进程内后台队列；
前端以同源 `/api`、`/media` 访问后端。依据见
[`backend/main.py`](../backend/main.py)、[`backend/db.py`](../backend/db.py)、
[`generation_queue.py`](../backend/services/generation_queue.py)、
[`frontend/src/api/client.ts`](../frontend/src/api/client.ts)。
这里没有现成 Dockerfile、D1/R2 存储适配器、Vercel Function 入口或多租户账号系统。
不要只设置 `VITE_API_BASE_URL`：当前客户端没有使用这个变量切换完整后端。

<a id="static-demo"></a>
## 1. 先在本地构建静态 demo

以下构建无需 Python、私人图库或任何模型 Key。它使用随源码提供的
`frontend/public/demo-data/` 公开示例，不会自动导出你的图库。
需安装 Node.js 24；从仓库根目录（有 `package.json` 的目录）执行：

```sh
npm ci
npx tsc
npx vite build --mode demo --base /
npx vite preview --host 127.0.0.1 --port 5177 --strictPort
```

打开 <http://127.0.0.1:5177/>。输出目录是 **`frontend/dist`**，不是根目录 `dist`
或 `public`。`--mode demo` 加载已跟踪的 `frontend/.env.demo`，启用
`VITE_DEMO_MODE=true`。`--base /` 用于 `*.pages.dev`、`*.vercel.app` 或自定义域名根路径。

已有 `npm run build:demo` 刻意使用 `/image-prompt-library/`，适合原 GitHub Pages
项目子路径；不要原样用在域名根目录，否则静态资源和 demo JSON 可能 404。
使用 `VITE_BASE_PATH` 不能覆盖脚本内显式的 `--base`，所以本文直接给出构建命令。

部署前应确认：

- `frontend/dist/index.html`、`demo-data/items.json`、`demo-data/clusters.json`、
  `demo-data/tags.json` 和对应媒体存在，浏览/搜索/复制可用。
- Network 中 demo 数据请求返回 JSON/图片，不是 `index.html`；不要求 `/api/health`
  成功。静态站没有完整应用 API，不能用 200 HTML 冒充健康 JSON。
- 没有私人 SQLite、备份、凭据或私人图文进入发布目录。
  不在 `frontend/public` 放私人内容；不配置 `VITE_*` 模型 Key，前端环境值可能进入产物。

静态 demo 的编辑、生图和 Agent 能力被禁用；页面上有示例图片不代表它已连接本机
8000。公开素材的来源与许可仍需保留，见 [sample-data](../sample-data/README.md)。
`vite preview` 仅用于本地检查，线上由托管平台提供静态文件。

<a id="cloudflare-pages"></a>
## 2. Cloudflare Pages：通过 Git 部署只读 demo

在你自己的账号中创建 **Pages** 项目并连接 Git 仓库，注意不要误选“创建 Worker”
后照填 Pages 字段。控制台入口名称可能调整，以官方 [Git integration][cf-git]
和 [Build configuration][cf-build] 为准。

| 设置 | 本项目的值 |
| --- | --- |
| Production branch | 你确认要公开的分支，如 `main` |
| Root directory | 仓库根目录；留空或 `.`，不要填 `frontend` |
| Framework preset | None / 无，由下面的命令显式构建 |
| Build command | `npm ci && npx tsc && npx vite build --mode demo --base /` |
| Build output directory | `frontend/dist` |
| Build environment | `NODE_VERSION=24`、`SKIP_DEPENDENCY_INSTALL=1`，Production 与 Preview 均设置 |
| API Key / Python / 私人数据库 | 不需要，不添加 |

选择 Git 自动部署后，后续指定分支推送会按 Pages 项目设置重新构建；这与你仓库里
被停用的 `.github/workflows/pages.yml` 不是一回事。本次文档不启用任何发布工作流。

第一次发布后，打开 Pages 分配的地址，检查主页、示例详情、搜索及刷新，再考虑
绑定自定义域名。排查 `index.html` 找不到时，先检查 output directory；
排查 `/image-prompt-library/assets/...` 404 时，先检查 `--base /`。
`SKIP_DEPENDENCY_INSTALL=1` 关闭平台的自动安装阶段，由上面的 `npm ci` 按锁文件安装一次，
避免重复安装；Node 与安装控制见 [Build image][cf-image]。

### 已经本地构建，也可 Direct Upload

只上传构建产物，不上传仓库目录或你的图库：

```sh
npx wrangler@4 login
npx wrangler@4 pages project create image-prompt-library-demo
npx wrangler@4 pages deploy frontend/dist --project-name image-prompt-library-demo
```

这些命令会在你执行时登录并发布到账号，**不是文档检查命令**。
项目名按自己的账号修改，后续只需再次部署同一项目。
Cloudflare 文档说明 Direct Upload 项目不能直接切换为 Git integration 项目；
需要 Git 自动构建时优先采用上面的路线。Direct Upload 与文件大小/数量限制见
[官方说明][cf-upload]、[Pages limits][cf-limits]。
核对日 Pages 单个静态文件上限为 25 MiB；不要用该路径承载大体积原图备份。

<a id="vercel"></a>
## 3. Vercel：显式选择静态 demo，而非自动识别 Python 后端

导入你自己的 Git 仓库，在 Build and Deployment 设置中覆盖默认识别结果：

| 设置 | 本项目的值 |
| --- | --- |
| Framework Preset | **Other**；不选择自动检测的 FastAPI |
| Root Directory | 仓库根目录；不要填 `frontend` |
| Node.js Version | `24.x` |
| Install Command | `npm ci` |
| Build Command | `npx tsc && npx vite build --mode demo --base /` |
| Output Directory | `frontend/dist` |
| Function / 模型 Key / Python 环境配置 | 静态路线不需要 |

也可以在自己的部署分支根目录添加以下 `vercel.json`，**本仓库不会因阅读文档就
自动创建或启用它**。`framework: null` 表示不套用自动框架预设：

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "framework": null,
  "installCommand": "npm ci",
  "buildCommand": "npx tsc && npx vite build --mode demo --base /",
  "outputDirectory": "frontend/dist"
}
```

Node 版本仍在项目设置中明确选择。配置字段与构建目录含义见
[Vercel build settings][vc-build]、[vercel.json][vc-json]、[Node versions][vc-node]。
不要将仓库根目录直接设为公开 Output Directory。

部署后检查 `*.vercel.app` 的主页和 `demo-data/items.json`。若变成 Function 报错，
先确认 Framework 与构建参数；若网页能开但始终请求 `/api/items`，说明部署的是普通
完整应用前端而非 demo。不要增加“所有 `/api/*` 都重写到首页”的规则掩盖错误。
当前 demo 的视图导航不需要额外的全路径 rewrite；只有确有客户端路由需求时才加规则，
并继续保留静态资源的正确 MIME 和找不到文件的可诊断性。

### 为什么不直接把 FastAPI 放到 Vercel / Workers？

Vercel 官方确实支持 FastAPI，Cloudflare Python Workers 也提供 ASGI/FastAPI 支持。
但 Vercel Functions 使用只读部署文件系统和临时 scratch 空间，且有请求/响应大小与
执行时长限制；这些不能当作本项目的持久化图库。Cloudflare Python Workers 的文件系统也只是 isolate 内的临时内存空间，
不能保存跨实例的图库；D1 是通过 binding/API 访问的数据库，并不是把当前
`sqlite3.connect()` 的文件路径改个字符串就能使用。
依据：[Vercel FastAPI][vc-fastapi]、[Functions runtimes][vc-runtime]、
[Functions limits][vc-limits]、[Python Workers FastAPI][cf-fastapi]、
[Python Workers 文件系统][cf-python-fs]、[D1][cf-d1]。

因此，“完整应用 serverless 化”还需要设计数据库/媒体存储、持久化任务与恢复、
凭据边界及访问控制，并做迁移和数据安全验证。本指南不把这些未完成工作写成部署成功。
仅将前端放 Pages/Vercel 再连另一台完整后端，也需额外处理同源代理、鉴权、上传、SSE
与代理超时；不是当前支持的一键开关。

<a id="persistent-server"></a>
## 4. 完整应用：持久化服务器上的单实例

适合你自己的 Linux VPS、NAS 或长期在线主机。以下是可按环境调整的部署模板，
不是已经替你安装好的远端实例。先用[快速开始](QUICK_START.md)确认源码版运行正确。

### 准备目录和运行环境

安装 Git、Python 3.11、Node.js 24/npm；具体系统包安装按发行版处理。
以下假设已创建非 root 服务用户 `ipl`，并为它准备可写的目录：

```text
/srv/ipl/app/             审查后的源码与独立依赖
/srv/ipl/state/library/   SQLite、媒体、任务和恢复证据
/srv/ipl/state/private/   凭据与配对，必须在图库之外
/srv/ipl/backups/         完整备份，不作为 Web 静态目录
```

在 `ipl` 用户身份下克隆仓库到 `/srv/ipl/app`，按快速开始的 macOS/Linux 命令安装
锁定依赖并执行 **`npm run build`**，不是 demo 构建。整个 `state`、`private` 与备份目录
仅给服务用户及必要管理员访问。不要把私人状态写进 Git 或前端构建目录。

### 单独保存服务环境

创建 `/srv/ipl/state/runtime.env`（权限 `0600`、归服务用户所有），内容例如：

```dotenv
IMAGE_PROMPT_LIBRARY_PATH=/srv/ipl/state/library
IMAGE_PROMPT_LIBRARY_AUTH_PATH=/srv/ipl/state/private/auth.json
IMAGE_PROMPT_LIBRARY_GROK_AUTH_PATH=/srv/ipl/state/private/grok-auth.json
IMAGE_PROMPT_LIBRARY_CONFIG_PATH=/srv/ipl/state/private/config.json
IMAGE_PROMPT_LIBRARY_OPENAI_COMPATIBLE_CONFIG_PATH=/srv/ipl/state/private/openai-compatible.json
IMAGE_PROMPT_LIBRARY_CAPTURE_CLIENTS_PATH=/srv/ipl/state/private/capture-clients.json
IMAGE_PROMPT_LIBRARY_CAPTURE_ORGANIZER_CONFIG_PATH=/srv/ipl/state/private/capture-organizer.json
```

这里保存路径而不是在公开文档填真实 Key；实际 Key 通过受保护的配置界面保存。
下方 systemd 的 `EnvironmentFile` 负责加载这些变量，后端本身不自动读 `.env`。

### systemd 示例

创建 `/etc/systemd/system/image-prompt-library.service`，先确认用户、工作路径及
解释器都存在，再启用服务：

```ini
[Unit]
Description=Image Prompt Library
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=ipl
Group=ipl
WorkingDirectory=/srv/ipl/app
EnvironmentFile=/srv/ipl/state/runtime.env
Environment=PYTHONUNBUFFERED=1
UMask=0077
ExecStart=/srv/ipl/app/.venv/bin/python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000 --workers 1 --proxy-headers --forwarded-allow-ips=127.0.0.1
Restart=on-failure
RestartSec=5
TimeoutStopSec=infinity

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now image-prompt-library
sudo systemctl status image-prompt-library --no-pager
curl -fsS http://127.0.0.1:8000/api/health
journalctl -u image-prompt-library -n 100 --no-pager
```

`--workers 1` 是本项目的单图库约束，不启用多副本负载均衡；不要用多个服务共享同一个
SQLite/图库目录。优雅停止等待任务排空，不为了维护窗口强杀后台写入。
更新前检查活动和未知任务、按兼容性要求备份；不要把服务进程重启当作收费请求重试。
日志可能含私人来源信息，不直接公开上传。

### 首次远程访问：先用 SSH 转发，不开公网 8000

在自己的电脑另开终端（`server.example.com` 替换为实际服务器）：

```sh
ssh -N -L 8011:127.0.0.1:8000 your-user@server.example.com
```

打开本机 <http://127.0.0.1:8011/>。浏览器与完整后端同源，不需要放开 CORS；服务器
8000 继续仅绑定回环地址。不将仅供开发的 Vite 服务用作正式公网入口。

<a id="cloudflare-tunnel"></a>
## 5. 可选：Cloudflare Tunnel + Access 远程使用完整应用

这是**已有服务器/电脑上的应用**经 Tunnel 访问，不是把后端迁到 Pages。
主机必须持续在线，数据仍在它的持久化磁盘上。

1. **先建立 Access 自托管应用和仅允许指定用户的策略**，再发布域名路由。
   保护整个域名，包括 `/api/*`、`/media/*` 和流式接口，不加公开 bypass。
2. 按 Cloudflare 官方引导安装并运行 `cloudflared`，把受保护域名路由到同机
   `http://127.0.0.1:8000`。隧道凭据留在服务端，不放入 Git/前端。
3. 开启 Tunnel 的 **Protect with Access**，由连接器验证 Access token；
   本项目没有实现 Cloudflare JWT 验证，不能只假定每条请求都经过 Access。
4. 在后端环境添加精确的域名白名单，例如
   `IMAGE_PROMPT_LIBRARY_ALLOWED_HOSTS=library.example.com`。不带协议、端口或通配符。
   保留原 Host，通过可信回环代理正确传递 HTTPS scheme；不要信任任意来源的转发头。
5. 先验证未登录请求受阻，再用授权浏览器检查页面、原图、上传与 SSE。
   私人 API、动态页面和 `/media` 不设置公开缓存；用户主动授权后才测试付费模型。

Cloudflare 官方建议先配置 Access 再建路由，否则公开应用可能被任何互联网用户访问；
还要求保护源站免受绕过。见 [self-hosted application][cf-access]。
本项目的 Host/Origin 检查和浏览器插件配对**不是完整用户登录或多租户授权**，
将允许域名加入白名单不等于已经鉴权。服务器防火墙应继续阻止绕过入口访问 8000。

浏览器采集扩展当前按本地配对边界实现，不能承诺它自动适配远端 Access 登录；
远程入口、账号 OAuth、SSE、上传大小和代理超时需要按实际环境验收。
不要通过取消 Origin 检查、公开接口或给插件长期管理凭据来“解决”不兼容。

## 6. 发布与更新检查

静态演示：检查构建模式、根路径、输出目录、JSON/图片资源和公开素材许可。
完整应用：检查健康版本、实际进程、单实例图库、凭据目录、备份恢复与访问控制。
仅健康接口成功不代表模型权限或付费生图成功。

普通数据备份与回退见 [BACKUP_AND_RESTORE.md](BACKUP_AND_RESTORE.md)；当前源码
维护策略见 [INDEPENDENT_MAINTENANCE.md](INDEPENDENT_MAINTENANCE.md)。本仓库仍不
提供独立 Release 安装包，历史安装器文档不能当作这套定制版本的升级入口。

本指南的平台字段依据下列官方文档；Cloudflare/Vercel 线上账号、费用、域名和 Tunnel
没有因新增此文档自动配置。平台限制会变化，发布前应重新确认。实际本地构建验证与
线上部署验收是两件事。

[cf-git]: https://developers.cloudflare.com/pages/get-started/git-integration/
[cf-build]: https://developers.cloudflare.com/pages/configuration/build-configuration/
[cf-image]: https://developers.cloudflare.com/pages/configuration/build-image/
[cf-upload]: https://developers.cloudflare.com/pages/get-started/direct-upload/
[cf-limits]: https://developers.cloudflare.com/pages/platform/limits/
[vc-build]: https://vercel.com/docs/builds/configure-a-build
[vc-json]: https://vercel.com/docs/project-configuration/vercel-json
[vc-node]: https://vercel.com/docs/functions/runtimes/node-js/node-js-versions
[vc-fastapi]: https://vercel.com/docs/frameworks/backend/fastapi
[vc-runtime]: https://vercel.com/docs/functions/runtimes
[vc-limits]: https://vercel.com/docs/functions/limitations
[cf-fastapi]: https://developers.cloudflare.com/workers/languages/python/packages/fastapi/
[cf-python-fs]: https://developers.cloudflare.com/workers/languages/python/stdlib/
[cf-d1]: https://developers.cloudflare.com/d1/
[cf-access]: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/
