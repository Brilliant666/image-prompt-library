# Agent run state and bounded progress

The browser observes a durable request through one full snapshot followed by patches of its current round. The repository stores the execution truth. Reconnecting an observer never schedules a model request, repeats a provider POST, or stops an existing request.

## Protocol

`GET /api/agent/requests/{request_id}/events` starts a new observation epoch. An old `Last-Event-ID` is not replayed. The first `snapshot` event keeps the existing `AgentSnapshot` fields and adds:

```ts
stream: {
  version: 1;
  epoch: string;
  sequence: 0;
  requestId: string;
  conversationId: string;
  roundId: string;
  view?: ProgressView;
}
```

`ProgressView` contains the revision, conversation metadata, request, editing task, current round, and that round's messages, images and jobs. It excludes historical rounds and messages. Both the full snapshot and this limited view use the repository's shared public projection. Normal progress does not call `snapshot`, `request`, or `_rounds`, and does not parse frozen full conversation history.

A `patch` event carries the same version/epoch/request/conversation/round identity, `sequence`, `baseSequence`, and `operations`. Each operation is one of:

```ts
{ op: "replace", path: Array<string | number>, value: unknown }
{ op: "append", path: Array<string | number>, offset: number, value: string }
```

Append offsets count UTF-16 code units, matching JavaScript string length. Repeated text is valid content and is not deduplicated by its value. A changed dictionary key set or array length replaces that container; equal-length arrays are compared recursively. Final text corrections can therefore replace earlier text.

The client validates identities, paths and sequence continuity before immutable application. Duplicate sequences are ignored. Invalid operations, unknown epochs or gaps trigger read-only recovery. Limited-view entities are merged by business ID into the canonical full snapshot, preserving historical messages and image references. Expired current previews are released unless another historical/current image role still references them.

| Bound | Value | Behavior on overflow |
| --- | ---: | --- |
| Retained current view, serialized UTF-8 JSON | 4 MiB per connection | Full initial snapshot without a patch baseline, then read-only polling |
| Serialized patch payload | 512 KiB | Read-only polling |
| Operations per patch | 512 | Read-only polling |
| Operation path depth | 20 | Read-only polling |

The 4 MiB limit is not a Python heap bound: temporary projections, serialized output and the initial full history require additional memory. The initial full snapshot remains proportional to the full conversation. The patch byte bound applies to JSON payload bytes, excluding SSE framing.

## Recovery and consistency

- Each connection owns its epoch and sequence. Closing one observer does not affect execution or another observer.
- The server captures change markers before assembling projections. Writes during projection remain visible on the next observation.
- Before publishing an initial terminal snapshot, the server rechecks token and structure markers. An already committed safe resume produces `resync` instead of an obsolete terminal snapshot. Terminal limited views also recheck their token before publication.
- Every saved round advances its request observation marker monotonically, including two commits within one wall-clock millisecond. Concurrent late diagnostics from an old round cannot be hidden by a new current-round update.
- A branch, title, editing-task, historical request or historical job structural change emits `resync`. The browser opens another read-only event GET; after two reconnects it uses read-only GET polling.
- `fallback` selects GET polling directly, including view/patch overflow and unavailable observations. Polling never replays submission or recovery POSTs.
- Stop, interrupted/unknown outcomes and completed receipts retain their existing durable meaning. A transport failure after persisted completion does not replace that completion with a fabricated failure.
- A normal send retains its recovery journal while awaiting the POST receipt without showing an uncertain-outcome warning prematurely. A genuinely lost acknowledgement still requires read-only receipt lookup; neither refresh nor observer recovery repeats the send.
- Image progress uses the actual jobs of the round, not its authorization maximum. Pending cards do not offer result actions or declare that no image was generated. A terminal all-failed batch, partial success and an unknown outcome have distinct presentations; successful images remain available even if a sibling failed.
- Structured failure details travel with the public round/job view. A recognized HTTP 413 reports a request-size rejection even when the gateway supplies no usable JSON body. A bounded, sanitized provider explanation may supplement safe codes and moderation fields. Only a verified local pre-dispatch failure can claim that no upstream request was submitted; a provider message cannot establish that fact.
- Normal job discard/accept/delete paths are reflected in job markers and explicit image status. Direct external filesystem deletion does not update database markers; historical image availability refreshes on a subsequent full GET.

