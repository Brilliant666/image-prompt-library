"""Terminal receipts and stream identity, using temporary libraries and mock HTTP."""
import base64
import json

import httpx
import pytest

from backend.db import connect
from backend.agent_schemas import AgentRef
from backend.services import agent_execution as execution
from backend.services.agent_repository import AgentError
from test_agent_image_selection import repo, body, set_mode
from test_agent_workspaces import image_bytes


class ScriptedStream(httpx.SyncByteStream):
    def __init__(self, chunks, *, error=None, close_error=None, after=None):
        self.chunks, self.error, self.close_error, self.after = chunks, error, close_error, after

    def __iter__(self):
        yield from self.chunks
        if self.after:
            self.after()
        if self.error:
            raise self.error

    def close(self):
        if self.close_error:
            raise self.close_error


def transport(monkeypatch, *, events=None, payload=None, error=None, close_error=None, after=None):
    calls = []

    def handler(request):
        assert request.url.host == '127.0.0.1' and request.url.path == '/v1/responses'
        calls.append(json.loads(request.content))
        chunks = [(e if isinstance(e, str) else 'data: ' + json.dumps(e) + '\n\n').encode() for e in events] if events is not None else [json.dumps(payload).encode()]
        return httpx.Response(200, stream=ScriptedStream(chunks, error=error, close_error=close_error, after=after),
                              headers={'content-type': 'text/event-stream' if events is not None else 'application/json'})
    monkeypatch.setattr(httpx, 'HTTPTransport', lambda **kwargs: httpx.MockTransport(handler))
    return calls


def start(repo, native=False):
    if native:
        set_mode(repo, 'native')
    value = body(repo)
    repo.create_round('conversation', value)
    return value


def image_result(status='completed'):
    return {'id': 'image-call', 'type': 'image_generation_call', 'status': status,
            'result': base64.b64encode(image_bytes()).decode()}


def text_result(text='hello', identity='message'):
    return {'id': identity, 'type': 'message', 'role': 'assistant',
            'content': [{'type': 'output_text', 'text': text}]}


def terminal(output=None, status='completed'):
    response = {'id': 'response', 'status': status}
    if output is not None:
        response['output'] = output
    return {'type': 'response.' + status, 'response': response}


def delta(text='hello', sequence=7, slot=0, identity='message', content=0):
    event = {'type': 'response.output_text.delta', 'output_index': slot, 'content_index': content, 'delta': text}
    if identity is not None:
        event['item_id'] = identity
    if sequence is not None:
        event['sequence_number'] = sequence
    return event


def new_child(repo, item='one'):
    job = execution.create_image_job(repo, 'request', 1, 'batch', item, 'synthetic square', {}, native=True)
    with connect(repo.library) as conn:
        conn.execute("UPDATE generation_jobs SET provider='agent_native_batch' WHERE id=?", (job.id,))
    return job


def job_count(repo):
    with connect(repo.library) as conn:
        return conn.execute('SELECT count(*) FROM generation_jobs').fetchone()[0]


def test_native_stream_preserves_final_revised_prompt_after_early_job_creation(repo, monkeypatch):
    value = start(repo, native=True)
    revised = 'Actual provider prompt\n  Exact spacing.'
    image = {**image_result(), 'revised_prompt': revised}
    transport(monkeypatch, events=[
        {'type': 'response.output_item.added', 'item': {**image, 'status': 'in_progress', 'result': None, 'revised_prompt': None}},
        {'type': 'response.output_item.done', 'item': image}, terminal([image])])
    execution.run_request(repo.library, 'request')
    current = repo.request('request')
    assert current['state'] == 'completed' and current['round']['prompt'] == value.prompt
    assert len(current['round']['outputTaskIds']) == 1
    job = repo.jobs.get_job(current['round']['outputTaskIds'][0])
    assert job.status == 'succeeded' and job.prompt_text == revised


