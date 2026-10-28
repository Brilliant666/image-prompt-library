# Agent architecture boundaries and reference audit

The Agent remains an image workflow inside Image Prompt Library. The existing asset store, Gallery queue, SQLite history, provider profiles and authorization checks remain authoritative. This document records implementation boundaries and the SDK experiment; it does not certify unfinished implementation stages, full upstream applications or real-provider acceptance.

## Boundaries

- **Canonical history:** preserve original prompts, image bytes, branch ancestry, tool receipts and frozen submission configuration. A model request is a rebuildable projection, never a destructive rewrite of that history.
- **Context assembly:** resolve the selected branch, current editing task, necessary image roles, Skill receipts and tool call/result pairs once. Provider serialization consumes that assembled view. Diagnostics describe counts, coverage, estimated budget and serialized bytes without including prompts, base64 or credentials.
- **Images:** keep asset identity separate from content equality. Request-local read/encoding reuse does not imply pixel deduplication in the serialized request. Any pixel deduplication must preserve visible evidence, source references, detail/transform distinctions and target/mask ordering, and remain explicitly reversible until real visual acceptance.
- **Runtime observation:** one run-state owner coordinates frozen submissions, observation, stop and late receipts. Start and observe are separate operations. A snapshot can establish or repair an observer baseline; ordinary streaming should publish bounded current-request changes. Gaps, stale identities and backend restarts require read-only resynchronization, never another provider POST.
- **Terminal truth:** persisted image success outranks a later transport failure. Text completion, tool-argument completion, saved image success and an attached browser are different states. Stop prevents work where the executor can actually stop it; unknown upstream work is not automatically replayed.
- **Budget and Skills:** distinguish local estimates from provider usage. An unknown model window remains unknown; base64 length is not visual token usage. Keep both existing Skill cores and on-demand additional sections. Automatic history compaction, a fixed last-N image policy and background model calls are not enabled by these boundaries.

## Fixed references and adoption

Reference labels resolve to these immutable revisions:

