"""Unresolved task evidence on the real serializer and mock Responses wire."""
import copy
import json

import pytest

from backend.db import connect
from backend.services.agent_context_pipeline import prepare_context
from backend.services.agent_repository import AgentError, encoded
from test_agent_context_correctness import add_round, asset, capture_request, pixels
from test_agent_image_selection import repo


def save_projection(repo, identity, request):
    with connect(repo.library) as conn:
        conn.execute('UPDATE agent_rounds SET data=? WHERE request_id=?', (encoded(request['round']), identity))
        conn.execute('UPDATE agent_requests SET history=? WHERE id=?', (encoded(request['history']), identity))


def long_task(repo, count=24):
    parent, old_assets = None, []
    for index in range(count):
        aid = asset(repo, f'#{index + 1:06x}')
        old_assets.append(aid)
        parent = add_round(repo, f'old-{index}', f'Exact historical requirement {index}.', parent=parent, assets=[aid])
    current_assets = [asset(repo, color) for color in ('orange', 'cyan')]
    add_round(repo, 'current', 'Compare the two current geometric references.', parent=parent, assets=current_assets)
    request = repo.request('current')
    current = request['round']
    current['taskContext'].update(taskType='image_edit', completeness='history_required',
        unresolvedItems=['已添加新的编辑对象；旧图与约束是否继续适用尚需确认。'],
        target={'assetId': old_assets[-1], 'source': {'kind': 'upload', 'uploadId': old_assets[-1]}}, auxiliaries=[],
        historyDependencies=[{'roundId': row['id'], 'reason': 'unreconciled_user_addition'} for row in request['history']]
            + [{'roundId': parent, 'reason': 'target_changed_requires_prior_evidence'}])
    current['editingTask'] = None
    current['taskImageIds'] = []
    save_projection(repo, 'current', request)
    return request, old_assets, current_assets


def text(body):
    return '\n'.join(part.get('text', '') for item in body['input'] for part in item.get('content', []))


def pending_candidates(repo):
    unrelated, first, second = [asset(repo, color) for color in ('purple', 'red', 'blue')]
    older = add_round(repo, 'unrelated-before-candidates', 'Earlier unrelated picture.', assets=[unrelated])
    source = add_round(repo, 'pending-candidate-source', '帮她修改衣服，保留姿势', parent=older, assets=[first, second])
    add_round(repo, 'pending-candidate-choice', '就改第二张，第一张只参考光线', parent=source)
    request = repo.request('pending-candidate-choice')
    assert request['round']['editingTask']['needsTargetSelection']
    assert {image['assetId'] for image in request['round']['editingTask']['candidates']} == {first, second}
    return request, unrelated, (first, second)


def test_pending_selection_attaches_exact_candidates_without_unrelated_history(repo):
    request, unrelated, candidates = pending_candidates(repo)
    original = copy.deepcopy(request)
    projection = prepare_context(repo, request)
    assert set(pixels({'input': projection.input})) == {repo.data_url(aid) for aid in candidates}
    assert repo.data_url(unrelated) not in json.dumps(projection.input)
    assert request == original


@pytest.mark.parametrize('missing', ['absent', 'sibling', 'file'])
def test_pending_selection_missing_candidate_cannot_be_ignored_or_substituted(repo, missing):
    request, _, candidates = pending_candidates(repo)
    if missing == 'file':
        (repo.library / repo.asset(candidates[1])['path']).unlink()
    else:
        aid = 'missing-candidate'
        if missing == 'sibling':
            aid = asset(repo, 'green')
            add_round(repo, 'sibling-candidate', 'Sibling-only candidate.', assets=[aid])
        request['round']['editingTask']['candidates'][1]['assetId'] = aid
    with pytest.raises(AgentError) as failure:
        prepare_context(repo, request)
    assert failure.value.code in {'reference_missing', 'frozen_reference_invalid'}


