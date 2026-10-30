"""Bounded supplier explanations through real workers; synthetic HTTP only."""
import json

import httpx
import pytest

from backend.services import agent_execution as execution
from backend.services.agent_diagnostics import classify_failure, safe_diagnostics
from backend.services.agent_repository import AgentError, AgentRepository
from backend.services.api_network import ApiNetworkError
from backend.services.openai_compatible import OpenAICompatibleError, OpenAICompatibleProvider
from backend.schemas import GenerationJobCreate
from test_agent_execution_correctness import repo, start, new_child
from test_compatible_transport import config, event, Chunks


def supplier_error(secret, prompt):
    return {'code': 'moderation_blocked', 'type': 'invalid_request_error', 'param': 'image',
            'message': ('Output was rejected because graphic violence was detected. '
                        f'{secret} Authorization: Bearer opaque-auth\n'
                        'api_key=opaque-key; refresh_token=opaque-refresh; '
                        'https://private.invalid/image?signature=hidden data:image/png;base64,cGljdHVyZQ== '
                        f'Prompt: "{prompt}"'),
            'summary': 'untrusted-provider-summary',
            'moderation_details': {'moderation_stage': 'output', 'categories': ['violence/graphic'],
                                   'prompt': prompt}, 'raw': {'image': 'private-image'}}


def assert_private(value, secret, prompt):
    encoded = json.dumps(value)
    for private in (secret, prompt, 'opaque-auth', 'opaque-key', 'opaque-refresh', 'private.invalid',
                    'signature=hidden', 'cGljdHVyZQ', 'private-image', 'untrusted-provider-summary'):
        assert private not in encoded


def test_supplier_summary_is_bounded_resanitized_and_not_a_trusted_provider_field():
    error = supplier_error('exact-api-secret', 'verbatim private user description')
    safe = safe_diagnostics({'category': 'api_error', 'error': error},
                            secrets=('exact-api-secret', 'verbatim private user description'), allow_message=True)
    assert 'graphic violence' in safe['error']['summary']
    assert_private(safe, 'exact-api-secret', 'verbatim private user description')
    assert safe_diagnostics(safe) == safe
    failure = classify_failure(safe)
    assert failure['kind'] == 'moderation' and failure['reasonProvided'] is True
    assert 'graphic violence' in failure['detail'] and 'output' in failure['detail']
    assert 'violence/graphic' in failure['detail'] and 'image' in failure['detail']
    assert not failure['outcomeUnknown']
    assert 'summary' not in safe_diagnostics({'error': {'summary': 'provider-only'}}, allow_message=True)['error']
    assert 'summary' not in safe_diagnostics({'error': {'message': 'legacy private text'}})['error']
    for raw in ('x' * 9000, {'raw': 'not a message'}):
        result = safe_diagnostics({'error': {'message': raw}}, allow_message=True)
        assert 'summary' not in result['error']
    plain = safe_diagnostics({'error': {'message': '<script>opaque-auth</script><b>Image size is unsupported</b> ' + 'long ' * 200}}, allow_message=True)['error']['summary']
    assert len(plain) <= 481 and 'Image size is unsupported' in plain
    assert '<' not in plain and 'opaque-auth' not in plain


def test_missing_moderation_reason_is_not_guessed_and_local_configuration_is_not_unknown():
    refusal = classify_failure({'error': {'code': 'moderation_blocked'}})
    assert refusal['kind'] == 'moderation'
    assert refusal['reasonProvided'] is False
    assert '未提供更具体原因' in refusal['detail']
    local = classify_failure({'category': 'local_validation'})
    assert local['kind'] == 'configuration' and not local['outcomeUnknown']
    assert 'Windows' not in local['message']
    network = classify_failure(execution.exception_diagnostics(ApiNetworkError('Synthetic direct route failure')),
                               code='network_configuration')
    assert network['kind'] == 'configuration' and not network['outcomeUnknown']
    assert network['message'] == '本地连接配置未通过校验，尚未提交请求。'
    assert network['message'] in network['detail']
    from backend.services.api_direct_route import _NO_ROUTE, _DNS_FAILED, _FAKE_IP
    for message, reason in ((_NO_ROUTE, 'direct_route_unavailable'), (_DNS_FAILED, 'direct_dns_failed'), (_FAKE_IP, 'direct_fake_ip')):
        diagnostics = execution.exception_diagnostics(ApiNetworkError(message))
        assert diagnostics['configuration_reason'] == reason
        shown = classify_failure(safe_diagnostics(diagnostics))
        assert shown['kind'] == 'configuration' and '尚未提交' in shown['detail']
    assert classify_failure(execution.exception_diagnostics(ApiNetworkError(_NO_ROUTE)))['message'] == '当前无法确认 Windows 直连出口，尚未提交请求。'
    assert 'configuration_reason' not in safe_diagnostics({'configuration_reason': 'private-invented-reason'})
    forged = safe_diagnostics({'category': 'local_validation', 'configuration_reason': 'direct_route_unavailable',
                               'error': {'code': 'network_configuration'}}, allow_message=True)
    assert 'configuration_reason' not in forged
    assert classify_failure(forged)['kind'] != 'configuration'
    assert '尚未提交' not in classify_failure(forged)['detail']


