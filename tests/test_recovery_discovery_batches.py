"""Receipt discovery stays bounded without forgetting later paid results."""
from contextlib import closing
import base64
import json

import pytest
from fastapi.testclient import TestClient

from backend.db import connect
from backend.agent_schemas import AgentConversationCreate
from backend.main import create_app
from backend.services import agent_execution as execution
from backend.services import agent_native_result_recovery as native
from backend.services.agent_repository import AgentRepository
from test_agent_image_selection import repo, body
from test_agent_execution_correctness import start, transport, image_result
from test_agent_native_result_recovery import fail_job_inserts, allow_job_inserts
from test_agent_workspaces import image_bytes
from test_generation_result_recovery import provider_case, pending_case


def unrelated_receipts(repo, count=101):
    for index in range(count):
        directory = repo.library/'generation-results'/f'gen_000{index:05d}'
        directory.mkdir(parents=True, exist_ok=True)
        # Invalid and unowned records must remain preserved, but cannot starve
        # a proven final in a later bounded scan page.
        (directory/native.NATIVE_RECEIPT_NAME).write_text('{}')


def retained_native(repo, monkeypatch, *, images=None):
    start(repo, native=True)
    calls = transport(monkeypatch, payload={'status':'completed', 'output':images or [image_result()]})
    fail_job_inserts(repo)
    execution.run_request(repo.library, 'request')
    with closing(connect(repo.library)) as conn:
        assert conn.execute('SELECT count(*) FROM generation_jobs').fetchone()[0] == 0
    allow_job_inserts(repo)
    return calls


def test_request_discovery_continues_past_101_unrelated_records(repo, monkeypatch):
    unrelated_receipts(repo)
    calls = retained_native(repo, monkeypatch)
    first = native.native_receipts_for_request(repo.jobs,'request',limit=100)
    assert first['job_ids'] == []
    assert first['complete'] is False and first['next_cursor']
    second = native.native_receipts_for_request(repo.jobs,'request',limit=100,cursor=first['next_cursor'])
    assert second['complete'] is True and second['next_cursor'] is None
    assert len(second['job_ids']) == 1 and not second['blocked']
    result = repo.recover_request_results('request')
    assert result['jobs'][0]['status'] == 'succeeded'
    job = repo.jobs.get_job(result['jobs'][0]['id'])
    assert (repo.library/job.result_path).read_bytes() == image_bytes()
    assert len(calls) == 1


