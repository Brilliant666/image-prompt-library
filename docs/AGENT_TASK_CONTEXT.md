# Agent task context

The chat keeps its complete history. **Current task** is the default disposable
view sent to the model, not a deletion, summary, or rewrite of that history.

Continue chatting normally: attach a reference, ask for a reverse Prompt, then
request another language or a specific edit. The backend maintains the task and
the model can reconcile its state while answering, without a separate
classification or bookkeeping model request. A sole new reference can identify
the analysis object without a manual "main image" action; it does not prove that
older images or constraints are irrelevant.

First binding is distinct from replacing an existing image: greeting the
assistant before uploading the first image does not create an unresolved old
image. Validated reference selections, including the selection attached to a
generation tool, reconcile the corresponding image-role dependencies locally.
This also works when the model does not call `update_task_context`. A resolved
image role is not proof that all earlier text requirements were satisfied, nor
that generation succeeded. Unprocessed text remains verbatim evidence without
automatically resending every image from that message. Explicit visual, mask,
comparison and necessary legacy evidence still includes its pixels.

An unresolved question can retain exact task wording without uploading every
historical picture. Pixels follow the specific visual dependency, selected
ancestor or `read_task_history` result, including that source's inherited target,
auxiliaries and explicit image/round references. Text-only dependencies do not
become visual dependencies just because a question is unresolved. Required
sources in an earlier task on the same branch remain available; sibling branches
and missing bindings are rejected. If the source of a visual question is still
unclear, the normal answer identifies/reads it or asks briefly before making a
visual claim. It must not pretend that omitted pixels were observed.

An exact ordinary round locator in retained text (for example, “第 3 轮”) also
recovers that source's necessary pixels. Selected sources retain their explicit
visual and legacy dependency chains, even across tasks or when comparing two
versions of the same task. Only resolved automatic image-role bookkeeping can
be superseded by a later role graph; an unknown dependency is not silently
discarded. Missing required source slots fail before a model POST.
This also applies when a read source depends on a text supplement: retain that
supplement verbatim and recover its explicitly named images, without promoting
its unrelated attachments or task bindings to visual evidence.

While an editing target is genuinely undecided, its frozen candidate images
remain available for the normal clarification reply. This does not restore all
historical images, choose a target on the user's behalf or revive candidates
after the selection is resolved.

Original user text, the current working candidate, the explicitly user-selected
Prompt and the actually executed Prompt remain separate versions with source
identities. Continuing a discussion uses the working candidate without claiming
that the user has confirmed it. The model cannot grant image authorization.
On a recognized Prompt block, **Continue optimizing** discusses that exact block;
**Generate image** selects it internally and authorizes only that operation.

## Context scope

- **Current task:** selected images and roles, effective task data, recent
  clarification dialogue, exact unresolved evidence, and current tool results.
- **Select history:** optionally add authorized ancestor messages and images.
  Necessary legacy evidence and current attachments still apply.
- **Full branch:** retain the complete authorized branch; this may send more
  images and increase latency and cost. Sibling branches are never included.

An image attachment does not prove that earlier images or constraints are
irrelevant. Changing an inferred target preserves the task and exposes the
previous evidence until it is reconciled. Explicitly starting a new task clears
the old task selection without deleting its history. Exact references and mask
targets remain validated, including actual pixels before an upstream request.

The normal composer shows attachments, text, image settings and image mode, not
task completeness, versions or candidate counts. Genuine missing images,
configuration failures and uncertain receipts remain actionable errors.

Optional context controls live under the conversation's **More / Context
details** entry. A manual history override is for the next accepted send, not a
permanent setting for later tasks; return to automatic task scope there. Opening
the inspector or answer details does not call a model or change the task. Closed
inspectors do not build a branch-wide image candidate list on every keystroke.

After submission, the round's optional answer details show the backend's latest
request-composition receipt: attached occurrences, image bindings, scope and
fallback reason. This is not a count inferred from composer candidates and does
not prove that an upstream server received a failed transport's full body.
A reference label is not a provider image cache.