Implementation entry points: `backend/services/agent_progress.py`, `AgentRepository.progress_view/progress_structure/progress_token`, `backend/routers/agent.py`, `frontend/src/api/agentProgress.ts`, and `frontend/src/components/agent/useAgentRunState.ts`.

## Reproduce the offline benchmark

Use the same locked Python environment and this version of the script for both source trees. Each invocation imports exactly one source checkout in a separate process. Run sequentially when comparing elapsed time:

```sh
git worktree add --detach ../agent-progress-b0 0f6dbab549ad7d63ad0e652071dc1dadfaad0b67
uv sync --locked --python 3.11
uv run --locked --python 3.11 python scripts/benchmark_agent_progress.py --source-root ../agent-progress-b0 --rounds 5 25 50 100 --repeats 3 --chunks 32 --output ../benchmark-results/progress-b0.json
uv run --locked --python 3.11 python scripts/benchmark_agent_progress.py --source-root . --rounds 5 25 50 100 --repeats 3 --chunks 32 --output ../benchmark-results/progress-current.json
```

The script creates only temporary synthetic libraries. It blocks provider/network connections, never invokes a model or queue worker, and calls the real `get_request_events` endpoint function and `StreamingResponse` iterator. Each history round has a synthetic input image and a local output job; the current answer is persisted in 32 chunks. Every sample validates the final completed state and exactly 33 published state events.

Cold means a fresh synthetic library copy and observer; OS caches are not flushed. Warm means the same synthetic copy after one complete unmeasured observation and resetting the synthetic current request. Each size has three measured cold and three measured warm observations. All tables include the initial snapshot and exclude fixture creation, synthetic durable writes and consumer JSON parsing. The polling interval is set to zero to measure processing rather than scheduled waiting.

## Recorded comparison

- Environment: Windows, Python 3.11.16, SQLite 3.53.1; identical interpreter/dependency environment for both sources.
- Baseline B0: `0f6dbab549ad7d63ad0e652071dc1dadfaad0b67`.
- Candidate base: `ebc84d7e6d49884d410351bca764ae21dd2cd2a7` plus the run-state changes described here. Source file hashes below identify the measured working tree.
- Benchmark script SHA-256: `30a21bf80b9063d36a8eca81eea9ee906a586d5d0739d2c0c986d349c1ce14b1`.

| Measured candidate source | SHA-256 |
| --- | --- |
| `backend/routers/agent.py` | `2b5b8a2c300eda7e5a3ea46921fc7ee63db414366a3ed9220a89b4e2bcb90957` |
| `backend/services/agent_repository.py` | `39d02e9297079a3d1d9ae2a765d22979d662f712f194043b2d37bbf73bdcf05d` |
| `backend/services/agent_progress.py` | `e8adec07e615d7651ed6b783fbd461bf44daeeb170278c6a05a37169eceb0483` |

Each table cell is **median [minimum, maximum]**, followed by ` / ` between **B0 / candidate**. Counts whose range endpoints are equal were identical in all three measured repetitions.

### Projection and SQL

Full snapshot/request calls are exactly **33 [33, 33] / 1 [1, 1]** in every row. Candidate current-round view calls are **32 [32, 32]**; after the initial snapshot its full snapshot/request calls are zero.

