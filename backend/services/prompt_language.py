"""Conservative, offline hints; never translate or rewrite the submitted prompt."""
from __future__ import annotations

import re
from functools import lru_cache
from typing import Literal

from opencc import OpenCC
from pydantic import BaseModel, Field

PromptLanguage = Literal["en", "zh_hans", "zh_hant", "und"]
MAX_PROMPT_CHARACTERS = 200_000


class LanguageDetectionRequest(BaseModel):
    text: str = Field(max_length=MAX_PROMPT_CHARACTERS)


class LanguageDetection(BaseModel):
    language: PromptLanguage
    uncertain: bool
    reason: str


_S2T = OpenCC("s2t")
_T2S = OpenCC("t2s")
_HAN = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\U00020000-\U0002fa1f]")
_WORDS = re.compile(r"[A-Za-z]+")
_TECHNICAL = {"pbr", "hdr", "hdri", "cgi", "rgb", "rgba", "cmyk", "png", "jpeg", "jpg", "webp", "uhd", "dof", "iso", "k", "mm"}
_ENGLISH_EVIDENCE = set("""a an the of in on at to with and or from for by without is are
image picture photo photograph portrait landscape woman man person people scene render
create draw generate show background lighting light soft dark bright red blue green white
black silver gold full body shot long short wearing hair eyes detailed realistic cinematic
photorealistic masterpiece best quality sharp focus beautiful elegant young temple lion
serpent texture fabric camera illustration composition style shadows high resolution""".split())
_ENGLISH_FUNCTION_WORDS = {"a", "an", "the", "of", "in", "on", "at", "to", "with", "and", "or", "from", "for", "by", "without", "is", "are"}


@lru_cache(maxsize=8192)
def _script_evidence(character: str) -> tuple[bool, bool]:
    return _S2T.convert(character) != character, _T2S.convert(character) != character


def detect_prompt_language(text: str) -> LanguageDetection:
    han = _HAN.findall(text)
    words = _WORDS.findall(text)
    # Acronyms and units (PBR, 8K, ISO, mm) do not turn a Chinese prompt into English.
    meaningful_words = [word for word in words if word.lower() not in _TECHNICAL and not (len(word) <= 5 and word.isupper())]
    latin_letters = sum(len(word) for word in meaningful_words)
    other_letters = any(character.isalpha() and not _HAN.fullmatch(character) and not ("a" <= character.lower() <= "z") for character in text)
    if other_letters:
        return LanguageDetection(language="und", uncertain=True, reason="unsupported_or_mixed_script")
    if han:
        if len(han) < 4:
            return LanguageDetection(language="und", uncertain=True, reason="insufficient_evidence")
        if latin_letters > max(8, len(han)):
            return LanguageDetection(language="und", uncertain=True, reason="mixed_languages")
        evidence = [_script_evidence(character) for character in han]
        simplified = sum(pair[0] and not pair[1] for pair in evidence)
        traditional = sum(pair[1] and not pair[0] for pair in evidence)
        if simplified and not traditional:
            return LanguageDetection(language="zh_hans", uncertain=False, reason="simplified_chinese")
        if traditional and not simplified:
            return LanguageDetection(language="zh_hant", uncertain=False, reason="traditional_chinese")
        return LanguageDetection(language="und", uncertain=True, reason="mixed_chinese_scripts" if simplified and traditional else "shared_chinese_characters")
    lower_words = [word.lower() for word in meaningful_words]
    evidence = sum(word in _ENGLISH_EVIDENCE for word in lower_words)
    function_evidence = sum(word in _ENGLISH_FUNCTION_WORDS for word in lower_words)
    if len(lower_words) >= 3 and latin_letters >= 12 and (evidence >= 4 or evidence >= 2 and function_evidence >= 2):
        return LanguageDetection(language="en", uncertain=False, reason="english")
    return LanguageDetection(language="und", uncertain=True, reason="insufficient_evidence")
