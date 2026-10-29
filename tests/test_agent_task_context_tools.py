"""Task tools cross the real worker and mocked Responses wire, without providers."""
import copy
import json

import httpx
import pytest

from backend.agent_schemas import AgentRef, AgentTaskContextPatch
from backend.services import agent_execution as execution
from backend.services.agent_repository import AgentError, encoded
from test_agent_image_selection import repo, body
from test_agent_execution_correctness import ScriptedStream, delta, terminal, text_result
from test_agent_workspaces import image_bytes


def start(repo, request_id='current', *, prompt='Keep natural lighting', parent=None, refs=()):
    value = body(repo, request_id, images=False).model_copy(update={
        'prompt': prompt, 'parentRoundId': parent, 'refs': [AgentRef.model_validate(ref) for ref in refs]})
    repo.create_round('conversation', value)
    return repo.request(request_id)


def call(name, arguments, identity='tool-call'):
    return {'id': identity, 'call_id': identity, 'type': 'function_call', 'name': name,
            'arguments': encoded(arguments)}


def state_call(repo, operations, identity='state-call', request_id='current'):
    request = repo.request(request_id)
    state = request['round']['taskContext']
    return call('update_task_context', {'taskId': state['taskId'], 'taskRevision': state['revision'],
        'branchRoundId': request['round_id'], 'operations': operations}, identity)


def reply(*output):
    return {'id': 'mock-response', 'status': 'completed', 'output': list(output)}


def provider(monkeypatch, responses, *, sse=False):
    calls = []

    def respond(request):
        assert request.method == 'POST' and request.url.host == '127.0.0.1'
        assert request.url.path == '/v1/responses'
        sent = json.loads(request.content)
        calls.append(sent)
        assert len(calls) <= len(responses), 'An unnecessary model POST was dispatched'
        entry = responses[len(calls) - 1]
        response = entry(sent) if callable(entry) else entry
        if not sse:
            return httpx.Response(200, json=response)
        text = next((item for item in response['output'] if item.get('type') == 'message'), None)
        events = []
        if text:
            content = text['content'][0]['text']
            events.extend([{'type': 'response.output_item.added', 'item': {**text, 'content': []}},
                           delta(content, sequence=7, identity=text['id']),
                           delta(content, sequence=7, identity=text['id'])])
        events.append(terminal(response['output']))
        chunks = [('data: ' + json.dumps(event) + '\n\n').encode() for event in events]
        return httpx.Response(200, stream=ScriptedStream(chunks), headers={'content-type': 'text/event-stream'})

    monkeypatch.setattr(httpx, 'HTTPTransport', lambda **kw: httpx.MockTransport(respond))
    return calls


def pixels(sent):
    return [part['image_url'] for row in sent['input'] for part in row.get('content', []) if part.get('type') == 'input_image']


def receipt(request, identity):
    values = [item for item in request['round']['responseOutput']
              if item.get('type') == 'function_call_output' and item.get('call_id') == identity]
    assert len(values) == 1
    return json.loads(values[0]['output'])


@pytest.mark.parametrize('sse', [False, True])
def test_normal_answer_and_state_tool_share_one_model_post_and_receipt_is_idempotent(repo, monkeypatch, sse):
    original = start(repo)
    before = copy.deepcopy(original['round']['taskContext'])
    update = state_call(repo, [{'op': 'add_constraint', 'text': 'Natural lighting', 'sourceQuote': original['round']['prompt']},
                              {'op': 'set_prompt', 'text': 'Candidate Prompt\n  exact spacing', 'kind': 'candidate'}])
    calls = provider(monkeypatch, [reply(text_result('Visible answer exactly once.'), update)], sse=sse)
    execution.run_request(repo.library, 'current')
    current = repo.request('current')
    assert current['state'] == 'completed' and current['usage']['responseStepsStarted'] == 1
    assert len(calls) == 1 and current['round']['assistantContent'] == 'Visible answer exactly once.'
    names = {tool.get('name') for tool in calls[0]['tools']}
    assert {'update_task_context', 'read_task_history'} <= names
    changed = current['round']['taskContext']
    assert changed['taskId'] == before['taskId'] and changed['revision'] == before['revision'] + 1
    assert changed['constraints'][0]['status'] == 'active'
    assert changed['constraints'][0]['source']['quote'] == original['round']['prompt']
    assert changed['promptVersions'][-1]['text'] == 'Candidate Prompt\n  exact spacing'
    assert changed['selectedPromptVersionId'] is None and changed['executedPromptVersionId'] is None
    assert receipt(current, 'state-call')['taskContext'] == changed
    # A receipt replay while still active is a local read, never another state
    # revision or another upstream request. Completed workers also never replay.
    repo.update('current', state='running', outcome='known')
    execution.execute_calls(repo, 'current', 1, [update], execution.refs_for_request(repo, repo.request('current')))
    assert repo.request('current')['round']['taskContext'] == changed
    receipt(repo.request('current'), 'state-call')
    repo.update('current', state='completed', outcome='known')
    assert len(calls) == 1


