"""The real worker exposes fixed foundations and follows model-selected chapters."""
import base64
import json

import pytest

from backend.services.agent_skills import default_skill_sections, read_agent_skill
from test_agent_workflow_execution import application, answer, pixels, submit, upload, used_sections
from test_agent_workspaces import image_bytes, isolated


FOUNDATIONS = {('image-prompt-reverse', 'overview'), ('gpt-image', 'overview')}


def strings(value):
    if isinstance(value, str):
        # Responses function outputs are JSON strings, unlike instructions.
        try:
            decoded = json.loads(value)
        except (ValueError, TypeError):
            decoded = None
        if isinstance(decoded, (dict, list)):
            yield from strings(decoded)
        else:
            yield value
    elif isinstance(value, dict):
        for item in value.values():
            yield from strings(item)
    elif isinstance(value, list):
        for item in value:
            yield from strings(item)


def chapter_call(skill, section, identity):
    return {'id': identity, 'call_id': identity, 'type': 'function_call', 'name': 'read_agent_skill',
            'arguments': json.dumps({'skill': skill, 'section': section})}


def assert_foundations_once(sent):
    for section in default_skill_sections():
        assert sent['instructions'].count(section['content']) == 1
        assert sum(part.count(section['content']) for part in strings(sent)) == 1


@pytest.mark.parametrize('prompt,with_image', [
    ('你好', False),
    ('先说说你的看法，暂时什么也别画。', True),
    ('接着来，不过衣服换成另一身，其他照旧。', True),
    ('使用图片反推工作流，再使用 GPT Image Skill。', True),
])
def test_tasks_receive_same_default_foundations_without_keyword_loading(isolated, monkeypatch, prompt, with_image):
    with application(isolated, monkeypatch) as (client, calls, replies):
        refs = [upload(client)] if with_image else []
        result, _ = submit(client, isolated, prompt, refs=refs)
        assert result['request']['state'] == 'completed'
        assert used_sections(result) == FOUNDATIONS
        assert len(calls) == 1 and calls[0][0] == '/v1/responses'
        sent = calls[0][1]
        assert_foundations_once(sent)
        assert bool(pixels(sent)) == with_image
        if with_image:
            assert pixels(sent)[0].endswith(base64.b64encode(image_bytes('blue')).decode())
        assert 'read_agent_skill' in {tool.get('name') for tool in sent['tools']}
        for skill, section in [('image-prompt-reverse', 'analysis'), ('gpt-image', 'editing'), ('gpt-image', 'composition')]:
            assert read_agent_skill(skill, section)['content'] not in sent['instructions']
        assert result['jobs'] == [] and client.get('/api/items').json()['items'] == []


@pytest.mark.parametrize('skill,section', [
    ('image-prompt-reverse', 'analysis'), ('gpt-image', 'editing'), ('gpt-image', 'text'),
])
def test_model_selected_chapter_reaches_real_followup_request_without_application_routing(isolated, monkeypatch, skill, section):
    with application(isolated, monkeypatch) as (client, calls, replies):
        replies.extend([
            {'id': 'read-chapter', 'status': 'completed', 'output': [chapter_call(skill, section, 'chapter')]},
            answer('Only the requested text response.\n\n```text\nPreserved wording.\n```'),
        ])
        # No fixed keyword is required for the model's selected chapter to work.
        result, original = submit(client, isolated, '再试另一种表达，细节都照着上面的要求来。', refs=[upload(client)])
        assert result['request']['state'] == 'completed'
        assert [path for path, _ in calls] == ['/v1/responses', '/v1/responses']
        assert used_sections(result) == FOUNDATIONS | {(skill, section)}
        expected = read_agent_skill(skill, section)
        output = next(part for part in calls[1][1]['input'] if part.get('type') == 'function_call_output' and part['call_id'] == 'chapter')
        assert json.loads(output['output']) == expected
        assert sum(part.count(expected['content']) for part in strings(calls[1][1])) == 1
        for _, sent in calls:
            assert_foundations_once(sent)
            assert pixels(sent)
        assert result['conversation']['messages'][-1]['content'].startswith('Only the requested text response.')
        assert result['jobs'] == [] and client.get('/api/items').json()['items'] == []
        assert client.post('/api/agent/conversations/conv/rounds', json=original).status_code == 200
        assert len(calls) == 2


def test_model_can_combine_two_chapters_without_extra_classifier_or_image_calls(isolated, monkeypatch):
    chapters = [('image-prompt-reverse', 'analysis'), ('gpt-image', 'composition')]
    with application(isolated, monkeypatch) as (client, calls, replies):
        replies.extend([
            {'id': 'combined', 'status': 'completed', 'output': [
                chapter_call(skill, section, 'chapter-' + str(index))
                for index, (skill, section) in enumerate(chapters)]},
            answer(),
        ])
        result, _ = submit(client, isolated, '用两套专业方法帮我完成这个思路。', refs=[upload(client)])
        assert result['request']['state'] == 'completed'
        assert [path for path, _ in calls] == ['/v1/responses', '/v1/responses']
        assert used_sections(result) == FOUNDATIONS | set(chapters)
        outputs = {part['call_id']: json.loads(part['output']) for part in calls[1][1]['input']
                   if part.get('type') == 'function_call_output'}
        for index, (skill, section) in enumerate(chapters):
            expected = read_agent_skill(skill, section)
            assert outputs['chapter-' + str(index)] == expected
            assert sum(part.count(expected['content']) for part in strings(calls[1][1])) == 1
        assert_foundations_once(calls[1][1])
        assert result['jobs'] == []


def test_prompt_contract_distinguishes_derivation_and_preserves_user_format_and_original():
    reverse = read_agent_skill('image-prompt-reverse')['content']
    craft = read_agent_skill('gpt-image')['content']
    assert 'inferred / derived prompt' in reverse
    assert '不是图片真实使用过的原始 Prompt' in reverse
    assert '未指定时沿用用户语言' in reverse
    assert '不强制固定字数、双语或负面词数量' in reverse
    assert '450' not in reverse and '700' not in reverse and '10—15' not in reverse
    assert '不覆盖原文' in craft and '局部修改范围' in craft
    assert '代码块' in craft and '不能从生图权限推断' in craft
    assert 'does not authorize image generation' in reverse
