"""Limits, stale sources and cleanup cannot turn a failed import into an asset."""
from contextlib import closing
from io import BytesIO
import hashlib
from pathlib import Path
import threading

import pytest
from PIL import Image

from backend.db import connect
from backend.schemas import ImportDraftCreate
from backend.services.image_store import store_image
from backend.services.import_drafts import ImportDraftConflict, ImportDraftRepository, MAX_IMPORT_IMAGE_BYTES
from backend.services.library_cleanup import LibraryCleanupService


def png(color="green", size=(20, 12), fmt="PNG"):
    buffer = BytesIO()
    Image.new("RGB", size, color).save(buffer, fmt)
    return buffer.getvalue()


def fixture(tmp_path, data=None):
    library = tmp_path / "library"
    repo = ImportDraftRepository(library)
    path = library / "import-staging" / "image.png"
    path.parent.mkdir()
    path.write_bytes(png() if data is None else data)
    draft = repo.create_draft(ImportDraftCreate(source_type="repository", title="Synthetic",
        prompts=[{"language":"en", "text":" Original prompt.\n  Exact text. "}],
        media=[{"staged_path":"import-staging/image.png"}]))
    return repo, path, draft


def no_formal_rows(repo, draft):
    with closing(connect(repo.library_path)) as conn:
        for table in ("items", "prompts", "images"):
            assert conn.execute('SELECT count(*) FROM "' + table + '"').fetchone()[0] == 0
    assert repo.get_draft(draft.id).status == "staged"


@pytest.mark.parametrize("kind", ["unsupported", "pixel_limit", "file_limit", "empty"])
def test_actual_format_pixel_file_limits_are_preflight_failures(tmp_path, kind):
    if kind == "unsupported": data = png(fmt="BMP")
    elif kind == "pixel_limit": data = png(size=(4001, 4000))
    elif kind == "empty": data = b""
    else: data = png()
    repo, path, draft = fixture(tmp_path, data)
    if kind == "file_limit":
        with path.open("r+b") as source: source.truncate(MAX_IMPORT_IMAGE_BYTES + 1)
    with pytest.raises(ImportDraftConflict, match={"unsupported":"format", "pixel_limit":"pixel", "file_limit":"30 MB", "empty":"damaged"}[kind]):
        repo.accept_draft(draft.id)
    no_formal_rows(repo, draft)
    assert path.is_file()
    assert not list((repo.library_path / "originals").rglob("*.*"))


def test_staged_hash_mismatch_does_not_claim_another_file(tmp_path):
    repo, path, draft = fixture(tmp_path)
    with closing(connect(repo.library_path)) as conn, conn:
        conn.execute("UPDATE import_drafts SET media=? WHERE id=?",
            ('[{"staged_path":"import-staging/image.png","file_sha256":"' + '0'*64 + '"}]',draft.id))
    with pytest.raises(ImportDraftConflict, match="recorded identity"): repo.accept_draft(draft.id)
    no_formal_rows(repo, draft)
    assert path.read_bytes() == png()


def test_source_replaced_between_validation_and_open_is_rejected(tmp_path, monkeypatch):
    import backend.services.import_drafts as imports
    repo, path, draft = fixture(tmp_path)
    original_open = imports.os.open
    changed = False
    def replace_before_open(value, flags, *args, **kwargs):
        nonlocal changed
        if Path(value) == path and not changed:
            changed = True
            path.unlink()
            path.write_bytes(png("blue"))
        return original_open(value, flags, *args, **kwargs)
    monkeypatch.setattr(imports.os, "open", replace_before_open)
    with pytest.raises(ImportDraftConflict, match="changed"): repo.accept_draft(draft.id)
    no_formal_rows(repo, draft)


def test_concurrent_draft_change_during_preparation_is_not_overwritten(tmp_path, monkeypatch):
    import backend.services.import_drafts as imports
    repo, path, draft = fixture(tmp_path)
    original = imports.store_image
    def prepare_then_change(*args, **kwargs):
        result = original(*args, **kwargs)
        with closing(connect(repo.library_path)) as conn, conn:
            conn.execute("UPDATE import_drafts SET title=?,updated_at=? WHERE id=?",("Changed by another request","next-version",draft.id))
        return result
    monkeypatch.setattr(imports, "store_image", prepare_then_change)
    with pytest.raises(ImportDraftConflict, match="draft changed"): repo.accept_draft(draft.id)
    no_formal_rows(repo, draft)
    assert repo.get_draft(draft.id).title == "Changed by another request"


