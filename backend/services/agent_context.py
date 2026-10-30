"""Conservative image selection for a request's model context.

This selects image bytes only. It never edits prompts, conversation history,
stored originals, or the branch's reference allowlist. ``None`` means that the
caller must preserve its existing all-images behavior.
"""
import re
from backend.services.agent_editing_task import required_asset_ids, execution_task


_ROUND_MENTION = re.compile(r"@(?:第)?(\d+)轮图(\d+)")
_CURRENT_MENTION = re.compile(r"@图(\d+)")
_REF_TAG = re.compile(r"<ref\b[^>]*\bid=[\"']([^\"']+)[\"'][^>]*\s*/?>")
_REF_ID = re.compile(r"round-([1-9]\d*)-(?:image|reference)-([1-9]\d*)")
_UNRESOLVED_REFERENCE = re.compile(r"@|</?ref|round-\d|图\s*[一二三四五六七八九十\d]+|第\s*[一二三四五六七八九十\d]+\s*(?:张|幅|轮)", re.I)
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


def _reference_scope(request, refs):
    """Resolve structured references without guessing natural-language intent."""
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
    # Frozen implicit bindings remain an audit trail, not a mandate to attach
    # an old subject after a validated same-response task boundary.
    context = current.get('taskContext')
    implicit = set(current.get('taskImageIds', []))
    if context:
        required = set(required_asset_ids(execution_task(current)))
        implicit = required if context.get('taskType') == 'image_edit' else implicit & required
    selected = set(inputs) | set(implicit)
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
        if re.match(r"[./／]\d", prompt[match.end():]):
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
        if re.match(r"[./／]\d", prompt[match.end():]):
            invalid = True
        return " "

    prompt = _CURRENT_MENTION.sub(current_mention, prompt)
    prompt = _REF_TAG.sub(lambda match: resolve(match[1]), prompt)
    return current, selected, explicit, prompt, invalid


def validate_context_references(request, refs):
    """Reject explicit references that cannot bind to this request's branch.

    Only the current instruction is checked: a historical turn can legitimately
    describe a result that has since been removed. Asset bytes are validated by
    the request builder before the upstream POST.
    """
    scope = _reference_scope(request, refs)
    if scope is not None and scope[4]:
        raise ValueError("引用的图片不存在、已清理或不属于当前分支。")


def select_context_images(request, refs):
    """Return required asset IDs, or ``None`` when narrowing is uncertain.

    An attachment or a mention does not prove that other images are irrelevant.
    Natural language may refer to any ancestor without recognizable keywords, so
    it retains branch pixels. Only reference-only messages and a small complete
    plain-text allowlist provide enough evidence to narrow the image context.
    """
    scope = _reference_scope(request, refs)
    if scope is None:
        return None
    current, selected, explicit, prompt, invalid = scope
    if invalid or _UNRESOLVED_REFERENCE.search(prompt):
        return None

    # Generated images in the current execution chain remain available to a
    # subsequent analysis step. A mask target must also retain first-image use.
    for field in ("maskTargetImageId", "maskImageId"):
        aid = current.get(field)
        if aid is not None:
            if not isinstance(aid, str) or not aid:
                return None
            selected.add(aid)
    current_output = re.compile(rf"round-{current['index']}-image-[1-9]\d*")
    for ref, aid in refs.items():
        if isinstance(ref, str) and current_output.fullmatch(ref):
            if not isinstance(aid, str) or not aid:
                return None
            selected.add(aid)

    plain = re.sub(r"[\s，,。.!！?？；;：:]+", " ", prompt).strip()
    if explicit:
        return selected | set(required_asset_ids(current.get('editingTask'))) if not plain else None
    # Chinese spaces are optional; English phrase spacing remains meaningful.
    if _PLAIN_TEXT.fullmatch(plain) or _PLAIN_TEXT.fullmatch(plain.replace(" ", "")):
        return selected
    return None