@pytest.mark.parametrize('narrow', [False, True])
def test_native_recipe_records_actual_historical_pixels_without_new_upload(repo, monkeypatch, narrow):
    set_mode(repo, 'native')
    assets = [repo.store_asset(image_bytes(color=color), None)['id'] for color in ('red', 'blue')]
    first = body(repo, 'first', images=False).model_copy(update={'prompt': '图片里有什么？',
        'refs': [AgentRef(kind='upload', uploadId=aid) for aid in assets]})
    repo.create_round('conversation', first)
    parent = repo.request('first')['round_id']
    repo.update('first', state='completed', outcome='known')
    value = body(repo, 'next').model_copy(update={'parentRoundId': parent,
        'prompt': '<ref id="round-1-reference-2" />' if narrow else '蓝色陶瓷茶杯，柔光，桌面。'})
    repo.create_round('conversation', value)
    calls = transport(monkeypatch, payload={'id': 'native', 'status': 'completed', 'output': [image_result()]})
    execution.run_request(repo.library, 'next')
    current = repo.request('next')
    job = repo.jobs.get_job(current['round']['outputTaskIds'][0])
    expected = assets[1:] if narrow else assets
    assert job.status == 'succeeded' and job.mode == 'image_edit'
    assert [image['result_path'] for image in job.parameters['input_images']] == [repo.asset(aid)['path'] for aid in expected]
    snapshot = job.metadata['agent']['nativeReferenceSnapshot']
    assert snapshot['complete'] and snapshot['count'] == len(expected)
    assert [entry['assetId'] for entry in snapshot['references']] == expected
    pixels = [part for item in calls[0]['input'] for part in item.get('content', []) if part.get('type') == 'input_image']
    assert len(pixels) == len(expected)


def test_native_more_than_four_context_images_preserves_complete_record_and_result(repo, monkeypatch):
    set_mode(repo, 'native')
    parent, assets = None, []
    for index, colors in enumerate((('red', 'blue', 'green'), ('yellow', 'purple', 'orange'))):
        current_assets = [repo.store_asset(image_bytes(color=color), None)['id'] for color in colors]
        assets.extend(current_assets)
        request_id = f'history-{index}'
        value = body(repo, request_id, images=False).model_copy(update={'prompt': '描述这些图片', 'parentRoundId': parent,
            'refs': [AgentRef(kind='upload', uploadId=aid) for aid in current_assets]})
        repo.create_round('conversation', value)
        parent = repo.request(request_id)['round_id']
        repo.update(request_id, state='completed', outcome='known')
    repo.create_round('conversation', body(repo, 'next').model_copy(update={'parentRoundId': parent}))
    calls = transport(monkeypatch, payload={'id': 'native', 'status': 'completed', 'output': [image_result()]})
    execution.run_request(repo.library, 'next')
    current = repo.request('next')
    job = repo.jobs.get_job(current['round']['outputTaskIds'][0])
    snapshot = job.metadata['agent']['nativeReferenceSnapshot']
    assert current['state'] == 'completed' and job.status == 'succeeded' and job.mode == 'image_edit'
    assert snapshot['complete'] is False and snapshot['count'] == 6 and snapshot['reason'] == 'input_limit_exceeded'
    assert [entry['assetId'] for entry in snapshot['references']] == assets
    assert job.parameters['input_images'] == []  # No truncated or substitutable retry recipe.
    assert len([part for item in calls[0]['input'] for part in item.get('content', []) if part.get('type') == 'input_image']) == 6


@pytest.mark.parametrize('status', ['failed', 'incomplete', 'cancelled'])
def test_native_explicit_tool_failure_has_terminal_evidence_only_for_failed(repo, monkeypatch, status):
    start(repo, native=True)
    failed = {**image_result(status), 'result': None, 'error': {'code': 'image_generation_user_error'}}
    transport(monkeypatch, payload={'id': 'native', 'status': 'completed', 'output': [failed]})
    execution.run_request(repo.library, 'request')
    current = repo.request('request')
    job = repo.jobs.get_job(current['round']['outputTaskIds'][0])
    assert job.status == 'failed'
    assert job.metadata['agent'].get('nativeTerminalStatus') == ('failed' if status == 'failed' else None)


