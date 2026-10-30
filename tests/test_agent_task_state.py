"""Current task state is durable, bounded and protected by branch/revision CAS."""
import json

import pytest

from backend.agent_schemas import AgentConversationPatch, AgentTaskContextPatch
from backend.db import connect
from backend.services.agent_repository import AgentError, AgentRepository
from test_agent_image_selection import repo, body
from test_agent_editing_task import turn, done, upload


def test_new_round_has_task_state_and_later_addition_is_structured(repo):
    first = turn(repo, 'first', '请整理一段图片提示词')
    state = first['round']['taskContext']
    assert state['taskId'] and state['revision'] == 1
    assert state['promptVersions'][0]['text'] == '请整理一段图片提示词'
    done(repo, 'first')
    second = turn(repo, 'second', '保持自然光线', parent=first['round']['id'])
    following = second['round']['taskContext']
    assert following['taskId'] == state['taskId']
    assert following['latestUserAddition']['text'] == '保持自然光线'
    assert following['revision'] > state['revision']
    assert len(following['promptVersions']) == 1


def test_ordinary_single_attachment_edit_keeps_prior_state_until_explicit_new_task(repo):
    red = upload(repo, 'red')
    first = turn(repo, 'first', '只把红色衣服改蓝色', [{'kind': 'upload', 'uploadId': red}])
    done(repo, 'first')
    blue = upload(repo, 'blue')
    second = turn(repo, 'second', '帮她更换袜子', [{'kind': 'upload', 'uploadId': blue}], first['round']['id'])
    state = second['round']['taskContext']
    assert state['target']['assetId'] == blue
    assert state['taskId'] == first['round']['taskContext']['taskId']
    assert '红色衣服' in json.dumps(state, ensure_ascii=False)
    assert {'roundId': first['round']['id'], 'reason': 'target_changed_requires_prior_evidence'} in state['historyDependencies']
    assert state['unresolvedItems']
    model = repo.update_task_context('second', state_arguments(second, [
        {'op': 'set_history_dependencies', 'dependencies': []}]), {})
    assert model['historyDependencies'] == state['historyDependencies']
    done(repo, 'second')
    fresh = turn(repo, 'fresh', '与前面的图无关，帮她修改袜子',
                 [{'kind': 'upload', 'uploadId': blue}], second['round']['id'])['round']['taskContext']
    assert fresh['taskId'] != state['taskId']
    assert '红色衣服' not in json.dumps(fresh, ensure_ascii=False)
    assert not fresh['historyDependencies']


def test_old_round_stays_explicit_legacy_without_reconstruction(repo):
    first = turn(repo, 'first', 'Old conversation')
    done(repo, 'first')
    old = dict(first['round'])
    old.pop('taskContext', None)
    with connect(repo.library) as conn:
        conn.execute('UPDATE agent_rounds SET data=? WHERE id=?', (json.dumps(old), old['id']))
    restored = AgentRepository(repo.library).snapshot('conversation')
    assert restored['taskContext'] is None
    assert restored['contextMode'] == 'legacy'


def test_round_rejects_task_revision_that_changed(repo):
    first = turn(repo, 'first', 'Original task')
    done(repo, 'first')
    request = body(repo, 'second').model_copy(update={
        'parentRoundId': first['round']['id'], 'taskRevision': first['round']['taskContext']['revision'] + 1})
    with pytest.raises(AgentError) as error:
        repo.create_round('conversation', request)
    assert error.value.code == 'task_revision_conflict'


def patch_context(repo, operations, branch=None, revision=None, task_revision=None):
    snapshot = repo.snapshot('conversation')
    if branch is None:
        branch = snapshot['conversation']['activeRoundId']
    state = next((row.get('taskContext') for row in snapshot['conversation']['rounds'] if row['id'] == branch), None)
    # A user draft can be newer than the immutable round's state.
    if snapshot['conversation']['activeRoundId'] == branch:
        state = snapshot['taskContext']
    return repo.patch_task_context('conversation', AgentTaskContextPatch.model_validate({
        'expectedRevision': snapshot['revision'] if revision is None else revision,
        'branchRoundId': branch, 'taskRevision': (state or {}).get('revision') if task_revision is None else task_revision,
        'operations': operations}))