def test_http_recovery_passes_101_valid_foreign_receipts_without_registering_them(repo, monkeypatch):
    target_id,target_call = max((native.native_job_id('request',1,f'target-{index}'),f'target-{index}')
                                for index in range(256))
    calls = retained_native(repo,monkeypatch,images=[{**image_result(),'id':target_call}])
    foreign = {}
    for index in range(101):
        cid,request_id = f'foreign-conversation-{index}',f'foreign-request-{index}'
        repo.create_conversation(AgentConversationCreate(id=cid))
        payload = body(repo,request_id).model_copy(update={'expectedRevision':repo.snapshot(cid)['revision']})
        repo.create_round(cid,payload)
        # Prepare the same durable frozen request/started-step boundary used by
        # run_request, then spill a validated final through its production helper.
        # Each foreign request has its own actual DB identity and authorization.
        with closing(connect(repo.library)) as conn,conn:
            row = conn.execute('SELECT usage FROM agent_requests WHERE id=?',(request_id,)).fetchone()
            usage = {**json.loads(row[0]),'responseStepsStarted':1}
            conn.execute("INSERT INTO agent_steps(request_id,step,state) VALUES(?,1,'sending')",(request_id,))
            conn.execute("UPDATE agent_requests SET usage=?,state='failed',upstream_outcome='known' WHERE id=?",
                         (json.dumps(usage),request_id))
        call_id = next(f'foreign-call-{attempt}' for attempt in range(256)
                       if native.native_job_id(request_id,1,f'foreign-call-{attempt}') < target_id)
        identity = native.preserve_native_final(repo.library,repo.request(request_id),1,
            {**image_result(),'id':call_id},execution.native_reference_snapshot(repo,{},[]),output_index=0)
        value = native.validate_native_receipt(repo.library,identity)
        assert value['requestId'] == request_id and identity < target_id
        receipt = repo.library/'generation-results'/identity/native.NATIVE_RECEIPT_NAME
        foreign[identity] = (receipt.read_bytes(),(repo.library/value['result']['path']).read_bytes())
    first = native.native_receipts_for_request(repo.jobs,'request')
    assert first['complete'] is False and first['job_ids'] == [] and not first['blocked']
    assert all(path.parent.name in foreign for path in
               native.receipt_scan_batch(repo.library,native.NATIVE_RECEIPT_NAME)['paths'])
    before = len(calls)
    client = TestClient(create_app(repo.library))
    try:
        response = client.post('/api/agent/requests/request/recover-results')
        assert response.status_code == 200,response.text
        assert [job['id'] for job in response.json()['jobs']] == [target_id]
        assert response.json()['jobs'][0]['status'] == 'succeeded'
    finally:
        client.close()
    with closing(connect(repo.library)) as conn:
        assert conn.execute('SELECT id FROM generation_jobs').fetchall()[0][0] == target_id
        assert conn.execute('SELECT count(*) FROM generation_jobs').fetchone()[0] == 1
        assert conn.execute('SELECT count(*) FROM agent_tool_jobs WHERE request_id<>?',('request',)).fetchone()[0] == 0
    for identity,(receipt_bytes,result_bytes) in foreign.items():
        receipt = repo.library/'generation-results'/identity/native.NATIVE_RECEIPT_NAME
        assert receipt.read_bytes() == receipt_bytes
        assert (repo.library/json.loads(receipt_bytes)['result']['path']).read_bytes() == result_bytes
    assert before == len(calls) == 1


def test_http_post_recovers_multiple_native_outputs_scattered_across_three_pages(repo, monkeypatch):
    unrelated_receipts(repo)
    choices = sorted((native.native_job_id('request',1,f'call-{index}'),f'call-{index}') for index in range(8))
    lower_id, second_call = choices[0]
    higher_id, first_call = choices[-1]
    assert lower_id < higher_id
    images = [{**image_result(),'id':first_call},
              {**image_result(),'id':second_call,'result':base64.b64encode(image_bytes('blue')).decode()}]
    calls = retained_native(repo,monkeypatch,images=images)
    for index in range(99):
        path = repo.library/'generation-results'/f'{lower_id}_{index:03d}'
        path.mkdir()
        (path/native.NATIVE_RECEIPT_NAME).write_text('{}')
    # Use the production routes without lifespan: no background queue may
    # pre-recover the evidence before the explicit user POST being tested.
    client = TestClient(create_app(repo.library))
    try:
        response = client.post('/api/agent/requests/request/recover-results')
        assert response.status_code == 200, response.text
        value = response.json()
        assert len(value['jobs']) == 2 and all(job['status'] == 'succeeded' for job in value['jobs'])
        repeated = client.post('/api/agent/requests/request/recover-results')
        assert repeated.status_code == 200
    finally:
        client.close()
    assert [repo.jobs.get_job(identity).metadata['agent']['toolCallId']
            for identity in repo.request('request')['round']['outputTaskIds']] == [first_call,second_call]
    assert {(repo.library/job['result_path']).read_bytes() for job in value['jobs']} == {image_bytes(),image_bytes('blue')}
    assert len(calls) == 1


def test_scan_continues_when_cleanup_removes_child_between_directory_checks(repo, monkeypatch):
    unrelated_receipts(repo,3)
    root = repo.library/'generation-results'
    original = native.os.scandir
    with original(root) as stream:
        entries = list(stream)
    gone = min(entries,key=lambda entry:entry.name)
    class VanishingEntry:
        name,path = gone.name,gone.path
        def is_dir(self,**kwargs):
            result = gone.is_dir(**kwargs)
            (root/gone.name/native.NATIVE_RECEIPT_NAME).unlink()
            (root/gone.name).rmdir()
            return result
        def stat(self,**kwargs):
            return gone.stat(**kwargs)
    class Entries:
        def __enter__(self):
            return iter([VanishingEntry(),*(entry for entry in entries if entry.name != gone.name)])
        def __exit__(self,*_):
            return False
    monkeypatch.setattr(native.os,'scandir',lambda _: Entries())
    page = native.receipt_scan_batch(repo.library,native.NATIVE_RECEIPT_NAME,limit=3)
    assert page['complete'] and len(page['paths']) == 2
    assert all(path.parent.name != gone.name for path in page['paths'])


