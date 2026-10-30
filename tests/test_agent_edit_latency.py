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
@pytest.mark.parametrize('record_candidate', [False, True])
def test_inline_selection_resolves_subject_and_roles_without_extra_model_step(isolated, monkeypatch, mode, batch, record_candidate):
    with application(isolated, monkeypatch, mode=mode) as (client, calls, replies):
        refs = [upload(client, color) for color in ('red', 'blue')]
        first, _ = submit(client, isolated, '帮她修改衣服，保留姿势', refs=refs, images=True, rid='first', run=False)
        response = answer('Which picture should be edited?')
        if record_candidate:
            state = first['taskContext']
            response['output'].append({'id': 'record-working-prompt', 'call_id': 'record-working-prompt',
                'type': 'function_call', 'name': 'update_task_context', 'arguments': encoded({
                    'taskId': state['taskId'], 'taskRevision': state['revision'],
                    'branchRoundId': first['request']['roundId'], 'operations': [
                        {'op': 'set_prompt', 'kind': 'candidate', 'text': 'Keep the pose and edit the chosen geometric subject.'}]})})
        replies.append(response)
        execution.run_request(isolated, 'first')
        first = client.get('/api/agent/requests/first').json()
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
        assert {image['source']['uploadId'] for image in original['editingTask']['candidates']} == {
            ref['uploadId'] for ref in refs}
        if record_candidate:
            assert first['taskContext']['workingPromptVersionId']
            assert first['taskContext']['selectedPromptVersionId'] is None
            assert repository.request('first')['usage']['responseStepsStarted'] == 1
        assert result['editingTask']['candidates'] == []
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


@pytest.mark.parametrize('boundary', ['new_task', 'set_target'])
def test_task_projection_clears_pending_candidates_after_new_task_or_explicit_target(repo, boundary):
    from backend.agent_schemas import AgentTaskContextPatch
    references = [{'kind': 'upload', 'uploadId': store_image(repo, color)} for color in ('red', 'blue')]
    first = turn(repo, 'first', '帮她修改衣服，保留姿势', references)
    done(repo, 'first')
    original = repo.request('first')['round']
    assert len(original['editingTask']['candidates']) == 2
    snapshot = repo.snapshot('conversation')
    operation = ({'op': 'new_task', 'taskType': 'image_edit', 'text': 'A separate unbound image task.'}
                 if boundary == 'new_task' else {'op': 'set_target', 'ref': references[1]})
    result = repo.patch_task_context('conversation', AgentTaskContextPatch.model_validate({
        'expectedRevision': snapshot['revision'], 'branchRoundId': first['round']['id'],
        'taskRevision': snapshot['taskContext']['revision'], 'operations': [operation]}))
    assert result['editingTask']['candidates'] == []
    if boundary == 'new_task':
        assert result['taskContext']['taskId'] != original['taskContext']['taskId']
        assert result['editingTask']['target'] is None
    else:
        assert result['editingTask']['target']['source'] == references[1]
    assert repo.request('first')['round'] == original


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


