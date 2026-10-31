# Recovering an obtained image and accepting imports safely

## Image generation and local registration are different steps

A provider can finish generating an image while the local database is temporarily
locked or unavailable. The application preserves a validated final image before
attempting its result transaction. Gallery and Agent then show **Local result
registration pending** instead of treating it as a reason to pay for generation
again. Use **Restore local result** to register the retained bytes on the original
task. This action does not call an image or text model or create another task.

Startup also makes a bounded local recovery attempt before classifying interrupted
generation jobs. A lost recovery response can be checked again with the same task
identity. Recovery never authorizes a later generation request or resumes an Agent
model loop automatically.

Provider failure, an unknown provider outcome, a retained final image awaiting
registration, and a registered successful image remain distinct. Stream previews
and images accompanying failed or incomplete Native responses are not evidence of
a successful final result. Unknown requests are not automatically replayed.

## Recovery evidence and its limits

Recovery evidence lives in the existing `generation-results/<job-id>/` directory.
The final image is written atomically first, then a small `local-result.json`
receipt, then the SQLite result transaction. The receipt binds the original task
and frozen execution identity to the complete SHA-256, file size, decoded format
and dimensions, task-local relative path, and confirmed completed provider outcome.
It contains no API key, OAuth data, provider response body, URL or image Base64.

Native Responses can return a final image before a local generation job has been
inserted. That path first writes `native-final.json` and the image under a stable
job ID derived from the original request and tool identity. Its bounded envelope
also retains the exact execution Prompt and required reference identities so the
original job and Agent mapping can be materialized locally. Validation ties it to
the original frozen, authorized request; it never adopts another request's result.
Use the original Agent request's local recovery action when no result card could
be created. The action belongs to that historical round, so finishing a newer
round does not remove it. Opening a conversation projects a cheap database hint;
an on-demand, uncached capability check verifies the retained evidence before
showing an enabled recovery action. It distinguishes pending, recovered, stopped,
deleted and blocked results. Token updates do not scan receipt files or decode
images. Restoring an older round refreshes the current conversation without
selecting the older branch or changing a new request, draft or attachments.
This does not repeat Responses or continue the model loop.

Receipt discovery reads at most 100 receipt headers per page, with explicit
`complete` and `nextCursor` results. A page containing only unrelated requests is
not evidence that the requested result is absent. Request recovery continues
through pages and validates every matching receipt against the frozen request,
including Native results whose first job insertion failed. It stops with an
explicit incomplete-check error after 4096 pages rather than claiming absence.
The browser checks up to eight pages per interaction and offers continuation if
more remain; it enables recovery only after that scan completes.

Startup recovery advances a small, restart-safe scan position before attempting
a page. Corrupt or conflicting evidence is retained and cannot permanently pin
later records behind the first batch. New directories preceding the position
are visited on the next scan cycle. The position file is only a rebuildable hint:
it grants no recovery permission, contains no image or provider data, and its
write failure is reported while in-process progress continues. Names and metadata
are enumerated to select a page with bounded memory; this is not a constant-time
filesystem index. All result ownership, path, full-hash and image checks remain
mandatory.

After a same-result database commit the receipt can be removed. A crash before
receipt removal is safe: repeated recovery finds the same successful task and
does not save another image. Cancellation, cleanup, acceptance and conflicting
newer results are checked under the database writer lock; recovery does not undo
those user actions or silently choose between different candidate images.

If the receipt cannot be written, the obtained image is still retained, but the
application cannot claim that it has complete automatic recovery evidence. Missing,
modified or ambiguous files and damaged or mismatched receipts require checking
the original result. Paid retry remains blocked while such evidence exists.
No orphan-file cleanup or filename-based result adoption happens automatically.

## Backups and restored libraries

The existing portable backup includes recovery evidence and images under
`generation-results`. It validates known receipt fields, task identity and image
integrity; it refuses unexpected or credential-shaped receipt data instead of
publishing it. A valid receipt can remain archived after cancellation, without
granting permission to restore the cancelled task to success.

The database payload comes from SQLite's consistent backup API, including committed
WAL content. `db.sqlite-wal` and `db.sqlite-shm` are not independent database backups
and are not archived as such. Physical checkpoints during enumeration do not replace
the database snapshot or its final full-file checksum. Restore into an isolated
library can complete pending local registration without a supplier connection.

## Import drafts: all declared local images or no accepted asset

Pure-text drafts remain supported. Remote source URLs and `original_path` describe
provenance; accepting a draft does not download remote images or read arbitrary
original files. A declared `staged_path` is different: its file must exist and pass
bounded reads, format decoding, the 30 MiB file limit, the existing pixel limit,
path and source-identity checks.

All declared images are prepared before formal rows are created. Item, original
Prompt, image records and the draft's accepted-item link then commit together in
one transaction. Missing or invalid media and failed writes leave the draft and
staged sources available for correction and retry. Published content-addressed
files are not blindly unlinked on rollback, because another asset may reference
them. This can leave safe unreferenced files for the existing authorized cleanup
flow; it must not delete a shared original.

The draft ID identifies acceptance. Concurrent submissions and replay after a lost
response return its existing item instead of creating another one. A separately
accepted draft with genuinely duplicate provenance or Prompt remains subject to
duplicate detection. Deleted items are not recreated by replaying old receipts.
This change does not automatically remove or claim older partial imports.

## Staging boundary

`import-staging` remains separate from formal media roots and cleanup targets.
Its root and child components must remain real directories and files inside the
active library. Absolute, drive-relative, UNC, traversal and redirected paths are
rejected. Both acceptance reads and repository-ingest staging writes check this
boundary. File identity is checked around bounded reading and before commitment;
stored originals use the same validated bytes.

This addresses a boundary gap **after a staging directory has already been
redirected**. It does not imply that an ordinary request on a default installation
can create an arbitrary local link. Component checks and supported no-follow opens
reject tested replacements; they are not a claim to eliminate every race against
a hostile local process with filesystem access.
