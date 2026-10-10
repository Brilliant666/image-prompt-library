# OpenAI-compatible image provider

This local extension adds `openai_compatible` alongside the upstream ChatGPT / Codex and Grok OAuth providers. It reuses the existing generation queue, reference-image preparation, result preview and acceptance into the Library.

## Configure

Open Config → Third-party API and add an endpoint with its own name, Base URL, API key, optional default image model and timeout (1–1800 seconds). Register multiple endpoints, edit them independently, and choose a default for new drafts. The endpoint name appears in the generation provider menu; “Third-party API” identifies the connection type. The Base URL may include `/v1`; trailing duplicate `/v1` segments are normalized. Use HTTPS for remote providers. Saving settings does not send a generation request. An empty API key field preserves only the selected endpoint’s stored key; a new endpoint never inherits another key. The key is never returned by the settings API and is not saved in browser storage.

Settings live in `~/.image-prompt-library/openai-compatible.json`, outside the Library. `IMAGE_PROMPT_LIBRARY_OPENAI_COMPATIBLE_CONFIG_PATH` can override this location in the process environment. The application rejects paths inside the active Library. Library backups and exports do not include this file; protect it separately as a credential file.

Choose the connection type in Config and the named endpoint in the generation composer. A model remains required for each request: the optional profile default preselects it, while the model icon menu also accepts a custom full model ID. This provider supports images only. Title suggestions remain unavailable when it is selected and never silently fall back to another account. Existing OAuth settings and endpoint addresses are unchanged.

## Requests and results

Text-only requests use synchronous `POST /v1/images/generations`; references use multipart `POST /v1/images/edits`. Each queue task sends `n=1`, with up to four references. New composer requests use ratio-only controls and `size=auto`; a chosen ratio is appended to the outgoing prompt while the original prompt is retained separately. Actual dimensions are determined by the service, not guaranteed by quality. Historical explicit sizes remain unchanged until a new ratio is selected. Saved request snapshots take precedence.

## GPT Image 2.5 controls (2026-10-09)

Choose `gpt-image-2.5-flare` or `gpt-image-2.5-sunburst` by full name. Configured and historical model names remain available; enter other service-specific models in the model menu or as a profile default in settings. Per-request choices do not change provider defaults. The recognized Image 2.5 names (including their `2026-09-08` snapshots) support `auto`, `low`, `medium`, `high`, `xhigh`, and `max`. Quality choices depend on the model, not the provider display name. An unknown legacy request model requires an explicit choice before another request.

The composer defaults to automatic ratio, quality and background, with PNG output. Explicit pixel sizes remain supported by the API and historical recipes. For Image 2.5 both dimensions must be positive multiples of 16, neither above 3840, longest/shortest ratio ≤3, and total pixels 655360–8294400 inclusive. `2160x3840` passes this validation; `2880x3840` does not. Local validation does not guarantee gateway support.

Background supports `auto`, `opaque`, `transparent`; output supports PNG, JPEG and WebP. Transparent + JPEG is blocked without erasing the background choice. JPEG/WebP compression supports integers 0–100; PNG omits compression. Originals are saved byte-for-byte. Newly created transparent previews and thumbnails preserve alpha, with checkerboard only in CSS; existing assets are not rebuilt. Downloads use the original file.

Settings follow single, batch, edit, history/draft and saved-image reuse. A queued batch freezes each request model/settings and endpoint ID before execution, so changing the default endpoint does not reroute queued jobs. History and saved-image drafts restore that endpoint; a deleted endpoint blocks execution and requires an explicit choice in a new draft. Credentials are resolved from that endpoint’s current configuration at execution time, so edit an existing endpoint’s URL only after its queue has finished, or add a new endpoint instead. Prompt text is preserved, including whitespace; variable expansion only applies when using an actual template.

