# OpenAI-compatible image provider

This local extension adds `openai_compatible` alongside the upstream ChatGPT / Codex and Grok OAuth providers. It reuses the existing generation queue, reference-image preparation, result preview and acceptance into the Library.

## Configure

Open Config → Third-party API and add an endpoint with its own name, Base URL, API key, optional default image model and timeout (1–1800 seconds). Register multiple endpoints, edit them independently, and choose a default for new drafts. The endpoint name appears in the generation provider menu; “Third-party API” identifies the connection type. The Base URL may include `/v1`; trailing duplicate `/v1` segments are normalized. Use HTTPS for remote providers. Saving settings does not send a generation request. An empty API key field preserves only the selected endpoint’s stored key; a new endpoint never inherits another key. The key is never returned by the settings API and is not saved in browser storage.

Settings live in `~/.image-prompt-library/openai-compatible.json`, outside the Library. `IMAGE_PROMPT_LIBRARY_OPENAI_COMPATIBLE_CONFIG_PATH` can override this location in the process environment. The application rejects paths inside the active Library. Library backups and exports do not include this file; protect it separately as a credential file.

Choose the connection type in Config and the named endpoint in the generation composer. A model remains required for each request: the optional profile default preselects it, while the model icon menu also accepts a custom full model ID. This provider supports images only. Title suggestions remain unavailable when it is selected and never silently fall back to another account. Existing OAuth settings and endpoint addresses are unchanged.

## Requests and results

Text-only requests use synchronous `POST /v1/images/generations`; references use multipart `POST /v1/images/edits`. Each queue task sends `n=1`, with up to four references. New composer requests send the selected pixel dimensions or `size=auto`. Quality is independent of size and does not guarantee the returned dimensions. Historical explicit sizes remain unchanged until a new size is selected. Saved request snapshots take precedence.

## GPT Image 2.5 controls (2026-10-09)

Choose `gpt-image-2.5-flare` or `gpt-image-2.5-sunburst` by full name. Configured and historical model names remain available; enter other service-specific models in the model menu or as a profile default in settings. Per-request choices do not change provider defaults. All compatible model names, including gateway aliases, expose `auto`, `low`, `medium`, `high`, `xhigh`, and `max`. Actual support is determined by the service, not inferred from the model name. An unknown legacy request model requires an explicit choice before another request.

For an endpoint without remembered choices, the composer defaults to automatic size, quality and background, with PNG output. Explicit pixel sizes remain supported by the API and historical recipes. For Image 2.5 both dimensions must be positive multiples of 16, neither above 3840, longest/shortest ratio ≤3, and total pixels 655360–8294400 inclusive. `2160x3840` passes this validation; `2880x3840` does not. Local validation does not guarantee gateway support.

Background supports `auto`, `opaque`, `transparent`; output supports PNG, JPEG and WebP. Transparent + JPEG is blocked without erasing the background choice. JPEG/WebP compression supports integers 0–100; PNG omits compression. Originals are saved byte-for-byte. Newly created transparent previews and thumbnails preserve alpha, with checkerboard only in CSS; existing assets are not rebuilt. Downloads use the original file.

Settings follow single, batch, edit, history/draft and saved-image reuse. A queued batch freezes each request model/settings and endpoint ID before execution, so changing the default endpoint does not reroute queued jobs. History and saved-image drafts restore that endpoint; a deleted endpoint blocks execution and requires an explicit choice in a new draft. Credentials are resolved from that endpoint’s current configuration at execution time, so edit an existing endpoint’s URL only after its queue has finished, or add a new endpoint instead. Prompt text is preserved, including whitespace; variable expansion only applies when using an actual template.