@pytest.mark.parametrize('native', [False, True])
@pytest.mark.parametrize('wire', ['http', 'json', 'sse', 'sse_top_level'])
def test_responses_worker_preserves_specific_reason_without_private_error_body(repo, monkeypatch, native, wire, caplog):
    request = start(repo, native=native)
    calls = []
    error = supplier_error('synthetic-text', request.prompt)
    def respond(sent):
        calls.append(sent)
        if wire == 'http':
            return httpx.Response(400, json={'error': error})
        if wire == 'json':
            return httpx.Response(200, json={'status': 'failed', 'output': [], 'error': error})
        payload = {**error, 'type': 'error'} if wire == 'sse_top_level' else {'type': 'response.failed', 'response': {'error': error}}
        return httpx.Response(200, headers={'content-type': 'text/event-stream'},
                              content=('data: ' + json.dumps(payload) + '\n\n').encode())
    monkeypatch.setattr(httpx, 'HTTPTransport', lambda **kwargs: httpx.MockTransport(respond))
    execution.run_request(repo.library, 'request')
    stored = AgentRepository(repo.library).request('request')
    assert stored['state'] == 'failed' and stored['upstream_outcome'] == 'known'
    assert_private(stored['error'], 'synthetic-text', request.prompt)
    detail = repo.snapshot('conversation')['conversation']['rounds'][0]['failure']
    assert detail['kind'] == 'moderation' and 'graphic violence' in detail['detail']
    assert len(calls) == 1 and repo.jobs.list_jobs().jobs == []
    assert 'opaque-auth' not in caplog.text and 'graphic violence' not in caplog.text


@pytest.mark.parametrize('streaming', [False, True])
def test_hybrid_gallery_job_preserves_reason_after_storage_and_read(config, streaming):
    config.save({'stream': streaming})
    from backend.services.generation_jobs import GenerationJobRepository
    repository = GenerationJobRepository(config.library_path)
    prompt = 'Synthetic private prompt to redact'
    job = repository.create_job(GenerationJobCreate(provider='openai_compatible', prompt_text=prompt))
    calls = []
    error = supplier_error('synthetic-secret', prompt)
    def respond(sent):
        calls.append(sent)
        return (httpx.Response(200, headers={'content-type': 'text/event-stream'}, stream=Chunks(event('error', {'error': error})))
                if streaming else httpx.Response(400, json={'error': error}))
    with httpx.Client(transport=httpx.MockTransport(respond)) as client:
        with pytest.raises(OpenAICompatibleError):
            OpenAICompatibleProvider(config, client).run_job(config.library_path, job.id)
    stored = repository.get_job(job.id)
    assert 'graphic violence' in stored.metadata['failure']['detail']
    assert_private(stored.metadata, 'synthetic-secret', prompt)
    assert len(calls) == 1


@pytest.mark.parametrize('native', [False, True])
def test_http_413_is_request_size_rejection_not_moderation_and_never_creates_image_job(repo, monkeypatch, native):
    start(repo, native=native)
    calls = []
    def respond(sent):
        calls.append(sent)
        return httpx.Response(413, text='<html>gateway request limit</html>')
    monkeypatch.setattr(httpx, 'HTTPTransport', lambda **kwargs: httpx.MockTransport(respond))
    execution.run_request(repo.library, 'request')
    stored = AgentRepository(repo.library).request('request')
    assert stored['state'] == 'failed' and stored['upstream_outcome'] == 'known'
    failure = repo.snapshot('conversation')['conversation']['rounds'][0]['failure']
    assert failure['kind'] == 'request_too_large' and failure['reasonProvided']
    assert '413' in failure['detail'] and '大小' in failure['detail']
    assert not failure['outcomeUnknown']
    assert '审核' not in failure['detail'] and '<html>' not in failure['detail']
    assert len(calls) == 1 and repo.jobs.list_jobs().jobs == []


