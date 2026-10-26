"""Task-aware prompt guidance reaches real request payloads without paid APIs."""
import base64
import json

import pytest

from backend.db import connect
from backend.services import agent_execution as execution
from backend.services import agent_skills
from backend.services.agent_repository import AgentRepository, encoded
from backend.services.agent_skills import read_agent_skill
from test_agent_workspaces import image_bytes, isolated
from test_agent_workflow_execution import application, answer, pixels, submit, upload, used_sections


EDITING = {('gpt-image', 'overview'), ('gpt-image', 'editing')}


@pytest.mark.parametrize('prompt,expected', [
    ('修改这张图片的背景，保持主体不变，先给我提示词。', EDITING),
    ('Using this image, change the background and give me a prompt first.', EDITING),
    ('先反推这张图的提示词，再调整背景。',
     {('image-prompt-reverse', 'overview'), ('image-prompt-reverse', 'analysis')}),
    ('使用图片反推工作流，修改这张图片的背景，先给我提示词。',
     {('image-prompt-reverse', 'overview'), ('image-prompt-reverse', 'analysis')}),
    ('根据这张图生成提示词。',
     {('image-prompt-reverse', 'overview'), ('image-prompt-reverse', 'analysis')}),
    ('这张图的光线有什么特点？', set()),
])
def test_library_edit_prompt_prefers_editing_unless_reverse_is_explicit(isolated, monkeypatch, prompt, expected):
    with application(isolated, monkeypatch) as (client, calls, replies):
        original = 'Original Library prompt.\n  Keep its exact text. '
        created = client.post('/api/items', json={'title': 'Synthetic workflow reference', 'prompts': [
            {'language': 'original', 'text': original, 'is_original': True, 'is_primary': True}]}).json()
        image = client.post('/api/items/' + created['id'] + '/images', files={
            'file': ('blue.png', image_bytes('blue'), 'image/png')}).json()
        before = client.get('/api/items/' + created['id']).json()
        reference = {'kind': 'library', 'imageId': image['id']}
        result, _ = submit(client, isolated, prompt, refs=[reference])
        assert result['request']['state'] == 'completed'
        assert used_sections(result) == expected
        if expected == EDITING:
            assert result['editingTask']['target']['source'] == reference
        assert len(calls) == 1 and calls[0][0] == '/v1/responses' and result['jobs'] == []
        sent = calls[0][1]
        assert pixels(sent)[0].endswith(base64.b64encode(image_bytes('blue')).decode())
        assert all(tool.get('name') == 'read_agent_skill' for tool in sent['tools'])
        for name, section in EDITING | {('image-prompt-reverse', 'overview'), ('image-prompt-reverse', 'analysis')}:
            assert guidance_count(sent, name, section) == int((name, section) in expected)
        assert client.get('/api/items/' + created['id']).json() == before
        assert result['conversation']['messages'][0]['content'] == prompt


def guidance_count(sent, skill, section):
    content = read_agent_skill(skill, section)['content']
    return sum(value.count(content) for value in [sent.get('instructions', '')] + [
        part.get('text', '') for item in sent.get('input', []) for part in item.get('content', [])])


def update_task(client, snapshot, task):
    response = client.patch('/api/agent/conversations/conv/editing-task', json={
        'expectedRevision': snapshot['revision'], 'branchRoundId': snapshot['conversation']['activeRoundId'], 'task': task})
    assert response.status_code == 200, response.text
    return response.json()


def select_branch(client, round_id):
    snapshot = client.get('/api/agent/conversations/conv').json()
    response = client.patch('/api/agent/conversations/conv', json={
        'expectedRevision': snapshot['revision'], 'activeRoundId': round_id})
    assert response.status_code == 200, response.text
    return response.json()


def test_editing_task_carries_short_answers_across_multiple_turns(isolated, monkeypatch):
    with application(isolated, monkeypatch) as (client, calls, replies):
        image = upload(client)
        prompts = ['帮她换袜子', '白色过膝袜', '就换白色的', '保持原来的姿势', '接着改背景', '按照刚才的效果继续', '优化这个提示词', '重新试一次']
        for index, prompt in enumerate(prompts):
            replies.append(answer('需要换成什么款式？' if index == 0 else '已确认当前修改要求。'))
            result, _ = submit(client, isolated, prompt, rid=f'turn-{index}', refs=[image] if index == 0 else [])
            assert used_sections(result) == EDITING
            assert result['editingTask']['target']['source'] == image
            assert result['jobs'] == []
            assert all('skillPreloads' not in row for row in result['conversation']['rounds'])
            for name, section in EDITING:
                assert guidance_count(calls[-1][1], name, section) == 1
        assert len(calls) == len(prompts)
        assert result['conversation']['messages'][0]['content'] == prompts[0]
        repo = AgentRepository(isolated)
        assert len(repo.request('turn-0')['round']['skillPreloads']) == 2
        assert all(not repo.request(f'turn-{i}')['round'].get('skillPreloads') for i in range(1, len(prompts)))


