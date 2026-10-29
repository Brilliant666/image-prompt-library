"""Choose the disposable task view before reading or encoding any pixels.

History, frozen requests and the branch reference allowlist are never rewritten.
Missing state has an explicit compatibility path rather than an invented summary.
"""
from dataclasses import dataclass
import re

from backend.services import agent_editing_task as editing
from backend.services.agent_context import _reference_scope, select_context_images


@dataclass
class ContextScope:
    history: list
    assets: set | None
    scope: str
    reason: str | None = None


def choose_context(request, refs):
    history, current = request['history'], request['round']
    scope = current.get('contextScope', request.get('body', {}).get('contextScope', 'task'))
    task = current.get('taskContext')
    if scope == 'branch':
        return ContextScope(history, None, 'branch', 'user_selected_full_branch')
    if not task and scope != 'selected':
        return ContextScope(history, None, 'branch', 'legacy_missing_task_state')
    reference = _reference_scope(request, refs)
    if scope == 'task' and reference and reference[2] and not re.sub(r'[\s，,。.!！?？；;：:]+', '', reference[3]):
        # A reference-only selection is an explicit user narrowing action, not
        # an inference from a new attachment or from ordinary leftover text.
        return ContextScope([], select_context_images(request, refs), scope, 'explicit_reference_only')
    selected_ids = set(current.get('historyRoundIds', request.get('body', {}).get('historyRoundIds', [])))
    dependencies = (task or {}).get('historyDependencies', [])
    dependent_ids = {row['roundId'] for row in dependencies} | set(current.get('contextEvidenceRoundIds', []))
    task_rows = [r for r in history if (r.get('taskContext') or {}).get('taskId') == (task or {}).get('taskId')]
    reason = None
    if scope == 'selected':
        rows = [r for r in history if r['id'] in selected_ids | dependent_ids]
    else:
        # Keep the immediate clarification exchange, and exact unreconciled
        # additions by source. A task is not a lossy summary of those messages.
        keep = {r['id'] for r in task_rows[-2:]} | dependent_ids
        rows = [r for r in history if r['id'] in keep]
    if dependencies:
        reason = 'required_history_evidence'
    if task and task.get('unresolvedItems'):
        rows = task_rows or history
        reason = 'unresolved_task_evidence'
    # A numeric round address is a locator, not a natural-language classifier.
    # Keep every image of that exact authorized round if no slot is specified.
    numbers = {int(n) for n in re.findall(r'第\s*(\d+)\s*轮', current['prompt'])}
    numeric_rows = [r for r in history if r['index'] in numbers]
    chosen_ids = {r['id'] for r in rows} | {r['id'] for r in numeric_rows}
    assets = set(editing.all_input_ids(current))
    if reference:
        assets.update(reference[1])
    if task and task.get('taskType') not in {'prompt', 'prompt_optimization'}:
        assets.update(image['assetId'] for image in ([task['target']] if task.get('target') else []) + task.get('auxiliaries', []))
    for name in ('maskTargetImageId', 'maskImageId'):
        if current.get(name):
            assets.add(current[name])
    # Explicit selected history and incomplete state carry its actual visual
    # evidence. Complete prompt-only iteration does not carry old pixels merely
    # because its text supplements have historical sources.
    image_rows = [r for r in rows if scope == 'selected' or r['id'] in current.get('contextEvidenceRoundIds', []) or reason == 'unresolved_task_evidence'
                  or (task or {}).get('taskType') not in {'prompt', 'prompt_optimization'} and r['id'] in dependent_ids]
    if scope == 'task' and task and task.get('taskType') == 'chat':
        # No structured visual/prompt decision has been made yet. Retain this
        # task's visual evidence until a normal model answer or explicit user
        # selection reconciles it, not every ended task in the whole branch.
        image_rows.extend(task_rows)
        if any(editing.all_input_ids(r) or editing.all_output_ids(r) for r in task_rows):
            reason = reason or 'unreconciled_visual_task'
            rows = list({r['id']: r for r in [*rows, *task_rows]}.values())
    image_rows.extend(numeric_rows)
    for r in image_rows + [current]:
        for ref, aid in refs.items():
            if aid and ref.startswith(f"round-{r['index']}-"):
                # Current inputs are always kept; generated prerequisite images
                # remain visible to subsequent tool steps in this same request.
                assets.add(aid)
    for ref, aid in refs.items():
        if aid in assets:
            match = re.match(r'round-(\d+)-', ref)
            if match:
                chosen_ids.update(r['id'] for r in history if r['index'] == int(match[1]))
    # Do not re-introduce unrelated historical text solely to label a selected
    # asset: it is attached in a separate binding message below by the builder.
    relevant = {r['id'] for r in rows} | {r['id'] for r in numeric_rows}
    return ContextScope([r for r in history if r['id'] in relevant], assets, scope, reason)


def task_data(task, refs):
    """Only current versions and bounded effective state, not a hidden transcript."""
    if not task:
        return None
    ids = {task.get(key) for key in ('originalPromptVersionId', 'selectedPromptVersionId', 'executedPromptVersionId')}
    keys = ('schemaVersion', 'taskId', 'revision', 'branchRoundId', 'taskType', 'completeness',
            'latestUserAddition', 'unresolvedItems', 'historyDependencies')
    result = {key: task.get(key) for key in keys}
    result['promptVersions'] = [p for p in task.get('promptVersions', []) if p['id'] in ids]
    result['constraints'] = [c for c in task.get('constraints', []) if c['status'] != 'revoked']
    def binding(image):
        return {'assetId': image['assetId'], 'ref': next((ref for ref, aid in refs.items() if aid == image['assetId']), None),
                **({'role': image['role']} if 'role' in image else {})}
    result['target'] = binding(task['target']) if task.get('target') else None
    result['auxiliaries'] = [binding(image) for image in task.get('auxiliaries', [])]
    return result
