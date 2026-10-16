"""One image plus one exact original prompt, committed as an ordinary library item."""
from __future__ import annotations

import hashlib
import json
import tempfile
import uuid
from contextlib import suppress
from io import BytesIO
from pathlib import Path

from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel, Field

from backend.config import resolve_library_storage_path
from backend.db import connect
from backend.repositories import ItemRepository, StoredImageInput, now
from backend.schemas import ItemCreate, ItemDetail, PromptIn
from backend.services.capture_naming import capture_title, safe_original_filename
from backend.services.image_store import MAX_IMAGE_PIXELS, _atomic_write_bytes, store_image
from backend.services.prompt_language import MAX_PROMPT_CHARACTERS, detect_prompt_language

MAX_CAPTURE_BYTES = 30 * 1024 * 1024
_FORMATS = {"PNG": ".png", "JPEG": ".jpg", "WEBP": ".webp", "GIF": ".gif"}


class CaptureError(ValueError):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


class CaptureFields(BaseModel):
    request_id: uuid.UUID
    prompt_text: str = Field(min_length=1, max_length=MAX_PROMPT_CHARACTERS)
    language: str = "auto"
    title: str = Field(default="", max_length=300)
    original_filename: str = Field(default="", max_length=1024)
    source_name: str = Field(default="", max_length=300)
    source_url: str = Field(default="", max_length=4096)
    notes: str = Field(default="", max_length=20_000)


def _image_extension(data: bytes) -> str:
    try:
        with Image.open(BytesIO(data)) as image:
            extension = _FORMATS.get(image.format or "")
            if extension is None:
                raise CaptureError(415, "Supported image formats are JPEG, PNG, WebP and GIF")
            if image.width * image.height > MAX_IMAGE_PIXELS:
                raise CaptureError(413, "Image exceeds the supported pixel limit")
            image.verify()
        # verify() alone does not guarantee the raster can actually be decoded.
        with Image.open(BytesIO(data)) as image:
            image.load()
        return extension
    except CaptureError:
        raise
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError) as exc:
        raise CaptureError(400, "The uploaded file is not a decodable supported image") from exc


def _fingerprint(fields: CaptureFields, data: bytes) -> str:
    payload = fields.model_dump(mode="json", exclude={"request_id"})
    # Old frozen clients never sent this field. Their durable fingerprint must
    # stay byte-for-byte compatible, including when they explicitly send "".
    if not fields.original_filename:
        payload.pop("original_filename")
    payload["image_sha256"] = hashlib.sha256(data).hexdigest()
    try:
        encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8")
    except UnicodeError as exc:
        raise CaptureError(400, "Capture text must contain valid Unicode characters") from exc
    return hashlib.sha256(encoded).hexdigest()


def _existing_capture(conn, request_id: str, fingerprint: str) -> str | None:
    row = conn.execute("SELECT fingerprint,item_id FROM capture_requests WHERE request_id=?", (request_id,)).fetchone()
    if row is None:
        return None
    if row["fingerprint"] != fingerprint:
        raise CaptureError(409, "This request ID was already used with different capture content")
    if row["item_id"] is None:
        raise CaptureError(410, "The item saved by this request was deleted; it will not be recreated")
    return row["item_id"]


def capture_item(library_path: Path | str, fields: CaptureFields, data: bytes) -> ItemDetail:
    if not fields.prompt_text.strip():
        raise CaptureError(400, "Prompt text is required")
    if fields.language not in {"auto", "en", "zh_hans", "zh_hant", "und"}:
        raise CaptureError(400, "Invalid prompt language")
    if not data:
        raise CaptureError(400, "An image is required")
    if len(data) > MAX_CAPTURE_BYTES:
        raise CaptureError(413, "Image upload too large")
    library = Path(library_path)
    repository = ItemRepository(library)
    request_id = str(fields.request_id)
    fingerprint = _fingerprint(fields, data)
    # Fast durable replay is independent of the language detector's future versions.
    with connect(library) as conn:
        existing = _existing_capture(conn, request_id, fingerprint)
    if existing:
        return repository.get_item(existing)
    extension = _image_extension(data)
    detection = detect_prompt_language(fields.prompt_text)
    language = detection.language if fields.language == "auto" else fields.language
    filename = safe_original_filename(fields.original_filename)
    title = capture_title(fields.title, filename, request_id, now())
    provenance = {"kind": "manual", "source_language": language, "method": "quick-capture",
                  "language_detection": {"mode": "auto" if fields.language == "auto" else "manual", **detection.model_dump()}}
    if filename:
        provenance["original_filename"] = filename
    prompt = PromptIn(
        language=language, text=fields.prompt_text, is_primary=True, is_original=True,
        provenance=provenance,
    )
    payload = ItemCreate(title=title, model="", prompts=[prompt], source_name=fields.source_name or None,
                         source_url=fields.source_url or None, notes=fields.notes or None)
    # Generate all derivatives in isolation; nothing visible in the library yet.
    with tempfile.TemporaryDirectory(prefix="image-prompt-capture-") as temporary:
        staging = Path(temporary)
        stored = store_image(staging, data, "image" + extension)
        paths = {
            "original_path": f"originals/captures/{request_id}/image{extension}",
            "thumb_path": f"thumbs/captures/{request_id}/image.webp",
            "preview_path": f"previews/captures/{request_id}/image.webp",
        }
        with connect(library) as conn:
            # SQLite also serializes other processes, including identical simultaneous requests.
            conn.execute("BEGIN IMMEDIATE")
            existing = _existing_capture(conn, request_id, fingerprint)
            if existing:
                item_id = existing
            else:
                written: list[Path] = []
                try:
                    for attribute, relative in paths.items():
                        destination = resolve_library_storage_path(library, relative)
                        destination.parent.mkdir(parents=True, exist_ok=True)
                        # UUID-owned paths cannot be shared with another capture/upload.
                        written.append(destination)
                        _atomic_write_bytes(destination, (staging / getattr(stored, attribute)).read_bytes())
                    item_id = repository.create_item_in_transaction(conn, payload, preserve_prompts=True)
                    repository.add_image_in_transaction(conn, item_id, StoredImageInput(
                        **paths, width=stored.width, height=stored.height, file_sha256=stored.file_sha256,
                    ))
                    conn.execute("INSERT INTO capture_requests(request_id,fingerprint,item_id,created_at) VALUES(?,?,?,?)",
                                 (request_id, fingerprint, item_id, now()))
                    conn.commit()
                except Exception:
                    conn.rollback()
                    for path in written:
                        with suppress(OSError):
                            path.unlink(missing_ok=True)
                    raise
    return repository.get_item(item_id)