| Rounds | Temperature | SQL connections B0 / candidate | SQL statements B0 / candidate | SELECTs B0 / candidate |
| ---: | --- | --- | --- | --- |
| 5 | cold | 630 [630, 630] / 280 [280, 280] | 1,494 [1,494, 1,494] / 990 [990, 990] | 861 [861, 861] / 643 [643, 643] |
| 25 | cold | 2,610 [2,610, 2,610] / 340 [340, 340] | 5,454 [5,454, 5,454] / 1,110 [1,110, 1,110] | 2,841 [2,841, 2,841] / 703 [703, 703] |
| 50 | cold | 5,085 [5,085, 5,085] / 415 [415, 415] | 10,404 [10,404, 10,404] / 1,260 [1,260, 1,260] | 5,316 [5,316, 5,316] / 778 [778, 778] |
| 100 | cold | 10,035 [10,035, 10,035] / 565 [565, 565] | 20,304 [20,304, 20,304] / 1,560 [1,560, 1,560] | 10,266 [10,266, 10,266] / 928 [928, 928] |
| 5 | warm | 630 [630, 630] / 280 [280, 280] | 1,494 [1,494, 1,494] / 990 [990, 990] | 861 [861, 861] / 643 [643, 643] |
| 25 | warm | 2,610 [2,610, 2,610] / 340 [340, 340] | 5,454 [5,454, 5,454] / 1,110 [1,110, 1,110] | 2,841 [2,841, 2,841] / 703 [703, 703] |
| 50 | warm | 5,085 [5,085, 5,085] / 415 [415, 415] | 10,404 [10,404, 10,404] / 1,260 [1,260, 1,260] | 5,316 [5,316, 5,316] / 778 [778, 778] |
| 100 | warm | 10,035 [10,035, 10,035] / 565 [565, 565] | 20,304 [20,304, 20,304] / 1,560 [1,560, 1,560] | 10,266 [10,266, 10,266] / 928 [928, 928] |

### Python JSON parsing

| Rounds | Temperature | All parse calls B0 / candidate | All parsed bytes B0 / candidate | Job metadata parse calls B0 / candidate | Job metadata parsed bytes B0 / candidate |
| ---: | --- | --- | --- | --- | --- |
| 5 | cold | 1,848 [1,848, 1,848] / 440 [440, 440] | 990,276 [990,276, 990,276] / 155,384 [155,384, 155,384] | 330 [330, 330] / 74 [74, 74] | 75,240 [75,240, 75,240] / 16,872 [16,872, 16,872] |
| 25 | cold | 8,448 [8,448, 8,448] / 640 [640, 640] | 4,829,628 [4,829,628, 4,829,628] / 272,766 [272,766, 272,766] | 1,650 [1,650, 1,650] / 114 [114, 114] | 377,256 [377,256, 377,256] / 26,088 [26,088, 26,088] |
| 50 | cold | 16,698 [16,698, 16,698] / 890 [890, 890] | 9,631,986 [9,631,986, 9,631,986] / 419,299 [419,299, 419,299] | 3,300 [3,300, 3,300] / 164 [164, 164] | 755,106 [755,106, 755,106] / 37,538 [37,538, 37,538] |
| 100 | cold | 33,198 [33,198, 33,198] / 1,390 [1,390, 1,390] | 19,237,032 [19,237,032, 19,237,032] / 712,535 [712,535, 712,535] | 6,600 [6,600, 6,600] / 264 [264, 264] | 1,510,872 [1,510,872, 1,510,872] / 60,504 [60,504, 60,504] |
| 5 | warm | 1,848 [1,848, 1,848] / 440 [440, 440] | 990,276 [990,276, 990,276] / 155,384 [155,384, 155,384] | 330 [330, 330] / 74 [74, 74] | 75,240 [75,240, 75,240] / 16,872 [16,872, 16,872] |
| 25 | warm | 8,448 [8,448, 8,448] / 640 [640, 640] | 4,829,628 [4,829,628, 4,829,628] / 272,766 [272,766, 272,766] | 1,650 [1,650, 1,650] / 114 [114, 114] | 377,256 [377,256, 377,256] / 26,088 [26,088, 26,088] |
| 50 | warm | 16,698 [16,698, 16,698] / 890 [890, 890] | 9,631,986 [9,631,986, 9,631,986] / 419,299 [419,299, 419,299] | 3,300 [3,300, 3,300] / 164 [164, 164] | 755,106 [755,106, 755,106] / 37,538 [37,538, 37,538] |
| 100 | warm | 33,198 [33,198, 33,198] / 1,390 [1,390, 1,390] | 19,237,032 [19,237,032, 19,237,032] / 712,535 [712,535, 712,535] | 6,600 [6,600, 6,600] / 264 [264, 264] | 1,510,872 [1,510,872, 1,510,872] / 60,504 [60,504, 60,504] |

### Published frames and retained view

