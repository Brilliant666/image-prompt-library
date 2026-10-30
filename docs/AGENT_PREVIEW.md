# Offline Agent browser preview

This developer preview runs the real application, SQLite, Agent worker, image
queue, Gallery and Library. Only provider HTTP is replaced by `httpx.MockTransport`.
All pictures and replies are synthetic. The prompt markers below select mock
scenarios; they are not product classifiers or examples of model quality.

From the repository root, prepare the locked Python environment and frontend:

```sh
uv sync --locked
npm ci --ignore-scripts
npm run build
uv run --locked python scripts/preview_agent.py --port 8766
```

Open **http://127.0.0.1:8766/** and select the Agent conversation **离线 Agent 预览**.
Stop the terminal with **Ctrl+C**. The script prints its PID, local URL and data
directory. Default data is temporary and removed after workers finish on exit.
For inspection after stopping, pass `--data-dir ./preview-data`; the directory
must be new or empty, and it is retained. Do not commit that local data directory.
An existing library is never opened. Port 8000 is rejected; the host is always
127.0.0.1. No `.env` is loaded, application credential paths are isolated before
backend imports, and provider/network fallbacks are blocked.

The preview seeds three geometric reference images in Library, three upload
references, two synthetic API profiles and an empty conversation. Use the normal
UI to select references, change parameters or switch Native/Hybrid. The preview
starts in Hybrid with streaming enabled. Except for P1/P2/P7, enable 生图模式 when
the scenario needs an image. A marker alone never grants image authorization.

P1–P10 identify preview recipes, separately from the user acceptance cases
S1–S10. The table describes expected behavior; browser validation is recorded below.

| Case | Enter / action | Expected production behavior |
| --- | --- | --- |
| P1 | `[preview:text] 普通对话` | Text deltas are saved; one Responses POST, zero Images POSTs. |
| P2 | `[preview:skill] 读取改图章节` | A real `read_agent_skill` call/result is saved, followed by text. |
| P3 | `[preview:image] 生成一张几何图` | One tool call creates a real Gallery job and saved image. |
| P4 | Select quantity **3**; `[preview:batch] 三张独立图片` | A batch tool produces three separate jobs. |
| P5 | Select quantity **3**; `[preview:partial] 三张图片，第二张失败` | Two succeed and one fails. Explicitly retry the failed image with 离线重试配置: only one Images POST is added; no extra Responses POST. |
| P6 | Switch to **Native**, quantity **1**; `[preview:native] 原生图像` | Native partial/final image events persist through the real native result path. |
| P7 | `[preview:slow] 检查停止` then click stop while text streams | The real stop endpoint settles the request without a second POST. |
| P8 | Native + generation enabled; `[preview:unknown] 最终回执前断线` | The stream ends without a receipt. The request becomes unknown; reload/observation does not replay it. |
| P9 | Select a seeded/result image as the editing target; `[preview:edit] 保留主体，换背景` | Real reference IDs and pixels reach image editing; Hybrid uses Images edits. |
| P10 | Branch from an earlier round, send `[preview:text] 从这里继续`; inspect Gallery and save a successful result to Library | Branch history excludes the sibling; Gallery and Library read real persisted records. |

The batch mock respects the selected quantity and request budget. P5 needs at
least two images; selecting three is the normal supported UI choice. A failed
member fails only once for that recipe, so explicit retry succeeds. Switch back
to Hybrid for the Images retry scenario. Unmarked messages receive a plain
synthetic text reply. Generated image sizes are fixture sizes, not provider
claims about requested parameters.

GET **http://127.0.0.1:8766/__preview__/diagnostics** provides read-only aggregate
POST counts, endpoint/byte receipts and seeded image IDs. It is loopback-only;
there is no mutation/reset endpoint. It does not expose prompts, image payloads,
credentials or local filesystem paths. Compare counts before and after an action
to check reload, stop, branch and retry behavior. Real model costs, visual
quality, provider timing/cache and remote cancellation are not measured.

Browser validation with this offline provider has covered:

- Ordinary text, Skill chapter reads and selecting Library images as references.
- Hybrid generation, saving the result to Library and successive image edits.
- Three image jobs with two successes and one failure; after changing the current
  profile, directly retrying the failed member adds exactly one Images POST and
  zero Responses POSTs.
- Switching pages during streaming while preserving the draft; reconnecting after
  a browser network interruption and refreshing without new provider POSTs.
- Stopping a request and then sending a new one; observing the conversation in two tabs.

- Native final image receipt and an interrupted Native response: the successful
  image remains available, while the incomplete result is labeled unknown and
  cannot be collected as a completed image. Refresh added no provider POST.
- Editing an earlier round creates a separate visible branch; switching back
  restores the original later rounds and their image results.
- Blocking the browser's SSE observation URL still completes the next answer
  through read-only polling, with only its one initial provider POST. Gallery
  shows the persisted Native/Hybrid jobs; Library retains its seeded images and
  the explicitly collected result.

These checks use synthetic images and provider replies; real-model visual
results, native IME behavior and paid-provider behavior have not been validated.

## Manual image clipboard acceptance

The preview also exposes **http://127.0.0.1:8766/__preview__/clipboard**, a
loopback-only paste receiver. It reads only the user's native paste event,
displays the pasted image and reports its format, dimensions and transparent
pixel counts. It does not read the clipboard on its own, upload the image or
send its contents to a model. Its network policy blocks outgoing connections.

1. Create a synthetic successful image in the preview, then choose **Copy image**
   on that result. Test PNG, JPEG, WebP and a transparent PNG/WebP separately;
   the preview supplier honors those output-format and background settings.
2. Open the receiver and press **Ctrl+V** (or the platform paste shortcut).
   Confirm a real image is pasted, the visible dimensions/orientation are
   retained, and transparent samples retain transparency. The clipboard may
   contain PNG even when the original file is JPEG or WebP.
3. Separately use **Copy generation Prompt** and paste into a text editor. It
   must copy the execution text, not substitute an image or submit a request.
4. Check denied clipboard permission or an unsupported browser: the application
   must report failure and leave the result available for original-file download.

Record the browser/platform and actual outcomes. Unit tests with a stubbed
`ClipboardItem` or `navigator.clipboard.write`, and scripted DOM paste events,
do not establish native operating-system clipboard acceptance. This procedure
is a reproducible manual check, not a claim that every browser has passed it.

Validation (no listening server or model calls):

```sh
uv run --locked python -m pytest -q tests/test_preview_agent.py
```
