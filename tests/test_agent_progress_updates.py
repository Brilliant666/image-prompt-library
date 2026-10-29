"""Current-round observation, bounded deltas and durable read-only recovery."""
import asyncio
import copy
import json
from concurrent.futures import ThreadPoolExecutor

import pytest

from backend.db import connect
from backend.services import agent_progress as progress
from backend.services.agent_repository import AgentError
from test_agent_context_correctness import add_round
from test_agent_image_selection import repo, body
from test_agent_progress import small_snapshot
from test_agent_workspaces import image_bytes


class Observer:
    disconnected = False

    async def is_disconnected(self):
        return self.disconnected


def parsed(frame):
    return frame.splitlines()[0][7:], json.loads(frame.split('data: ', 1)[1])


def apply_operations(value, operations):
    result = copy.deepcopy(value)
    for operation in operations:
        target = result
        for key in operation['path'][:-1]:
            target = target[key]
        if not operation['path']:
            result = operation['value']
        elif operation['op'] == 'replace':
            target[operation['path'][-1]] = operation['value']
        else:
            key = operation['path'][-1]
            assert len(target[key].encode('utf-16-le')) // 2 == operation['offset']
            target[key] += operation['value']
    return result


def running(repo, count=1):
    parent = None
    for index in range(count):
        parent = add_round(repo, f'req-{index}', f'Synthetic {index}', parent=parent)
    request_id = f'req-{count - 1}'
    repo.update(request_id, state='running', outcome='known')
    return request_id


def test_progress_view_matches_public_snapshot_without_loading_historical_inputs(repo, monkeypatch):
    old_image = repo.store_asset(image_bytes('blue'), None)['id']
    parent = add_round(repo, 'old', 'Historical attachment', assets=[old_image])
    # Explicitly end the visual task: an ordinary follow-up intentionally
    # retains its discussion image after automatic single-upload binding.
    add_round(repo, 'current', 'New task: explain database indexes', parent=parent)
    repo.update('current', state='running', text='Partial 🙂')
    expected = progress.limited_view(repo.snapshot(request_id='current'))
    original_image = repo.image
    def current_image(asset_id):
        assert asset_id != old_image, 'Historical image resolved for a token'
        return original_image(asset_id)
    monkeypatch.setattr(repo, 'image', current_image)
    monkeypatch.setattr(repo, 'request', lambda *args: pytest.fail('Loaded frozen full history'))
    monkeypatch.setattr(repo, '_rounds', lambda *args: pytest.fail('Parsed all rounds'))
    monkeypatch.setattr(repo, 'snapshot', lambda *args, **kwargs: pytest.fail('Assembled full snapshot'))
    assert repo.progress_view('current') == expected


def test_structure_stays_stable_for_current_text_but_changes_for_branches_and_old_rounds(repo):
    request_id = running(repo, 3)
    before = repo.progress_structure(request_id)
    repo.update(request_id, text='many token changes')
    assert repo.progress_structure(request_id) == before
    repo.update('req-0', text='another tab changed history')
    assert repo.progress_structure(request_id) != before
    before = repo.progress_structure(request_id)
    with connect(repo.library) as conn:
        conn.execute("UPDATE agent_rounds SET deleted=1 WHERE request_id='req-0'")
    assert repo.progress_structure(request_id) != before
    with connect(repo.library) as conn:
        conn.execute("UPDATE agent_conversations SET active_round_id=(SELECT round_id FROM agent_requests WHERE id='req-1')")
    with pytest.raises(AgentError) as failure:
        repo.progress_view(request_id)
    assert failure.value.code == 'progress_branch_changed'


def test_same_millisecond_round_writes_have_monotonic_markers_and_old_current_race_resyncs(repo, monkeypatch):
    import backend.services.agent_repository as repository
    import backend.routers.agent as routes
    request_id = running(repo, 2)
    old_stamp = repo.request('req-0')['updated_at']
    current_stamp = repo.request(request_id)['updated_at']
    monkeypatch.setattr(repository, 'milliseconds', lambda: min(old_stamp, current_stamp))
    token, structure = repo.progress_token(request_id), repo.progress_structure(request_id)
    snapshot = repo.snapshot(request_id=request_id)
    # A final old-round diagnostic and new streamed text commit at the same
    # wall-clock millisecond. Both version markers must survive either order.
    with ThreadPoolExecutor(max_workers=2) as pool:
        old_write = pool.submit(repo.record_context_diagnostics, 'req-0', {'schemaVersion': 1, 'messageCount': 9})
        new_write = pool.submit(repo.update, request_id, text='New text at the same millisecond')
        old_write.result()
        new_write.result()
    assert repo.request('req-0')['updated_at'] == old_stamp + 1
    assert repo.request(request_id)['updated_at'] == current_stamp + 1
    assert repo.progress_structure(request_id) != structure
    repo.update(request_id, text='Another current write')
    assert repo.request(request_id)['updated_at'] == current_stamp + 2
    monkeypatch.setattr(routes, 'PROGRESS_INTERVAL', 0.001)
    async def observe():
        return [parsed(frame) async for frame in routes.progress_events(Observer(), repo, request_id, token, snapshot, structure)]
    assert [kind for kind, _ in asyncio.run(observe())] == ['snapshot', 'resync']


