"""Derived branches retain explicit source bindings, never future branch data."""
import base64
import copy
import json

from fastapi.testclient import TestClient
import httpx
import pytest

from backend.agent_schemas import AgentConversationPatch, AgentTaskContextPatch, AgentRef
from backend.db import connect
from backend.main import create_app
from backend.services import agent_execution as execution
from backend.services.agent_repository import encoded
from test_agent_branch_submission import chain, submit_edit
from test_agent_editing_task import done, turn, upload
from test_agent_image_selection import repo, body


EXACT = '  Exact user recipe.\nKeep the two distinct reference roles.  '


def select_source_bindings(repo, source):
    target, auxiliary = upload(repo, 'blue'), upload(repo, 'green')
    snapshot = repo.snapshot('conversation')
    result = repo.patch_task_context('conversation', AgentTaskContextPatch.model_validate({
        'expectedRevision': snapshot['revision'], 'branchRoundId': source['id'],
        'taskRevision': source['taskContext']['revision'], 'operations': [
            {'op': 'set_target', 'ref': {'kind': 'upload', 'uploadId': target}},
            {'op': 'set_auxiliaries', 'auxiliaries': [
                {'ref': {'kind': 'upload', 'uploadId': auxiliary}, 'role': 'lighting'}]},
            {'op': 'set_prompt', 'kind': 'selected', 'text': EXACT}]}))
    view = next(row for row in result['conversation']['rounds'] if row['id'] == source['id'])
    return target, auxiliary, view['branchTaskRevision']


def source_draft(repo, source_id):
    with connect(repo.library) as connection:
        return json.loads(connection.execute(
            'SELECT editing_tasks FROM agent_conversations WHERE id=?', ('conversation',)).fetchone()[0])[source_id]


def replace_source_draft(repo, source_id, value):
    # Import the exact older JSON shape into isolated storage. This simulates
    # upgrade compatibility; no old real library or frozen request is changed.
    with connect(repo.library) as connection:
        drafts = json.loads(connection.execute(
            'SELECT editing_tasks FROM agent_conversations WHERE id=?', ('conversation',)).fetchone()[0])
        drafts[source_id] = value
        connection.execute('UPDATE agent_conversations SET editing_tasks=? WHERE id=?',
                           (encoded(drafts), 'conversation'))


def original_bytes(repo, identities):
    return {identity: (repo.library/repo.asset(identity)['path']).read_bytes() for identity in identities}


def wire_pixels(body):
    return [base64.b64decode(part['image_url'].split(',', 1)[1])
            for row in body['input'] for part in row.get('content', []) if part.get('type') == 'input_image']


def wire_task(items):
    texts = [part['text'] for row in items for part in row.get('content', [])
             if part.get('type') == 'input_text' and part.get('text', '').startswith('Current creative task ')]
    assert len(texts) == 1
    return json.loads(texts[0].partition(': ')[2])


@pytest.mark.parametrize('origin', ['edit', 'regenerate'])
@pytest.mark.parametrize('legacy', ['envelope', 'context_without_kind', 'plain_editing'])
def test_derived_source_manual_target_auxiliary_and_legacy_drafts_are_frozen(repo, monkeypatch, origin, legacy):
    rows = chain(repo)
    source = rows[7]
    target, auxiliary, selected_revision = select_source_bindings(repo, source)
    saved = source_draft(repo, source['id'])
    if legacy == 'context_without_kind':
        saved.pop('_kind')
        replace_source_draft(repo, source['id'], saved)
    elif legacy == 'plain_editing':
        saved = saved['editingTask']
        saved['requirements'] = EXACT
        replace_source_draft(repo, source['id'], saved)
    expected_revision = 0 if legacy == 'plain_editing' else selected_revision
    public = repo.snapshot('conversation')
    public_source = next(row for row in public['conversation']['rounds'] if row['id'] == source['id'])
    assert public_source['branchTaskRevision'] == expected_revision
    originals = {row['requestId']: copy.deepcopy(repo.request(row['requestId'])['round']) for row in rows}
    media_before = original_bytes(repo, (target, auxiliary))
    response, scheduled, payload = submit_edit(repo, monkeypatch, source, origin=origin)
    assert response.status_code == 202, response.text
    assert scheduled == ['edited']
    request = repo.request('edited')
    state = request['round']['taskContext']
    assert state['target']['assetId'] == target
    assert [(image['assetId'], image['role']) for image in state['auxiliaries']] == [(auxiliary, 'lighting')]
    assert set(request['round']['taskImageIds']) == {target, auxiliary}
    assert payload.taskRevision == expected_revision
    refs = execution.refs_for_request(repo, request)
    wire = execution.build_input(repo, request, refs)
    assert set(wire_pixels({'input': wire})) == set(media_before.values())
    expected_text = EXACT + '\n' + payload.prompt.strip() if legacy == 'plain_editing' else EXACT
    assert any(prompt['text'] == expected_text for prompt in wire_task(wire)['promptVersions'])
    assert 'REPLACED_ASSISTANT_CANDIDATE' not in encoded(wire)
    assert 'Original question 17' not in encoded(wire)
    assert original_bytes(repo, media_before) == media_before
    assert all(repo.request(identity)['round'] == before for identity, before in originals.items())


