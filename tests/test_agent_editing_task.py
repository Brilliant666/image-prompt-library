"""Editing targets are frozen branch data, not guessed thumbnail positions."""
import base64
import json

import pytest

from backend.agent_schemas import AgentRef, AgentEditingTaskPatch, AgentConversationPatch
from backend.db import connect
from backend.schemas import GenerationJobCreate
from backend.services import agent_execution as execution
from backend.services.agent_repository import AgentError, AgentRepository
from test_agent_image_selection import repo, body
from test_agent_workspaces import image_bytes
from test_agent_workspaces import isolated


def upload(repo, color):
    return repo.store_asset(image_bytes(color=color), None)['id']


def turn(repo, request_id, prompt, refs=(), parent=None):
    value = body(repo, request_id).model_copy(update={'prompt': prompt, 'refs': [AgentRef.model_validate(ref) for ref in refs], 'parentRoundId': parent})
    repo.create_round('conversation', value)
    return repo.request(request_id)


def done(repo, request_id):
    repo.update(request_id, state='completed', outcome='known')


def test_single_new_edit_image_replaces_task_but_keeps_old_pixels(repo):
    old = upload(repo, 'red')
    previous = turn(repo, 'old', '帮她更换外套', [{'kind': 'upload', 'uploadId': old}])
    done(repo, 'old')
    new = upload(repo, 'blue')
    request = turn(repo, 'new', '帮她修改袜子，参考前面图片的光线', [{'kind': 'upload', 'uploadId': new}], previous['round']['id'])
    task = request['round']['editingTask']
    assert task['target']['assetId'] == new
    assert task['auxiliaries'][0]['assetId'] == old and task['auxiliaries'][0]['role'] == 'lighting'
    refs = execution.refs_for_request(repo, request)
    sent = json.dumps(execution.build_input(repo, request, refs))
    assert repo.data_url(old) in sent and repo.data_url(new) in sent


def test_clarification_inherits_stable_target_and_requirements(repo):
    asset = upload(repo, 'red')
    first = turn(repo, 'first', '只修改袜子，其他不变', [{'kind': 'upload', 'uploadId': asset}])
    done(repo, 'first')
    next_request = turn(repo, 'next', '白色过膝袜', parent=first['round']['id'])
    task = next_request['round']['editingTask']
    assert task['target']['assetId'] == asset
    assert '只修改袜子' in task['requirements'] and '白色过膝袜' in task['requirements']


def test_unrelated_ends_implicit_task_and_multiple_ambiguous_images_do_not_pick_one(repo):
    first = turn(repo, 'first', '帮她修改衣服', [{'kind': 'upload', 'uploadId': upload(repo, 'red')}])
    done(repo, 'first')
    second = turn(repo, 'second', '与前面的图无关', parent=first['round']['id'])
    assert second['round']['editingTask'] is None
    done(repo, 'second')
    request = turn(repo, 'multiple', '帮她修改衣服', [{'kind': 'upload', 'uploadId': upload(repo, c)} for c in ('blue', 'green')], second['round']['id'])
    assert request['round']['editingTask']['target'] is None
    assert request['round']['editingTask']['needsTargetSelection']
    with pytest.raises(AgentError, match='编辑对象'):
        execution.create_image_job(repo, 'multiple', 1, 'call', 'one', 'Synthetic edit', execution.refs_for_request(repo, request))


def patch(repo, task, branch=None, revision=None):
    return repo.patch_editing_task('conversation', AgentEditingTaskPatch.model_validate({
        'expectedRevision': repo.snapshot('conversation')['revision'] if revision is None else revision,
        'branchRoundId': branch, 'task': task}))


