"""Choose the disposable task view before reading or encoding any pixels.

History, frozen requests and the branch reference allowlist are never rewritten.
Missing state has an explicit compatibility path rather than an invented summary.
"""
from dataclasses import dataclass
import heapq
import re

from backend.services import agent_editing_task as editing
from backend.services.agent_task_state import ROLE_CHANGE, TEXT_DEPENDENCIES
from backend.services.agent_context import _reference_scope, select_context_images, _ROUND_MENTION, _CURRENT_MENTION, _REF_TAG


@dataclass
class ContextScope:
    history: list
    assets: set | None
    scope: str
    reason: str | None = None
    image_refs: set | None = None


def numeric_sources(prompt):
    # A whole-round locator is broader than an exact image locator. Do not turn
    # @第N轮图M into a request for every picture of that round.
    text = _ROUND_MENTION.sub(' ', _REF_TAG.sub(' ', prompt))
    return {int(n) for n in re.findall(r'第\s*(\d+)\s*轮', text)}


def exact_text_locators(row, refs, rounds):
    """Resolve only pictures explicitly named by this frozen user text."""
    from backend.services.agent_repository import AgentError
    named = {match[1] for match in _REF_TAG.finditer(row['prompt'])}
    named.update(f'round-{int(match[1])}-image-{int(match[2])}' for match in _ROUND_MENTION.finditer(row['prompt']))
    for match in _CURRENT_MENTION.finditer(row['prompt']):
        slot = int(match[1])
        if not 0 < slot <= len(row.get('inputImageIds', [])):
            raise AgentError('reference_missing', '必要文字历史来源的图片引用缺失，请选择有效来源。', 400)
        named.add(f'round-{row["index"]}-reference-{slot}')
    if any(not refs.get(ref) for ref in named):
        raise AgentError('reference_missing', '必要文字历史来源的图片引用缺失或不属于当前分支，请选择有效来源。', 400)
    sources = []
    for number in numeric_sources(row['prompt']):
        ancestor = rounds.get(number)
        if not ancestor or number > row['index']:
            raise AgentError('reference_missing', '必要文字历史来源指向的图片轮次不可用，请选择有效历史来源。', 400)
        sources.append(ancestor)
    return {refs[ref] for ref in named}, named, sources


def pending_candidate_assets(row, refs):
    """Unselected frozen candidates are evidence, never a guessed target."""
    task = editing.execution_task(row) or {}
    if not task.get('needsTargetSelection'):
        return set()
    candidates = {image.get('assetId') if isinstance(image, dict) else None
                  for image in task.get('candidates', [])}
    if not candidates <= {aid for aid in refs.values() if aid}:
        from backend.services.agent_repository import AgentError
        raise AgentError('reference_missing', '待选择的候选图片缺失或不属于当前冻结分支，请重新选择有效来源。', 400)
    return candidates