@pytest.mark.parametrize('origin', ['edit', 'regenerate'])
def test_real_conversation_cas_conflict_does_not_enqueue_or_change_source(repo, monkeypatch, origin):
    rows = chain(repo, 9)
    source = rows[7]
    target, auxiliary, source_revision = select_source_bindings(repo, source)
    current = repo.snapshot('conversation')
    payload = body(repo, 'stale-tab', images=False).model_copy(update={
        'origin': origin, 'derivedFromRoundId': source['id'], 'parentRoundId': source['parentRoundId'],
        'prompt': source['prompt'] if origin == 'regenerate' else 'Edited user text',
        'taskRevision': source_revision})
    source_before = copy.deepcopy(repo.request(source['requestId'])['round'])
    media_before = original_bytes(repo, (target, auxiliary))
    # Another tab changes only the conversation revision, not the source task.
    repo.patch_conversation('conversation', AgentConversationPatch(expectedRevision=current['revision'], title='Other tab title'))
    scheduled = []
    monkeypatch.setattr('backend.routers.agent.schedule_request', lambda library, identity: scheduled.append(identity))
    client = TestClient(create_app(repo.library))
    response = client.post('/api/agent/conversations/conversation/rounds', json=payload.model_dump(mode='json'))
    assert response.status_code == 409
    assert response.json()['detail']['code'] == 'revision_conflict'
    assert scheduled == []
    with connect(repo.library) as connection:
        assert connection.execute("SELECT count(*) FROM agent_requests WHERE id='stale-tab'").fetchone()[0] == 0
    assert repo.request(source['requestId'])['round'] == source_before
    assert original_bytes(repo, media_before) == media_before
    client.close()


def test_first_edited_worker_has_one_model_post_and_no_replaced_answer_or_future_pixels(repo, monkeypatch):
    rows = chain(repo)
    source = rows[7]
    future_image = upload(repo, 'red')
    future = turn(repo, 'future-image', 'FUTURE_ONLY_IMAGE_REQUIREMENT',
                  refs=[{'kind': 'upload', 'uploadId': future_image}], parent=rows[-1]['id'])
    done(repo, 'future-image')
    target, auxiliary, _ = select_source_bindings(repo, source)
    media_before = original_bytes(repo, (target, auxiliary, future_image))
    source_before = copy.deepcopy(repo.request(source['requestId'])['round'])
    future_before = copy.deepcopy(repo.request('future-image')['round'])
    response, scheduled, payload = submit_edit(repo, monkeypatch, source)
    assert response.status_code == 202, response.text
    assert scheduled == ['edited']
    calls = []
    def handle(request):
        assert request.method == 'POST' and request.url.path.endswith('/responses')
        calls.append(json.loads(request.read()))
        return httpx.Response(200, json={'id': 'synthetic-derived-response', 'status': 'completed', 'output': [
            {'id': 'synthetic-derived-message', 'type': 'message', 'role': 'assistant',
             'content': [{'type': 'output_text', 'text': 'Synthetic edited answer, no image tool.'}]}]})
    monkeypatch.setattr(execution, 'create_api_client', lambda *args, **kwargs: httpx.Client(transport=httpx.MockTransport(handle)))
    execution.run_request(repo.library, 'edited')
    accepted = repo.request('edited')
    assert accepted['state'] == 'completed' and accepted['usage']['imageJobsCreated'] == 0
    assert len(calls) == 1
    assert set(wire_pixels(calls[0])) == {media_before[target], media_before[auxiliary]}
    serialized = encoded(calls[0])
    assert payload.prompt in serialized
    assert 'REPLACED_ASSISTANT_CANDIDATE' not in serialized
    assert 'FUTURE_ONLY_IMAGE_REQUIREMENT' not in serialized
    assert repo.data_url(future_image) not in serialized
    assert repo.request(source['requestId'])['round'] == source_before
    assert repo.request('future-image')['round'] == future_before
    assert original_bytes(repo, media_before) == media_before
    # The same accepted receipt remains idempotent after the worker finishes.
    replay = TestClient(create_app(repo.library)).post('/api/agent/conversations/conversation/rounds', json=payload.model_dump(mode='json'))
    assert replay.status_code == 200 and len(calls) == 1 and scheduled == ['edited']