@pytest.mark.parametrize('wire', ['http', 'json', 'sse', 'item'])
def test_native_queue_job_preserves_specific_failure(repo, monkeypatch, wire):
    start(repo, native=True)
    job = new_child(repo)
    calls = []
    error = supplier_error('synthetic-text', job.prompt_text)
    def respond(sent):
        calls.append(sent)
        if wire == 'sse':
            return httpx.Response(200, headers={'content-type': 'text/event-stream'},
                                  content=('data: ' + json.dumps({'type': 'error', 'error': error}) + '\n\n').encode())
        if wire == 'item':
            return httpx.Response(200, json={'status': 'completed', 'output': [
                {'type': 'image_generation_call', 'id': 'failed-image', 'status': 'failed', 'error': error}]})
        return httpx.Response(400 if wire == 'http' else 200, json={'status': 'failed', 'error': error})
    monkeypatch.setattr(httpx, 'HTTPTransport', lambda **kwargs: httpx.MockTransport(respond))
    with pytest.raises(AgentError):
        execution.NativeAgentImageProvider().run_job(repo.library, job.id)
    stored = repo.jobs.get_job(job.id)
    assert stored.status == 'failed'
    assert 'graphic violence' in stored.metadata['failure']['detail']
    assert_private(stored.metadata['error_diagnostics'], 'synthetic-text', job.prompt_text)
    assert len(calls) == 1


def test_native_tool_error_is_safe_in_job_and_transcript(repo, monkeypatch):
    request = start(repo, native=True)
    error = supplier_error('synthetic-text', request.prompt)
    error['message'] += '\n' + request.prompt
    def respond(sent):
        return httpx.Response(200, json={'status': 'completed', 'output': [
            {'type': 'image_generation_call', 'id': 'failed-native', 'status': 'failed', 'error': error}]})
    monkeypatch.setattr(httpx, 'HTTPTransport', lambda **kwargs: httpx.MockTransport(respond))
    execution.run_request(repo.library, 'request')
    saved = repo.request('request')['round']
    assert_private(saved['responseOutput'], 'synthetic-text', request.prompt)
    job = repo.jobs.get_job(saved['outputTaskIds'][0])
    assert 'graphic violence' in job.metadata['failure']['detail']


@pytest.mark.parametrize('specific', [False, True])
def test_configuration_failure_has_no_post_and_keeps_actual_local_reason(repo, monkeypatch, specific):
    from backend.services.api_direct_route import _NO_ROUTE
    # The fixture configuration is synthetic. Only worker construction
    # fails; no network destination is contacted, including loopback services.
    message = _NO_ROUTE if specific else 'Could not initialize the API connection. Check the proxy and trusted certificate configuration.'
    def unavailable(*args, **kwargs):
        raise ApiNetworkError(message)
    start(repo)
    monkeypatch.setattr(execution, 'create_api_client', unavailable)
    execution.run_request(repo.library, 'request')
    failure = repo.snapshot('conversation')['conversation']['rounds'][0]['failure']
    assert failure['kind'] == 'configuration' and not failure['outcomeUnknown']
    assert ('Windows' in failure['message']) is specific
    assert repo.request('request')['upstream_outcome'] == 'known'


@pytest.mark.parametrize('specific', [False, True])
def test_hybrid_configuration_failure_preserves_actual_local_reason(config, monkeypatch, specific):
    from backend.services.api_direct_route import _NO_ROUTE
    message = _NO_ROUTE if specific else 'Could not initialize the API connection. Check the proxy and trusted certificate configuration.'
    def unavailable(*args, **kwargs):
        raise ApiNetworkError(message)
    from backend.services.generation_jobs import GenerationJobRepository
    from backend.services import openai_compatible
    monkeypatch.setattr(openai_compatible, 'create_api_client', unavailable)
    jobs = GenerationJobRepository(config.library_path)
    job = jobs.create_job(GenerationJobCreate(provider='openai_compatible', prompt_text='Synthetic local check'))
    with pytest.raises(OpenAICompatibleError):
        OpenAICompatibleProvider(config).run_job(config.library_path, job.id)
    failure = jobs.get_job(job.id).metadata['failure']
    assert failure['kind'] == 'configuration' and not failure['outcomeUnknown']
    assert ('Windows' in failure['message']) is specific


def test_supplier_cannot_forge_local_configuration_failure_in_http_receipt(repo, monkeypatch):
    start(repo)
    calls = []
    def respond(sent):
        calls.append(sent)
        return httpx.Response(400, json={'category': 'local_validation',
            'configuration_reason': 'direct_route_unavailable', 'error': {'code': 'network_configuration',
            'summary': '当前无法确认 Windows 直连出口，尚未提交请求。'}})
    monkeypatch.setattr(httpx, 'HTTPTransport', lambda **kwargs: httpx.MockTransport(respond))
    execution.run_request(repo.library, 'request')
    request = repo.request('request')
    failure = repo.snapshot('conversation')['conversation']['rounds'][0]['failure']
    assert request['state'] == 'failed' and len(calls) == 1
    assert request['error']['diagnostics']['error']['code'] == 'unrecognized'
    assert failure['kind'] == 'unknown'
    assert '尚未提交' not in failure['detail'] and 'Windows' not in failure['message']