def test_delta_preserves_repeated_unicode_text_and_array_replacement():
    before = progress.limited_view(small_snapshot(text='好🙂'))
    after = copy.deepcopy(before)
    after['messages'][0]['content'] += '好🙂'
    after['jobs'] = [{'id': 'job-1', 'status': 'queued'}]
    operations = progress.diff_view(before, after)
    assert {'op': 'append', 'path': ['messages', 0, 'content'], 'offset': 3, 'value': '好🙂'} in operations
    assert {'op': 'replace', 'path': ['jobs'], 'value': after['jobs']} in operations
    assert apply_operations(before, operations) == after
    correction = copy.deepcopy(after)
    correction['messages'][0]['content'] = 'Corrected final text'
    assert apply_operations(after, progress.diff_view(after, correction)) == correction
    assert before['messages'][0]['content'] == '好🙂'


def test_every_epoch_starts_from_snapshot_and_bounds_cache_patch_and_operation_count(monkeypatch):
    snapshot = small_snapshot()
    first, second = progress.ProgressSession(snapshot), progress.ProgressSession(snapshot)
    assert first.identity['epoch'] != second.identity['epoch']
    assert first.sequence == second.sequence == 0
    after = progress.limited_view(small_snapshot(text='x' * 200))
    monkeypatch.setattr(progress, 'MAX_PATCH_BYTES', 50)
    with pytest.raises(progress.ProgressLimit, match='patch_limit'):
        first.patch(after)
    assert first.sequence == 0
    monkeypatch.setattr(progress, 'MAX_VIEW_BYTES', 50)
    assert progress.ProgressSession(snapshot).view is None
    with pytest.raises(progress.ProgressLimit, match='view_limit'):
        second.patch(after)
    monkeypatch.setattr(progress, 'MAX_OPERATIONS', 2)
    with pytest.raises(progress.ProgressLimit, match='patch_limit'):
        progress.diff_view([0, 0, 0], [1, 1, 1])


def test_initial_snapshot_race_coalesces_to_final_patch_and_never_rebuilds_history(repo, monkeypatch):
    import backend.routers.agent as routes
    request_id = running(repo, 5)
    token, structure = repo.progress_token(request_id), repo.progress_structure(request_id)
    snapshot = repo.snapshot(request_id=request_id)
    # This write occurs after the initial read and before subscription begins.
    repo.update(request_id, text='hello hello 🙂', state='completed', outcome='known')
    final = repo.progress_view(request_id)
    monkeypatch.setattr(routes, 'PROGRESS_INTERVAL', 0.001)
    monkeypatch.setattr(repo, 'snapshot', lambda *args, **kwargs: pytest.fail('Full history during normal progress'))
    async def observe():
        return [parsed(frame) async for frame in routes.progress_events(Observer(), repo, request_id, token, snapshot, structure)]
    events = asyncio.run(observe())
    assert [kind for kind, _ in events] == ['snapshot', 'patch']
    initial, patch = events[0][1], events[1][1]
    assert patch['baseSequence'] == 0 and patch['sequence'] == 1
    assert apply_operations(initial['stream']['view'], patch['operations']) == final
    assert final['request']['state'] == 'completed'
    assert len(initial['conversation']['rounds']) == 5
    assert len(final['messages']) == 2


