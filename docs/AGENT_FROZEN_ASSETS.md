# Agent frozen image references

Agent requests keep independent image snapshots so later turns can still use a
reference after its Gallery result or Library original is removed. These are
original bytes, not thumbnails, recompressed images, or hard links to a mutable
source.

## Source identity and reuse

Migration `018_agent_frozen_sources.sql` adds a small mapping from the canonical
source identity (`jobId` or Library `imageId`) to an existing `agent_assets` ID.
The first successful freeze writes an independent file below
`generation-references/agent/frozen/`; later requests reuse that asset after
checking its path, source and SHA-256. Two different sources with identical image
bytes retain different identities. Uploads, masks and Native streaming previews
keep their existing separate lifetimes.

The mapping does not grant access to another conversation branch. Request
construction still resolves its parent path and validates explicit image
references against that path. Current attachments do not remove necessary
historical pixels. This optimization changes local storage reuse, not the
context-selection policy or image-generation authorization.

First creation is serialized in a SQLite transaction and uses an atomic file
write. A failed database commit or interruption after the write can leave one
unreferenced file. Retrying with a valid source uses the same deterministic path;
it never treats an uncommitted file as evidence of a successful snapshot. If the
source has disappeared before a committed snapshot exists, the request reports a
missing reference. A committed snapshot that is missing or damaged produces an
explicit error rather than silently replacing its pixels.

## Existing libraries and deletion

The migration adds metadata only. It does not rewrite requests, scan all images,
change old asset IDs or delete redundant copies. On use, a parent request's
persisted image slots and ancestor inputs can supply verified legacy snapshots.
This avoids adopting a partial Native preview merely because it has the same
source task. Only the relevant parent history is read; there is no whole-library
search for each reference. If an old parent snapshot has a missing output slot,
an indexed source check can trigger one bounded lookup of that branch's ancestor
requests for an earlier committed snapshot. Normal new requests do not perform
this fallback.

Deleting a conversation or one branch does not garbage-collect its frozen
resources. Gallery cleanup and Library deletion do not remove an established
Agent snapshot. Old redundant copies and interrupted, unreferenced files are
retained in this release; cleanup needs a separate ownership and reachability
review.

## Backup and program rollback

Portable backups already traverse `generation-references` recursively. The new
mapping is included in the SQLite snapshot, and backup verification checks the
new schema contract and existing asset paths. Restore tests cover both legacy
and shared snapshots, including sources removed before backup.

Keep a verified pre-upgrade backup and the previous runnable installation.
An older backup utility that does not know migration 018 cannot verify or restore
a new-format database. Retain the updated utility for backups and restores even
when an independently validated program-only rollback is needed. Never restore
a pre-upgrade database over newer user data. Compatibility must be tested on a
copy before changing a running installation.

## Reproducing the storage baseline

Run these offline diagnostics in a development checkout:

```console
python scripts/diagnose_agent_result_snapshots.py --rounds 5 25 50 100
python scripts/diagnose_agent_context.py --rounds 5 25 50 100
```

Both tools use temporary libraries and synthetic images, block external network
access, and report aggregate measurements. File counts are recursive and include
unreferenced files, so moving files into subdirectories cannot disguise storage
growth. Logical rows, unique physical hashes, file bytes, newly created files,
SQLite activity, request bytes and local timings are reported separately.

For one distinct generated result per turn, the first 100 turns formerly created
4,950 frozen copies of 99 sources. Reuse should retain 99 snapshots; repeated
request IDs should create no additional files or asset rows. Full histories and
necessary image payloads still grow with conversation length. This does not
establish lower provider latency, token usage, billing, or prompt-cache hits.

### Measured comparison