def test_native_stream_failed_terminal_keeps_reliable_image_prompt_for_retry(repo, monkeypatch):
    start(repo, native=True)
    revised = 'Final attempted image prompt\n  Exact spacing.'
    failed = {**image_result('failed'), 'result': None, 'revised_prompt': revised,
              'error': {'code': 'image_generation_user_error'}}
    transport(monkeypatch, events=[{'type': 'response.output_item.added', 'item': {
        **failed, 'status': 'in_progress', 'revised_prompt': None}}, terminal([failed])])
    execution.run_request(repo.library, 'request')
    current = repo.request('request')
    job = repo.jobs.get_job(current['round']['outputTaskIds'][0])
    assert job.status == 'failed' and job.prompt_text == revised
    assert job.metadata['response']['revised_prompt'] == revised
    assert job.metadata['agent']['nativeTerminalStatus'] == 'failed'


def test_native_batch_preserves_submitted_prompt_and_records_provider_revision(repo, monkeypatch):
    start(repo, native=True)
    job = new_child(repo)
    transport(monkeypatch, payload={'id': 'native', 'status': 'completed', 'output': [
        {**image_result(), 'revised_prompt': 'Final provider recipe\n  Exact spacing.'}]})
    result = execution.NativeAgentImageProvider().run_job(repo.library, job.id)
    assert result.status == 'succeeded' and result.prompt_text == job.prompt_text
    assert result.metadata['response']['revised_prompt'] == 'Final provider recipe\n  Exact spacing.'


@pytest.mark.parametrize('status', ['failed', 'incomplete'])
@pytest.mark.parametrize('stream', [False, True])
def test_native_child_rejects_failed_or_incomplete_response_with_image(repo, monkeypatch, status, stream):
    start(repo, native=True)
    job = new_child(repo)
    response = {'id': 'response', 'status': status, 'error': {'message': 'synthetic failure'}, 'output': [image_result()]}
    calls = transport(monkeypatch, payload=response, events=[{'type': 'response.' + status, 'response': response}] if stream else None)
    with pytest.raises(AgentError):
        execution.NativeAgentImageProvider().run_job(repo.library, job.id)
    assert repo.jobs.get_job(job.id).status == 'failed'
    with pytest.raises(AgentError):
        execution.NativeAgentImageProvider().run_job(repo.library, job.id)
    assert len(calls) == job_count(repo) == 1


@pytest.mark.parametrize('failure', [None, httpx.ReadTimeout('after terminal'), httpx.ReadError('after terminal')])
def test_completed_native_receipt_is_terminal_without_waiting_for_eof(repo, monkeypatch, failure):
    value = start(repo, native=True)
    calls = transport(monkeypatch, events=[terminal([image_result()])], error=failure)
    execution.run_request(repo.library, 'request')
    request = repo.request('request')
    assert request['state'] == 'completed' and request['upstream_outcome'] == 'known'
    assert request['usage']['imageJobsCreated'] == 1 and job_count(repo) == 1
    assert repo.jobs.get_job(request['round']['outputTaskIds'][0]).status == 'succeeded'
    assert repo.create_round('conversation', value)[1] is False
    execution.recover_agent_requests(repo.library)
    assert len(calls) == 1


def test_duplicate_identified_delta_is_not_appended_twice(repo, monkeypatch):
    start(repo)
    event = delta()
    calls = transport(monkeypatch, events=[event, event, terminal()])
    execution.run_request(repo.library, 'request')
    request = repo.request('request')
    assert request['state'] == 'completed'
    assert request['round']['assistantContent'] == 'hello'
    assert repo.snapshot(request_id='request')['conversation']['messages'][-1]['content'] == 'hello'
    assert len(calls) == 1


@pytest.mark.parametrize('stream', [False, True])
@pytest.mark.parametrize('item_status', ['failed', 'incomplete', 'in_progress'])
def test_native_child_requires_completed_image_inside_completed_response(repo, monkeypatch, stream, item_status):
    start(repo, native=True)
    job = new_child(repo)
    result = terminal([image_result(item_status)])
    calls = transport(monkeypatch, payload=result['response'], events=[result] if stream else None)
    with pytest.raises(AgentError):
        execution.NativeAgentImageProvider().run_job(repo.library, job.id)
    assert repo.jobs.get_job(job.id).status == 'failed' and len(calls) == 1