def test_manual_task_patch_end_revision_and_branch_isolation(repo):
    first_asset = upload(repo, 'red')
    first = turn(repo, 'first', '帮她修改衣服', [{'kind': 'upload', 'uploadId': first_asset}])
    done(repo, 'first')
    root = first['round']['id']
    left = turn(repo, 'left', '改成蓝色', parent=root)
    done(repo, 'left')
    right = turn(repo, 'right', '改成绿色', parent=root)
    done(repo, 'right')
    prior = repo.snapshot('conversation')
    patch(repo, {'target': {'kind': 'upload', 'uploadId': first_asset}, 'requirements': 'exact\n manual edit',
                 'constraints': ['只改衣服', '姿势不变'], 'workflow': 'gpt-image'}, left['round']['id'])
    with pytest.raises(AgentError) as stale:
        patch(repo, None, root, revision=prior['revision'])
    assert stale.value.code == 'revision_conflict'
    assert '改成绿色' in AgentRepository(repo.library).snapshot('conversation')['editingTask']['requirements']
    snap = repo.snapshot('conversation')
    selected = repo.patch_conversation('conversation', AgentConversationPatch(expectedRevision=snap['revision'], activeRoundId=left['round']['id']))
    assert selected['editingTask']['requirements'] == 'exact\n manual edit'
    assert selected['editingTask']['constraints'] == ['只改衣服', '姿势不变']
    # Ending a branch does not mutate its frozen request or revive its ancestor.
    patch(repo, None, left['round']['id'])
    assert repo.snapshot('conversation')['editingTask'] is None
    follow = turn(repo, 'after-end', '白色款式', parent=left['round']['id'])
    assert follow['round']['editingTask'] is None
    assert repo.request('left')['round']['editingTask']['target']['assetId'] == first_asset


def test_active_request_and_other_branch_upload_cannot_replace_task(repo):
    first = turn(repo, 'first', '普通聊天')
    with pytest.raises(AgentError) as active:
        patch(repo, None, first['round']['id'])
    assert active.value.code == 'request_active'
    done(repo, 'first')
    other = upload(repo, 'blue')
    sibling = turn(repo, 'sibling', '帮她修改衣服', [{'kind': 'upload', 'uploadId': other}], first['round']['id'])
    done(repo, 'sibling')
    with pytest.raises(AgentError) as wrong_branch:
        patch(repo, {'target': {'kind': 'upload', 'uploadId': other}}, first['round']['id'])
    assert wrong_branch.value.code == 'invalid_reference'
    with pytest.raises(AgentError):
        patch(repo, {'target': {'kind': 'upload', 'uploadId': 'not-an-asset'}}, first['round']['id'])


def test_manual_gallery_target_freezes_pixels_after_source_cleanup(repo):
    job = repo.jobs.create_job(GenerationJobCreate(prompt_text='Original synthetic\n prompt'))
    repo.jobs.stage_result(job.id, image_bytes('green'), 'synthetic.png')
    selected = patch(repo, {'target': {'kind': 'job', 'jobId': job.id}, 'requirements': '只改变光线'})['editingTask']
    repo.jobs.discard_job(job.id)
    changed = patch(repo, {'target': selected['target']['source'], 'requirements': '只改变光线', 'constraints': ['构图不变']})['editingTask']
    assert changed['target']['assetId'] == selected['target']['assetId']
    request = turn(repo, 'request', '更柔和一点')
    assert request['round']['inputImageIds'] == []
    assert request['round']['taskImageIds'] == [selected['target']['assetId']]
    refs = execution.refs_for_request(repo, request)
    sent = execution.build_input(repo, request, refs)
    assert repo.data_url(selected['target']['assetId']) in json.dumps(sent)
    task_text = sent[-1]['content'][-1]['text']
    assert 'round-1-reference-1' in task_text
    created = execution.create_image_job(repo, 'request', 1, 'edit', 'one', 'Actual tool prompt', refs)
    assert created.mode == 'image_edit'
    assert created.parameters['input_images'][0]['result_path'] == repo.asset(selected['target']['assetId'])['path']
    assert created.prompt_text == 'Actual tool prompt'