@pytest.mark.parametrize('origin', ['edit', 'regenerate'])
@pytest.mark.parametrize('operation', ['target', 'auxiliary'])
@pytest.mark.parametrize('legacy_seed', [False, True])
def test_first_image_source_manual_bindings_survive_unchanged_task_type(repo, monkeypatch, origin, operation, legacy_seed):
    original_image, chosen = upload(repo, 'orange'), upload(repo, 'purple')
    reference = {'kind': 'upload', 'uploadId': original_image}
    original = turn(repo, 'first-source', 'Edit this geometric subject.', refs=[reference])
    state = original['round']['taskContext']
    assert state['taskType'] == 'image_edit'
    repo.update_task_context('first-source', {'taskId': state['taskId'], 'taskRevision': state['revision'],
        'branchRoundId': original['round_id'], 'operations': [
            {'op': 'set_prompt', 'kind': 'candidate', 'text': 'REPLACED_FIRST_IMAGE_CANDIDATE'}]},
        execution.refs_for_request(repo, original))
    repo.update('first-source', text='REPLACED_FIRST_IMAGE_CANDIDATE', outcome='known')
    done(repo, 'first-source')
    source = repo.request('first-source')['round']
    if legacy_seed:
        source.pop('_taskInputState')
        with connect(repo.library) as connection:
            connection.execute('UPDATE agent_rounds SET data=? WHERE id=?', (encoded(source), source['id']))
    snapshot = repo.snapshot('conversation')
    op = ({'op': 'set_target', 'ref': {'kind': 'upload', 'uploadId': chosen}} if operation == 'target' else
          {'op': 'set_auxiliaries', 'auxiliaries': [
              {'ref': {'kind': 'upload', 'uploadId': chosen}, 'role': 'lighting'}]})
    patched = repo.patch_task_context('conversation', AgentTaskContextPatch.model_validate({
        'expectedRevision': snapshot['revision'], 'branchRoundId': source['id'],
        'taskRevision': source['taskContext']['revision'], 'operations': [op]}))
    source_view = next(row for row in patched['conversation']['rounds'] if row['id'] == source['id'])
    assert source_draft(repo, source['id'])['taskContext']['taskType'] == state['taskType']
    before = copy.deepcopy(repo.request('first-source')['round'])
    media_before = original_bytes(repo, (original_image, chosen))
    scheduled = []
    monkeypatch.setattr('backend.routers.agent.schedule_request', lambda library, identity: scheduled.append(identity))
    payload = body(repo, 'derived-first-image', images=False).model_copy(update={
        'origin': origin, 'parentRoundId': None, 'derivedFromRoundId': source['id'],
        'prompt': source['prompt'] if origin == 'regenerate' else 'Change the geometric subject lighting.',
        'refs': [AgentRef.model_validate(ref) for ref in repo.request('first-source')['body']['refs']],
        'taskRevision': source_view['branchTaskRevision']})
    client = TestClient(create_app(repo.library))
    stale = payload.model_copy(update={'requestId': 'stale-first-image',
        'taskRevision': source['taskContext']['revision']})
    rejected = client.post('/api/agent/conversations/conversation/rounds', json=stale.model_dump(mode='json'))
    assert rejected.status_code == 409
    assert rejected.json()['detail']['code'] == 'task_revision_conflict'
    assert scheduled == []
    with connect(repo.library) as connection:
        assert connection.execute("SELECT count(*) FROM agent_requests WHERE id='stale-first-image'").fetchone()[0] == 0
    assert repo.request('first-source')['round'] == before
    response = client.post('/api/agent/conversations/conversation/rounds', json=payload.model_dump(mode='json'))
    assert response.status_code == 202, response.text
    assert scheduled == ['derived-first-image']
    request = repo.request('derived-first-image')
    expected_target = chosen if operation == 'target' else original_image
    expected_auxiliaries = [] if operation == 'target' else [(chosen, 'lighting')]
    assert request['round']['taskContext']['taskType'] == 'image_edit'
    assert request['round']['editingTask']['target']['assetId'] == expected_target
    assert [(image['assetId'], image['role']) for image in request['round']['editingTask']['auxiliaries']] == expected_auxiliaries
    refs = execution.refs_for_request(repo, request)
    wire = execution.build_input(repo, request, refs)
    assert media_before[expected_target] in wire_pixels({'input': wire})
    if operation == 'auxiliary':
        assert media_before[chosen] in wire_pixels({'input': wire})
    assert 'REPLACED_FIRST_IMAGE_CANDIDATE' not in encoded(wire)
    assert repo.request('first-source')['round'] == before
    assert original_bytes(repo, media_before) == media_before
    client.close()
