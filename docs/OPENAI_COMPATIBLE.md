# OpenAI-compatible image provider

This local extension adds `openai_compatible` alongside the upstream ChatGPT / Codex and Grok OAuth providers. It reuses the existing generation queue, reference-image preparation, result preview and acceptance into the Library.

## Configure

Open Settings → API → API Key profiles and add an endpoint with its own name, Base URL, API key, image model list, optional default image model and timeout (1–1800 seconds). Register multiple endpoints, edit them independently, and choose a default for new drafts. The endpoint name appears in the generation provider menu. Account connections retain the separate ChatGPT/Codex and Grok OAuth flows. Switching the settings view does not change the default connection.

The profile list and selected profile's fields remain expanded. In the default versioned URL mode, the Base URL may include `/v1`; trailing duplicate `/v1` segments are normalized. Custom-root mode preserves the supplied path without adding `/v1`. Both modes show the actual Images and Responses addresses before saving; a trailing slash alone never changes modes. Use HTTPS for remote providers. Existing profiles retain versioned URL behavior, non-streaming requests and automatic response transport unless explicitly changed.

Saving settings does not send a generation request. An empty API key field preserves only the selected endpoint's stored key; a new endpoint never inherits another key. The key is never returned by the settings API and is not saved in browser storage.

Settings live in `~/.image-prompt-library/openai-compatible.json`, outside the Library. `IMAGE_PROMPT_LIBRARY_OPENAI_COMPATIBLE_CONFIG_PATH` can override this location in the process environment. The application rejects paths inside the active Library. Library backups and exports do not include this file; protect it separately as a credential file.

## Network connection

Each API profile has a **Network connection / 网络连接** selector:

| Mode | Behavior |
| --- | --- |
| Direct (default) / 直连 | Ignores HTTP proxy environment variables. On Windows, public destinations use a verified physical network source address before connecting. Local destinations retain normal local routing. |
| Follow runtime environment / 跟随运行环境 | Uses the backend process's `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` and `NO_PROXY` settings and normal OS routing, including VPN/TUN routing. |
| Use a proxy / 指定代理 | Uses the saved HTTP, HTTPS or SOCKS5 proxy. This explicit choice takes precedence over environment proxies and `NO_PROXY`. |

The policy applies to the machine **running the backend**. A hosted application uses its server/container network, not the visitor's browser proxy. The application does not change system proxy rules, routes or DNS. Linux, macOS and containers retain their OS routing; direct mode there disables application-level proxies and does not promise to bypass an OS VPN. On Windows, ambiguous or unavailable physical routes and Fake-IP DNS results produce a clear error instead of silently switching routes. Network discovery is cached briefly (up to ten seconds); source binding cannot override every packet-filter driver.

Agent text requests, Native Responses image tools, Hybrid/Gallery Images calls, model discovery and protected image-result downloads follow the selected profile. The capture text/vision model has its **own** identical network selector; it does not guess a profile from a matching URL. OAuth account connections and application updates keep their existing behavior.

Older configurations without these fields default to direct. Choosing another mode does not replace models, API keys, drafts, references or image parameters. A changed profile cannot redirect an already frozen Agent request; start a new request explicitly after checking the earlier receipt. An unchanged older direct-mode request retains its identity.

Proxy addresses may include credentials. They are stored only in the existing private configuration file; settings responses expose only the host/port and whether a proxy is saved. Leave the password-style input blank to retain it, or use the explicit clear action. Protect configuration backups as credentials. Standard TLS certificate verification remains enabled, including `SSL_CERT_FILE` and `SSL_CERT_DIR` support.

Saving a profile still performs the existing model-list refresh; it never generates an image or calls a text/vision model. There is no automatic switch to another route or replay of a generation POST after a timeout. Image downloads remain bounded, validate each redirect and never forward the API key. Some proxy implementations may reject IPv6-only image CDN CONNECT targets; this reports a download failure without resubmitting generation.

Choose the connection type in Config and the named endpoint in the generation composer. A model remains required for each request: the optional profile default preselects it, while the model icon menu also accepts a custom full model ID. This provider supports images only. Title suggestions remain unavailable when it is selected and never silently fall back to another account. Existing OAuth settings and endpoint addresses are unchanged.

## Requests and results

