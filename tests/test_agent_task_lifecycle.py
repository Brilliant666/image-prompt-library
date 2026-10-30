"""Source-backed task lifecycle updates preserve frozen history and user authority."""
import copy
import hashlib

import pytest

from backend.agent_schemas import AgentConversationPatch
from backend.db import connect
from backend.services import agent_editing_task as editing
from backend.services.agent_context_pipeline import refs_for_request
from backend.services.agent_protocol import task_update_schema, tools_for
from backend.services.agent_repository import AgentError, encoded
from test_agent_image_selection import repo
from test_agent_editing_task import turn, done, upload
from test_agent_task_state import state_arguments


def continued_task(repo, latest='生成一张撸猫的图'):
    first = turn(repo, 'first', 'Original unrelated composition')
    done(repo, 'first')
    exact = '  Preserve the small amber triangle.\nUse a quiet background.  '
    second = turn(repo, 'second', exact, parent=first['round']['id'])
    done(repo, 'second')
    third = turn(repo, 'third', latest, parent=second['round']['id'])
    return first, second, third, exact


def test_same_response_start_task_is_exact_and_preserves_frozen_history_and_authorization(repo):
    first, second, third, _ = continued_task(repo)
    before = copy.deepcopy(repo.request('third'))
    old_rounds = [copy.deepcopy(repo.request(identity)['round']) for identity in ('first', 'second')]
    old = before['round']['taskContext']
    assert old['historyDependencies']
    updated = repo.update_task_context('third', state_arguments(third, [{
        'op': 'start_task', 'taskType': 'image_generation', 'sourceQuote': third['round']['prompt']}]), {})
    current = repo.request('third')
    assert updated['taskId'] != old['taskId'] and updated['revision'] == old['revision'] + 1
    assert updated['taskType'] == 'image_generation'
    assert updated['promptVersions'][0]['text'] == third['round']['prompt']
    assert not updated['historyDependencies'] and not updated['constraints']
    assert updated['selectedPromptVersionId'] is None and updated['executedPromptVersionId'] is None
    assert current['history'] == before['history']
    assert current['body'] == before['body'] and current['frozen'] == before['frozen']
    assert current['round']['_taskInputState'] == before['round']['_taskInputState']
    assert [repo.request(identity)['round'] for identity in ('first', 'second')] == old_rounds
    assert current['round']['taskContext']['_taskBoundary']['previousTaskId'] == old['taskId']
    public = repo.snapshot('conversation')
    assert '_taskBoundary' not in public['taskContext']
    assert all('_taskBoundary' not in (r.get('taskContext') or {}) for r in public['conversation']['rounds'])
    with pytest.raises(AgentError) as error:
        repo.update_task_context('third', state_arguments(third, [{'op': 'set_task_type', 'taskType': 'chat'}]), {})
    assert error.value.code == 'task_revision_conflict'


def test_clearing_stale_image_selection_preserves_the_new_generation_task_type(repo):
    _, _, third, _ = continued_task(repo)
    updated = repo.update_task_context('third', state_arguments(third, [{
        'op': 'start_task', 'taskType': 'image_generation', 'sourceQuote': third['round']['prompt']}]), {})
    repo.select_request_references('third', {'targetRef': None, 'auxiliaries': []}, {})
    current = repo.request('third')['round']['taskContext']
    assert current['taskId'] == updated['taskId']
    assert current['taskType'] == 'image_generation'
    assert current['target'] is None and not current['historyDependencies']


