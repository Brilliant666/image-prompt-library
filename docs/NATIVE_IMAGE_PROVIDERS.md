# API image connections: OpenAI compatible, Gemini and Seedream

## Connections and generation settings

For the connection editor, unsaved model discovery and credential handling, see
[API connections](API_CONNECTIONS.md). Discovery is explicit; saving does not
automatically fetch models or execute generation.

API settings retain multiple named connections, defaults, copying, ordering,
manual models and network controls. New connections can start from OpenAI,
Google Gemini, Seedream or custom-relay presets. A preset only fills the unsaved
form. It neither sends a generation request nor grants a model permission.

Each connection explicitly selects `openai_compatible`, `gemini_native` or
`seedream_native`. Protocol means wire format, not ownership of the server:
a relay may expose a native format, and a Gemini-named model may be offered
through an OpenAI-compatible endpoint. The application never guesses from a
model name or retries another endpoint after failure.

Base URL, authentication, default model, network mode and transport belong to
connection settings. Per-image dimensions, aspect ratio, resolution, format and
watermark belong to the Gallery/Agent image controls. Advanced discovery and
transport settings remain available in expandable groups. Changing a saved URL
or protocol requires re-entering the key; stored keys remain outside the library.

Gallery, Agent Hybrid and confirmed-Prompt execution share these connections and
the existing queue. Agent text remains Responses on a separate OpenAI-compatible
connection. Native Agent still means its original Responses image-tool workflow;
it is not silently converted to Gemini or Seedream. Existing OAuth providers
retain their original executors.

## Protocols

| Protocol | Versioned root | Image request | Authentication |
| --- | --- | --- | --- |
| OpenAI compatible | Existing `/v1` rule | Existing generations/edits paths | Existing Bearer key |
| Gemini GenerateContent | `/v1beta`, or an explicitly supplied `/v1` | `/models/{model}:generateContent` | `x-goog-api-key` |
| Seedream Images | `/api/v3` | `/images/generations` | Bearer key |

Use exact-base mode when the documented relay root differs. Known version
suffixes are not appended twice. Keys, query strings and generation/model paths
are not accepted as part of the connection root. URL previews are not connection
tests, and saving a configuration does not prove generation availability.

Gemini model discovery uses bounded paginated GET requests. Only exact documented
image model IDs establish image-output recommendations; an arbitrary name
containing `image` does not. Embedding-only methods are not recommended for image
generation. Unknown aliases remain editable. Seedream discovery presents a built-in
documentation reference list, not an account-access check. Endpoint IDs may be
entered manually. Catalog refreshes do not change the user's selected model.

## Image controls and compatibility

Gemini maps native aspect ratio and resolution into
`generationConfig.imageConfig`; originals enter ordered `inlineData` parts.
The adapter requests a non-streaming completed candidate and ignores intermediate
thought images. Text alongside a final image is allowed. Explicit OpenAI-only
quality, transparency, compression and mask options are not silently discarded:
incompatible values must be explicitly adjusted before submission.

Seedream maps dimensions/tier, optional watermark and supported output format.
Ordered references are sent as data URLs. Documented older models explicitly
use `sequential_image_generation=disabled`; newer single-output models omit the
unsupported field. One existing queue task represents one requested image.
Selecting multiple images continues to create the application's existing set of
single-image tasks, not an implicit provider-side batch. Group generation and
layer decomposition are not enabled in this adapter.

Known models restrict the offered resolution/format combinations. Unknown aliases
remain unverified; the server still applies local safety limits and the supplier
validates actual model availability. Changing protocols has separate remembered
parameters. Restoring a historical recipe does not silently convert incompatible
settings or change its Prompt. A deliberate reset applies native defaults while
leaving the Prompt and references intact.

Native transport is currently non-streaming. Seedream may return Base64 or a URL;
this is result delivery, not reference-image upload. Public result downloads reuse
the existing bounded downloader without forwarding the provider API key. Download
failure does not automatically submit another generation. This version does not
provide remote-URL download resumption after an expiring URL becomes unavailable.

## Local safety and result ownership

The initial adapter limit is four ordered reference images. Gemini inline JSON
has a 20 MiB local request budget. Seedream has a 10 MiB per-reference and 64 MiB
serialized request budget in this application; these local limits are not claims
about every supplier's maximum. Oversize requests fail before submission. No
cloud upload, resizing or local background removal is performed automatically.

The bounded decoded-image limit is 20,000,000 pixels, covering the documented 4K
square and wide/tall Gemini outputs. Existing file-byte bounds and decode checks
remain. Stored originals are byte-for-byte unchanged; thumbnails/previews use
the existing derived-image path. This limit applies consistently to saving,
Library acceptance, frozen references and local-result verification.

Protocol and the native connection identity are frozen with queued tasks. Changing
the connection later cannot redirect an old task. Native requests use the same
confirmed-recipe byte/order verification, local-result registration and recovery
boundaries as the existing API executor. No additional text planning is performed
for a confirmed Hybrid recipe. Retry remains an explicit user action, never an
implicit protocol or supplier fallback.

Only confirmed, validated finals can become successful results. If a response
contains extra finals or a mixture of usable and unsuccessful outputs, all usable
final bytes are retained in the original task directory. The task remains blocked
for inspection rather than silently choosing a winner, fabricating full success
or starting another paid request. Images attached only to refused/incomplete
Gemini candidates are not promoted to successful finals.

## Verification and limits

Protocol and workflow tests use synthetic images and `httpx.MockTransport`.
They cover exact Prompt/reference bytes, configuration identity, Gallery and
Hybrid execution, confirmed recipes, refusal/incomplete outputs, no implicit
retry, local recovery and 4K Library acceptance. Frontend behavior checks cover
protocol-specific controls, saved recipes, defaults and unchanged legacy behavior.
These tests do not establish real account permissions, visual quality, latency,
billing or third-party gateway compatibility. Real-provider tests require a
separate explicit call scope and budget.

Protocol documentation checked when implementing this adapter (2026-11-01):
- Google Generate Content image generation:
  https://ai.google.dev/gemini-api/docs/generate-content/image-generation
- Google model listing: https://ai.google.dev/api/models
- Volcengine Seedream image API:
  https://docs.volcengine.com/docs/ark/image-generation-api

Exact documented capability entries are maintenance hints, not permanent brand-wide
rules. Update the relevant mapper, UI choices and regression examples together
when adding another documented model/version.