def state_arguments(request, operations):
    state = request['round']['taskContext']
    return {'taskId': state['taskId'], 'taskRevision': state['revision'],
            'branchRoundId': request['round_id'], 'operations': operations}


def test_constraint_add_update_revoke_preserves_sources_and_original_round(repo):
    first = turn(repo, 'first', 'Original task')
    done(repo, 'first')
    saved = patch_context(repo, [{'op': 'add_constraint', 'text': 'Keep white socks'}])
    constraint = saved['taskContext']['constraints'][0]
    assert constraint['status'] == 'active' and constraint['source']['kind'] == 'user'
    updated = patch_context(repo, [{'op': 'update_constraint', 'id': constraint['id'], 'text': 'Use black socks'}])
    assert updated['taskContext']['constraints'][0]['text'] == 'Use black socks'
    revoked = patch_context(repo, [{'op': 'revoke_constraint', 'id': constraint['id']}])
    assert revoked['taskContext']['constraints'][0]['status'] == 'revoked'
    assert repo.request('first')['round']['taskContext']['constraints'] == []


def test_model_proposal_is_not_selection_and_actual_execution_is_separate(repo):
    first = turn(repo, 'first', 'Original user wording')
    result = repo.update_task_context('first', state_arguments(first, [
        {'op': 'set_prompt', 'text': 'Model candidate', 'kind': 'candidate'},
        {'op': 'add_constraint', 'text': 'Model suggestion'}]), {})
    assert result['selectedPromptVersionId'] is None
    assert result['constraints'][0]['status'] == 'proposed'
    executed = repo.record_task_execution('first', 'Exact tool prompt')
    assert executed['selectedPromptVersionId'] is None
    assert next(p for p in executed['promptVersions'] if p['id'] == executed['executedPromptVersionId'])['text'] == 'Exact tool prompt'
    assert next(p for p in executed['promptVersions'] if p['id'] == executed['originalPromptVersionId'])['text'] == 'Original user wording'
    current = repo.request('first')
    before = current['round']['taskContext']
    with pytest.raises(AgentError):
        repo.update_task_context('first', state_arguments(current, [{'op': 'select_prompt', 'id': result['promptVersions'][-1]['id']}]), {})
    assert repo.request('first')['round']['taskContext'] == before


def test_model_active_constraint_change_requires_current_user_quote(repo):
    first = turn(repo, 'first', 'Keep white socks')
    done(repo, 'first')
    saved = patch_context(repo, [{'op': 'add_constraint', 'text': 'White socks'}])
    constraint = saved['taskContext']['constraints'][0]
    second = turn(repo, 'second', 'Change the white socks to black socks', parent=first['round']['id'])
    for quote in (None, 'A quote from a different turn'):
        operation = {'op': 'update_constraint', 'id': constraint['id'], 'text': 'Black socks'}
        if quote:
            operation['sourceQuote'] = quote
        with pytest.raises(AgentError):
            repo.update_task_context('second', state_arguments(second, [operation]), {})
        assert repo.request('second')['round']['taskContext']['constraints'][0]['text'] == 'White socks'
    changed = repo.update_task_context('second', state_arguments(second, [{
        'op': 'update_constraint', 'id': constraint['id'], 'text': 'Black socks',
        'sourceQuote': 'white socks to black socks'}]), {})
    assert changed['constraints'][0]['status'] == 'active'
    assert changed['constraints'][0]['source']['authority'] == 'user_instruction'
    assert changed['constraints'][0]['source']['interpretedBy'] == 'model'


def test_model_stale_revision_and_late_branch_cannot_override(repo):
    first = turn(repo, 'first', 'Original task')
    arguments = state_arguments(first, [{'op': 'set_task_type', 'taskType': 'prompt'}])
    changed = repo.update_task_context('first', arguments, {})
    with pytest.raises(AgentError) as stale:
        repo.update_task_context('first', arguments, {})
    assert stale.value.code == 'task_revision_conflict'
    snapshot = repo.snapshot('conversation')
    repo.patch_conversation('conversation', AgentConversationPatch(expectedRevision=snapshot['revision'], activeRoundId=None))
    current = repo.request('first')
    with pytest.raises(AgentError) as late:
        repo.update_task_context('first', state_arguments(current, [{'op': 'set_task_type', 'taskType': 'chat'}]), {})
    assert late.value.code == 'task_branch_conflict'
    assert repo.request('first')['round']['taskContext'] == changed