def test_resolved_selection_does_not_reactivate_stale_candidate_list(repo):
    request, unrelated, candidates = pending_candidates(repo)
    target = {'assetId': candidates[0], 'source': json.loads(repo.asset(candidates[0])['source'])}
    request['round']['editingTask'].update(target=target, needsTargetSelection=False,
        candidates=[{'assetId': unrelated}, {'assetId': 'obsolete-missing-candidate'}])
    request['round']['taskContext'].update(target=target, auxiliaries=[], unresolvedItems=[])
    projection = prepare_context(repo, request)
    assert set(pixels({'input': projection.input})) == {repo.data_url(candidates[0])}
    assert repo.data_url(unrelated) not in json.dumps(projection.input)


def test_unresolved_24_turn_task_does_not_promote_all_text_evidence_to_image_uploads(repo, monkeypatch):
    request, older, current = long_task(repo)
    frozen = copy.deepcopy(request['history'])
    sent = capture_request(repo, monkeypatch, 'current')
    expected = {repo.data_url(aid) for aid in [older[-1], *current]}
    assert set(pixels(sent)) == expected
    assert len(pixels(sent)) <= 4, 'one unresolved flag must not send all 24 historical pictures'
    for index in range(24):
        assert f'Exact historical requirement {index}.' in text(sent), 'original requirements must not be truncated'
    assert repo.request('current')['history'] == frozen
    assert repo.request('current')['round']['taskContext'] == request['round']['taskContext']
    assert repo.jobs.list_jobs().jobs == []


@pytest.mark.parametrize('source_kind', ['target_changed_requires_prior_evidence', 'legacy_requirements_in_history', 'unknown_visual_dependency', 'history_tool'])
def test_exact_visual_source_includes_inherited_target_auxiliary_and_explicit_locator(repo, monkeypatch, source_kind):
    target, light, named, unrelated, current = [asset(repo, color) for color in ('red', 'blue', 'yellow', 'purple', 'cyan')]
    first = add_round(repo, 'source', 'Initial reference pixels.', assets=[target, light, named])
    middle = add_round(repo, 'bound', 'Keep <ref id="round-1-reference-3" /> as composition evidence.', parent=first)
    tail = add_round(repo, 'unrelated', 'Unrelated historical picture.', parent=middle, assets=[unrelated])
    add_round(repo, 'current', 'Use the bound lighting evidence on the current reference.', parent=tail, assets=[current])
    request = repo.request('current')
    bound = request['history'][1]
    bound.update(inputImageIds=[], taskImageIds=[], editingTask=None)
    bound['taskContext'].update(target={'assetId': target}, auxiliaries=[{'assetId': light, 'role': 'lighting'}])
    state = request['round']['taskContext']
    state.update(target={'assetId': current}, auxiliaries=[], unresolvedItems=['Lighting remains unresolved.'],
                 historyDependencies=[] if source_kind == 'history_tool' else [{'roundId': middle, 'reason': source_kind}])
    request['round'].update(editingTask=None, taskImageIds=[], contextEvidenceRoundIds=[middle] if source_kind == 'history_tool' else [])
    save_projection(repo, 'current', request)
    sent = capture_request(repo, monkeypatch, 'current')
    assert set(pixels(sent)) == {repo.data_url(aid) for aid in (target, light, named, current)}
    assert repo.data_url(unrelated) not in json.dumps(sent)
    assert middle in text(sent), 'the exact historical source locator remains visible'


def test_unknown_unresolved_source_preserves_text_and_recovers_only_requested_ancestor_pixels(repo):
    request, older, current = long_task(repo, count=5)
    request['round']['taskContext'].update(target=None, taskType='prompt_optimization',
        historyDependencies=[{'roundId': row['id'], 'reason': 'unreconciled_user_addition'} for row in request['history']],
        unresolvedItems=['Which older composition should be preserved?'])
    before = copy.deepcopy(request)
    initial = prepare_context(repo, request)
    assert set(pixels({'input': initial.input})) == {repo.data_url(aid) for aid in current}
    assert 'Which older composition should be preserved?' in text({'input': initial.input})
    assert '"hasOmittedPixels":true' in text({'input': initial.input})
    request['round']['contextEvidenceRoundIds'] = [request['history'][1]['id']]
    recovered = prepare_context(repo, request)
    assert set(pixels({'input': recovered.input})) == {repo.data_url(aid) for aid in [older[1], *current]}
    assert request['history'] == before['history']
    assert request['round']['taskContext'] == before['round']['taskContext']


