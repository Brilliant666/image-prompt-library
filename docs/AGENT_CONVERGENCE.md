# Agent dependency convergence verification

The baseline is `b76e5d8`. The numeric tables below record earlier candidate
snapshots from this PR's image-role and lifecycle repairs, not the final Head
or final staged tree. Later source-closure and protocol-boundary changes can
change the exact byte counts and timings when rerun. These historical samples
use synthetic data, production HTTP routes, the Agent worker and
the generation queue with a local `MockTransport`. They never open an existing
library or use saved provider credentials. Port 8000 and external sockets are
blocked by the isolated preview fixture.

## Lifecycle contract

The tables below describe the earlier image-role repair. They did not establish
that an old conversation naturally changing subject would end its text/history
dependencies. The follow-up regressions now cover that distinct lifecycle:

- Long-lived chat no longer implies every old picture is needed. Only immediate
  visual context and actual bindings/evidence are sent by default; explicit
  historical comparisons recover the specified pixels before observation.
- A normal answer can start a source-backed independent task or reconcile exact
  user sources into a recorded candidate, without a bookkeeping model request.
- The HTTP/MockTransport regression changes an old picture discussion to a new
  independent image, then edits that result. Each image step makes one normal
  Responses call and one Images call; the original history/frozen JSON bytes
  are compared unchanged. Mock geometric outputs use distinct pixels to detect
  accidental old-asset reuse.
- Worker exit after job creation, restart recovery and an explicit HTTP resume
  reuse the task/selection receipt and existing job. They do not create a second
  image job or replay the original paid POST.
- The scaling fixture at 5/25/50/100/200 turns uses actual `prepare_context`
  image loading, encoding and JSON composition. Uncoordinated text is preserved;
  only the recent two visual bindings travel. A validated independent task then
  excludes old evidence. This is a projection test, not supplier-latency or
  natural-language quality measurement.

- A text greeting followed by the first image does not imply an older target.
  A genuinely earlier generated result still counts as visual evidence.
- Frozen target/auxiliary selections, including ordinary image calls without a
  separate state tool, reconcile only the matching image-role dependency.
  Exact textual supplements remain available; a submitted execution Prompt is
  not proof that all written requirements are satisfied.
- User selection, normal model state updates and image tools use the same small
  reconciliation function. Active-request, task revision, branch and frozen
  asset checks remain in the repository.
- New local bindings leave a private backend proof. An older generation receipt
  additionally requires a real local `agent_tool_jobs` association and matching
  saved target/auxiliary state. A provider-supplied pair of tool JSON messages
  cannot supply this proof. Public snapshots omit the private proof.
- Existing false first-image dependencies are repaired on natural continuation;
  old rounds and original messages are unchanged. A legacy selection-only
  receipt with no trustworthy local proof stays conservative until a normal
  validated selection or image operation resolves it.
- Text-only dependencies do not attach every historical image. Explicit image
  locators, legacy/overflow evidence, unknown visual dependencies, masks and
  requested comparisons remain available, even in Prompt optimization tasks.
- Quota/model/moderation errors and unknown outcomes never promote a missing
  image to the next target. Late execution receipts cannot edit a finished or
  different active branch.

## Lifecycle follow-up projection measurements

The following is one local synthetic projection sample, not a before/after
supplier-speed benchmark. "Old evidence" is the corrected default task view
before the normal answer declares an independent task: exact unresolved text
is retained, with only two recent visual bindings. "Independent task" follows
the validated task-boundary operation. Both use the same current serializer,
fixed skills/tools and synthetic asset; experimental pixel deduplication is off.

| Historical turns | Old-evidence image occurrences | Independent-task image occurrences | Old-evidence JSON bytes | Independent-task JSON bytes |
| --- | --- | --- | --- | --- |
| 5 | 2 | 0 | 24,255 | 21,991 |
| 25 | 2 | 0 | 30,961 | 21,991 |
| 50 | 2 | 0 | 39,361 | 21,991 |
| 100 | 2 | 0 | 56,166 | 21,991 |
| 200 | 2 | 0 | 90,167 | 21,991 |