Every B0 observation publishes 33 snapshots and zero patches; every candidate observation publishes one snapshot and 32 patches. These counts are identical in all samples. Published-byte totals and maximum frame sizes include SSE framing. Retained-view bytes are measured serialized JSON; B0 has no retained limited-view object.

| Rounds | Temperature | Total SSE bytes B0 / candidate | Largest frame bytes B0 / candidate | Candidate patch bytes, total | Candidate largest patch frame bytes | Candidate largest retained view bytes |
| ---: | --- | --- | --- | --- | --- | --- |
| 5 | cold | 814,218 [814,218, 814,218] / 46,629 [46,629, 46,629] | 25,210 [25,210, 25,210] / 30,361 [30,361, 30,361] | 16,268 [16,268, 16,268] | 925 [925, 925] | 7,012 [7,012, 7,012] |
| 25 | cold | 3,824,940 [3,824,940, 3,824,940] / 137,938 [137,938, 137,938] | 116,444 [116,444, 116,444] / 121,606 [121,606, 121,606] | 16,332 [16,332, 16,332] | 927 [927, 927] | 7,021 [7,021, 7,021] |
| 50 | cold | 7,589,415 [7,589,415, 7,589,415] / 252,013 [252,013, 252,013] | 230,519 [230,519, 230,519] / 235,681 [235,681, 235,681] | 16,332 [16,332, 16,332] | 927 [927, 927] | 7,021 [7,021, 7,021] |
| 100 | cold | 15,118,596 [15,118,596, 15,118,596] / 480,210 [480,210, 480,210] | 458,676 [458,676, 458,676] / 463,846 [463,846, 463,846] | 16,364 [16,364, 16,364] | 928 [928, 928] | 7,028 [7,028, 7,028] |
| 5 | warm | 814,218 [814,218, 814,218] / 46,555 [46,555, 46,555] | 25,210 [25,210, 25,210] / 30,361 [30,361, 30,361] | 16,194 [16,194, 16,194] | 851 [851, 851] | 7,012 [7,012, 7,012] |
| 25 | warm | 3,824,940 [3,824,940, 3,824,940] / 137,864 [137,864, 137,864] | 116,444 [116,444, 116,444] / 121,606 [121,606, 121,606] | 16,258 [16,258, 16,258] | 853 [853, 853] | 7,021 [7,021, 7,021] |
| 50 | warm | 7,589,415 [7,589,415, 7,589,415] / 251,939 [251,939, 251,939] | 230,519 [230,519, 230,519] / 235,681 [235,681, 235,681] | 16,258 [16,258, 16,258] | 853 [853, 853] | 7,021 [7,021, 7,021] |
| 100 | warm | 15,118,596 [15,118,596, 15,118,596] / 480,136 [480,136, 480,136] | 458,676 [458,676, 458,676] / 463,846 [463,846, 463,846] | 16,290 [16,290, 16,290] | 854 [854, 854] | 7,028 [7,028, 7,028] |

At 100 rounds, cold median publication drops from 15,118,596 to 480,210 bytes (96.82%). After the initial snapshot, the candidate uses 610 SELECTs for 32 updates at every tested history size. Its Python JSON parsing after that initial snapshot is 126,198 / 126,454 / 126,486 / 126,710 bytes at 5 / 25 / 50 / 100 rounds, respectively; these counts are identical across all cold and warm repetitions.

Python image file opens, image read calls and image read bytes are **0 [0, 0]** in both versions for every measured stream. This is a metadata/projection/transport improvement; it does not establish a pixel-payload reading improvement.

### Instrumented processing time

These elapsed values include instrumentation. The recorded source processes overlapped for part of the run, so these are descriptive local observations, not precise latency speedup ratios. They exclude the configured polling wait and cannot predict provider time, first-token latency, or model cost.

