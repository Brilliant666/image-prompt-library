"""Paid final results recover locally through the real provider and queue paths."""
import base64
from contextlib import contextmanager, suppress
from io import BytesIO
import json
import sqlite3
import hashlib
from concurrent.futures import ThreadPoolExecutor
from threading import Event,get_ident

import httpx
import pytest
from PIL import Image

from backend.schemas import GenerationJobCreate
from backend.services.generation_jobs import GenerationJobConflict, GenerationJobRepository
from backend.services.openai_compatible import OpenAICompatibleConfig, OpenAICompatibleProvider
from test_agent_image_selection import repo as agent_repo


def picture(color='purple'):
    stream = BytesIO()
    Image.new('RGB', (24, 16), color).save(stream, 'PNG')
    return stream.getvalue()


def test_unsafe_result_root_minimal_descriptor_stays_conservatively_blocked(tmp_path):
    import os
    import subprocess
    from types import SimpleNamespace
    from backend.services.generation_result_recovery import evidence
    library = tmp_path/'library'
    library.mkdir()
    target = tmp_path/'outside'
    target.mkdir()
    root = library/'generation-results'
    if os.name == 'nt':
        subprocess.run(['cmd','/c','mklink','/J',str(root),str(target)],check=True,capture_output=True)
        assert root.lstat().st_file_attributes & 0x400
    else:
        root.symlink_to(target,target_is_directory=True)
    # Resume checks can intentionally supply only these two safe fields.
    job = SimpleNamespace(id='gen_minimal',result_path=None)
    assert evidence(library,job) is True
    assert list(target.iterdir()) == []


@pytest.fixture
def provider_case(tmp_path, monkeypatch):
    library = tmp_path/'library'
    config = OpenAICompatibleConfig(tmp_path/'credentials.json', library)
    monkeypatch.setenv('IMAGE_PROMPT_LIBRARY_OPENAI_COMPATIBLE_CONFIG_PATH', str(config.path))
    config.save({'base_url':'https://images.example/v1', 'api_key':'test-only-key', 'model':'image-model'}, profile_id='p1')
    repo = GenerationJobRepository(library)
    job = repo.create_job(GenerationJobCreate(provider='openai_compatible', model='image-model',
        prompt_text='Synthetic purple square', parameters={'compatible_profile_id':'p1'}))
    calls = []
    def handler(request):
        calls.append(request)
        return httpx.Response(200, json={'data':[{'b64_json':base64.b64encode(picture()).decode()}]})
    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        yield library, repo, job, OpenAICompatibleProvider(config, client), calls


def test_provider_persists_final_image_before_observational_write(provider_case, monkeypatch):
    library, repo, job, provider, calls = provider_case
    original = GenerationJobRepository.record_execution
    def fail_processing(self, job_id, phase=None, **kw):
        if phase == 'processing_results':
            raise sqlite3.OperationalError('synthetic observation write failure')
        return original(self, job_id, phase, **kw)
    monkeypatch.setattr(GenerationJobRepository, 'record_execution', fail_processing)
    with suppress(Exception):
        provider.run_job(library, job.id)
    assert len(calls) == 1
    final = repo.get_job(job.id)
    assert final.status == 'succeeded'
    assert (library/final.result_path).read_bytes() == picture()


@pytest.fixture
def pending_case(provider_case, monkeypatch):
    library, repo, job, provider, calls = provider_case
    with fail_result_database(monkeypatch, 'update'):
        pending = provider.run_job(library,job.id)
        assert pending.status == 'running'
    assert len(calls) == 1
    return provider_case


def test_persistent_database_failure_retains_image_and_receipt(pending_case,monkeypatch):
    library,repo,job,_,calls = pending_case
    receipt = library/'generation-results'/job.id/'local-result.json'
    original = receipt.read_bytes()
    for _ in range(2):
        with fail_result_database(monkeypatch,'update'), pytest.raises(sqlite3.Error):
            repo.recover_local_result(job.id)
    assert receipt.read_bytes() == original
    assert repo.get_job(job.id).status == 'running'
    assert len(calls) == 1
    assert repo.recover_local_result(job.id).status == 'succeeded'


