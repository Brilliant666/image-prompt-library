# OpenAI-compatible image provider

This local extension adds `openai_compatible` alongside the upstream ChatGPT / Codex and Grok OAuth providers. It reuses the existing generation queue, reference-image preparation, result preview and acceptance into the Library.

## Configure

Open Config and enter a display name, Base URL, API key, image model and timeout (1–1800 seconds). The Base URL may include `/v1`; trailing duplicate `/v1` segments are normalized. Use HTTPS for remote providers. Saving settings does not send a generation request. An empty API key field preserves the stored key. The key is never returned by the settings API and is not saved in browser storage.

Settings live in `~/.image-prompt-library/openai-compatible.json`, outside the Library. `IMAGE_PROMPT_LIBRARY_OPENAI_COMPATIBLE_CONFIG_PATH` can override this location in the process environment. The application rejects paths inside the active Library. Library backups and exports do not include this file; protect it separately as a credential file.

Select the provider in Config or the generation composer. This provider supports images only. Title suggestions remain unavailable when it is selected and never silently fall back to another account. Existing OAuth settings and endpoint addresses are unchanged.

## Requests and results

Text-only requests use `POST /v1/images/generations`. Requests with reference images use multipart `POST /v1/images/edits`, retaining reference order. Up to four references are supported to match the existing queue. Each request asks for one image; defaults are `1024x1024` and `low`. The service must actually support the requested model, quality and size.

Generation POST requests are never automatically retried or redirected. Failed or interrupted jobs remain failed. A timeout does not establish whether the service charged the request: check the service before manually retrying. Explicit retry is a new request.

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
