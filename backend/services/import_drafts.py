from __future__ import annotations

import json
import hashlib
import os
import re
import sqlite3
import stat
import tempfile
from contextlib import closing
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path, PureWindowsPath

from PIL import Image, UnidentifiedImageError

from backend.config import resolve_library_storage_path
from backend.db import connect, init_db
from backend.repositories import ItemRepository, StoredImageInput, new_id, now
from backend.schemas import (
    ImportDraftAcceptResult,
    ImportDraftCreate,
    ImportDraftList,
    ImportDraftMedia,
    ImportDraftRecord,
    ItemCreate,
    PromptIn,
)
from backend.services.image_store import MAX_IMAGE_PIXELS, StoredImage, _atomic_write_bytes, store_image
from backend.services.text_normalize import to_traditional

IMPORT_STAGING_ROOT = "import-staging"
MAX_IMPORT_IMAGE_BYTES = 30 * 1024 * 1024
_IMAGE_EXTENSIONS = {"PNG": ".png", "JPEG": ".jpg", "WEBP": ".webp", "GIF": ".gif"}


@dataclass(frozen=True)
class _PreparedMedia:
    media: ImportDraftMedia
    source_identity: tuple
    stored: StoredImage


def _file_identity(info):
    return info.st_dev, info.st_ino, info.st_mode, info.st_size, info.st_mtime_ns, info.st_ctime_ns


def _image_extension(data: bytes) -> str:
    try:
        with Image.open(BytesIO(data)) as image:
            extension = _IMAGE_EXTENSIONS.get(image.format or "")
            if extension is None:
                raise ImportDraftConflict("Import image format is unsupported; use PNG, JPEG, WebP or GIF")
            if image.width * image.height > MAX_IMAGE_PIXELS:
                raise ImportDraftConflict("Import image exceeds the supported pixel limit")
            image.verify()
        with Image.open(BytesIO(data)) as image:
            image.load()
        return extension
    except ImportDraftConflict:
        raise
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError, EOFError,
            Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise ImportDraftConflict("Import image is damaged or cannot be decoded; replace the staged image and retry") from exc


def _json_default(value):
    if hasattr(value, "model_dump"):
        return value.model_dump()
    raise TypeError(f"Object of type {type(value).__name__} is not JSON serializable")


def _to_json(value) -> str:
    return json.dumps(value, ensure_ascii=False, default=_json_default)


def _from_json(raw: str | None, fallback):
    if not raw:
        return fallback
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return fallback


def _normalize_text(text: str) -> str:
    return re.sub(r"\s+", "", to_traditional(text).casefold())


class ImportDraftConflict(ValueError):
    pass


