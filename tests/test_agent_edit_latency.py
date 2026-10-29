"""Inline reference selection reaches the existing image queue in one model step."""
import json

import pytest

from backend.services import agent_execution as execution
from backend.services.agent_repository import AgentError, AgentRepository, encoded
from test_agent_editing_task import done, turn, upload as store_image
from test_agent_image_selection import body, repo
from test_agent_workflow_execution import application, answer, image_reply, pixels, submit, upload
from test_agent_workspaces import image_bytes, isolated


def image_call(selection, *, batch=False, prompt='Synthetic edit preserving the selected subject'):
    arguments = {'finish_after_generation': True, 'referenceSelection': selection}
    arguments.update({'images': [{'id': 'one', 'prompt': prompt}]} if batch else {'id': 'one', 'prompt': prompt})
    return {'id': 'edit-response', 'status': 'completed', 'output': [
        {'id': 'edit-call', 'call_id': 'edit-call', 'type': 'function_call',
         'name': 'generate_image_batch' if batch else 'generate_image', 'arguments': encoded(arguments)}]}


@pytest.mark.parametrize('mode,batch', [('hybrid', False), ('hybrid', True), ('native', True)])
def test_inline_selection_resolves_subject_and_roles_without_extra_model_step(isolated, monkeypatch, mode, batch):
    with application(isolated, monkeypatch, mode=mode) as (client, calls, replies):
        refs = [upload(client, color) for color in ('red', 'blue')]
        replies.append(answer('Which picture should be edited?'))
        first, _ = submit(client, isolated, '帮她修改衣服，保留姿势', refs=refs, images=True, rid='first')
        original = AgentRepository(isolated).request('first')['round']
        assert original['editingTask']['needsTargetSelection'] and not first['jobs']
        replies.append(image_call({'targetRef': 'round-1-reference-2', 'auxiliaries': [
            {'ref': 'round-1-reference-1', 'role': 'lighting'}]}, batch=batch))
        if mode == 'native':
            replies.append(image_reply('native'))
        before = len(calls)
        result, submitted = submit(client, isolated, '就改第二张，第一张只参考光线', images=True, rid='second')
        assert result['request']['state'] == 'completed', result['request']
        repository = AgentRepository(isolated)
        task = result['editingTask']
        assert task['target']['source'] == refs[1] and task['auxiliaries'][0]['source'] == refs[0]
        assert '保留姿势' in task['requirements']
        assert len(result['jobs']) == 1 and result['jobs'][0]['status'] == 'succeeded'
        job = result['jobs'][0]
        assert job['mode'] == 'image_edit'
        assert [entry['result_path'] for entry in job['parameters']['input_images']] == [
            repository.asset(task['target']['assetId'])['path'], repository.asset(task['auxiliaries'][0]['assetId'])['path']]
        sent = calls[before][1]
        tool_name = 'generate_image_batch' if batch else 'generate_image'
        tool = next(tool for tool in sent['tools'] if tool.get('name') == tool_name)
        assert 'referenceSelection' in tool['parameters']['properties']
        assert repository.data_url(task['target']['assetId']) in pixels(sent)
        assert repository.data_url(task['auxiliaries'][0]['assetId']) in pixels(sent)
        new_calls = calls[before:]
        assert [path for path, _ in new_calls] == (
            ['/v1/responses', '/v1/responses'] if mode == 'native' else ['/v1/responses', '/v1/images/edits'])
        if mode == 'native':
            assert pixels(new_calls[1][1]) == [repository.data_url(task['target']['assetId']),
                                               repository.data_url(task['auxiliaries'][0]['assetId'])]
        else:
            for color in ('red', 'blue'):
                assert image_bytes(color) in new_calls[1][1]
        assert repository.request('second')['usage']['responseStepsStarted'] == 1
        assert repository.request('first')['round'] == original
        assert client.post('/api/agent/conversations/conv/rounds', json=submitted).status_code == 200
        assert len(calls) == before + 2
        assert len(client.get('/api/agent/requests/second').json()['jobs']) == 1
        assert client.get('/api/items').json()['items'] == []