def test_manual_workflow_choice_applies_to_confirmed_task_and_can_end(isolated, monkeypatch):
    with application(isolated, monkeypatch) as (client, calls, replies):
        image = upload(client)
        current = client.get('/api/agent/conversations/conv').json()
        update_task(client, current, {'target': image, 'requirements': '反推中文提示词', 'workflow': 'image-prompt-reverse'})
        result, _ = submit(client, isolated, '请开始', rid='reverse')
        assert used_sections(result) == {('image-prompt-reverse', 'overview'), ('image-prompt-reverse', 'analysis')}
        update_task(client, result, None)
        result, _ = submit(client, isolated, '继续', rid='ended')
        assert result['editingTask'] is None and used_sections(result) == set()
        assert len(calls) == 2 and result['jobs'] == []


def test_new_task_boundary_stops_old_editing_workflow(isolated, monkeypatch):
    with application(isolated, monkeypatch) as (client, calls, replies):
        submit(client, isolated, '帮她换袜子', rid='edit', refs=[upload(client)])
        result, _ = submit(client, isolated, '换个话题，解释数据库索引', rid='new-topic')
        assert result['editingTask'] is None and used_sections(result) == set()
        assert all(guidance_count(calls[-1][1], name, section) == 0 for name, section in EDITING)
        result, _ = submit(client, isolated, '继续', rid='continue-topic')
        assert result['editingTask'] is None and used_sections(result) == set()
        assert result['jobs'] == [] and len(calls) == 3


@pytest.mark.parametrize('prompt', [
    'Do not start a new task; keep the pose and change the background.',
    "Don't start a new editing task; change the background.",
    "Don't end this task; keep the pose and change the background.",
    '不要结束当前任务，保持姿势并修改背景。',
])
def test_negated_task_boundary_preserves_target_constraints_and_pixels(isolated, monkeypatch, prompt):
    with application(isolated, monkeypatch) as (client, calls, replies):
        image = upload(client)
        snapshot = client.get('/api/agent/conversations/conv').json()
        update_task(client, snapshot, {'target': image, 'requirements': '调整背景',
                                     'constraints': ['保持姿势'], 'workflow': 'gpt-image'})
        first, _ = submit(client, isolated, '请开始', rid='first')
        second, _ = submit(client, isolated, prompt, rid='continue')
        assert second['editingTask']['target'] == first['editingTask']['target']
        assert second['editingTask']['constraints'] == ['保持姿势']
        assert second['editingTask']['workflow'] == 'gpt-image'
        assert used_sections(second) == EDITING and second['jobs'] == []
        assert pixels(calls[-1][1]) == pixels(calls[0][1])


def test_manual_end_blocks_previous_prompt_fallback(isolated, monkeypatch):
    with application(isolated, monkeypatch) as (client, calls, replies):
        first, _ = submit(client, isolated, '修改图片人物服装，优化这段提示词', refs=[upload(client)], rid='first')
        assert first['editingTask']['target'] and used_sections(first)
        update_task(client, first, None)
        ended, _ = submit(client, isolated, '继续', rid='ended')
        assert ended['editingTask'] is None and used_sections(ended) == set()
        assert all(guidance_count(calls[-1][1], name, section) == 0 for name, section in EDITING)


