"""A conversation's working result is distinct from its original reference."""
import json

import pytest

from backend.services import agent_execution as execution
from backend.services.agent_repository import AgentError
from backend.db import connect
from test_agent_editing_task import done, patch, turn, upload
from test_agent_image_selection import repo
from test_agent_workspaces import image_bytes
from test_preview_agent import preview


def generated(repo, *, count=1, status='succeeded'):
    original = upload(repo, 'red')
    request = turn(repo, 'create', 'Create a seated synthetic subject',
                   [{'kind': 'upload', 'uploadId': original}])
    refs = execution.refs_for_request(repo, request)
    jobs = []
    for index in range(count):
        job = execution.create_image_job(repo, 'create', 1, f'call-{index}', str(index),
                                         'Exact executed prompt\n  Preserve whitespace.', refs)
        if status == 'succeeded':
            repo.jobs.stage_result(job.id, image_bytes(('green', 'blue')[index]), 'synthetic.png')
        else:
            with connect(repo.library) as conn:
                conn.execute('UPDATE generation_jobs SET status=? WHERE id=?', ('failed' if status == 'unknown' else status, job.id))
        jobs.append(repo.jobs.get_job(job.id))
    if status == 'unknown':
        repo.update('create', state='unknown', outcome='unknown')
    else:
        done(repo, 'create')
    return original, repo.request('create'), jobs


@pytest.mark.parametrize('prompt', ['这张图头太歪了', '背景留白再多一点', 'The sleeve should be longer.'])
def test_followup_uses_single_successful_result_without_magic_words(repo, prompt):
    original, previous, jobs = generated(repo)
    old_frozen = json.dumps(previous, sort_keys=True)
    request = turn(repo, 'follow', prompt, parent=previous['round']['id'])
    task = request['round']['editingTask']
    assert task['target']['source'] == {'kind': 'job', 'jobId': jobs[0].id}
    refs = execution.refs_for_request(repo, request)
    wire = json.dumps(execution.build_input(repo, request, refs))
    assert repo.data_url(task['target']['assetId']) in wire
    next_job = execution.create_image_job(repo, 'follow', 1, 'edit', 'one', 'Head upright.', refs)
    assert next_job.parameters['input_images'][0]['result_path'] == repo.asset(task['target']['assetId'])['path']
    assert json.dumps(repo.request('create'), sort_keys=True) == old_frozen
    assert repo.request('create')['round']['editingTask']['target']['assetId'] == original
    assert repo.jobs.get_job(jobs[0].id).prompt_text == 'Exact executed prompt\n  Preserve whitespace.'


def test_several_generated_results_are_visible_but_not_implicitly_selected(repo):
    original, previous, jobs = generated(repo, count=2)
    request = turn(repo, 'follow', '头太歪了', parent=previous['round']['id'])
    task = request['round']['editingTask']
    assert task['target'] is None and task['needsTargetSelection']
    assert {entry['source']['jobId'] for entry in task['candidates']} == {job.id for job in jobs}
    refs = execution.refs_for_request(repo, request)
    wire = json.dumps(execution.build_input(repo, request, refs))
    assert all(repo.data_url(entry['assetId']) in wire for entry in task['candidates'])
    with pytest.raises(AgentError):
        execution.create_image_job(repo, 'follow', 1, 'edit', 'one', 'Head upright.', refs)


def test_explicit_original_and_new_attachment_override_working_result(repo):
    original, previous, jobs = generated(repo)
    request = turn(repo, 'original', '<ref id="round-1-reference-1" /> 修改背景',
                   parent=previous['round']['id'])
    assert request['round']['editingTask']['target']['assetId'] == original
    done(repo, 'original')
    new = upload(repo, 'blue')
    request = turn(repo, 'new', '袖子再长一点', [{'kind': 'upload', 'uploadId': new}],
                   parent=previous['round']['id'])
    assert request['round']['editingTask']['target']['assetId'] == new


@pytest.mark.parametrize('status', ['failed', 'unknown', 'cancelled'])
def test_non_success_result_never_becomes_working_image(repo, status):
    original, previous, jobs = generated(repo, status=status)
    request = turn(repo, 'follow', '头太歪了', parent=previous['round']['id'])
    assert request['round']['editingTask']['target']['assetId'] == original


def test_sibling_result_is_not_adopted_and_manual_target_is_preserved(repo):
    original, previous, jobs = generated(repo)
    sibling = turn(repo, 'sibling', 'Standalone branch', parent=None)
    assert not sibling['round'].get('editingTask')
    done(repo, 'sibling')
    chosen = upload(repo, 'blue')
    patch(repo, {'target': {'kind': 'upload', 'uploadId': chosen}, 'requirements': 'Keep my selection'},
          previous['round']['id'])
    request = turn(repo, 'manual', '头太歪了', parent=previous['round']['id'])
    assert request['round']['editingTask']['target']['assetId'] == chosen


@pytest.mark.parametrize('origin', ['edit', 'regenerate'])
def test_fork_replays_the_working_input_not_the_source_answer(repo, origin):
    original, previous, jobs = generated(repo)
    follow = turn(repo, 'follow', '这张图头太歪了', parent=previous['round']['id'])
    working = follow['round']['editingTask']['target']
    refs = execution.refs_for_request(repo, follow)
    answer = execution.create_image_job(repo, 'follow', 1, 'answer', 'one', 'Second answer.', refs)
    repo.jobs.stage_result(answer.id, image_bytes('blue'), 'answer.png')
    done(repo, 'follow')
    from test_agent_image_selection import body
    payload = body(repo, 'fork').model_copy(update={
        'origin': origin, 'derivedFromRoundId': follow['round']['id'],
        'parentRoundId': previous['round']['id'],
        'prompt': follow['round']['prompt'] if origin == 'regenerate' else '头部自然一些',
    })
    repo.create_round('conversation', payload)
    assert repo.request('fork')['round']['editingTask']['target'] == working
    assert working['source']['jobId'] == jobs[0].id
    assert repo.request('follow')['round']['editingTask']['target'] == working


