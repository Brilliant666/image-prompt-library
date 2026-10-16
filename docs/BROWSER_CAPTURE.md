# Browser sidebar capture (Chrome / Manifest V3)

The extension collects **one image and the exact prompt you provide** into Image
Prompt Library. It does not generate images, inspect chat history, infer prompts,
or use your generation provider accounts. This first version depends on the
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
The pairing panel shows connection progress and errors beside the connect button.

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
  manual correction takes priority. Titles and other metadata are optional and
  are handled by the existing capture service.
- After success, use **Continue capture** for a completely empty next card, or
  **View in library** to open the item. The previous prompt is never reused for a
  new image implicitly.

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

## Recovery and limits

IndexedDB stores only the current card and necessary receipt. Before a submission,
the image, original text, language, target, client identity and request UUID are
frozen durably. Closing the panel or losing a response retains that snapshot.
Reopening does not automatically submit. A deliberate retry checks its own
receipt and uses the same UUID and content; an uncertain result cannot be edited
into a fresh request silently. A different pairing or target cannot retry an old
uncertain request as a new client.

A definite validation failure allows correction. Network/server failures keep
the card. There is no infinite retry loop. After success, the original temporary
image is removed; only a small preview and receipt remain until the next card.
**Clear draft** discards local buffered content. It never deletes a library item;
if a result was uncertain, check the library before recapturing it.

The credential permits only capture, language detection, connection validation
and recovery of that client's own receipt. It cannot list the library, read
provider configuration, change settings, generate images or delete arbitrary
assets. Normal same-origin write protections remain in place. This first version
does not implement asset undo or batch capture.

## Verification

Run `npm run test:extension`, `npm run test:frontend`, `npm run build`,
`npm run build:extension`, and the relevant Python capture/security tests. Test
with an isolated library and all external credential paths redirected outside
that library; never point automated tests at a personal library.

Unit and API tests cannot prove OS drag-and-drop or a native side panel opened.
Manual browser acceptance should cover: load unpacked; click the pinned icon;
pair to an isolated instance; paste image then prompt; reverse the order; confirm
one saved item; continue with a second card; close/reopen an unfinished card;
stop the extension worker during an uncertain result and recover; revoke pairing;
try a public image URL and an inaccessible/blob image. Verify file hashes and
exact prompt text in the isolated library. Do not use paid image generation for
this acceptance.
