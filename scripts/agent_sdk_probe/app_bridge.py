"""Development-only JSON-lines bridge into the real Python adapter/queue; no server."""
from __future__ import annotations
import base64
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import traceback

source = Path(sys.argv[1]).resolve()
output = Path(sys.argv[2]).resolve()
workspace = Path(tempfile.mkdtemp(prefix='synthetic-', dir=output))
for key in list(os.environ):
    if key.upper() not in {'SYSTEMROOT', 'WINDIR', 'PATH', 'TEMP', 'TMP', 'PATHEXT', 'COMSPEC', 'PYTHONDONTWRITEBYTECODE'}:
        os.environ.pop(key, None)
os.environ['PYTHONDONTWRITEBYTECODE'] = '1'
os.environ['USERPROFILE'] = str(workspace / 'profile')
os.environ['APPDATA'] = str(workspace / 'profile' / 'AppData' / 'Roaming')
os.environ['LOCALAPPDATA'] = str(workspace / 'profile' / 'AppData' / 'Local')
# Keep default application paths isolated on platforms whose home lookup uses passwd.
Path.home = classmethod(lambda cls: workspace / 'profile')
os.environ['IMAGE_PROMPT_LIBRARY_ALLOWED_HOSTS'] = 'testserver'
for suffix in ('AUTH_PATH', 'GROK_AUTH_PATH', 'CONFIG_PATH', 'OPENAI_COMPATIBLE_CONFIG_PATH', 'CAPTURE_CLIENTS_PATH', 'CAPTURE_ORGANIZER_CONFIG_PATH'):
    os.environ['IMAGE_PROMPT_LIBRARY_' + suffix] = str(workspace / 'config' / (suffix.lower() + '.json'))
original_connect = socket.socket.connect
def loopback_runtime_only(sock, address):
    # Windows asyncio implements its self-pipe using a loopback socket pair.
    if address[0] in {'127.0.0.1', '::1'} and address[1] != 8000:
        return original_connect(sock, address)
    raise AssertionError('External network and production 8000 denied')
socket.socket.connect = loopback_runtime_only
sys.path[:0] = [str(source), str(source / 'tests')]
import httpx
import pytest
from fastapi.testclient import TestClient
from backend.main import create_app
from backend.services import agent_execution as execution
from backend.services.agent_repository import AgentRepository, AgentError, encoded
from backend.db import connect
from test_agent_workspaces import configure, payload, image_bytes

patch = pytest.MonkeyPatch()
library = workspace / 'library'
posts = []
def mock_provider(request):
    assert request.url.host == '127.0.0.1' and request.method == 'POST'
    assert request.url.path in {'/v1/images/generations', '/v1/images/edits'}
    posts.append({'path': request.url.path, 'bytes': len(request.content), 'containsFrozenModel': b'gpt-image-2' in request.content})
    return httpx.Response(200, json={'data': [{'b64_json': base64.b64encode(image_bytes('orange')).decode()}]})
patch.setattr(httpx, 'HTTPTransport', lambda **kw: httpx.MockTransport(mock_provider))
patch.setattr('backend.routers.agent.schedule_request', lambda *args: None)
client_context = TestClient(create_app(library))
client = client_context.__enter__()
config = configure(client, library, 'http://127.0.0.1:1/v1', 'hybrid')
client.post('/api/agent/conversations', json={'id': 'sdk-conversation'})
upload = client.post('/api/agent/uploads', files={'file': ('synthetic.png', image_bytes('blue'), 'image/png')})
assert upload.status_code == 200, upload.text
repo = AgentRepository(library)

def submit(request_id):
    snapshot = client.get('/api/agent/conversations/sdk-conversation').json()
    current = client.get('/api/agent/config').json()
    body = payload(snapshot, current, request_id, 'Optimize the prompt for this synthetic blue rectangle and generate an orange variant.', True)
    body['refs'] = [{'kind': 'upload', 'uploadId': upload.json()['uploadId']}]
    body['activeProfileId'] = 'mock'
    response = client.post('/api/agent/conversations/sdk-conversation/rounds', json=body)
    assert response.status_code == 202, response.text
    return response.json()

submit('sdk-request')
changed = client.put('/api/agent/config', json={'expectedRevision': config['revision'], 'config': {**config['config'], 'imageModel': 'changed-after-submit'}})
assert changed.status_code == 200, changed.text

def dispatch(command):
    action = command['action']
    if action == 'init':
        refs = execution.refs_for_request(repo, repo.request('sdk-request'))
        asset = repo.asset(next(iter(refs.values())))
        return {'imageDataUri': 'data:image/png;base64,' + base64.b64encode(image_bytes('blue')).decode(), 'referenceId': next(iter(refs)), 'assetId': asset['id'], 'assetSha256': asset['sha256'], 'workspace': str(workspace)}
    if action == 'execute':
        request_id = command.get('requestId', 'sdk-request')
        call = {'id': 'fc-sdk', 'call_id': command.get('callId', 'call-image-1'), 'type': 'function_call', 'name': 'generate_image', 'arguments': encoded({'id': 'one', 'prompt': command['prompt']})}
        refs = execution.refs_for_request(repo, repo.request(request_id))
        result = execution.execute_calls(repo, request_id, 1, [call], refs)
        request = repo.request(request_id)
        jobs = [repo.jobs.get_job(jid) for jid in request['round']['outputTaskIds']]
        return {'toolOutput': result, 'jobs': [{'id': job.id, 'status': job.status, 'model': job.model, 'provider': job.provider, 'mode': job.mode, 'prompt': job.prompt_text, 'resultPath': str(library / job.result_path), 'exists': (library / job.result_path).is_file()} for job in jobs], 'posts': list(posts), 'frozenModel': request['frozen']['imageModel'], 'currentModel': client.get('/api/agent/config').json()['config']['imageModel']}
    if action == 'stop':
        submit('sdk-stop-request')
        repo.stop('sdk-stop-request')
        return {'state': repo.request('sdk-stop-request')['state'], 'requestId': 'sdk-stop-request'}
    if action == 'unknown':
        repo.update('sdk-request', state='unknown', outcome='unknown')
        return {'state': repo.request('sdk-request')['state']}
    if action == 'snapshot':
        snap = repo.snapshot(request_id='sdk-request')
        return {'request': snap['request'], 'posts': list(posts)}
    raise ValueError(action)

try:
    for line in sys.stdin:
        try:
            value = dispatch(json.loads(line))
            print(json.dumps({'ok': True, 'value': value}, ensure_ascii=False), flush=True)
        except AgentError as exc:
            print(json.dumps({'ok': False, 'error': exc.code, 'message': exc.message}), flush=True)
        except Exception as exc:
            traceback.print_exc(file=sys.stderr)
            print(json.dumps({'ok': False, 'error': type(exc).__name__, 'message': str(exc)}), flush=True)
finally:
    client_context.__exit__(None, None, None)
    patch.undo()