Preparation in this sample ranged from 13.874 to 22.398 ms for the retained
old evidence, and 0.151 to 0.306 ms after the independent task. These are single
observations with tiny synthetic pictures, not latency guarantees, token counts,
cache hits or actual charges. Actual provider performance remains unverified.

## Method and limits

Each scenario runs a single 50-turn conversation, recording every turn and
showing checkpoints 5, 17, 25 and 50 below. Generated image calls contain
`referenceSelection` and `finish_after_generation`, with no extra
`update_task_context` call or extra model round. The regression suite separately
covers omitted selection and Native image generation.

`Images` is input-image occurrences / unique image bytes (SHA-256 of decoded
base64). The deterministic preview generator repeats some synthetic pixels,
so occurrences and unique counts can differ. Every measured turn retained all
required images. JSON sizes are actual outgoing HTTP request bytes, not token
estimates. Exact text is retained, so payloads can still grow with prose.

`SELECT` counts statements inside `prepare_context` only, not all requests or
polling. Preparation time is one instrumented local sample per checkpoint;
SQL observation and concurrent local activity affect it. It is not a repeated
performance distribution and says nothing about supplier latency, paid-service
speed, image processing time or cache hit rates.

Each cell uses **baseline → candidate**. POST counts are cumulative and identical
between both versions; they are shown as model / image POSTs. A and B make
50 / 12 POSTs at turn 50; C makes 50 / 0. Cache hits are never counted as zero
request bytes.

## A: replace the target, then continue

Start with hello, reverse/English/local wording, generate, and repeatedly supply a new target. The normal image tool binds that target. Following turns should use the current target rather than every prior image.

| Turn | Images | JSON bytes | SELECT | Preparation ms | Model / image POSTs |
| --- | --- | --- | --- | --- | --- |
| 5 | 1/1 → 1/1 | 58,543 → 58,152 | 2 → 2 | 13.813 → 12.404 | 5 / 1 |
| 17 | 8/7 → 1/1 | 187,881 → 61,476 | 16 → 2 | 105.825 → 13.252 | 17 / 4 |
| 25 | 12/9 → 1/1 | 273,431 → 65,352 | 24 → 2 | 202.453 → 16.671 | 25 / 6 |
| 50 | 24/15 → 1/1 | 529,614 → 76,521 | 48 → 2 | 330.058 → 18.495 | 50 / 12 |

## B: continue the latest generated result

Keep one editing task and explicitly continue the latest generated image after each generation. Previous generated results remain in storage but are not implicit inputs to later text supplements.

| Turn | Images | JSON bytes | SELECT | Preparation ms | Model / image POSTs |
| --- | --- | --- | --- | --- | --- |
| 5 | 2/2 → 1/1 | 59,550 → 21,949 | 4 → 2 | 24.479 → 15.223 | 5 / 1 |
| 17 | 5/4 → 1/1 | 75,769 → 27,629 | 10 → 2 | 58.300 → 14.240 | 17 / 4 |
| 25 | 7/4 → 1/1 | 86,585 → 31,419 | 14 → 2 | 83.690 → 12.975 | 25 / 6 |
| 50 | 13/4 → 1/1 | 118,589 → 42,341 | 26 → 2 | 220.705 → 18.883 | 50 / 12 |

## C: necessary cross-image comparison

Explicit full-branch comparison intentionally retains every supplied image. This control must grow with the required evidence, rather than obtaining a smaller payload by omitting images.