- **LC:** [LibreChat `8d3da9bbb220a0a96be9330a2e1cbd385fb786d5`](https://github.com/LibreChat-AI/LibreChat/tree/8d3da9bbb220a0a96be9330a2e1cbd385fb786d5), [MIT license](https://github.com/LibreChat-AI/LibreChat/blob/8d3da9bbb220a0a96be9330a2e1cbd385fb786d5/LICENSE), copyright 2026 LibreChat.
- **LA:** [agents `c56fc5eb7d141a25976c1886520ab4dac745ae07`](https://github.com/LibreChat-AI/agents/tree/c56fc5eb7d141a25976c1886520ab4dac745ae07), [MIT license](https://github.com/LibreChat-AI/agents/blob/c56fc5eb7d141a25976c1886520ab4dac745ae07/LICENSE), copyright 2024 LibreChat.
- **OW:** [Open WebUI `33c1978d5bad52a31df75ea55143025dfad18d16`](https://github.com/open-webui/open-webui/tree/33c1978d5bad52a31df75ea55143025dfad18d16), [Open WebUI License](https://github.com/open-webui/open-webui/blob/33c1978d5bad52a31df75ea55143025dfad18d16/LICENSE) and [license history](https://github.com/open-webui/open-webui/blob/33c1978d5bad52a31df75ea55143025dfad18d16/LICENSE_HISTORY).

| Source files at the revision above | Problem addressed / decision | Reuse and dependency boundary | Relevant upstream tests inspected |
| --- | --- | --- | --- |
| LA `src/messages/format.ts`, `src/messages/toolHistoryProjection.ts` | Derive provider messages while retaining actor, call identity and order; validate call/result pairing. | Independently implement the pattern; no runtime dependency. | `src/messages/toolHistoryProjection.test.ts`, `formatAgentMessages.tools.test.ts`, `formatAgentMessages.skills.test.ts` |
| LA `src/agents/projection.ts`, `src/agents/AgentContext.ts` | Account for instruction/tool/message overhead without modifying canonical branch input; report unknown window explicitly. | Pattern only; no SDK tokenizer assumption for images or hand-entered models. | `src/agents/__tests__/projection.test.ts`, `AgentContext.test.ts` |
| LA `docs/summarization-behavior.md`, `src/messages/prune.ts` | Inspect the tradeoff between bounded context and retained evidence. SDK masking/fading can discard older material even with summarization disabled. | Do not adopt default automatic pruning or additional summary calls. | `src/messages/budget.test.ts`, `contextPruning.test.ts` |
| LC `client/src/hooks/SSE/useResumableSSE.ts`; `packages/chat/src/core/resumable/{run,subscription,resume,terminal}.ts` | Separate the UI adapter from one run owner; leaving a page detaches observation; stale lifecycle callbacks are fenced. | Pattern only. `packages/chat/package.json` declares `private: true` and internal workspace peers; it is not an independently installable SDK. | `packages/chat/src/core/__tests__/{subscription,resume,terminal,mount}.spec.ts` |
| LC `packages/chat/src/core/stream/state.ts`, `packages/chat/src/core/reducer.ts` | Keep authoritative streaming content outside component rendering; batch display effects and handle deltas that precede their step. | Pattern; preserve existing request/round/call/job identities. | `packages/chat/src/core/__tests__/{reducer,steps,frames}.spec.ts` |
| LC `packages/api/src/stream/GenerationJobManager.ts`, `interfaces/IJobStore.ts`, `internal/coalescing.ts` | Close the snapshot/subscription race; bound replay and batches; persist terminal evidence before publication. | Adapt to existing SQLite and worker. No Redis, distributed job manager or new scheduler. | `packages/api/src/stream/__tests__/reconnect-reorder-desync.stream_integration.spec.ts`, `GenerationJobManager.resumeReplay.spec.ts`, `idempotencyClaim.spec.ts`, `deltaCoalescing.spec.ts` |
| LC `packages/api/src/stream/terminalProjection.ts` | Exclude transient model-input image bytes from terminal caches/replay while keeping result metadata. | Pattern; do not delete the canonical asset or output attachment text. | `packages/api/src/stream/__tests__/terminalProjection.spec.ts`, `terminalProjectionBoundary.stream_integration.spec.ts` |
| LC `packages/api/src/files/encode/image.ts`, `memoryGuard.ts` | Centralize validated reads, explicit storage dependencies, bounded encoding and provider formatting; retain input order. | Pattern around the existing frozen-asset and PNG cache implementation. It is not evidence of safe serialized-pixel deduplication. | `packages/api/src/files/encode/{image,memoryGuard,processAttachments}.spec.ts` |
| OW `backend/open_webui/utils/context_compaction.py`, `models/chat_messages.py`, `utils/misc.py` | Selected ancestry, checkpoints bound to a branch/boundary, and adjacent tool-batch pairing. | General patterns only; no copying or translation. Do not adopt fixed image-token estimates or automatic fallback truncation. | No tracked upstream tests for these candidate behaviors were found at the pinned revision. Separate offline module checks are not upstream test execution. |
| OW `backend/open_webui/utils/middleware.py`, `utils/skill_files.py` | Explicit version/section receipts and bounded Skill paging. | General patterns only; preserve the current two Skill cores and explicit section reads. No Skill platform dependency. | Same upstream-test limitation as above. |

Open WebUI's current license includes branding conditions; historical MIT/BSD material does not make the current repository uniformly MIT. A deployment-size exception is not a permanent exemption for public redistribution. No Open WebUI implementation is copied or translated here. MIT code copied or adapted in a future change must retain its applicable notice and source attribution. This audit does not change the project's existing license.

## SDK experiment and decision

The optional [development probe](../scripts/agent_sdk_probe/README.md) pins the public package **`@librechat/agents@4.1.1`**. Its relevant published source files (`format.ts`, `projection.ts`, `responses/index.ts`, `llm/fake.ts`) were hash-compared with LA and matched. The probe adds no production dependencies or Node sidecar.

Three module-level checks passed:

1. Synthetic PNG → actual SDK `Run` / mock model → optimized prompt → `DynamicStructuredTool` → the application's real `execute_calls`, existing Gallery queue and image provider persistence, with only provider HTTP mocked. The result was one saved PNG, two mock model invocations and one `/images/edits` request. The SDK content aggregator produced the final response; a development HTML viewer displays the saved job result.
2. SDK `AbortSignal` after the first text delta prevented image-tool dispatch: one model invocation, zero image-tool calls.
3. The actual context-projection module returned `null` for an unknown window and preserved canonical message content with a known synthetic window. Its text-only test counter is not a production token estimator.

Across the real application adapter, changed settings did not replace the frozen image model; repeating the same tool call returned the same job without another image POST; unknown-outcome replay was rejected; a stopped request rejected later work. These protections remained responsibilities of the application, not new guarantees supplied by the SDK. Stable message IDs and the application's explicit asset-reference mapping were required.

**Retain the current execution engine for this change.** The SDK can drive the Hybrid adapter, but the experiment did not show a maintenance benefit sufficient to replace the engine: frozen assets/configuration, SQLite recovery, idempotency and Gallery ownership still need host integration, while deployment would acquire a second runtime and an IPC/API lifecycle.

Installation is part of that cost. SDK 4.1.1 requires Node >=24 and declares 38 direct dependencies. An initial unconstrained public install resolved incompatible OpenTelemetry peers and failed root import (`SeverityNumber` missing from API 1.9.1 after an exporter/transformer 0.300.0 resolution). The probe locks six compatible transitive versions from the inspected source lock: four Langfuse packages at 5.10.1 and two OpenTelemetry exporter packages at 0.220.0. Its tested graph contains 279 installed package instances; this is an isolated development graph, not the application bundle. The SDK also declares Reova install telemetry, so install scripts are disabled and runtime telemetry is opted out before import.

Native support is partial evidence, not an absence claim: LA's OpenAI adapter recognizes native image-generation and partial-image events, with tests in `src/llm/openai/contentBlocks.test.ts`. Its separate outward `src/responses/index.ts` writer models message/function/reasoning items. Full Native failed/incomplete behavior, masks, image persistence and restart recovery through an SDK path were not accepted by this Hybrid probe. Existing product safeguards remain necessary.

No real model, image, search, title or summary service was called. Full LibreChat/Open WebUI application behavior, real visual understanding, TTFT, provider cache hits, latency and cost remain unverified. Local mock timings do not establish those outcomes.

## Reproducible context baseline

B0 is PR #22 commit `0f6dbab549ad7d63ad0e652071dc1dadfaad0b67`. Both trees used Python 3.11.16, the same locked dependencies (normalized `uv.lock` SHA-256 `7d4e77e377c616e0d891b8a065a3816993d4dcc7cedfafc8e4575f3441f50779`), synthetic PNGs and `scripts/benchmark_agent_pipeline.py`. Each cold and warm group contains three independent measurements. Cold clears application image-encoding caches, not the OS page cache. Instrumentation runs separately from wall-clock measurements. Values below are milliseconds: median [minimum–maximum].

The default path produced byte-identical actual HTTP request bodies for all 12 text/repeated-image/unique-image matrix cases and the mask, branch and tool-pair probes. Opt-in pixel aliasing is **off by default**. No source image or canonical prompt is replaced.

| Scenario | Rounds | B0 cold build | New cold build | B0 warm build | New warm build | Request bytes (default) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| text | 5 | 1.80 [1.75–1.82] | 2.14 [2.14–2.31] | 1.77 [1.73–1.85] | 1.94 [1.91–2.04] | 18,509 |
| text | 25 | 1.97 [1.93–2.31] | 2.33 [2.22–2.52] | 2.12 [1.91–2.83] | 2.80 [2.42–3.28] | 39,185 |
| text | 50 | 2.52 [2.17–2.54] | 4.81 [4.66–5.02] | 2.12 [2.10–2.21] | 4.86 [4.53–5.20] | 65,035 |
| text | 100 | 3.39 [2.65–3.49] | 6.16 [5.90–7.30] | 2.81 [2.69–3.29] | 6.06 [5.88–6.68] | 116,736 |
| repeated_image | 5 | 29.28 [29.04–29.45] | 60.59 [57.06–65.02] | 30.05 [29.04–30.78] | 56.65 [56.36–61.97] | 28,903 |
| repeated_image | 25 | 148.95 [141.60–151.58] | 239.14 [236.96–247.69] | 143.92 [140.58–151.85] | 243.40 [233.15–249.75] | 87,395 |
| repeated_image | 50 | 273.35 [261.70–285.29] | 452.12 [441.90–469.19] | 290.41 [286.86–305.21] | 441.88 [438.14–443.50] | 160,520 |
| repeated_image | 100 | 527.70 [526.98–544.89] | 914.63 [897.59–962.06] | 534.75 [526.98–554.79] | 923.01 [918.28–943.37] | 306,772 |
| unique_images | 5 | 29.61 [28.52–33.39] | 102.64 [100.97–102.89] | 28.21 [27.78–29.21] | 94.62 [93.13–100.66] | 28,903 |
| unique_images | 25 | 153.74 [144.59–154.36] | 489.68 [482.43–490.59] | 134.75 [133.31–137.33] | 475.06 [462.32–483.62] | 87,391 |
| unique_images | 50 | 299.69 [287.20–308.82] | 933.84 [920.62–936.33] | 271.14 [269.97–285.69] | 909.31 [893.68–946.52] | 160,516 |
| unique_images | 100 | 598.56 [586.19–607.79] | 1163.71 [1157.28–1256.61] | 540.67 [537.33–566.99] | 1150.68 [1078.91–1376.69] | 306,764 |

**This is not a local wall-clock speedup.** The added source/version checks, final preflight and diagnostics increase context construction time in this Windows sample. The measured gain is fewer image reads/encodes, and optionally fewer serialized pixels. Those are distinct from provider latency. Removing redundant metadata work is a follow-up profiling target; integrity checks must remain.

| Repeated-image rounds | B0 image opens / encodes | New image opens / encodes | Default bytes | Experimental bytes | Serialized images default → experiment |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 5 | 10 / 5 | 1 / 1 | 28,903 | 22,475 | 5 → 1 |
| 25 | 50 / 25 | 1 / 1 | 87,395 | 48,827 | 25 → 1 |
| 50 | 100 / 50 | 1 / 1 | 160,520 | 81,777 | 50 → 1 |
| 100 | 200 / 100 | 1 / 1 | 306,772 | 147,679 | 100 → 1 |

At 100 repeated images, audited image-stream reads fell from 39,400,600 to 196,993 bytes; this includes PIL reads, not only explicit `read_bytes` calls. Unique-image input still reads each original: no artificial cross-asset identity merge. Encoded request-local cache retention is bounded to 64 images / 64 MiB; overflow is sent uncached, never discarded. Same-content references with different target/auxiliary/generated/reference roles remain separate. Mask requests preserve all positions and first-image binding.

| Repeated-image rounds | B0 snapshot cold | New snapshot cold | B0 snapshot warm | New snapshot warm | B0 → new build SQL statements |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 5 | 14.13 [13.98–14.39] | 25.89 [24.70–26.09] | 14.02 [13.29–15.07] | 24.15 [23.13–24.32] | 14 → 16 |
| 25 | 51.66 [50.41–52.94] | 85.20 [83.08–85.85] | 56.55 [53.13–61.31] | 90.30 [86.10–91.98] | 54 → 56 |
| 50 | 104.25 [103.15–105.22] | 167.33 [164.97–171.15] | 93.81 [93.59–101.30] | 175.97 [160.83–187.55] | 104 → 106 |
| 100 | 190.55 [187.18–192.86] | 331.31 [326.74–336.91] | 191.88 [189.94–192.43] | 323.69 [320.13–343.00] | 204 → 206 |

Reproduce with the benchmark CLI (`--help`) against both checked-out source trees using one locked environment. Its wire hashes, source fingerprints and cold/warm ranges are evidence about local synthetic calls, not token counts, billing, prompt-cache hits or visual interpretation. Request diagnostics report exact byte/text composition and an **unknown** model window/token budget when no verified tokenizer/capability source exists. No history truncation or summary call is used.
