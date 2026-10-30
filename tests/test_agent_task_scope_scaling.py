"""Bounded visual projection of synthetic old chat evidence, without pixel loss."""
import copy
import json
import time

import pytest

from backend.services import agent_task_state
from backend.services.agent_context_pipeline import prepare_context
from backend.services.agent_protocol import response_body
from test_agent_context_correctness import add_round, asset, pixels
from test_agent_image_selection import repo


@pytest.mark.parametrize('count', [5, 25, 50, 100, 200])
def test_long_chat_projects_recent_pixels_and_new_task_drops_only_old_evidence(repo, count):
    aid = asset(repo, 'blue')
    add_round(repo, 'source', 'Preserved geometric source.', assets=[aid])
    request = repo.request('source')
    original_row = request['round']
    old_id = original_row['taskContext']['taskId']
    history = []
    for index in range(1, count + 1):
        row = copy.deepcopy(original_row)
        row.update(id=f'old-{index}', index=index, prompt=f'Exact old requirement {index}.',
                   outputTaskIds=[], frozenOutputImages=[], assistantContent='', responseOutput=[])
        row['taskContext'].update(taskId=old_id, taskType='chat', target=None, auxiliaries=[],
                                  branchRoundId=row['id'], unresolvedItems=[])
        history.append(row)
    current = copy.deepcopy(original_row)
    current.update(id='current', index=count + 1, prompt='生成一张猫咪的图', inputImageIds=[],
                   taskImageIds=[aid], outputTaskIds=[], frozenOutputImages=[], responseOutput=[])
    current['taskContext'].update(taskType='chat', target=None, auxiliaries=[], branchRoundId='current',
        unresolvedItems=[], historyDependencies=[{'roundId': row['id'], 'reason': 'unreconciled_user_addition'} for row in history])
    current['editingTask'] = None
    request.update(history=history, round=current, round_id='current')
    frozen = copy.deepcopy(request)
    before_started = time.perf_counter()
    before = prepare_context(repo, request)
    before_ms = (time.perf_counter() - before_started) * 1000
    # Exact textual evidence stays; repeated old aliases do not all become
    # necessary picture uploads merely because the task type is chat.
    assert len(pixels({'input': before.input})) == 2
    assert before.diagnostics['includedHistoryRoundCount'] == count
    assert not before.diagnostics['experimentalImageDeduplication']
    assert before.diagnostics['serializedDeduplicatedOccurrences'] == 0
    for row in history:
        assert row['prompt'] in [p.get('text') for m in before.input for p in m.get('content', [])]
    assert request == frozen

    updated = agent_task_state.apply(current['taskContext'], [{
        'op': 'start_task', 'taskType': 'image_generation', 'sourceQuote': current['prompt']}],
        actor='model', branch_id='current', select_asset=lambda value: pytest.fail('No image may be substituted'),
        validate_source=lambda *args: pytest.fail('No source rewrite'), user_text=current['prompt'], history=history)
    projected_request = {**request, 'round': {**current, 'taskContext': updated, 'editingTask': None}}
    after_started = time.perf_counter()
    after = prepare_context(repo, projected_request)
    after_ms = (time.perf_counter() - after_started) * 1000
    assert pixels({'input': after.input}) == []
    assert after.diagnostics['includedHistoryRoundCount'] == 0
    assert after.diagnostics['uniqueAssetCount'] == 0
    assert projected_request['history'] == frozen['history'] and request == frozen
    before_body = response_body(request, before.input, None, 'synthetic-only')
    after_body = response_body(projected_request, after.input, None, 'synthetic-only')
    before_bytes = len(json.dumps(before_body, ensure_ascii=False).encode())
    after_bytes = len(json.dumps(after_body, ensure_ascii=False).encode())
    assert after_bytes < before_bytes
    print(json.dumps({'turns': count, 'before_images': 2, 'after_images': 0,
                      'before_json_bytes': before_bytes, 'after_json_bytes': after_bytes,
                      'before_prepare_ms': round(before_ms, 3), 'after_prepare_ms': round(after_ms, 3),
                      'real_provider_latency': 'not measured'}))