The following synthetic comparison used baseline `82f0c6308373adc812cba485724f88820037330c`
and the source-reuse implementation, on Windows with Python 3.10.10. The same
diagnostic code ran against both source trees. Each turn staged a distinct
64 x 64 PNG of 12,420 bytes. No provider or generation worker ran. Counts below
include all nested Agent files, not only the old flat directory. Logical asset
rows equal physical file counts in this fixture; the distinct physical SHA-256
count remains `n - 1` before and after.

| Turns | Files / asset rows, before -> after | Frozen bytes, before -> after | New files in that turn, before -> after |
| --- | ---: | ---: | ---: |
| 5 | 10 -> 4 | 124,200 -> 49,680 | 4 -> 1 |
| 25 | 300 -> 24 | 3,726,000 -> 298,080 | 24 -> 1 |
| 50 | 1,225 -> 49 | 15,214,500 -> 608,580 | 49 -> 1 |
| 100 | 4,950 -> 99 | 61,479,000 -> 1,229,580 | 99 -> 1 |

At each checkpoint, repeating the same request ID created zero files and zero
asset rows. There were no unreferenced files or missing asset files. The 98%
reduction at 100 turns applies to **newly created frozen image storage** in this
fixture; this change does not remove old copies from existing libraries.

| Turns | Create-round ms, before -> after | Create-round connections / SQL statements, before -> after | Snapshot ms, before -> after | Build-input ms, before -> after |
| --- | ---: | ---: | ---: | ---: |
| 5 | 86.0 -> 50.8 | 26 / 74 -> 20 / 60 | 20.7 -> 20.5 | 19.3 -> 16.7 |
| 25 | 690.4 -> 217.4 | 126 / 314 -> 80 / 180 | 136.6 -> 80.3 | 183.8 -> 109.5 |
| 50 | 1,470.2 -> 433.5 | 251 / 614 -> 155 / 330 | 287.7 -> 171.5 | 396.7 -> 251.1 |
| 100 | 2,947.1 -> 1,348.3 | 501 / 1,214 -> 305 / 630 | 537.0 -> 522.4 | 761.5 -> 786.0 |

Create-round is measured once because a second call would measure request replay.
Snapshot and build-input values are medians of three runs. Timings include SQL
tracing, local reads, JSON processing and final image hash verification; OS
caches and concurrent machine load vary. They are observations, not latency
thresholds. At 100 turns, build-input still opens 99 SQLite connections and runs
198 statements, while snapshot opens 203 connections and runs 410 statements,
unchanged from baseline. Storage reuse is not a comprehensive context or
snapshot performance fix.

| Turns | First model request bytes, both versions | Historical image occurrences, both versions | Raw image bytes sent, both versions |
| --- | ---: | ---: | ---: |
| 5 | 73,320 | 4 | 49,680 |
| 25 | 411,431 | 24 | 298,080 |
| 50 | 834,081 | 49 | 608,580 |
| 100 | 1,679,382 | 99 | 1,229,580 |

Those request bodies were captured from the production request builder with
MockTransport. Necessary history pixels were not removed to obtain the storage
improvement. Stable frozen IDs are longer than old random IDs: at 100 turns,
persisted history JSON across all requests grows from 3,505,392 to 3,698,442 bytes.
Total SQLite file size in this fixture falls from 5,980,160 to 4,558,848 bytes,
but full frozen history JSON still grows quadratically across requests. No old
history is rewritten by this change.

The separate upload-history diagnostic preserves distinct upload identities,
even when their bytes match. At 5 / 25 / 50 / 100 turns it retains 5 / 25 / 50 /
100 asset rows and files, with one distinct physical hash. Its outbound request
sizes remain 1,328,238 / 6,607,610 / 13,206,835 / 26,405,287 bytes in both versions,
including 5 / 25 / 50 / 100 image occurrences. The text-only request sizes remain
13,568 / 34,244 / 60,094 / 111,795 bytes. Skill and tool-follow-up probes remain
enabled in that diagnostic. These are local byte measurements, not tokens or
charges; provider cache usage is unmeasured and missing usage stays unknown.