| Turn | Images | JSON bytes | SELECT | Preparation ms | Model / image POSTs |
| --- | --- | --- | --- | --- | --- |
| 5 | 1/1 → 1/1 | 55,347 → 55,154 | 2 → 2 | 13.651 → 12.811 | 5 / 0 |
| 17 | 4/4 → 4/4 | 171,742 → 171,631 | 8 → 8 | 48.765 → 87.695 | 17 / 0 |
| 25 | 6/6 → 6/6 | 249,338 → 249,227 | 12 → 12 | 79.749 → 79.758 | 25 / 0 |
| 50 | 13/13 → 13/13 | 519,817 → 519,706 | 26 → 26 | 168.569 → 190.992 | 50 / 0 |

## Reproduce without production data

Use an isolated development Python environment with the project dependencies,
from the candidate repository root. The runner is import-inert and requires a
new or empty data directory. On PowerShell:

```powershell
$run = Join-Path $env:TEMP ("ipl-convergence-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $run | Out-Null
$archive = Join-Path $run "baseline.zip"
$baseline = Join-Path $run "baseline-source"
git archive --format=zip --output=$archive b76e5d8 -- backend scripts pyproject.toml
Expand-Archive -LiteralPath $archive -DestinationPath $baseline
python scripts/benchmark_agent_convergence.py --source $baseline --data "$run/baseline-data" --output "$run/baseline.json"
python scripts/benchmark_agent_convergence.py --source . --data "$run/candidate-data" --output "$run/candidate.json"
```

Both runs use the same runner/interpreter and synthetic fixture. Reports include
all per-turn metrics, dependency reasons, required-image coverage and hashes of
the measured source modules. `--rounds 5` is a smaller smoke run; default
checkpoints are `5 17 25 50`. Do not commit generated libraries or local reports.

## Regression evidence and remaining boundary

`tests/test_agent_task_convergence.py` starts with four failing production-path
regressions: first binding, image generation with and without explicit reference
selection, and an affected old conversation. It also covers the Hybrid/Native
natural chain, exact long text, genuine visual/legacy dependencies without an
unresolved marker, local legacy generation proof, forged upstream receipt,
failure modes, no implicit replay, unchanged old rounds and late receipts.
Existing context/recipe/frozen-asset tests cover selected history, true multiple
image comparison, masks, branch authorization and immutable recipe inputs.

`tests/test_agent_unresolved_evidence.py` covers exact-source projection for
older unresolved questions. `tests/test_agent_unresolved_evidence_http.py` runs
the real upload/round routes, worker and `read_task_history` tool against the
offline preview fixture and MockTransport. For both inherited `taskContext`
and `editingTask` bindings, the first Responses request contains the current
image only; the next contains that image plus the specifically read ancestor's
target and auxiliary. The ancestor owns no new attachment. An unrelated older
image stays absent, exact old text/history remains unchanged, and the exchange
uses two Responses POSTs and zero Images POSTs. This is request-composition
evidence, not proof that an unscripted model will always choose the right source.

Additional source-closure regressions cover ordinary numeric round locators in
text-only supplements, transitive visual dependencies, two historical versions
of one task, missing result slots and sibling/future sources. Automatic resolved
role-change edges do not revive obsolete image chains; explicit unknown and
legacy visual dependencies remain conservative. A genuinely undecided target
retains only its frozen candidates for clarification. The existing Hybrid and
Native inline-selection tests verify that those candidate pixels reach the
planning request and the selected originals reach the image request.

Run the focused evidence regressions in an isolated development environment:

```sh
python -m pytest -q tests/test_agent_unresolved_evidence.py tests/test_agent_unresolved_evidence_http.py
```

The Responses receive boundary now rejects provider-origin
`function_call_output` in JSON payloads and SSE item/completion events before
merging them into local output. It rejects the response rather than dropping a
forged receipt and proceeding to execute its tool. Production-worker regressions
assert one Responses POST, zero task CAS mutations and zero Images calls;
locally generated tool receipts and prior-step base output remain intact.
This does not rewrite existing history or retroactively certify older stored
receipts, and it is not a redesign of every upstream output type. No real
provider, paid generation, external upload or live-service latency was tested.