| Rounds | Temperature | Instrumented milliseconds B0 / candidate |
| ---: | --- | --- |
| 5 | cold | 1,289.29 [1,251.71, 1,305.71] / 614.87 [590.29, 632.36] |
| 25 | cold | 5,143.72 [5,040.35, 5,191.28] / 767.69 [764.09, 788.33] |
| 50 | cold | 10,153.51 [10,051.31, 10,181.10] / 1,058.13 [1,041.72, 1,082.52] |
| 100 | cold | 19,530.56 [19,172.36, 19,754.66] / 1,822.06 [1,780.28, 1,852.88] |
| 5 | warm | 1,324.35 [1,259.95, 1,327.68] / 633.05 [616.92, 633.58] |
| 25 | warm | 5,124.24 [5,012.13, 5,362.21] / 832.38 [755.62, 859.15] |
| 50 | warm | 9,885.56 [9,396.70, 10,328.38] / 1,086.07 [1,061.28, 1,110.32] |
| 100 | warm | 19,480.99 [19,091.24, 19,557.97] / 1,834.42 [1,773.67, 2,038.32] |

### Counting limits

- JSON counters wrap Python `json.loads`. Job metadata counts identify decoded objects with `agent` or `agentRetry` keys. They exclude SQLite's internal `json_extract` evaluation.
- A constant SELECT count does not imply constant database work. Structural markers still read historical identities/statuses, and retry-job filtering may inspect task metadata inside SQLite.
- Image counters cover Python binary reads under synthetic reference/result directories. They exclude SQLite internal file reads and filesystem metadata operations.
- Reported retained bytes describe the serialized limited view, not peak resident memory. Both the initial full snapshot and the browser's canonical conversation retain full history.
- No tokenizer, prompt-cache, model throughput or real-provider behavior was measured.

## Verification and independent review

The affected progress suites passed **33 tests** after the final race guards: current-view/full-snapshot equivalence; forbidden full-history reads during ordinary progress; UTF-16/repeated-text patches; sequence and size bounds; job-only changes; deleted results; multiple observers; disconnects; lost terminal publication; same-millisecond historical/current writes; and safe resume during both initial snapshot and terminal projection.

A separate read-only review of the backend projection, marker, SSE and recovery changes found no new definite blocking regression. It checked normal historical job removal/acceptance, branch changes, safe-resume races and the benchmark exclusion boundaries. It did not equate filesystem-only changes with persisted database events, or serialized byte limits with Python heap limits.

The Responses adapter extraction was independently compared with the earlier implementation: seven moved helper functions had identical ASTs. The executor continues to own durable writes and scheduling. Full-suite and browser acceptance should be reported separately against the final reviewed source revision; this document's benchmark does not replace them.

The browser acceptance found a separate stop race: the stop receipt can precede the worker's final diagnostic write. The next explicit send now reads the stopped/unknown request's latest revision before its first POST. It only accepts the revision refresh when branch, request, round, prompt, references, mask and editing-task bindings still match. A semantic change preserves the draft and requires a new user decision; a rejected POST is never replayed automatically. Hook regressions also cover new text/attachments during this read, selection changes and unmount.

## S1–S10 acceptance evidence map

These are the requested acceptance scenarios, distinct from preview recipes P1–P10 in [AGENT_PREVIEW.md](AGENT_PREVIEW.md). Test names below identify existing executable evidence; the browser column is limited to the synthetic-provider checks recorded there. All real-model visual understanding, prompt quality and image quality remain **unverified**. The pinned LibreChat/agents/Open WebUI audit in [AGENT_ARCHITECTURE.md](AGENT_ARCHITECTURE.md) supplies source/module and SDK-probe evidence only, not a three-platform end-to-end comparison.

