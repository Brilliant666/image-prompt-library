"""Conservative image selection for a request's model context.

This selects image bytes only. It never edits prompts, conversation history,
stored originals, or the branch's reference allowlist. ``None`` means that the
caller must preserve its existing all-images behavior.
"""
import re


_ROUND_MENTION = re.compile(r"@(?:第)?(\d+)轮图(\d+)")
_CURRENT_MENTION = re.compile(r"@图(\d+)")
_REF_TAG = re.compile(r"<ref\b[^>]*\bid=[\"'](round-\d+-(?:image|reference)-\d+)[\"'][^>]*\s*/?>")
_REF_ID = re.compile(r"round-([1-9]\d*)-(?:image|reference)-([1-9]\d*)")
_UNRESOLVED_REFERENCE = re.compile(r"@|</?ref|round-\d|图\s*[一二三四五六七八九十\d]+|第\s*[一二三四五六七八九十\d]+\s*(?:张|幅|轮)", re.I)
_AMBIGUOUS_HISTORY = re.compile(
    r"之前|以前|此前|先前|上一|上次|上张|上图|刚才|刚刚|前面|前一|最初|原先|原来|上面|上述|"
    r"那张|那些|那幅|这几张|这些图|这些照片|所有图|全部图|比较|对比|同样|相同|一样|继续|接着|延续|"
    r"\b(?:previous|earlier|before|above|last|compare|comparison|contrast|versus|vs|difference|continue|again|same|those|both)\b|"
    r"\b(?:first|second|third|fourth|other)\s+(?:image|photo|picture)s?\b|\b(?:image|photo|picture)\s*\d+\b",
    re.I,
)
_PLAIN_TEXT = re.compile(
    r"(?:你好|您好|嗨|哈喽|早上好|下午好|晚上好|hello|hi|hey|"
    r"你(?:现在|当前)?(?:是|用的是什么|使用的是什么)(?:什么|哪个)?模型|"
    r"(?:what|which) model are you(?: using)?|"
    r"你(?:现在|当前)?(?:有|会|支持|能使用|可以使用|已安装了?)(?:哪些|什么)?(?:skill|skills|技能)(?:吗)?|"
    r"你(?:能|可以)安装(?:skill|skills|技能)吗|"
    r"(?:有|支持|已安装了?)(?:哪些|什么)(?:skill|skills|技能)|"
    r"what skills (?:do you have|can you use)|which skills are available)",
    re.I,
)


def select_context_images(request, refs):
    """Return required asset IDs, or ``None`` when narrowing is uncertain.

    Current attachments or valid explicit mentions establish an image scope.
    Additional historical/relational wording cancels that scope conservatively.
    Without an explicit scope, only a small whole-message allowlist of plain
    greetings and model/skill questions can omit historical images.
    """
    if not isinstance(request, dict) or not isinstance(refs, dict):
        return None
    current = request.get("round")
    if not isinstance(current, dict) or not isinstance(current.get("prompt"), str):
        return None
    inputs, index = current.get("inputImageIds"), current.get("index")
    if (not isinstance(inputs, list) or any(not isinstance(aid, str) or not aid for aid in inputs)
            or type(index) is not int or index < 1):
        return None

    # The editor's invisible label is presentation metadata, just as in the
    # request builder. Unterminated metadata is uncertain rather than hidden.
    prompt = current["prompt"]
    if "\u2065" in re.sub(r"\u2065[^\u2064]*\u2064", "", prompt):
        return None
    prompt = re.sub(r"\u2065[^\u2064]*\u2064", "", prompt).replace("\u2063", "").replace("\u2064", "")
    selected = set(inputs)
    explicit = False
    invalid = False

    def resolve(ref):
        nonlocal explicit, invalid
        aid = refs.get(ref)
        if not _REF_ID.fullmatch(ref) or not isinstance(aid, str) or not aid:
            invalid = True
        else:
            explicit = True
            selected.add(aid)
        return " "

    def round_mention(match):
        # A fractional/range suffix is not an unambiguous image identifier.
        nonlocal invalid
        if prompt[match.end():match.end() + 1] in {".", "/", "／"}:
            invalid = True
        try:
            return resolve(f"round-{int(match[1])}-image-{int(match[2])}")
        except ValueError:
            invalid = True
            return " "

    prompt = _ROUND_MENTION.sub(round_mention, prompt)

    def current_mention(match):
        nonlocal explicit, invalid
        try:
            slot = int(match[1])
        except ValueError:
            invalid = True
            return " "
        if slot < 1 or slot > len(inputs):
            invalid = True
        else:
            explicit = True
            selected.add(inputs[slot - 1])
        if prompt[match.end():match.end() + 1] in {".", "/", "／"}:
            invalid = True
        return " "

    prompt = _CURRENT_MENTION.sub(current_mention, prompt)
    prompt = _REF_TAG.sub(lambda match: resolve(match[1]), prompt)
    if invalid or _UNRESOLVED_REFERENCE.search(prompt) or _AMBIGUOUS_HISTORY.search(prompt):
        return None

    # Generated images in the current execution chain remain available to a
    # subsequent analysis step. A mask target must also retain first-image use.
    for field in ("maskTargetImageId", "maskImageId"):
        aid = current.get(field)
        if aid is not None:
            if not isinstance(aid, str) or not aid:
                return None
            selected.add(aid)
    current_output = re.compile(rf"round-{index}-image-[1-9]\d*")
    for ref, aid in refs.items():
        if isinstance(ref, str) and current_output.fullmatch(ref):
            if not isinstance(aid, str) or not aid:
                return None
            selected.add(aid)

    if inputs or explicit:
        return selected
    plain = re.sub(r"[\s，,。.!！?？；;：:]+", " ", prompt).strip()
    # Chinese spaces are optional; English phrase spacing remains meaningful.
    if _PLAIN_TEXT.fullmatch(plain) or _PLAIN_TEXT.fullmatch(plain.replace(" ", "")):
        return selected
    return None