def test_new_image_with_explicit_older_lighting_keeps_roles_and_pixels(repo):
    first = turn(repo, 'first', 'Generate synthetic scene')
    source = execution.create_image_job(repo, 'first', 1, 'light', 'one', 'Blue scene', {})
    repo.jobs.stage_result(source.id, image_bytes('blue'), 'blue.png')
    done(repo, 'first')
    new = upload(repo, 'green')
    request = turn(repo, 'current', '帮她修改衣服，参考 @第1轮图1 的光线', [{'kind': 'upload', 'uploadId': new}], first['round']['id'])
    task = request['round']['editingTask']
    assert task['target']['assetId'] == new
    assert task['auxiliaries'][0]['source'] == {'kind': 'job', 'jobId': source.id}
    assert task['auxiliaries'][0]['role'] == 'lighting'
    sent = execution.build_input(repo, request, execution.refs_for_request(repo, request))
    pixels = [part['image_url'] for item in sent for part in item.get('content', []) if part['type'] == 'input_image']
    assert pixels == [repo.data_url(task['auxiliaries'][0]['assetId']), repo.data_url(new)]


def test_exact_reference_keeps_manual_required_auxiliary_pixels(repo):
    one, two = upload(repo, 'red'), upload(repo, 'green')
    first = turn(repo, 'first', 'Compare these images', [{'kind': 'upload', 'uploadId': aid} for aid in (one, two)])
    done(repo, 'first')
    patch(repo, {'target': {'kind': 'upload', 'uploadId': one}, 'auxiliaries': [
        {'ref': {'kind': 'upload', 'uploadId': two}, 'role': 'lighting'}]}, first['round']['id'])
    request = turn(repo, 'next', '<ref id="round-1-reference-1" />', parent=first['round']['id'])
    # An explicit repeat of the chosen target must not erase manually selected roles.
    assert request['round']['editingTask']['auxiliaries'][0]['assetId'] == two
    sent = execution.build_input(repo, request, execution.refs_for_request(repo, request))
    assert repo.data_url(one) in json.dumps(sent) and repo.data_url(two) in json.dumps(sent)


def test_retry_results_project_separately_and_continue_in_branch(repo):
    request = turn(repo, 'first', 'Generate synthetic scene')
    failed = execution.create_image_job(repo, 'first', 1, 'failed', 'one', 'Actual image prompt', {})
    repo.jobs.mark_failed(failed.id, 'Synthetic failure', diagnostics={'error': {'code': 'insufficient_quota'}})
    repo.update('first', state='failed', outcome='known', error={'code': 'image_job_failed', 'message': 'Synthetic failure'})
    retry = repo.jobs.create_job(GenerationJobCreate(prompt_text='Actual image prompt'), metadata={'agentRetry': {
        'conversationId': 'conversation', 'roundId': request['round']['id'], 'sourceRequestId': 'first', 'sourceJobId': failed.id}})
    repo.jobs.stage_result(retry.id, image_bytes('green'), 'retry.png')
    snapshot = AgentRepository(repo.library).snapshot('conversation')
    old_round = snapshot['conversation']['rounds'][0]
    assert old_round['outputTaskIds'] == [failed.id] and old_round['retryTaskIds'] == [retry.id]
    assert old_round['resultSummary']['outcome'] == 'images_failed'
    assert retry.id in {job['id'] for job in snapshot['jobs']}
    assert 'output_' + retry.id in {image['id'] for image in snapshot['images']}
    following = turn(repo, 'next', '继续修改上一张生成结果', parent=request['round']['id'])
    assert following['round']['editingTask']['target']['source'] == {'kind': 'job', 'jobId': retry.id}
    sent = execution.build_input(repo, following, execution.refs_for_request(repo, following))
    assert repo.data_url(following['round']['editingTask']['target']['assetId']) in json.dumps(sent)


def test_http_task_patch_never_dispatches_model_and_keeps_user_draft_fields(repo, monkeypatch):
    from fastapi.testclient import TestClient
    from backend.main import create_app
    monkeypatch.setattr('backend.routers.agent.schedule_request', lambda *args: pytest.fail('settings dispatched model'))
    aid = upload(repo, 'red')
    client = TestClient(create_app(repo.library))
    response = client.patch('/api/agent/conversations/conversation/editing-task', json={
        'expectedRevision': repo.snapshot('conversation')['revision'], 'branchRoundId': None,
        'task': {'target': {'kind': 'upload', 'uploadId': aid}, 'requirements': '  exact\n instructions  ', 'constraints': ['只改光线']}})
    assert response.status_code == 200, response.text
    assert response.json()['editingTask']['requirements'] == '  exact\n instructions  '
    assert response.json()['conversation']['rounds'] == []