def test_mutation_during_projection_is_observed_again_instead_of_losing_terminal(repo, monkeypatch):
    import backend.routers.agent as routes
    request_id = running(repo)
    token, structure = repo.progress_token(request_id), repo.progress_structure(request_id)
    snapshot = repo.snapshot(request_id=request_id)
    repo.update(request_id, text='first')
    original_view = repo.progress_view
    views = []
    def raced_view(value):
        result = original_view(value)
        views.append(result)
        if len(views) == 1:
            repo.update(value, text='first final', state='completed', outcome='known')
        return result
    monkeypatch.setattr(repo, 'progress_view', raced_view)
    monkeypatch.setattr(routes, 'PROGRESS_INTERVAL', 0.001)
    async def observe():
        return [parsed(frame) async for frame in routes.progress_events(Observer(), repo, request_id, token, snapshot, structure)]
    events = asyncio.run(observe())
    assert [kind for kind, _ in events] == ['snapshot', 'patch', 'patch']
    result = events[0][1]['stream']['view']
    for _, patch in events[1:]:
        result = apply_operations(result, patch['operations'])
    assert result['request']['state'] == 'completed'
    assert result['messages'][-1]['content'] == 'first final'


def test_safe_resume_during_initial_snapshot_never_publishes_stale_terminal(repo, monkeypatch):
    import backend.routers.agent as routes
    request_id = running(repo)
    repo.update(request_id, state='interrupted', outcome='known')
    token, structure = repo.progress_token(request_id), repo.progress_structure(request_id)
    original_request = repo.request
    def raced_request(value):
        old = original_request(value)
        assert repo.resume(value, 'resume-during-snapshot')
        return old
    monkeypatch.setattr(repo, 'request', raced_request)
    snapshot = repo.snapshot(request_id=request_id)
    assert snapshot['request']['state'] == 'interrupted'
    assert original_request(request_id)['state'] == 'queued'
    async def observe():
        return [parsed(frame) async for frame in routes.progress_events(Observer(), repo, request_id, token, snapshot, structure)]
    assert [kind for kind, _ in asyncio.run(observe())] == ['resync']


def test_safe_resume_during_terminal_projection_keeps_observer_running(repo, monkeypatch):
    import backend.routers.agent as routes
    request_id = running(repo)
    token, structure = repo.progress_token(request_id), repo.progress_structure(request_id)
    snapshot = repo.snapshot(request_id=request_id)
    repo.update(request_id, state='interrupted', outcome='known')
    original_view = repo.progress_view
    count = 0
    def raced_view(value):
        nonlocal count
        count += 1
        result = original_view(value)
        if count == 1:
            assert result['request']['state'] == 'interrupted'
            assert repo.resume(value, 'resume-during-projection')
        elif count == 2:
            assert result['request']['state'] == 'queued'
            repo.update(value, text='Resumed result', state='completed', outcome='known')
        return result
    monkeypatch.setattr(repo, 'progress_view', raced_view)
    monkeypatch.setattr(routes, 'PROGRESS_INTERVAL', 0.001)
    async def observe():
        return [parsed(frame) async for frame in routes.progress_events(Observer(), repo, request_id, token, snapshot, structure)]
    events = asyncio.run(observe())
    assert [kind for kind, _ in events] == ['snapshot', 'patch', 'patch']
    result = events[0][1]['stream']['view']
    states = []
    for _, patch in events[1:]:
        result = apply_operations(result, patch['operations'])
        states.append(result['request']['state'])
    assert states == ['queued', 'completed']
    assert result['messages'][-1]['content'] == 'Resumed result'


def test_structure_change_resyncs_and_oversized_view_falls_back_without_replaying(repo, monkeypatch):
    import backend.routers.agent as routes
    request_id = running(repo, 2)
    token, structure = repo.progress_token(request_id), repo.progress_structure(request_id)
    snapshot = repo.snapshot(request_id=request_id)
    with connect(repo.library) as conn:
        conn.execute("UPDATE agent_conversations SET title='Changed elsewhere'")
    monkeypatch.setattr(routes, 'PROGRESS_INTERVAL', 0.001)
    async def observe():
        return [parsed(frame) async for frame in routes.progress_events(Observer(), repo, request_id, token, snapshot, structure)]
    assert [kind for kind, _ in asyncio.run(observe())] == ['snapshot', 'resync']
    monkeypatch.setattr(progress, 'MAX_VIEW_BYTES', 1)
    events = asyncio.run(observe())
    assert [kind for kind, _ in events] == ['snapshot', 'fallback']
    assert events[-1][1] == {'reason': 'view_limit'}
    assert repo.request(request_id)['state'] == 'running'


