"""Bounded branch-local task state in the existing editing-task JSON column.

The state is an explicit projection, never a replacement for preserved messages.
Only user actions can select a Prompt or confirm a proposed constraint.
"""
from __future__ import annotations

import copy
import hashlib
import json
from uuid import uuid4

SCHEMA_VERSION = 1
ENVELOPE = 'agent-task-context-v1'
MAX_PROMPT_VERSIONS = 24


def identifier(prefix):
    return prefix + '_' + uuid4().hex


def current(conversation, rounds, branch_id):
    drafts = json.loads(conversation['editing_tasks'])
    key = branch_id or '__root__'
    if key in drafts:
        saved = drafts[key]
        if isinstance(saved, dict) and saved.get('_kind') == ENVELOPE:
            return copy.deepcopy(saved.get('taskContext'))
        # A legacy explicit editing draft may have an embedded new projection.
        return copy.deepcopy(saved.get('taskContext')) if isinstance(saved, dict) else None
    return copy.deepcopy(next((row.get('taskContext') for row in rounds if row['id'] == branch_id), None))


def envelope(editing_task, context, prompt_archive=None):
    value = {'_kind': ENVELOPE, 'editingTask': copy.deepcopy(editing_task), 'taskContext': copy.deepcopy(context)}
    if prompt_archive:
        value['_taskPromptArchive'] = copy.deepcopy(prompt_archive)
    return value


def source(kind, round_id, **extra):
    return {'kind': kind, 'roundId': round_id, **extra}


def new(text, branch_id, *, task_type='chat', target=None, auxiliaries=()):
    prompt_id = identifier('prompt')
    return {'schemaVersion': SCHEMA_VERSION, 'taskId': identifier('task'), 'revision': 1,
            'branchRoundId': branch_id, 'taskType': task_type, 'target': copy.deepcopy(target),
            'startRoundId': branch_id, 'sourceRoundIds': [branch_id] if branch_id else [], 'targetExplicit': False,
            'pendingUserTask': False,
            'auxiliaries': copy.deepcopy(list(auxiliaries)),
            'promptVersions': [{'id': prompt_id, 'text': text, 'kind': 'original',
                                'source': source('user', branch_id), 'confirmedBy': 'user'}] if text else [],
            'originalPromptVersionId': prompt_id if text else None, 'selectedPromptVersionId': None,
            'workingPromptVersionId': None, 'executedPromptVersionId': None, 'constraints': [],
            'latestUserAddition': {'text': text, 'roundId': branch_id} if text else None,
            'unresolvedItems': [], 'completeness': 'complete', 'historyDependencies': []}


def working_prompt_id(context):
    """Continue an explicit stored candidate, without treating it as accepted."""
    if 'workingPromptVersionId' in context:
        return context.get('workingPromptVersionId')
    # Compatibility uses an already recorded Prompt, never an arbitrary block.
    return context.get('selectedPromptVersionId') or next(
        (p['id'] for p in reversed(context.get('promptVersions', [])) if p['kind'] == 'candidate'), None)


def trim_prompts(context, archive):
    """Keep a bounded active window; exact older versions stay in branch JSON."""
    protected = {context.get(field) for field in ('originalPromptVersionId', 'selectedPromptVersionId', 'executedPromptVersionId')}
    protected.add(working_prompt_id(context))
    protected.add(context['promptVersions'][-1]['id'] if context['promptVersions'] else None)
    while len(context['promptVersions']) > MAX_PROMPT_VERSIONS:
        index = next(i for i, prompt in enumerate(context['promptVersions']) if prompt['id'] not in protected)
        removed = context['promptVersions'].pop(index)
        archive[removed['id']] = copy.deepcopy(removed)
    return context


def refresh(context):
    context['completeness'] = ('history_required' if context['historyDependencies'] else
                               'partial' if context['unresolvedItems'] else 'complete')
    return context


def dependency(context, round_id, reason):
    if round_id and not any(item['roundId'] == round_id and item['reason'] == reason for item in context['historyDependencies']):
        context['historyDependencies'].append({'roundId': round_id, 'reason': reason})


