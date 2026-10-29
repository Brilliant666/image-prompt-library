"""Bounded branch-local task state in the existing editing-task JSON column.

The state is an explicit projection, never a replacement for preserved messages.
Only user actions can select a Prompt or confirm a proposed constraint.
"""
from __future__ import annotations

import copy
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
            'executedPromptVersionId': None, 'constraints': [],
            'latestUserAddition': {'text': text, 'roundId': branch_id} if text else None,
            'unresolvedItems': [], 'completeness': 'complete', 'historyDependencies': []}


def trim_prompts(context, archive):
    """Keep a bounded active window; exact older versions stay in branch JSON."""
    protected = {context.get(field) for field in ('originalPromptVersionId', 'selectedPromptVersionId', 'executedPromptVersionId')}
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


def advance(previous, editing_task, *, prompt, branch_id, boundary=False, requirements_history=(), explicit_target=False):
    target = (editing_task or {}).get('target')
    if not editing_task and previous and previous['taskType'] != 'image_edit':
        target = previous.get('target')
    changed_target = bool(previous and target and (previous.get('target') or {}).get('assetId') != target['assetId']
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
        if editing_task:
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
    return refresh(value)


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
            'candidates': []}


def apply(context, operations, *, actor, branch_id, select_asset, validate_source, user_text='', prompt_archive=None,
          restore_prompt=None):
    from backend.services.agent_repository import AgentError

    def invalid(message='任务状态操作无效。'):
        raise AgentError('invalid_task_context', message, 400)

    value = copy.deepcopy(context) if context else new('', branch_id)
    prompt_archive = prompt_archive if prompt_archive is not None else {}
    previous_revision = value['revision']
    allowed_model = {'set_task_type', 'set_target', 'set_auxiliaries', 'add_constraint', 'update_constraint',
                     'revoke_constraint', 'set_prompt', 'set_unresolved', 'set_history_dependencies'}
    for operation in operations:
        item = operation.model_dump(exclude_none=True) if hasattr(operation, 'model_dump') else operation
        op, text = item.get('op'), item.get('text')
        if actor == 'model' and op not in allowed_model:
            invalid('模型只能提议任务状态，不能代替用户确认或新建任务。')
        provenance = source(actor, branch_id)
        user_authority = actor == 'user'
        if actor == 'model' and item.get('sourceQuote') is not None:
            quote = item['sourceQuote']
            if not isinstance(quote, str) or not quote.strip() or quote not in user_text:
                invalid('约束来源必须逐字匹配本轮用户原文。')
            provenance = source('user', branch_id, quote=quote, authority='user_instruction', interpretedBy='model')
            user_authority = True
        if op == 'new_task':
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
            if actor == 'user' and kind == 'selected':
                value['selectedPromptVersionId'] = prompt_id
        elif op in {'select_prompt', 'restore_prompt'}:
            found = next((p for p in value['promptVersions'] if p['id'] == item.get('id')), None)
            if not found and restore_prompt:
                found = copy.deepcopy(restore_prompt(item.get('id')))
                if found:
                    value['promptVersions'].append(found)
            if not found:
                invalid('Prompt 版本不存在。')
            value['selectedPromptVersionId'] = found['id']
            found['confirmedBy'] = 'user'
        elif op == 'set_unresolved':
            value['unresolvedItems'] = item.get('items', [])
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
    return refresh(value)


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