def test_restart_restores_result_before_classifying_interrupted_work(pending_case):
    from backend.services.generation_queue import recover_interrupted_generation_jobs
    library,repo,job,_,calls = pending_case
    assert recover_interrupted_generation_jobs(library,provider='openai_compatible') == []
    restored = GenerationJobRepository(library).get_job(job.id)
    assert restored.status == 'succeeded' and (library/restored.result_path).read_bytes() == picture()
    assert len(calls) == 1


def test_concurrent_recovery_is_one_same_job(pending_case):
    library,repo,job,_,calls = pending_case
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: GenerationJobRepository(library).recover_local_result(job.id),range(2)))
    assert {value.id for value in results} == {job.id}
    assert {value.result_sha256 for value in results} == {hashlib.sha256(picture()).hexdigest()}
    assert repo.list_jobs().total == 1 and len(calls) == 1


def test_sqlite_commit_before_receipt_cleanup_is_idempotent(provider_case,monkeypatch):
    import backend.services.generation_result_recovery as recovery
    library,repo,job,provider,calls = provider_case
    with monkeypatch.context() as context:
        context.setattr(recovery,'clear_receipt',lambda *_:None)
        assert provider.run_job(library,job.id).status == 'succeeded'
    assert (library/'generation-results'/job.id/recovery.RECEIPT_NAME).is_file()
    assert repo.recover_local_result(job.id).status == 'succeeded'
    assert not (library/'generation-results'/job.id/recovery.RECEIPT_NAME).exists()
    assert len(calls) == 1


def test_stale_running_projection_does_not_misclassify_committed_image_as_orphan(provider_case):
    from backend.db import connect
    library,repo,job,provider,calls = provider_case
    with connect(library) as connection:
        stale = connection.execute('SELECT * FROM generation_jobs WHERE id=?',(job.id,)).fetchone()
    assert provider.run_job(library,job.id).status == 'succeeded'
    # A concurrent snapshot had read the old row before result registration.
    projected = repo._record_from_row(stale)
    assert 'local_result_recovery' not in projected.metadata
    assert len(calls) == 1


def test_projection_during_final_commit_cannot_publish_stale_pending_state(provider_case,monkeypatch):
    """Reproduce the epoch/active observation window with a real paid mock.

    A single stale active observation models the interval between incrementing
    the epoch and adding its active job. The old second Path.resolve then yields
    to the worker after the epoch comparison but before its active comparison.
    """
    import inspect
    from pathlib import Path
    from backend.services import generation_jobs as jobs
    library,repo,job,provider,calls = provider_case
    image_ready,release_commit,worker_done = Event(),Event(),Event()
    projection_thread = {'id':None,'stale':False,'resolves':0}
    original_register = GenerationJobRepository._register_local_result
    original_resolve = Path.resolve
    class OneStaleActiveObservation(set):
        def __contains__(self,key):
            if get_ident() == projection_thread['id'] and not projection_thread['stale']:
                projection_thread['stale'] = True
                return False
            return super().__contains__(key)
    def held_register(self,job_id,*args,**kwargs):
        if job_id == job.id:
            image_ready.set()
            assert release_commit.wait(10)
        return original_register(self,job_id,*args,**kwargs)
    def resolve_after_epoch(path,*args,**kwargs):
        if (get_ident() == projection_thread['id']
                and inspect.currentframe().f_back.f_code.co_name == '_record_from_row'):
            projection_thread['resolves'] += 1
            if projection_thread['resolves'] == 2:
                release_commit.set()
                assert worker_done.wait(10)
        return original_resolve(path,*args,**kwargs)
    monkeypatch.setattr(jobs,'_RESULT_STAGING_ACTIVE',OneStaleActiveObservation())
    monkeypatch.setattr(GenerationJobRepository,'_register_local_result',held_register)
    monkeypatch.setattr(Path,'resolve',resolve_after_epoch)
    def generate():
        try: return provider.run_job(library,job.id)
        finally: worker_done.set()
    def project():
        projection_thread['id'] = get_ident()
        return repo.get_job(job.id)
    with ThreadPoolExecutor(max_workers=2) as pool:
        worker = pool.submit(generate)
        try:
            assert image_ready.wait(10)
            projected = pool.submit(project).result(timeout=10)
        finally: release_commit.set()
        assert worker.result(timeout=10).status == 'succeeded'
    assert 'local_result_recovery' not in projected.metadata, {
        'row_status':projected.status,'row_path':projected.result_path,
        'recovery':projected.metadata.get('local_result_recovery'),
        'controlled_observation':projection_thread,
        'actual_status':repo.get_job(job.id).status}
    assert len(calls) == 1