## State and compatibility

Natural task changes and text-source coordination are handled in the normal
model answer, not by a separate classifier request. `start_task` cites the
entire current user instruction and changes only the current task projection;
old messages, candidate archives and frozen requests remain readable.
`reconcile_text_source` cites an exact frozen source and a recorded candidate
Prompt, coordinating that source individually without declaring every old
requirement satisfied. Neither recording a Prompt nor generating successfully
performs that coordination automatically. Visual, legacy and unknown evidence
cannot be cleared by this text operation.

Chat task type alone no longer attaches all images from a long-lived task.
Current attachments/roles, the immediate visual exchange, explicit locators,
masks and required visual evidence remain available. Retained text sources
include round locators and indicate omitted pixels; comparisons involving an
older unobserved image use `read_task_history` before visual claims. Full branch
scope still preserves every original occurrence and ordering. This policy is
separate from experimental same-pixel deduplication, which stays opt-in.

Image tools can carry `taskContextUpdate` in the same call. The entire batch is
preflighted before state or queue writes. Task changes and reference selection
commit with a request/step/call receipt, so an interrupted call can reuse its
existing jobs without replaying an obsolete task revision or a paid POST.
Normal sends retain their recovery journal silently while waiting for the POST
receipt; genuine uncertain outcomes remain visible and actionable.

Task changes use task ID, revision and branch checks. A late response cannot
replace another branch's newer selection. Existing sessions are read without
bulk migration or model calls. Legacy requirements and unprocessed additions
retain exact source-message dependencies; overflow is never silently truncated
and called complete. These tasks can therefore grow until normal dialogue
reconciles the necessary evidence or the user explicitly chooses a
self-contained Prompt/new task; manual state maintenance is not a prerequisite.

Affected older conversations are coordinated on their next normal operation,
using validated bindings and local execution evidence. Historical requests are
not rewritten. Unknown dependencies remain conservative; a fabricated provider
tool receipt is not accepted as proof of a backend image selection.

Editing or regenerating a question validates the effective source round's task
revision, including explicit user changes on that source branch. Its new parent
is the source question's parent. The new input starts from the original
pre-answer state and frozen ancestors, never the replaced answer or later
rounds. Explicit user-selected source-branch changes are preserved separately.
Legacy requests use their frozen ancestor state without a bulk migration.
Actual version conflicts preserve the edited draft and never replay a POST.

The model can record working candidate Prompts and reconcile constraints in its normal
answer using `update_task_context`. Changes to confirmed user constraints must
cite the current user's exact instruction. Model suggestions do not confirm a
Prompt or grant tools. Restoring an earlier working version through the normal
tool requires an exact current user instruction and a valid historical source;
it does not silently select a paid execution recipe. A complete visible answer plus a successful state update
finishes without a separate bookkeeping model request.

`read_task_history` reads at most six specified ancestor rounds from the frozen
authorized branch and restores their pixels for the next normal step. Missing
sources fail explicitly; ambiguous references require clarification or a user
history selection. It cannot read arbitrary files, SQL, URLs or Library items.

The HTTP/worker regression in `tests/test_agent_unresolved_evidence_http.py`
starts with an old unresolved question and text-only dependencies. Its first
Responses request carries only the current required image. Reading an ancestor
with no own attachments then supplies that ancestor's inherited target and
auxiliary pixels alongside the current image in the next Responses request,
without an unrelated old image, an Images call or a classifier POST. The checks
compare real serialized image bytes and preserve the frozen original rounds.

Hot Prompt versions are bounded; older versions remain recoverable in the
existing conversation JSON. Exact source IDs and necessary unprocessed history
can grow. This is not an unlimited fixed-size memory or an automatic summary
system. No new database, image ownership, queue, or Agent framework is added.

The independent experimental image deduplication setting is unchanged and is
not enabled by this feature. See [the offline benchmark](AGENT_TASK_CONTEXT_BENCHMARK.md)
for measured coverage, bytes, local costs and limitations. Real visual quality,
provider latency, token costs and Prompt Cache behavior require separate tests.
