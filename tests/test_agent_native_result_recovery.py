"""Validated Native finals survive failures before the first generation row."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
import json
import sqlite3
import base64

import pytest

from backend.db import connect
from backend.services import agent_execution as execution
from backend.services.agent_repository import AgentRepository
from backend.agent_schemas import AgentRef
from test_agent_image_selection import repo, body, set_mode
from test_agent_execution_correctness import start, transport, image_result, terminal
from test_agent_workspaces import image_bytes


def fail_job_inserts(repo):
    with closing(connect(repo.library)) as conn, conn:
        conn.execute("CREATE TRIGGER fail_native_job BEFORE INSERT ON generation_jobs BEGIN SELECT RAISE(ABORT,'synthetic job registration failure'); END")


def allow_job_inserts(repo):
    with closing(connect(repo.library)) as conn, conn:
        conn.execute("DROP TRIGGER fail_native_job")


@pytest.mark.parametrize("stream", [False, True])
def test_native_final_survives_first_job_insert_failure_and_restart_without_post(repo, monkeypatch, stream):
    start(repo, native=True)
    image = image_result()
    calls = transport(monkeypatch, **({'events':[terminal([image])]} if stream else {'payload':{'id':'response','status':'completed','output':[image]}}))
    fail_job_inserts(repo)
    execution.run_request(repo.library, 'request')
    with closing(connect(repo.library)) as conn:
        assert conn.execute('SELECT count(*) FROM generation_jobs').fetchone()[0] == 0
    files = list((repo.library/'generation-results').glob('*/result-*'))
    assert len(files) == 1 and files[0].read_bytes() == image_bytes()
    receipts = list((repo.library/'generation-results').glob('*/native-final.json'))
    assert len(receipts) == 1
    assert 'test-secret' not in receipts[0].read_text()
    allow_job_inserts(repo)
    restarted = AgentRepository(repo.library)
    recovered = restarted.jobs.recover_local_results()
    assert len(recovered['recovered']) == 1
    assert len(calls) == 1
    snapshot = restarted.snapshot('conversation', 'request')
    assert len(snapshot['jobs']) == 1 and snapshot['jobs'][0]['status'] == 'succeeded'
    job = restarted.jobs.get_job(snapshot['jobs'][0]['id'])
    assert (repo.library/job.result_path).read_bytes() == image_bytes()
    assert restarted.request('request')['round']['outputTaskIds'] == [job.id]
    assert restarted.request('request')['usage']['imageJobsCreated'] == 1
    restarted.jobs.recover_local_result(job.id)
    assert len(calls) == 1


def test_native_final_is_spilled_before_optional_response_detail_write(repo, monkeypatch):
    start(repo, native=True)
    calls = transport(monkeypatch, payload={'id':'response','status':'completed','output':[image_result()]})
    original = AgentRepository.record_response_details
    def fail_final(self, request_id, step, payload=None, **kwargs):
        if payload is not None: raise sqlite3.OperationalError('synthetic optional write failure')
        return original(self, request_id, step, payload, **kwargs)
    with monkeypatch.context() as patch:
        patch.setattr(AgentRepository, 'record_response_details', fail_final)
        execution.run_request(repo.library, 'request')
    files = list((repo.library/'generation-results').glob('*/result-*'))
    assert len(files) == 1 and files[0].read_bytes() == image_bytes()
    repo.jobs.recover_local_results()
    assert len(repo.snapshot('conversation')['jobs']) == 1
    assert len(calls) == 1


def test_concurrent_native_local_recovery_uses_original_job_and_round(repo, monkeypatch):
    start(repo, native=True)
    calls = transport(monkeypatch, payload={'status':'completed','output':[image_result()]})
    fail_job_inserts(repo)
    execution.run_request(repo.library, 'request')
    assert list((repo.library/'generation-results').glob('*/native-final.json'))
    allow_job_inserts(repo)
    with ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(lambda _: AgentRepository(repo.library).jobs.recover_local_results(), range(2)))
    snapshot = repo.snapshot('conversation', 'request')
    assert len(snapshot['jobs']) == 1 and snapshot['jobs'][0]['status'] == 'succeeded'
    assert repo.request('request')['usage']['imageJobsCreated'] == 1
    assert len(calls) == 1


@pytest.mark.parametrize('mutation', ['image','receipt','stop'])
def test_native_pending_conflict_never_fabricates_a_job_or_replays(repo, monkeypatch, mutation):
    start(repo, native=True)
    calls = transport(monkeypatch, payload={'status':'completed','output':[image_result()]})
    fail_job_inserts(repo)
    execution.run_request(repo.library, 'request')
    receipt = next((repo.library/'generation-results').glob('*/native-final.json'))
    if mutation == 'image': next(receipt.parent.glob('result-*')).write_bytes(image_bytes('blue'))
    elif mutation == 'receipt':
        value = json.loads(receipt.read_text()); value['requestId'] = 'other-request'
        receipt.write_text(json.dumps(value))
    else:
        with closing(connect(repo.library)) as conn, conn:
            conn.execute("UPDATE agent_requests SET stop_requested=1,state='stopped' WHERE id='request'")
    allow_job_inserts(repo)
    result = repo.jobs.recover_local_results()
    assert result['blocked']
    with closing(connect(repo.library)) as conn:
        assert conn.execute('SELECT count(*) FROM generation_jobs').fetchone()[0] == 0
    assert receipt.is_file() and len(calls) == 1


@pytest.mark.parametrize('status', ['failed','incomplete'])
def test_invalid_native_terminal_with_image_never_creates_recoverable_success(repo, monkeypatch, status):
    start(repo, native=True)
    calls = transport(monkeypatch, payload={'status':status,'output':[image_result()],
        'usage':{'input_tokens':10,'output_tokens':5,'total_tokens':15}})
    execution.run_request(repo.library, 'request')
    assert not list((repo.library/'generation-results').glob('*/native-final.json'))
    assert repo.jobs.recover_local_results()['recovered'] == []
    assert repo.request('request')['round']['responseDetails']['steps'][0]['usage']['totalTokens'] == 15
    assert len(calls) == 1


@pytest.mark.parametrize('stream',[False,True])
def test_unrequested_native_terminal_cannot_create_success_proof_or_hide_authorization_error(repo, monkeypatch, stream):
    set_mode(repo,'native')
    repo.create_round('conversation',body(repo,images=False))
    response = {'status':'completed','output':[image_result()]}
    calls = transport(monkeypatch,**({'events':[terminal(response['output'])]} if stream else {'payload':response}))
    execution.run_request(repo.library,'request')
    request = repo.request('request')
    assert request['error']['code'] == 'authorization_denied'
    assert request['upstream_outcome'] == 'known'
    assert not list((repo.library/'generation-results').glob('*/native-final.json'))
    assert not list((repo.library/'generation-results').glob('*/result-*'))
    with closing(connect(repo.library)) as conn:
        assert conn.execute('SELECT count(*) FROM generation_jobs').fetchone()[0] == 0
    assert len(calls) == 1


def test_all_images_in_valid_terminal_are_spilled_before_first_job_write(repo, monkeypatch):
    start(repo, native=True)
    images = [{**image_result(), 'id':'z-first'},
              {**image_result(), 'id':'a-second', 'result':base64.b64encode(image_bytes('blue')).decode()}]
    calls = transport(monkeypatch, payload={'status':'completed','output':images})
    fail_job_inserts(repo)
    execution.run_request(repo.library, 'request')
    files = list((repo.library/'generation-results').glob('*/result-*'))
    assert {path.read_bytes() for path in files} == {image_bytes(), image_bytes('blue')}
    assert len(list((repo.library/'generation-results').glob('*/native-final.json'))) == 2
    allow_job_inserts(repo)
    result = repo.jobs.recover_local_results()
    assert len(result['recovered']) == 2
    request = repo.request('request')
    assert [repo.jobs.get_job(job_id).metadata['agent']['toolCallId'] for job_id in request['round']['outputTaskIds']] == ['z-first','a-second']
    assert request['usage']['imageJobsCreated'] == 2 and len(calls) == 1


@pytest.mark.parametrize('failure', ['native_record','standard_record','record_too_large'])
def test_native_receipt_write_failure_preserves_image_and_precise_pending_error(repo, monkeypatch, failure):
    from backend.services import agent_native_result_recovery as native
    from backend.services import generation_result_recovery as common
    start(repo, native=True)
    calls = transport(monkeypatch, payload={'status':'completed','output':[image_result()]})
    module = native if failure != 'standard_record' else common
    original = module._atomic_write_bytes
    def fail_receipt(path,data):
        if path.name == ('native-final.json' if failure == 'native_record' else 'local-result.json'):
            raise OSError('Synthetic receipt storage failure')
        return original(path,data)
    with monkeypatch.context() as patch:
        if failure == 'record_too_large': patch.setattr(native,'MAX_NATIVE_RECEIPT_BYTES',128)
        else: patch.setattr(module,'_atomic_write_bytes',fail_receipt)
        execution.run_request(repo.library, 'request')
    request = repo.request('request')
    assert request['error']['code'] == 'local_result_pending'
    assert '图片已取得' in request['error']['message']
    files = list((repo.library/'generation-results').glob('*/result-*'))
    assert len(files) == 1 and files[0].read_bytes() == image_bytes()
    if failure == 'standard_record':
        assert repo.jobs.recover_local_results()['recovered']
        assert repo.snapshot('conversation')['jobs'][0]['status'] == 'succeeded'
    else:
        assert not list((repo.library/'generation-results').glob('*/native-final.json'))
        assert repo.jobs.recover_local_results()['recovered'] == []
    assert len(calls) == 1


def test_native_preview_sqlite_failure_does_not_abandon_valid_final(repo, monkeypatch):
    start(repo, native=True)
    image = image_result()
    calls = transport(monkeypatch, events=[
        {'type':'response.output_item.added', 'item':{**image,'status':'in_progress','result':None}},
        {'type':'response.image_generation_call.partial_image','item_id':image['id'], 'partial_image_b64':image['result']},
        terminal([image])])
    original = AgentRepository.store_asset
    def fail_preview(self,data,source,*args,**kwargs):
        if source and source.get('kind') == 'job': raise sqlite3.OperationalError('Synthetic preview persistence failure')
        return original(self,data,source,*args,**kwargs)
    monkeypatch.setattr(AgentRepository,'store_asset',fail_preview)
    execution.run_request(repo.library,'request')
    snapshot = repo.snapshot('conversation')
    assert snapshot['jobs'][0]['status'] == 'succeeded' and len(calls) == 1


@pytest.mark.parametrize('field,value', [('quality',{'api_key':'synthetic-private'}),
                                      ('size','https://example.invalid/private?token=secret'),
                                      ('quality','Bearer synthetic-private')])
def test_native_metadata_is_only_safe_recipe_scalars(repo, monkeypatch, field, value):
    start(repo, native=True)
    calls = transport(monkeypatch,payload={'status':'completed','output':[{**image_result(),field:value,'output_compression':0}]})
    execution.run_request(repo.library,'request')
    job = repo.jobs.get_job(repo.request('request')['round']['outputTaskIds'][0])
    assert job.status == 'succeeded'
    assert 'synthetic-private' not in json.dumps(job.metadata)
    assert 'https://example.invalid' not in json.dumps(job.metadata)
    assert job.metadata['response']['output_compression'] == 0 and len(calls) == 1


def test_native_result_replacement_between_lstat_and_open_is_blocked(repo, monkeypatch):
    from pathlib import Path
    from backend.services import generation_result_recovery as common
    start(repo,native=True)
    calls = transport(monkeypatch,payload={'status':'completed','output':[image_result()]})
    fail_job_inserts(repo)
    execution.run_request(repo.library,'request')
    receipt = next((repo.library/'generation-results').glob('*/native-final.json'))
    image = next(receipt.parent.glob('result-*'))
    allow_job_inserts(repo)
    original_open = common.os.open
    replaced = False
    def swap(path,flags,*args,**kwargs):
        nonlocal replaced
        if Path(path) == image and not replaced:
            replacement = image.with_name('replacement.tmp')
            replacement.write_bytes(image_bytes())
            replacement.replace(image)
            replaced = True
        return original_open(path,flags,*args,**kwargs)
    monkeypatch.setattr(common.os,'open',swap)
    result = repo.jobs.recover_local_results()
    assert result['blocked'] and not result['recovered'] and replaced and len(calls) == 1
    with closing(connect(repo.library)) as conn:
        assert conn.execute('SELECT count(*) FROM generation_jobs').fetchone()[0] == 0


def test_native_pending_result_restores_exact_frozen_reference_roles_and_prompt(repo, monkeypatch):
    set_mode(repo,'native')
    assets = [repo.store_asset(image_bytes(color),None)['id'] for color in ('red','blue')]
    value = body(repo).model_copy(update={'refs':[AgentRef(kind='upload',uploadId=asset) for asset in assets]})
    repo.create_round('conversation',value)
    executed = ' Exact provider prompt.\n  Preserve both references. '
    calls = transport(monkeypatch,payload={'status':'completed','output':[{**image_result(),'revised_prompt':executed}]})
    fail_job_inserts(repo)
    execution.run_request(repo.library,'request')
    allow_job_inserts(repo)
    result = repo.jobs.recover_local_results()
    job = repo.jobs.get_job(result['recovered'][0])
    assert job.prompt_text == executed
    assert repo.request('request')['round']['prompt'] == value.prompt
    snapshot = job.metadata['agent']['nativeReferenceSnapshot']
    assert [entry['assetId'] for entry in snapshot['references']] == assets
    assert [entry['path'] for entry in snapshot['references']] == [repo.asset(asset)['path'] for asset in assets]
    assert [entry['name'] for entry in job.parameters['input_images']] == ['round-1-reference-1','round-1-reference-2']
    assert len(calls) == 1


@pytest.mark.parametrize('mutation', ['round_deleted','conversation_deleted','request_fingerprint','foreign_reference'])
def test_native_restore_rejects_late_source_or_branch_conflicts(repo, monkeypatch, mutation):
    start(repo,native=True)
    calls = transport(monkeypatch,payload={'status':'completed','output':[image_result()]})
    fail_job_inserts(repo)
    execution.run_request(repo.library,'request')
    receipt = next((repo.library/'generation-results').glob('*/native-final.json'))
    with closing(connect(repo.library)) as conn,conn:
        if mutation == 'round_deleted': conn.execute("UPDATE agent_rounds SET deleted=1 WHERE request_id='request'")
        elif mutation == 'conversation_deleted': conn.execute("UPDATE agent_conversations SET deleted=1 WHERE id='conversation'")
        elif mutation == 'request_fingerprint': conn.execute("UPDATE agent_requests SET fingerprint='changed' WHERE id='request'")
    if mutation == 'foreign_reference':
        record = json.loads(receipt.read_text())
        record['nativeReferenceSnapshot'] = {'version':1,'complete':True,'count':1,'references':[
            {'ref':'round-1-reference-1','assetId':'foreign','path':'generation-references/foreign.png','sha256':'0'*64}]}
        receipt.write_text(json.dumps(record))
    allow_job_inserts(repo)
    result = repo.jobs.recover_local_results()
    assert result['blocked'] and not result['recovered'] and len(calls) == 1
    assert receipt.is_file()
    with closing(connect(repo.library)) as conn:
        assert conn.execute('SELECT count(*) FROM generation_jobs').fetchone()[0] == 0


@pytest.mark.parametrize('prompt',['Render with sk-syntheticsecret123456',
                                  'Use https://example.invalid/image?token=synthetic-private',
                                  'Use Bearer syntheticprivatesecret123456'])
def test_sensitive_native_execution_text_keeps_image_without_unsafe_recovery_record(repo, monkeypatch, prompt):
    start(repo,native=True)
    calls = transport(monkeypatch,payload={'status':'completed','output':[{**image_result(),'revised_prompt':prompt}]})
    execution.run_request(repo.library,'request')
    assert len(calls) == 1
    assert repo.request('request')['error']['code'] == 'local_result_pending'
    assert not list((repo.library/'generation-results').glob('*/native-final.json'))
    files = list((repo.library/'generation-results').glob('*/result-*'))
    assert len(files) == 1 and files[0].read_bytes() == image_bytes()


def test_first_native_receipt_failure_does_not_drop_other_valid_images_in_same_terminal(repo, monkeypatch):
    from backend.services import agent_native_result_recovery as native
    start(repo,native=True)
    images = [{**image_result(),'id':'first'},
              {**image_result(),'id':'second','result':base64.b64encode(image_bytes('blue')).decode()}]
    calls = transport(monkeypatch,payload={'status':'completed','output':images})
    original = native._atomic_write_bytes
    first_job_id = native.native_job_id('request',1,'first')
    def fail_first_marker(path,data):
        if path.name == 'native-final.json' and path.parent.name == first_job_id:
            raise OSError('Synthetic first recovery marker failure')
        return original(path,data)
    with monkeypatch.context() as patch:
        patch.setattr(native,'_atomic_write_bytes',fail_first_marker)
        execution.run_request(repo.library,'request')
    files = list((repo.library/'generation-results').glob('*/result-*'))
    assert {path.read_bytes() for path in files} == {image_bytes(),image_bytes('blue')}
    assert len(list((repo.library/'generation-results').glob('*/native-final.json'))) == 1
    assert repo.request('request')['error']['code'] == 'local_result_pending'
    result = repo.jobs.recover_local_results()
    assert len(result['recovered']) == 1 and len(calls) == 1
    assert repo.jobs.get_job(result['recovered'][0]).metadata['agent']['toolCallId'] == 'second'


def test_native_valid_png_above_download_cap_still_survives_registration_failure(repo, monkeypatch):
    """Native already permits an 80 MiB Responses envelope, independent of downloads."""
    from io import BytesIO
    from PIL import Image
    from backend.services.agent_responses import MAX_RESPONSE_BYTES
    from backend.services.image_download import MAX_IMAGE_BYTES
    start(repo,native=True)
    buffer = BytesIO()
    Image.new('RGBA',(3000,3000),(31,47,59,255)).save(buffer,'PNG',compress_level=0)
    data = buffer.getvalue()
    image = {**image_result(),'result':base64.b64encode(data).decode()}
    payload = {'status':'completed','output':[image]}
    assert len(data) > MAX_IMAGE_BYTES == 32 * 1024 * 1024
    assert len(json.dumps(payload).encode()) < MAX_RESPONSE_BYTES
    calls = transport(monkeypatch,payload=payload)
    fail_job_inserts(repo)
    execution.run_request(repo.library,'request')
    paths = list((repo.library/'generation-results').glob('*/result-*'))
    assert len(paths) == 1 and paths[0].read_bytes() == data
    allow_job_inserts(repo)
    recovered = repo.jobs.recover_local_results()
    assert len(recovered['recovered']) == 1 and len(calls) == 1
    job = repo.jobs.get_job(recovered['recovered'][0])
    assert job.status == 'succeeded' and job.result_width == job.result_height == 3000
    assert (repo.library/job.result_path).read_bytes() == data


@pytest.mark.parametrize('preview',['not-valid-base64!',base64.b64encode(b'not a decodable image').decode()])
def test_native_invalid_preview_cannot_abandon_valid_final(repo, monkeypatch, preview):
    start(repo,native=True)
    image = image_result()
    calls = transport(monkeypatch,events=[
        {'type':'response.output_item.added','item':{**image,'status':'in_progress','result':None}},
        {'type':'response.image_generation_call.partial_image','item_id':image['id'],'partial_image_b64':preview},
        terminal([image])])
    execution.run_request(repo.library,'request')
    request = repo.request('request')
    assert request['state'] == 'completed'
    assert len(request['round']['outputTaskIds']) == 1
    job = repo.jobs.get_job(request['round']['outputTaskIds'][0])
    assert job.status == 'succeeded' and (repo.library/job.result_path).read_bytes() == image_bytes()
    assert len(calls) == 1