@pytest.mark.parametrize('operation',['retry_failed_job','discard_and_retry_job','mark_stale_running_failed'])
def test_paid_retry_cannot_bypass_pending_local_result(pending_case,operation):
    _,repo,job,_,calls = pending_case
    with pytest.raises(GenerationJobConflict,match='本地'):
        getattr(repo,operation)(job.id)
    assert repo.list_jobs().total == 1 and len(calls) == 1


def test_agent_retry_cannot_bypass_pending_result(pending_case):
    from backend.services.agent_image_retry import AgentImageRetryRepository
    from backend.services.agent_repository import AgentError
    library,repo,job,_,calls = pending_case
    with pytest.raises(AgentError,match='本地'):
        AgentImageRetryRepository(library)._terminal(repo.get_job(job.id))
    assert len(calls) == 1


def test_pending_result_cannot_claim_changed_legacy_reference_identity(pending_case):
    from backend.db import connect
    library,repo,job,_,calls = pending_case
    with connect(library) as connection:
        connection.execute('UPDATE generation_jobs SET reference_image_ids=? WHERE id=?',
                           (json.dumps(['different-reference']),job.id))
    assert repo.local_result_recovery(job.id)['state'] == 'blocked'
    with pytest.raises(GenerationJobConflict): repo.recover_local_result(job.id)
    assert repo.get_job(job.id).result_path is None and len(calls) == 1


@pytest.mark.parametrize('state',['cancelled','discarded','accepted'])
def test_recovery_respects_a_committed_user_action(pending_case,state):
    from backend.db import connect
    library,repo,job,_,calls = pending_case
    if state == 'cancelled':
        repo.cancel_job(job.id)
    else:
        # Exercise committed database state independent of unrelated UI setup.
        with connect(library) as connection:
            connection.execute('UPDATE generation_jobs SET status=? WHERE id=?',(state,job.id))
    with pytest.raises(GenerationJobConflict):
        repo.recover_local_result(job.id)
    assert repo.get_job(job.id).status == state and len(calls) == 1
    assert (library/'generation-results'/job.id/'local-result.json').exists()


@pytest.mark.parametrize('damage',['missing','changed','record','identity','other_job','extra_candidate'])
def test_invalid_or_ambiguous_evidence_is_preserved_and_blocks_paid_retry(pending_case,damage):
    library,repo,job,_,calls = pending_case
    directory = library/'generation-results'/job.id
    receipt = directory/'local-result.json'
    value = json.loads(receipt.read_bytes())
    image = library/value['result']['path']
    if damage == 'missing': image.unlink()
    elif damage == 'changed': image.write_bytes(picture('blue'))
    elif damage == 'record': receipt.write_text('{broken',encoding='utf8')
    elif damage == 'identity':
        value['identity_sha256'] = '0'*64
        receipt.write_text(json.dumps(value),encoding='utf8')
    elif damage == 'other_job':
        value['result']['path'] = 'generation-results/gen_other/result-' + value['result']['sha256'] + '.png'
        receipt.write_text(json.dumps(value),encoding='utf8')
    else: (directory/('result-' + 'a'*64 + '.png')).write_bytes(picture('blue'))
    assert repo.local_result_recovery(job.id)['state'] == 'blocked'
    with pytest.raises(GenerationJobConflict): repo.recover_local_result(job.id)
    with pytest.raises(GenerationJobConflict): repo.retry_failed_job(job.id)
    assert receipt.exists() and len(calls) == 1


def test_failed_receipt_write_keeps_bytes_without_claiming_auto_recovery(provider_case,monkeypatch):
    import backend.services.generation_result_recovery as recovery
    library,repo,job,provider,calls = provider_case
    def disk_error(*_): raise OSError('Synthetic receipt disk failure')
    monkeypatch.setattr(recovery,'_atomic_write_bytes',disk_error)
    pending = provider.run_job(library,job.id)
    assert pending.status == 'running' and len(calls) == 1
    assert len(list((library/'generation-results'/job.id).glob('result-*.png'))) == 1
    assert not (library/'generation-results'/job.id/'local-result.json').exists()
    assert repo.local_result_recovery(job.id) == {'state':'blocked','message':recovery.BLOCKED_MESSAGE,'can_recover':False}
    with pytest.raises(GenerationJobConflict): repo.recover_local_result(job.id)