def test_native_single_image_contract_does_not_hide_extra_failed_image(repo, monkeypatch):
    start(repo, native=True)
    job = new_child(repo)
    calls = transport(monkeypatch, payload=terminal([image_result(), {'type': 'image_generation_call', 'id': 'failed', 'status': 'failed'}])['response'])
    with pytest.raises(AgentError):
        execution.NativeAgentImageProvider().run_job(repo.library, job.id)
    assert repo.jobs.get_job(job.id).status == 'failed' and len(calls) == 1


@pytest.mark.parametrize('stream', [False, True])
def test_native_child_failure_keeps_previously_confirmed_sibling(repo, monkeypatch, stream):
    start(repo, native=True)
    good, bad = new_child(repo, 'good'), new_child(repo, 'bad')
    payload = terminal([image_result()])
    successful_calls = transport(monkeypatch, payload=payload['response'], events=[payload] if stream else None)
    execution.NativeAgentImageProvider().run_job(repo.library, good.id)
    success = repo.jobs.get_job(good.id)
    payload = terminal([image_result()], status='incomplete')
    failed_calls = transport(monkeypatch, payload=payload['response'], events=[payload] if stream else None)
    with pytest.raises(AgentError):
        execution.NativeAgentImageProvider().run_job(repo.library, bad.id)
    assert repo.jobs.get_job(good.id).status == 'succeeded'
    assert repo.jobs.get_job(good.id).result_path == success.result_path
    assert repo.jobs.get_job(bad.id).status == 'failed'
    assert len(successful_calls) == len(failed_calls) == 1 and job_count(repo) == 2


@pytest.mark.parametrize('status', ['failed', 'incomplete'])
def test_native_stream_item_done_is_not_success_before_terminal(repo, monkeypatch, status):
    start(repo, native=True)
    calls = transport(monkeypatch, events=[
        {'type': 'response.output_item.done', 'output_index': 0, 'item': image_result()},
        terminal([image_result()], status=status),
    ])
    execution.run_request(repo.library, 'request')
    request = repo.request('request')
    assert request['state'] == 'failed' and request['upstream_outcome'] == 'known'
    assert len(request['round']['outputTaskIds']) == 1
    job = repo.jobs.get_job(request['round']['outputTaskIds'][0])
    assert job.status == 'failed' and job.result_path is None
    assert len(calls) == 1


@pytest.mark.parametrize('failure', [None, httpx.ReadTimeout('no receipt'), httpx.ReadError('no receipt')])
def test_no_terminal_receipt_keeps_unknown_without_replaying(repo, monkeypatch, failure):
    value = start(repo, native=True)
    calls = transport(monkeypatch, events=[{'type': 'response.output_item.done', 'output_index': 0, 'item': image_result()}], error=failure)
    execution.run_request(repo.library, 'request')
    request = repo.request('request')
    assert request['state'] == 'unknown' and request['upstream_outcome'] == 'unknown'
    assert repo.jobs.get_job(request['round']['outputTaskIds'][0]).status == 'failed'
    assert repo.create_round('conversation', value)[1] is False
    execution.recover_agent_requests(repo.library)
    assert len(calls) == 1


@pytest.mark.parametrize('native_child', [False, True])
def test_valid_terminal_survives_transport_close_error(repo, monkeypatch, native_child):
    start(repo, native=True)
    calls = transport(monkeypatch, events=[terminal([image_result()])], close_error=httpx.ReadError('close failed'))
    if native_child:
        job = new_child(repo)
        execution.NativeAgentImageProvider().run_job(repo.library, job.id)
        assert repo.jobs.get_job(job.id).status == 'succeeded'
    else:
        execution.run_request(repo.library, 'request')
        assert repo.request('request')['state'] == 'completed'
    assert len(calls) == 1 and not execution._clients


@pytest.mark.parametrize('status', ['failed', 'incomplete'])
def test_invalid_terminal_is_not_accepted_when_transport_close_also_fails(repo, monkeypatch, status):
    start(repo, native=True)
    job = new_child(repo)
    calls = transport(monkeypatch, events=[terminal([image_result()], status=status)], close_error=httpx.ReadError('close failed'))
    with pytest.raises((AgentError, httpx.ReadError)):
        execution.NativeAgentImageProvider().run_job(repo.library, job.id)
    assert repo.jobs.get_job(job.id).status == 'failed' and len(calls) == 1