Text-only requests use `POST {base}/images/generations`; references use multipart `POST {base}/images/edits`. The default base ends in `/v1`; custom-root mode uses the configured path. Responses are JSON by default, or Images SSE when streaming is enabled. Each queue task sends `n=1`, with up to four references. New composer requests send the selected pixel dimensions or `size=auto`. Quality is independent of size and does not guarantee the returned dimensions. Historical explicit sizes remain unchanged until a new size is selected. Saved request snapshots take precedence.

### 4K target with automatic aspect ratio

The single size menu also offers **4K · Auto aspect ratio**. This is a local size resolver, not the API value `size=auto`: it prefers an explicit ratio in the prompt, then the first reference image, and otherwise visibly defaults to 1:1. Conflicting explicit ratios block submission. The resolved pixel dimensions are shown before submission and sent as `size`; quality remains independent.

The target is approximately 8 megapixels within the current Image 2.5 limits, rather than a guaranteed 3840-pixel long edge for every ratio. For example, an exact 2:3 ratio uses `2336x3504`; `2560x3840` exceeds the pixel limit. Reference ratios may require rounding to legal pixel multiples. Gateway support and actual returned dimensions can differ; originals are never stretched, upscaled or cropped to make them match the request. Inspect the recorded requested and decoded dimensions separately.

## GPT Image 2.5 controls (2026-10-09)

Choose `gpt-image-2.5-flare` or `gpt-image-2.5-sunburst` by full name. Configured and historical model names remain available; enter other service-specific models in the model menu or as a profile default in settings. Per-request choices do not change provider defaults. All compatible model names, including gateway aliases, expose `auto`, `low`, `medium`, `high`, `xhigh`, and `max`. Actual support is determined by the service, not inferred from the model name. An unknown legacy request model requires an explicit choice before another request.

For an endpoint without remembered choices, the composer defaults to automatic size, quality and background, with PNG output. Explicit pixel sizes remain supported by the API and historical recipes. For Image 2.5 both dimensions must be positive multiples of 16, neither above 3840, longest/shortest ratio ≤3, and total pixels 655360–8294400 inclusive. `2160x3840` passes this validation; `2880x3840` does not. Local validation does not guarantee gateway support.

Background supports `auto`, `opaque`, `transparent`; output supports PNG, JPEG and WebP. Transparent + JPEG is blocked without erasing the background choice. JPEG/WebP compression supports integers 0–100; PNG omits compression. Originals are saved byte-for-byte. Newly created transparent previews and thumbnails preserve alpha, with checkerboard only in CSS; existing assets are not rebuilt. Downloads use the original file.

Gallery's **More** menu also exposes optional `moderation: auto | low`, supported by the OpenAI Images generation and edit contracts. An omitted historical setting stays omitted; an explicit selection is validated, forwarded in JSON or multipart, and retained in request history and per-profile preferences. This is a request setting, not the returned `moderation_details` diagnostic, and does not guarantee that a third-party service supports it or accepts the prompt.

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

