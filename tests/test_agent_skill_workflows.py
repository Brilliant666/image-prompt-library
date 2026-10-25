"""Task routing contracts; actual HTTP execution is covered separately."""
import pytest

from backend.services.agent_skills import read_agent_skill, selected_skill_sections


def chapters(prompt, images=False, previous=None):
    return [(part['skill'], part['section']) for part in selected_skill_sections(prompt, images, previous)]


@pytest.mark.parametrize('prompt,images,expected', [
    ('使用图片反推工作流，给我简短中文提示词', True, ('image-prompt-reverse', 'analysis')),
    ('Use image-prompt-reverse for a detailed English prompt.', True, ('image-prompt-reverse', 'analysis')),
    ('使用 GPT Image Skill 优化', False, ('gpt-image', 'composition')),
    ('Use GPT Image Skill to polish this brief.', False, ('gpt-image', 'composition')),
    ('使用 GPT Image Skill 优化刚才反推的提示词', True, ('gpt-image', 'composition')),
    ('优化刚才反推的提示词，给更短的英文版本', True, ('gpt-image', 'composition')),
    ('把刚才反推的提示词优化成英文', True, ('gpt-image', 'composition')),
    ('Refine the reverse-engineered prompt into concise English.', True, ('gpt-image', 'composition')),
    ('使用 GPT Image Skill 根据这张图片优化提示词', True, ('gpt-image', 'composition')),
    ('保持主体不变，调整光线', False, ('gpt-image', 'editing')),
    ('保留人物姿势和画幅，只修改背景', True, ('gpt-image', 'editing')),
    ('Change the lighting while preserving the subject and outfit.', True, ('gpt-image', 'editing')),
    ('使用 GPT Image Skill 编写带精确文字的海报排版提示词', False, ('gpt-image', 'text')),
])
def test_explicit_professional_tasks_select_only_required_guidance(prompt, images, expected):
    skill, section = expected
    assert chapters(prompt, images) == [(skill, 'overview'), (skill, section)]


@pytest.mark.parametrize('prompt', [
    '使用图片反推工作流分析参考图，再用 GPT Image Skill 优化成英文 Prompt。',
    '先反推这张图，再使用 GPT Image Skill 优化成英文',
    'Reverse-engineer this image and refine the prompt for controlled lighting.',
])
def test_complex_task_can_combine_two_finite_skills_without_loading_all_sections(prompt):
    selected = selected_skill_sections(prompt, True)
    assert [(part['skill'], part['section']) for part in selected] == [
        ('image-prompt-reverse', 'overview'), ('image-prompt-reverse', 'analysis'),
        ('gpt-image', 'overview'), ('gpt-image', 'composition'),
    ]
    assert len({(part['skill'], part['section']) for part in selected}) == len(selected)
    assert all(part['section'] not in ('illustration', 'text', 'editing') for part in selected)


@pytest.mark.parametrize('prompt', [
    '给我一个更短的英文版本',
    '改成更适合 GPT Image 2.5 的写法',
    'Translate it in English',
    'Make it shorter please',
])
def test_language_length_and_model_followups_require_an_existing_prompt_task(prompt):
    assert chapters(prompt, False, '根据参考图反推中文提示词') == [
        ('gpt-image', 'overview'), ('gpt-image', 'composition'),
    ]
    assert chapters(prompt, False, '解释数据库事务') == []
    assert chapters(prompt, False) == []


@pytest.mark.parametrize('prompt', [
    '这张图为什么好看？', '它的光线有什么特点？', '我该怎么还原这种肤色？',
    '仅描述画面中的几何形状', '介绍一下 GPT Image Skill',
    '解释一下提示词怎么优化', 'How do I optimize a prompt?',
    '如何使用 GPT Image Skill？', '介绍一下如何使用图片反推工作流',
    '请告诉我如何使用 GPT Image Skill', '请告诉我，如何使用图片反推工作流？',
    'Please tell me how to use GPT Image Skill.',
    '不要反推提示词，只分析这张图的光线', '不要反推这张图的提示词，只描述主体。',
    "Don't reverse-engineer a prompt; describe the lighting in this image.",
    '不要使用技能，只优化我给的文字提示词',
])
def test_visual_conversation_and_opt_out_do_not_force_prompt_workflows(prompt):
    assert chapters(prompt, True, '请优化这段提示词：蓝色方块') == []


def test_missing_pixels_do_not_activate_reverse_workflow():
    assert chapters('使用图片反推工作流，给我中文 Prompt', False) == []


@pytest.mark.parametrize('prompt', [
    '不要使用图片反推工作流，只优化现有提示词',
    "Don't use image-prompt-reverse; optimize this prompt.",
])
def test_named_workflow_opt_out_cannot_activate_the_negated_name(prompt):
    assert chapters(prompt, True) == [('gpt-image', 'overview'), ('gpt-image', 'composition')]
    assert chapters('不要使用图片反推工作流，帮我反推这张图片', True) == []
    assert chapters('不要使用 GPT Image Skill，优化这段提示词', False) == []
    assert chapters('不要使用 GPT Image Skill，使用图片反推工作流反推这张图', True) == [
        ('image-prompt-reverse', 'overview'), ('image-prompt-reverse', 'analysis'),
    ]


def test_negating_reverse_task_still_allows_a_separate_prompt_optimization_request():
    assert chapters('不要反推图片，只优化现有提示词：蓝色矩形', True) == [
        ('gpt-image', 'overview'), ('gpt-image', 'composition'),
    ]
    assert chapters('请使用图片反推工作流，给我中文 Prompt', True) == [
        ('image-prompt-reverse', 'overview'), ('image-prompt-reverse', 'analysis'),
    ]


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