@pytest.mark.parametrize('native_child', [False, True])
def test_repeated_terminal_and_item_events_save_one_image(repo, monkeypatch, native_child):
    start(repo, native=True)
    item_event = {'type': 'response.output_item.done', 'output_index': 0, 'item': image_result()}
    calls = transport(monkeypatch, events=[item_event, item_event, terminal(), terminal([image_result()])])
    if native_child:
        job = new_child(repo)
        execution.NativeAgentImageProvider().run_job(repo.library, job.id)
    else:
        execution.run_request(repo.library, 'request')
        job = repo.jobs.get_job(repo.request('request')['round']['outputTaskIds'][0])
        assert repo.request('request')['state'] == 'completed'
    assert repo.jobs.get_job(job.id).status == 'succeeded'
    assert len(calls) == job_count(repo) == 1


@pytest.mark.parametrize('events,expected,ids', [
    ([delta(sequence=1), delta(sequence=2)], 'hellohello', ['message']),
    ([delta(sequence=None), delta(sequence=None)], 'hellohello', ['message']),
    ([delta(identity=None), delta(identity='late')], 'hello', ['late']),
    ([delta('first', slot=0, identity=None), delta('second', slot=1, identity=None)], 'first\n\nsecond', None),
    ([delta('first', content=0), delta('second', content=1)], 'first\n\nsecond', ['message']),
    ([delta('draft'), {'type': 'response.output_item.done', 'output_index': 0, 'item': text_result('final')}, delta('late', sequence=8)], 'final', ['message']),
    ([delta('draft', identity=None), {'type': 'response.output_item.added', 'output_index': 0, 'item': {**text_result(identity='late'), 'content': []}}, delta(' end', sequence=8, identity='late')], 'draft end', ['late']),
])
def test_delta_identity_and_full_message_replacement(repo, monkeypatch, events, expected, ids):
    start(repo)
    transport(monkeypatch, events=[*events, terminal()])
    output, _ = execution.call_responses(repo, 'request', 1, {})
    request = repo.request('request')
    assert request['round']['assistantContent'] == expected
    assert repo.snapshot(request_id='request')['conversation']['messages'][-1]['content'] == expected
    if ids:
        assert [item['id'] for item in output] == ids
    else:
        assert len(output) == 2


def test_stream_preview_and_persisted_text_share_delta_deduplication(repo, monkeypatch):
    start(repo)
    previews = []
    original = repo.update
    def observe(*args, **kwargs):
        result = original(*args, **kwargs)
        if 'text' in kwargs:
            previews.append(repo.snapshot(request_id='request')['conversation']['messages'][-1]['content'])
        return result
    monkeypatch.setattr(repo, 'update', observe)
    transport(monkeypatch, events=[delta('one', sequence=1), delta('one', sequence=1), delta(' two', sequence=2), terminal()])
    execution.call_responses(repo, 'request', 1, {})
    assert previews[0] == 'one' and previews[-1] == 'one two'
    assert all(value in {'one', 'one two'} for value in previews)
    assert repo.request('request')['round']['assistantContent'] == previews[-1]


def test_identical_delta_sequence_in_later_step_is_a_new_event(repo, monkeypatch):
    start(repo)
    base = [text_result('Planning.', 'first'), {'type': 'function_call', 'id': 'skill-call', 'call_id': 'skill', 'name': 'read_agent_skill', 'arguments': '{}'},
            {'type': 'function_call_output', 'call_id': 'skill', 'output': '{}'}]
    repo.update('request', output=base, text='Planning.')
    calls = transport(monkeypatch, events=[delta('next', sequence=1, identity='second'), terminal()])
    execution.call_responses(repo, 'request', 2, {})
    transport(monkeypatch, events=[delta('again', sequence=1, identity='third'), terminal()])
    execution.call_responses(repo, 'request', 3, {})
    request = repo.request('request')
    assert request['round']['assistantContent'] == 'Planning.\n\nnext\n\nagain'
    assert request['round']['responseOutput'][:3] == base and len(calls) == 1