def test_queue_runner_local_recovery_never_calls_provider(pending_case,monkeypatch):
    from backend.services import generation_queue as queue
    library,repo,job,_,calls = pending_case
    def no_provider(*_): raise AssertionError('Recovery must never reach a supplier')
    monkeypatch.setattr(queue,'_provider_for',no_provider)
    assert queue.run_generation_job_now(library,job.id).status == 'succeeded'
    assert len(calls) == 1
    final = repo.get_job(job.id)
    assert final.status == 'succeeded'
    assert (library/final.result_path).read_bytes() == picture()


def test_pending_queue_head_does_not_hide_later_ordinary_jobs(provider_case,monkeypatch):
    from concurrent.futures import Future
    from backend.services import generation_queue as queue
    library,repo,first,provider,calls = provider_case
    blocked = [first]
    for index in range(7):
        blocked.append(repo.create_job(GenerationJobCreate(provider='openai_compatible',model='image-model',
            prompt_text=f'Synthetic pending head {index}',parameters={'compatible_profile_id':'p1'})))
    for job in blocked:
        with fail_result_database(monkeypatch,'update'),pytest.raises(sqlite3.Error):
            repo.stage_result(job.id,picture(),'synthetic.png')
    ordinary = repo.create_job(GenerationJobCreate(provider='openai_compatible',model='image-model',
        prompt_text='Synthetic ordinary queued job',parameters={'compatible_profile_id':'p1'}))
    assert [job.id for job in repo.next_queued_provider_jobs('openai_compatible',limit=5)] == [ordinary.id]
    monkeypatch.setattr(queue,'_active',set())
    monkeypatch.setattr(queue,'_active_providers',{})
    monkeypatch.setattr(queue,'_futures',{})
    monkeypatch.setattr(queue,'_closing',set())
    monkeypatch.setattr(queue,'_provider_for',lambda _:provider)
    dispatched = []
    class SynchronousExecutor:
        def submit(self,function,*args):
            assert args[1] == ordinary.id
            dispatched.append(args[1])
            result = Future()
            result.set_result(queue._run_provider_job(*args))
            return result
    monkeypatch.setattr(queue,'_executor',SynchronousExecutor())
    queue.enqueue_generation_jobs(library,provider='openai_compatible')
    assert dispatched == [ordinary.id] and len(calls) == 1
    assert repo.get_job(ordinary.id).status == 'succeeded'
    assert all(repo.get_job(job.id).status == 'queued' for job in blocked)


def test_real_sqlite_writer_lock_preserves_and_restores_paid_result(provider_case,monkeypatch):
    library,repo,job,provider,calls = provider_case
    monkeypatch.setattr('backend.db.BUSY_TIMEOUT_SECONDS',0.05)
    holder = sqlite3.connect(library/'db.sqlite')
    generate = provider.generate
    def hold_after_success(*args,**kwargs):
        value = generate(*args,**kwargs)
        holder.execute('BEGIN IMMEDIATE')
        return value
    monkeypatch.setattr(provider,'generate',hold_after_success)
    try:
        assert provider.run_job(library,job.id).metadata['local_result_recovery']
        with pytest.raises(sqlite3.Error,match='locked'):
            repo.recover_local_result(job.id)
        assert len(calls) == 1
        assert (library/'generation-results'/job.id/'local-result.json').is_file()
    finally:
        holder.rollback()
        holder.close()
    assert repo.recover_local_result(job.id).status == 'succeeded'
    assert len(calls) == 1