def test_visual_dependency_cannot_replace_missing_or_other_branch_bound_asset(repo):
    request, _, _ = long_task(repo, count=3)
    source = request['history'][-1]
    source.update(taskImageIds=[], editingTask=None)
    source['taskContext'].update(target={'assetId': 'not-in-this-branch'}, auxiliaries=[])
    with pytest.raises(AgentError, match='引用|分支|图片'):
        prepare_context(repo, request)


def test_selected_history_does_not_promote_unselected_text_only_dependency(repo):
    request, older, current = long_task(repo, count=3)
    row = request['round']
    row.update(contextScope='selected', historyRoundIds=[request['history'][0]['id']])
    row['taskContext'].update(taskType='prompt_optimization', target=None,
        historyDependencies=[{'roundId': request['history'][-1]['id'], 'reason': 'unreconciled_user_addition'}])
    projection = prepare_context(repo, request)
    assert set(pixels({'input': projection.input})) == {repo.data_url(aid) for aid in [older[0], *current]}
    assert 'Exact historical requirement 2.' in text({'input': projection.input})


def test_unresolved_current_task_retains_exact_visual_dependency_from_older_task(repo):
    request, older, current = long_task(repo, count=3)
    source = request['history'][0]
    source['taskContext']['taskId'] = 'different-completed-task'
    row = request['round']
    row['taskContext'].update(target=None, taskType='prompt_optimization',
        historyDependencies=[{'roundId': source['id'], 'reason': 'compare_original_pixel_lighting'}])
    projection = prepare_context(repo, request)
    assert set(pixels({'input': projection.input})) == {repo.data_url(aid) for aid in [older[0], *current]}
    assert source['id'] in text({'input': projection.input})


def test_required_visual_source_closes_numeric_history_locator_without_expanding_exact_slot(repo):
    request, older, current = long_task(repo, count=4)
    source = request['history'][2]
    source['prompt'] = 'Use 第 1 轮 for the lighting of the bound image.'
    request['round']['taskContext'].update(target=None, taskType='prompt_optimization',
        historyDependencies=[{'roundId': source['id'], 'reason': 'compare_original_pixel_lighting'}])
    projection = prepare_context(repo, request)
    assert set(pixels({'input': projection.input})) == {repo.data_url(aid) for aid in [older[0], older[2], *current]}
    source['prompt'] = '<ref id="round-1-reference-1" />'
    source['taskContext'].update(target=None, auxiliaries=[])
    source.update(inputImageIds=[], taskImageIds=[], editingTask=None)
    projection = prepare_context(repo, request)
    assert set(pixels({'input': projection.input})) == {repo.data_url(aid) for aid in [older[0], *current]}


def test_exact_generated_image_locator_with_prose_does_not_expand_its_whole_round(repo):
    request, older, current = long_task(repo, count=3)
    source = request['history'][0]
    source.update(frozenOutputImages=[older[1]], outputTaskIds=['synthetic-result-slot'])
    request['round'].update(prompt='Compare @第1轮图1 with the current references.')
    request['round']['taskContext'].update(target=None, taskType='prompt_optimization',
        historyDependencies=[{'roundId': row['id'], 'reason': 'unreconciled_user_addition'} for row in request['history']])
    projection = prepare_context(repo, request)
    assert set(pixels({'input': projection.input})) == {repo.data_url(aid) for aid in [older[1], *current]}
    assert repo.data_url(older[0]) not in json.dumps(projection.input)


def test_visual_source_numeric_self_reference_is_bounded_and_missing_round_fails(repo):
    request, _, _ = long_task(repo, count=3)
    source = request['history'][-1]
    source['prompt'] = f'Keep 第{source["index"]}轮 as its own visible evidence.'
    assert prepare_context(repo, request).input
    source['prompt'] = 'Keep 第99轮 as visual evidence.'
    with pytest.raises(AgentError, match='历史来源|轮次'):
        prepare_context(repo, request)


