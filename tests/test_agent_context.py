"""Image-context optimization must not silently change reference semantics."""
import copy

import pytest

from backend.services.agent_context import select_context_images


def request(prompt, inputs=()):
    return {"round": {"index": 3, "prompt": prompt, "inputImageIds": list(inputs), "outputTaskIds": []},
            "history": [{"index": 1, "prompt": "Original text stays unchanged.", "inputImageIds": ["old-input"]}]}


REFS = {"round-1-image-1": "old-output", "round-1-reference-1": "old-input",
        "round-2-image-1": "other-output", "round-3-reference-1": "current"}


@pytest.mark.parametrize("prompt", ["根据参考图生成一张照片", "修改 @图1 的背景", "Describe this attached image."])
def test_current_attachments_limit_image_bytes_without_mutating_history(prompt):
    value = request(prompt, ["current"])
    before, refs = copy.deepcopy(value), copy.deepcopy(REFS)
    assert select_context_images(value, refs) == {"current"}
    assert value == before and refs == REFS


@pytest.mark.parametrize("prompt", ["编辑 @第1轮图1", "修改 @1轮图1", '编辑 <ref id="round-1-image-1" />',
                                     "编辑 <ref id='round-1-reference-1' />"])
def test_explicit_historical_reference_limits_to_its_frozen_asset(prompt):
    assert select_context_images(request(prompt), REFS) == {"old-input" if "reference" in prompt else "old-output"}


def test_current_explicit_mask_and_generated_assets_are_all_kept():
    value = request("将 @图1 与 @第1轮图1 融合", ["current", "second-current"])
    value["round"].update(maskTargetImageId="current", maskImageId="mask")
    refs = {**REFS, "round-3-image-1": "new-output"}
    assert select_context_images(value, refs) == {"current", "second-current", "old-output", "mask", "new-output"}


@pytest.mark.parametrize("suffix", ["按之前的样子", "用上一张的颜色", "与刚才的图比较", "继续修改", "比较这几张", "保持同样的发型",
                                     "use the first image", "compare both pictures", "use the previous photo", "same as above", "再参考图2",
                                     "再参考图一", "使用所有图", "和第一张一样", "describe the difference"])
def test_additional_ambiguous_history_keeps_all_even_with_current_or_explicit_refs(suffix):
    assert select_context_images(request("编辑 @图1，" + suffix, ["current"]), REFS) is None
    assert select_context_images(request("编辑 @第1轮图1，" + suffix), REFS) is None


@pytest.mark.parametrize("prompt", ["你好", "Hi!", "hello", "你是什么模型？", "你当前是哪个模型", "What model are you?",
                                     "你有哪些 skills？", "你可以安装skill吗", "what skills do you have?"])
def test_only_clear_text_questions_omit_historical_images(prompt):
    assert select_context_images(request(prompt), REFS) == set()


@pytest.mark.parametrize("prompt", ["给我一些建议", "分析", "生成一张图", "你是什么模型，顺便解释图片", "你好，看看上次那张", "你会用skill分析照片吗"])
def test_unknown_or_mixed_intent_preserves_all_images(prompt):
    assert select_context_images(request(prompt), REFS) is None


@pytest.mark.parametrize("prompt", ["编辑 @图0", "编辑 @图2", "编辑 @图", "编辑 @第1轮图", "编辑 @第0轮图1", "编辑 @第8轮图1",
                                     "编辑 @第1轮图1.5", "编辑 @第1轮图1/2", "编辑 @图1/2", '<ref id="round-1-image-1"',
                                     '<ref id="round-99-image-1" />', '<ref id="round-1-image-0" />', '<ref id="broken" />',
                                     '编辑 @已删除轮次图1', '编辑 @reference', '<refid="round-1-image-1" />'])
def test_incomplete_invalid_or_missing_references_never_silently_drop_images(prompt):
    assert select_context_images(request(prompt, ["current"]), REFS) is None


def test_deleted_and_wrong_branch_refs_remain_conservative():
    assert select_context_images(request("编辑 @第1轮图1"), {**REFS, "round-1-image-1": None}) is None
    assert select_context_images(request("编辑 @第1轮图1"), {}) is None


@pytest.mark.parametrize("prompt", ["编辑 @图" + "9" * 5000, "编辑 @第" + "9" * 5000 + "轮图1"])
def test_oversized_reference_numbers_do_not_break_request_construction(prompt):
    assert select_context_images(request(prompt, ["current"]), REFS) is None


def test_rich_mention_label_is_not_treated_as_extra_history_instruction():
    value = request("编辑 @第1轮图1\u2063\u2065之前的照片\u2064")
    assert select_context_images(value, REFS) == {"old-output"}
    value["round"]["prompt"] = "编辑 @第1轮图1\u2065unfinished"
    assert select_context_images(value, REFS) is None


def test_plain_text_followup_retains_current_execution_results():
    assert select_context_images(request("你好"), {**REFS, "round-3-image-1": "new-output"}) == {"new-output"}


@pytest.mark.parametrize("value,refs", [(None, {}), ({}, {}), ({"round": {"prompt": "你好", "inputImageIds": [], "index": 0}}, {}),
                                       (request("你好", [None]), REFS), (request("你好"), None)])
def test_unexpected_shapes_fall_back_to_existing_behavior(value, refs):
    assert select_context_images(value, refs) is None
