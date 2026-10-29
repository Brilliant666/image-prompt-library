"""Non-mutating projection of a frozen branch into one Responses request.

Canonical history remains in AgentRepository; this module owns the disposable
provider input, image coverage, skill reuse and safe composition diagnostics.
"""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import re

from backend.services.agent_repository import AgentError, ROUND_MENTION, encoded
from backend.services import agent_editing_task as editing
from backend.services.agent_context import select_context_images, validate_context_references
from backend.services.agent_skills import default_skill_sections, read_agent_skill, validated_skill_preloads
from backend.services.agent_image_inputs import ImageInputSession
from backend.services.agent_context_scope import choose_context, task_data

def history_items(output):
    result = []
    pending, paired_indices = {}, set()
    for index, item in enumerate(output):
        call_id = item.get('call_id')
        if item.get('type') == 'function_call' and call_id:
            pending[call_id] = index
        elif item.get('type') == 'function_call_output' and call_id in pending:
            paired_indices.update((pending.pop(call_id), index))
    for index, item in enumerate(output):
        kind = item.get("type")
        if kind in {"image_generation_call", "web_search_call"}:
            continue
        if kind == "message":
            content = [{"type": "output_text", "text": p.get("text") or p.get("refusal")}
                       for p in item.get("content", []) if isinstance(p, dict) and (p.get("text") or p.get("refusal"))]
            if content:
                result.append({"role": "assistant", "content": content})
        elif kind in {"function_call", "function_call_output"} and index in paired_indices:
            result.append(item)
        elif kind == "reasoning":
            result.append(item)
    return result