@pytest.mark.parametrize('operations', [
    [{'op': 'start_task', 'taskType': 'image_generation', 'sourceQuote': '撸猫'}],
    [{'op': 'start_task', 'taskType': 'image_generation', 'sourceQuote': '生成一张撸猫的图', 'text': 'Invented replacement'}],
    [{'op': 'set_prompt', 'text': 'Candidate'},
     {'op': 'start_task', 'taskType': 'image_generation', 'sourceQuote': '生成一张撸猫的图'}],
    [{'op': 'new_task', 'text': 'Invented model task'}],
])
def test_start_task_rejects_partial_quotes_rewording_late_start_and_user_only_op(repo, operations):
    _, _, third, _ = continued_task(repo)
    before = copy.deepcopy(repo.request('third')['round'])
    with pytest.raises(AgentError) as error:
        repo.update_task_context('third', state_arguments(third, operations), {})
    assert error.value.code == 'invalid_task_context'
    assert repo.request('third')['round'] == before


def test_text_reconciliation_is_per_exact_source_and_does_not_confirm_candidate(repo):
    _, second, third, exact = continued_task(repo, 'Now make the background quieter.')
    before = copy.deepcopy(repo.request('third'))
    source_id = second['round']['id']
    current_id = third['round']['id']
    candidate = exact + '\nNow make the background quieter.'
    updated = repo.update_task_context('third', state_arguments(third, [
        {'op': 'set_prompt', 'text': candidate},
        {'op': 'reconcile_text_source', 'roundId': source_id, 'sourceQuote': exact},
        {'op': 'reconcile_text_source', 'roundId': current_id, 'sourceQuote': third['round']['prompt']},
    ]), {})
    assert not updated['historyDependencies']
    assert updated['latestUserAddition']['reconciled']
    assert not updated['constraints'] and updated['selectedPromptVersionId'] is None
    working = next(p for p in updated['promptVersions'] if p['id'] == updated['workingPromptVersionId'])
    assert working['kind'] == 'candidate' and working['confirmedBy'] is None
    saved = repo.request('third')
    assert saved['history'] == before['history']
    receipt = saved['round']['taskContext']['_textReconciliations'][source_id]
    assert receipt['promptVersionId'] == working['id']
    assert receipt['sourceSha256'] == hashlib.sha256(exact.encode('utf-8')).hexdigest()
    assert '_textReconciliations' not in updated
    public = repo.snapshot('conversation')
    assert '_textReconciliations' not in public['taskContext']
    assert all('_textReconciliations' not in (r.get('taskContext') or {}) for r in public['conversation']['rounds'])
    done(repo, 'third')
    fourth = turn(repo, 'fourth', 'Continue the current candidate.', parent=current_id)
    assert not fourth['round']['taskContext']['historyDependencies']


@pytest.mark.parametrize('source_id, quote, with_candidate', [
    ('not-in-authorized-history', 'Missing source', True),
    ('second', 'Preserve the small amber triangle.', True),
    ('second', 'EXACT', False),
])
def test_reconciliation_rejects_missing_partial_sources_and_unrecorded_candidates(repo, source_id, quote, with_candidate):
    _, second, third, exact = continued_task(repo)
    before = copy.deepcopy(repo.request('third')['round'])
    operations = ([{'op': 'set_prompt', 'text': exact}] if with_candidate else [])
    operations.append({'op': 'reconcile_text_source',
        'roundId': second['round']['id'] if source_id == 'second' else source_id,
        'sourceQuote': exact if quote == 'EXACT' else quote})
    with pytest.raises(AgentError) as error:
        repo.update_task_context('third', state_arguments(third, operations), {})
    assert error.value.code == 'invalid_task_context'
    assert repo.request('third')['round'] == before


def test_old_projection_text_can_coordinate_without_dropping_visual_legacy_or_unknown_evidence(repo):
    _, second, third, exact = continued_task(repo)
    before = copy.deepcopy(repo.request('third'))
    row = copy.deepcopy(before['round'])
    source_id = second['round']['id']
    reasons = ['legacy_requirements_in_history', 'legacy_context_missing', 'compare_original_pixel_lighting']
    row['taskContext']['historyDependencies'].extend({'roundId': source_id, 'reason': reason} for reason in reasons)
    row['taskContext'].pop('_textReconciliations', None)  # Existing projection, no migration.
    with connect(repo.library) as conn:
        conn.execute('UPDATE agent_rounds SET data=? WHERE id=?', (encoded(row), row['id']))
    updated = repo.update_task_context('third', state_arguments(third, [
        {'op': 'set_prompt', 'text': exact},
        {'op': 'reconcile_text_source', 'roundId': source_id, 'sourceQuote': exact},
    ]), {})
    assert {d['reason'] for d in updated['historyDependencies']} == set(reasons)
    assert updated['completeness'] == 'history_required'
    assert repo.request('third')['history'] == before['history']