def test_http_edit_role_context_reaches_responses_and_existing_images_queue(isolated, monkeypatch):
    from test_agent_workflow_execution import application, submit, upload as http_upload, image_reply, pixels
    with application(isolated, monkeypatch) as (client, calls, replies):
        first, _ = submit(client, isolated, '帮她修改衣服', rid='first', refs=[http_upload(client, 'blue')])
        first_round = first['conversation']['activeRoundId']
        replies.append(image_reply('hybrid'))
        second, value = submit(client, isolated, '帮她修改衣服，参考 <ref id="round-1-reference-1" /> 的光线',
                               rid='edit', refs=[http_upload(client, 'green')], images=True)
        current = next(row for row in second['conversation']['rounds'] if row['id'] == second['request']['roundId'])
        task = current['editingTask']
        assert task['target']['source'] == value['refs'][0]
        assert task['auxiliaries'][0]['role'] == 'lighting'
        assert task['branchRoundId'] == current['id'] and current['parentRoundId'] == first_round
        sent = next(data for path, data in calls[1:] if path == '/v1/responses')
        repository = AgentRepository(isolated)
        assert pixels(sent) == [repository.data_url(task['auxiliaries'][0]['assetId']), repository.data_url(task['target']['assetId'])]
        task_text = next(part['text'] for item in sent['input'] for part in item.get('content', [])
                         if part.get('text', '').startswith('Current editing task'))
        assert json.loads(task_text.split(': ', 1)[1])['targetRef'] == 'round-2-reference-1'
        assert second['request']['state'] == 'completed'
        job = second['jobs'][0]
        assert job['status'] == 'succeeded' and job['mode'] == 'image_edit'
        assert [image['result_path'] for image in job['parameters']['input_images']] == [
            repository.asset(task['target']['assetId'])['path'], repository.asset(task['auxiliaries'][0]['assetId'])['path']]
        assert [path for path, _ in calls] == ['/v1/responses', '/v1/responses', '/v1/images/edits']
        assert client.post('/api/agent/conversations/conv/rounds', json=value).status_code == 200
        assert len(calls) == 3 and client.get('/api/items').json()['items'] == []


def test_multiple_visual_images_do_not_force_an_editing_task(repo, monkeypatch):
    from test_agent_execution_correctness import transport, text_result
    request = turn(repo, 'compare', 'Compare the lighting of these two pictures', [
        {'kind': 'upload', 'uploadId': upload(repo, color)} for color in ('red', 'green')])
    calls = transport(monkeypatch, payload={'id': 'comparison', 'status': 'completed', 'output': [text_result('Synthetic comparison')]})
    execution.run_request(repo.library, 'compare')
    assert request['round']['editingTask'] is None
    assert repo.request('compare')['state'] == 'completed' and len(calls) == 1
    assert len([part for row in calls[0]['input'] for part in row.get('content', []) if part['type'] == 'input_image']) == 2
    assert repo.snapshot('conversation')['jobs'] == []


def test_manual_task_reuses_legacy_branch_pixels_after_live_source_changes(repo):
    source = repo.jobs.create_job(GenerationJobCreate(prompt_text='Synthetic source'))
    repo.jobs.stage_result(source.id, image_bytes('red'), 'original.png')
    legacy = repo.store_asset(image_bytes('red'), {'kind': 'job', 'jobId': source.id})['id']
    first = turn(repo, 'first', 'Ordinary history')
    with connect(repo.library) as conn:
        row = dict(first['round'], inputImageIds=[legacy])
        conn.execute('UPDATE agent_rounds SET data=? WHERE id=?', (json.dumps(row), row['id']))
    done(repo, 'first')
    (repo.library / repo.jobs.get_job(source.id).result_path).write_bytes(image_bytes('green'))
    # The mutable original may have changed and is now removed. The accepted
    # branch reference remains the authority; no new live read may replace it.
    repo.jobs.discard_job(source.id)
    selected = patch(repo, {'target': {'kind': 'job', 'jobId': source.id}, 'requirements': 'Preserve red'}, first['round']['id'])
    assert selected['editingTask']['target']['assetId'] == legacy
    assert repo.data_url(legacy).endswith(base64.b64encode(image_bytes('red')).decode())