class ImportDraftRepository:
    def __init__(self, library_path: Path | str):
        self.library_path = Path(library_path)
        init_db(self.library_path)
        self.items = ItemRepository(self.library_path)

    def create_draft(self, payload: ImportDraftCreate) -> ImportDraftRecord:
        draft_id = new_id("drf")
        timestamp = now()
        duplicate_of = self._find_duplicate(payload)
        status = "duplicate" if duplicate_of else "staged"
        with connect(self.library_path) as conn:
            conn.execute(
                """
                INSERT INTO import_drafts(
                    id,status,source_type,source_name,source_url,source_ref,source_path,title,model,author,
                    suggested_cluster_name,suggested_tags,prompts,media,warnings,confidence,
                    duplicate_of_item_id,created_at,updated_at
                ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                """,
                (
                    draft_id,
                    status,
                    payload.source_type,
                    payload.source_name,
                    payload.source_url,
                    payload.source_ref,
                    payload.source_path,
                    payload.title,
                    payload.model,
                    payload.author,
                    payload.suggested_cluster_name,
                    _to_json(payload.suggested_tags),
                    _to_json(payload.prompts),
                    _to_json(payload.media),
                    _to_json(payload.warnings),
                    payload.confidence,
                    duplicate_of,
                    timestamp,
                    timestamp,
                ),
            )
            conn.commit()
        return self.get_draft(draft_id)

    def get_draft(self, draft_id: str) -> ImportDraftRecord:
        with connect(self.library_path) as conn:
            row = conn.execute("SELECT * FROM import_drafts WHERE id=?", (draft_id,)).fetchone()
        if row is None:
            raise KeyError(draft_id)
        return self._record_from_row(row)

    def list_drafts(self, *, status: str | None = None, limit: int = 100, offset: int = 0) -> ImportDraftList:
        where = "WHERE status=?" if status else ""
        params: list[object] = [status] if status else []
        with connect(self.library_path) as conn:
            total = conn.execute(f"SELECT COUNT(*) FROM import_drafts {where}", params).fetchone()[0]
            rows = conn.execute(
                f"SELECT * FROM import_drafts {where} ORDER BY created_at DESC LIMIT ? OFFSET ?",
                (*params, limit, offset),
            ).fetchall()
        return ImportDraftList(drafts=[self._record_from_row(row) for row in rows], total=total, limit=limit, offset=offset)

    def _staged_file(self, staged_path: str | None) -> Path | None:
        if not staged_path:
            return None
        # Check both path syntaxes, including drive-relative paths and UNC on
        # POSIX. Staging is not a formal media root or an arbitrary local path.
        windows = PureWindowsPath(staged_path)
        relative = Path(staged_path.replace("\\", "/"))
        message = "Import draft media must be staged inside the library import folder without links"
        if (relative.is_absolute() or windows.drive or windows.root or ".." in relative.parts
                or relative.parts[:1] != (IMPORT_STAGING_ROOT,) or len(relative.parts) < 2
                or any(":" in part for part in relative.parts)):
            raise ImportDraftConflict(message)
        try:
            library = self.library_path.resolve(strict=True)
            expected_root = library / IMPORT_STAGING_ROOT
            candidate = library
            for index, part in enumerate(relative.parts):
                candidate = candidate / part
                info = candidate.lstat()
                if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
                    raise ImportDraftConflict(message)
                if index < len(relative.parts) - 1 and not stat.S_ISDIR(info.st_mode):
                    raise ImportDraftConflict(message)
            if not stat.S_ISREG(info.st_mode):
                raise ImportDraftConflict("Import staged image must be a regular file")
            # A redirected staging root must never redefine the allowed root.
            staging_root = (library / IMPORT_STAGING_ROOT).resolve(strict=True)
            resolved = candidate.resolve(strict=True)
            if staging_root != expected_root or not resolved.is_relative_to(expected_root):
                raise ImportDraftConflict(message)
            return candidate
        except FileNotFoundError:
            raise ImportDraftConflict("Import staged image is missing; replace it and retry") from None
        except (OSError, RuntimeError, ValueError):
            raise ImportDraftConflict(message) from None

    def _read_staged_image(self, media: ImportDraftMedia) -> tuple[bytes, tuple]:
        path = self._staged_file(media.staged_path)
        if path is None:
            raise ImportDraftConflict("Import staged image is missing")
        before = _file_identity(path.lstat())
        if before[3] > MAX_IMPORT_IMAGE_BYTES:
            raise ImportDraftConflict("Import image exceeds the 30 MB file limit")
        flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
        try:
            fd = os.open(path, flags)
            with os.fdopen(fd, "rb") as source:
                if _file_identity(os.fstat(source.fileno())) != before:
                    raise ImportDraftConflict("Import staged image changed; retry the import")
                data = source.read(MAX_IMPORT_IMAGE_BYTES + 1)
                if len(data) > MAX_IMPORT_IMAGE_BYTES:
                    raise ImportDraftConflict("Import image exceeds the 30 MB file limit")
                if _file_identity(os.fstat(source.fileno())) != before:
                    raise ImportDraftConflict("Import staged image changed; retry the import")
            # Recheck directory and final-file identity after opening/reading.
            if _file_identity(self._staged_file(media.staged_path).lstat()) != before:
                raise ImportDraftConflict("Import staged image changed; retry the import")
        except OSError:
            raise ImportDraftConflict("Import staged image could not be read safely; retry the import") from None
        if media.file_sha256 and hashlib.sha256(data).hexdigest() != media.file_sha256.lower():
            raise ImportDraftConflict("Import staged image content does not match its recorded identity")
        return data, before

    def _prepare_media(self, draft: ImportDraftRecord, directory: Path) -> list[_PreparedMedia]:
        prepared = []
        for media in draft.media:
            # Remote URLs and original_path are descriptive only. Acceptance
            # never downloads them or opens an arbitrary original source path.
            if not media.staged_path:
                continue
            if media.role not in {"result_image", "reference_image"}:
                raise ImportDraftConflict("Import image role is invalid")
            data, identity = self._read_staged_image(media)
            extension = _image_extension(data)
            try:
                stored = store_image(directory, data, "image" + extension)
            except (OSError, ValueError):
                raise ImportDraftConflict("Import image preparation failed; staged files were retained for retry") from None
            prepared.append(_PreparedMedia(media, identity, stored))
        return prepared

    def _publish_media(self, directory: Path, prepared: _PreparedMedia) -> StoredImageInput:
        stored = prepared.stored
        for relative in (stored.original_path, stored.thumb_path, stored.preview_path):
            destination = resolve_library_storage_path(self.library_path, relative)
            destination.parent.mkdir(parents=True, exist_ok=True)
            _atomic_write_bytes(destination, (directory / relative).read_bytes())
        return StoredImageInput(
            original_path=stored.original_path, thumb_path=stored.thumb_path,
            preview_path=stored.preview_path, remote_url=prepared.media.url,
            width=stored.width, height=stored.height, file_sha256=stored.file_sha256,
            role=prepared.media.role,
        )

    def _accepted_result(self, draft: ImportDraftRecord) -> ImportDraftAcceptResult:
        if not draft.accepted_item_id:
            raise ImportDraftConflict("The accepted import no longer has a saved item; it will not be recreated")
        try:
            item = self.items.get_item(draft.accepted_item_id)
        except KeyError:
            raise ImportDraftConflict("The item saved by this import was deleted; it will not be recreated") from None
        return ImportDraftAcceptResult(draft=draft, item=item)

    def accept_draft(self, draft_id: str) -> ImportDraftAcceptResult:
        draft = self.get_draft(draft_id)
        if draft.status == "accepted":
            return self._accepted_result(draft)
        if draft.status == "duplicate" or draft.duplicate_of_item_id:
            raise ImportDraftConflict("Import draft is marked as duplicate and cannot be accepted")
        if draft.status != "staged":
            raise ImportDraftConflict("Import draft is no longer available for acceptance")
        payload = ItemCreate(
            title=draft.title,
            model=draft.model,
            source_name=draft.source_name,
            source_url=draft.source_url,
            author=draft.author,
            cluster_name=draft.suggested_cluster_name,
            tags=draft.suggested_tags,
            prompts=draft.prompts,
        )
        expected = draft.model_dump(mode="json")
        try:
            # Decode and prepare every image before exposing any formal row or
            # holding SQLite's writer lock. Originals keep their exact bytes.
            with tempfile.TemporaryDirectory(prefix="image-prompt-import-") as temporary:
                directory = Path(temporary)
                prepared = self._prepare_media(draft, directory)
                with closing(connect(self.library_path)) as conn, conn:
                    conn.execute("BEGIN IMMEDIATE")
                    row = conn.execute("SELECT * FROM import_drafts WHERE id=?", (draft_id,)).fetchone()
                    if row is None:
                        raise KeyError(draft_id)
                    latest = self._record_from_row(row)
                    if latest.status == "accepted":
                        # A concurrent request won. Its receipt, not duplicate
                        # detection, owns the completed item for this draft ID.
                        return self._accepted_result(latest)
                    if latest.model_dump(mode="json") != expected:
                        raise ImportDraftConflict("Import draft changed; review it and retry")
                    duplicate_of = self._find_duplicate(latest, conn=conn)
                    if duplicate_of:
                        conn.execute("UPDATE import_drafts SET status='duplicate', duplicate_of_item_id=?, updated_at=? WHERE id=?",
                                     (duplicate_of, now(), draft_id))
                        conn.commit()
                        raise ImportDraftConflict("Import draft is marked as duplicate and cannot be accepted")
                    for media in prepared:
                        if _file_identity(self._staged_file(media.media.staged_path).lstat()) != media.source_identity:
                            raise ImportDraftConflict("Import staged image changed; retry the import")
                    item_id = self.items.create_item_in_transaction(conn, payload, imported=True)
                    for media in prepared:
                        image_input = self._publish_media(directory, media)
                        self.items.add_image_in_transaction(conn, item_id, image_input)
                    timestamp = now()
                    conn.execute("UPDATE import_drafts SET status='accepted', accepted_item_id=?, accepted_at=?, updated_at=? WHERE id=?",
                                 (item_id, timestamp, timestamp, draft_id))
                    conn.commit()
        except (sqlite3.Error, OSError, ValueError) as exc:
            if isinstance(exc, ImportDraftConflict):
                raise
            # Formal content-addressed files may already be shared with another
            # writer. Keep them on rollback; never unlink by a 'created' list.
            # The draft and original staged sources remain available for retry.
            raise ImportDraftConflict("Import could not be committed; the draft and staged files were retained. Retry the import") from None
        return self._accepted_result(self.get_draft(draft_id))

    def _find_duplicate(self, payload: ImportDraftCreate, *, conn=None) -> str | None:
        if conn is None:
            with closing(connect(self.library_path)) as owned:
                return self._find_duplicate(payload, conn=owned)
        else:
            if payload.source_url:
                row = conn.execute(
                    "SELECT id FROM items WHERE source_url=? AND archived=0 AND deleted_at IS NULL ORDER BY created_at LIMIT 1",
                    (payload.source_url,),
                ).fetchone()
                if row:
                    return row["id"]
            draft_texts = {_normalize_text(prompt.text) for prompt in payload.prompts if prompt.text.strip()}
            if draft_texts:
                rows = conn.execute(
                    """
                    SELECT i.id, p.text
                    FROM items i
                    JOIN prompts p ON p.item_id=i.id
                    WHERE i.archived=0 AND i.deleted_at IS NULL
                    ORDER BY i.created_at
                    """
                ).fetchall()
        for row in rows if draft_texts else []:
            if _normalize_text(row["text"]) in draft_texts:
                return row["id"]
        return None

    def _record_from_row(self, row) -> ImportDraftRecord:
        data = dict(row)
        data["suggested_tags"] = [str(tag) for tag in _from_json(data.get("suggested_tags"), [])]
        data["prompts"] = [PromptIn.model_validate(prompt) for prompt in _from_json(data.get("prompts"), [])]
        data["media"] = [ImportDraftMedia.model_validate(media) for media in _from_json(data.get("media"), [])]
        data["warnings"] = [str(warning) for warning in _from_json(data.get("warnings"), [])]
        return ImportDraftRecord(**data)
