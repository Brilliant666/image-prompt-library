"""Portable backups retain proven paid bytes and only safe local receipts."""
import base64
import hashlib
from io import BytesIO
import json
import sqlite3
import tarfile

from fastapi.testclient import TestClient
import httpx
from PIL import Image
import pytest

from backend.main import create_app
from backend.schemas import GenerationJobCreate
from backend.services.generation_jobs import GenerationJobRepository
from backend.services.library_archives import LibraryArchiveError, backup_library, restore_library, verify_backup
from backend.services.openai_compatible import OpenAICompatibleConfig, OpenAICompatibleProvider


@pytest.fixture
def obtained_result(tmp_path, monkeypatch):
    library = tmp_path/'library'
    config = OpenAICompatibleConfig(tmp_path/'provider-private.json', library)
    monkeypatch.setenv('IMAGE_PROMPT_LIBRARY_OPENAI_COMPATIBLE_CONFIG_PATH', str(config.path))
    config.save({'base_url':'https://images.example/v1','api_key':'sk-test-private-archive-canary',
                 'model':'synthetic-image-model'}, profile_id='test')
    repository = GenerationJobRepository(library)
    job = repository.create_job(GenerationJobCreate(provider='openai_compatible',
        prompt_text='  Synthetic archive image.\n Preserve whitespace. ',
        parameters={'compatible_profile_id':'test'}))
    stream = BytesIO()
    Image.new('RGB',(18,12),'blue').save(stream,'PNG')
    data = stream.getvalue()
    calls = []
    def respond(request):
        calls.append(request)
        return httpx.Response(200,json={'data':[{'b64_json':base64.b64encode(data).decode()}]})
    def unavailable(*args,**kwargs):
        raise sqlite3.OperationalError('Synthetic local registration failure')
    with monkeypatch.context() as patch, httpx.Client(transport=httpx.MockTransport(respond)) as client:
        patch.setattr(GenerationJobRepository,'_register_local_result',unavailable)
        OpenAICompatibleProvider(config,client).run_job(library,job.id)
    assert len(calls)==1
    return library,repository,job,data,calls


def test_pending_result_round_trip_restores_locally_on_same_job(obtained_result,tmp_path,monkeypatch):
    library,repository,job,data,calls=obtained_result
    archive=backup_library(library,tmp_path/'recoverable.tar.gz')
    manifest=verify_backup(archive)
    paths={entry['path'] for entry in manifest['files']}
    assert f'library/generation-results/{job.id}/local-result.json' in paths
    assert not any(path.endswith(('-wal','-shm')) for path in paths)
    with tarfile.open(archive,'r:gz') as tar:
        contents=b''.join(tar.extractfile(member).read() for member in tar.getmembers() if member.isfile())
    assert b'sk-test-private-archive-canary' not in contents
    assert b'b64_json' not in contents
    restored=tmp_path/'restored'
    restore_library(archive,restored,confirm=True)
    def forbidden(*args,**kwargs): raise AssertionError('Local recovery cannot contact a supplier')
    monkeypatch.setattr(OpenAICompatibleProvider,'run_job',forbidden)
    reopened=GenerationJobRepository(restored)
    before=reopened.get_job(job.id)
    assert before.metadata['local_result_recovery']['state']=='pending'
    with TestClient(create_app(library_path=restored)) as client:
        # Startup may already have recovered it. Explicit replay remains local.
        result=client.post(f'/api/generation-jobs/{job.id}/recover-result')
        assert result.status_code==200,result.text
        assert result.json()['id']==job.id and result.json()['status']=='succeeded'
        again=client.post(f'/api/generation-jobs/{job.id}/recover-result')
        assert again.status_code==200 and again.json()['id']==job.id
    final=reopened.get_job(job.id)
    assert final.prompt_text==job.prompt_text
    assert final.result_sha256==hashlib.sha256(data).hexdigest()
    assert (restored/final.result_path).read_bytes()==data
    assert reopened.list_jobs().total==1 and len(calls)==1