def test_schema18_upgrade_and_portable_backup_preserve_branch_task_and_assets(repo, tmp_path):
    from backend import db
    from backend.services.library_archives import backup_library, restore_library, verify_backup
    aid = upload(repo, 'red')
    first = turn(repo, 'first', '帮她修改衣服', [{'kind': 'upload', 'uploadId': aid}])
    done(repo, 'first')
    # Simulate a genuine pre-task database with ordinary old round JSON.
    old_round = {key: value for key, value in first['round'].items() if key not in {'editingTask', 'taskImageIds'}}
    old_config = repo.config()
    with connect(repo.library) as conn:
        conn.execute('UPDATE agent_rounds SET data=? WHERE id=?', (json.dumps(old_round), old_round['id']))
        conn.execute('DROP INDEX idx_generation_agent_retry_conversation')
        conn.execute('ALTER TABLE agent_conversations DROP COLUMN editing_tasks')
        conn.execute("DELETE FROM schema_migrations WHERE version='019_agent_editing_tasks.sql'")
    conn.close()
    db.init_db(repo.library)
    upgraded = AgentRepository(repo.library)
    assert upgraded.config() == old_config and upgraded.snapshot('conversation')['editingTask'] is None
    selected = patch(upgraded, {'target': {'kind': 'upload', 'uploadId': aid}, 'requirements': '  Exact\nnew requirement  ',
                               'constraints': ['Keep pose'], 'workflow': 'gpt-image'}, old_round['id'])
    archive = backup_library(repo.library, tmp_path / 'editing-tasks.tar.gz')
    assert verify_backup(archive)['migrations'] == db.MIGRATIONS
    destination = tmp_path / 'restored'
    restore_library(archive, destination, confirm=True)
    restored = AgentRepository(destination)
    assert restored.snapshot('conversation')['editingTask'] == selected['editingTask']
    assert restored.data_url(aid) == repo.data_url(aid)
    assert restored.request('first')['round']['prompt'] == first['round']['prompt']
    with connect(destination) as conn:
        assert conn.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
        assert conn.execute('PRAGMA foreign_key_check').fetchall() == []


def test_explicit_new_auxiliary_keeps_selected_subject_and_actual_edit_input_order(repo):
    red = upload(repo, 'red')
    first = turn(repo, 'first', '帮她修改衣服', [{'kind': 'upload', 'uploadId': red}])
    done(repo, 'first')
    blue = upload(repo, 'blue')
    current = turn(repo, 'next', '保持当前人物姿势，参考 @图1 的光线',
                   [{'kind': 'upload', 'uploadId': blue}], first['round']['id'])
    task = current['round']['editingTask']
    assert task['target']['assetId'] == red
    assert [(image['assetId'], image['role']) for image in task['auxiliaries']] == [(blue, 'lighting')]
    refs = execution.refs_for_request(repo, current)
    sent = execution.build_input(repo, current, refs)
    assert repo.data_url(red) in json.dumps(sent) and repo.data_url(blue) in json.dumps(sent)
    job = execution.create_image_job(repo, 'next', 1, 'call', 'one', 'Actual edit prompt', refs)
    assert [image['result_path'] for image in job.parameters['input_images']] == [repo.asset(red)['path'], repo.asset(blue)['path']]
    assert repo.request('first')['round']['editingTask']['auxiliaries'] == []


