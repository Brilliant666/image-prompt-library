# Quick capture

Use **Quick capture** from the existing Add entry to save one finished image with its original prompt. Choose a file, drop a file from your file manager, or actively paste an image; paste the full prompt and press Save (Ctrl+Enter also works). Title and other metadata are optional. After saving, the confirmation stays in place with a thumbnail, Continue and Full editor actions. Existing multi-image and multilingual editing remains available.

Uploads retain their original file bytes. Thumbnails and previews use the existing image pipeline, including alpha support. Clipboard images are the bytes supplied by the browser; they are not necessarily identical to a platform download. URL-only drags ask the user to copy the image or use a downloaded file; capture does not fetch arbitrary URLs.

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
- Optional `title`, `source_name`, `source_url`, `notes`

It returns the saved ItemDetail. The item, its original prompt, its image record and a small idempotency receipt commit together. A successful retry returns the same item; reusing a request ID for different content is rejected. Image equality alone does not merge different captures. The receipt ledger is a minimal additive migration; existing Item, Prompt and Image storage remains authoritative.

If a response is lost, retry the pending capture with its original request ID and payload. The web form keeps the pending draft and does not silently create a new item. It does not store credentials, prompts or images in localStorage. Unsaved drafts survive closing/reopening the form in the current page, not a full browser reload; saved records survive reload and application restart.

## Follow-up browser collector

A Chromium Manifest V3 side panel can reuse these two endpoints and the same request-ID contract. It should collect one explicitly selected file/image and the user's chosen complete prompt, without reading conversation history, site cookies, private image APIs or clipboard history. A single save follows a completed user drop/paste only after both fields are present. Failed saves retain the card; successful saves show a receipt and an undo action, then an explicit next-card transition clears both fields.

Extension-to-localhost writes are not enabled by this change. A later implementation must add narrowly scoped capture pairing and explicit origin authorization while preserving the existing cross-origin write protections. It must report inaccessible/cross-origin images or preview-only sources truthfully. No extension, account system, cloud sync or background collector is included here.