def test_user_prompt_source_is_verbatim_and_restore_does_not_overwrite_original(repo):
    first = turn(repo, 'first', 'Original user text')
    repo.update('first', text='Explanation\n```prompt\nExact model Prompt\n```', state='completed', outcome='known')
    selected = patch_context(repo, [{'op': 'set_prompt', 'text': 'Exact model Prompt', 'kind': 'selected',
        'source': {'kind': 'model', 'roundId': first['round']['id'], 'messageId': first['round']['assistantMessageId']}}])
    state = selected['taskContext']
    candidate = state['promptVersions'][-1]
    assert candidate['source']['kind'] == 'model' and candidate['confirmedBy'] == 'user'
    assert state['selectedPromptVersionId'] == candidate['id']
    restored = patch_context(repo, [{'op': 'restore_prompt', 'id': state['originalPromptVersionId']}])['taskContext']
    assert next(p for p in restored['promptVersions'] if p['id'] == restored['selectedPromptVersionId'])['text'] == 'Original user text'
    before = repo.snapshot('conversation')
    with pytest.raises(AgentError) as invalid:
        patch_context(repo, [{'op': 'set_prompt', 'text': 'Changed model Prompt', 'kind': 'selected',
            'source': {'kind': 'model', 'roundId': first['round']['id']}}])
    assert invalid.value.code == 'invalid_task_source'
    assert repo.snapshot('conversation') == before


def test_explicit_target_survives_preserved_attachment_and_new_task_clears_it(repo):
    red, blue = upload(repo, 'red'), upload(repo, 'blue')
    first = turn(repo, 'first', 'Edit clothes', [{'kind': 'upload', 'uploadId': red}, {'kind': 'upload', 'uploadId': blue}])
    done(repo, 'first')
    chosen = patch_context(repo, [{'op': 'set_target', 'ref': {'kind': 'upload', 'uploadId': red}}])['taskContext']
    second = turn(repo, 'second', 'More natural', [{'kind': 'upload', 'uploadId': blue}], first['round']['id'])
    assert second['round']['taskContext']['target']['assetId'] == red
    assert second['round']['editingTask']['target']['assetId'] == red
    assert second['round']['taskContext']['unresolvedItems']
    done(repo, 'second')
    new = patch_context(repo, [{'op': 'new_task', 'text': 'Fresh prompt task', 'taskType': 'prompt'}])
    assert new['taskContext']['taskId'] != chosen['taskId']
    assert new['taskContext']['target'] is None and new['editingTask'] is None


def test_user_and_model_cross_branch_upload_and_history_scope_are_rejected(repo):
    red, blue = upload(repo, 'red'), upload(repo, 'blue')
    first = turn(repo, 'first', 'Edit clothes', [{'kind': 'upload', 'uploadId': red}])
    done(repo, 'first')
    sibling = turn(repo, 'sibling', 'Edit another image', [{'kind': 'upload', 'uploadId': blue}])
    done(repo, 'sibling')
    with pytest.raises(AgentError) as wrong:
        patch_context(repo, [{'op': 'set_target', 'ref': {'kind': 'upload', 'uploadId': blue}}], branch=first['round']['id'])
    assert wrong.value.code == 'invalid_reference'
    current = turn(repo, 'current', 'Change clothes', parent=first['round']['id'])
    with pytest.raises(AgentError):
        repo.update_task_context('current', state_arguments(current, [{
            'op': 'set_target', 'ref': {'kind': 'upload', 'uploadId': blue}}]), {'allowed': red})
    done(repo, 'current')
    value = body(repo, 'scope').model_copy(update={'parentRoundId': first['round']['id'],
        'contextScope': 'selected', 'historyRoundIds': [sibling['round']['id']]})
    with pytest.raises(AgentError) as scope:
        repo.create_round('conversation', value)
    assert scope.value.code == 'invalid_context_scope'