ROLE_CHANGE = 'target_changed_requires_prior_evidence'
ROLE_CHANGE_UNRESOLVED = '已添加新的编辑对象；旧图与约束是否继续适用尚需确认。'
ROLE_UNRESOLVED = {ROLE_CHANGE_UNRESOLVED, '请选择本次编辑对象。',
                   '新增附件尚未指定角色；当前明确选择的编辑对象保持不变。'}
TEXT_DEPENDENCIES = {'unreconciled_user_addition'}


def recorded_role_selection(context, history):
    """Use local binding proofs or tool-job records, never provider receipts alone."""
    from backend.services.agent_editing_task import references
    refs = references(history, [], 0)
    wanted_target = (context.get('target') or {}).get('assetId')
    wanted_aux = [(image['assetId'], image['role']) for image in context.get('auxiliaries', [])]
    proof = context.get('_imageRoleBinding', {})
    if (proof.get('targetAssetId') == wanted_target and proof.get('auxiliaries') == [list(item) for item in wanted_aux]):
        source = next((row for row in history if row['id'] == proof.get('roundId')), None)
        if source and (source.get('taskContext') or {}).get('taskId') == context.get('taskId'):
            return source['index']
    for row in reversed(history):
        recorded = row.get('taskContext') or {}
        if (recorded.get('taskId') != context.get('taskId')
                or (recorded.get('target') or {}).get('assetId') != wanted_target
                or [(image['assetId'], image['role']) for image in recorded.get('auxiliaries', [])] != wanted_aux):
            continue
        outputs = row.get('responseOutput', [])
        receipts = {item.get('call_id'): item for item in outputs if item.get('type') == 'function_call_output'}
        for call in reversed(outputs):
            if (call.get('type') != 'function_call' or call.get('call_id') not in receipts
                    or call.get('call_id') not in row.get('_verifiedImageCalls', [])):
                continue
            try:
                arguments = json.loads(call['arguments'])
                receipt = json.loads(receipts[call['call_id']]['output'])
                if not isinstance(arguments, dict):
                    continue
                selection = arguments.get('referenceSelection') if call.get('name') in {'generate_image', 'generate_image_batch'} else None
                if not isinstance(selection, dict) or not isinstance(receipt, dict) or 'error' in receipt:
                    continue
                if not ('images' in receipt or receipt.get('status') in {'done', 'error'}):
                    continue
                target = refs.get(selection.get('targetRef'))
                auxiliary = [(refs.get(image['ref']), image['role']) for image in selection.get('auxiliaries', [])]
                if wanted_target and target == wanted_target and auxiliary == wanted_aux:
                    return row['index']
            except (ValueError, TypeError, KeyError):
                continue
    return None


def reconcile(context, *, history=(), image_roles_resolved=False):
    """Resolve only evidenced image-role causes; keep exact textual sources.

    Callers prove bindings through frozen-asset validation and their existing
    branch/revision CAS. A generated Prompt is never proof that prose is met.
    Legacy/overflow and unknown evidence reasons deliberately remain untouched.
    """
    sources = {row['id']: row for row in history}
    receipt_index = None if image_roles_resolved else recorded_role_selection(context, history)
    kept, text_sources = [], []
    removed_role = False
    for item in context['historyDependencies']:
        row = sources.get(item['roundId'])
        prior = (row or {}).get('taskContext')
        first_binding = (prior is not None and not prior.get('target') and
                         not any((prior_row.get('taskContext') or {}).get('taskId') == prior.get('taskId')
                                 and prior_row['index'] <= row['index']
                                 and any(prior_row.get(key) for key in ('inputImageIds', 'taskImageIds', 'outputTaskIds', 'retryTaskIds'))
                                 for prior_row in history))
        paired_selection = row is not None and receipt_index is not None and row['index'] <= receipt_index
        if item['reason'] == ROLE_CHANGE and (image_roles_resolved or first_binding or paired_selection):
            removed_role = True
            # Binding pixels does not waive the source turn's written request.
            if row is None or row.get('prompt'):
                text_sources.append(item['roundId'])
        else:
            kept.append(item)
    context['historyDependencies'] = kept
    for round_id in text_sources:
        dependency(context, round_id, 'unreconciled_user_addition')
    if image_roles_resolved:
        context['_imageRoleBinding'] = {'roundId': context['branchRoundId'],
            'targetAssetId': (context.get('target') or {}).get('assetId'),
            'auxiliaries': [[image['assetId'], image['role']] for image in context.get('auxiliaries', [])]}
        context['unresolvedItems'] = [item for item in context['unresolvedItems'] if item not in ROLE_UNRESOLVED]
    elif removed_role and not any(item['reason'] == ROLE_CHANGE for item in kept):
        context['unresolvedItems'] = [item for item in context['unresolvedItems'] if item != ROLE_CHANGE_UNRESOLVED]
    return refresh(context)


