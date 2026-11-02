"""The integrated trial retains result continuity across native image protocols."""
import json

import httpx
import pytest

from backend.agent_schemas import AgentImageConfig, AgentRef
from backend.services import agent_execution as execution
from backend.services.agent_repository import AgentError
from test_agent_image_selection import repo, body
from test_agent_workspaces import image_bytes
from test_native_provider_workflows import configure_native, image_response, wire_pixels


def native_turn(repo, identity, prompt, *, parent=None, refs=(), images=True, selection=False, options=None):
    value = body(repo, identity, images=images)
    value = value.model_copy(update={
        'prompt': prompt, 'parentRoundId': parent,
        'refs': [AgentRef.model_validate(ref) for ref in refs],
        'params': value.params.model_copy(update={
            'size': 'auto', 'quality': 'auto', 'output_format': 'auto', 'provider_options': options or {}}),
    })
    if selection:
        value = value.model_copy(update={'imageConfig': AgentImageConfig(
            profileId='image_a', model=repo.config()['config']['imageModel'])})
    repo.create_round('conversation', value)
    execution.run_request(repo.library, identity)
    result = repo.request(identity)
    assert result['state'] == 'completed', result['error']
    return result


@pytest.mark.parametrize('protocol', ['gemini_native', 'seedream_native'])
def test_hybrid_native_followup_sends_last_result_then_auxiliary_and_explicit_original_wins(repo, monkeypatch, protocol):
    configure_native(repo, protocol)
    original = repo.store_asset(image_bytes('red'), None)['id']
    auxiliary = repo.store_asset(image_bytes('blue'), None)['id']
    calls, image_inputs, response_inputs = [], [], []

    def respond(request):
        calls.append(request)
        payload = json.loads(request.content)
        if request.url.path.endswith('/responses'):
            response_inputs.append(payload)
            args = {'images': [{'id': 'one', 'prompt': '  Exact native edit\nPreserve whitespace.  '}],
                    'finish_after_generation': True}
            if len(response_inputs) == 1:
                args['referenceSelection'] = {
                    'targetRef': 'round-1-reference-1',
                    'auxiliaries': [{'ref': 'round-1-reference-2', 'role': 'lighting'}],
                }
            return httpx.Response(200, json={'status': 'completed', 'output': [{
                'type': 'function_call', 'id': 'native-edit', 'call_id': 'native-edit',
                'name': 'generate_image_batch', 'arguments': json.dumps(args)}]})
        image_inputs.append(wire_pixels(protocol, payload))
        return httpx.Response(200, json=image_response(protocol))

    monkeypatch.setattr(httpx, 'HTTPTransport', lambda **kw: httpx.MockTransport(respond))
    first = native_turn(repo, 'first', 'Edit the first image using the second image for lighting', refs=[
        {'kind': 'upload', 'uploadId': original}, {'kind': 'upload', 'uploadId': auxiliary}])
    first_job = repo.jobs.get_job(first['round']['outputTaskIds'][0])
    assert first_job.status == 'succeeded' and first_job.parameters['protocol'] == protocol
    assert image_inputs == [[image_bytes('red'), image_bytes('blue')]]
    preserved_prompt = first_job.prompt_text
    preserved_request = json.dumps(first, sort_keys=True)

    following = native_turn(repo, 'follow', '头部自然一些，其他保持', parent=first['round']['id'])
    target = following['round']['editingTask']['target']
    assert target['source'] == {'kind': 'job', 'jobId': first_job.id}
    assert image_inputs[-1] == [image_bytes('green'), image_bytes('blue')]
    assert repo.data_url(target['assetId']) in json.dumps(response_inputs[-1])
    assert repo.jobs.get_job(first_job.id).prompt_text == preserved_prompt
    assert json.dumps(repo.request('first'), sort_keys=True) == preserved_request

    explicit = native_turn(repo, 'original', '<ref id="round-1-reference-1" /> 修改背景',
                           parent=following['round']['id'])
    assert explicit['round']['editingTask']['target']['assetId'] == original
    # An explicit single-image selection may narrow the old auxiliary set;
    # the original subject must be used instead of the latest green result.
    assert image_inputs[-1] == [image_bytes('red')]
    assert len(calls) == 6 and len(response_inputs) == len(image_inputs) == 3
    assert all(job.parameters['protocol'] == protocol for job in repo.jobs.list_jobs().jobs)


@pytest.mark.parametrize('protocol', ['gemini_native', 'seedream_native'])
@pytest.mark.parametrize('selection', [False, True])
def test_hybrid_native_image_mode_off_only_calls_text_response(repo, monkeypatch, protocol, selection):
    configure_native(repo, protocol)
    calls = []
    def respond(request):
        calls.append(request)
        assert request.url.path.endswith('/responses')
        payload = json.loads(request.content)
        assert all(tool.get('name') not in {'generate_image', 'generate_image_batch', 'continue_generation'}
                   and tool['type'] != 'image_generation' for tool in payload['tools'])
        return httpx.Response(200, json={'status': 'completed', 'output': [{
            'type': 'message', 'id': 'answer', 'role': 'assistant',
            'content': [{'type': 'output_text', 'text': 'Synthetic text-only answer'}]}]})
    monkeypatch.setattr(httpx, 'HTTPTransport', lambda **kw: httpx.MockTransport(respond))
    result = native_turn(repo, 'text-only', 'Explain the synthetic composition', images=False, selection=selection)
    assert len(calls) == 1 and not result['round']['outputTaskIds']
    assert repo.jobs.list_jobs().total == 0


@pytest.mark.parametrize('protocol', ['gemini_native', 'seedream_native'])
def test_text_only_explicit_image_config_still_rejects_unmapped_native_options(repo, monkeypatch, protocol):
    configure_native(repo, protocol)
    calls = []
    monkeypatch.setattr(httpx, 'HTTPTransport', lambda **kw: httpx.MockTransport(
        lambda request: calls.append(request) or httpx.Response(503)))
    with pytest.raises(AgentError) as caught:
        native_turn(repo, 'invalid-options', 'Only a synthetic text question', images=False,
                    selection=True, options={'unmapped_native_option': True})
    assert caught.value.code == 'invalid_parameters'
    assert calls == [] and repo.jobs.list_jobs().total == 0
