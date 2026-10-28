"""Passive per-request transport measurements; synthetic data and no paid APIs."""
import json
import socket
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from types import SimpleNamespace

import httpcore
import httpx
import pytest

from backend.db import connect
from backend.services import agent_execution as execution
from backend.services import agent_execution_timing as timing
from backend.services.agent_repository import AgentRepository
from backend.services.api_network import create_api_client
from backend.services.openai_compatible import OpenAICompatibleConfig
from test_agent_execution_correctness import ScriptedStream, repo, start, terminal, text_result


REAL_HANDLE_REQUEST = httpx.HTTPTransport.handle_request
FIELDS = (*timing.TRANSPORT_TIMINGS, 'requestBytes')
PHASES = [('connection.connect_tcp', .1), ('connection.start_tls', .2),
          ('http11.send_request_body', 2), ('http11.receive_response_headers', 5)]


def current_step(repo):
    return AgentRepository(repo.library).snapshot('conversation')['conversation']['rounds'][0]['execution']['modelSteps'][0]


def emit_phases(request, clock, *, fail=None, reuse=False):
    trace = request.extensions['trace']
    for index, (phase, duration) in enumerate(PHASES):
        if reuse and index < 2:
            continue
        if index == 2:
            trace('http11.send_request_headers.started', {'request': request})
            trace('http11.send_request_headers.complete', {'return_value': None})
        trace(phase + '.started', {'request': request, 'private': 'NEVER_STORE'})
        clock[0] += duration
        if index == fail:
            trace(phase + '.failed', {'exception': RuntimeError('NEVER_STORE')})
            raise httpx.ReadTimeout('Synthetic transport failure', request=request)
        trace(phase + '.complete', {'return_value': 'NEVER_STORE'})
        # A duplicated completion must not inflate a duration or add a write.
        trace(phase + '.complete', {'return_value': 'NEVER_STORE'})


@pytest.mark.parametrize('kind', ['json', 'sse', 'completed_then_disconnect'])
@pytest.mark.parametrize('native', [False, True])
def test_real_request_callback_persists_phase_measurements_without_extra_posts(repo, monkeypatch, kind, native):
    start(repo, native=native)
    clock, calls, writes = [100.0], [], []
    monkeypatch.setattr(timing, 'monotonic', lambda: clock[0])
    original_record = AgentRepository.record_execution

    def record(self, *args, **kwargs):
        writes.append(kwargs)
        return original_record(self, *args, **kwargs)

    monkeypatch.setattr(AgentRepository, 'record_execution', record)

    def handler(request):
        calls.append(request)
        assert request.method == 'POST' and request.url.path == '/v1/responses'
        before = len(writes)
        emit_phases(request, clock)
        assert len(writes) == before  # Trace callbacks only collect numbers in memory.
        payload = terminal([text_result('Synthetic answer')])
        if kind == 'json':
            return httpx.Response(200, json=payload['response'])
        close_error = httpx.ReadTimeout('Synthetic close failure') if kind == 'completed_then_disconnect' else None
        chunks = [('data: ' + json.dumps(payload) + '\n\n').encode()]
        return httpx.Response(200, headers={'content-type': 'text/event-stream'},
                              stream=ScriptedStream(chunks, error=close_error, close_error=close_error))

    monkeypatch.setattr(httpx, 'HTTPTransport', lambda **kwargs: httpx.MockTransport(handler))
    execution.run_request(repo.library, 'request')
    step = current_step(repo)
    assert {key: step[key] for key in timing.TRANSPORT_TIMINGS} == {
        'connectionMs': 100, 'tlsMs': 200, 'uploadMs': 2000, 'waitHeadersMs': 5000}
    assert step['requestBytes'] == len(calls[0].content) == int(calls[0].headers['content-length'])
    assert step['headersMs'] == step['firstEventMs'] == step['responseMs'] == 7300
    assert step['state'] == repo.request('request')['state'] == 'completed'
    assert repo.request('request')['round']['assistantContent'] == 'Synthetic answer'
    assert repo.request('request')['usage']['imageJobsCreated'] == 0
    sent = json.loads(calls[0].content)
    assert sent['model'] == 'mock-text' and sent['input'][0]['content'][0]['text'] == 'Create a synthetic orange square'
    assert not any(field in sent for field in FIELDS)
    serialized = json.dumps(step)
    assert 'NEVER_STORE' not in serialized and 'synthetic-text' not in serialized and 'headers' not in step
    assert len([w for w in writes if 'connectionMs' in w]) == 1
    assert len(writes) <= 9
    execution.run_request(repo.library, 'request')
    assert len(calls) == 1