Sources: [official image generation guide](https://developers.openai.com/api/docs/guides/image-generation), [Images API reference](https://developers.openai.com/api/reference/resources/images/methods/generate). Documented model names do not establish access for a particular gateway/key.

Generation POST requests are never automatically retried or redirected. Failed or interrupted jobs remain failed. A timeout does not establish whether the service charged the request: check the service before manually retrying. Explicit retry is a new request.

The existing generation-count menu supports batches of 3, 5, or 10 images. Each batch uses the original queue with a separate single-image request per job, rather than a multi-image API response. Selecting a batch submits that many potentially billable requests. A failed job does not automatically retry.

History actions follow result state, not recency. Unsaved successful results retain the original save, reference, retry and discard actions. Saved results can still be reused as references or restored as a draft for another explicit generation. Saving or discarding an already accepted result is not repeated through the transient-result API.

Each task requests `n=1` and expects one `data` entry containing a non-empty `b64_json` or an HTTP(S) image `url`. When both are present, Base64 takes precedence; invalid Base64 reports an error rather than silently falling back to the URL. URL results undergo restricted downloading, then the same real-image decoding as Base64 results before acceptance. HTTP 200 or a returned URL alone does not mean an image has been successfully saved. A download failure never automatically resubmits the paid generation request.

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

The composer uses compact model, size, quality and output controls. Full model IDs and current values remain available in menus and tooltips. New reference forms, including “Save as new reference”, default the original prompt language to Simplified Chinese. This only sets the language marker; it does not translate the prompt or change existing references.


## Synchronous image response compatibility

The provider accepts standard `data[0].b64_json` and `data[0].url` responses without hostname-specific rules. It leaves `response_format` unspecified so the service can use its default. `output_format` describes the image file encoding, not its transport. Base64 takes precedence when both fields exist; invalid Base64 is reported rather than silently replaced.

URL results are downloaded by the backend without API authorization, cookies or environment proxies, then passed through the same PNG/JPEG/WebP decoder, preview and save pipeline. Downloads are restricted to public HTTP(S) addresses on standard ports, with DNS address pinning, at most three redirects, no HTTPS downgrade, a 32 MiB limit and bounded DNS/network waits. Full signed URLs and response bodies are not persisted in diagnostics. Metadata records the transport and actual decoded dimensions/format/alpha separately from requested settings.

A download failure never resubmits a generation POST. It reports download, blocked-target, timeout, empty-result or decoding errors separately. Failed download URLs are not retained for restart recovery: use the supplier's existing request record to recover the image rather than blindly generating again. No automatic paid retry is performed.

The existing queue deliberately submits `n=1` per task, including batches; each response must contain exactly one image. This change does not introduce a second batching mechanism, asynchronous job protocols or vendor-private response shapes. Model/quality/size support remains service-dependent; no parameters are silently removed and no production provider configuration is changed.


## Single size control

Third-party API generation uses one size menu: automatic, exact pixel presets with aspect-ratio labels, or a custom `WIDTHxHEIGHT`. Quality is independent and never derives or overwrites size. New drafts do not add a separate aspect-ratio parameter or composition hint. Historical composition ratios remain visible and preserved until the user explicitly selects or edits a size; existing stored dimensions remain authoritative. Other OAuth providers retain their original ratio controls.

Custom dimensions are validated before submission. GPT Image 2.5 uses its documented edge, multiple-of-16, ratio and pixel-count constraints. Preset names describe requested pixels, not guaranteed provider billing tiers or returned dimensions.


## Local proxy Fake-IP downloads

Downloads remain public-address-only by default. A local operator using a trusted TUN/Fake-IP proxy can explicitly set `IMAGE_PROMPT_LIBRARY_IMAGE_FAKE_IP_CIDRS` to the exact CIDRs configured in that proxy, for example `198.18.0.0/16,2001:2::/64`. For a managed installation, put the variable in its external installation `.env` and restart the application. Do not put credentials or machine-specific configuration in the asset library or Git.

The exception applies only to HTTPS domain URLs whose resolved addresses fall within the configured benchmark subnets. Literal Fake-IP URLs, ordinary private/link-local/loopback addresses, nonstandard ports and HTTPS downgrades remain blocked. Every redirect is checked. The downloader pins the validated address while retaining the original Host and TLS server name, so the proxy can route it and HTTPS certificates remain verified. No provider hostname is hardcoded; rotating addresses within the configured subnets work without changing the application. A proxy using other ranges requires explicit review rather than a blanket allow-private setting.

The compact size badge describes application presets (1K/2K/4K), not a supplier's price tier. The full requested pixel dimensions and ratio remain in the menu and tooltip; custom values are never silently converted to a billing tier.

## Remembered generation settings

Explicit model, size, quality and output choices are remembered per endpoint in this browser. Reopening or refreshing restores them; clearing browser storage resets them. No keys, prompts or images are stored in these preferences. Historical recipe restoration takes precedence. The size control sends explicit pixels (or auto) independently of quality.