def test_candidate_or_execution_alone_does_not_coordinate_text_dependencies(repo):
    _, second, third, exact = continued_task(repo)
    expected = copy.deepcopy(third['round']['taskContext']['historyDependencies'])
    updated = repo.update_task_context('third', state_arguments(third, [{'op': 'set_prompt', 'text': exact}]), {})
    assert updated['historyDependencies'] == expected
    repo.record_task_execution('third', 'A successful submitted image prompt')
    current = repo.request('third')['round']['taskContext']
    assert current['historyDependencies'] == expected
    assert not current['latestUserAddition'].get('reconciled')
    assert current['selectedPromptVersionId'] is None


def test_start_task_preserves_existing_archive_and_rejects_late_or_other_branch_updates(repo):
    first, second, third, _ = continued_task(repo)
    row = copy.deepcopy(repo.request('third')['round'])
    archive = {'prompt_old_unique': {'id': 'prompt_old_unique', 'text': 'Unique retained old candidate',
        'kind': 'candidate', 'confirmedBy': None, 'source': {'kind': 'model', 'roundId': second['round']['id']}}}
    row['_taskPromptArchive'] = copy.deepcopy(archive)
    with connect(repo.library) as conn:
        conn.execute('UPDATE agent_rounds SET data=? WHERE id=?', (encoded(row), row['id']))
    repo.update_task_context('third', state_arguments(third, [{
        'op': 'start_task', 'taskType': 'image_generation', 'sourceQuote': third['round']['prompt']}]), {})
    assert repo.request('third')['round']['_taskPromptArchive'] == archive
    done(repo, 'third')
    later = turn(repo, 'later', 'A later branch.', parent=third['round']['id'])
    with pytest.raises(AgentError) as error:
        repo.update_task_context('first', state_arguments(first, [{'op': 'set_task_type', 'taskType': 'prompt'}]), {})
    assert error.value.code in {'stopped', 'task_branch_conflict'}
    assert repo.request('later')['round']['taskContext']['taskId'] == later['round']['taskContext']['taskId']


def test_advertised_state_and_inline_image_contract_share_lifecycle_operations(repo):
    _, _, third, _ = continued_task(repo)
    schema = task_update_schema()
    fields = schema['properties']['operations']['items']['properties']
    assert {'start_task', 'reconcile_text_source'} <= set(fields['op']['enum'])
    assert 'roundId' in fields and 'new_task' not in fields['op']['enum']
    tools = {tool['name']: tool for tool in tools_for(repo.request('third')) if tool['type'] == 'function'}
    assert tools['update_task_context']['parameters'] == schema
    for name in ('generate_image', 'generate_image_batch'):
        assert tools[name]['parameters']['properties']['taskContextUpdate']['properties'] == schema['properties']


def inline_update(third, *, step=1, call_id='generate-one', reference_selection=None):
    update = state_arguments(third, [{
        'op': 'start_task', 'taskType': 'image_generation', 'sourceQuote': third['round']['prompt']}])
    complete_arguments = {'images': [{'id': 'one', 'prompt': 'Synthetic cat image'}],
        'referenceSelection': reference_selection if reference_selection is not None else {'targetRef': None, 'auxiliaries': []},
        'taskContextUpdate': update, 'finish_after_generation': True}
    receipt = {'step': step, 'callId': call_id,
        'argumentsSha256': hashlib.sha256(encoded(complete_arguments).encode('utf-8')).hexdigest()}
    return update, receipt


