"""Small branch-local editing context. This does not select or discard pixels."""
import copy
import re


_EDIT = re.compile(r'修改|编辑|更换|换成|换一下|换掉|调整|改成|改为|帮[她他它].*换|继续修改|\b(?:edit|modify|change|replace|adjust)\b', re.I)
_END = re.compile(r'(?:与|和)(?:前面|之前|前一张|上一张|前)(?:的)?(?:图|图片).*无关|结束(?:当前|这个|本次)?(?:编辑|任务)|全新(?:的)?(?:图片|任务)|\b(?:unrelated to (?:the )?(?:previous|earlier)|end (?:this |the )?(?:edit|task)|new editing task)\b', re.I)
_CONTINUE_RESULT = re.compile(r'(?:继续|再|接着).*(?:上一张|上张|刚才|最新).*(?:结果|生成|图)|\b(?:continue|edit|modify) (?:the )?(?:last|latest|previous) (?:generated |result )?image\b', re.I)
_LIGHT = re.compile(r'(?:参考|沿用|保持).*(?:前面|之前|上[一张]|历史).*(?:光线|灯光)|(?:前面|之前|上[一张]).*(?:光线|灯光)|\b(?:previous|earlier).*(?:light|lighting)\b', re.I)
_ROUND = re.compile(r'@(?:第)?(\d+)轮图(\d+)')
_CURRENT = re.compile(r'@图(\d+)')
_TAG = re.compile(r'<ref\b[^>]*\bid=["\'](round-\d+-(?:image|reference)-\d+)["\'][^>]*\s*/?>')
_TOPIC_CHANGE = re.compile(r'^(?:请|我们|现在|接下来|好了|好)[，,\s]*(?:换个话题|换个问题|新任务|新的任务|另一个任务)|^(?:换个话题|换个问题|新任务|新的任务|另一个任务)|^(?:(?:please|now|let\'s)\s+)?(?:start\s+(?:a\s+)?)?(?:new task|new topic|change (?:the )?topic|another topic)\b', re.I)
_BOUNDARY_NEGATION = re.compile(r'(?:不要|不用|不必|别|不是|并非|\b(?:do not|don\'t|dont|not|never)\b)[^，,。.!！？?；;\n]{0,24}$', re.I)


def task_boundary(prompt):
    text = prompt.strip()
    return any(not _BOUNDARY_NEGATION.search(text[max(0, match.start() - 40):match.start()])
               for pattern in (_END, _TOPIC_CHANGE) for match in pattern.finditer(text))


def branch_key(round_id):
    return round_id or '__root__'


def current_task(conversation, rounds, branch_id):
    import json
    drafts = json.loads(conversation['editing_tasks'])
    key = branch_key(branch_id)
    if key in drafts:
        saved = drafts[key]
        from backend.services.agent_task_state import ENVELOPE
        if isinstance(saved, dict) and saved.get('_kind') == ENVELOPE:
            return copy.deepcopy(saved.get('editingTask'))
        return copy.deepcopy(saved)
    return copy.deepcopy(next((r.get('editingTask') for r in rounds if r['id'] == branch_id), None))


def all_input_ids(round_data):
    return [*round_data.get('inputImageIds', []), *round_data.get('taskImageIds', [])]


def all_output_ids(round_data):
    return [*round_data.get('outputTaskIds', []), *round_data.get('retryTaskIds', [])]


def asset_selection(repo, asset_id):
    import json
    asset = repo.asset(asset_id)
    return {'assetId': asset_id, 'source': json.loads(asset['source'])}


def references(history, inputs, current_index):
    result = {f'round-{current_index}-reference-{i + 1}': aid for i, aid in enumerate(inputs)}
    for row in history:
        result.update({f'round-{row["index"]}-reference-{i + 1}': aid for i, aid in enumerate(all_input_ids(row))})
        result.update({f'round-{row["index"]}-image-{i + 1}': aid for i, aid in enumerate(row.get('frozenOutputImages', []))})
    return result


