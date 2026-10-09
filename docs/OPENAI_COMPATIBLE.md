# OpenAI-compatible image provider

This local extension adds `openai_compatible` alongside the upstream ChatGPT / Codex and Grok OAuth providers. It reuses the existing generation queue, reference-image preparation, result preview and acceptance into the Library.

## Configure

Open Config and enter a display name, Base URL, API key, image model and timeout (1–1800 seconds). The Base URL may include `/v1`; trailing duplicate `/v1` segments are normalized. Use HTTPS for remote providers. Saving settings does not send a generation request. An empty API key field preserves the stored key. The key is never returned by the settings API and is not saved in browser storage.

Settings live in `~/.image-prompt-library/openai-compatible.json`, outside the Library. `IMAGE_PROMPT_LIBRARY_OPENAI_COMPATIBLE_CONFIG_PATH` can override this location in the process environment. The application rejects paths inside the active Library. Library backups and exports do not include this file; protect it separately as a credential file.

Select the provider in Config or the generation composer. This provider supports images only. Title suggestions remain unavailable when it is selected and never silently fall back to another account. Existing OAuth settings and endpoint addresses are unchanged.

## Requests and results

Text-only requests use `POST /v1/images/generations`. Requests with reference images use multipart `POST /v1/images/edits`, retaining reference order. Up to four references are supported to match the existing queue. Each request asks for one image; defaults are automatic aspect ratio and `low` quality. The composer reuses the upstream aspect-ratio menu. The adapter translates `auto` to `size=auto`, `1:1` to `1024x1024`, `3:4` to `864x1152`, `9:16` to `720x1280`, `4:3` to `1152x864`, and `16:9` to `1280x720`. These are application defaults, not provider capability limits. The fixed sizes preserve each selected ratio exactly with dimensions divisible by 16. The service must actually support the requested model, quality and size; it may return different dimensions. Selected ratio, transmitted size and decoded dimensions are retained separately. Unchanged retries of older jobs retain their explicit size.

Generation POST requests are never automatically retried or redirected. Failed or interrupted jobs remain failed. A timeout does not establish whether the service charged the request: check the service before manually retrying. Explicit retry is a new request.

The existing generation-count menu supports batches of 3, 5, or 10 images. Each batch uses the original queue with a separate single-image request per job, rather than a multi-image API response. Selecting a batch submits that many potentially billable requests. A failed job does not automatically retry.

History actions follow result state, not recency. Unsaved successful results retain the original save, reference, retry and discard actions. Saved results can still be reused as references or restored as a draft for another explicit generation. Saving or discarding an already accepted result is not repeated through the transient-result API.

The implemented response contract is one `data` entry containing `b64_json`. Image bytes must pass decoding before the result is accepted. URL-only responses are deliberately rejected until that service's response contract is verified. HTTP 200 or a model listing alone is not generation success.

Result metadata retains requested parameters separately from service-reported fields and decoded image dimensions. A returned model label is a service claim, not an independent model-identity verification. Missing model data is left unknown. Images saved into the Library use the returned model, never the requested model as a substitute. User-entered card metadata remains editable.

## Keep this extension during upstream updates

This source snapshot is based on upstream v0.11.2, commit `e3d2ecddeeb09975e27826a4d7e5da2abab8cd99`. Its local baseline snapshot is not the upstream Git commit. The branch `codex/sub2api-images` contains the local patch. Keep this source repository and its exported patch/bundle separately from Library backups.

Do not expect the upstream updater to merge local changes: an ordinary update selects an unmodified upstream release and the custom provider may disappear, although its separate configuration file and Library remain. Before updating:

1. Stop the app and create/verify a Library backup.
2. Obtain the intended upstream version in a separate checkout.
3. Apply the saved patch, review conflicts, and run provider, queue, OAuth, backup, frontend and build checks. Do not automatically rerun paid API requests.
4. Package the build under a new custom version name and preserve the previous version for rollback.
5. Switch the installed version only after stopping the managed process. Verify health, existing Library data, settings and preview/save behavior.

No schema replacement, credential migration or upstream OAuth change is required for this extension. Roll back the application version separately from Library data; do not restore an old database merely to switch application code.
