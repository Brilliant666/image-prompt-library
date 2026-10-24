# Agent execution and recovery research

This is a diagnostic report against PR #15's corrected documentation baseline,
`594a11639c6191d266e10836f1a08ada261e12e2`. The research branch does not repair
the production execution path. Its `characterizes` tests intentionally assert
the observed defective behavior: a passing probe confirms reproduction, not a
fix. There are no skipped or expected-failure tests hiding these findings.

All inputs are synthetic, all libraries and configuration files are temporary,
and all new HTTP calls use `httpx.MockTransport`. No real provider, key, personal
library, or running installation is needed. These are backend execution probes,
not a claim of browser validation or production provider reproduction.

## Repeat the investigation

From a configured development checkout:

```sh
python -m pytest tests/test_agent_risk_research.py -q
python -m pytest tests/test_agent_workspaces.py tests/test_agent_progress.py tests/test_agent_response_details.py tests/test_agent_context.py -q
```

Results on the research baseline: **15 new probes passed**, and **121 existing
execution, progress, response-details and context tests passed**. Existing tests
include a loopback HTTP provider; new probes also block network transport through
their isolated fixture. Timings vary by host and are not provider latency data.

## Confirmed correctness gaps

| Finding | Reproduction and observed result | Source evidence | Recommended gate |
| --- | --- | --- | --- |
| P2: attaching a new image can silently omit needed historical pixels | Supply an earlier blue portrait and a current orange image; ask “Match the lighting of the portrait we discussed on this photo.” Only the orange pixels are sent. The blue portrait becomes `available_ref`. The Chinese equivalent is also reproduced. | [`agent_context.py:15`](../backend/services/agent_context.py#L15), [`:103`](../backend/services/agent_context.py#L103), [`:121`](../backend/services/agent_context.py#L121); [`agent_execution.py:168`](../backend/services/agent_execution.py#L168). | Resolve before merging PR #15's automatic narrowing. Keeping references in the database is not equivalent to supplying the pixels needed for analysis. |
| P2: native batch child ignores unsuccessful Responses status | Return JSON with `status=failed` or `incomplete`, an error, and exactly one image result. The child is recorded as `succeeded`. The regular Responses path rejects unsuccessful status, so behavior differs by path. | [`agent_execution.py:843`](../backend/services/agent_execution.py#L843) through result staging; compare [`:414`](../backend/services/agent_execution.py#L414). | Resolve before merge: retain available artifacts if desired, but do not report a failed response as successful. |
| P2: a terminal SSE receipt followed by a read timeout becomes unknown | Send `response.completed` containing a finished native image, then raise `ReadTimeout` while awaiting EOF. The image is saved successfully but the Agent request becomes `unknown`. | [`agent_execution.py:528`](../backend/services/agent_execution.py#L528), [`:530`](../backend/services/agent_execution.py#L530), [`:750`](../backend/services/agent_execution.py#L750). | Resolve before merge: a validated terminal receipt should be the completion boundary. No real provider incidence is asserted. |
| P2: duplicate SSE text event persists duplicate text when completion omits output | Deliver the same `response.output_text.delta` twice, with the same `sequence_number`, then a successful completion without output. Persisted text is `hellohello`, not `hello`. | [`agent_execution.py:468`](../backend/services/agent_execution.py#L468) through [`:489`](../backend/services/agent_execution.py#L489). | Resolve before merge for the supported gateway fallback. Deduplicate only identified repeated events; equal text alone is not a safe deduplication key. |
| P3: a late JSON text receipt may update a stopped round | Yield the complete JSON response bytes, set the stop flag before stream EOF, then allow JSON handling. Request stays stopped, but `assistantContent` changes to the late text. | [`agent_execution.py:440`](../backend/services/agent_execution.py#L440) through [`:450`](../backend/services/agent_execution.py#L450); [`agent_repository.py:533`](../backend/services/agent_repository.py#L533). | Follow-up refinement. No new image job or POST occurs. Decide whether late partial-result retention is intentional and make the UI contract explicit. |

Each row has a separately named `test_characterizes_*` reproduction in
[`test_agent_risk_research.py`](../tests/test_agent_risk_research.py). When a fix
is implemented in a functional PR, convert the relevant characterization into
an assertion of the desired behavior; do not leave a passing old-behavior test
as evidence of repair.

For the first issue, extending a word list alone cannot establish a reliable
boundary for all languages or indirect references. A minimal safe option is to
retain historical pixels when image scope is inferred only from a new
attachment, and make any narrower selection explicit. An eventual context
manager may select or fetch images, but must expose selection and uncertainty
instead of silently discarding necessary context. This research does not change
stored originals, reference tags, or context construction.

## Guards that held under the probes

| Scenario | Observed boundary |
| --- | --- |
| Completed native JSON; duplicate native SSE item and completion receipts | Exactly one local image job, one model POST and one image-budget increment. Repeating the client request ID and scanning recovery does not send another POST. |
| SSE read timeout, read disconnect, or clean EOF without `response.completed` | Request becomes `unknown`; existing unfinished native child becomes failed; original request replay is read-only; resume is denied; no automatic provider replay. |
| Stop before late native JSON completion | Request stays stopped and no result job is created. This is distinct from the late text publication gap above. |
| Concurrent creation using the same tool identity | Both workers are forced past the initial absent-row lookup. One transaction succeeds and one raises `sqlite3.IntegrityError`; there is still one job and one budget increment. The uniqueness key prevents duplicate persistence, but the loser does not return the existing job gracefully. |
| Branch image scope | The leaf receives its current image and its ancestor's image; a sibling's image is absent. An invented tool reference outside the frozen branch raises `reference_missing` before any job is created. |
| Frozen source image after source result cleanup | Existing integration coverage verifies regeneration uses the frozen asset bytes after the source generation result is discarded. |
| Safe restart/resume of an unstarted queued child | Existing integration coverage verifies restart holds the child, explicit resume reuses its job identity, and repeating the resume ID sends no extra request. |
| Browser progress observer disconnect | Existing progress tests verify that observing/reconnecting does not cancel or retry the durable request. A browser disconnect differs from an upstream transport disconnect. |

The main controls are [`agent_requests` request identity and frozen history](../backend/services/agent_repository.py#L430),
the [`agent_tool_jobs` composite SQL key](../backend/migrations/014_agent_workspaces.sql#L29),
[`create_image_job`](../backend/services/agent_execution.py#L247),
[`resume`](../backend/services/agent_repository.py#L710),
and [`recover_agent_requests`](../backend/services/agent_execution.py#L888).
The concurrent creation exception is a hardening opportunity, not proof that
the normal scheduler currently runs duplicate workers or incurs double charges.

## What the limits mean

- Configuration and each request cap **model steps** and **created image jobs**.
  The schema allows at most 50 model steps and 20 images per request; the saved
  configuration can impose smaller limits, and request authorization cannot
  exceed it. Image batches are rejected before dispatch when the declared batch
  exceeds the remaining count. Native tools receive `max_tool_calls`.
- These are **request-count limits, not a currency budget**. There is no price
  table, spend reservation, invoice reconciliation, account-level cap, or hard
  aggregate token ceiling. Native batch children make their own bounded
  Responses calls in addition to the outer model steps. Even one permitted call
  can be costly. A request stopped locally may continue at the provider.
- The request schema limits a single prompt to 100,000 characters, upload assets
  to 30 MiB each, and streaming response accumulation to 80 MiB. These limits
  constrain particular inputs and responses; they do not cap the assembled
  conversation or actual billable cost.
- [`response_usage`](../backend/services/agent_repository.py#L74) preserves an
  absent `cached_tokens` as unknown. [`aggregate_response_usage`](../backend/services/agent_repository.py#L115)
  also returns unknown for an aggregate field if any relevant step lacks it.
  Explicit zero and missing usage must remain distinct in any cost UI.

A small follow-up can show authorization counts, known provider token usage,
unknown usage and a clearly labeled estimate when user-configured prices are
available. It should not imply a monetary spending guarantee. A full billing
platform is outside this research scope.

## Unverified assumptions and next checks

The failure streams are deterministic simulated conditions. They establish
client handling defects, not the frequency of these conditions at any real
provider. No real latency, cache hit rate, provider routing, hidden reasoning,
provider cancellation, or monetary charge is measured here. A Harness swap
would not prove or repair those provider behaviors by itself.

No duplicate local image job or model POST was observed in the exercised client
replay, native receipt, timeout, stop, recovery or concurrent persistence paths. This does not
prove a provider's idempotency: after an unknown outcome, manually submitting a
new request can still pay again. The deliberate refusal to replay unknown
requests is a safety property to preserve during any later refactor.

Before merging PR #15, address the four P2 semantic/terminal-state findings and
rerun the new assertions for corrected behavior alongside the existing recovery
suite. The late-text policy, graceful concurrency conflict response, cost
estimation and broader transport fuzzing can be separate follow-up PRs. Do not
replace the current execution engine merely to hide these bounded issues.