def test_disabled_workflows_neither_read_nor_inject_preload_then_reenable(isolated, monkeypatch):
    with application(isolated, monkeypatch) as (client, calls, replies):
        first, _ = submit(client, isolated, '帮她换袜子', refs=[upload(client)], rid='first')
        assert used_sections(first) == EDITING
        config = client.get('/api/agent/config').json()
        changed = client.put('/api/agent/config', json={'expectedRevision': config['revision'],
            'config': {**config['config'], 'professionalPromptWorkflows': False}})
        assert changed.status_code == 200 and len(calls) == 1
        def forbidden(*args, **kwargs):
            raise AssertionError('Disabled workflows must not read or authenticate skill bodies')
        with monkeypatch.context() as guard:
            guard.setattr(execution, 'read_agent_skill', forbidden)
            guard.setattr(agent_skills, 'read_agent_skill', forbidden)
            off, _ = submit(client, isolated, '继续优化', rid='off')
        assert off['request']['state'] == 'completed' and used_sections(off) == set()
        assert calls[-1][1]['tools'] == [] and off['jobs'] == []
        assert all(guidance_count(calls[-1][1], name, section) == 0 for name, section in EDITING)
        config = client.get('/api/agent/config').json()
        client.put('/api/agent/config', json={'expectedRevision': config['revision'],
            'config': {**config['config'], 'professionalPromptWorkflows': True}})
        on, _ = submit(client, isolated, '继续优化', rid='on')
        assert used_sections(on) == EDITING and on['request']['state'] == 'completed'
        assert all(guidance_count(calls[-1][1], name, section) == 1 for name, section in EDITING)
        assert len(calls) == 3 and on['jobs'] == []


def test_workflow_receipts_are_branch_local_and_do_not_fabricate_tool_history(isolated, monkeypatch):
    with application(isolated, monkeypatch) as (client, calls, replies):
        root, _ = submit(client, isolated, '你好', rid='root')
        ancestor = root['conversation']['activeRoundId']
        left, _ = submit(client, isolated, '帮她换袜子', refs=[upload(client)], rid='left')
        left_id = left['conversation']['activeRoundId']
        select_branch(client, ancestor)
        right, _ = submit(client, isolated, '根据参考图反推中文提示词', refs=[upload(client, 'red')], rid='right')
        reverse = {('image-prompt-reverse', 'overview'), ('image-prompt-reverse', 'analysis')}
        assert used_sections(right) == reverse
        assert all(guidance_count(calls[-1][1], name, section) == 0 for name, section in EDITING)
        select_branch(client, left_id)
        resumed, _ = submit(client, isolated, '继续', rid='resumed')
        assert used_sections(resumed) == EDITING
        sent = calls[-1][1]
        assert all(guidance_count(sent, name, section) == 0 for name, section in reverse)
        assert all(guidance_count(sent, name, section) == 1 for name, section in EDITING)
        assert not any(item.get('type') in {'function_call', 'function_call_output'} for item in sent['input'])
        assert sent['input'][0]['role'] == 'user'
        assert sent['input'][0]['content'][0]['text'].startswith('Application-supplied bundled skill guidance;')
        assert len(calls) == 4 and resumed['jobs'] == []


@pytest.mark.parametrize('damage', ['revision', 'content', 'section', 'metadata-only'])
def test_unverified_preload_receipt_is_reloaded_from_pinned_source(isolated, monkeypatch, damage):
    with application(isolated, monkeypatch) as (client, calls, replies):
        submit(client, isolated, '帮她换袜子', refs=[upload(client)], rid='first')
        with connect(isolated) as conn:
            row = conn.execute('SELECT id,data FROM agent_rounds WHERE request_id=?', ('first',)).fetchone()
            value = json.loads(row['data'])
            for receipt in value['skillPreloads']:
                if damage == 'metadata-only':
                    receipt.pop('content')
                else:
                    receipt[damage] = 'not-the-pinned-body'
            conn.execute('UPDATE agent_rounds SET data=? WHERE id=?', (encoded(value), row['id']))
        result, _ = submit(client, isolated, '继续优化', rid='next')
        assert used_sections(result) == EDITING and result['request']['state'] == 'completed'
        for name, section in EDITING:
            assert read_agent_skill(name, section)['content'] in calls[-1][1]['instructions']
            assert guidance_count(calls[-1][1], name, section) == 1
        assert 'not-the-pinned-body' not in json.dumps(calls[-1][1])


@pytest.mark.parametrize('prompt', ['你好', '这张图为什么好看？', '它的光线有什么特点？', '只分析构图，不要反推'])
def test_visual_chat_during_editing_does_not_force_guidance_or_generation(isolated, monkeypatch, prompt):
    with application(isolated, monkeypatch) as (client, calls, replies):
        submit(client, isolated, '帮她换袜子', refs=[upload(client)], rid='first')
        result, _ = submit(client, isolated, prompt, images=True, rid='analysis')
        assert result['request']['state'] == 'completed' and used_sections(result) == set()
        assert result['jobs'] == [] and len(calls) == 2
        assert all(guidance_count(calls[-1][1], name, section) == 0 for name, section in EDITING)