def test_overflow_requirements_keep_explicit_historical_evidence(repo):
    first = turn(repo, 'first', 'Edit clothes ' + 'important detail ' * 400,
                 [{'kind': 'upload', 'uploadId': upload(repo, 'red')}])
    done(repo, 'first')
    second = turn(repo, 'second', 'Retain every earlier detail', parent=first['round']['id'])
    state = second['round']['taskContext']
    assert second['round']['editingTask']['requirementsInHistory']
    assert {'roundId': first['round']['id'], 'reason': 'legacy_requirements_in_history'} in state['historyDependencies']
    assert state['completeness'] == 'history_required'
    model = repo.update_task_context('second', state_arguments(second, [
        {'op': 'set_history_dependencies', 'dependencies': []}]), {})
    assert model['historyDependencies'] == state['historyDependencies']


def test_task_context_http_patch_is_local_and_backup_round_trip(repo, monkeypatch, tmp_path):
    from fastapi.testclient import TestClient
    from backend.main import create_app
    from backend.services.library_archives import backup_library, restore_library
    monkeypatch.setattr('backend.routers.agent.schedule_request', lambda *a: pytest.fail('task edit dispatched a model'))
    client = TestClient(create_app(repo.library))
    response = client.patch('/api/agent/conversations/conversation/task-context', json={
        'expectedRevision': repo.snapshot('conversation')['revision'], 'branchRoundId': None, 'taskRevision': None,
        'operations': [{'op': 'new_task', 'text': '  Preserve exact\n text  ', 'taskType': 'prompt'}]})
    assert response.status_code == 200, response.text
    saved = response.json()['taskContext']
    assert saved['promptVersions'][0]['text'] == '  Preserve exact\n text  '
    assert response.json()['conversation']['rounds'] == []
    archive = backup_library(repo.library, tmp_path / 'task-context.tar.gz')
    destination = tmp_path / 'restored'
    restore_library(archive, destination, confirm=True)
    assert AgentRepository(destination).snapshot('conversation')['taskContext'] == saved


def test_explicit_new_task_target_and_auxiliary_survive_boundary_message(repo):
    red, blue = upload(repo, 'red'), upload(repo, 'blue')
    first = turn(repo, 'first', 'Edit clothes ' + 'old requirements ' * 400,
                 [{'kind': 'upload', 'uploadId': red}, {'kind': 'upload', 'uploadId': blue}])
    done(repo, 'first')
    selected = patch_context(repo, [
        {'op': 'new_task', 'text': 'New exact requirements', 'taskType': 'image_edit'},
        {'op': 'set_target', 'ref': {'kind': 'upload', 'uploadId': blue}},
        {'op': 'set_auxiliaries', 'auxiliaries': [{'ref': {'kind': 'upload', 'uploadId': red}, 'role': 'lighting'}]}])
    assert 'old requirements' not in selected['editingTask']['requirements']
    second = turn(repo, 'second', '与前面的图无关，帮她修改袜子', parent=first['round']['id'])
    state = second['round']['taskContext']
    assert state['taskId'] == selected['taskContext']['taskId']
    assert state['target']['assetId'] == blue and state['auxiliaries'][0]['assetId'] == red
    assert second['round']['editingTask']['requirements'] == 'New exact requirements'
    assert not state['historyDependencies']


def test_continuing_result_preserves_task_id_and_confirmed_constraints(repo):
    from backend.services import agent_execution as execution
    from test_agent_workspaces import image_bytes
    red = upload(repo, 'red')
    first = turn(repo, 'first', 'Edit clothes', [{'kind': 'upload', 'uploadId': red}])
    done(repo, 'first')
    selected = patch_context(repo, [{'op': 'add_constraint', 'text': 'Preserve pose'}])['taskContext']
    second = turn(repo, 'second', 'Green clothes', parent=first['round']['id'])
    result = execution.create_image_job(repo, 'second', 1, 'call', 'one', 'Exact green edit',
                                        execution.refs_for_request(repo, second))
    repo.jobs.stage_result(result.id, image_bytes('green'), 'green.png')
    done(repo, 'second')
    third = turn(repo, 'third', '继续修改上一张生成结果', parent=second['round']['id'])
    assert third['round']['taskContext']['taskId'] == selected['taskId']
    assert third['round']['taskContext']['constraints'] == selected['constraints']
    assert third['round']['taskContext']['target']['source'] == {'kind': 'job', 'jobId': result.id}


