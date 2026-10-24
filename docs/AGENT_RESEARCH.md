# Agent context, execution and recovery baseline

Research baseline: `594a11639c6191d266e10836f1a08ada261e12e2`, the documentation-corrected head of PR #15. This research branch is based on `codex/agent-core-integration`, not `main`. It adds diagnostic tools, tests and this report; it does **not** change the production Agent, replace its Harness, migrate data, or deploy a runtime.

## Result and decision

Keep the existing execution engine for now. First repair the four bounded correctness gaps below, then measure the actual network/provider stages before selecting a performance intervention. Introduce explicit context management incrementally if long-conversation measurements justify it. A mature Harness is an architectural option, not evidence that provider waiting time or cache misses will disappear.

The offline baseline proves growth in serialized requests, local work and frozen history. It does **not** establish the cause of any user's real API latency, real cache hit rate, or bill. Large supported model context is a capacity limit; it does not by itself establish cache reuse or latency.

Related evidence:

- [Execution and recovery findings](AGENT_EXECUTION_RESEARCH.md): deterministic failure probes, safety properties, and request-count versus money limits.
- [PR #14 coverage comparison](AGENT_PR14_COVERAGE.md): all 41 changed paths examined, with implementation and regression mapping.
- [Context diagnostic](../scripts/diagnose_agent_context.py): actual request construction, SQLite traces and snapshot measurements with synthetic data.
- [Failure probes](../tests/test_agent_risk_research.py): `characterizes` tests reproduce **unfixed** defects. Passing these is not a repair certificate.

## Reproduction and measurement boundary

Use a development environment with the project's Python dependencies installed:

```sh
python scripts/diagnose_agent_context.py
python scripts/diagnose_agent_context.py --rounds 1 5 --repeats 1
python scripts/diagnose_agent_result_snapshots.py
python -m pytest tests/test_agent_context_diagnostic.py tests/test_agent_risk_research.py -q
```

The script always creates a new temporary library and synthetic provider configuration. It does not accept an existing library or provider path. Socket connections are blocked, and `call_responses` receives a local `httpx.MockTransport`; no text, image, search or organizer provider executes. Only aggregate counters are printed, not prompts, payloads, credentials or images. Temporary files are removed at exit. Run measurements serially for cleaner timing; do not interpret timing as an SLA.

Two main fixtures use the same deterministic prompt and assistant text:

- Text history: previous rounds contain text only.
- Image history: each round attaches one valid 256 × 256 synthetic noise PNG of **197,104 bytes**. Each upload has its own asset identity. The task explicitly compares prior composition requirements, so all historical pixels remain relevant. This is deliberately a full-context workload, not an assertion that every task sends all images.

The round count includes the new current request: 100 means 99 completed ancestors plus the current round. Historical image bytes below exclude the current image; the outbound request includes it. Seeded prior replies are simplified text rather than complete provider traces. Only measurement checkpoints call the mock Responses path. Snapshot measurements occur before the current mock response; metadata, generated-image jobs, branches and streaming histories can make real snapshots larger. This baseline is not a comprehensive user-history replay.

`request_json_bytes` is the actual UTF-8 HTTP request body captured after production construction and HTTPX serialization. It is **not** a token count. The local context timing includes `repo.request`, `refs_for_request` and `build_input`; snapshot timing covers `repo.snapshot(request_id=...)`. Each is measured three times with actual SQLite connection/statement tracing. Timing includes trace overhead, file reads, JSON work and OS caching. Setup/seed time, external HTTP, provider scheduling, prefill, reasoning, generation and browser rendering are excluded. `create_round_once_ms` is separately reported and includes the script's revision/config reads; it is not a pure database insert measurement.

## Quantified baseline

Observed on Windows, Python 3.10.10, three samples per read operation. Median times are milliseconds; exact JSON/image bytes and SQL counts are the more reproducible comparison dimensions. Timings vary with filesystem, antivirus, machine load and cache state.

### Text history

| Total rounds | Request JSON bytes | Historical image bytes | Context ms / SELECTs | Snapshot ms / SELECTs | Sum of stored history JSON bytes |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 7,718 | 0 | 2.640 / 3 | 6.189 / 7 | 2 |
| 5 | 11,850 | 0 | 1.549 / 3 | 4.549 / 7 | 17,606 |
| 25 | 32,526 | 0 | 1.585 / 3 | 4.531 / 7 | 467,546 |
| 50 | 58,376 | 0 | 2.014 / 3 | 5.833 / 7 | 1,860,521 |
| 100 | 110,077 | 0 | 2.329 / 3 | 7.956 / 7 | 7,386,896 |

### One input image per round

| Total rounds | Request JSON bytes | Historical image bytes | Context ms / SELECTs | Snapshot ms / SELECTs | Sum of stored history JSON bytes |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 270,652 | 0 | 6.790 / 4 | 5.830 / 8 | 2 |
| 5 | 1,326,520 | 788,416 | 27.135 / 8 | 12.313 / 12 | 18,036 |
| 25 | 6,605,892 | 4,730,496 | 126.988 / 28 | 41.325 / 32 | 480,446 |
| 50 | 13,205,117 | 9,658,096 | 414.879 / 53 | 122.084 / 57 | 1,913,196 |
| 100 | 26,403,569 | 19,513,296 | 820.387 / 103 | 235.339 / 107 | 7,599,746 |

At 100 rounds, 100 attached PNG occurrences contribute 19,710,400 raw bytes and 26,280,800 Base64 bytes. This accounts for most of the 26.4 MB request. The script reads each asset through the real repository path; context SELECT count is `3 + images`, snapshot SELECT count is `7 + input images` in this fixture. Text-only operation count stays constant while parsed history size grows. This is evidence of local scaling cost, not proof that it dominates an upstream wait measured in tens of seconds.

Every request stores its ancestor history JSON. The sum across requests grows approximately quadratically for this linear fixture, even though a single outgoing request grows approximately linearly. See [`create_round`](../backend/services/agent_repository.py#L430) and [`request`](../backend/services/agent_repository.py#L521). Freezing history protects branch/replay correctness; eliminating it without an equivalent immutable contract would be a regression.

### Generated-result freezing, measured separately

The [result snapshot diagnostic](../scripts/diagnose_agent_result_snapshots.py) stages one distinct deterministic 64 × 64 PNG (**12,420 bytes**) per completed round using the real local job repository. No generation worker or provider runs. It measures `create_round` once (repeating would measure request replay), then measures the completed round's snapshot three times. This fixture has generated results and no input uploads, unlike the preceding table.

| Completed rounds | Frozen original files | Distinct frozen image hashes | Frozen bytes | Original result bytes | Create-round ms / SELECTs | Snapshot ms / SELECTs |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 5 | 10 | 4 | 124,200 | 62,100 | 71.492 / 30 | 15.513 / 17 |
| 25 | 300 | 24 | 3,726,000 | 310,500 | 348.070 / 110 | 60.068 / 57 |
| 50 | 1,225 | 49 | 15,214,500 | 621,000 | 1,217.092 / 210 | 203.912 / 107 |
| 100 | 4,950 | 99 | 61,479,000 | 1,242,000 | 2,436.988 / 410 | 418.196 / 207 |

The frozen file count is `n(n−1)/2`: each later request copies every ancestor's result into a new immutable asset. [`resolve_ref`](../backend/services/agent_repository.py#L358) calls `store_asset`, and `create_round` repeats this for historical outputs. At 100 rounds, create-round opens 501 SQLite connections and snapshot opens 203 in this fixture. These counts include the production snapshot returned by create-round. File size and time grow even though the logical number of distinct images is small.

This is a confirmed storage/submit-latency scaling risk, **already present in the compared main baseline** (`efdba43`); it is not newly introduced by the documentation or research PR. It deserves a prioritized follow-up: evaluate immutable asset reuse with explicit reference ownership and retention. Do not delete snapshots or deduplicate files ad hoc: the existing frozen-reference guarantee protects regeneration after source results are removed. The synthetic result size is deliberately small; no claim is made about a real library's disk consumption or deletion eligibility.

## First call, later rounds and tool follow-ups

The baseline's first request is 7,718 bytes for text or 270,652 bytes with an image. At later checkpoints, earlier `input` items remain exactly equal at the JSON structure level: 1 → 5, 5 → 25, 25 → 50 and 50 → 100 preserve respectively 1, 9, 49 and 99 leading items. Instructions and tool definitions also remain equal while the task, configuration and quota state stay fixed.

Each sampled prompt preloads `gpt-image/overview` and `gpt-image/composition`: **2,861 UTF-8 bytes of section content**. The always-present skill catalog is **1,023 bytes**. These are adapted bundled sections, not the complete upstream repositories and not arbitrary installed executable skills. [`agent_skills.py`](../backend/services/agent_skills.py) selects sections from task text and relevant-image presence; recognition is heuristic, not a general intent model.

For the 100-round tool-follow-up diagnostic, a deterministic `read_agent_skill` receipt is inserted into the current round through the real repository. This models a provider choosing a skill call despite preloading; it does not assert that providers commonly do so. `call_responses` then builds the actual next request:

| Follow-up state | Text JSON bytes | Image JSON bytes | Tool definitions equal to first call? |
| --- | ---: | ---: | --- |
| No image quota consumed | 112,025 | 26,405,517 | Yes |
| One of two image slots consumed | 112,025 | 26,405,517 | No: remaining batch bound changes |
| Two image slots consumed | 110,396 | 26,403,888 | No: image tools disappear |

All 199 prior input items and all 100 image occurrences are resent in this simulated follow-up. The 1,702-byte skill result remains in `input`, while preloaded instructions are repeated too. Image counters are changed only in the isolated fixture; no real image job is dispatched by this diagnostic. A quota change can leave byte length equal while changing content, so payload length alone cannot diagnose cache stability.

Changing the current task to a greeting removes the preloaded sections and changes instructions from 5,198 to 2,091 bytes. The updated diagnostic resets quota before this comparison, holding tool definitions constant. In image history it also narrows old image attachment. This is a controlled input-shape observation, not an estimate of provider token savings.

## Prompt Cache: evidence versus hypotheses

Confirmed locally:

1. Ordinary append-only rounds can retain matching instructions, tools and leading input items.
2. Quota-dependent `tools_for` schemas change between tool steps. Task-dependent skill preloading changes `instructions`. Image selection can change earlier input items from pixels to `available_ref` text. Editing an ancestor/branch changes the retained path. These are plausible prefix disruptions.
3. [`response_usage`](../backend/services/agent_repository.py#L74) preserves missing `cached_tokens` as `None`; explicit numeric zero stays zero. The aggregate becomes unknown if a contributing step omits the field. No mock usage is presented as a real cache hit.

OpenAI's [Prompt caching documentation](https://developers.openai.com/api/docs/guides/prompt-caching) describes reuse of a matching rendered prefix, including tools and multimodal content. JSON key order or equal raw-body byte prefixes are not themselves the model's rendered token prefix. Model/settings, routing and retention also matter. Those official rules do not establish that an arbitrary compatible gateway preserves the same behavior or even forwards all usage fields.

Unverified: provider cache eligibility for a given alias/account; gateway routing stability; whether usage fields are stripped or transformed; actual cache writes/reads; impact on prefill latency; hidden reasoning time; whether a slow response spent time before reaching the model. No paid or authenticated endpoint was queried. Do not label missing telemetry zero, a client serialization match a cache hit, or a Harness switch a cache fix.

A subsequent separately authorized measurement should timestamp enqueue, worker start, context construction, POST dispatch, response headers, first semantic event, first visible delta, tool start/end and terminal receipt. Record only byte counts, durations, stable anonymized request identifiers and provider-reported usage presence/values. Correlate with authorized gateway telemetry before ranking network, provider queue, prefill, reasoning or local overhead. Do not log prompts, image Base64 or credentials by default.

## Merge gates and follow-up scope

The dedicated [execution report](AGENT_EXECUTION_RESEARCH.md) supplies source locations and runnable reproductions. Four P2 issues should be corrected **before PR #15 is merged**, then changed from characterization assertions to desired-behavior regressions:

1. Current attachments can hide needed historical pixels for indirect references.
2. Native batch children can report success despite a failed/incomplete Responses status.
3. A completed SSE response followed by timeout can become `unknown` even after its image is saved.
4. A duplicate identified text delta can persist duplicate text when completion omits output.

PR #15's documentation Head has green CI. That does not invalidate newly reproduced defects or authorize merging. This research deliberately leaves them unfixed and keeps both PRs Draft.

Separate follow-ups can address late text after stop, graceful concurrent duplicate conflict handling, snapshot/asset lookup costs, explicit context policy, bounded metadata telemetry and clearly labeled cost estimates. Count caps already constrain model steps and image jobs; they are not a monetary budget. Any future cost display must separate known usage, missing usage, estimate and actual charge. Do not build a billing platform as part of this closeout.

Validation of this research includes **15 execution risk probes and 5 diagnostic integrity tests**. Existing execution/context/progress suites passed 121 tests; PR #14 overlap suites passed 352 frontend tests and 293 backend tests with 10 existing Windows symlink skips; an additional 72 Agent frontend callbacks/hooks passed. These suites overlap, so these counts must not be summed into a unique whole-project total. The separate documents list commands and untested boundaries. Both full baseline scripts completed with temporary fixtures; timings are observations rather than pass/fail thresholds.

## Three architectural directions

The comparison below is an engineering assessment based on the inspected application, not a benchmark of competing frameworks.

| Direction | Suitable when | Proposed boundary | Compatibility and migration cost | What it does not solve |
| --- | --- | --- | --- | --- |
| Keep and optimize the existing engine | Current product behavior is sufficient; correctness and observability are the immediate gaps | Repair terminal-state handling and event identity, preserve stop/idempotency rules, instrument stage timings, reduce redundant repository reads | Lowest disruption. Keep SQLite schema, request IDs, branch identities, saved results, Gallery/Library bridges and provider adapters. Each change needs existing recovery regressions. | No guarantee of upstream latency or cache improvements |
| Add explicit context management around the current engine | Measurements show history/pixels, repeated skills or snapshots materially affect performance/cost | Versioned context policy with immutable full history, explicit image selection, stable instruction segments, optional summaries/retrieval with visible provenance | Moderate. No initial storage migration required if full history remains canonical; branches, reference tags, summaries and old requests need compatibility rules. Summarization may itself incur fees and lose detail. | Cannot silently drop necessary images or assume provider cache support |
| Adopt a mature Agent Harness, such as LangGraph | Workflow checkpoints, multiple agents or durable orchestration outgrow the current narrow loop | First isolate a provider/tool adapter and compare an offline execution prototype behind the same UI/API | Highest. Map conversation/round/request/job IDs and authorization snapshots; retain original data during dual-read/compatibility transition. Disable unsafe framework retries around paid side effects and validate stop/unknown-outcome semantics. | Does not bypass provider queues, create cache hits, guarantee exactly-once external billing, or automatically migrate this application's references |

LangGraph's [persistence documentation](https://docs.langchain.com/oss/python/langgraph/persistence) describes thread checkpointers and stores. It also notes that growing checkpoints need lifecycle management. These capabilities are relevant to durable workflows, but they do not remove application-specific image-job, authorization and recovery contracts. No Harness package was installed or executed in this research. An unspecified “DeepSeek Harness” cannot be assessed as a concrete replacement without a repository/version and provider compatibility evidence; a model provider and an orchestration runtime are separate choices.

Recommended sequence: correctness gates → bounded timing/usage observability → targeted local optimizations → explicit context policy if justified → isolated Harness evaluation only if orchestration requirements demand it. Preserve the original full conversation, image bytes, branch references and uncertainty semantics at each boundary. This is a recommendation for later authorized work, not an automatic implementation plan.

## PR and runtime boundaries

The documentation fix in PR #15 restores visible upstream v0.11.0/v0.11.2 historical links and localized independent-maintenance contracts without restoring upstream installation/update entry points. Its exact Head is `594a11639c6191d266e10836f1a08ada261e12e2`; [CI run 40107131798](https://github.com/Brilliant666/image-prompt-library/actions/runs/40107131798) passed `test`, `windows-installer` (including native smoke), and `macos-backup-restore`.

The research PR contains only the delta above that Head. Neither PR #15 nor PR #14 is merged or closed by this investigation. The running application, personal library, pairing, provider configuration and installed extensions are outside the test environment and were not operated on. No new browser acceptance, production latency measurement, cache validation or paid API test is claimed.