def test_sse_preview_failure_and_final_registration_failure_restore_locally(provider_case,monkeypatch):
    library,repo,_,provider,calls = provider_case
    provider.config.save({'stream':True,'partial_images':1},profile_id='p1')
    job = repo.create_job(GenerationJobCreate(provider='openai_compatible',model='image-model',
        prompt_text='Synthetic streamed square',parameters={'compatible_profile_id':'p1'}))
    events = [{'type':'image_generation.partial_image','partial_image_index':0,'b64_json':base64.b64encode(picture('gray')).decode()},
              {'type':'image_generation.completed','b64_json':base64.b64encode(picture()).decode()}]
    def handler(request):
        calls.append(request)
        return httpx.Response(200,headers={'content-type':'text/event-stream'},
            content=''.join('data: '+json.dumps(event)+'\n\n' for event in events).encode())
    def bad_preview(*args,**kwargs): raise sqlite3.OperationalError('Synthetic preview failure')
    monkeypatch.setattr(GenerationJobRepository,'stage_stream_preview',bad_preview)
    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        provider.http_client = client
        with fail_result_database(monkeypatch,'update'):
            pending = provider.run_job(library,job.id)
    assert pending.metadata['local_result_recovery'] and len(calls) == 1
    restored = repo.recover_local_result(job.id)
    assert restored.status == 'succeeded' and (library/restored.result_path).read_bytes() == picture()
    assert len(calls) == 1


@pytest.mark.parametrize('stream',[False,True])
def test_native_batch_final_result_restores_without_responses_replay(agent_repo,monkeypatch,stream):
    from test_agent_execution_correctness import start,new_child,transport,image_result,terminal
    from backend.services.agent_execution import NativeAgentImageProvider
    repo = agent_repo
    start(repo,native=True)
    job = new_child(repo)
    image = image_result()
    calls = transport(monkeypatch, payload={'status':'completed','output':[image]},
        events=[terminal([image])] if stream else None)
    with fail_result_database(monkeypatch,'update'):
        assert NativeAgentImageProvider().run_job(repo.library,job.id).metadata['local_result_recovery']
    restored = repo.jobs.recover_local_result(job.id)
    assert restored.status == 'succeeded' and len(calls) == 1
    assert (repo.library/restored.result_path).read_bytes() == base64.b64decode(image['result'])
    assert repo.jobs.get_job(job.id).metadata['agent']['requestId'] == 'request'


def test_native_batch_observation_failure_occurs_after_durable_final_image(agent_repo,monkeypatch):
    from test_agent_execution_correctness import start,new_child,transport,image_result
    from backend.services.agent_execution import NativeAgentImageProvider
    from backend.services.agent_repository import AgentRepository
    repo = agent_repo
    start(repo,native=True)
    job = new_child(repo)
    calls = transport(monkeypatch,payload={'status':'completed','output':[image_result()]})
    original = AgentRepository.record_response_details
    def failed_details(self, request_id, step, payload=None, **kwargs):
        if payload is not None:
            raise sqlite3.OperationalError('Synthetic final response receipt failure')
        return original(self,request_id,step,payload,**kwargs)
    monkeypatch.setattr(AgentRepository,'record_response_details',failed_details)
    with suppress(sqlite3.Error): NativeAgentImageProvider().run_job(repo.library,job.id)
    result = repo.jobs.get_job(job.id)
    assert result.status == 'succeeded' and len(calls) == 1
    assert (repo.library/result.result_path).is_file()


@pytest.mark.parametrize('code,outcome',[('local_result_pending','known'),('upstream_outcome_unknown','unknown')])
def test_agent_regenerate_cannot_repay_unresolved_image_without_a_job(agent_repo,monkeypatch,code,outcome):
    from test_agent_execution_correctness import start
    from test_agent_branch_submission import submit_edit
    start(agent_repo,native=True)
    agent_repo.update('request',state='failed' if outcome=='known' else 'unknown',outcome=outcome,
                     error={'code':code,'message':'Synthetic unresolved paid image'})
    source = agent_repo.request('request')['round']
    assert source['outputTaskIds'] == []
    response, scheduled, _ = submit_edit(agent_repo,monkeypatch,source,origin='regenerate')
    assert response.status_code == 409 and scheduled == []
    assert code in response.text


def test_explicit_edit_new_content_is_not_silently_replayed_or_forbidden(agent_repo,monkeypatch):
    from test_agent_execution_correctness import start
    from test_agent_branch_submission import submit_edit
    start(agent_repo,native=True)
    agent_repo.update('request',state='failed',outcome='known',
                     error={'code':'local_result_pending','message':'Synthetic pending image'})
    source = agent_repo.request('request')['round']
    response, scheduled, _ = submit_edit(agent_repo,monkeypatch,source,origin='edit')
    assert response.status_code == 202 and scheduled == ['edited']
    assert agent_repo.request('edited')['body']['authorization']['allowImageGeneration'] is False


