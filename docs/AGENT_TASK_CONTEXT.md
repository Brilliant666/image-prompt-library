# Agent task context

The chat keeps its complete history. **Current task** is the default disposable
view sent to the model, not a deletion, summary, or rewrite of that history.

Use the composer task panel to inspect image objects, select an exact Prompt,
restore a Prompt version, choose a target, or start a new task. Original user
text, model candidates, the user-selected Prompt and the actually executed
Prompt remain separate versions with source identities. Choosing a Prompt does
not generate an image or change image authorization.

## Context scope

- **Current task:** selected images and roles, effective task data, recent
  clarification dialogue, exact unresolved evidence, and current tool results.
- **Select history:** explicitly add authorized ancestor messages and images.
  Necessary legacy evidence and current attachments still apply.
- **Full branch:** retain the complete authorized branch; this may send more
  images and increase latency and cost. Sibling branches are never included.

An image attachment does not prove that earlier images or constraints are
irrelevant. Changing an inferred target preserves the task and exposes the
previous evidence until it is reconciled. Explicitly starting a new task clears
the old task selection without deleting its history. Exact references and mask
targets remain validated, including actual pixels before an upstream request.

The composer distinguishes known image objects from conservative **image
candidates** when an incomplete task or compatibility fallback may enlarge the
scope. After submission, the context receipt records the actual attached count,
scope and fallback reason. A reference label is not a provider image cache.

## State and compatibility

Task changes use task ID, revision and branch checks. A late response cannot
replace another branch's newer selection. Existing sessions are read without
bulk migration or model calls. Legacy requirements and unprocessed additions
retain exact source-message dependencies; overflow is never silently truncated
and called complete. These tasks can therefore grow until the user resolves
them or explicitly chooses a self-contained Prompt/new task.

The model can record candidate Prompts and reconcile constraints in its normal
answer using `update_task_context`. Changes to confirmed user constraints must
cite the current user's exact instruction. Model suggestions do not confirm a
Prompt or grant tools. A complete visible answer plus a successful state update
finishes without a separate bookkeeping model request.

`read_task_history` reads at most six specified ancestor rounds from the frozen
authorized branch and restores their pixels for the next normal step. Missing
sources fail explicitly; ambiguous references require clarification or a user
history selection. It cannot read arbitrary files, SQL, URLs or Library items.

Hot Prompt versions are bounded; older versions remain recoverable in the
existing conversation JSON. Exact source IDs and necessary unprocessed history
can grow. This is not an unlimited fixed-size memory or an automatic summary
system. No new database, image ownership, queue, or Agent framework is added.

The independent experimental image deduplication setting is unchanged and is
not enabled by this feature. See [the offline benchmark](AGENT_TASK_CONTEXT_BENCHMARK.md)
for measured coverage, bytes, local costs and limitations. Real visual quality,
provider latency, token costs and Prompt Cache behavior require separate tests.