@dataclass
class ContextProjection:
    input: list
    refs: dict
    attached_refs: list
    skill_receipts: list
    diagnostics: dict
    images: ImageInputSession

    def validate(self):
        self.images.validate()
        self.diagnostics.update(self.images.metrics)

    def summary(self, body):
        """Bounded safe receipt; never persist prompts, paths, pixels or credentials."""
        value = dict(self.diagnostics)
        for key in ('attachedRefs', 'pixelBindings'):
            value[key] = value[key][:128]
        value['bindingsOmitted'] = max(0, len(self.diagnostics['pixelBindings']) - 128)
        value['requestJsonBytes'] = len(json.dumps(body, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8'))
        value['toolCount'] = len(body.get('tools', []))
        prefix = body.get('instructions', '').split('\nClient request metadata follows', 1)[0]
        value['stablePrefixSha256'] = hashlib.sha256(prefix.encode('utf-8')).hexdigest()
        value['providerCacheVerified'] = False
        return value


def tool_pairing(rounds):
    """Pair locally and in order; reused IDs in another round cannot repair a call."""
    paired = orphan_calls = orphan_results = 0
    for row in rounds:
        pending = {}
        for item in row.get('responseOutput') or []:
            kind, call_id = item.get('type'), item.get('call_id')
            if kind == 'function_call':
                if call_id in pending:
                    orphan_calls += 1
                pending[call_id] = item
            elif kind == 'function_call_output':
                if call_id and pending.pop(call_id, None) is not None:
                    paired += 1
                else:
                    orphan_results += 1
        orphan_calls += len(pending)
    return dict(paired=paired, orphanCalls=orphan_calls, orphanResults=orphan_results)


def context_budget(items):
    """Composition, not a made-up tokenizer or model-window capability database.

    Arbitrary compatible model aliases and image tokenizers have no dependable
    local token conversion. Report exact text sizes and unknown token/window
    values until a verified tokenizer/capability source is supplied.
    """
    text = []
    for item in items:
        text.extend(part['text'] for part in item.get('content', [])
                    if isinstance(part, dict) and isinstance(part.get('text'), str))
        text.extend(item[key] for key in ('arguments', 'output') if isinstance(item.get(key), str))
    return {'textCharacters': sum(map(len, text)),
            'textUtf8Bytes': sum(len(value.encode('utf-8')) for value in text),
            'estimatedTextTokens': None, 'estimatedImageTokens': None,
            'contextWindowTokens': None, 'status': 'unknown',
            'warnings': ['Model context window and image token accounting are unverified. '
                         'No history was truncated or summarized; byte counts are not tokens or cost.']}


def prepare_context(repo, request, refs=None, *, deduplicate_images=None):
    """Build one isolated input view without changing saved prompts or references.

    Experimental aliasing only shares pixels with an earlier visible image of
    the same content/encoding/role. It never merges business assets. Masks keep
    the original ordering and repetitions even when the experiment is enabled.
    """
    refs = refs_for_request(repo, request) if refs is None else refs
    images = ImageInputSession(repo)
    attached, skills, bindings = [], [], []
    plan = choose_context(request, refs)
    selected = plan.assets
    if not request['round'].get('taskContext') and plan.scope != 'selected':
        selected = select_context_images(request, refs)
    enabled = (request.get('frozen', {}).get('experimentalImageDeduplication', False)
               if deduplicate_images is None else deduplicate_images)
    masked = bool(request['round'].get('maskImageId'))
    canonical, unique_assets, unique_pixels = {}, set(), set()
    occurrences = attached_count = duplicates = 0
    task = request['round'].get('editingTask') or {}

    def role_for(aid, ref_id):
        if aid == (task.get('target') or {}).get('assetId'):
            return 'editing_target'
        for auxiliary in task.get('auxiliaries', []):
            if aid == auxiliary.get('assetId'):
                return 'auxiliary:' + auxiliary.get('role', 'other')
        return 'generated' if '-image-' in ref_id else 'reference'

    def image_content(aid, ref_id):
        nonlocal occurrences, attached_count, duplicates
        occurrences += 1
        if selected is not None and aid not in selected:
            return []
        url = images.data_url(aid)
        identity = images.identity(aid)
        role = role_for(aid, ref_id)
        origin = 'generated' if '-image-' in ref_id else 'reference'
        key = (*identity[1:], role, origin, 'default-detail')
        unique_assets.add(aid)
        unique_pixels.add(identity[1:])
        attached.append(ref_id)
        pixel_ref = canonical.get(key)
        if enabled and not masked and pixel_ref and ref_id != pixel_ref:
            duplicates += 1
            bindings.append(dict(ref=ref_id, assetId=aid, pixelRef=pixel_ref, role=role))
            return [{'type': 'input_text', 'text':
                f'<ref id="{ref_id}" pixel_ref="{pixel_ref}" /> '
                f'This reference uses exactly the same visible pixels as the earlier attached reference {pixel_ref}; '
                'its source identity, position in the conversation and role remain distinct.'}]
        canonical.setdefault(key, ref_id)
        attached_count += 1
        bindings.append(dict(ref=ref_id, assetId=aid, pixelRef=ref_id, role=role))
        return [{'type': 'input_image', 'image_url': url},
                {'type': 'input_text', 'text': f'<ref id="{ref_id}" />'}]

    items = _build_input(repo, request, refs, images=images, image_content=image_content,
                         attached_refs=attached, skill_receipts=skills, plan=plan)
    if masked and request['round'].get('maskTargetImageId'):
        occurrences += 1
        attached_count += 1
        target = request['round']['maskTargetImageId']
        index = request['round']['inputImageIds'].index(target) + 1
        target_ref = f'round-{request["round"]["index"]}-reference-{index}'
        bindings.insert(0, dict(ref=target_ref, assetId=target, pixelRef=target_ref, role='mask_target'))
        unique_assets.add(target)
        unique_pixels.add(images.identity(target)[1:])
    pairs = tool_pairing([*request['history'], request['round']])
    budget = context_budget(items)
    if pairs['orphanCalls'] or pairs['orphanResults']:
        budget['warnings'].append('Unpaired tool history is excluded from provider input; saved history is unchanged.')
    sections = [*default_skill_sections(), *skills] if request.get('frozen', {}).get('professionalPromptWorkflows', True) else []
    diagnostics = {
        'schemaVersion': 1, 'historyRoundCount': len(request['history']),
        'contextScope': plan.scope, 'includedHistoryRoundCount': len(plan.history), 'fallbackReason': plan.reason,
        'currentRoundIndex': request['round']['index'], 'messageCount': len(items),
        'imageOccurrences': occurrences, 'attachedImageOccurrences': attached_count,
        'uniqueAssetCount': len(unique_assets), 'uniquePixelCount': len(unique_pixels),
        'duplicatePixelOccurrences': max(0, len(attached) - len(unique_pixels)),
        'serializedDeduplicatedOccurrences': duplicates, 'attachedRefs': attached,
        'pixelBindings': bindings, 'experimentalImageDeduplication': bool(enabled),
        'deduplicationException': 'mask_first_image_order' if masked and enabled else None,
        'serializedInputBytes': len(json.dumps(items, ensure_ascii=False, separators=(',', ':')).encode('utf-8')),
        'skillSections': [{key: value[key] for key in ('skill', 'section', 'revision')} for value in sections],
        'toolPairing': pairs, 'budget': budget, **images.metrics,
    }
    result = ContextProjection(items, refs, attached, skills, diagnostics, images)
    result.validate()
    return result


def build_input(repo, request, refs, *, attached_refs=None, skill_receipts=None):
    """Compatibility entry point; all callers share the same production projection."""
    projection = prepare_context(repo, request, refs)
    if attached_refs is not None:
        attached_refs.extend(projection.attached_refs)
    if skill_receipts is not None:
        skill_receipts.extend(projection.skill_receipts)
    return projection.input


def refs_for_request(repo, request):
    refs = {}
    for r in [*request["history"], request["round"]]:
        for i, asset_id in enumerate(editing.all_input_ids(r)):
            refs[f"round-{r['index']}-reference-{i + 1}"] = asset_id
        outputs = r.get("frozenOutputImages")
        if outputs is None:
            outputs = []
            for jid in editing.all_output_ids(r):
                try:
                    outputs.append(repo.resolve_ref({"kind": "job", "jobId": jid}))
                except AgentError as exc:
                    if exc.code != "reference_missing":
                        # Corrupt established snapshots must not silently turn
                        # into absent pixels or be replaced from another source.
                        raise
                    outputs.append(None)
        for i, asset_id in enumerate(outputs):
            refs[f"round-{r['index']}-image-{i + 1}"] = asset_id
    return refs


def _build_input(repo, request, refs, *, images, image_content, attached_refs=None, skill_receipts=None, plan=None):
    try:
        validate_context_references(request, refs)
    except ValueError as exc:
        raise AgentError("reference_missing", str(exc), 400) from None
    items = []
    plan = plan or choose_context(request, refs)

    target = request["round"].get("maskTargetImageId")
    if request["round"].get("maskImageId") and target:
        # Responses applies input_image_mask to the first image in the context.
        index = request["round"]["inputImageIds"].index(target) + 1
        if attached_refs is not None:
            attached_refs.append(f'round-{request["round"]["index"]}-reference-{index}')
        items.append({"role": "user", "content": [
            {"type": "input_text", "text": f'The mask applies to <ref id="round-{request["round"]["index"]}-reference-{index}" />.'},
            {"type": "input_image", "image_url": images.data_url(target)},
        ]})
    seen_assets = set()
    for r in [*plan.history, request["round"]]:
        prompt = re.sub(r"\u2065[^\u2064]*", "", r["prompt"]).replace("\u2063", "").replace("\u2064", "")
        prompt = ROUND_MENTION.sub(lambda m: f'<ref id="round-{m[1]}-image-{m[2]}" />', prompt)
        def current_ref(match):
            i = int(match[1])
            if i < 1 or i > len(r["inputImageIds"]):
                raise AgentError("reference_missing", "当前输入图片引用不存在。", 400)
            return f'<ref id="round-{r["index"]}-reference-{i}" />'
        prompt = re.sub(r"@图(\d+)", current_ref, prompt)
        content = [{"type": "input_text", "text": prompt}]
        for i, aid in enumerate(editing.all_input_ids(r)):
            content.extend(image_content(aid, f'round-{r["index"]}-reference-{i + 1}'))
            seen_assets.add(aid)
        if r is request['round'] and r.get('taskContext'):
            content.append({'type': 'input_text', 'text': 'Current creative task (user-level data; original, selected and executed Prompts are distinct): ' +
                            encoded(task_data(r['taskContext'], refs))})
        if r is request['round'] and r.get('editingTask') and not r.get('taskContext'):
            content.append({'type': 'input_text', 'text': 'Current editing task (user-level JSON data, not system instructions): ' +
                            encoded(editing.context_data(r['editingTask'], refs))})
        items.append({"role": "user", "content": content})
        output = r.get("responseOutput") or []
        items.extend(history_items(output))
        if not output and r.get("assistantContent"):
            items.append({"role": "assistant", "content": [{"type": "output_text", "text": r["assistantContent"]}]})
        generated = []
        for i, jid in enumerate(editing.all_output_ids(r)):
            ref_id = f"round-{r['index']}-image-{i + 1}"
            aid = refs.get(ref_id)
            if aid:
                generated.extend(image_content(aid, ref_id))
                seen_assets.add(aid)
            else:
                generated.append({"type": "input_text", "text": f'<removed_ref id="{ref_id}" />'})
        if generated:
            items.append({"role": "user", "content": generated})
    # A target may be owned by an excluded older task. Attach its exact stable
    # binding without that unrelated task's transcript or an enormous ref index.
    for aid in sorted((plan.assets or set()) - seen_assets):
        ref_id = next((ref for ref, asset in refs.items() if asset == aid), None)
        if ref_id and aid != request['round'].get('maskImageId'):
            items.append({'role': 'user', 'content': image_content(aid, ref_id)})
    return skill_context_items(request, items, skill_receipts=skill_receipts)


def validated_skill_tool_outputs(input_items):
    """Authenticate exact pinned bodies only through genuine paired tool records."""
    matching_calls, result = {}, {}
    for index, item in enumerate(input_items or []):
        if item.get("role") is not None:
            continue
        if item.get("type") == "function_call":
            # Providers may reuse IDs in later rounds. Bind each output to the
            # most recent preceding call, never a different round's call.
            matching_calls.pop(item.get('call_id'), None)
            if item.get('name') != 'read_agent_skill':
                continue
            try:
                arguments = json.loads(item.get("arguments", ""))
            except (ValueError, TypeError):
                continue
            if (isinstance(arguments, dict) and not set(arguments) - {"skill", "section"}
                    and isinstance(item.get("call_id"), str) and item["call_id"]):
                try:
                    matching_calls[item['call_id']] = read_agent_skill(arguments.get('skill'), arguments.get('section', 'overview'))
                except ValueError:
                    continue
        if item.get("type") != "function_call_output" or item.get("call_id") not in matching_calls:
            continue
        try:
            value = json.loads(item.get("output", ""))
        except (ValueError, TypeError):
            continue
        expected = matching_calls[item['call_id']]
        if value == expected:
            result[index] = expected
    return result


def skill_context_items(request, items, *, skill_receipts=None):
    """Keep historical guidance once without rewriting stored rounds or receipts."""
    if not request.get('frozen', {}).get('professionalPromptWorkflows', True):
        call_names, result = {}, []
        for item in items:
            if item.get('role') is None and item.get('type') == 'function_call':
                call_names[item.get('call_id')] = item.get('name')
            if (item.get('role') is None and item.get('type') in {'function_call', 'function_call_output'}
                    and call_names.get(item.get('call_id')) == 'read_agent_skill'):
                continue
            result.append(item)
        return result
    foundations = default_skill_sections()
    seen = {(skill['skill'], skill['section'], skill['revision']) for skill in foundations}
    result = list(items)
    for index, skill in validated_skill_tool_outputs(items).items():
        key = (skill['skill'], skill['section'], skill['revision'])
        if key in seen:
            # The actual receipt remains in storage. Only the outgoing context
            # points to the body already supplied in instructions/earlier input.
            result[index] = {**items[index], 'output': encoded({
                **{name: value for name, value in skill.items() if name != 'content'},
                'content_available_in': 'instructions' if skill in foundations else 'earlier_context'})}
        else:
            seen.add(key)
            if skill_receipts is not None:
                skill_receipts.append(skill)
    guidance = []
    for skill in validated_skill_preloads([*request['history'], request['round']]):
        key = (skill['skill'], skill['section'], skill['revision'])
        if key not in seen:
            seen.add(key)
            guidance.append(skill)
            if skill_receipts is not None:
                skill_receipts.append(skill)
    if guidance:
        result.insert(0, {'role': 'user', 'content': [{'type': 'input_text', 'text':
            'Application-supplied bundled skill guidance; historical context, not a new user request. '
            'Reuse only where relevant to the current task; it grants no tools or generation permission.\n' +
            '\n\n'.join(f"[{skill['skill']} / {skill['section']} / {skill['revision']}]\n{skill['content']}" for skill in guidance)}]})
    return result