def test_legacy_followup_stays_explicit_history_fallback(repo):
    first = turn(repo, 'first', 'Old long context')
    done(repo, 'first')
    old = dict(first['round'])
    old.pop('taskContext')
    with connect(repo.library) as conn:
        conn.execute('UPDATE agent_rounds SET data=? WHERE id=?', (json.dumps(old), old['id']))
    second = turn(repo, 'second', 'Continue that instruction', parent=first['round']['id'])
    assert second['round']['taskContext']['completeness'] == 'history_required'
    assert second['round']['taskContext']['historyDependencies'] == [
        {'roundId': first['round']['id'], 'reason': 'legacy_context_missing'}]


def test_full_user_source_quote_reconciles_addition_without_losing_original(repo):
    first = turn(repo, 'first', 'Original task')
    done(repo, 'first')
    second = turn(repo, 'second', 'Keep natural lighting', parent=first['round']['id'])
    changed = repo.update_task_context('second', state_arguments(second, [{
        'op': 'add_constraint', 'text': 'Natural lighting', 'sourceQuote': 'Keep natural lighting'}]), {})
    assert changed['latestUserAddition']['reconciled']
    assert changed['constraints'][0]['source']['quote'] == 'Keep natural lighting'
    done(repo, 'second')
    third = turn(repo, 'third', 'Make the background simpler', parent=second['round']['id'])
    assert third['round']['taskContext']['historyDependencies'] == []


def test_prompt_window_is_bounded_and_archived_version_remains_exactly_restorable(repo):
    first = turn(repo, 'first', 'Original wording')
    done(repo, 'first')
    first_candidate = patch_context(repo, [{'op': 'set_prompt', 'text': '  exact old\n candidate  ', 'kind': 'candidate'}])['taskContext']['promptVersions'][-1]
    for index in range(28):
        patch_context(repo, [{'op': 'set_prompt', 'text': f'Candidate {index}', 'kind': 'candidate'}])
    snapshot = repo.snapshot('conversation')
    assert len(snapshot['taskContext']['promptVersions']) <= 24
    assert first_candidate['id'] not in {p['id'] for p in snapshot['taskContext']['promptVersions']}
    assert '_taskPromptArchive' not in json.dumps(snapshot)
    second = turn(repo, 'second', 'Continue this task', parent=first['round']['id'])
    done(repo, 'second')
    restored = patch_context(repo, [{'op': 'restore_prompt', 'id': first_candidate['id']}])['taskContext']
    assert len(restored['promptVersions']) <= 24
    assert next(p for p in restored['promptVersions'] if p['id'] == restored['selectedPromptVersionId'])['text'] == '  exact old\n candidate  '


def test_executed_prompt_window_is_bounded_and_duplicate_receipt_is_idempotent(repo):
    first = turn(repo, 'first', 'Original wording')
    for index in range(30):
        state = repo.record_task_execution('first', f'Exact execution {index}')
    assert len(state['promptVersions']) <= 24
    again = repo.record_task_execution('first', 'Exact execution 29')
    assert again == state
    assert '_taskPromptArchive' not in json.dumps(repo.snapshot('conversation'))
    done(repo, 'first')
    with connect(repo.library) as conn:
        old = json.loads(conn.execute('SELECT data FROM agent_rounds WHERE id=?', (first['round']['id'],)).fetchone()[0])
    old_version = next(p for p in old['_taskPromptArchive'].values() if p['text'] == 'Exact execution 0')
    restored = patch_context(repo, [{'op': 'restore_prompt', 'id': old_version['id']}])['taskContext']
    assert next(p for p in restored['promptVersions'] if p['id'] == restored['selectedPromptVersionId'])['text'] == 'Exact execution 0'


def test_reverse_single_upload_binds_object_without_manual_target_selection(repo):
    image = upload(repo, 'red')
    request = turn(repo, 'reverse', '反推这张图', [{'kind': 'upload', 'uploadId': image}])
    state = request['round']['taskContext']
    assert state['target']['assetId'] == image
    assert state['unresolvedItems'] == []
    assert state['selectedPromptVersionId'] is None
    assert not request['round']['editingTask']['needsTargetSelection']


