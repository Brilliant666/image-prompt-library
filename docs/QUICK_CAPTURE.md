# Quick capture

Use **Quick capture** from the existing Add entry to save one finished image with its original prompt. Choose a file, drop a file from your file manager, or actively paste an image; paste the full prompt and press Save (Ctrl+Enter also works). Title and other metadata are optional. After saving, the confirmation stays in place with a thumbnail, Continue and Full editor actions. Existing multi-image and multilingual editing remains available.

Uploads retain their original file bytes. Thumbnails and previews use the existing image pipeline, including alpha support. Clipboard images are the bytes supplied by the browser; they are not necessarily identical to a platform download. URL-only drags ask the user to copy the image or use a downloaded file; capture does not fetch arbitrary URLs.

An optional explicit title wins. Otherwise, a meaningful original filename without its extension becomes the title; generic names, opaque identifiers or missing names use a neutral capture-time/short-ID fallback. Prompts are not shortened into new titles. Existing records and titles are not renamed. Original filename metadata is separate from the UUID-based storage path and is frozen with each request; older clients and frozen retries that omit it remain compatible.

## Original text and language

The single prompt is marked as original because it is the version the user supplied. Its whitespace, punctuation and line breaks are stored unchanged. Language is a separate, editable label. The local detection endpoint uses script evidence, OpenCC comparison and conservative English hints; it makes no translation or external model request. Chinese with rendering jargon such as PBR, SSS and 8K is not labeled English just because those terms appear. Ambiguous or unsupported text falls back to `und` (undetermined), with an uncertainty hint. A manual language choice takes precedence. Detection is a convenience, not proof of the language or of a text's authorship.

## Small shared API

`POST /api/captures/detect-language` accepts JSON `{ "text": "..." }` and returns `language`, `uncertain` and `reason`.

`POST /api/captures` accepts multipart fields:

- `file`: one image file
- `prompt_text_json`: JSON-encoded original prompt string (the web form uses this to prevent multipart newline normalization)
- Alternatively `prompt_text`: plain text for clients that already control their wire representation; supply only one of these fields
- `request_id`: a UUID reused for retries of the same capture
- `language`: `auto` (default), `en`, `zh_hans`, `zh_hant` or `und`
- Optional `title`, `original_filename`, `source_name`, `source_url`, `notes`

It returns the saved ItemDetail. The item, its original prompt, its image record and a small idempotency receipt commit together. A successful retry returns the same item; reusing a request ID for different content is rejected. Image equality alone does not merge different captures. The receipt ledger is a minimal additive migration; existing Item, Prompt and Image storage remains authoritative.

If a response is lost, retry the pending capture with its original request ID and payload. The web form keeps the pending draft and does not silently create a new item. It does not store credentials, prompts or images in localStorage. Unsaved drafts survive closing/reopening the form in the current page, not a full browser reload; saved records survive reload and application restart.

## Browser side-panel collector

A Chromium Manifest V3 side panel reuses these endpoints and the same request-ID contract through narrowly scoped local pairing. It collects one explicitly supplied image and complete prompt, without reading conversation history, exporting site cookies, calling private image APIs or retaining clipboard history. A save follows a completed user drop/paste only after both inputs are present. Failed saves retain the frozen card; successful saves show a receipt and offer a cancellable three-second transition to an empty next card. The extension keeps bounded recent receipts and does not grant arbitrary deletion access or implement asset undo.

The original quick-capture change alone does not enable extension writes. The dependent browser-capture implementation adds pairing, explicit Origin authorization and scoped receipt recovery while retaining same-origin protections. See [Browser capture](BROWSER_CAPTURE.md) for loading, pairing, recent-record behavior and input limitations. No cloud sync or automatic conversation collector is used.