def test_state_tool_without_visible_answer_uses_the_normal_next_step(repo, monkeypatch):
    start(repo)
    update = state_call(repo, [{'op': 'set_task_type', 'taskType': 'prompt_optimization'}])
    calls = provider(monkeypatch, [reply(update), reply(text_result('The normal visible result.'))])
    execution.run_request(repo.library, 'current')
    current = repo.request('current')
    assert current['state'] == 'completed' and len(calls) == 2
    assert current['usage']['responseStepsStarted'] == 2
    assert current['round']['taskContext']['taskType'] == 'prompt_optimization'
    assert current['round']['assistantContent'] == 'The normal visible result.'
    outputs = [row for row in calls[1]['input'] if row.get('type') == 'function_call_output' and row.get('call_id') == 'state-call']
    assert len(outputs) == 1 and json.loads(outputs[0]['output'])['taskContext']['taskType'] == 'prompt_optimization'


def historical_request(repo, *, generated=False, sibling=False):
    image = repo.store_asset(image_bytes('red'), None)['id']
    first_value = body(repo, 'ancestor', images=generated).model_copy(update={'prompt': 'Exact ancestor visual evidence',
        'refs': [] if generated else [AgentRef(kind='upload', uploadId=image)]})
    repo.create_round('conversation', first_value)
    first = repo.request('ancestor')
    source_job = None
    if generated:
        source_job = execution.create_image_job(repo, 'ancestor', 1, 'source-image', 'one', 'Synthetic source image', {})
        repo.jobs.stage_result(source_job.id, image_bytes('red'), 'red.png')
    repo.update('ancestor', state='completed', outcome='known')
    if sibling:
        other = repo.store_asset(image_bytes('blue'), None)['id']
        branch = start(repo, 'sibling', prompt='Sibling source', parent=first['round_id'],
                       refs=[{'kind': 'upload', 'uploadId': other}])
        repo.update('sibling', state='completed', outcome='known')
    snapshot = repo.snapshot('conversation')
    repo.patch_task_context('conversation', AgentTaskContextPatch(expectedRevision=snapshot['revision'],
        branchRoundId=first['round_id'], taskRevision=first['round']['taskContext']['revision'],
        operations=[{'op': 'new_task', 'text': 'Current independent prompt task', 'taskType': 'prompt'}]))
    current = start(repo, parent=first['round_id'], prompt='Find the specifically requested source before continuing')
    if generated:
        image = current['history'][0]['frozenOutputImages'][0]
        repo.jobs.discard_job(source_job.id)
    return current, image


@pytest.mark.parametrize('generated', [False, True])
def test_read_ancestor_attaches_actual_frozen_pixels_to_next_model_wire(repo, monkeypatch, generated):
    original, image = historical_request(repo, generated=generated)
    read = call('read_task_history', {'roundNumbers': [1]}, 'history-call')
    calls = provider(monkeypatch, [reply(read), reply(text_result('Observed the actual requested source.'))])
    execution.run_request(repo.library, 'current')
    current = repo.request('current')
    assert current['state'] == 'completed' and len(calls) == 2
    assert pixels(calls[0]) == []
    assert pixels(calls[1]) == [repo.data_url(image)]
    assert current['history'] == original['history']
    evidence = receipt(current, 'history-call')
    assert evidence['pixelsAttachedOnNextStep'] is True
    assert evidence['history'][0]['roundId'] == original['history'][0]['id']
    assert evidence['history'][0]['user'] == 'Exact ancestor visual evidence'
    assert evidence['history'][0]['refs']
    assert current['round']['contextEvidenceRoundIds'] == [original['history'][0]['id']]
    repo.update('current', state='running', outcome='known')
    execution.execute_calls(repo, 'current', 1, [read], execution.refs_for_request(repo, repo.request('current')))
    replayed = repo.request('current')
    assert receipt(replayed, 'history-call') == evidence
    assert replayed['round']['contextEvidenceRoundIds'] == current['round']['contextEvidenceRoundIds']
    assert len(calls) == 2
    repo.update('current', state='completed', outcome='known')