def test_model_candidate_is_working_version_without_user_confirmation(repo):
    first = turn(repo, 'first', '反推中文提示词')
    result = repo.update_task_context('first', state_arguments(first, [
        {'op': 'set_task_type', 'taskType': 'reverse'},
        {'op': 'set_prompt', 'text': '  候选原文\n保留空白  ', 'kind': 'candidate'}]), {})
    assert result['workingPromptVersionId'] == result['promptVersions'][-1]['id']
    assert result['selectedPromptVersionId'] is None
    assert result['promptVersions'][-1]['confirmedBy'] is None
    done(repo, 'first')
    second = turn(repo, 'second', '改成英文', parent=first['round_id'])
    assert second['round']['taskContext']['workingPromptVersionId'] == result['workingPromptVersionId']
    assert second['body']['authorization'] == first['body']['authorization']


def test_natural_undo_restores_working_version_only_with_source_quote(repo):
    first = turn(repo, 'first', '请生成一份候选提示词')
    first_state = repo.update_task_context('first', state_arguments(first, [
        {'op': 'set_prompt', 'text': '  First candidate\nexact original  ', 'kind': 'candidate'}]), {})
    old_id = first_state['workingPromptVersionId']
    done(repo, 'first')
    second = turn(repo, 'second', '光线柔和一点，其他保持', parent=first['round_id'])
    second_state = repo.update_task_context('second', state_arguments(second, [
        {'op': 'set_prompt', 'text': 'Second candidate with softer lighting', 'kind': 'candidate'}]), {})
    done(repo, 'second')
    third = turn(repo, 'third', '撤销刚才的修改', parent=second['round_id'])
    before = repo.request('third')['round']['taskContext']
    for quote in (None, '撤销'):
        operation = {'op': 'restore_working_prompt', 'id': old_id}
        if quote is not None:
            operation['sourceQuote'] = quote
        with pytest.raises(AgentError):
            repo.update_task_context('third', state_arguments(third, [operation]), {})
        assert repo.request('third')['round']['taskContext'] == before
    result = repo.update_task_context('third', state_arguments(third, [
        {'op': 'restore_working_prompt', 'id': old_id, 'sourceQuote': '撤销刚才的修改'}]), {})
    assert result['workingPromptVersionId'] == old_id
    assert result['selectedPromptVersionId'] is None
    restored = next(p for p in result['promptVersions'] if p['id'] == old_id)
    assert restored['text'] == '  First candidate\nexact original  '
    assert restored['confirmedBy'] is None
    assert result['workingPromptSource']['restoredFrom'] == old_id
    assert result['workingPromptSource']['quote'] == '撤销刚才的修改'
    assert second_state['workingPromptVersionId'] != old_id


def test_working_prompt_is_pinned_in_bounded_window_and_undo_rejects_sibling_version(repo):
    first = turn(repo, 'first', 'Candidate task')
    state = repo.update_task_context('first', state_arguments(first, [
        {'op': 'set_prompt', 'text': 'Keep exact candidate', 'kind': 'candidate'}]), {})
    working = state['workingPromptVersionId']
    for index in range(28):
        repo.record_task_execution('first', f'Execution {index}')
    current = repo.request('first')['round']['taskContext']
    assert len(current['promptVersions']) <= 24
    assert next(p for p in current['promptVersions'] if p['id'] == working)['text'] == 'Keep exact candidate'
    done(repo, 'first')
    left = turn(repo, 'left', 'Left candidate', parent=first['round_id'])
    left_state = repo.update_task_context('left', state_arguments(left, [
        {'op': 'set_prompt', 'text': 'Private sibling candidate', 'kind': 'candidate'}]), {})
    done(repo, 'left')
    right = turn(repo, 'right', '撤销刚才的修改', parent=first['round_id'])
    with pytest.raises(AgentError):
        repo.update_task_context('right', state_arguments(right, [
            {'op': 'restore_working_prompt', 'id': left_state['workingPromptVersionId'],
             'sourceQuote': '撤销刚才的修改'}]), {})
    assert repo.request('right')['round']['taskContext']['workingPromptVersionId'] == working