def reference_case(repo):
    first_asset, second_asset = upload(repo, 'red'), upload(repo, 'blue')
    first = turn(repo, 'source-first', 'First comparison source', [{'kind': 'upload', 'uploadId': first_asset}])
    done(repo, 'source-first')
    second = turn(repo, 'source-second', 'Second comparison source',
                  [{'kind': 'upload', 'uploadId': second_asset}], parent=first['round']['id'])
    done(repo, 'source-second')
    third = turn(repo, 'third', 'Generate an independent image with the chosen comparison sources.', parent=second['round']['id'])
    refs = refs_for_request(repo, third)
    selection = {'targetRef': 'round-1-reference-1',
                 'auxiliaries': [{'ref': 'round-2-reference-1', 'role': 'lighting'}]}
    return third, refs, selection, first_asset, second_asset


def test_inline_selection_task_and_receipt_commit_together_and_replay_does_not_reselect(repo, monkeypatch):
    third, refs, selection, target, auxiliary = reference_case(repo)
    arguments, receipt = inline_update(third, reference_selection=selection)
    before = copy.deepcopy(repo.request('third'))
    assert before['round']['taskContext']['target']['assetId'] != target
    proposed = repo.update_task_context('third', arguments, refs, dry_run=True,
                                       tool_receipt=receipt, reference_selection=selection)
    assert proposed['target']['assetId'] == target
    assert [(item['assetId'], item['role']) for item in proposed['auxiliaries']] == [(auxiliary, 'lighting')]
    assert proposed['_imageRoleBinding']['targetAssetId'] == target
    assert repo.request('third')['round'] == before['round']
    assert repo.task_update_receipt('third', receipt) is False
    updated = repo.update_task_context('third', arguments, refs, tool_receipt=receipt, reference_selection=selection)
    saved = copy.deepcopy(repo.request('third'))
    assert saved['history'] == before['history']
    assert saved['round']['editingTask']['target']['assetId'] == updated['target']['assetId'] == target
    assert saved['round']['taskContext']['_imageRoleBinding']['targetAssetId'] == target
    assert repo.task_update_receipt('third', receipt)['taskRevision'] == updated['revision']

    def no_second_selection(*args, **kwargs):
        raise AssertionError('Applied selection must not be executed twice')

    monkeypatch.setattr(editing, 'select_references', no_second_selection)
    replayed = repo.update_task_context('third', arguments, refs, tool_receipt=receipt, reference_selection=selection)
    dry_replayed = repo.update_task_context('third', arguments, refs, dry_run=True,
                                          tool_receipt=receipt, reference_selection=selection)
    assert replayed['taskId'] == dry_replayed['taskId'] == updated['taskId']
    assert replayed['revision'] == dry_replayed['revision'] == updated['revision']
    assert repo.request('third')['round'] == saved['round']


@pytest.mark.parametrize('selection', [
    {'targetRef': 'not-in-frozen-refs', 'auxiliaries': []},
    {'targetRef': None, 'auxiliaries': [{'ref': 'round-2-reference-1', 'role': 'lighting'}]},
    {'targetRef': 'round-1-reference-1', 'auxiliaries': [{'ref': 'round-1-reference-1', 'role': 'lighting'}]},
])
def test_invalid_inline_selection_never_saves_task_or_receipt(repo, selection):
    third, refs, _, _, _ = reference_case(repo)
    arguments, receipt = inline_update(third, reference_selection=selection)
    before = copy.deepcopy(repo.request('third')['round'])
    for dry_run in (True, False):
        with pytest.raises(AgentError) as error:
            repo.update_task_context('third', arguments, refs, dry_run=dry_run,
                                     tool_receipt=receipt, reference_selection=selection)
        assert error.value.code in {'invalid_reference', 'reference_missing'}
        assert repo.request('third')['round'] == before
        assert repo.task_update_receipt('third', receipt) is False