The provider accepts standard `data[0].b64_json` and `data[0].url` responses without hostname-specific rules. By default it leaves `response_format` unspecified so the service can use its default. The optional **Return Base64 image data** switch explicitly sends `response_format: b64_json` for compatible gateways that require it. Official GPT Image models already return Base64 and do not support that legacy request parameter; leave the switch off for those endpoints. See the [Images API parameter reference](https://developers.openai.com/api/reference/python/resources/images/methods/generate). `output_format` describes the image file encoding, not its transport. Base64 takes precedence when both fields exist; invalid Base64 is reported rather than silently replaced.

URL results are downloaded by the backend without API authorization, cookies or environment proxies, then passed through the same PNG/JPEG/WebP decoder, preview and save pipeline. Downloads are restricted to public HTTP(S) addresses on standard ports, with DNS address pinning, at most three redirects, no HTTPS downgrade, a 32 MiB limit and bounded DNS/network waits. Full signed URLs and response bodies are not persisted in diagnostics. Metadata records the transport and actual decoded dimensions/format/alpha separately from requested settings.

A download failure never resubmits a generation POST. It reports download, blocked-target, timeout, empty-result or decoding errors separately. Failed download URLs are not retained for restart recovery: use the supplier's existing request record to recover the image rather than blindly generating again. No automatic paid retry is performed.

The existing queue deliberately submits `n=1` per task, including batches; each response must contain exactly one image. This change does not introduce a second batching mechanism, asynchronous job protocols or vendor-private response shapes. Model/quality/size support remains service-dependent; no parameters are silently removed and no production provider configuration is changed.

## Optional image streaming

Each API profile can enable streaming and request 0–3 intermediate previews. Zero requests only the final image. Intermediate images are optional: a service may complete before sending all requested previews. These options require provider support and remain off by default; saving them performs no network test. Native transparency remains a generation parameter, without local background removal or automatic image re-encoding.

The backend accepts bounded Images SSE generation/edit events and validates image bytes before exposing a preview. Gallery labels an intermediate image as a preview of a running task; it cannot be collected, reused as a final result or downloaded through the completed-result controls. Only the final completion event becomes the task result. A gateway that responds with ordinary JSON is handled within the same request. A disconnected stream without a final result remains a failure with an uncertain upstream outcome, without a second POST or automatic fallback request.

The latest preview is transient task data, separate from the final original image. Terminal tasks clear the preview. Stream settings are retained with the task's safe request parameters. Old jobs without these settings retain their previous non-streaming behavior. New fields are read with defaults without rewriting existing external credential files on startup; after saving newer options, account for credential-file compatibility when downgrading.


## Single size control

Third-party API generation uses one size menu: automatic, exact pixel presets with aspect-ratio labels, or a custom `WIDTHxHEIGHT`. Quality is independent and never derives or overwrites size. New drafts do not add a separate aspect-ratio parameter or composition hint. Historical composition ratios remain visible and preserved until the user explicitly selects or edits a size; existing stored dimensions remain authoritative. Other OAuth providers retain their original ratio controls.

In Gallery this control opens a centered dialog: **Auto**, **By ratio** (1K/2K/4K and common/custom ratios), or **Custom dimensions**. It previews the exact pixels before applying; cancellation keeps the previous recipe. Image 2.5-specific custom-size bounds only apply to the model IDs already covered by the existing validator. Other model aliases retain their existing positive-integer dimension contract rather than inheriting a new model restriction.

Custom dimensions are validated before submission. GPT Image 2.5 uses its documented edge, multiple-of-16, ratio and pixel-count constraints. Preset names describe requested pixels, not guaranteed provider billing tiers or returned dimensions.


## Local proxy Fake-IP downloads

Downloads remain public-address-only by default. A local operator using a trusted TUN/Fake-IP proxy can explicitly set `IMAGE_PROMPT_LIBRARY_IMAGE_FAKE_IP_CIDRS` to the exact CIDRs configured in that proxy, for example `198.18.0.0/16,2001:2::/64`. For a managed installation, put the variable in its external installation `.env` and restart the application. Do not put credentials or machine-specific configuration in the asset library or Git.

The exception applies only to HTTPS domain URLs whose resolved addresses fall within the configured benchmark subnets. Literal Fake-IP URLs, ordinary private/link-local/loopback addresses, nonstandard ports and HTTPS downgrades remain blocked. Every redirect is checked. The downloader pins the validated address while retaining the original Host and TLS server name, so the proxy can route it and HTTPS certificates remain verified. No provider hostname is hardcoded; rotating addresses within the configured subnets work without changing the application. A proxy using other ranges requires explicit review rather than a blanket allow-private setting.

The compact size badge describes application presets (1K/2K/4K), not a supplier's price tier. The full requested pixel dimensions and ratio remain in the menu and tooltip; custom values are never silently converted to a billing tier.

## Remembered generation settings

Explicit model, size, quality and output choices are remembered per endpoint in this browser. Reopening or refreshing restores them; clearing browser storage resets them. No keys, prompts or images are stored in these preferences. Historical recipe restoration takes precedence. The size control sends explicit pixels (or auto) independently of quality.


## Moderation diagnostics

When the provider returns `error.moderation_details`, the application retains only the public moderation stage (`input`, `output`, or `unknown`) and recognized category labels. Extra fields, classifier scores, credentials and arbitrary nested payloads are discarded. The failure view distinguishes input moderation from output moderation; absent or invalid stage information is shown as unavailable rather than inferred from error wording, elapsed time or category.

Some gateways retain these details in their administrative upstream logs but omit them from the client response. The application cannot recover fields it did not receive. Existing failures are not rewritten, and an unknown stage does not prove which system applied the rejection. This diagnostic change does not relax moderation or automatically retry a paid request.