@pytest.mark.parametrize('fail', range(4))
def test_interrupted_phase_stays_unknown_and_completed_phases_survive_without_replay(repo, monkeypatch, fail):
    start(repo)
    clock, calls = [50.0], []
    monkeypatch.setattr(timing, 'monotonic', lambda: clock[0])

    def handler(request):
        calls.append(request)
        emit_phases(request, clock, fail=fail)
        pytest.fail('Synthetic failure did not interrupt')

    monkeypatch.setattr(httpx, 'HTTPTransport', lambda **kwargs: httpx.MockTransport(handler))
    execution.run_request(repo.library, 'request')
    step = current_step(repo)
    assert step['state'] == 'interrupted'
    for index, field in enumerate(timing.TRANSPORT_TIMINGS):
        expected = PHASES[index][1] * 1000 if index < fail else None
        assert step[field] == expected
    assert step['headersMs'] is None and step['firstEventMs'] is None
    assert (step['requestBytes'] is not None) == (fail >= 2)
    assert repo.request('request')['state'] == 'unknown'
    execution.recover_agent_requests(repo.library)
    execution.run_request(repo.library, 'request')
    assert len(calls) == 1


def test_reused_connection_does_not_claim_zero_connection_or_tls_time(repo, monkeypatch):
    start(repo)
    clock = [0.0]
    monkeypatch.setattr(timing, 'monotonic', lambda: clock[0])

    def handler(request):
        emit_phases(request, clock, reuse=True)
        return httpx.Response(200, json=terminal([text_result()])['response'])

    monkeypatch.setattr(httpx, 'HTTPTransport', lambda **kwargs: httpx.MockTransport(handler))
    execution.run_request(repo.library, 'request')
    step = current_step(repo)
    assert step['connectionMs'] is step['tlsMs'] is None
    assert (step['uploadMs'], step['waitHeadersMs'], step['headersMs']) == (2000, 5000, 7000)


@pytest.mark.parametrize('observer_error', [False, True])
def test_unavailable_trace_or_observer_failure_does_not_change_result(repo, monkeypatch, observer_error):
    start(repo)
    calls = []

    def broken_observer(*args):
        raise RuntimeError('Synthetic instrumentation fault')

    if observer_error:
        monkeypatch.setattr(timing.TransportTiming, '_observe', broken_observer)

    def handler(request):
        calls.append(request)
        if observer_error:
            request.extensions['trace']('connection.connect_tcp.started', {})
            request.extensions['trace']('connection.connect_tcp.complete', {})
        return httpx.Response(200, json=terminal([text_result()])['response'])

    monkeypatch.setattr(httpx, 'HTTPTransport', lambda **kwargs: httpx.MockTransport(handler))
    execution.run_request(repo.library, 'request')
    assert repo.request('request')['state'] == 'completed' and len(calls) == 1
    assert all(current_step(repo)[field] is None for field in FIELDS)
    # Existing histories have no transport fields and remain readable as-is.
    with connect(repo.library) as conn:
        row = conn.execute('SELECT id,data FROM agent_rounds').fetchone()
        data = json.loads(row['data'])
        for field in FIELDS:
            data['execution']['modelSteps'][0].pop(field)
        conn.execute('UPDATE agent_rounds SET data=? WHERE id=?', (json.dumps(data), row['id']))
    assert all(field not in current_step(repo) for field in FIELDS)


def test_trace_allowlist_is_bounded_and_never_retains_raw_request_data(monkeypatch):
    clock = [1.0]
    monkeypatch.setattr(timing, 'monotonic', lambda: clock[0])
    observed = timing.TransportTiming()
    for index in range(1000):
        observed.trace(f'private-{index}.started', {'prompt': 'NEVER_STORE'})
    for event in (None, {}, 0):
        observed.trace(event, {'private': 'NEVER_STORE'})
    for size in ('-1', 'NaN', '1.2', '9' * 80, '9007199254740992'):
        observed.trace('http11.send_request_headers.started', {'request': SimpleNamespace(headers=[(b'Content-Length', size.encode())])})
        assert observed.values()['requestBytes'] is None
    observed.trace('http2.send_request_headers.started', {'request': SimpleNamespace(headers=[(b'Content-Length', b'0')])})
    observed.trace('http2.send_request_body.started', {})
    observed.trace('http2.send_request_body.complete', {})
    observed.trace('http2.send_request_body.started', {})
    clock[0] += 100
    observed.trace('http2.send_request_body.complete', {})
    assert observed.values()['requestBytes'] == observed.values()['uploadMs'] == 0
    assert len(observed._started) == 0 and len(observed._closed) == 1 and len(observed._values) == 5
    assert 'NEVER_STORE' not in repr(vars(observed))
    value = timing.empty_execution()
    timing.apply_measurement(value, step=1, requestBytes=True, connectionMs=float('nan'), secret='NEVER_STORE')
    assert value['modelSteps'][0]['requestBytes'] is None and value['modelSteps'][0]['connectionMs'] is None
    assert 'NEVER_STORE' not in json.dumps(value)


