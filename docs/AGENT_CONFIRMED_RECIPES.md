# Execute a confirmed Prompt in Agent

1. Chat normally to reverse an image, create a Prompt or refine a working draft.
   No task panel, context selector or manual main-image selection is required
   for a single unambiguous reference and normal follow-up discussion.
2. On the specific recognized Prompt block, choose **Continue optimizing** for
   a text-only continuation or **Generate image** to use that exact block.
   Each candidate has its own message/block source; arbitrary code and the
   entire explanatory answer are not automatically execution recipes.
3. Generation selects that block internally and freezes it with the current
   visible image settings and established references. The click authorizes
   only this image operation. A lightweight choice is required only for a real
   reference conflict, ambiguity or missing prerequisite, not a task form.

The generate action preserves exact whitespace and line breaks. It does not
append hidden conversation text, inject an aspect-ratio sentence, select a last
code block automatically, or turn on persistent image mode. Composer text and
attachments remain in the draft. A newly attached image that conflicts with a
previous recipe cannot be silently ignored or substituted: resolve that choice
before submission. Optional context details remain available for diagnosis.

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

Ordinary conversational generation remains available: with image mode enabled,
"generate the previous version" follows the normal Agent tool flow. Its default
references come from the frozen task's bound target and auxiliaries even after
the discussion became a Prompt-optimization task. Omitting reference tags must
not silently turn that bound image recipe into text-to-image. Explicit tool
reference selections remain validated and authoritative. For Native, an
authorized request carries the bound current-task pixels through Responses;
it cannot claim a reference was supplied merely because a local ID exists.
Unauthorised text-only Prompt iterations retain their narrower pixel scope.

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
isolated browser acceptance. Its deterministic natural-language and marker
routing exists only in the mock provider, not in production intent handling.
Real model quality, provider compatibility,
latency, pricing and Prompt Cache are not established by offline tests.

The conversational regression additionally runs upload -> reverse -> English ->
softer light -> the clicked block's internal selection -> direct failure ->
explicit retry -> Library -> continued chat, without manual target, context
scope or completeness operations. It checks outgoing image bytes, exact Prompt
whitespace, compression zero, candidate provenance and receipt replay. Its
Responses count remains five while the image attempt and retry increase Images
from zero to two. A separate natural-language generation case verifies that
image mode off stays text-only and explicit image authorization keeps the
ordinary Agent tool path available, without requiring the direct button.

Actual offline browser acceptance also covers the no-panel path with three
Prompt turns, direct success, Library collection and continued conversation.
The mock's six Responses calls stay at six for the direct operation; Images
increases from zero to one. Reload, optional answer diagnostics, exact block
copy and a 390-pixel viewport are checked separately. Mock answers and local
timings do not establish free-form understanding or real visual quality.