def test_inline_receipt_replays_original_cas_once_and_returns_current_context(repo):
    _, _, third, _ = continued_task(repo)
    arguments, receipt = inline_update(third)
    original = copy.deepcopy(repo.request('third'))
    proposed = repo.update_task_context('third', arguments, {}, dry_run=True, tool_receipt=receipt)
    assert proposed['taskId'] != original['round']['taskContext']['taskId']
    assert repo.task_update_receipt('third', receipt) is False
    assert repo.request('third')['round'] == original['round']
    applied = repo.update_task_context('third', arguments, {}, tool_receipt=receipt)
    assert applied['taskId'] != original['round']['taskContext']['taskId']
    current = repo.request('third')
    repo.update_task_context('third', state_arguments(current, [{'op': 'set_prompt', 'text': 'A later working candidate'}]), {})
    before_replay = copy.deepcopy(repo.request('third'))
    replayed = repo.update_task_context('third', arguments, {}, tool_receipt=receipt)
    dry_replay = repo.update_task_context('third', arguments, {}, dry_run=True, tool_receipt=receipt)
    assert replayed['taskId'] == dry_replay['taskId'] == applied['taskId']
    assert replayed['revision'] == dry_replay['revision'] == before_replay['round']['taskContext']['revision']
    assert replayed['workingPromptVersionId'] == before_replay['round']['taskContext']['workingPromptVersionId']
    assert repo.request('third')['round'] == before_replay['round']
    assert repo.request('third')['history'] == original['history']
    assert repo.request('third')['body'] == original['body']
    record = repo.task_update_receipt('third', receipt)
    assert record == {**receipt, 'taskId': applied['taskId'], 'taskRevision': applied['revision']}
    assert len(encoded(record)) < 400 and 'taskContext' not in record
    public = repo.snapshot('conversation')
    assert all('_taskUpdateReceipts' not in row for row in public['conversation']['rounds'])


def test_receipt_hash_conflict_rejects_and_other_calls_still_require_their_own_cas(repo):
    _, _, third, _ = continued_task(repo)
    arguments, receipt = inline_update(third)
    repo.update_task_context('third', arguments, {}, tool_receipt=receipt)
    changed = {**receipt, 'argumentsSha256': '0' * 64}
    for run in (lambda: repo.task_update_receipt('third', changed),
                lambda: repo.update_task_context('third', arguments, {}, tool_receipt=changed),
                lambda: repo.update_task_context('third', arguments, {}, dry_run=True, tool_receipt=changed)):
        with pytest.raises(AgentError) as error:
            run()
        assert error.value.code == 'task_tool_receipt_conflict'
    before = copy.deepcopy(repo.request('third')['round'])
    for identity in ({**receipt, 'callId': 'a-different-call'}, {**receipt, 'step': 2}):
        assert repo.task_update_receipt('third', identity) is False
        with pytest.raises(AgentError) as error:
            repo.update_task_context('third', arguments, {}, tool_receipt=identity)
        assert error.value.code == 'task_revision_conflict'
    assert repo.request('third')['round'] == before
    other_arguments = state_arguments(repo.request('third'), [{'op': 'set_task_type', 'taskType': 'prompt'}])
    other_receipt = {'step': 1, 'callId': 'a-different-call',
        'argumentsSha256': hashlib.sha256(encoded(other_arguments).encode('utf-8')).hexdigest()}
    other = repo.update_task_context('third', other_arguments, {}, tool_receipt=other_receipt)
    assert other['revision'] == before['taskContext']['revision'] + 1
    assert repo.task_update_receipt('third', other_receipt)['taskRevision'] == other['revision']
    assert repo.task_update_receipt('third', receipt)['taskRevision'] == before['taskContext']['revision']


