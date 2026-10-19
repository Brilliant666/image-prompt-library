# Playground workspaces

Image Prompt Library remains the asset library and the only generation task store.
The gallery, Agent workspace and grouped settings adapt interaction and source
code from [CookSleep/gpt_image_playground](https://github.com/CookSleep/gpt_image_playground),
pinned to `1e9d5af60aadd9117a835cc2da43908b8e3370dd` (2026-10-19).

The source is MIT licensed, copyright 2026 CookSleep; its complete license is
retained in [Playground-MIT.txt](../licenses/Playground-MIT.txt). The existing
Image Prompt Library license and attribution remain in effect.

Adaptations replace the source's browser database, credentials and direct provider
requests with this project's server-side profiles, generation queue and library.
No Playground installer, updater, remote announcement, sponsor configuration or
preconfigured account is included.

The source `virtualGrid.ts` and `useVirtualGrid.ts` are reused for virtual layout
and rectangular selection. Lightbox wheel zoom, pan, pinch, double-tap and swipe
handling comes from `src/components/Lightbox.tsx`, with scoped styles and this
project's focus management. Image dragging outside these controls remains enabled.

The new workspaces require a local backend; the static example site continues to
offer Explore and Library without prompting for provider credentials.

## Using the workspaces

The navigation is **Explore / Library / 画廊 (Gallery) / Agent**. Quick capture and
the settings button remain available without an image or text API account.
Workspace navigation retains the composer, filters, selection and scroll position.
Tasks and conversations live on the server; reopening a page never submits them.

In Gallery, enter a prompt, optionally choose Library/history images or upload,
paste or drop image files, and select an API profile. Model ID, pixel size,
quality, background, output format and compression are separate request settings.
The existing 4K target resolver and prompt variables are retained. A target is
not a promise of the returned resolution; the details view distinguishes the
request, reported response and decoded file. Original image bytes are retained.
URL-only browser drags need an actual downloaded/copied image; they are not
treated as uploaded files.

One submission creates one job or an existing 3/5/10-job generation set. Results
can be selected, downloaded as originals in a ZIP, inspected in the zoomable
lightbox, restored for another request, or saved as a new Library reference or
attached to an existing reference. Clearing a generation result does not delete
an already accepted Library image. Protected Agent references remain usable.
History loads in pages; search and status filters cover the loaded pages, and
**Load more** makes older pages available.

Settings are grouped into API, General, Agent, Capture, Data and About. API
profiles retain their stable IDs and independent keys. Copying a profile happens
on the server; keys are never returned to the browser for copying. Reordering
does not change the default. Existing ChatGPT/Codex OAuth, Grok OAuth and the
capture organizer keep their separate credentials and protocols. The organizer
still uses Chat Completions; Agent uses Responses.

General preferences apply only to the Gallery and Agent composers, not the
browser capture extension. Input persistence is opt-in and local to this browser.
An unresolved Agent submission always retains its frozen request receipt so
closing the page cannot accidentally turn it into a new paid request.

## Agent requests and authorization

Choose a full text model ID and a compatible API profile in Agent settings.
Saving these settings does not test the endpoint or spend model credits.

- **Hybrid**: Responses text/tool calls use the text profile. Validated
  `generate_image`, `generate_image_batch` and `continue_generation` calls create
  jobs in the existing image queue, using the separately selected image profile.
- **Native**: Responses `image_generation` results enter the same image decoding,
  task and Library acceptance flow. The application does not call Images again
  after receiving a native result. Text and image-tool models remain separate.
- **Current API / independent configuration off**: use the profile explicitly
  selected in the Agent workspace for the native Responses route. A text model
  is still required; an image-model name is not assumed to be a text model.

Image generation is off for a new turn until **Allow images for this turn** is
selected. The turn freezes its image limit and maximum Responses steps; web search
also needs both its configuration switch and explicit turn authorization. These
limits bound the application's dispatches, not a provider's price or billing.

Only selected reference images and the selected conversation branch are sent.
`@图1` addresses a current attachment; `@第2轮图1` addresses an output on the
current branch. Editing or regenerating a message creates another branch and
keeps the old one. A missing reference is reported rather than substituted.
Model tool arguments cannot provide arbitrary file paths, URLs, shell commands,
credential changes or asset-deletion instructions.

Stop prevents new calls. An already submitted upstream request may still finish
or be billed. HTTP failures, disconnections and unknown outcomes do not trigger
automatic paid POST retries. Durable request IDs, step claims and tool/job
associations prevent browser reconnection and duplicate events from creating the
same job again. A known-safe interrupted continuation requires an explicit
resume; changed profile identity, deleted conversation or unknown sent step blocks
it. Native results restored from Gallery return to their Agent conversation,
preserving the original route.

The Responses parser accepts JSON and SSE. Text and partial-image events are
progress only; they are not a final successful image. Final images still undergo
real decoding. Empty image output, refusal and interrupted streams remain visible
errors. Provider-origin diagnostics and persisted response fields are sanitized.

## Source adaptation and capability status

| Source area | Integration | Status |
| --- | --- | --- |
| `virtualGrid.ts`, `useVirtualGrid.ts` | Reused measured virtualization and rectangular selection; adapted for hidden workspaces | Local behavior and browser verification |
| `TaskGrid`, `TaskCard`, `InputBar`, `DetailModal` | Adapted layout and operations to existing generation jobs, recipes, profiles and Library acceptance | Local HTTP mock and browser verification |
| `Lightbox`, `clickSuppression` | Reused zoom, pan, pinch, double-tap, swipe and click suppression; scoped styles/focus handling | Desktop browser verification; physical touch gestures need device acceptance |
| `AgentWorkspace`, conversation/reference/response helpers | Adapted branch, mention, message and tool-result semantics; server-owned request lifecycle | Local HTTP JSON/SSE and browser verification; real providers unverified |
| `SettingsModal`, settings/profile interactions | Grouped dialog, list edit/copy/order, local workflow preferences | Local tests and browser verification |
| Native Responses image tool | Shared result validation and storage, no second Images request | Implemented and mock-tested; real provider support unverified |
| Streaming text / partial images | Server processes SSE and UI polls durable progress | Mock-tested; real provider streaming unverified |
| Web search | Explicitly authorized Responses built-in tool and citation display | Implemented; no paid search performed |
| Native transparency | Existing background/format parameters and alpha-preserving original/derived files | Local synthetic tests; real provider support unverified |
| Mask editing | Native mask upload/target validation protocol | Backend tests only; source paint/mask editor UI not ported |
| Canvas and comment annotations | — | Not ported in this iteration |
| Multiple prompt batch editor | Existing identical-prompt generation sets; Agent batch tools | Source multi-prompt editor not ported |
| Multiple Gallery favorites/groups | Existing Library Collections remain authoritative | Source separate favorites store not ported |
| Local background removal | — | Not ported; no original is overwritten |
| Asynchronous/custom HTTP providers | — | Not ported; no unsupported switch is exposed |

The source browser IndexedDB asset database, direct provider-key handling and
front-end scheduler are intentionally replaced by the existing backend contracts.
No extra Node service or second asset library is introduced.

## Persistence, backups and compatibility

Migration `014_agent_workspaces.sql` incrementally adds Agent config, conversations,
rounds, requests, steps, tool/job links, reference snapshots and resume receipts
to the existing SQLite database. Agent images use the existing generation-reference
and generation-result directories. Portable backups include these rows and files;
restore validates their schema and paths. They do not include external provider,
OAuth, pairing or organizer credentials.

Use the existing `image-prompt-library backup`, `verify-backup` and `restore`
commands. Stop the isolated/application instance before operations requiring its
library lease. Restore to a separate directory first when checking a backup.
Old databases upgrade in place; old application versions are not promised to
understand a newer database or the separately stored multi-profile credential
format. Preserve a pre-upgrade backup and compatible external configuration when
planning a downgrade. Never copy a test library over a daily library.

## Verification boundary

Regression tests use isolated libraries, synthetic images and controllable local
HTTP JSON/SSE responses. They exercise tool dispatch, real image decoding,
idempotency, branch references, limits, stop/restart, archive restore and secret
redaction. Frontend tests cover recipe preservation, draft restoration, navigation,
late responses and submission duplication. Existing capture/extension and installer
checks remain enabled. Test or CI success does not verify a commercial provider,
its content moderation, charges, native image resolution or model identity.

Changing source or merging a PR does not update an installed running application.
Use a separate loopback preview and explicit isolated paths when evaluating these
workspaces; deployment to a daily library is a separate operation.