@pytest.mark.parametrize('proxy_scheme', ['http', 'https'])
@pytest.mark.parametrize('failure', [None, 'connect_headers', 'origin_tls', 'upload', 'headers'])
def test_real_proxy_transport_measures_origin_post_and_preserves_incomplete_phases(monkeypatch, proxy_scheme, failure):
    """Real HTTPX/httpcore proxy negotiation over an entirely in-memory socket."""
    clock, connections, writes, events = [0.0], [], [], []
    body = b'synthetic-request-NEVER_STORE'
    monkeypatch.setattr(timing, 'monotonic', lambda: clock[0])
    monkeypatch.setattr(socket, 'create_connection', lambda *a, **k: pytest.fail('Unexpected live socket'))
    monkeypatch.setattr(socket, 'getaddrinfo', lambda *a, **k: pytest.fail('Unexpected live DNS'))

    class Stream(httpcore.NetworkStream):
        def __init__(self):
            self.tunneled, self.closed = False, False

        def read(self, max_bytes, timeout=None):
            if not self.tunneled:
                clock[0] += .2
                if failure == 'connect_headers':
                    raise httpcore.ReadTimeout('Synthetic CONNECT failure')
                self.tunneled = True
                return b'HTTP/1.1 200 Connection established\r\n\r\n'
            clock[0] += 5
            if failure == 'headers':
                raise httpcore.ReadTimeout('Synthetic origin headers failure')
            return b'HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok'

        def write(self, buffer, timeout=None):
            writes.append(buffer)
            if buffer == body:
                clock[0] += 3
                if failure == 'upload':
                    raise httpcore.WriteTimeout('Synthetic origin upload failure')

        def start_tls(self, ssl_context, server_hostname=None, timeout=None):
            assert ssl_context.check_hostname
            origin = server_hostname == 'origin.example.invalid'
            clock[0] += .4 if origin else .3
            if origin and failure == 'origin_tls':
                raise httpcore.ConnectError('Synthetic origin TLS failure')
            return self

        def close(self):
            self.closed = True

        def get_extra_info(self, info):
            return None

    stream = Stream()

    class Backend(httpcore.NetworkBackend):
        def connect_tcp(self, host, port, timeout=None, local_address=None, socket_options=None):
            connections.append((host, port))
            clock[0] += .1
            return stream

    observed = timing.TransportTiming()

    def trace(event, info):
        events.append(event)
        observed.trace(event, info)
        if event.endswith('.complete'):
            observed.trace(event, info)  # Duplicate receipts cannot inflate either TLS leg.

    with create_api_client({'network_mode': 'proxy', 'proxy_url': f'{proxy_scheme}://proxy.example.invalid:8080'}, timeout=30) as client:
        client._transport._pool._network_backend = Backend()
        if failure:
            with pytest.raises(httpx.HTTPError):
                client.post('https://origin.example.invalid/responses', content=body, extensions={'trace': trace})
        else:
            response = client.post('https://origin.example.invalid/responses', content=body, extensions={'trace': trace})
            assert response.status_code == 200 and response.content == b'ok'

    values = observed.values()
    assert values['connectionMs'] == 100
    if failure == 'origin_tls':
        assert values['tlsMs'] is None
    elif failure == 'connect_headers':
        assert values['tlsMs'] == (300 if proxy_scheme == 'https' else None)
    else:
        assert values['tlsMs'] == (700 if proxy_scheme == 'https' else 400)
    assert values['uploadMs'] == (3000 if failure in (None, 'headers') else None)
    assert values['waitHeadersMs'] == (5000 if failure is None else None)
    post_started = failure not in ('connect_headers', 'origin_tls')
    assert values['requestBytes'] == (len(body) if post_started else None)
    assert connections == [('proxy.example.invalid', 8080)]
    assert sum(part.startswith(b'CONNECT ') for part in writes) == 1
    assert sum(part.startswith(b'POST ') for part in writes) == int(post_started)
    assert events.count('proxy.start_tls.started') == int(failure != 'connect_headers')
    assert stream.closed and 'NEVER_STORE' not in repr(vars(observed))


def test_loopback_httpcore_populates_real_boundaries_and_exact_body_size(repo, monkeypatch):
    """Exercise installed httpcore callback names against a disposable HTTP server."""
    received = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            content = self.rfile.read(int(self.headers['Content-Length']))
            received.append(content)
            answer = json.dumps(terminal([text_result('Loopback answer')])['response']).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(answer)))
            self.end_headers()
            self.wfile.write(answer)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    worker = Thread(target=server.serve_forever, daemon=True)
    worker.start()
    port = server.server_port

    def only_loopback(self, request):
        assert request.url.host == '127.0.0.1' and request.url.port == port
        return REAL_HANDLE_REQUEST(self, request)

    monkeypatch.setattr(httpx.HTTPTransport, 'handle_request', only_loopback)
    try:
        OpenAICompatibleConfig(library_path=repo.library).save({
            'base_url': f'http://127.0.0.1:{port}/v1', 'api_key': 'synthetic-local', 'model': 'mock-text'}, profile_id='text')
        start(repo)
        execution.run_request(repo.library, 'request')
        step = current_step(repo)
        assert repo.request('request')['state'] == 'completed' and len(received) == 1
        assert step['requestBytes'] == len(received[0])
        assert step['tlsMs'] is None  # Plain HTTP has no TLS phase.
        assert all(step[key] is not None and step[key] >= 0 for key in ('connectionMs', 'uploadMs', 'waitHeadersMs'))
        assert sum(step[key] for key in ('connectionMs', 'uploadMs', 'waitHeadersMs')) <= step['headersMs'] + .01
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=5)