@pytest.mark.parametrize('numbers', [[2], [99]])
def test_history_tool_cannot_read_sibling_or_missing_round(repo, monkeypatch, numbers):
    original, _ = historical_request(repo, sibling=True)
    calls = provider(monkeypatch, [reply(call('read_task_history', {'roundNumbers': numbers}, 'bad-history'))])
    execution.run_request(repo.library, 'current')
    current = repo.request('current')
    assert current['state'] == 'failed' and current['error']['code'] == 'reference_missing'
    assert len(calls) == 1 and not current['round'].get('contextEvidenceRoundIds')
    assert current['round']['taskContext'] == original['round']['taskContext']
    assert 'Sibling source' not in json.dumps(calls[0])
    assert not any(row.get('call_id') == 'bad-history' and row.get('type') == 'function_call_output'
                   for row in current['round']['responseOutput'])


def test_missing_requested_history_pixels_fail_before_another_model_post(repo, monkeypatch):
    original, image = historical_request(repo)
    (repo.library / repo.asset(image)['path']).unlink()
    calls = provider(monkeypatch, [reply(call('read_task_history', {'roundNumbers': [1]}, 'missing-pixels'))])
    execution.run_request(repo.library, 'current')
    current = repo.request('current')
    assert len(calls) == 1
    assert current['state'] in {'failed', 'unknown'}
    assert current['error']['code'] in {'reference_missing', 'frozen_reference_invalid'}
    assert current['round']['taskContext'] == original['round']['taskContext']


@pytest.mark.parametrize('terminal_state', ['unknown', 'stopped'])
def test_unknown_and_stopped_requests_never_dispatch_or_apply_task_tools(repo, monkeypatch, terminal_state):
    original = start(repo)
    update = state_call(repo, [{'op': 'set_prompt', 'text': 'Must not be persisted', 'kind': 'candidate'}])
    if terminal_state == 'unknown':
        repo.update('current', state='unknown', outcome='unknown')
    else:
        repo.stop('current')
    calls = provider(monkeypatch, [])
    with pytest.raises(AgentError):
        execution.execute_calls(repo, 'current', 1, [update], {})
    with pytest.raises(AgentError):
        execution.execute_calls(repo, 'current', 1, [call('read_task_history', {'roundNumbers': [1]})], {})
    execution.run_request(repo.library, 'current')
    current = repo.request('current')
    assert calls == [] and current['state'] == terminal_state
    assert current['round']['taskContext'] == original['round']['taskContext']
    assert current['round']['responseOutput'] == []
    with pytest.raises(AgentError) as unsafe:
        repo.resume('current', 'must-not-resume')
    assert unsafe.value.code == 'resume_not_safe'


def test_unterminated_sse_task_call_never_updates_state_or_replays_the_submission(repo, monkeypatch):
    original = start(repo)
    update = state_call(repo, [{'op': 'set_prompt', 'text': 'Unconfirmed partial candidate', 'kind': 'candidate'}])
    calls = []

    def respond(request):
        calls.append(json.loads(request.content))
        events = [
            {'type': 'response.created', 'response': {'id': 'partial-response', 'status': 'in_progress'}},
            {'type': 'response.output_item.added', 'item': update},
            {'type': 'response.output_item.done', 'item': update},
        ]
        chunks = [('data: ' + json.dumps(event) + '\n\n').encode() for event in events]
        return httpx.Response(200, stream=ScriptedStream(chunks), headers={'content-type': 'text/event-stream'})

    monkeypatch.setattr(httpx, 'HTTPTransport', lambda **kw: httpx.MockTransport(respond))
    execution.run_request(repo.library, 'current')
    current = repo.request('current')
    assert len(calls) == 1 and current['state'] == 'unknown'
    assert current['error']['code'] == 'upstream_outcome_unknown'
    assert current['round']['taskContext'] == original['round']['taskContext']
    assert not any(item.get('type') == 'function_call_output' for item in current['round']['responseOutput'])
    execution.recover_agent_requests(repo.library)
    execution.run_request(repo.library, 'current')
    assert len(calls) == 1 and repo.request('current')['state'] == 'unknown'
    with pytest.raises(AgentError) as unsafe:
        repo.resume('current', 'unknown-stream-must-not-resume')
    assert unsafe.value.code == 'resume_not_safe'