| Case / requested scenario | Existing application evidence | Browser evidence and remaining limit |
| --- | --- | --- |
| S1 — Single-image visual analysis | `tests/test_agent_context_correctness.py::test_exact_reference_only_sends_the_bound_asset_not_other_history` checks the actual outgoing image binding. The architecture document records the one-PNG SDK mock probe. | Library-image selection and reference submission exercised. Image understanding/analysis accuracy was not tested with a real model; this is input-delivery evidence. |
| S2 — Image-to-prompt → English refinement → local prompt revision | `tests/test_preview_agent.py::test_text_and_skill_are_executed_and_saved_through_real_routes`; `tests/test_agent_context_pipeline.py::test_only_exact_paired_skill_receipts_are_reused_without_rewriting_history`. | Text and Skill chapter reads exercised. The complete three-stage semantic workflow and quality of English/refinement are not independently accepted; mocks establish routing, receipts and persistence only. |
| S3 — Reuse the same image across historical rounds | `tests/test_agent_context_pipeline.py::test_default_projection_preserves_repetitions_order_roles_and_originals` and `test_experimental_dedup_keeps_every_alias_and_turn_text`; repeated-image 5/25/50/100 benchmarks in the architecture document. | Successive image edits exercised. Serialized pixel aliasing remains off by default; real-model equivalence of the optional experiment is unverified. |
| S4 — New image is the editing target; old image supplies lighting only | `tests/test_agent_context_pipeline.py::test_equal_pixels_do_not_collapse_a_new_editing_target_into_an_old_reference` and `test_one_asset_in_generated_and_current_target_positions_keeps_both_roles` preserve distinct business roles. | Successive edits and selecting references exercised. The exact lighting-only interpretation is not claimed as browser/model acceptance. |
| S5 — Compare images while retaining every necessary image | `tests/test_agent_context_correctness.py::test_outgoing_request_keeps_historical_pixels_when_scope_is_uncertain`; `tests/test_agent_execution_correctness.py::test_native_more_than_four_context_images_preserves_complete_record_and_result`. | Reference selection and generation infrastructure exercised. Cross-image comparison accuracy and a complete semantic comparison walkthrough remain unverified. |
| S6 — Explicit image failure, change current settings, retry directly | `tests/test_preview_agent.py::test_partial_batch_and_explicit_retry_only_add_one_image_post`; existing image-retry contracts retain frozen references and distinguish unknown outcomes from explicit failure. | Three jobs yielded two successes and one failure. After changing profile, retrying only the failed member added one Images POST and zero Responses POSTs. No paid provider was called. |
| S7 — Switch pages, disconnect, reconnect and stop during streaming | `tests/test_agent_progress_updates.py::test_multiple_observers_and_disconnect_preserve_execution_and_other_cursor`, `test_lost_terminal_publication_recovers_persisted_success_by_get`, and both safe-resume race tests; `tests/test_preview_agent.py::test_slow_stream_can_be_stopped_without_another_post`. | Page switching with draft retention, browser network interruption/reconnect, refresh, stop/new request, two tabs and blocked-SSE polling were exercised without duplicate provider POSTs. Remote-provider cancellation is unverified. |
| S8 — Histories of 5 / 25 / 50 / 100 rounds | `scripts/benchmark_agent_pipeline.py` and `scripts/benchmark_agent_progress.py`: actual request bodies and actual progress-route iteration, three cold plus three warm measurements per size; recorded ranges in the architecture document and above. | Synthetic offline measurement, not a long-history real-model quality or latency test. Initial full history still grows; only subsequent progress avoids rebuilding it. |
| S9 — Mask target together with other reference images | `tests/test_agent_context_pipeline.py::test_mask_keeps_target_first_and_every_occurrence_with_alpha` covers default and experimental paths; the context benchmark includes the mask probe. | No dedicated browser mask walkthrough is claimed. Binding/order/alpha transport are covered by synthetic tests; visual mask adherence remains unverified. |
| S10 — Edit a historical message to create a branch | `tests/test_agent_context_correctness.py::test_branch_request_includes_ancestors_but_never_sibling_pixels`; `tests/test_agent_context_pipeline.py::test_experimental_projection_never_acquires_sibling_branch_pixels`; `tests/test_preview_agent.py::test_generated_image_edit_branch_and_library_accept_use_real_persistence`. | Editing an earlier round created a distinct visible branch; switching back restored the original later rounds/results. Branch-content quality is unverified. |

Source references remain pinned to LibreChat `8d3da9bbb220a0a96be9330a2e1cbd385fb786d5`, agents `c56fc5eb7d141a25976c1886520ab4dac745ae07`, and Open WebUI `33c1978d5bad52a31df75ea55143025dfad18d16`. Exact candidate files and inspected upstream tests are listed in the architecture document. No tracked Open WebUI tests were found for its candidate behaviors; separate offline checks must not be labeled upstream test execution. This map does not imply that all ten semantic scenarios passed on all three applications.