def test_text_dependency_numeric_locator_keeps_only_the_named_visual_source(repo):
    request, older, current = long_task(repo, count=4)
    addition = request['history'][2]
    addition['prompt'] = 'Preserve the lighting from 第 1 轮 while improving the wording.'
    state = request['round']['taskContext']
    state.update(taskType='prompt_optimization', target=None, auxiliaries=[], unresolvedItems=[],
                 historyDependencies=[{'roundId': addition['id'], 'reason': 'unreconciled_user_addition'}])
    original = copy.deepcopy(request)
    projection = prepare_context(repo, request)
    assert set(pixels({'input': projection.input})) == {repo.data_url(aid) for aid in [older[0], *current]}
    assert repo.data_url(older[2]) not in json.dumps(projection.input), 'the text source itself does not become a visual source'
    assert addition['prompt'] in text({'input': projection.input})
    assert request['history'][0]['prompt'] in text({'input': projection.input})
    assert request == original


@pytest.mark.parametrize('number', [3, 99])
def test_text_dependency_numeric_locator_rejects_future_or_missing_source(repo, number):
    request, _, _ = long_task(repo, count=4)
    addition = request['history'][1]
    addition['prompt'] = f'Preserve the lighting from 第 {number} 轮.'
    request['round']['taskContext'].update(taskType='prompt_optimization', target=None, auxiliaries=[], unresolvedItems=[],
        historyDependencies=[{'roundId': addition['id'], 'reason': 'unreconciled_user_addition'}])
    with pytest.raises(AgentError, match='历史来源|图片轮次') as failure:
        prepare_context(repo, request)
    assert failure.value.code == 'reference_missing'


def test_text_dependency_missing_exact_historical_image_ref_fails_before_model_input(repo):
    request, _, _ = long_task(repo, count=4)
    removed, addition = request['history'][0], request['history'][2]
    removed.update(outputTaskIds=['removed-historical-result'], frozenOutputImages=[None])
    addition['prompt'] = 'Keep the exact lighting from <ref id="round-1-image-1" />.'
    request['round']['taskContext'].update(taskType='prompt_optimization', target=None, auxiliaries=[], unresolvedItems=[],
        historyDependencies=[{'roundId': addition['id'], 'reason': 'unreconciled_user_addition'}])
    original = copy.deepcopy(request)
    with pytest.raises(AgentError, match='历史来源|图片引用') as failure:
        prepare_context(repo, request)
    assert failure.value.code == 'reference_missing'
    assert request == original


@pytest.mark.parametrize('locator', ['ref', 'numeric', 'current', 'generated'])
def test_nested_text_source_keeps_its_words_and_only_explicit_visual_locators(repo, locator):
    request, older, current = long_task(repo, count=6)
    evidence, text_source, visual_source = request['history'][0], request['history'][2], request['history'][4]
    prompts = {'ref': '<ref id="round-1-reference-1" />', 'numeric': '第 1 轮',
               'current': '@图1', 'generated': '@第1轮图1'}
    if locator == 'generated':
        evidence.update(inputImageIds=[], taskImageIds=[], outputTaskIds=['older-image-result'], frozenOutputImages=[older[0]])
    if locator == 'current':
        text_source.update(inputImageIds=[older[0], older[2]])
    text_source['prompt'] = f'  Keep only the lighting from {prompts[locator]}.\nPreserve this exact source wording.  '
    text_source['taskContext'].update(target={'assetId': older[1]}, auxiliaries=[], historyDependencies=[
        {'roundId': request['history'][1]['id'], 'reason': 'unknown_visual_dependency'}])
    visual_source.update(prompt='Continue the previously discussed lighting.', inputImageIds=[], taskImageIds=[], editingTask=None)
    visual_source['taskContext'].update(target=None, auxiliaries=[], historyDependencies=[
        {'roundId': text_source['id'], 'reason': 'unreconciled_user_addition'}])
    request['round'].update(contextEvidenceRoundIds=[visual_source['id']])
    request['round']['taskContext'].update(taskId='independent-current-task', taskType='prompt_optimization',
                                         target=None, auxiliaries=[], unresolvedItems=[], historyDependencies=[])
    original = copy.deepcopy(request)
    projection = prepare_context(repo, request)
    sent = {'input': projection.input}
    assert set(pixels(sent)) == {repo.data_url(aid) for aid in [older[0], *current]}
    assert len(pixels(sent)) == 3
    assert repo.data_url(older[1]) not in json.dumps(projection.input), 'the text source roles and task graph stay text-only'
    assert repo.data_url(older[2]) not in json.dumps(projection.input), 'unmentioned text-source attachments are not promoted'
    assert 'Preserve this exact source wording.  ' in text(sent)
    assert text_source['id'] in text(sent)
    assert request == original