@pytest.mark.parametrize('malformation', ['invalid_json', 'stale_revision', 'forged_quote', 'missing_ref', 'confirm_candidate'])
def test_invalid_model_state_tool_keeps_last_valid_state_and_returns_local_error(repo, monkeypatch, malformation):
    start(repo)
    accepted = state_call(repo, [{'op': 'add_constraint', 'text': 'Keep lighting', 'sourceQuote': 'Keep natural lighting'}], 'accepted')
    execution.execute_calls(repo, 'current', 1, [accepted], {})
    valid = copy.deepcopy(repo.request('current')['round']['taskContext'])
    operation = {'op': 'set_prompt', 'text': 'Candidate only', 'kind': 'candidate'}
    invalid = state_call(repo, [operation], 'invalid')
    arguments = json.loads(invalid['arguments'])
    if malformation == 'invalid_json':
        invalid['arguments'] = '{'
    elif malformation == 'stale_revision':
        arguments['taskRevision'] -= 1
    elif malformation == 'forged_quote':
        arguments['operations'] = [{'op': 'update_constraint', 'id': valid['constraints'][0]['id'],
                                    'text': 'Remove lighting', 'sourceQuote': 'Not the user instruction'}]
    elif malformation == 'missing_ref':
        arguments['operations'] = [{'op': 'set_target', 'ref': 'round-99-reference-1'}]
    else:
        arguments['operations'] = [{'op': 'set_prompt', 'text': 'May not be selected by model', 'kind': 'selected'}]
    if malformation != 'invalid_json':
        invalid['arguments'] = encoded(arguments)
    calls = provider(monkeypatch, [])
    execution.execute_calls(repo, 'current', 2, [invalid], {})
    current = repo.request('current')
    assert current['round']['taskContext'] == valid
    assert receipt(current, 'invalid')['error']
    execution.execute_calls(repo, 'current', 2, [invalid], {})
    assert repo.request('current')['round']['taskContext'] == valid
    receipt(repo.request('current'), 'invalid')
    assert calls == []


def test_new_attachment_keeps_prior_composition_evidence_and_confirmed_constraints_on_wire(repo, monkeypatch):
    first_image = repo.store_asset(image_bytes('red'), None)['id']
    first = start(repo, 'ancestor', prompt='旧图确立构图，保持人物姿势。',
                  refs=[{'kind': 'upload', 'uploadId': first_image}])
    repo.update('ancestor', state='completed', outcome='known')
    snapshot = repo.snapshot('conversation')
    selected = repo.patch_task_context('conversation', AgentTaskContextPatch(expectedRevision=snapshot['revision'],
        branchRoundId=first['round_id'], taskRevision=first['round']['taskContext']['revision'],
        operations=[{'op': 'add_constraint', 'text': '保持人物姿势'}]))
    next_image = repo.store_asset(image_bytes('blue'), None)['id']
    current = start(repo, prompt='帮她换衣服，保留之前那张的构图。', parent=first['round_id'],
                    refs=[{'kind': 'upload', 'uploadId': next_image}])
    calls = provider(monkeypatch, [reply(text_result('I can see both the new subject and the original composition.'))])
    execution.run_request(repo.library, 'current')
    state = repo.request('current')['round']['taskContext']
    assert state['taskId'] == selected['taskContext']['taskId']
    assert state['constraints'] == selected['taskContext']['constraints']
    assert state['target']['assetId'] == next_image
    assert len(calls) == 1 and set(pixels(calls[0])) == {repo.data_url(first_image), repo.data_url(next_image)}
    wire_text = '\n'.join(part.get('text', '') for row in calls[0]['input'] for part in row.get('content', []))
    assert '旧图确立构图' in wire_text and '保持人物姿势' in wire_text


def test_undo_archived_working_prompt_in_same_normal_answer(repo, monkeypatch):
    first = start(repo, request_id='ancestor', prompt='Write a candidate image prompt')
    original = '  ARCHIVED_WORKING\nkeep exact punctuation: ,.!  '
    state = repo.update_task_context('ancestor', json.loads(state_call(repo, [
        {'op': 'set_prompt', 'text': original, 'kind': 'candidate'}],
        request_id='ancestor')['arguments']), {})
    old_id = state['workingPromptVersionId']
    for index in range(28):
        request = repo.request('ancestor')
        state = request['round']['taskContext']
        repo.update_task_context('ancestor', {
            'taskId': state['taskId'], 'taskRevision': state['revision'],
            'branchRoundId': request['round_id'],
            'operations': [{'op': 'set_prompt', 'text': f'Candidate {index}', 'kind': 'candidate'}]}, {})
    assert old_id not in {p['id'] for p in state['promptVersions']}
    repo.update('ancestor', state='completed', outcome='known')
    start(repo, prompt='Undo the previous change and restore the first candidate', parent=first['round_id'])
    undo = state_call(repo, [{'op': 'restore_working_prompt', 'id': old_id,
        'sourceQuote': 'Undo the previous change and restore the first candidate'}])
    calls = provider(monkeypatch, [reply(text_result('Restored the previous discussion version.'), undo)])
    execution.run_request(repo.library, 'current')
    current = repo.request('current')
    final = current['round']['taskContext']
    assert len(calls) == 1 and current['usage']['responseStepsStarted'] == 1
    assert final['workingPromptVersionId'] == old_id
    assert final['selectedPromptVersionId'] is None
    assert next(p for p in final['promptVersions'] if p['id'] == old_id)['text'] == original
    assert current['usage']['imageJobsCreated'] == 0