@pytest.mark.parametrize('mode', ['hybrid', 'native'])
def test_prompt_only_task_keeps_bound_target_and_auxiliary_for_authorized_generation(isolated, monkeypatch, mode):
    from pathlib import Path
    with application(isolated, monkeypatch, mode=mode) as (client, calls, replies):
        ended = upload(client, 'green')
        submit(client, isolated, 'Analyze this unrelated image', refs=[ended], rid='ended')
        references = [upload(client, color) for color in ('red', 'blue')]
        current, _ = submit(client, isolated, 'New task: compare these two pictures',
                            refs=references, rid='compare')
        candidate = '  EXACT_WORKING_PROMPT\nKeep composition and use the lighting reference.  '
        patched = client.patch('/api/agent/conversations/conv/task-context', json={
            'expectedRevision': current['revision'],
            'branchRoundId': current['conversation']['activeRoundId'],
            'taskRevision': current['taskContext']['revision'],
            'operations': [
                {'op': 'set_target', 'ref': references[0]},
                {'op': 'set_auxiliaries', 'auxiliaries': [{'ref': references[1], 'role': 'lighting'}]},
                {'op': 'set_task_type', 'taskType': 'prompt_optimization'},
                {'op': 'set_prompt', 'text': candidate, 'kind': 'candidate'}]})
        assert patched.status_code == 200, patched.text
        snapshot = patched.json()
        assert snapshot['editingTask'] is None
        assert snapshot['taskContext']['selectedPromptVersionId'] is None
        off, _ = submit(client, isolated, 'Use the current version to generate', rid='off')
        assert off['request']['state'] == 'completed' and off['jobs'] == []
        assert pixels(calls[-1][1]) == []
        assert not any(t.get('type') == 'image_generation' or t.get('name') in
                       {'generate_image', 'generate_image_batch'} for t in calls[-1][1]['tools'])
        replies.append(image_call(None, prompt=candidate) if mode == 'hybrid' else image_reply('native'))
        before = len(calls)
        result, _ = submit(client, isolated, 'Use the current version to generate',
                           images=True, rid='generate')
        assert result['request']['state'] == 'completed', result['request']
        assert result['taskContext']['selectedPromptVersionId'] is None
        assert len(result['jobs']) == 1
        job = result['jobs'][0]
        assert job['status'] == 'succeeded' and job['mode'] == 'image_edit'
        if mode == 'hybrid':
            assert job['prompt_text'] == candidate
        assert [Path(isolated / entry['result_path']).read_bytes() for entry in job['parameters']['input_images']] == [
            image_bytes('red'), image_bytes('blue')]
        new_calls = calls[before:]
        if mode == 'hybrid':
            assert [path for path, _ in new_calls] == ['/v1/responses', '/v1/images/edits']
            assert pixels(new_calls[0][1]) == []
            assert image_bytes('red') in new_calls[1][1] and image_bytes('blue') in new_calls[1][1]
        else:
            assert [path for path, _ in new_calls] == ['/v1/responses']
            repository = AgentRepository(isolated)
            task_text = next(part['text'] for item in new_calls[0][1]['input']
                             for part in item.get('content', [])
                             if part.get('text', '').startswith('Current creative task'))
            task_data = json.loads(task_text.partition('): ')[2])
            working = next(p for p in task_data['promptVersions'] if p['id'] == task_data['workingPromptVersionId'])
            assert working['text'] == candidate and working['confirmedBy'] is None
            assert pixels(new_calls[0][1]) == [repository.data_url(ref['uploadId']) for ref in references]
            bound = job['metadata']['agent']['nativeReferenceSnapshot']
            assert bound['complete'] and bound['count'] == 2
            assert [item['assetId'] for item in bound['references']] == [ref['uploadId'] for ref in references]
            assert repository.data_url(ended['uploadId']) not in json.dumps(new_calls[0][1])


@pytest.mark.parametrize('problem', ['missing_frozen_ref', 'unresolved_roles'])
def test_prompt_task_execution_bridge_preserves_reference_preflight_guards(repo, problem):
    image = store_image(repo, 'blue')
    first = turn(repo, 'first', 'Reverse this image', [{'kind': 'upload', 'uploadId': image}])
    state = first['round']['taskContext']
    repo.update_task_context('first', {
        'taskId': state['taskId'], 'taskRevision': state['revision'],
        'branchRoundId': first['round_id'], 'operations': [
            {'op': 'set_task_type', 'taskType': 'prompt_optimization'},
            {'op': 'set_prompt', 'text': 'Bound candidate', 'kind': 'candidate'}]}, {})
    done(repo, 'first')
    current = turn(repo, 'next', 'Generate the current version', parent=first['round_id'])
    assert current['round']['editingTask'] is None
    refs = execution.refs_for_request(repo, current)
    if problem == 'missing_frozen_ref':
        refs = {}
    else:
        state = current['round']['taskContext']
        repo.update_task_context('next', {
            'taskId': state['taskId'], 'taskRevision': state['revision'],
            'branchRoundId': current['round_id'],
            'operations': [{'op': 'set_unresolved', 'items': ['The editing objects are ambiguous.']}]}, refs)
    with pytest.raises(AgentError) as failure:
        execution.create_image_job(repo, 'next', 1, 'call', 'single', 'Bound candidate without tags', refs)
    assert failure.value.code == ('reference_missing' if problem == 'missing_frozen_ref' else 'editing_target_required')
    assert repo.request('next')['usage']['imageJobsCreated'] == 0
    assert repo.request('next')['round']['outputTaskIds'] == []