@pytest.mark.parametrize('missing', ['reference', 'source', 'future', 'sibling'])
def test_nested_text_source_missing_or_other_branch_evidence_is_rejected(repo, missing):
    request, _, _ = long_task(repo, count=6)
    text_source, visual_source = request['history'][2], request['history'][4]
    text_source['prompt'] = 'Use <ref id="round-1-image-99" /> as lighting evidence.' if missing == 'reference' else 'Use 第1轮 for lighting.'
    source_id = text_source['id']
    if missing == 'source':
        source_id = 'missing-text-source'
    elif missing == 'future':
        source_id = request['round']['id']
    elif missing == 'sibling':
        source_id = add_round(repo, 'sibling-text-source', 'Use 第1轮 for lighting.', parent=request['history'][0]['id'])
    visual_source.update(inputImageIds=[], taskImageIds=[], editingTask=None)
    visual_source['taskContext'].update(target=None, auxiliaries=[], historyDependencies=[
        {'roundId': source_id, 'reason': 'unreconciled_user_addition'}])
    request['round'].update(contextEvidenceRoundIds=[visual_source['id']])
    request['round']['taskContext'].update(taskId='independent-current-task', taskType='prompt_optimization',
                                         target=None, auxiliaries=[], unresolvedItems=[], historyDependencies=[])
    with pytest.raises(AgentError) as failure:
        prepare_context(repo, request)
    assert failure.value.code == 'reference_missing'


def test_nested_text_aliases_of_one_asset_do_not_reupload_each_text_source_occurrence(repo):
    request, older, current = long_task(repo, count=6)
    first_text, second_text, visual_source = request['history'][2], request['history'][3], request['history'][4]
    for source in (first_text, second_text):
        source.update(prompt='Keep the lighting of @图1.', inputImageIds=[older[0], older[2]], taskImageIds=[], editingTask=None)
        source['taskContext'].update(target={'assetId': older[1]}, auxiliaries=[])
    visual_source.update(inputImageIds=[], taskImageIds=[], editingTask=None)
    visual_source['taskContext'].update(target=None, auxiliaries=[], historyDependencies=[
        {'roundId': source['id'], 'reason': 'unreconciled_user_addition'} for source in (first_text, second_text)])
    request['round'].update(contextEvidenceRoundIds=[visual_source['id']])
    request['round']['taskContext'].update(taskId='independent-current-task', taskType='prompt_optimization',
                                         target=None, auxiliaries=[], unresolvedItems=[], historyDependencies=[])
    projection = prepare_context(repo, request)
    assert len(pixels({'input': projection.input})) == 3
    assert set(pixels({'input': projection.input})) == {repo.data_url(aid) for aid in [older[0], *current]}
    assert first_text['id'] in text({'input': projection.input}) and second_text['id'] in text({'input': projection.input})
    assert not projection.diagnostics['experimentalImageDeduplication']
    assert projection.diagnostics['serializedDeduplicatedOccurrences'] == 0


@pytest.mark.parametrize('reason', ['unknown_visual_dependency', 'legacy_requirements_in_history'])
def test_selected_same_task_historical_sources_keep_each_frozen_explicit_visual_dependency(repo, reason):
    request, older, current = long_task(repo, count=6)
    evidence, earlier, later = request['history'][0], request['history'][2], request['history'][4]
    for source in (earlier, later):
        source.update(inputImageIds=[], taskImageIds=[], editingTask=None)
        source['taskContext'].update(target=None, auxiliaries=[], historyDependencies=[])
    earlier['taskContext']['historyDependencies'] = [{'roundId': evidence['id'], 'reason': reason}]
    request['round'].update(contextScope='selected', historyRoundIds=[earlier['id'], later['id']])
    request['round']['taskContext'].update(taskType='prompt_optimization', target=None, auxiliaries=[],
                                         unresolvedItems=[], historyDependencies=[])
    original = copy.deepcopy(request)
    projection = prepare_context(repo, request)
    assert set(pixels({'input': projection.input})) == {repo.data_url(aid) for aid in [older[0], *current]}
    assert evidence['prompt'] in text({'input': projection.input})
    assert earlier['prompt'] in text({'input': projection.input})
    assert later['prompt'] in text({'input': projection.input})
    assert request == original