def test_startup_scan_advances_across_blocked_page_and_restart(repo, monkeypatch):
    unrelated_receipts(repo)
    calls = retained_native(repo,monkeypatch)
    first = repo.jobs.recover_local_results(limit=100)
    assert len(first['blocked']) == 100 and not first['recovered']
    native._SCAN_POSITIONS.clear()  # Simulate losing all process-local state.
    restarted = AgentRepository(repo.library)
    second = restarted.jobs.recover_local_results(limit=100)
    assert len(second['recovered']) == 1
    job = restarted.jobs.get_job(second['recovered'][0])
    assert job.status == 'succeeded' and (repo.library/job.result_path).read_bytes() == image_bytes()
    assert len(calls) == 1


def test_request_pages_bound_header_reads_and_validate_only_matching_results(repo, monkeypatch):
    unrelated_receipts(repo)
    calls = retained_native(repo,monkeypatch)
    reads = []
    original = native._read_regular
    def measured(path,limit):
        reads.append(path)
        return original(path,limit)
    monkeypatch.setattr(native,'_read_regular',measured)
    page = native.native_receipts_for_request(repo.jobs,'request',limit=25)
    assert len(reads) == 25 and not page['complete'] and not page['job_ids']
    while not page['complete']:
        reads.clear()
        page = native.native_receipts_for_request(repo.jobs,'request',limit=25,cursor=page['next_cursor'])
        assert len([path for path in reads if path.name == native.NATIVE_RECEIPT_NAME]) <= 25
        assert len([path for path in reads if path.name.startswith('result-')]) <= len(page['job_ids'])
    assert len(page['job_ids']) == 1 and len(calls) == 1


def test_request_page_reports_owned_corrupt_final_as_blocked_not_absent(repo, monkeypatch):
    unrelated_receipts(repo)
    calls = retained_native(repo,monkeypatch)
    image = next((repo.library/'generation-results').glob('gen_native_*/result-*'))
    image.write_bytes(image_bytes('blue'))
    page = native.native_receipts_for_request(repo.jobs,'request')
    page = native.native_receipts_for_request(repo.jobs,'request',cursor=page['next_cursor'])
    assert page['complete'] and page['blocked'] and not page['job_ids']
    assert image.read_bytes() == image_bytes('blue') and len(calls) == 1


def test_cursor_write_failure_reports_degradation_but_keeps_in_process_progress(repo, monkeypatch):
    unrelated_receipts(repo)
    calls = retained_native(repo,monkeypatch)
    original = native._atomic_write_bytes
    def fail_hint(path,data):
        if path.name == native._SCAN_STATE_NAME:
            raise OSError('Synthetic cursor write failure')
        return original(path,data)
    monkeypatch.setattr(native,'_atomic_write_bytes',fail_hint)
    first = repo.jobs.recover_local_results()
    assert first['scan_warning'] and not first['recovered']
    second = repo.jobs.recover_local_results()
    assert second['scan_warning'] and len(second['recovered']) == 1
    assert len(calls) == 1


def test_corrupt_scan_hint_is_rebuildable_and_never_adopts_a_file(repo, monkeypatch):
    calls = retained_native(repo,monkeypatch)
    (repo.library/native._SCAN_STATE_NAME).write_text('{broken')
    native._SCAN_POSITIONS.clear()
    result = AgentRepository(repo.library).jobs.recover_local_results()
    assert result['scan_warning'] and len(result['recovered']) == 1
    assert len(calls) == 1
    # A forged cursor cannot authorize a mismatched result on its next cycle.
    job = repo.jobs.get_job(result['recovered'][0])
    assert (repo.library/job.result_path).read_bytes() == image_bytes()