def test_inline_selection_corrects_old_subject_when_a_new_upload_is_the_intended_target(isolated, monkeypatch):
    with application(isolated, monkeypatch) as (client, calls, replies):
        original_ref = upload(client, 'red')
        first, _ = submit(client, isolated, '修改这张图，保持姿势', refs=[original_ref], rid='first')
        repository = AgentRepository(isolated)
        original = repository.request('first')['round']
        new_ref = upload(client, 'blue')
        queued, _ = submit(client, isolated, '新图作为主图，原图只用它的光线，直接出图',
                           refs=[new_ref], images=True, rid='second', run=False)
        # The single current upload is automatically the discussion object.
        # Its old relationship is not discarded: the normal model call still
        # receives the prior pixels and assigns their exact auxiliary role.
        assert queued['editingTask']['target']['source'] == new_ref
        assert queued['taskContext']['historyDependencies']
        assert queued['taskContext']['unresolvedItems']
        replies.append(image_call({'targetRef': 'round-2-reference-1', 'auxiliaries': [
            {'ref': 'round-1-reference-1', 'role': 'lighting'}]}))
        before = len(calls)
        execution.run_request(isolated, 'second')
        assert set(pixels(calls[before][1])) == {
            repository.data_url(new_ref['uploadId']), repository.data_url(original_ref['uploadId'])}
        result = client.get('/api/agent/requests/second').json()
        assert result['request']['state'] == 'completed', result['request']
        assert result['editingTask']['target']['source'] == new_ref
        assert result['editingTask']['auxiliaries'][0]['source'] == original_ref
        job = result['jobs'][0]
        assert job['status'] == 'succeeded'
        assert [entry['result_path'] for entry in job['parameters']['input_images']] == [
            repository.asset(new_ref['uploadId'])['path'], repository.asset(original_ref['uploadId'])['path']]
        assert [path for path, _ in calls[before:]] == ['/v1/responses', '/v1/images/edits']
        assert image_bytes('blue') in calls[-1][1] and image_bytes('red') in calls[-1][1]
        assert repository.request('first')['round'] == original


@pytest.mark.parametrize('case', ['missing', 'sibling', 'corrupt', 'duplicate', 'malformed'])
def test_inline_selection_rejects_unsafe_references_before_any_image_job(repo, monkeypatch, case):
    red, blue = store_image(repo, 'red'), store_image(repo, 'blue')
    first = turn(repo, 'first', '修改衣服', [{'kind': 'upload', 'uploadId': red}])
    done(repo, 'first')
    turn(repo, 'sibling', '修改衣服', [{'kind': 'upload', 'uploadId': blue}])
    done(repo, 'sibling')
    current = turn(repo, 'next', '采用另一张图', parent=first['round']['id'])
    refs = execution.refs_for_request(repo, current)
    selection = {'targetRef': 'round-1-reference-1', 'auxiliaries': []}
    if case == 'missing':
        selection['targetRef'] = 'round-99-reference-1'
    elif case == 'sibling':
        selection['targetRef'] = blue
    elif case == 'corrupt':
        (repo.library / repo.asset(red)['path']).write_bytes(image_bytes('green'))
    elif case == 'duplicate':
        selection['auxiliaries'] = [{'ref': selection['targetRef'], 'role': 'lighting'}]
    else:
        selection = {'targetRef': selection['targetRef']}
    monkeypatch.setattr('backend.services.generation_queue.enqueue_generation_jobs',
                        lambda *a, **kw: pytest.fail('Invalid selection queued a paid image job'))
    with pytest.raises(AgentError):
        execution.execute_calls(repo, 'next', 1, image_call(selection)['output'], refs)
    assert repo.request('next')['round']['editingTask'] == current['round']['editingTask']
    assert repo.request('next')['round']['outputTaskIds'] == []
    assert repo.request('next')['usage']['imageJobsCreated'] == 0


def test_inline_selection_never_grants_image_authorization(repo, monkeypatch):
    refs = [{'kind': 'upload', 'uploadId': store_image(repo, color)} for color in ('red', 'blue')]
    first = turn(repo, 'first', '修改衣服', refs)
    done(repo, 'first')
    value = body(repo, 'next', images=False).model_copy(update={
        'prompt': '第二张只做文字分析', 'parentRoundId': first['round']['id']})
    repo.create_round('conversation', value)
    current = repo.request('next')
    bound = execution.refs_for_request(repo, current)
    monkeypatch.setattr('backend.services.generation_queue.enqueue_generation_jobs',
                        lambda *a, **kw: pytest.fail('Unauthorized request queued an image'))
    with pytest.raises(AgentError) as error:
        execution.execute_calls(repo, 'next', 1, image_call({
            'targetRef': 'round-1-reference-2', 'auxiliaries': []})['output'], bound)
    assert error.value.code == 'authorization_denied'
    assert repo.request('next')['round']['editingTask'] == current['round']['editingTask']
    assert not repo.request('next')['round']['outputTaskIds']
    assert not any(tool.get('name') in {'generate_image', 'generate_image_batch'} or tool['type'] == 'image_generation'
                   for tool in execution.tools_for(current))