@pytest.mark.parametrize('source_kind', ['legacy_requirements_in_history', 'unknown_visual_dependency'])
def test_visual_source_closes_its_frozen_visual_dependencies_across_tasks(repo, source_kind):
    request, older, current = long_task(repo, count=5)
    obsolete, evidence, text_only, source = request['history'][:4]
    # This source discusses a prior image without owning pixels or naming a
    # locator in prose. Its frozen structured dependency is the exact evidence.
    source.update(prompt='Continue the established lighting comparison.', inputImageIds=[], taskImageIds=[], editingTask=None)
    source['taskContext'].update(taskId='older-visual-task', target=None, auxiliaries=[], historyDependencies=[
        {'roundId': evidence['id'], 'reason': source_kind},
        {'roundId': text_only['id'], 'reason': 'unreconciled_user_addition'},
        {'roundId': source['id'], 'reason': source_kind}])
    # An older snapshot must not resurrect automatic role-change bookkeeping
    # which the selected later source has already coordinated.
    evidence['taskContext'].update(taskId='older-visual-task', historyDependencies=[
        {'roundId': obsolete['id'], 'reason': 'target_changed_requires_prior_evidence'}])
    state = request['round']['taskContext']
    state.update(taskType='prompt_optimization', target=None, auxiliaries=[], unresolvedItems=[],
                 historyDependencies=[{'roundId': source['id'], 'reason': 'compare_original_pixel_lighting'}])
    original = copy.deepcopy(request)
    projection = prepare_context(repo, request)
    assert set(pixels({'input': projection.input})) == {repo.data_url(aid) for aid in [older[1], *current]}
    assert evidence['prompt'] in text({'input': projection.input})
    assert repo.data_url(older[2]) not in json.dumps(projection.input), 'a nested text-only dependency must not promote its picture'
    assert repo.data_url(older[0]) not in json.dumps(projection.input), 'only coordinated automatic role-change evidence is superseded'
    assert request == original


@pytest.mark.parametrize('source_id', ['missing-source', 'current-round', 'later-ancestor', 'sibling'])
def test_visual_source_dependency_rejects_missing_future_and_other_branch_sources(repo, source_id):
    request, _, _ = long_task(repo, count=4)
    source = request['history'][1]
    forbidden = {'current-round': request['round']['id'], 'later-ancestor': request['history'][2]['id']}.get(source_id, source_id)
    if source_id == 'sibling':
        forbidden = add_round(repo, 'sibling-only-source', 'A source outside the frozen request branch.',
                              parent=request['history'][0]['id'], assets=[asset(repo, 'purple')])
    source['taskContext'].update(taskId='older-visual-task',
        historyDependencies=[{'roundId': forbidden, 'reason': 'unknown_visual_dependency'}])
    request['round']['taskContext'].update(taskType='prompt_optimization', target=None, auxiliaries=[], unresolvedItems=[],
        historyDependencies=[{'roundId': source['id'], 'reason': 'compare_original_pixel_lighting'}])
    with pytest.raises(AgentError, match='历史来源|分支|图片|轮次') as failure:
        prepare_context(repo, request)
    assert failure.value.code == 'reference_missing'