@pytest.mark.parametrize('receipt', [
    {'step': True, 'callId': 'call', 'argumentsSha256': '0' * 64},
    {'step': 0, 'callId': 'call', 'argumentsSha256': '0' * 64},
    {'step': 1, 'callId': '', 'argumentsSha256': '0' * 64},
    {'step': 1, 'callId': 'call', 'argumentsSha256': 'g' * 64},
    {'step': 1, 'callId': 'call', 'argumentsSha256': '0' * 64, 'context': {}},
])
def test_malformed_receipts_do_not_change_task_state(repo, receipt):
    _, _, third, _ = continued_task(repo)
    arguments, _ = inline_update(third)
    before = copy.deepcopy(repo.request('third')['round'])
    with pytest.raises(AgentError) as error:
        repo.update_task_context('third', arguments, {}, tool_receipt=receipt)
    assert error.value.code == 'invalid_task_context'
    assert repo.request('third')['round'] == before


@pytest.mark.parametrize('fence', ['stop', 'branch', 'unknown'])
def test_applied_receipt_cannot_bypass_stop_branch_or_unknown_fence(repo, fence):
    _, _, third, _ = continued_task(repo)
    arguments, receipt = inline_update(third)
    repo.update_task_context('third', arguments, {}, tool_receipt=receipt)
    if fence == 'stop':
        repo.stop('third')
    elif fence == 'branch':
        snapshot = repo.snapshot('conversation')
        repo.patch_conversation('conversation', AgentConversationPatch(expectedRevision=snapshot['revision'], activeRoundId=None))
    else:
        repo.update('third', state='unknown', outcome='unknown')
    before = copy.deepcopy(repo.request('third')['round'])
    for run in (lambda: repo.task_update_receipt('third', receipt),
                lambda: repo.update_task_context('third', arguments, {}, tool_receipt=receipt),
                lambda: repo.update_task_context('third', arguments, {}, dry_run=True, tool_receipt=receipt)):
        with pytest.raises(AgentError) as error:
            run()
        assert error.value.code == ('task_branch_conflict' if fence == 'branch' else 'stopped')
    assert repo.request('third')['round'] == before


def test_task_state_and_receipt_roll_back_together_when_saving_fails(repo, monkeypatch):
    third, refs, selection, target, _ = reference_case(repo)
    arguments, receipt = inline_update(third, reference_selection=selection)
    before = copy.deepcopy(repo.request('third')['round'])
    save_round = repo._save_round

    def interrupted_save(conn, value):
        save_round(conn, value)
        raise RuntimeError('Synthetic failure before transaction commit')

    monkeypatch.setattr(repo, '_save_round', interrupted_save)
    with pytest.raises(RuntimeError, match='Synthetic failure'):
        repo.update_task_context('third', arguments, refs, tool_receipt=receipt, reference_selection=selection)
    assert repo.task_update_receipt('third', receipt) is False
    assert repo.request('third')['round'] == before
    monkeypatch.setattr(repo, '_save_round', save_round)
    repo.update_task_context('third', arguments, refs, tool_receipt=receipt, reference_selection=selection)
    assert repo.task_update_receipt('third', receipt)
    assert repo.request('third')['round']['editingTask']['target']['assetId'] == target


def test_receipt_committed_between_lookup_and_round_read_is_recovered(repo, monkeypatch):
    _, _, third, _ = continued_task(repo)
    arguments, receipt = inline_update(third)
    read_request = repo.request
    injected = False

    def concurrent_commit(request_id):
        nonlocal injected
        if request_id == 'third' and not injected:
            injected = True
            repo.update_task_context('third', arguments, {}, tool_receipt=receipt)
        return read_request(request_id)

    monkeypatch.setattr(repo, 'request', concurrent_commit)
    current = repo.update_task_context('third', arguments, {}, tool_receipt=receipt)
    assert current['revision'] == third['round']['taskContext']['revision'] + 1
    assert repo.task_update_receipt('third', receipt)['taskId'] == current['taskId']