def test_unresolved_subject_still_requires_selection_when_inline_selection_is_null(repo, monkeypatch):
    current = turn(repo, 'first', '修改衣服', [
        {'kind': 'upload', 'uploadId': store_image(repo, color)} for color in ('red', 'blue')])
    monkeypatch.setattr('backend.services.generation_queue.enqueue_generation_jobs',
                        lambda *a, **kw: pytest.fail('Ambiguous subject queued an image'))
    with pytest.raises(AgentError) as error:
        execution.execute_calls(repo, 'first', 1, image_call(None)['output'], execution.refs_for_request(repo, current))
    assert error.value.code == 'editing_target_required'
    assert repo.request('first')['round']['editingTask'] == current['round']['editingTask']
    assert not repo.request('first')['round']['outputTaskIds']


@pytest.mark.parametrize('case,code', [('bad_second_ref', 'reference_missing'),
                                      ('over_budget', 'budget_exhausted'), ('stopped', 'stopped')])
def test_entire_batch_is_validated_before_selection_changes_or_jobs(repo, monkeypatch, case, code):
    current = turn(repo, 'first', '修改衣服', [
        {'kind': 'upload', 'uploadId': store_image(repo, color)} for color in ('red', 'blue')])
    call = image_call({'targetRef': 'round-1-reference-2', 'auxiliaries': []}, batch=True)['output'][0]
    args = json.loads(call['arguments'])
    args['images'].append({'id': 'two', 'prompt': 'Another synthetic edit'})
    if case == 'bad_second_ref':
        args['images'][1]['prompt'] += ' <ref id="round-99-reference-1" />'
    elif case == 'over_budget':
        args['images'].append({'id': 'three', 'prompt': 'Third synthetic edit'})
    else:
        repo.stop('first')
    call['arguments'] = encoded(args)
    monkeypatch.setattr('backend.services.generation_queue.enqueue_generation_jobs',
                        lambda *a, **kw: pytest.fail('Invalid batch queued an image'))
    with pytest.raises(AgentError) as error:
        execution.execute_calls(repo, 'first', 1, [call], execution.refs_for_request(repo, current))
    assert error.value.code == code
    request = repo.request('first')
    assert request['round']['editingTask'] == current['round']['editingTask']
    assert request['round']['outputTaskIds'] == [] and request['usage']['imageJobsCreated'] == 0


def test_inline_selection_receipt_recovery_reuses_already_completed_image_job(repo, monkeypatch):
    current = turn(repo, 'first', '修改衣服', [
        {'kind': 'upload', 'uploadId': store_image(repo, color)} for color in ('red', 'blue')])
    output = image_call({'targetRef': 'round-1-reference-2', 'auxiliaries': []})['output']
    actual_dispatches = []

    def queue(library, **kwargs):
        # Emulate the real queue's queued-only dispatch contract, and preserve
        # the confirmed result before the Agent tool receipt is persisted.
        for job_id in repo.request('first')['round']['outputTaskIds']:
            if repo.jobs.get_job(job_id).status == 'queued':
                actual_dispatches.append(job_id)
                repo.jobs.stage_result(job_id, image_bytes('orange'), 'synthetic.png')

    monkeypatch.setattr('backend.services.generation_queue.enqueue_generation_jobs', queue)
    original_update = repo.update
    failed_once = False

    def interrupted_update(request_id, **kwargs):
        nonlocal failed_once
        if kwargs.get('output') is not None and not failed_once:
            failed_once = True
            raise RuntimeError('Synthetic interruption before saving the tool receipt')
        return original_update(request_id, **kwargs)

    monkeypatch.setattr(repo, 'update', interrupted_update)
    bound = execution.refs_for_request(repo, current)
    with pytest.raises(RuntimeError, match='Synthetic interruption'):
        execution.execute_calls(repo, 'first', 1, output, bound)
    first_job_ids = repo.request('first')['round']['outputTaskIds']
    assert len(first_job_ids) == 1 and repo.jobs.get_job(first_job_ids[0]).status == 'succeeded'
    execution.execute_calls(repo, 'first', 1, output, bound)
    request = repo.request('first')
    assert request['round']['outputTaskIds'] == first_job_ids and actual_dispatches == first_job_ids
    assert request['usage']['imageJobsCreated'] == 1
    assert len([item for item in request['round']['responseOutput'] if item.get('call_id') == 'edit-call']) == 1