def advance(previous, editing_task, *, prompt, branch_id, boundary=False, requirements_history=(), explicit_target=False, history=()):
    target = (editing_task or {}).get('target')
    if not editing_task and previous and previous['taskType'] != 'image_edit':
        target = previous.get('target')
    prior_visual = previous and any((row.get('taskContext') or {}).get('taskId') == previous.get('taskId') and
                                   any(row.get(key) for key in ('inputImageIds', 'taskImageIds', 'outputTaskIds', 'retryTaskIds'))
                                   for row in history)
    changed_target = bool(previous and (previous.get('target') or prior_visual) and target
                          and (previous.get('target') or {}).get('assetId') != target['assetId']
                          and previous.get('branchRoundId') and not (editing_task or {}).get('continuesTask')
                          and not explicit_target)
    if previous and previous.get('pendingUserTask'):
        boundary = changed_target = False
    if not previous or boundary:
        value = new(prompt, branch_id, task_type='image_edit' if editing_task else 'chat', target=target,
                    auxiliaries=(editing_task or {}).get('auxiliaries', []))
        if not previous and editing_task:
            # Legacy manual task text has no message source to reconstruct.
            # Keep it exactly rather than claiming the current short follow-up
            # contains every requirement already confirmed by the user.
            legacy_text = editing_task.get('requirements', '')
            if legacy_text and legacy_text != prompt:
                value['promptVersions'][0].update(text=legacy_text, source=source('legacy', branch_id))
            value['constraints'] = [{'id': identifier('constraint'), 'text': text, 'status': 'active',
                                      'source': source('legacy', branch_id)} for text in editing_task.get('constraints', [])]
    else:
        value = copy.deepcopy(previous)
        value['workingPromptVersionId'] = working_prompt_id(previous)
        value['revision'] += 1
        value['branchRoundId'] = branch_id
        if not value.get('startRoundId'):
            value['startRoundId'] = branch_id
        value['sourceRoundIds'] = list(dict.fromkeys([*value.get('sourceRoundIds', []), *([branch_id] if branch_id else [])]))
        old_addition = value.get('latestUserAddition')
        # A supplement is never silently dropped from compact context. Until a
        # state tool reconciles it, its exact historical turn remains required.
        if old_addition and not old_addition.get('reconciled') and old_addition.get('roundId') != branch_id:
            original = next((p for p in value['promptVersions'] if p['id'] == value['originalPromptVersionId']), None)
            if not original or old_addition['text'] != original['text']:
                dependency(value, old_addition.get('roundId'), 'unreconciled_user_addition')
        value['latestUserAddition'] = {'text': prompt, 'roundId': branch_id}
        if not value['promptVersions']:
            prompt_id = identifier('prompt')
            value['promptVersions'] = [{'id': prompt_id, 'text': prompt, 'kind': 'original',
                                        'source': source('user', branch_id), 'confirmedBy': 'user'}]
            value['originalPromptVersionId'] = prompt_id
        value['target'] = copy.deepcopy(target)
        if editing_task:
            value['auxiliaries'] = copy.deepcopy(editing_task.get('auxiliaries', []))
        if editing_task and (changed_target or previous['taskType'] == 'chat'):
            value['taskType'] = 'image_edit'
        if changed_target:
            # A new attachment identifies a new subject, but says nothing about
            # whether the prior composition, constraints or image are obsolete.
            # Keep the user's effective state and require its exact old source
            # until the normal model turn can resolve the image roles.
            dependency(value, previous['branchRoundId'], 'target_changed_requires_prior_evidence')
            unresolved = '已添加新的编辑对象；旧图与约束是否继续适用尚需确认。'
            if unresolved not in value['unresolvedItems']:
                value['unresolvedItems'].append(unresolved)
    for round_id in requirements_history:
        dependency(value, round_id, 'legacy_requirements_in_history')
    if editing_task and editing_task.get('needsTargetSelection'):
        if '请选择本次编辑对象。' not in value['unresolvedItems']:
            value['unresolvedItems'].append('请选择本次编辑对象。')
    value['pendingUserTask'] = False
    resolved = bool(explicit_target or (editing_task or {}).get('continuesTask') and previous and
                    target and target != previous.get('target'))
    return reconcile(value, history=history, image_roles_resolved=resolved)