def test_disconnected_text_retains_deduplicated_preview_in_snapshot(repo, monkeypatch):
    start(repo)
    calls = transport(monkeypatch, events=[delta(), delta()], error=httpx.ReadTimeout('before terminal'))
    execution.run_request(repo.library, 'request')
    assert repo.request('request')['state'] == 'unknown'
    assert repo.snapshot(request_id='request')['conversation']['messages'][-1]['content'] == 'hello'
    assert len(calls) == 1


def test_distinct_messages_without_output_index_never_inherit_each_others_text(repo, monkeypatch):
    start(repo)
    events = [
        {'type': 'response.output_item.added', 'item': {**text_result(identity='first'), 'content': []}},
        {key: value for key, value in delta('First', identity='first', sequence=1).items() if key != 'output_index'},
        {'type': 'response.output_item.done', 'item': text_result('First', 'first')},
        {'type': 'response.output_item.added', 'item': {**text_result(identity='second'), 'content': []}},
        {key: value for key, value in delta('Second', identity='second', sequence=2).items() if key != 'output_index'},
        terminal(),
    ]
    transport(monkeypatch, events=events)
    output, _ = execution.call_responses(repo, 'request', 1, {})
    assert [item['id'] for item in output] == ['first', 'second']
    assert repo.request('request')['round']['assistantContent'] == 'First\n\nSecond'


def test_late_added_image_does_not_replace_completed_item_before_terminal(repo, monkeypatch):
    start(repo, native=True)
    added = {'type': 'response.output_item.added', 'output_index': 0, 'item': {'id': 'image-call', 'type': 'image_generation_call', 'status': 'in_progress'}}
    calls = transport(monkeypatch, events=[added, {'type': 'response.output_item.done', 'output_index': 0, 'item': image_result()}, added, terminal()])
    execution.run_request(repo.library, 'request')
    request = repo.request('request')
    assert request['state'] == 'completed'
    assert repo.jobs.get_job(request['round']['outputTaskIds'][0]).status == 'succeeded'
    assert len(calls) == job_count(repo) == 1


def test_sse_event_id_deduplicates_only_the_same_event(repo, monkeypatch):
    start(repo)
    def frame(identity):
        return f'id: {identity}\ndata: ' + json.dumps(delta(sequence=None)) + '\n\n'
    transport(monkeypatch, events=[frame('one'), frame('one'), frame('two'), terminal()])
    execution.call_responses(repo, 'request', 1, {})
    assert repo.request('request')['round']['assistantContent'] == 'hellohello'


@pytest.mark.parametrize('failure', [httpx.ReadTimeout('after receipt'), httpx.ReadError('after receipt')])
def test_native_child_stops_reading_after_valid_terminal(repo, monkeypatch, failure):
    start(repo, native=True)
    job = new_child(repo)
    calls = transport(monkeypatch, events=[terminal([image_result()])], error=failure)
    execution.NativeAgentImageProvider().run_job(repo.library, job.id)
    assert repo.jobs.get_job(job.id).status == 'succeeded' and len(calls) == 1


@pytest.mark.parametrize('native_child', [False, True])
def test_native_json_without_final_status_is_not_success(repo, monkeypatch, native_child):
    start(repo, native=True)
    calls = transport(monkeypatch, payload={'id': 'response', 'output': [image_result()]})
    if native_child:
        job = new_child(repo)
        with pytest.raises(AgentError):
            execution.NativeAgentImageProvider().run_job(repo.library, job.id)
        assert repo.jobs.get_job(job.id).status == 'failed'
    else:
        execution.run_request(repo.library, 'request')
        assert repo.request('request')['state'] == 'failed' and not repo.request('request')['round']['outputTaskIds']
    assert len(calls) == 1


def test_missing_reference_preflight_is_a_known_failure_without_post(repo, monkeypatch):
    from backend.agent_schemas import AgentRoundCreate
    value = body(repo).model_dump()
    value['prompt'] = 'Use <ref id="round-99-image-1" />'
    repo.create_round('conversation', AgentRoundCreate.model_validate(value))
    calls = transport(monkeypatch, events=[terminal([text_result()])])
    execution.run_request(repo.library, 'request')
    request = repo.request('request')
    assert request['state'] == 'failed' and request['upstream_outcome'] == 'known'
    assert request['error']['code'] == 'reference_missing' and not calls