def test_cleanup_stale_preview_is_serialized_with_publishing_import(tmp_path, monkeypatch):
    repo, path, draft = fixture(tmp_path)
    stored = store_image(repo.library_path, png(), "image.png")
    cleanup = LibraryCleanupService(repo.library_path)
    preview = cleanup.preview()
    assert stored.original_path in {record.path for record in preview.unreferenced_files}
    original_publish = repo._publish_media
    started = threading.Event()
    completed = threading.Event()
    results = []
    errors = []
    def run_cleanup():
        started.set()
        try: results.append(cleanup.apply(preview, remove_broken_image_records=True, remove_unreferenced_files=True))
        except BaseException as exc: errors.append(exc)
        finally: completed.set()
    worker = threading.Thread(target=run_cleanup)
    def publish_then_cleanup(*args):
        result = original_publish(*args)
        worker.start()
        assert started.wait(3)
        assert not completed.wait(0.1)  # Another writer cannot unlink before the import commits.
        return result
    monkeypatch.setattr(repo, "_publish_media", publish_then_cleanup)
    try: accepted = repo.accept_draft(draft.id)
    finally: worker.join(timeout=5)
    assert not worker.is_alive() and not errors
    assert results[0].removed_unreferenced_files == 0
    assert len(accepted.item.images) == 1
    for name in (stored.original_path, stored.thumb_path, stored.preview_path): assert (repo.library_path/name).is_file()
    assert (repo.library_path/stored.original_path).read_bytes() == png()


def test_lost_accept_response_cannot_recreate_a_deleted_item(tmp_path):
    repo, path, draft = fixture(tmp_path)
    result = repo.accept_draft(draft.id)
    repo.items.delete_item(result.item.id)
    with pytest.raises(ImportDraftConflict, match="deleted"): repo.accept_draft(draft.id)
    with closing(connect(repo.library_path)) as conn:
        assert conn.execute("SELECT count(*) FROM items").fetchone()[0] == 1
    assert repo.get_draft(draft.id).accepted_item_id == result.item.id


def test_true_duplicate_is_rechecked_with_the_same_accept_transaction(tmp_path):
    repo, path, draft = fixture(tmp_path)
    another = repo.create_draft(ImportDraftCreate(source_type="repository",title="Other staged draft",
        prompts=[{"language":"en","text":draft.prompts[0].text}], media=[]))
    accepted = repo.accept_draft(draft.id)
    with pytest.raises(ImportDraftConflict, match="duplicate"): repo.accept_draft(another.id)
    assert repo.get_draft(another.id).duplicate_of_item_id == accepted.item.id
    with closing(connect(repo.library_path)) as conn:
        assert conn.execute("SELECT count(*) FROM items").fetchone()[0] == 1


def test_source_replaced_during_publication_still_rolls_back(tmp_path, monkeypatch):
    repo, path, draft = fixture(tmp_path)
    publish = repo._publish_media
    def publish_then_replace(*args):
        result = publish(*args)
        path.unlink()
        path.write_bytes(png("blue"))
        return result
    monkeypatch.setattr(repo, "_publish_media", publish_then_replace)
    with pytest.raises(ImportDraftConflict, match="changed"):
        repo.accept_draft(draft.id)
    no_formal_rows(repo, draft)


def test_repository_ingest_does_not_write_through_redirected_staging_root(tmp_path):
    import os
    import subprocess
    from backend.schemas import RepositoryIngestRequest
    from backend.services.repository_ingest import ingest_repository_to_drafts
    library = tmp_path / "library"
    ImportDraftRepository(library)
    outside = tmp_path / "outside"
    outside.mkdir()
    link = library / "import-staging"
    if os.name == "nt":
        subprocess.run(["cmd.exe", "/d", "/c", "mklink", "/J", str(link), str(outside)], check=True, capture_output=True)
    else:
        link.symlink_to(outside, target_is_directory=True)
    source = tmp_path / "repository"
    source.mkdir()
    (source / "image.png").write_bytes(png())
    (source / "gallery.md").write_text("# Collection\n\n## Synthetic\n\n![Image](image.png)\n\n```text\nSynthetic prompt\n```\n", encoding="utf8")
    try:
        with pytest.raises(ImportDraftConflict):
            ingest_repository_to_drafts(RepositoryIngestRequest(path=str(source)), library)
        assert not list(outside.iterdir())
        with closing(connect(library)) as conn:
            assert conn.execute("SELECT count(*) FROM import_drafts").fetchone()[0] == 0
    finally:
        if os.name == "nt": os.rmdir(link)
        else: link.unlink()