@pytest.mark.parametrize('reason', ['target_changed_requires_prior_evidence', 'unknown_visual_dependency', 'legacy_requirements_in_history'])
def test_transitive_source_supersedes_only_automatic_roles_independent_of_dependency_order(repo, reason):
    request, older, current = long_task(repo, count=6)
    obsolete, evidence, earlier, later, source = request['history'][:5]
    for row in (earlier, later, source):
        row.update(inputImageIds=[], taskImageIds=[], editingTask=None)
        row['taskContext'].update(target=None, auxiliaries=[])
    earlier['taskContext'].update(taskId='nested-visual-task', historyDependencies=[
        {'roundId': obsolete['id'], 'reason': reason}])
    later['taskContext'].update(taskId='nested-visual-task', historyDependencies=[
        {'roundId': evidence['id'], 'reason': reason}])
    source['taskContext'].update(taskId='selected-source-task', historyDependencies=[
        {'roundId': later['id'], 'reason': 'unknown_visual_dependency'},
        {'roundId': earlier['id'], 'reason': 'unknown_visual_dependency'}])
    request['round']['taskContext'].update(taskType='prompt_optimization', target=None, auxiliaries=[], unresolvedItems=[],
        historyDependencies=[{'roundId': source['id'], 'reason': 'unknown_visual_dependency'}])
    original = copy.deepcopy(request)
    projection = prepare_context(repo, request)
    expected = [older[1], *current]
    if reason != 'target_changed_requires_prior_evidence':
        expected.append(older[0])
    assert set(pixels({'input': projection.input})) == {repo.data_url(aid) for aid in expected}
    assert request == original


@pytest.mark.parametrize('reason', ['compare_original_pixel_lighting', 'target_changed_requires_prior_evidence'])
def test_same_task_legacy_current_state_without_dependency_graph_uses_frozen_source_evidence(repo, reason):
    request, older, current = long_task(repo, count=5)
    evidence, source = request['history'][0], request['history'][3]
    source.update(inputImageIds=[], taskImageIds=[], editingTask=None)
    source['taskContext'].update(target=None, auxiliaries=[], historyDependencies=[
        {'roundId': evidence['id'], 'reason': reason}])
    request['round'].update(contextEvidenceRoundIds=[source['id']])
    state = request['round']['taskContext']
    state.update(taskType='prompt_optimization', target=None, auxiliaries=[], unresolvedItems=[])
    state.pop('historyDependencies')
    original = copy.deepcopy(request)
    projection = prepare_context(repo, request)
    assert set(pixels({'input': projection.input})) == {repo.data_url(aid) for aid in [older[0], *current]}
    assert request == original


@pytest.mark.parametrize('count', [5, 25, 50, 100, 200])
def test_unresolved_text_growth_does_not_increase_visual_uploads(repo, count):
    request, older, current = long_task(repo, count=3)
    template = request['history'][0]
    history = []
    for index in range(count):
        row = copy.deepcopy(template)
        row.update(id=f'historical-{index}', index=index + 1,
                   prompt=f'Exact accumulated requirement {index}.', editingTask=None,
                   taskImageIds=[], inputImageIds=[older[2] if index == count - 1 else older[0]])
        row['taskContext'].update(target={'assetId': older[2]}, auxiliaries=[])
        history.append(row)
    request.update(history=history)
    row = request['round']
    row.update(index=count + 1)
    row['taskContext']['historyDependencies'] = [
        {'roundId': item['id'], 'reason': 'unreconciled_user_addition'} for item in history
    ] + [{'roundId': history[-1]['id'], 'reason': 'target_changed_requires_prior_evidence'}]
    original = copy.deepcopy(request)
    projection = prepare_context(repo, request)
    assert len(pixels({'input': projection.input})) == 3
    assert set(pixels({'input': projection.input})) == {repo.data_url(aid) for aid in [older[2], *current]}
    assert projection.diagnostics['imageReads'] == projection.diagnostics['imageEncodings'] == 3
    assert projection.diagnostics['includedHistoryRoundCount'] == count
    assert not projection.diagnostics['experimentalImageDeduplication']
    assert projection.diagnostics['serializedDeduplicatedOccurrences'] == 0
    for index in range(count):
        assert f'Exact accumulated requirement {index}.' in text({'input': projection.input})
    assert request == original
    print(json.dumps({'rounds': count, 'attached_images': 3,
                      'input_bytes': projection.diagnostics['serializedInputBytes'],
                      'image_reads': projection.diagnostics['imageReads'], 'real_model_posts': 0}))