def test_agent_request_local_restore_is_scoped_and_does_not_resume_text_model(agent_repo,monkeypatch):
    from test_agent_execution_correctness import start,new_child,transport,image_result
    from test_agent_image_selection import body
    from backend.services import agent_execution as execution
    start(agent_repo,native=True)
    source = agent_repo.request('request')['round']
    job = new_child(agent_repo)
    calls = transport(monkeypatch,payload={'status':'completed','output':[image_result()]})
    with fail_result_database(monkeypatch,'update'):
        execution.NativeAgentImageProvider().run_job(agent_repo.library,job.id)
    agent_repo.update('request',state='failed',outcome='known',
                     error={'code':'local_result_pending','message':'Synthetic pending image'})
    agent_repo.create_round('conversation',body(agent_repo,'other'))
    other = execution.create_image_job(agent_repo,'other',1,'different-call','single','Other synthetic task',{},native=True)
    with fail_result_database(monkeypatch,'update'),pytest.raises(sqlite3.Error):
        agent_repo.jobs.stage_result(other.id,picture('blue'),'other.png')
    snapshot = agent_repo.recover_request_results('request')
    assert snapshot['request']['id'] == 'request'
    assert agent_repo.jobs.get_job(job.id).status == 'succeeded'
    assert agent_repo.jobs.get_job(other.id).result_path is None
    assert agent_repo.request('request')['error'] is None
    assert agent_repo.request('request')['state'] == 'failed'  # No automatic model resume.
    assert agent_repo.request('request')['round']['prompt'] == source['prompt']
    assert len(calls) == 1
    again = agent_repo.recover_request_results('request')
    assert again['revision'] == snapshot['revision']
    assert len(calls) == 1


@contextmanager
def fail_result_database(monkeypatch, phase):
    import backend.services.generation_jobs as jobs
    original = jobs.connect
    class Connection:
        def __init__(self, conn): self.conn, self.result_write = conn, False
        def execute(self, sql, params=()):
            if sql == 'BEGIN IMMEDIATE' and phase == 'begin':
                raise sqlite3.OperationalError('synthetic BEGIN failure')
            if "SET status='succeeded', result_path" in sql:
                self.result_write = True
                if phase == 'update':
                    raise sqlite3.OperationalError('synthetic UPDATE failure')
            return self.conn.execute(sql, params)
        def commit(self):
            if self.result_write and phase == 'commit':
                raise sqlite3.OperationalError('synthetic COMMIT failure')
            return self.conn.commit()
        def __getattr__(self, name): return getattr(self.conn, name)
    @contextmanager
    def wrapped(*args, **kwargs):
        conn = original(*args, **kwargs)
        try:
            with conn:
                yield Connection(conn)
        finally: conn.close()
    with monkeypatch.context() as context:
        context.setattr(jobs, 'connect', wrapped)
        yield


@pytest.mark.parametrize('phase', ['begin','update','commit'])
def test_worker_local_registration_failure_recovers_same_paid_result(provider_case, monkeypatch, phase):
    library, repo, job, provider, calls = provider_case
    generate = provider.generate
    def generated(*args, **kwargs):
        value = generate(*args, **kwargs)
        # Inject only after the paid mock response has completed.
        fault.__enter__()
        return value
    fault = fail_result_database(monkeypatch, phase)
    monkeypatch.setattr(provider, 'generate', generated)
    try:
        with suppress(Exception): provider.run_job(library, job.id)
        assert len(calls) == 1
        kept = list((library/'generation-results'/job.id).glob('result-*.png'))
        assert len(kept) == 1 and kept[0].read_bytes() == picture()
        evidence = repo.local_result_recovery(job.id)
        assert evidence['state'] == 'pending' and evidence['can_recover'] is True
        assert repo.get_job(job.id).status != 'failed'
    finally:
        fault.__exit__(None, None, None)
    recovered = repo.recover_local_result(job.id)
    assert recovered.id == job.id and recovered.status == 'succeeded'
    assert (library/recovered.result_path).read_bytes() == picture()
    assert repo.recover_local_result(job.id).result_sha256 == recovered.result_sha256
    assert len(calls) == 1
