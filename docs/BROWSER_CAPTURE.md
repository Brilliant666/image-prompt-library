# Browser sidebar capture (Chrome / Manifest V3)

The extension collects **one image and the exact prompt you provide** into Image
Prompt Library. It does not generate images, inspect chat history, infer prompts,
or use your generation provider accounts. The extension depends on the
quick-capture API from PR #4.

## Load locally

Use a library server that includes the browser-capture branch. A server with only
PR #4 has quick capture but does not have extension pairing.

1. Run `npm install` and `npm run build` for the library frontend. Start the backend
   using your normal source installation, with an isolated library when testing.
2. The extension is native JavaScript: no bundler or generated output is needed.
   `npm run build:extension` checks its loadable source and manifest.
3. Open `chrome://extensions` in Chrome, enable **Developer mode**, choose
   **Load unpacked**, and select `extensions/browser-capture` in this repository.
4. Pin the extension and click its icon to open Chrome's native side panel.

After a source update, reload the extension in Chrome's extension manager, then
close and reopen the sidebar. Its header displays the loaded manifest version
(currently v0.3.0). Reloading preserves pairing and the current buffered card;
do not uninstall the extension to update it.

Chrome 116 or newer is required. The native side-panel API is described in
[Chrome's documentation](https://developer.chrome.com/docs/extensions/reference/api/sidePanel).
Moving the unpacked directory can change its extension ID; create a new pairing
for that ID and resolve any uncertain old submission before starting another.

## Connect and revoke

In the panel's secondary connection settings, explicitly choose the local service
address. Only `localhost` and `127.0.0.1` are accepted, with configurable ports.
The suggested test address is `http://127.0.0.1:8013`; the extension does not
silently connect to the normal port 8000.

Open the local library's **Settings → Browser capture**. Confirm the extension ID
shown by Chrome and authorize capture. Copy the pairing information and paste it
into the extension's connection settings. The resulting credential is bound to
this extension, client, local origin, and library instance. The connection check
does not submit an image.

Connection validation and own-receipt queries use POST without creating assets.
Chrome may omit `Origin` on host-permitted extension GETs; these POST requests
allow the browser to supply it while the server still requires the exact paired
Origin, token, local target and instance. The original GET routes remain available
with the same strict checks. The extension never manufactures an Origin header.
Explicit connection checks show a dismissible status at the bottom of the sidebar,
as well as status in the pairing settings. It reports progress, success or failure
without moving focus. Background checks on reopening do not show the popup, and a
successful connection never saves the current card by itself.

Use the same settings section to **revoke** a pairing. It does not delete assets.
Close the settings drawer to discard the in-memory copy of a newly issued secret.
Do not paste pairing information into chats or commit it to Git.

The server stores only credential hashes, outside the library, in
`~/.image-prompt-library/capture-clients.json` by default. Override
`IMAGE_PROMPT_LIBRARY_CAPTURE_CLIENTS_PATH` for isolated instances. Paths inside
the asset library are rejected. Pairings are excluded from library backups and
exports. The extension uses local storage only, never Chrome sync.

## Collect an image and prompt

- Choose an image file, drag a file into the panel, or deliberately paste a copied
  image. PNG, JPEG, WebP and GIF are supported, up to 30 MiB. The acquired file
  bytes are preserved; clipboard pixels may differ from a downloaded original.
- Paste or drag the full prompt text. Whitespace and line endings are preserved
  via `prompt_text_json`. No translation or rewriting takes place.
- Either order works. After a completed paste or drop supplies valid image and
  prompt, an authorized connection can save once. Typing, IME composition,
  language detection, reconnection and reopening the panel do not trigger saves.
  Use **Save** or **Ctrl+Enter** after typing or editing.
- Language defaults to automatic. An uncertain result does not block saving;
  manual correction takes priority. A name is optional: an explicit name wins,
  then the capture service uses a meaningful original filename when available,
  otherwise it chooses a neutral fallback. It does not rewrite the prompt or
  rename existing library items.
- After success, the visible panel starts a **3-second Continue capture**
  countdown. Cancel it to keep the success card, choose **Continue capture**
  immediately, or use **View in library**. Continuing clears both image and
  prompt; it does not submit anything or reuse the previous prompt.
- Moving the panel into the background pauses the countdown. Closing/reopening
  the sidebar, reloading the extension, or restoring an older saved card does
  not automatically restart the countdown or clear the restored card. The
  explicit **Continue capture** action remains available.

The web quick-capture form and the extension send the optional
`original_filename` field as upload metadata. An original file name is not
inferred from a generated transport filename, a URL, or the prompt. This field
travels with the frozen capture snapshot, so a retry retains its original name,
bytes and request ID. Clients that omit the new field remain supported, including
older buffered requests; upgrading does not force them to create a new request.

## Recent captures

The panel shows the current connected instance's **5 most recent captures**;
expand the list to see up to **20**. These are bounded local receipts and small
thumbnails, accumulated after successful captures in this extension version.
The extension does not scan the library, read all its items, or import an old
saved card as new history. Each receipt can open its saved item in the library.

Recent receipts are local conveniences, not another asset library or a batch
queue. They do not retain original files or complete prompts and are not cloud
synced. Clearing recent records removes this local history only; it does not
delete images, prompts or records from the library. Switching the connected
instance does not present another instance's entries as its own.

For a webpage image drop, the browser may supply a file, a data URL, a public
HTTP(S) URL, or a page-local blob URL. A URL is not an image until its bytes have
been obtained and decoded. Permission for a public image host is requested only
when needed; downloads carry no pairing or provider credential, omit cookies,
reject redirects, and retain byte/time/format limits. Where only a webpage's
displayed image is available, the panel identifies that limitation rather than
claiming it is the platform's original. If a blob or authenticated image cannot
be read through the explicitly authorized current tab, use **Copy image** or
download the image and drop the file. The extension does not export site cookies
or tokens or call private image-generation endpoints.

## Optional title and Collection organization

Library **Settings → Capture auto-organizer** configures a separate OpenAI-compatible
Base URL, API key, vision-capable text model and timeout. The extension settings
link to this page, but cannot read or modify these credentials. `gpt6-luna` is the
suggested model identifier, not a claim of support by every provider.

This feature is disabled by default. Saving or checking configuration is local
only and does not validate a real model call. After enabling, newly captured
images and exact prompts are saved first. The server then sends an analysis-sized
image copy, prompt, existing title and Collection names to `/v1/chat/completions`;
this may incur the configured provider's text/vision charges. Original image
bytes and prompt text remain unchanged. There is no image-generation call.

Explicit capture names win over generated titles. The model is instructed to
retain concrete descriptions and avoid generic suffixes such as 人像. Collections
reuse existing names where suitable, without a fixed taxonomy; new Collections
can be disabled. Uncertain classification may remain unset. Existing captures
are not backfilled, and edits made while a job is waiting are preserved.

The key is stored outside the library in a per-library file under
`~/.image-prompt-library/capture-organizer/`. The optional
`IMAGE_PROMPT_LIBRARY_CAPTURE_ORGANIZER_CONFIG_PATH` override is also scoped to
the library. This file cannot be inside the asset library and is excluded from
library archives and exports. Public settings expose only whether a key exists.

Organization does not block the 3-second continue countdown. Recent receipts
show eventual title, Collection and status updates; their refresh uses the
existing client-scoped receipt endpoint and never resubmits a capture or model
call. Jobs are durably claimed before the external POST. A failed or interrupted
request is not automatically retried, including after service restart. A failed
organization does not undo a successfully saved capture.

## Recovery and limits

IndexedDB stores the current card and bounded recent receipts. Before a submission,
the image, original text, language, target, client identity and request UUID are
frozen durably. Closing the panel or losing a response retains that snapshot.
Reopening does not automatically submit. A deliberate retry checks its own
receipt and uses the same UUID and content; an uncertain result cannot be edited
into a fresh request silently. A different pairing or target cannot retry an old
uncertain request as a new client.

A definite validation failure allows correction. Network/server failures keep
the card. There is no infinite retry loop. After success, the original temporary
image is removed; only a small preview and receipt remain in bounded local history.
**Clear draft** discards local buffered content. It never deletes a library item;
if a result was uncertain, check the library before recapturing it.

The credential permits only capture, language detection, connection validation
and recovery of that client's own receipt. It cannot list the library, read
provider configuration, change settings, generate images or delete arbitrary
assets. Normal same-origin write protections remain in place. The extension
does not implement asset undo or batch capture.

## Verification

Run `npm run test:extension`, `npm run test:frontend`, `npm run build`,
`npm run build:extension`, and the relevant Python capture/security tests. Test
with an isolated library and all external credential paths redirected outside
that library; never point automated tests at a personal library.

Unit and API tests cannot prove OS drag-and-drop or a native side panel opened.
Manual browser acceptance should cover: load unpacked; click the pinned icon;
pair to an isolated instance; paste image then prompt; reverse the order; confirm
one saved item; cancel and complete the 3-second countdown; pause it in the
background; reopen a saved card without automatic continuation; continue with a
second card; inspect the current instance's recent list and clear it without
deleting library items; verify optional names and meaningful original filenames;
close/reopen an unfinished card;
stop the extension worker during an uncertain result and recover; revoke pairing;
try a public image URL and an inaccessible/blob image. Verify file hashes and
exact prompt text in the isolated library. Do not use paid image generation for
this acceptance.