def test_continue_generated_result_preserves_confirmed_task_constraints_and_workflow(repo):
    red = upload(repo, 'red')
    first = turn(repo, 'first', '帮她修改衣服', [{'kind': 'upload', 'uploadId': red}])
    done(repo, 'first')
    confirmed = patch(repo, {'target': {'kind': 'upload', 'uploadId': red}, 'requirements': '只修改衣服颜色',
                            'constraints': ['保持人物姿势', '保持光线'], 'workflow': 'gpt-image'}, first['round']['id'])['editingTask']
    second = turn(repo, 'generate', '改成绿色', parent=first['round']['id'])
    refs = execution.refs_for_request(repo, second)
    result = execution.create_image_job(repo, 'generate', 1, 'call', 'one', 'Actual green edit prompt', refs)
    repo.jobs.stage_result(result.id, image_bytes('green'), 'result.png')
    done(repo, 'generate')
    current = turn(repo, 'next', '继续修改上一张生成结果', parent=second['round']['id'])
    task = current['round']['editingTask']
    assert task['target']['source'] == {'kind': 'job', 'jobId': result.id}
    assert task['constraints'] == confirmed['constraints'] and task['workflow'] == 'gpt-image'
    assert task['requirements'] == '只修改衣服颜色\n改成绿色\n继续修改上一张生成结果'
    refs = execution.refs_for_request(repo, current)
    assert repo.data_url(task['target']['assetId']) in json.dumps(execution.build_input(repo, current, refs))
    next_job = execution.create_image_job(repo, 'next', 1, 'next-call', 'one', 'Actual follow-up prompt', refs)
    assert next_job.parameters['input_images'][0]['result_path'] == repo.asset(task['target']['assetId'])['path']
    assert repo.jobs.get_job(result.id).status == 'succeeded'
    assert repo.request('generate')['round']['editingTask']['target']['assetId'] == red


def selection_call(target, auxiliaries=(), call_id='selection'):
    return {'id': call_id, 'call_id': call_id, 'type': 'function_call', 'name': 'select_image_references',
            'arguments': json.dumps({'targetRef': target, 'auxiliaries': list(auxiliaries)})}


@pytest.mark.parametrize('mode', ['hybrid', 'native'])
def test_conversation_selection_resolves_second_image_and_auxiliary_before_real_queue(isolated, monkeypatch, mode):
    from test_agent_workflow_execution import application, submit, upload as http_upload, answer, image_reply
    with application(isolated, monkeypatch, mode=mode) as (client, calls, replies):
        refs = [http_upload(client, color) for color in ('red', 'blue')]
        replies.append(answer('要修改哪张图片？'))
        first, _ = submit(client, isolated, '帮她修改衣服，保留姿势', refs=refs, images=True, rid='first')
        assert first['editingTask']['needsTargetSelection'] and not first['jobs']
        replies.extend([{'id': 'selection-response', 'status': 'completed', 'output': [
            selection_call('round-1-reference-2', [{'ref': 'round-1-reference-1', 'role': 'lighting'}])]}, image_reply(mode)])
        second, _ = submit(client, isolated, '就改第二张，第一张只参考光线', images=True, rid='second')
        repository = AgentRepository(isolated)
        task = second['editingTask']
        assert second['request']['state'] == 'completed' and not task['needsTargetSelection']
        assert task['target']['source'] == refs[1] and task['auxiliaries'][0]['source'] == refs[0]
        assert '保留姿势' in task['requirements']
        job = next(job for job in second['jobs'] if job['status'] == 'succeeded')
        target_path = repository.asset(task['target']['assetId'])['path']
        auxiliary_path = repository.asset(task['auxiliaries'][0]['assetId'])['path']
        # Hybrid submits the selected editing subject first. Native stores the
        # actual Responses attachment order, which includes the earlier context.
        assert [entry['result_path'] for entry in job['parameters']['input_images']] == (
            [target_path, auxiliary_path] if mode == 'hybrid' else [auxiliary_path, target_path])
        model_calls = [sent for path, sent in calls if path == '/v1/responses']
        assert not any(tool.get('name') == 'generate_image' or tool['type'] == 'image_generation' for tool in model_calls[1]['tools'])
        assert any(tool.get('name') == 'generate_image' or tool['type'] == 'image_generation' for tool in model_calls[2]['tools'])
        receipt = next(item for item in model_calls[2]['input'] if item.get('type') == 'function_call_output' and item['call_id'] == 'selection')
        assert json.loads(receipt['output'])['editingTask']['targetRef'] == 'round-1-reference-2'
        assert repository.request('first')['round']['editingTask']['needsTargetSelection']