def infer_task(repo, previous, *, conversation_id, parent_id, prompt, inputs, history, config):
    """Resolve concrete selectors first; unknown multi-image roles stay unknown.

    A few explicit task boundaries help ordinary chat. They are not a classifier
    for every possible instruction: full history and all required pixels remain.
    """
    if task_boundary(prompt):
        previous = None
        if not inputs:
            return None
    available = references(history, inputs, len(history) + 1)
    selector_matches = [(m, m[1]) for m in _TAG.finditer(prompt)]
    selector_matches += [(m, f'round-{m[1]}-image-{m[2]}') for m in _ROUND.finditer(prompt)]
    selector_matches += [(m, f'round-{len(history) + 1}-reference-{m[1]}') for m in _CURRENT.finditer(prompt)]
    explicit_auxiliary = []
    selectors = []
    for match, ref in selector_matches:
        if not available.get(ref):
            continue
        prefix = prompt[max(0, match.start() - 24):match.start()]
        nearby = prefix + prompt[match.end():match.end() + 20]
        role = next((role for role, words in (('lighting', r'光线|灯光|lighting'), ('style', r'风格|style'),
                    ('composition', r'构图|composition'), ('subject', r'主体|subject')) if re.search(words, nearby, re.I)), None)
        if role and re.search(r'(?:参考|沿用|借鉴|参照|reference|using)[^，。；\n]{0,18}$', prefix, re.I):
            explicit_auxiliary.append({**asset_selection(repo, available[ref]), 'role': role})
        else:
            selectors.append(ref)
    explicit = list(dict.fromkeys(available[ref] for ref in selectors))
    edit = bool(_EDIT.search(prompt))
    target, auxiliary, candidates = None, [], []
    replace, continuing_result = False, False
    if len(explicit) == 1 and (edit or previous):
        target, replace = explicit[0], True
    elif inputs and (len(inputs) == 1 or edit or explicit_auxiliary or _LIGHT.search(prompt)):
        # A sole current attachment is a concrete discussion/analysis object,
        # even for reverse prompting or ordinary visual questions. This binds
        # identity, not intent or generation permission. Multiple unassigned
        # images remain ambiguous; changed targets retain prior task evidence.
        # A new attachment explicitly assigned an auxiliary role is not a new
        # editing subject. Keep the selected subject when every new image is
        # auxiliary; otherwise use only the remaining unassigned candidates.
        auxiliary_ids = {image['assetId'] for image in explicit_auxiliary}
        primary_inputs = [aid for aid in inputs if aid not in auxiliary_ids]
        target = primary_inputs[0] if len(primary_inputs) == 1 else None
        if not primary_inputs and previous and previous.get('target'):
            target = previous['target']['assetId']
        replace = True
        candidates = primary_inputs if len(primary_inputs) > 1 else []
    elif _CONTINUE_RESULT.search(prompt):
        recent = next((r for r in reversed(history) if any(r.get('frozenOutputImages', []))), None)
        choices = list(dict.fromkeys(aid for aid in (recent or {}).get('frozenOutputImages', []) if aid))
        target, replace = (choices[0] if len(choices) == 1 else None), True
        candidates = choices if len(choices) > 1 else []
        continuing_result = True
    elif len(explicit) > 1 and edit:
        replace, candidates = True, explicit
    if replace:
        auxiliary = explicit_auxiliary
        if target and inputs and _LIGHT.search(prompt) and not auxiliary:
            if previous and previous.get('target'):
                auxiliary = [{**previous['target'], 'role': 'lighting'}]
            else:
                old = next((r for r in reversed(history) if r.get('frozenOutputImages') or all_input_ids(r)), None)
                choices = list(dict.fromkeys(aid for aid in ([*(old or {}).get('frozenOutputImages', []), *all_input_ids(old or {})]) if aid))
                if len(choices) == 1:
                    auxiliary = [{**asset_selection(repo, choices[0]), 'role': 'lighting'}]
        same_task = previous and (continuing_result or target and (previous.get('target') or {}).get('assetId') == target)
        if same_task and not auxiliary:
            auxiliary = previous.get('auxiliaries', [])
        value = {'version': 1, 'target': asset_selection(repo, target) if target else None,
                 'auxiliaries': [a for a in auxiliary if a['assetId'] != target], 'requirements': '',
                 'constraints': [], 'workflow': 'auto', 'needsTargetSelection': target is None,
                 'candidates': [asset_selection(repo, aid) for aid in candidates[:4]]}
        value['continuesTask'] = bool(same_task)
        if same_task:
            value.update({key: copy.deepcopy(previous.get(key, default)) for key, default in (
                ('requirements', ''), ('constraints', []), ('workflow', 'auto'))})
    else:
        value = copy.deepcopy(previous)
    if value is None:
        return None
    value.update(conversationId=conversation_id, branchRoundId=parent_id,
                 configIdentity={key: config.get(source) for key, source in (
                     ('mode', 'apiConfigMode'), ('textProfileId', 'textProfileId'), ('textModel', 'textModel'),
                     ('imageProfileId', 'imageProfileId'), ('imageModel', 'imageModel'))})
    # These are verbatim user requirements, never model-invented constraints.
    # Full messages are preserved in history if the small display field is full.
    addition = prompt.strip()
    old_requirements = value.get('requirements', '')
    combined = old_requirements + ('\n' if old_requirements else '') + addition
    if addition and addition not in old_requirements.splitlines() and len(combined) <= 4000:
        value['requirements'] = combined
    elif len(combined) > 4000:
        value['requirementsInHistory'] = True
    return value