def project_editing(context, previous=None):
    """Keep the old image executor contract while state remains authoritative."""
    if not context or context['taskType'] != 'image_edit':
        return None
    previous = previous or {}
    if previous.get('taskId') != context['taskId']:
        previous = {}
    selected = next((p['text'] for p in context['promptVersions'] if p['id'] == context['selectedPromptVersionId']), None)
    original = next((p['text'] for p in context['promptVersions'] if p['id'] == context['originalPromptVersionId']), '')
    requirements = selected if selected is not None else previous.get('requirements', original)
    return {**copy.deepcopy(previous), 'version': 1, 'branchRoundId': context['branchRoundId'], 'taskId': context['taskId'],
            'target': copy.deepcopy(context['target']), 'auxiliaries': copy.deepcopy(context['auxiliaries']),
            'requirements': requirements if len(requirements) <= 4000 else '',
            'requirementsInHistory': bool(previous.get('requirementsInHistory')) or len(requirements) > 4000,
            'constraints': [c['text'] for c in context['constraints'] if c['status'] == 'active'][:12],
            'workflow': previous.get('workflow', 'auto'), 'needsTargetSelection': context['target'] is None,
            'candidates': copy.deepcopy(previous.get('candidates', [])) if context['target'] is None else []}


def apply(context, operations, *, actor, branch_id, select_asset, validate_source, user_text='', prompt_archive=None,
          restore_prompt=None, history=()):
    from backend.services.agent_repository import AgentError

    def invalid(message='任务状态操作无效。'):
        raise AgentError('invalid_task_context', message, 400)

    value = copy.deepcopy(context) if context else new('', branch_id)
    prompt_archive = prompt_archive if prompt_archive is not None else {}
    previous_revision = value['revision']
    allowed_model = {'set_task_type', 'set_target', 'set_auxiliaries', 'add_constraint', 'update_constraint',
                     'revoke_constraint', 'set_prompt', 'restore_working_prompt', 'set_unresolved', 'set_history_dependencies',
                     'start_task', 'reconcile_text_source'}
    for operation_index, operation in enumerate(operations):
        item = operation.model_dump(exclude_none=True) if hasattr(operation, 'model_dump') else operation
        op, text = item.get('op'), item.get('text')
        if actor == 'model' and op not in allowed_model:
            invalid('模型只能提议任务状态，不能代替用户确认或新建任务。')
        provenance = source(actor, branch_id)
        user_authority = actor == 'user'
        if actor == 'model' and item.get('sourceQuote') is not None and op != 'reconcile_text_source':
            quote = item['sourceQuote']
            if not isinstance(quote, str) or not quote.strip() or quote not in user_text:
                invalid('约束来源必须逐字匹配本轮用户原文。')
            provenance = source('user', branch_id, quote=quote, authority='user_instruction', interpretedBy='model')
            user_authority = True
        if op == 'start_task':
            # This is an interpretation of this exact user request, not model
            # authority to confirm constraints, select a draft or grant tools.
            # Starting first keeps the rest of the batch scoped to the new task.
            if (actor != 'model' or operation_index != 0 or not user_text.strip()
                    or item.get('sourceQuote') != user_text or text not in (None, user_text)
                    or item.get('taskType') not in {'chat', 'image_edit', 'image_generation', 'prompt',
                                                    'analysis', 'reverse', 'prompt_optimization'}):
                invalid('新任务必须逐字引用本轮完整用户要求，并作为首个操作。')
            previous_task_id = value['taskId']
            value = new(user_text, branch_id, task_type=item['taskType'])
            value['_taskBoundary'] = {'previousTaskId': previous_task_id, 'roundId': branch_id,
                                      'sourceSha256': hashlib.sha256(user_text.encode('utf-8')).hexdigest(),
                                      'interpretedBy': 'model'}
        elif op == 'new_task':
            value = new(text or '', branch_id, task_type=item.get('taskType', 'chat'))
            value['pendingUserTask'] = True
        elif op == 'set_task_type':
            if item.get('taskType') not in {'chat', 'image_edit', 'image_generation', 'prompt', 'analysis', 'reverse', 'prompt_optimization'}:
                invalid()
            value['taskType'] = item['taskType']
        elif op == 'set_target':
            value['target'] = select_asset(item['ref']) if item.get('ref') else None
            value['targetExplicit'] = actor == 'user'
            value['taskType'] = 'image_edit' if value['target'] else value['taskType']
        elif op == 'set_auxiliaries':
            value['auxiliaries'] = [{**select_asset(aux['ref']), 'role': aux['role']} for aux in item.get('auxiliaries', [])]
        elif op in {'add_constraint', 'update_constraint', 'revoke_constraint'}:
            if op != 'revoke_constraint' and (not isinstance(text, str) or not text.strip() or len(text) > 1000):
                invalid('约束内容必须为 1 到 1000 个字符。')
            if op == 'add_constraint':
                if len(value['constraints']) >= 48:
                    invalid('当前任务约束过多，请开启新任务或整理约束。')
                value['constraints'].append({'id': identifier('constraint'), 'text': text,
                                            'status': 'active' if user_authority else 'proposed', 'source': provenance})
            else:
                found = next((c for c in value['constraints'] if c['id'] == item.get('id')), None)
                if not found:
                    invalid('约束不存在。')
                if not user_authority and found['status'] == 'active':
                    invalid('模型不能修改或撤销已确认约束；请提出候选约束。')
                found.update(status='revoked' if op == 'revoke_constraint' else 'active' if user_authority else 'proposed',
                             source=provenance)
                if op != 'revoke_constraint':
                    found['text'] = text
            if (actor == 'model' and user_authority and item.get('sourceQuote') == user_text
                    and value.get('latestUserAddition', {}).get('roundId') == branch_id):
                value['latestUserAddition']['reconciled'] = True
        elif op == 'set_prompt':
            if not isinstance(text, str) or not text.strip():
                invalid('Prompt 不能为空。')
            if item.get('source'):
                provenance = validate_source(item['source'], text)
            elif actor == 'model':
                provenance = source('model', branch_id)
                if item.get('sourceQuote'):
                    provenance['userInstruction'] = {'roundId': branch_id, 'quote': item['sourceQuote']}
            kind = item.get('kind', 'candidate')
            if actor == 'model' and kind != 'candidate':
                invalid('模型生成的 Prompt 只能作为候选版本。')
            prompt_id = identifier('prompt')
            value['promptVersions'].append({'id': prompt_id, 'text': text, 'kind': kind, 'source': provenance,
                                            'confirmedBy': 'user' if actor == 'user' and kind == 'selected' else None})
            value['workingPromptVersionId'] = prompt_id
            value.pop('workingPromptSource', None)
            if actor == 'user' and kind == 'selected':
                value['selectedPromptVersionId'] = prompt_id
        elif op in {'select_prompt', 'restore_prompt', 'restore_working_prompt'}:
            if op == 'restore_working_prompt' and actor == 'model' and item.get('sourceQuote') != user_text:
                invalid('恢复讨论版本必须逐字引用本轮完整用户要求。')
            found = next((p for p in value['promptVersions'] if p['id'] == item.get('id')), None)
            if not found and restore_prompt:
                found = copy.deepcopy(restore_prompt(item.get('id')))
                if found:
                    value['promptVersions'].append(found)
            if not found:
                invalid('Prompt 版本不存在。')
            value['workingPromptVersionId'] = found['id']
            if op == 'restore_working_prompt':
                value['workingPromptSource'] = {**provenance, 'restoredFrom': found['id']}
            else:
                value['selectedPromptVersionId'] = found['id']
                found['confirmedBy'] = 'user'
                value.pop('workingPromptSource', None)
        elif op == 'set_unresolved':
            value['unresolvedItems'] = item.get('items', [])
        elif op == 'reconcile_text_source':
            # Exact frozen sources, not a generated Prompt or a successful image
            # job alone, support removing a textual transcript dependency.
            round_id = item.get('roundId')
            source_text = (user_text if round_id == branch_id else
                           next((row['prompt'] for row in history if row['id'] == round_id), None))
            latest = value.get('latestUserAddition') or {}
            dependencies = value['historyDependencies']
            required = any(d['roundId'] == round_id and d['reason'] in TEXT_DEPENDENCIES for d in dependencies)
            if (not source_text or item.get('sourceQuote') != source_text
                    or not (required or latest.get('roundId') == round_id)):
                invalid('只能协调当前任务所需的完整冻结用户原文。')
            prompt_id = item.get('id') or working_prompt_id(value)
            prompt = next((p for p in value['promptVersions'] if p['id'] == prompt_id), None)
            if not prompt or prompt['kind'] != 'candidate':
                invalid('协调文本必须指向当前任务已记录的候选 Prompt。')
            # Keep the provenance without copying another hidden transcript.
            # Candidate status remains unchanged and is never user confirmation.
            value.setdefault('_textReconciliations', {})[round_id] = {
                'promptVersionId': prompt_id, 'roundId': branch_id, 'actor': actor,
                'sourceSha256': hashlib.sha256(source_text.encode('utf-8')).hexdigest()}
            value['historyDependencies'] = [d for d in dependencies
                if not (d['roundId'] == round_id and d['reason'] in TEXT_DEPENDENCIES)]
            if latest.get('roundId') == round_id:
                latest['reconciled'] = True
        elif op == 'set_history_dependencies':
            dependencies = item.get('dependencies', [])
            for entry in dependencies:
                if set(entry) != {'roundId', 'reason'} or not isinstance(entry['reason'], str) or len(entry['reason']) > 200:
                    invalid()
                validate_source({'kind': 'user', 'roundId': entry['roundId']}, None)
            # User may explicitly narrow context. Model output cannot erase raw
            # history that was marked necessary by overflow or old task data.
            preserved = [d for d in value['historyDependencies'] if actor == 'model' and d['reason'] in {
                'legacy_requirements_in_history', 'unreconciled_user_addition', 'legacy_context_missing',
                'target_changed_requires_prior_evidence'}]
            value['historyDependencies'] = preserved
            for entry in dependencies:
                dependency(value, entry['roundId'], entry['reason'])
        else:
            invalid()
    identities = [image['assetId'] for image in ([value['target']] if value['target'] else []) + value['auxiliaries']]
    if len(identities) != len(set(identities)):
        raise AgentError('invalid_reference', '编辑对象和辅助参考不能重复。', 400)
    value['revision'] = previous_revision + 1
    value['branchRoundId'] = branch_id
    trim_prompts(value, prompt_archive)
    roles = any((item.model_dump() if hasattr(item, 'model_dump') else item)['op']
                in ({'set_target', 'set_auxiliaries'} if value.get('target') else {'set_target'}) for item in operations)
    return reconcile(value, history=history, image_roles_resolved=roles)


def record_execution(context, prompt, *, round_id, prompt_archive=None):
    """Record the exact submitted tool Prompt; execution never selects a draft."""
    if not context:
        return None
    value = copy.deepcopy(context)
    existing = next((p for p in value['promptVersions'] if p['id'] == value.get('executedPromptVersionId')), None)
    if existing and existing['text'] == prompt and existing['source']['roundId'] == round_id:
        return value
    prompt_id = identifier('prompt')
    value['promptVersions'].append({'id': prompt_id, 'text': prompt, 'kind': 'executed',
                                    'source': source('model', round_id), 'confirmedBy': None})
    value['executedPromptVersionId'] = prompt_id
    value['revision'] += 1
    return trim_prompts(value, prompt_archive if prompt_archive is not None else {})
