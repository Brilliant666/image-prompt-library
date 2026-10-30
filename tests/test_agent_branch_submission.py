"""Derived submissions validate the source but replace its answer, using isolated data."""
import copy
import json

import pytest
from fastapi.testclient import TestClient

from backend.agent_schemas import AgentTaskContextPatch
from backend.db import connect
from backend.main import create_app
from backend.services import agent_execution as execution
from backend.services.agent_repository import encoded
from test_agent_image_selection import repo, body
from test_agent_editing_task import turn, done, upload


def chain(repo, count=17):
    rows=[]
    for index in range(count):
        rid=f'original-{index+1}'
        request=turn(repo,rid,f'Original question {index+1}',parent=rows[-1]['id'] if rows else None)
        if index==7:
            state=request['round']['taskContext']
            repo.update_task_context(rid, {'taskId':state['taskId'],'taskRevision':state['revision'],
                'branchRoundId':request['round_id'],'operations':[{'op':'set_prompt','kind':'candidate',
                'text':'REPLACED_ASSISTANT_CANDIDATE'}]}, {})
            repo.update(rid,text='REPLACED_ASSISTANT_CANDIDATE',outcome='known')
        done(repo,rid)
        rows.append(repo.request(rid)['round'])
    return rows


def submit_edit(repo,monkeypatch,source,*,origin='edit',revision=None,request_id='edited'):
    scheduled=[]
    monkeypatch.setattr('backend.routers.agent.schedule_request',lambda library,rid:scheduled.append(rid))
    current=repo.snapshot('conversation')
    source_view=next(r for r in current['conversation']['rounds'] if r['id']==source['id'])
    payload=body(repo,request_id,images=False).model_copy(update={
        'prompt':source['prompt'] if origin=='regenerate' else 'Replacement question',
        'parentRoundId':source['parentRoundId'],'origin':origin,'derivedFromRoundId':source['id'],
        'taskRevision':revision if revision is not None else source_view.get('branchTaskRevision',
            (source_view.get('taskContext') or {}).get('revision',0))})
    client=TestClient(create_app(repo.library),base_url='http://127.0.0.1:8767')
    response=client.post('/api/agent/conversations/conversation/rounds',json=payload.model_dump(mode='json'))
    return response,scheduled,payload


@pytest.mark.parametrize('origin',['edit','regenerate'])
def test_derived_branch_replaces_source_answer_and_never_inherits_future(repo,monkeypatch,origin):
    rows=chain(repo)
    source=rows[7]
    before={r['id']:copy.deepcopy(r) for r in rows}
    response,scheduled,payload=submit_edit(repo,monkeypatch,source,origin=origin)
    assert response.status_code==202,response.text
    assert scheduled==['edited']
    request=repo.request('edited')
    assert request['round']['parentRoundId']==rows[6]['id']
    assert [r['id'] for r in request['history']]==[r['id'] for r in rows[:7]]
    assert all('_taskInputState' not in r for r in request['history'])
    refs=execution.refs_for_request(repo,request)
    wire=encoded(execution.build_input(repo,request,refs))
    assert 'REPLACED_ASSISTANT_CANDIDATE' not in wire
    assert 'Original question 17' not in wire
    assert payload.prompt in wire
    for rid,old in before.items():
        assert repo.request(old['requestId'])['round']==old
    replay=TestClient(create_app(repo.library),base_url='http://127.0.0.1:8767').post(
        '/api/agent/conversations/conversation/rounds',json=payload.model_dump(mode='json'))
    assert replay.status_code==200 and scheduled==['edited']


def test_source_branch_user_draft_revision_and_explicit_prompt_are_preserved(repo,monkeypatch):
    rows=chain(repo,9); source=rows[7]
    snap=repo.snapshot('conversation')
    selected=repo.patch_task_context('conversation',AgentTaskContextPatch(
        expectedRevision=snap['revision'],branchRoundId=source['id'],taskRevision=source['taskContext']['revision'],
        operations=[{'op':'set_prompt','kind':'selected','text':'Explicit user selected recipe'}]))
    view=next(r for r in selected['conversation']['rounds'] if r['id']==source['id'])
    assert view['branchTaskRevision']>source['taskContext']['revision']
    response,scheduled,_=submit_edit(repo,monkeypatch,source)
    assert response.status_code==202,response.text
    state=repo.request('edited')['round']['taskContext']
    assert any(p['text']=='Explicit user selected recipe' and p['confirmedBy']=='user' for p in state['promptVersions'])
    assert all(p['text']!='REPLACED_ASSISTANT_CANDIDATE' for p in state['promptVersions'])
    assert scheduled==['edited']


def test_old_draft_without_envelope_kind_has_the_same_public_and_checked_revision(repo,monkeypatch):
    rows=chain(repo,9);source=rows[7]
    with connect(repo.library) as conn:
        conversation=conn.execute('SELECT editing_tasks FROM agent_conversations WHERE id=?',('conversation',)).fetchone()
        drafts=json.loads(conversation[0])
        saved=copy.deepcopy(source['taskContext']);saved['revision']+=1
        drafts[source['id']]={'taskContext':saved}
        conn.execute('UPDATE agent_conversations SET editing_tasks=? WHERE id=?',(encoded(drafts),'conversation'))
    public=repo.snapshot('conversation')
    view=next(r for r in public['conversation']['rounds'] if r['id']==source['id'])
    assert view['branchTaskRevision']==saved['revision']
    response,scheduled,_=submit_edit(repo,monkeypatch,source)
    assert response.status_code==202,response.text
    assert scheduled==['edited']


def test_actual_stale_task_version_is_rejected_before_queue(repo,monkeypatch):
    rows=chain(repo,9)
    response,scheduled,_=submit_edit(repo,monkeypatch,rows[7],revision=rows[6]['taskContext']['revision'])
    assert response.status_code==409
    assert response.json()['detail']['code']=='task_revision_conflict'
    assert scheduled==[]
    with connect(repo.library) as conn:
        assert conn.execute("SELECT count(*) FROM agent_requests WHERE id='edited'").fetchone()[0]==0


@pytest.mark.parametrize('legacy',[False,True])
def test_edit_first_round_and_legacy_state_never_import_replaced_answer(repo,monkeypatch,legacy):
    rows=chain(repo,1); source=rows[0]
    if legacy:
        with connect(repo.library) as conn:
            data=json.loads(conn.execute('SELECT data FROM agent_rounds WHERE id=?',(source['id'],)).fetchone()[0])
            data.pop('taskContext',None);data.pop('_taskInputState',None)
            conn.execute('UPDATE agent_rounds SET data=? WHERE id=?',(encoded(data),source['id']))
    response,scheduled,_=submit_edit(repo,monkeypatch,source)
    assert response.status_code==202,response.text
    assert repo.request('edited')['history']==[]
    assert repo.request('edited')['round']['parentRoundId'] is None
    assert scheduled==['edited']