def test_startup_cycle_finds_new_earlier_record_after_later_entries_are_cleaned(repo, monkeypatch):
    calls = retained_native(repo,monkeypatch)
    old_id = next((repo.library/'generation-results').glob('gen_native_*/native-final.json')).parent.name
    tail = repo.library/'generation-results'/'gen_zz_tail'
    tail.mkdir()
    (tail/native.NATIVE_RECEIPT_NAME).write_text('{}')
    first = repo.jobs.recover_local_results(limit=1)
    assert first['recovered'] == [old_id]
    new_call = next(f'new-call-{index}' for index in range(1000)
                    if native.native_job_id('new-request',1,f'new-call-{index}') < old_id)
    repo.create_round('conversation',body(repo,'new-request'))
    new_calls = transport(monkeypatch,payload={'status':'completed','output':[{**image_result(),'id':new_call}]})
    fail_job_inserts(repo)
    execution.run_request(repo.library,'new-request')
    allow_job_inserts(repo)
    # Removing a later record must not leave the saved cursor permanently past
    # a valid newly retained result with a smaller deterministic directory ID.
    (tail/native.NATIVE_RECEIPT_NAME).unlink()
    assert not repo.jobs.recover_local_results(limit=1)['recovered']
    native._SCAN_POSITIONS.clear()
    recovered = AgentRepository(repo.library).jobs.recover_local_results(limit=1)
    assert recovered['recovered'] == [native.native_job_id('new-request',1,new_call)]
    assert len(calls) == len(new_calls) == 1


def test_standard_receipts_advance_past_blocked_jobs_without_provider_replay(pending_case):
    library,jobs,job,_,calls = pending_case
    from backend.services.generation_result_recovery import RECEIPT_NAME
    for index in range(101):
        path = library/'generation-results'/f'A_{index:05d}'
        path.mkdir()
        (path/RECEIPT_NAME).write_text('{}')
    first = jobs.recover_local_results(provider='openai_compatible')
    assert len(first['blocked']) == 100 and not first['recovered']
    native._SCAN_POSITIONS.clear()
    second = type(jobs)(library).recover_local_results(provider='openai_compatible')
    assert second['recovered'] == [job.id]
    assert jobs.get_job(job.id).status == 'succeeded' and len(calls) == 1


def test_scan_positions_are_separate_for_receipt_kind_and_provider(repo):
    unrelated_receipts(repo,3)
    first = native.next_recovery_scan_batch(repo.library,native.NATIVE_RECEIPT_NAME,provider=None,limit=1)
    separate = native.next_recovery_scan_batch(repo.library,native.NATIVE_RECEIPT_NAME,provider='agent_native',limit=1)
    continued = native.next_recovery_scan_batch(repo.library,native.NATIVE_RECEIPT_NAME,provider=None,limit=1)
    assert first['paths'] == separate['paths']
    assert continued['paths'] != first['paths']
    assert not separate['complete']


@pytest.mark.parametrize('cursor',['../outside','C:\\outside','/outside','x'*161])
def test_scan_cursor_is_only_a_safe_directory_position(repo,cursor):
    with pytest.raises(native.RecoveryConflict):
        native.native_receipts_for_request(repo.jobs,'request',cursor=cursor)


def test_native_outputs_remain_in_provider_order_when_recovered_across_pages(repo, monkeypatch):
    # Choose IDs whose deterministic directory ordering reverses provider order.
    choices = sorted((native.native_job_id('request',1,f'call-{index}'),f'call-{index}') for index in range(8))
    first_call, second_call = choices[-1][1], choices[0][1]
    images = [{**image_result(),'id':first_call},
              {**image_result(),'id':second_call,'result':base64.b64encode(image_bytes('blue')).decode()}]
    calls = retained_native(repo,monkeypatch,images=images)
    one = repo.jobs.recover_local_results(limit=1)
    two = AgentRepository(repo.library).jobs.recover_local_results(limit=1)
    assert len(set(one['recovered']+two['recovered'])) == 2
    ids = repo.request('request')['round']['outputTaskIds']
    assert [repo.jobs.get_job(identity).metadata['agent']['toolCallId'] for identity in ids] == [first_call,second_call]
    assert len(calls) == 1
