"""Derived-turn CAS identity and pre-answer task seed are different contracts."""
import copy
import json

from backend.services import agent_editing_task as editing, agent_task_state as tasks


def source_branch(body):
    return body.derivedFromRoundId if body.origin != 'send' and body.derivedFromRoundId else body.parentRoundId


def branch_revision(drafts, round_data):
    key = editing.branch_key(round_data['id'])
    saved = drafts.get(key)
    state = (saved.get('taskContext') if isinstance(saved, dict) else None) if key in drafts else round_data.get('taskContext')
    return (state or {}).get('revision', 0)


def input_state(editing_task, context):
    # Stored before the answer changes state. No response output or history copy.
    return {'version': 1, 'editingTask': copy.deepcopy(editing_task), 'taskContext': copy.deepcopy(context)}


def _manual_overlay(seed, observed, saved, branch_id):
    """Carry explicit source-branch user edits, never the replaced model answer."""
    before = observed or {}
    if saved.get('taskId') != before.get('taskId'):
        return copy.deepcopy(saved)  # An explicit user-created independent task.
    value = copy.deepcopy(seed) if seed else tasks.new('', branch_id)
    for key in ('target', 'auxiliaries', 'taskType', 'targetExplicit', 'unresolvedItems', 'historyDependencies'):
        if saved.get(key) != before.get(key):
            value[key] = copy.deepcopy(saved.get(key))
    if any(saved.get(key) != before.get(key) for key in ('target', 'auxiliaries')):
        # A binding is a complete target/auxiliary contract. The source may
        # already have been image_edit while its pre-answer seed was chat (or
        # absent on a legacy first round). Keeping only changed fields would
        # lose an unchanged target/type and discard the explicit user choice.
        for key in ('target', 'auxiliaries', 'taskType', 'targetExplicit'):
            value[key] = copy.deepcopy(saved.get(key))
    old_prompts = {p['id']: p for p in before.get('promptVersions', [])}
    for prompt in saved.get('promptVersions', []):
        if prompt == old_prompts.get(prompt['id']):
            continue
        if prompt.get('confirmedBy') != 'user' and prompt.get('source', {}).get('kind') != 'user':
            continue
        value['promptVersions'] = [p for p in value['promptVersions'] if p['id'] != prompt['id']]
        value['promptVersions'].append(copy.deepcopy(prompt))
    ids = {p['id'] for p in value['promptVersions']}
    for key in ('selectedPromptVersionId', 'workingPromptVersionId'):
        if saved.get(key) != before.get(key) and saved.get(key) in ids:
            value[key] = saved[key]
    old_constraints = {c['id']: c for c in before.get('constraints', [])}
    for constraint in saved.get('constraints', []):
        if constraint != old_constraints.get(constraint['id']):
            value['constraints'] = [c for c in value['constraints'] if c['id'] != constraint['id']]
            value['constraints'].append(copy.deepcopy(constraint))
    return tasks.refresh(value)


def submission_seed(conversation, rounds, body, original_request=None):
    if body.origin == 'send' or not body.derivedFromRoundId:
        return (editing.current_task(conversation, rounds, body.parentRoundId),
                tasks.current(conversation, rounds, body.parentRoundId))
    source = next(r for r in rounds if r['id'] == body.derivedFromRoundId)
    stored = source.get('_taskInputState')
    if isinstance(stored, dict) and stored.get('version') == 1:
        edit, state = copy.deepcopy(stored.get('editingTask')), copy.deepcopy(stored.get('taskContext'))
    else:
        # Legacy: original request history froze the ancestors before this
        # answer. Do not seed from the mutable source answer or current leaf.
        parent = next((r for r in (original_request or {}).get('history', []) if r['id'] == body.parentRoundId), None)
        edit, state = (copy.deepcopy((parent or {}).get('editingTask')),
                       copy.deepcopy((parent or {}).get('taskContext')))
    drafts = json.loads(conversation['editing_tasks'])
    saved = drafts.get(editing.branch_key(source['id']))
    if isinstance(saved, dict) and saved.get('taskContext'):
        state = _manual_overlay(state, source.get('taskContext'), saved['taskContext'], body.parentRoundId)
        edit = tasks.project_editing(state, edit)
    elif isinstance(saved, dict) and saved.get('_kind') != tasks.ENVELOPE:
        edit, state = copy.deepcopy(saved), None
    return edit, state