def visual_source_bindings(row, refs, rounds, current_task=None):
    """Close one required source over its frozen roles and exact locators.

    A discussion turn may inherit its subject without owning any new image.
    Only the authorized branch map can supply its pixels; never substitute the
    current subject when a required older binding is missing.
    """
    from backend.services.agent_repository import AgentError
    assets, selected, visited, text_sources = set(), set(), set(), set()
    pending = [(-row['index'], row['id'], row)]
    allowed = {aid for aid in refs.values() if aid}
    by_id = {source['id']: source for source in rounds.values()}
    # Only automatic role-change bookkeeping can be superseded by an effective
    # task graph. Explicit visual, unknown and legacy evidence belongs to the
    # selected historical source even if a later version of its task changed.
    active = current_task or {}
    role_graphs = ({active['taskId']: {entry['roundId'] for entry in active['historyDependencies']
                                     if entry['reason'] == ROLE_CHANGE}}
                   if active.get('taskId') and isinstance(active.get('historyDependencies'), list) else {})
    while pending:
        _, _, source = heapq.heappop(pending)
        if source['id'] in visited:
            continue
        visited.add(source['id'])
        bound = set(editing.required_asset_ids(source.get('taskContext')))
        bound.update(editing.required_asset_ids(source.get('editingTask')))
        bound.update(pending_candidate_assets(source, refs))
        _, named, numeric = exact_text_locators(source, refs, rounds)
        if not bound <= allowed:
            raise AgentError('reference_missing', '必要历史来源的图片引用缺失或不属于当前分支，请重新选择有效来源。', 400)
        for ancestor in numeric:
            heapq.heappush(pending, (-ancestor['index'], ancestor['id'], ancestor))
        # Reading a source also requires the exact visual evidence its frozen
        # task already depended on. Text-only additions do not promote their
        # own attachments or bindings to visual evidence.
        source_task = source.get('taskContext') or {}
        task_key = source_task.get('taskId') or ('legacy', source['id'])
        # All edges point backwards. Newest-first traversal chooses a stable
        # effective role graph for an older task, independent of entry order.
        graph = source_task.get('historyDependencies')
        dependencies = graph if isinstance(graph, list) else []
        if task_key not in role_graphs and isinstance(graph, list):
            role_graphs[task_key] = {entry['roundId'] for entry in graph if entry['reason'] == ROLE_CHANGE}
        for dependency in dependencies:
            if dependency['reason'] == ROLE_CHANGE and dependency['roundId'] not in role_graphs[task_key]:
                continue
            ancestor = by_id.get(dependency['roundId'])
            if not ancestor or ancestor['index'] > source['index']:
                raise AgentError('reference_missing', '必要历史来源依赖的图片轮次缺失或不属于当时分支，请选择有效历史来源。', 400)
            if dependency['reason'] in TEXT_DEPENDENCIES:
                # Keep the exact supplement, but do not expand its own roles,
                # unmentioned attachments or older task graph as visual data.
                if ancestor['id'] not in text_sources:
                    text_sources.add(ancestor['id'])
                    text_assets, _, text_rounds = exact_text_locators(ancestor, refs, rounds)
                    assets.update(text_assets)
                    for text_round in text_rounds:
                        heapq.heappush(pending, (-text_round['index'], text_round['id'], text_round))
                continue
            heapq.heappush(pending, (-ancestor['index'], ancestor['id'], ancestor))
        named.update(ref for ref, aid in refs.items() if aid and ref.startswith(f'round-{source["index"]}-'))
        assets.update(bound)
        assets.update(refs[ref] for ref in named)
        selected.update(named)
    return assets, selected, visited | text_sources


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
    visual_ids = {row['roundId'] for row in dependencies if row['reason'] not in TEXT_DEPENDENCIES}
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
        # Keep exact textual evidence and source locators for unresolved legacy
        # questions. The flag does not identify every historical picture as
        # necessary. Specific visual dependencies and read_task_history below
        # supply pixels; an unlocated question can be clarified normally.
        if scope == 'task':
            keep = {r['id'] for r in (task_rows or history)} | {r['id'] for r in rows}
            rows = [r for r in history if r['id'] in keep]
        reason = 'unresolved_task_evidence'
    # A numeric round address is a locator, not a natural-language classifier.
    # Keep every image of that exact authorized round if no slot is specified.
    rounds = {r['index']: r for r in [*history, current]}
    numbers = numeric_sources(current['prompt'])
    if numbers - rounds.keys():
        from backend.services.agent_repository import AgentError
        raise AgentError('reference_missing', '指定轮次不在当前授权分支中，请选择有效历史来源。', 400)
    numeric_rows = [r for r in history if r['index'] in numbers]
    chosen_ids = {r['id'] for r in rows} | {r['id'] for r in numeric_rows}
    assets = set(current.get('inputImageIds', []))
    assets.update(pending_candidate_assets(current, refs))
    implicit = set(current.get('taskImageIds', []))
    if task:
        required = set(editing.required_asset_ids(editing.execution_task(current)))
        implicit = required if task.get('taskType') == 'image_edit' else implicit & required
    assets.update(implicit)
    if reference:
        assets.update(reference[1])
    authorization = request.get('body', {}).get('authorization', {})
    native_generation = (request.get('frozen', {}).get('apiConfigMode') in {'native', 'off'}
                         and authorization.get('allowImageGeneration')
                         and request.get('usage', {}).get('imageJobsCreated', 0) < authorization.get('maxImageJobs', 0))
    if task and (task.get('taskType') not in {'prompt', 'prompt_optimization'} or native_generation):
        # A native image tool consumes this very Responses input. Attach the
        # current bound recipe pixels before granting that tool, even when its
        # preceding discussion was text-only. Hybrid execution binds the same
        # frozen inputs locally; ordinary prompt iteration remains pixel-free.
        assets.update(image['assetId'] for image in ([task['target']] if task.get('target') else []) + task.get('auxiliaries', []))
    for name in ('maskTargetImageId', 'maskImageId'):
        if current.get(name):
            assets.add(current[name])
    # Explicit selected history and incomplete state carry its actual visual
    # evidence. Complete prompt-only iteration does not carry old pixels merely
    # because its text supplements have historical sources.
    image_rows = [r for r in rows if (scope == 'selected' and r['id'] in selected_ids) or r['id'] in current.get('contextEvidenceRoundIds', [])
                  or r['id'] in visual_ids]
    if scope == 'task' and task and task.get('taskType') == 'chat':
        # Chat is not proof that every image ever seen in a long-lived task is
        # needed again. Keep the immediate exchange, explicit roles/locators and
        # visual/legacy evidence above. Older ambiguous sources can be read via
        # the existing authorized history tool before claiming visual details.
        recent = task_rows[-2:]
        image_rows.extend(recent)
        if any(editing.all_input_ids(r) or editing.all_output_ids(r) for r in recent):
            reason = reason or 'recent_visual_context'
    # Exact text additions stay in the model view without implicitly attaching
    # all pixels owned by those turns. Explicit image locators still bind.
    for row in rows:
        if row['id'] in dependent_ids - visual_ids:
            named_assets, _, numeric = exact_text_locators(row, refs, rounds)
            assets.update(named_assets)
            image_rows.extend(numeric)
    image_rows.extend(numeric_rows)
    source_refs, source_ids = set(), set()
    for r in image_rows:
        source_assets, named, closure_ids = visual_source_bindings(r, refs, rounds, task)
        assets.update(source_assets)
        source_refs.update(named)
        source_ids.update(closure_ids)
    assets.update(aid for ref, aid in refs.items() if aid and ref.startswith(f"round-{current['index']}-image-"))
    for ref, aid in refs.items():
        if aid in assets:
            match = re.match(r'round-(\d+)-', ref)
            if match:
                chosen_ids.update(r['id'] for r in history if r['index'] == int(match[1]))
    # Do not re-introduce unrelated historical text solely to label a selected
    # asset: it is attached in a separate binding message below by the builder.
    relevant = {r['id'] for r in rows} | {r['id'] for r in numeric_rows} | source_ids
    # Select bindings as well as assets. The same upload may appear in many
    # text-only evidence turns; retaining its current use must not encode every
    # old occurrence again. This does not merge different business identities
    # or enable the separate experimental same-pixel deduplication option.
    image_refs = {ref for row in image_rows for ref, aid in refs.items()
                  if aid and ref.startswith(f"round-{row['index']}-")}
    image_refs.update(source_refs)
    inputs = current.get('inputImageIds', [])
    required = set(editing.required_asset_ids(editing.execution_task(current)))
    for slot, aid in enumerate(editing.all_input_ids(current)):
        if slot < len(inputs) or aid in required and aid in assets:
            image_refs.add(f"round-{current['index']}-reference-{slot + 1}")
    image_refs.update(ref for ref, aid in refs.items() if aid and ref.startswith(f"round-{current['index']}-image-"))
    image_refs.update(match[1] for match in _REF_TAG.finditer(current['prompt']) if refs.get(match[1]))
    image_refs.update(f'round-{int(match[1])}-image-{int(match[2])}' for match in _ROUND_MENTION.finditer(current['prompt']))
    image_refs.update(f"round-{current['index']}-reference-{int(match[1])}" for match in _CURRENT_MENTION.finditer(current['prompt']))
    covered = {refs[ref] for ref in image_refs if refs.get(ref)}
    for aid in assets - covered:
        binding = next((ref for ref, value in reversed(list(refs.items())) if value == aid), None)
        if binding:
            image_refs.add(binding)
    return ContextScope([r for r in history if r['id'] in relevant], assets, scope, reason, image_refs)


