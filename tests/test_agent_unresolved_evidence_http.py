"""An actual history-tool step restores only its inherited reference pixels."""
import base64
import copy
import hashlib
import json

import pytest

from backend.db import connect
from backend.services import agent_execution as execution
from backend.services.agent_repository import AgentRepository, encoded
from scripts.preview_agent import synthetic_image
from test_agent_task_convergence import message, pixels, scripted, select_roles, turn
from test_preview_agent import preview, submit, wait_request


def wire_pixel_hashes(wire):
    return [hashlib.sha256(base64.b64decode(url.split(',', 1)[1], validate=True)).hexdigest()
            for url in pixels(wire)]


def wire_text(wire):
    return '\n'.join(part.get('text', '') for row in wire['body']['input']
                     for part in row.get('content', []) if isinstance(part, dict))


@pytest.mark.parametrize('binding_state', ['taskContext', 'editingTask'])
def test_history_tool_reads_inherited_roles_without_uploading_unrelated_unresolved_history(preview, monkeypatch, binding_state):
    client, provider, seeds, library = preview
    repo = AgentRepository(library)
    plans, wires = scripted(provider, monkeypatch)
    target, light, unrelated = [image['uploadId'] for image in seeds['images']]
    source_text = '  Preserve the original geometric subject.\n\nUse the blue lighting reference exactly.  '
    source = turn(client, plans, 'evidence-source', source_text,
                  refs=[{'kind': 'upload', 'uploadId': aid} for aid in (target, light)])
    select_roles(client, target, [(light, 'lighting')])
    inherited_text = '  Keep the same subject and lighting.\nNo new attachment belongs to this turn.  '
    ancestor = turn(client, plans, 'evidence-inherited', inherited_text, parent=source)
    tail = turn(client, plans, 'evidence-unrelated', 'A different historical geometric picture.', parent=ancestor,
                refs=[{'kind': 'upload', 'uploadId': unrelated}])

    # Reproduce an old discussion turn whose bindings survived in its task
    # envelope but which owns no input/output slot. Do not manufacture a ref on
    # that turn: the real history tool must close over the earlier frozen IDs.
    old = repo.request('evidence-inherited')['round']
    old.update(inputImageIds=[], taskImageIds=[], outputTaskIds=[])
    target_binding = {'assetId': target, 'source': {'kind': 'upload', 'uploadId': target}}
    light_binding = {'assetId': light, 'source': {'kind': 'upload', 'uploadId': light}, 'role': 'lighting'}
    if binding_state == 'taskContext':
        old['taskContext'].update(target=target_binding, auxiliaries=[light_binding])
        old['editingTask'] = None
    else:
        old['taskContext'].update(target=None, auxiliaries=[])
        old['editingTask'].update(target=target_binding, auxiliaries=[light_binding])
    with connect(library) as conn:
        conn.execute('UPDATE agent_rounds SET data=? WHERE id=?', (encoded(old), ancestor))

    # This fourth fixture has different original bytes from all three seeds.
    current_bytes = synthetic_image(0, transparent=True)
    upload = client.post('/api/agent/uploads', files={'file': ('current.png', current_bytes, 'image/png')})
    assert upload.status_code == 200, upload.text
    current = upload.json()['uploadId']
    expected = {aid: hashlib.sha256(base64.b64decode(repo.data_url(aid).split(',', 1)[1])).hexdigest()
                for aid in (target, light, unrelated, current)}
    assert len(set(expected.values())) == 4

    # Pause only scheduling, not the HTTP route or worker. Install the legacy
    # unresolved state in the isolated queued fixture before executing the exact
    # production worker entry point; no provider result is monkeypatched locally.
    scheduled = []
    with monkeypatch.context() as pending:
        pending.setattr('backend.routers.agent.schedule_request', lambda path, rid: scheduled.append((path, rid)))
        submit(client, 'evidence-current', '  Describe this new image.\nRetain the written constraints.  ', parent=tail,
               refs=[{'kind': 'upload', 'uploadId': current}], images=False)
    assert scheduled == [(library, 'evidence-current')]
    request = repo.request('evidence-current')
    state = request['round']['taskContext']
    state.update(taskType='prompt_optimization', target=None, auxiliaries=[], completeness='history_required',
                 unresolvedItems=['Which older lighting should remain relevant?'],
                 historyDependencies=[{'roundId': row['id'], 'reason': 'unreconciled_user_addition'} for row in request['history']])
    request['round'].update(editingTask=None, taskImageIds=[], contextEvidenceRoundIds=[])
    with connect(library) as conn:
        conn.execute('UPDATE agent_rounds SET data=? WHERE request_id=?', (encoded(request['round']), 'evidence-current'))
        historical_before = dict(conn.execute('SELECT id,data FROM agent_rounds WHERE id<>?', (request['round_id'],)).fetchall())
    frozen_before = copy.deepcopy(repo.request('evidence-current'))
    assert not frozen_before['history'][1]['inputImageIds']
    assert not frozen_before['history'][1]['taskImageIds']
    assert frozen_before['history'][1]['id'] == ancestor
    counts_before, wire_start = dict(provider.counts), len(wires)

    def request_missing_evidence(wire_body):
        wire = {'body': wire_body}
        assert wire_pixel_hashes(wire) == [expected[current]], 'unknown unresolved text must not upload every old picture'
        assert source_text in wire_text(wire) and inherited_text in wire_text(wire)
        assert 'Which older lighting should remain relevant?' in wire_text(wire)
        assert any(tool.get('name') == 'read_task_history' for tool in wire_body['tools'])
        assert not any(tool.get('name') in {'generate_image', 'generate_image_batch'} or tool.get('type') == 'image_generation'
                       for tool in wire_body['tools'])
        return [{'id': 'read-inherited', 'call_id': 'read-inherited', 'type': 'function_call',
                 'name': 'read_task_history', 'arguments': json.dumps({'roundNumbers': [2]})}]

    def answer_with_exact_evidence(wire_body):
        wire = {'body': wire_body}
        hashes = wire_pixel_hashes(wire)
        assert set(hashes) == {expected[target], expected[light], expected[current]}
        assert len(hashes) == 3 and expected[unrelated] not in hashes
        output = next(row for row in wire_body['input'] if row.get('type') == 'function_call_output'
                      and row.get('call_id') == 'read-inherited')
        receipt = json.loads(output['output'])
        assert receipt['pixelsAttachedOnNextStep'] is True
        assert len(receipt['history']) == 1
        assert receipt['history'][0]['roundId'] == ancestor
        assert receipt['history'][0]['user'] == inherited_text
        assert receipt['history'][0]['refs'] == [], 'inherited bindings must not be mistaken for owned attachments'
        assert source_text in wire_text(wire) and inherited_text in wire_text(wire)
        return [message('The requested historical lighting evidence is now visible.')]

    plans.extend([request_missing_evidence, answer_with_exact_evidence])
    execution.run_request(library, 'evidence-current')
    result = wait_request(client, 'evidence-current')
    assert result['request']['state'] == 'completed', result
    sent = wires[wire_start:]
    assert len(sent) == 2 and all(wire['bytes'] > 0 and 'body' in wire for wire in sent)
    assert provider.counts['responses'] == counts_before['responses'] + 2
    assert provider.counts['images'] == counts_before.get('images', 0) == 0
    assert not plans and repo.jobs.list_jobs().jobs == []
    after = repo.request('evidence-current')
    assert after['history'] == frozen_before['history']
    assert after['round']['prompt'] == frozen_before['round']['prompt']
    assert after['round']['taskContext'] == frozen_before['round']['taskContext']
    assert after['round']['parentRoundId'] == tail
    assert after['round']['contextEvidenceRoundIds'] == [ancestor]
    with connect(library) as conn:
        assert dict(conn.execute('SELECT id,data FROM agent_rounds WHERE id<>?', (request['round_id'],)).fetchall()) == historical_before
    assert result['conversation']['activeRoundId'] == request['round_id']
