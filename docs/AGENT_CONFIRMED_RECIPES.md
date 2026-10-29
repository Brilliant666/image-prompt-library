# Execute a confirmed Prompt in Agent

1. Choose **Set as current Prompt** on the exact Prompt block you want to use,
   or explicitly select text from your input or a historical message.
2. Inspect the full selected text, current image settings, and reference images
   with their roles and order in the task panel.
3. Choose **Continue optimizing** for another text-only Agent answer, or
   **Generate with this Prompt** to authorize this image operation only.

The generate action preserves exact whitespace and line breaks. It does not
append hidden conversation text, inject an aspect-ratio sentence, select a last
code block automatically, or turn on persistent image mode. Composer text and
attachments remain in the draft. Draft attachments are separate from the task's
explicit recipe references; the panel shows which images the recipe will use.

## Existing generation paths

- **Hybrid:** submits the selected recipe to the existing Images API adapter and
  generation queue, with **zero text-model planning POSTs**.
- **Native:** uses the existing forced Responses image tool. Each image still
  needs a native Responses image request; there is no separate planning request.
- **Current API:** direct execution is not verified for this mode and is blocked
  with an explanation. The ordinary Agent conversation path remains available;
  switching to Hybrid or Native is an explicit user choice.

Direct mask execution is currently blocked; use the existing editing flow.
Missing images, ambiguous roles, unconfirmed Prompt versions and required legacy
or visual evidence prevent submission. Ordinary unreconciled text additions do
not block an explicitly confirmed complete recipe; they remain in chat history.
The selected text is the execution text, not a summary of those additions.

Image parameters follow the existing Agent/Gallery controls. A direct operation
freezes profile/model, size, quality, format, background, compression (including
zero), count, original image hashes and order, task version, Prompt version and
message source. No Key is sent to the browser.

## Receipts, failures and assets

A single transaction records the operation, its stable request identity and all
existing queue jobs. Double-clicks reuse the receipt. A lost acknowledgement or
page refresh checks the original receipt with GET; it does not resend a paid
POST. An unknown provider outcome is not automatically retried.

The operation card is labeled **Generated from a confirmed recipe** rather than
inventing an assistant text response. Agent and Gallery show the same jobs.
Actual dispatch records the exact executed Prompt even for a provider failure
or unknown outcome; a local validation failure is not called an execution.

For a confirmed failure, the existing explicit image retry can use the current
image settings while preserving the Prompt, reference bytes and source recipe.
It does not replace the current selected Prompt or editing target. Select a
successful result explicitly before making it the next task target, or collect
it into Library using the existing flow. Library ownership and recovery remain
unchanged; no second image database is created.

## Offline validation

The regression suite exercises real HTTP routes, SQLite receipts, frozen files,
workers, the existing queue, Images multipart and Native Responses through
MockTransport. Coverage includes 1/3/5/10 images, changed files before dispatch,
duplicate Native claims, stop/unknown states, original Prompt bytes, config
changes, retry provenance, Library collection and reuse in Agent.

`scripts/preview_agent.py` provides synthetic Prompt workflow scenarios for
isolated browser acceptance. Its marker routing exists only in the mock provider,
not in production intent handling. Real model quality, provider compatibility,
latency, pricing and Prompt Cache are not established by offline tests.