def execution_task(round_data):
    """Bridge the frozen task's image bindings to the existing image executor.

    Prompt-only discussion deliberately need not be an old editingTask. Its
    bound target/auxiliaries nevertheless remain the recipe's exact inputs;
    forgetting that envelope must never silently become text-to-image.
    """
    if round_data.get('editingTask') is not None:
        return round_data['editingTask']
    context = round_data.get('taskContext') or {}
    target, auxiliaries = context.get('target'), context.get('auxiliaries', [])
    if not target and not auxiliaries:
        return None
    return {'target': target, 'auxiliaries': auxiliaries,
            'needsTargetSelection': not target or bool(context.get('unresolvedItems'))}


def required_asset_ids(task):
    return list(dict.fromkeys(image['assetId'] for image in ([task['target']] if task and task.get('target') else []) +
                             (task.get('auxiliaries', []) if task else [])))


def select_references(repo, request, arguments, refs):
    """Bind a model's conversational selection to this frozen branch only."""
    from backend.services.agent_repository import AgentError, encoded

    if (not isinstance(arguments, dict) or set(arguments) != {'targetRef', 'auxiliaries'}
            or not isinstance(arguments['auxiliaries'], list) or len(arguments['auxiliaries']) > 3):
        raise AgentError('invalid_reference', '图片选择参数无效；请选择当前分支提供的图片。', 400)
    target_ref, auxiliaries = arguments['targetRef'], arguments['auxiliaries']
    if target_ref is None:
        if auxiliaries:
            raise AgentError('invalid_reference', '辅助参考需要明确的编辑对象。', 400)
        return None

    def selected(ref):
        if not isinstance(ref, str) or not refs.get(ref):
            raise AgentError('reference_missing', '所选图片不在本轮冻结引用中；不会用其他图片替代。', 400)
        image = asset_selection(repo, refs[ref])
        repo._check_frozen_asset(repo.asset(image['assetId']), encoded(image['source']))
        return image

    target = selected(target_ref)
    chosen = []
    for item in auxiliaries:
        if (not isinstance(item, dict) or set(item) != {'ref', 'role'} or not isinstance(item['role'], str)
                or item['role'] not in {'lighting', 'style', 'subject', 'composition', 'other'}):
            raise AgentError('invalid_reference', '辅助参考角色无效。', 400)
        chosen.append({**selected(item['ref']), 'role': item['role']})
    identities = [target['assetId'], *(image['assetId'] for image in chosen)]
    if len(set(identities)) != len(identities):
        raise AgentError('invalid_reference', '编辑对象和辅助参考不能重复。', 400)
    previous = request['round'].get('editingTask') or {}
    return {**copy.deepcopy(previous), 'version': 1, 'conversationId': request['conversation_id'],
            'branchRoundId': request['round_id'], 'target': target, 'auxiliaries': chosen,
            'requirements': previous.get('requirements', request['round']['prompt']),
            'constraints': previous.get('constraints', []), 'workflow': previous.get('workflow', 'auto'),
            'needsTargetSelection': False, 'candidates': []}


def context_data(task, refs):
    if not task:
        return None
    def label(image):
        return next((ref for ref, aid in reversed(list(refs.items())) if aid == image['assetId']), None) if image else None
    return {'targetRef': label(task.get('target')),
            'auxiliaries': [{'ref': label(image), 'role': image['role']} for image in task.get('auxiliaries', [])],
            'requirements': task.get('requirements', ''), 'constraints': task.get('constraints', []),
            'workflow': task.get('workflow', 'auto'), 'needsTargetSelection': task.get('needsTargetSelection', False)}
