"""Small, local-only title hints; filenames are metadata, never storage paths."""
from datetime import datetime
import re
import unicodedata

_GENERIC_NAME = re.compile(
    r"(?:image|img|capture|clipboard|pasted[ _-]?image|screenshot|untitled|download|blob|file|图片|图像|截图|未命名)"
    r"(?:[\s_.()-]*(?:[0-9a-f]{8,}|[0-9_ .()-]+))?\Z", re.IGNORECASE,
)
_UUID_NAME = re.compile(r"[0-9a-f]{8}[-_][0-9a-f]{4}[-_][0-9a-f]{4}[-_][0-9a-f]{4}[-_][0-9a-f]{12}\Z", re.IGNORECASE)


def safe_original_filename(value: str) -> str:
    # A browser may provide a Windows path or a Unix path. Neither its directory
    # nor control/bidi characters belong in portable provenance or display text.
    value = value.replace("\\", "/").rsplit("/", 1)[-1]
    value = "".join(character for character in value if not unicodedata.category(character).startswith("C"))
    value = value.strip().rstrip(".").strip()
    # These characters can carry URL query fragments or invalid Windows names.
    # The extension supplies a filename, never a URL or a remote path hint.
    if not value or any(character in value for character in '<>:"|?*'):
        return ""
    return value


def filename_title(filename: str) -> str:
    stem = filename.rsplit(".", 1)[0] if "." in filename else filename
    stem = stem.strip()
    if not stem or _GENERIC_NAME.fullmatch(stem) or _UUID_NAME.fullmatch(stem):
        return ""
    if re.fullmatch(r"[0-9a-f]{16,}", stem, re.IGNORECASE):
        return ""
    # Conservative opaque-ID heuristic, never applied to Chinese or other
    # Unicode names, nor to human phrases with spaces/separators.
    if (len(stem) >= 32 and stem.isascii() and stem.isalnum()
            and any(character.isalpha() for character in stem)
            and any(character.isdigit() for character in stem)):
        return ""
    return stem[:300]


def capture_title(title: str, filename: str, request_id: str, created_at: str) -> str:
    explicit = title.strip()
    if explicit:
        return explicit
    suggested = filename_title(filename)
    if suggested:
        return suggested
    local_time = datetime.fromisoformat(created_at).astimezone().strftime("%Y-%m-%d %H:%M")
    return f"收录 · {local_time} · {request_id[:8]}"