def task_data(task, refs, *, visible_refs=None):
    """Only current versions and bounded effective state, not a hidden transcript."""
    if not task:
        return None
    from backend.services.agent_task_state import working_prompt_id
    working = working_prompt_id(task)
    ids = {task.get(key) for key in ('originalPromptVersionId', 'selectedPromptVersionId', 'executedPromptVersionId')} | {working}
    keys = ('schemaVersion', 'taskId', 'revision', 'branchRoundId', 'taskType', 'completeness',
            'latestUserAddition', 'unresolvedItems', 'historyDependencies')
    result = {key: task.get(key) for key in keys}
    result['promptVersions'] = [p for p in task.get('promptVersions', []) if p['id'] in ids]
    result['workingPromptVersionId'] = working
    if task.get('workingPromptSource'):
        result['workingPromptSource'] = task['workingPromptSource']
    # Source locators support undo without sending all previous candidate bodies.
    result['promptHistory'] = [{'id': p['id'], 'kind': p['kind'],
                                'source': {key: p['source'][key] for key in ('kind', 'roundId', 'messageId') if key in p['source']}}
                               for p in task.get('promptVersions', [])[-8:]]
    result['constraints'] = [c for c in task.get('constraints', []) if c['status'] != 'revoked']
    def binding(image):
        visible = next((ref for ref, aid in refs.items() if aid == image['assetId']
                        and (visible_refs is None or ref in visible_refs)), None)
        ref = visible or next((ref for ref, aid in refs.items() if aid == image['assetId']), None)
        return {'assetId': image['assetId'], 'ref': ref, 'pixelsAttached': visible is not None,
                **({'role': image['role']} if 'role' in image else {})}
    result['target'] = binding(task['target']) if task.get('target') else None
    result['auxiliaries'] = [binding(image) for image in task.get('auxiliaries', [])]
    return result