Sources: [official image generation guide](https://developers.openai.com/api/docs/guides/image-generation), [Images API reference](https://developers.openai.com/api/reference/resources/images/methods/generate). Documented model names do not establish access for a particular gateway/key.

Generation POST requests are never automatically retried or redirected. Failed or interrupted jobs remain failed. A timeout does not establish whether the service charged the request: check the service before manually retrying. Explicit retry is a new request.

The existing generation-count menu supports batches of 3, 5, or 10 images. Each batch uses the original queue with a separate single-image request per job, rather than a multi-image API response. Selecting a batch submits that many potentially billable requests. A failed job does not automatically retry.

History actions follow result state, not recency. Unsaved successful results retain the original save, reference, retry and discard actions. Saved results can still be reused as references or restored as a draft for another explicit generation. Saving or discarding an already accepted result is not repeated through the transient-result API.

The implemented response contract is one `data` entry containing `b64_json`. Image bytes must pass decoding before the result is accepted. URL-only responses are deliberately rejected until that service's response contract is verified. HTTP 200 or a model listing alone is not generation success.

Result metadata retains requested parameters separately from service-reported fields and decoded image dimensions. A returned model label is a service claim, not an independent model-identity verification. Missing model data is left unknown. Images saved into the Library use the returned model, never the requested model as a substitute. User-entered card metadata remains editable.

## Keep this extension during upstream updates

The independently maintained repository uses source updates; upstream release installation remains disabled. The procedure below describes a reviewed manual port, not automatic upstream synchronization.

This source snapshot is based on upstream v0.11.2, commit `e3d2ecddeeb09975e27826a4d7e5da2abab8cd99`. Its local baseline snapshot is not the upstream Git commit. The branch `codex/sub2api-images` contains the local patch. Keep this source repository and its exported patch/bundle separately from Library backups.

Do not expect the upstream updater to merge local changes: an ordinary update selects an unmodified upstream release and the custom provider may disappear, although its separate configuration file and Library remain. Before updating:

1. Stop the app and create/verify a Library backup.
2. Obtain the intended upstream version in a separate checkout.
3. Apply the saved patch, review conflicts, and run provider, queue, OAuth, backup, frontend and build checks. Do not automatically rerun paid API requests.
4. Package the build under a new custom version name and preserve the previous version for rollback.
5. Switch the installed version only after stopping the managed process. Verify health, existing Library data, settings and preview/save behavior.

No schema replacement, credential migration or upstream OAuth change is required for this extension. Roll back the application version separately from Library data; do not restore an old database merely to switch application code.

## Diagnostics and free verification

Gallery recipe restoration and history drafts restore the original ordered input images, not the generated output. Inline inputs are snapshotted as durable references; legacy recipes expose recoverable originals without exposing data URLs. Missing or unreadable inputs remain visible and block submission until replaced or explicitly converted to text-only generation. Editing the draft or leaving it invalidates pending restoration responses.

For explicit requested aspect ratios, decoded dimensions are compared with a 1% relative ratio tolerance: `abs(actual_ratio / requested_ratio - 1) <= 0.01`. Automatic size does not disable this check. An explicit pixel size remains authoritative; an incompatible composition ratio is reported as a request-settings conflict, separately from an actual file-size mismatch. Service-reported dimensions are never used in place of decoded pixels. Warnings preserve the original image and do not trigger transformations or retries.

"Configured" means local fields are complete, not that credentials, image permissions or a real generation have been verified. Saving configuration performs no paid call. Inspect a result's Generation Record for requested settings, service-returned labels, top-level/item differences, actual width/height/format/alpha, timestamps, request ID and elapsed time. Missing service fields remain unknown. A small or differently formatted result is preserved and marked as a mismatch, never automatically resized or retried. A returned model is a service label, not proof of the actual upstream route.

Failures retain bounded, redacted structured diagnostics for authentication, group/permissions, route/model, rate limit, upstream failure, network/timeouts, non-JSON gateway pages, missing image, invalid base64 and invalid image data. Neither elapsed time nor local cancellation proves upstream work stopped or was not billed. Check service logs before explicitly submitting again.

Run `python -m pytest tests/test_openai_compatible.py tests/test_compatible_recipe.py tests/test_generation_alpha.py tests/test_image_store.py -q`, `npm run test:frontend` and `npm run build`. Tests use temporary libraries and mocked HTTP, without production keys or paid requests.

After separate authorization and a stated budget, manually submit one Flare/low/1024x1024/opaque/PNG image through the UI. Check decoded pixels, request ID and usage before any additional call; no automatic retry. Sunburst comparisons, xhigh/max, 4K and transparency are separate cost-bearing tests. Use the gateway's actual bill, not an OpenAI price estimate.

The reviewed sub2api source baseline is `3a6fd1c9db07203ca308aaba69e502bc1f35b307`; this is not evidence of the deployed service version. Gateway version, key group/image permission, account availability, model mapping, actual upstream model/endpoint, balance and limits need authorized server-side evidence. Do not change server settings or omit requested parameters to bypass routing restrictions. Synchronous image endpoints remain in use. Async requires separately verified object storage, task polling, safe original downloads and restart recovery; do not automatically resubmit a timed-out synchronous request through async.

## Existing installations and reference defaults (2026-10-10)

Existing single-endpoint configuration is read as the stable `legacy` profile without rewriting the file on startup. Saving settings upgrades the same credential file to a multi-profile structure. Historical jobs without a profile ID remain associated with `legacy`, never with a subsequently selected default. Keep a separate secure copy of the credential file before downgrading to a version that only understands the old format.

The composer uses compact model, ratio, quality and output controls. Full model IDs and current values remain available in menus and tooltips. New reference forms, including “Save as new reference”, default the original prompt language to Simplified Chinese. This only sets the language marker; it does not translate the prompt or change existing references.