def test_partial_batch_or_cleaned_result_is_not_adopted(repo):
    original, previous, jobs = generated(repo, count=2)
    with connect(repo.library) as conn:
        conn.execute("UPDATE generation_jobs SET status='failed' WHERE id=?", (jobs[1].id,))
    request = turn(repo, 'follow', '头部自然一些', parent=previous['round']['id'])
    assert request['round']['editingTask']['target']['assetId'] == original
    done(repo, 'follow')
    # Even an already-frozen successful output must not revive a cleaned job.
    with connect(repo.library) as conn:
        conn.execute("UPDATE generation_jobs SET status='discarded' WHERE id=?", (jobs[0].id,))
    request = turn(repo, 'cleaned', '头部自然一些', parent=previous['round']['id'])
    assert request['round']['editingTask']['target']['assetId'] == original


def test_new_discussion_image_after_generation_is_not_replaced_by_an_older_result(repo):
    original, previous, jobs = generated(repo)
    new = upload(repo, 'blue')
    discussion = turn(repo, 'discussion', '分析这张图', [{'kind': 'upload', 'uploadId': new}],
                      parent=previous['round']['id'])
    done(repo, 'discussion')
    following = turn(repo, 'following', '头部自然一些', parent=discussion['round']['id'])
    assert following['round']['editingTask']['target']['assetId'] == new


def test_conversational_selection_after_generation_is_not_undone(repo):
    from test_agent_editing_task import selection_call
    original, previous, jobs = generated(repo)
    discussion = turn(repo, 'discussion', '使用最初的图片', parent=previous['round']['id'])
    execution.execute_calls(repo, 'discussion', 1, [selection_call('round-1-reference-1')],
                            execution.refs_for_request(repo, discussion))
    done(repo, 'discussion')
    following = turn(repo, 'following', '头部自然一些', parent=discussion['round']['id'])
    assert following['round']['editingTask']['target']['assetId'] == original


def test_http_worker_uses_result_pixels_in_both_responses_and_images_without_extra_planning(preview, monkeypatch):
    from backend.services.agent_repository import AgentRepository
    from test_agent_task_convergence import generation, pixels, scripted, turn as http_turn
    from test_agent_task_lifecycle_requests import image_transport
    client, provider, seeds, library = preview
    plans, wires = scripted(provider, monkeypatch)
    image_wires = image_transport(provider, monkeypatch)
    parent = http_turn(client, plans, 'seated', '生成坐姿合成图',
                       refs=[{'kind': 'upload', 'uploadId': seeds['images'][0]['uploadId']}],
                       images=True, output=generation(provider, selection=False))
    repository = AgentRepository(library)
    first = repository.request('seated')
    first_job = repository.jobs.get_job(first['round']['outputTaskIds'][0])
    preserved = first_job.prompt_text
    http_turn(client, plans, 'head', '这张图头太歪了', parent=parent,
              images=True, output=generation(provider, selection=False))
    follow = repository.request('head')
    target = follow['round']['editingTask']['target']
    assert target['source'] == {'kind': 'job', 'jobId': first_job.id}
    responses = [wire for wire in wires if 'body' in wire]
    assert len(responses) == 2 and len(image_wires) == 2
    assert repository.data_url(target['assetId']) in pixels(responses[-1])
    result_bytes = (library / first_job.result_path).read_bytes()
    assert image_wires[-1]['files'][0] == result_bytes
    assert repository.jobs.get_job(first_job.id).prompt_text == preserved
    assert len(follow['round']['outputTaskIds']) == 1
    assert follow['round']['taskContext']['selectedPromptVersionId'] is None
    assert not plans


def test_native_worker_keeps_native_protocol_and_continues_the_successful_result(preview, monkeypatch):
    from backend.services.agent_repository import AgentRepository
    from test_agent_execution_correctness import image_result
    from test_agent_task_convergence import pixels, scripted, set_mode, turn as http_turn
    client, provider, seeds, library = preview
    set_mode(client, 'native')
    plans, wires = scripted(provider, monkeypatch)
    parent = http_turn(client, plans, 'native-first', 'Generate a synthetic seated subject',
                       refs=[{'kind': 'upload', 'uploadId': seeds['images'][0]['uploadId']}],
                       images=True, output=[image_result()])
    repository = AgentRepository(library)
    first_job_id = repository.request('native-first')['round']['outputTaskIds'][0]
    http_turn(client, plans, 'native-edit', '头部自然一些', parent=parent,
              images=True, output=[{**image_result(), 'id': 'native-edit-result'}])
    target = repository.request('native-edit')['round']['editingTask']['target']
    assert target['source'] == {'kind': 'job', 'jobId': first_job_id}
    responses = [wire for wire in wires if 'body' in wire]
    assert len(responses) == 2 and not any('path' in wire for wire in wires)
    assert all(any(tool['type'] == 'image_generation' for tool in wire['body']['tools']) for wire in responses)
    assert repository.data_url(target['assetId']) in pixels(responses[-1])
    assert not plans