def test_selection_can_clear_stale_ambiguity_and_does_not_grant_generation(repo):
    refs = [{'kind': 'upload', 'uploadId': upload(repo, color)} for color in ('red', 'blue')]
    first = turn(repo, 'first', '帮她修改衣服', refs)
    done(repo, 'first')
    value = body(repo, 'next', images=False).model_copy(update={'prompt': '现在聊聊另一个项目', 'parentRoundId': first['round']['id']})
    repo.create_round('conversation', value)
    request = repo.request('next')
    assert request['round']['editingTask']['needsTargetSelection']
    bound = execution.refs_for_request(repo, request)
    call = selection_call(None)
    execution.execute_calls(repo, 'next', 1, [call], bound)
    execution.execute_calls(repo, 'next', 1, [call], bound)
    current = repo.request('next')
    assert current['round']['editingTask'] is None
    assert len([item for item in current['round']['responseOutput'] if item.get('call_id') == 'selection']) == 1
    assert not any(tool.get('name') in {'generate_image', 'generate_image_batch'} or tool['type'] == 'image_generation'
                   for tool in execution.tools_for(current))
    assert repo.request('first')['round']['editingTask']['needsTargetSelection']


def test_conversation_correction_replaces_old_target_only_in_current_branch(repo):
    red, blue = upload(repo, 'red'), upload(repo, 'blue')
    first = turn(repo, 'first', '修改 @图1 的衣服，保持姿势', [
        {'kind': 'upload', 'uploadId': red}, {'kind': 'upload', 'uploadId': blue}])
    done(repo, 'first')
    current = turn(repo, 'next', '我说的是另一张', parent=first['round']['id'])
    assert current['round']['editingTask']['target']['assetId'] == red
    bound = execution.refs_for_request(repo, current)
    execution.execute_calls(repo, 'next', 1, [selection_call('round-1-reference-2')], bound)
    changed = repo.request('next')['round']['editingTask']
    assert changed['target']['assetId'] == blue and '保持姿势' in changed['requirements']
    job = execution.create_image_job(repo, 'next', 2, 'image', 'single', 'Edit the chosen subject', bound)
    assert job.parameters['input_images'][0]['result_path'] == repo.asset(blue)['path']
    assert repo.request('first')['round']['editingTask']['target']['assetId'] == red


@pytest.mark.parametrize('bad', ['missing', 'sibling', 'corrupt', 'duplicate'])
def test_selection_rejects_invalid_branch_pixels_without_replacing_task(repo, bad):
    red, blue = upload(repo, 'red'), upload(repo, 'blue')
    first = turn(repo, 'first', '帮她修改衣服', [{'kind': 'upload', 'uploadId': red}])
    done(repo, 'first')
    sibling = turn(repo, 'sibling', '帮她修改衣服', [{'kind': 'upload', 'uploadId': blue}])
    done(repo, 'sibling')
    current = turn(repo, 'next', '就改另一张', parent=first['round']['id'])
    bound = execution.refs_for_request(repo, current)
    target, auxiliaries = 'round-1-reference-1', []
    if bad == 'missing':
        target = 'round-99-reference-1'
    elif bad == 'sibling':
        target = blue  # An existing asset outside this branch is not a reference ID.
    elif bad == 'corrupt':
        (repo.library / repo.asset(red)['path']).write_bytes(image_bytes('green'))
    else:
        auxiliaries = [{'ref': target, 'role': 'lighting'}]
    with pytest.raises(AgentError):
        execution.execute_calls(repo, 'next', 1, [selection_call(target, auxiliaries)], bound)
    assert repo.request('next')['round']['editingTask'] == current['round']['editingTask']
    assert not repo.request('next')['round']['outputTaskIds']
