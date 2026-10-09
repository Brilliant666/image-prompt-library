# 独立维护说明

维护仓库为 [Brilliant666/image-prompt-library](https://github.com/Brilliant666/image-prompt-library)，集成分支为 `main`，日常修改在功能分支完成后通过 PR 合并。原 `codex/sub2api-images` 分支保留为历史记录。本项目基于 [EddieTYP/image-prompt-library](https://github.com/EddieTYP/image-prompt-library)，保留原作者声明及 AGPL-3.0-or-later 许可证；不是从零开发的项目。

## 来源与历史

- 上游基线：`v0.11.2`，已核实的上游提交为 `e3d2ecddeeb09975e27826a4d7e5da2abab8cd99`。
- 本地历史从该版本源码归档初始化，基线快照提交为 `916b6cc18bf7de27e3c4fb666cd5070f899782e6`。此快照不是上游提交本身，也不包含上游完整 Git 历史。
- 迁移前记录的来源 remote 为 `https://github.com/EddieTYP/image-prompt-library.git`；它仅用于来源说明，不设置自动同步任务。
- 2026-10-09：接入 OpenAI 兼容图片供应商，保留 ChatGPT/Codex 与 Grok OAuth；恢复原有比例菜单，复用生成队列实现批量生成，并修复已保存历史结果的操作入口。供应商凭据置于图库之外，请求信息与实际输出信息分别记录。
- 本次独立仓库迁移保留现有本地提交链，不导入私人图库或供应商凭据。

## 从源码开发与启动

使用 Python 3.10+ 和 Node.js 24。在已有源码目录操作，不要重新下载覆盖已有工作区。Windows PowerShell 示例：

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e '.[dev]'
npm ci
npm run build
$env:IMAGE_PROMPT_LIBRARY_PATH = Join-Path $HOME 'ImagePromptLibrary'
.\.venv\Scripts\python.exe -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

运行前确认同一图库没有其他实例运行，且 8000 端口空闲。上例显式使用用户目录中的图库，不复制或迁移数据。新环境请自行选择图库路径。终端按 `Ctrl-C` 停止。macOS/Linux 可使用现有 `scripts/setup.sh`、`scripts/start.sh`，详见 [开发指南](DEVELOPMENT.md)。

已安装的本地定制版仍使用原有 `image-prompt-library start`、`stop` 和 `status` 管理。安装发行目录与源码目录是不同副本；编辑源码不会自动修改安装版。替换安装版前应备份图库、运行测试、构建并逐步停止/更新/启动，保留上一版本作为回退。

```powershell
git status
git add <明确修改的文件>
git diff --cached
git commit -m "Describe the change"
git push -u origin HEAD
```

## 更新与自动化

当前采用源码维护，尚未建立本仓库 Releases。安装上游发行包的更新入口暂停；不要运行来源仓库的远程一键安装命令。未来更新通过本仓库审查后的源码提交完成，不自动合并上游。上游链接保留用于来源、发布历史和致谢，不代表当前定制版的更新源。

CI 对 `codex/sub2api-images` 和 `main` 的推送及 PR 执行现有测试、应用构建与示例构建。Pages 发布、Release 发布和依赖发行包的安装冒烟工作流保留原定义，但使用 job 级 `if: ${{ false }}` 停用；Pages 也移除了推送触发。没有配置公网部署或自动同步。建立自己的发行策略后再明确启用相关流程。

## 依赖审计（2026-10-10）

旧基线的 Vite → PostCSS → `source-map-js@1.2.1` 存在 [GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q)：解析恶意 indexed source map 的偏移量可能阻塞事件循环。这是既有构建工具链依赖问题；图库图片上传和 Python 图片 API 不解析 source map。锁文件已定向更新到修复版 `1.2.2`，未批量升级依赖；使用官方 npm registry 的审计结果为 0 项漏洞。

## 数据边界

Git 只保存源码、测试、锁文件、文档和无密钥配置示例。个人 SQLite、原图、缩略图、生成结果、供应商凭据、OAuth 状态、日志、依赖目录与备份不应上传。已跟踪的上游测试素材和文档图片继续保留。供应商配置说明见 [OpenAI 兼容图片供应商](OPENAI_COMPATIBLE.md)。