def test_recover_http_action_and_lost_response_replay_never_enqueue(obtained_result,monkeypatch):
    from backend.services import generation_queue
    library,repository,job,data,calls=obtained_result
    def forbidden(*args,**kwargs): raise AssertionError('Recovery must not enqueue generation')
    monkeypatch.setattr(generation_queue,'enqueue_generation_jobs',forbidden)
    # Avoid startup recovery so this exercises the production HTTP action itself.
    client=TestClient(create_app(library_path=library))
    for _ in range(2):
        result=client.post(f'/api/generation-jobs/{job.id}/recover-result')
        assert result.status_code==200,result.text
        assert result.json()['id']==job.id and result.json()['status']=='succeeded'
    assert repository.list_jobs().total==1
    assert (library/repository.get_job(job.id).result_path).read_bytes()==data
    assert len(calls)==1


def test_invalid_receipt_blocks_recover_and_both_paid_retry_endpoints(obtained_result):
    library,repository,job,_,calls=obtained_result
    receipt=library/'generation-results'/job.id/'local-result.json'
    receipt.write_bytes(b'{bad receipt')
    client=TestClient(create_app(library_path=library))
    for action in ('recover-result','retry','discard-and-retry'):
        response=client.post(f'/api/generation-jobs/{job.id}/{action}')
        assert response.status_code==409,response.text
    assert repository.list_jobs().total==1 and len(calls)==1
    assert receipt.read_bytes()==b'{bad receipt'


@pytest.mark.parametrize('change',['secret','wrong_job','wrong_hash'])
def test_backup_does_not_copy_invalid_or_secret_recovery_records(obtained_result,tmp_path,change):
    library,_,job,_,_=obtained_result
    path=library/'generation-results'/job.id/'local-result.json'
    record=json.loads(path.read_bytes())
    if change=='secret': record['api_key']='private-canary-not-allowed'
    elif change=='wrong_job': record['job_id']='gen_unrelated'
    else: record['result']['sha256']='0'*64
    path.write_text(json.dumps(record),encoding='utf8')
    with pytest.raises(LibraryArchiveError,match='recovery'):
        backup_library(library,tmp_path/'must-not-publish.tar.gz')
    assert path.is_file()
    assert not (tmp_path/'must-not-publish.tar.gz').exists()


def test_cancelled_result_is_archived_without_silent_revival(obtained_result,tmp_path):
    library,repository,job,data,calls=obtained_result
    repository.cancel_job(job.id)
    archive=backup_library(library,tmp_path/'cancelled.tar.gz')
    restored=tmp_path/'cancelled-restored'
    restore_library(archive,restored,confirm=True)
    reopened=GenerationJobRepository(restored)
    report=reopened.recover_local_results()
    assert job.id in report['blocked']
    assert reopened.get_job(job.id).status=='cancelled'
    assert (restored/'generation-results'/job.id/'local-result.json').is_file()
    assert len(calls)==1


def test_wal_checkpoint_during_enumeration_uses_consistent_sqlite_snapshot(obtained_result,tmp_path,monkeypatch):
    from backend.services import library_archives as archives
    library,_,job,data,calls=obtained_result
    database=library/'db.sqlite'
    holder=sqlite3.connect(database)
    try:
        holder.execute('PRAGMA wal_checkpoint(TRUNCATE)')
        holder.execute('PRAGMA wal_autocheckpoint=0')
        holder.execute('CREATE TABLE checkpoint_sentinel(value BLOB)')
        holder.execute('INSERT INTO checkpoint_sentinel VALUES (?)',(b'x'*128000,))
        holder.commit()
        original=archives._open_regular_source
        triggered=[]
        def checkpoint_after_open(path):
            handle,info=original(path)
            if path==database and not triggered:
                triggered.append(True)
                holder.execute('PRAGMA wal_checkpoint(TRUNCATE)')
            return handle,info
        monkeypatch.setattr(archives,'_open_regular_source',checkpoint_after_open)
        archive=backup_library(library,tmp_path/'checkpoint.tar.gz')
        assert triggered
        verify_backup(archive)
        restored=tmp_path/'checkpoint-restored'
        restore_library(archive,restored,confirm=True)
        connection=sqlite3.connect(restored/'db.sqlite')
        try:
            assert connection.execute('SELECT length(value) FROM checkpoint_sentinel').fetchone()[0]==128000
        finally: connection.close()
        assert len(calls)==1
    finally: holder.close()