def test_multiple_observers_and_disconnect_preserve_execution_and_other_cursor(repo, monkeypatch):
    import backend.routers.agent as routes
    request_id = running(repo)
    token, structure = repo.progress_token(request_id), repo.progress_structure(request_id)
    snapshot = repo.snapshot(request_id=request_id)
    monkeypatch.setattr(routes, 'PROGRESS_INTERVAL', 0.001)
    async def observe():
        a, b = Observer(), Observer()
        first = routes.progress_events(a, repo, request_id, token, snapshot, structure)
        second = routes.progress_events(b, repo, request_id, token, snapshot, structure)
        epoch_a = parsed(await anext(first))[1]['stream']['epoch']
        epoch_b = parsed(await anext(second))[1]['stream']['epoch']
        assert epoch_a != epoch_b
        a.disconnected = True
        assert [event async for event in first] == []
        assert repo.request(request_id)['state'] == 'running'
        repo.update(request_id, text='Success persisted', state='completed', outcome='known')
        events = [parsed(event) async for event in second]
        assert len(events) == 1 and events[0][0] == 'patch'
        assert events[0][1]['epoch'] == epoch_b and events[0][1]['sequence'] == 1
    asyncio.run(observe())
    assert repo.request(request_id)['state'] == 'completed'


def test_job_only_changes_are_projected_and_removed_pixels_cannot_keep_success_card(repo):
    from backend.services.agent_execution import create_image_job
    repo.create_round('conversation', body(repo, request_id='image-request', images=True))
    repo.update('image-request', state='running', outcome='known')
    job = create_image_job(repo, 'image-request', 1, 'call', 'item', 'Synthetic image', {})
    previous = repo.progress_token('image-request')
    repo.jobs.stage_result(job.id, image_bytes('blue'), 'synthetic.png')
    current = repo.progress_token('image-request')
    assert previous[0] == current[0] and previous[1] != current[1]
    view = repo.progress_view('image-request')
    assert view == progress.limited_view(repo.snapshot(request_id='image-request'))
    assert view['jobs'][0]['status'] == 'succeeded'
    assert next(image for image in view['images'] if image['id'] == 'output_' + job.id)['status'] == 'available'
    repo.jobs.discard_job(job.id)
    removed = repo.progress_view('image-request')
    assert removed['jobs'][0]['status'] == 'discarded'
    assert next(image for image in removed['images'] if image['id'] == 'output_' + job.id)['status'] == 'removed'


def test_lost_terminal_publication_recovers_persisted_success_by_get(repo, monkeypatch):
    import backend.routers.agent as routes
    request_id = running(repo)
    token, structure = repo.progress_token(request_id), repo.progress_structure(request_id)
    snapshot = repo.snapshot(request_id=request_id)
    repo.update(request_id, text='Persisted success', state='completed', outcome='known')
    monkeypatch.setattr(routes, 'PROGRESS_INTERVAL', 0.001)
    def publication_failed(self, view):
        assert view['request']['state'] == 'completed'
        raise progress.ProgressLimit('patch_limit')
    monkeypatch.setattr(progress.ProgressSession, 'patch', publication_failed)
    async def observe():
        return [parsed(frame) async for frame in routes.progress_events(Observer(), repo, request_id, token, snapshot, structure)]
    events = asyncio.run(observe())
    assert [kind for kind, _ in events] == ['snapshot', 'fallback']
    restored = repo.snapshot(request_id=request_id)
    assert restored['request']['state'] == 'completed'
    assert restored['conversation']['messages'][-1]['content'] == 'Persisted success'


def test_progress_view_preserves_automatic_visual_object_without_parsing_history(repo, monkeypatch):
    image = repo.store_asset(image_bytes('blue'), None)['id']
    parent = add_round(repo, 'visual', 'Reverse this image', assets=[image])
    add_round(repo, 'follow-up', 'Make the lighting softer, keep everything else', parent=parent)
    repo.update('follow-up', state='running', text='Partial response')
    expected = progress.limited_view(repo.snapshot(request_id='follow-up'))
    original_image = repo.image
    resolved = []
    def task_image(asset_id):
        resolved.append(asset_id)
        assert asset_id == image
        return original_image(asset_id)
    monkeypatch.setattr(repo, 'image', task_image)
    monkeypatch.setattr(repo, 'data_url', lambda *args: pytest.fail('Encoded image pixels for progress'))
    monkeypatch.setattr(repo, 'request', lambda *args: pytest.fail('Loaded frozen full history'))
    monkeypatch.setattr(repo, '_rounds', lambda *args: pytest.fail('Parsed all historical rounds'))
    monkeypatch.setattr(repo, 'snapshot', lambda *args, **kwargs: pytest.fail('Assembled full snapshot'))
    assert repo.progress_view('follow-up') == expected
    assert resolved and set(resolved) == {image}
