"""Native results obtained before job insertion survive portable restore."""
import json
import tarfile

import pytest
from fastapi.testclient import TestClient

from backend.main import create_app
from backend.services import agent_execution as execution
from backend.services.agent_repository import AgentRepository
from backend.services.library_archives import LibraryArchiveError, backup_library, restore_library, verify_backup
from test_agent_image_selection import repo
from test_agent_execution_correctness import start, transport, image_result
from test_agent_native_result_recovery import fail_job_inserts, allow_job_inserts
from test_agent_workspaces import image_bytes


def pending_native(repo,monkeypatch):
    start(repo,native=True)
    calls=transport(monkeypatch,payload={'status':'completed','output':[image_result()]})
    fail_job_inserts(repo)
    execution.run_request(repo.library,'request')
    assert len(calls)==1
    receipt=next((repo.library/'generation-results').glob('*/native-final.json'))
    allow_job_inserts(repo)
    return calls,receipt


def test_native_pre_job_receipt_and_pixels_restore_without_any_post(repo,monkeypatch,tmp_path):
    calls,receipt=pending_native(repo,monkeypatch)
    archive=backup_library(repo.library,tmp_path/'native.tar.gz')
    manifest=verify_backup(archive)
    assert any(entry['path'].endswith('/native-final.json') for entry in manifest['files'])
    with tarfile.open(archive,'r:gz') as tar:
        payload=b''.join(tar.extractfile(member).read() for member in tar.getmembers() if member.isfile())
    assert b'test-secret' not in payload and b'b64_json' not in payload
    restored=tmp_path/'restored-native'
    restore_library(archive,restored,confirm=True)
    reopened=AgentRepository(restored)
    report=reopened.jobs.recover_local_results()
    assert len(report['recovered'])==1 and not report['blocked']
    snapshot=reopened.snapshot('conversation','request')
    assert len(snapshot['jobs'])==1 and snapshot['jobs'][0]['status']=='succeeded'
    job=reopened.jobs.get_job(snapshot['jobs'][0]['id'])
    assert (restored/job.result_path).read_bytes()==image_bytes()
    assert reopened.request('request')['round']['outputTaskIds']==[job.id]
    assert reopened.jobs.recover_local_results()['recovered']==[]
    assert len(calls)==1


def test_backup_rejects_extra_secret_in_native_recovery_envelope(repo,monkeypatch,tmp_path):
    calls,receipt=pending_native(repo,monkeypatch)
    data=json.loads(receipt.read_bytes())
    data['raw_response']={'authorization':'Bearer private-canary'}
    receipt.write_text(json.dumps(data),encoding='utf8')
    with pytest.raises(LibraryArchiveError,match='recovery'):
        backup_library(repo.library,tmp_path/'must-not-publish-native.tar.gz')
    assert receipt.is_file() and len(calls)==1


def test_native_original_request_http_recovery_is_visible_and_idempotent(repo,monkeypatch):
    calls,_=pending_native(repo,monkeypatch)
    before=repo.request('request')
    client=TestClient(create_app(library_path=repo.library))
    for _ in range(2):
        response=client.post('/api/agent/requests/request/recover-results')
        assert response.status_code==200,response.text
        snapshot=response.json()
        assert snapshot['conversation']['id']=='conversation'
        assert len(snapshot['jobs'])==1 and snapshot['jobs'][0]['status']=='succeeded'
    after=repo.request('request')
    assert after['id']==before['id'] and after['round_id']==before['round_id']
    assert after['usage']['responseStepsStarted']==before['usage']['responseStepsStarted']
    assert len(calls)==1
