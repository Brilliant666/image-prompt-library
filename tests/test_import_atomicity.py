"""Import acceptance commits one complete asset or keeps the draft retryable."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from io import BytesIO
import os
from pathlib import Path
import sqlite3
import subprocess

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from backend.db import connect
from backend.main import create_app
from backend.repositories import ItemRepository, StoredImageInput
from backend.schemas import ImportDraftCreate, ItemCreate
from backend.services.image_store import store_image
from backend.services.import_drafts import ImportDraftConflict, ImportDraftRepository
from backend.services.library_cleanup import LibraryCleanupService


def image_bytes(color="red", *, fmt="PNG", size=(24, 16)):
    stream = BytesIO()
    Image.new("RGB", size, color).save(stream, fmt)
    return stream.getvalue()


def stage(library, name, data):
    path = library / "import-staging" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path.relative_to(library).as_posix()


def payload(paths=(), *, prompt="  Synthetic prompt.\nKeep original whitespace.  ", **kwargs):
    return ImportDraftCreate(source_type="repository", title="Synthetic import", model="",
                             prompts=[{"language": "en", "text": prompt, "is_original": True}],
                             media=[{"staged_path": path, "role": "result_image"} for path in paths], **kwargs)


def rows(library):
    with closing(connect(library)) as conn:
        return {table: conn.execute('SELECT count(*) FROM "' + table + '"').fetchone()[0]
                for table in ("items", "prompts", "images")}


def assert_uncommitted(repo, draft_id):
    assert rows(repo.library_path) == {"items": 0, "prompts": 0, "images": 0}
    draft = repo.get_draft(draft_id)
    assert draft.status == "staged" and draft.accepted_item_id is None


@pytest.mark.parametrize("contents", [None, b"corrupt image"])
def test_declared_missing_or_corrupt_image_is_not_a_success(tmp_path, contents):
    library = tmp_path / "library"
    repo = ImportDraftRepository(library)
    path = "import-staging/image.png"
    if contents is not None:
        stage(library, "image.png", contents)
    draft = repo.create_draft(payload([path]))
    c = TestClient(create_app(library_path=library), raise_server_exceptions=False)
    response = c.post(f"/api/import-drafts/{draft.id}/accept")
    assert response.status_code == 409
    assert str(tmp_path) not in response.text
    assert_uncommitted(repo, draft.id)


def test_second_bad_image_does_not_leave_first_image_or_prompt(tmp_path):
    library = tmp_path / "library"
    repo = ImportDraftRepository(library)
    first = stage(library, "one.png", image_bytes())
    second = stage(library, "two.png", b"bad")
    draft = repo.create_draft(payload([first, second]))
    with pytest.raises(ImportDraftConflict):
        repo.accept_draft(draft.id)
    assert_uncommitted(repo, draft.id)
    assert (library / first).read_bytes() == image_bytes()
    (library / second).write_bytes(image_bytes("blue"))
    result = repo.accept_draft(draft.id)
    assert result.draft.status == "accepted" and len(result.item.images) == 2
    assert next(p.text for p in result.item.prompts if p.is_original) == payload().prompts[0].text


@pytest.mark.parametrize("failure", ["item", "image", "accepted", "commit"])
def test_accept_database_failure_rolls_back_all_rows_and_can_retry(tmp_path, monkeypatch, failure):
    import backend.services.import_drafts as imports
    library = tmp_path / "library"
    repo = ImportDraftRepository(library)
    source = stage(library, "one.png", image_bytes())
    draft = repo.create_draft(payload([source]))
    original_connect = imports.connect

    class FailConnection:
        def __init__(self, conn): self.conn = conn
        def __getattr__(self, name): return getattr(self.conn, name)
        def __enter__(self): self.conn.__enter__(); return self
        def __exit__(self, *args): return self.conn.__exit__(*args)
        def execute(self, sql, *args):
            target = {"item": "INSERT INTO items", "image": "INSERT INTO images", "accepted": "UPDATE import_drafts SET status='accepted'"}.get(failure)
            if target and sql.strip().startswith(target):
                raise sqlite3.OperationalError("Synthetic database failure")
            return self.conn.execute(sql, *args)
        def commit(self):
            if failure == "commit" and self.conn.in_transaction:
                raise sqlite3.OperationalError("Synthetic commit failure")
            return self.conn.commit()

    with monkeypatch.context() as patch:
        patch.setattr(imports, "connect", lambda *args: FailConnection(original_connect(*args)))
        with pytest.raises(ImportDraftConflict):
            repo.accept_draft(draft.id)
    assert_uncommitted(repo, draft.id)
    assert (library / source).read_bytes() == image_bytes()
    accepted = repo.accept_draft(draft.id)
    assert accepted.draft.status == "accepted" and len(accepted.item.images) == 1
    assert rows(library) == {"items": 1, "prompts": 1, "images": 1}


def test_successful_acceptance_replay_and_concurrent_requests_use_one_item(tmp_path):
    library = tmp_path / "library"
    repo = ImportDraftRepository(library)
    source = stage(library, "one.png", image_bytes())
    draft = repo.create_draft(payload([source]))
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: ImportDraftRepository(library).accept_draft(draft.id), range(2)))
    assert len({result.item.id for result in results}) == 1
    (library / source).unlink()  # A lost response can be resolved without the old staging file.
    replay = repo.accept_draft(draft.id)
    assert replay.item.id == results[0].item.id
    assert rows(library) == {"items": 1, "prompts": 1, "images": 1}


@pytest.mark.parametrize("mutation", ["delete", "replace"])
def test_source_changed_after_preflight_is_rejected_before_commit(tmp_path, monkeypatch, mutation):
    import backend.services.import_drafts as imports
    library = tmp_path / "library"
    repo = ImportDraftRepository(library)
    source = stage(library, "one.png", image_bytes())
    draft = repo.create_draft(payload([source]))
    original = imports.store_image

    def change_after_preparation(*args, **kwargs):
        stored = original(*args, **kwargs)
        (library / source).unlink()
        if mutation == "replace": (library / source).write_bytes(image_bytes("blue"))
        return stored

    with monkeypatch.context() as patch:
        patch.setattr(imports, "store_image", change_after_preparation)
        with pytest.raises(ImportDraftConflict, match="changed|missing"):
            repo.accept_draft(draft.id)
    assert_uncommitted(repo, draft.id)


def test_import_rollback_does_not_delete_same_hash_media_owned_by_another_item(tmp_path, monkeypatch):
    library = tmp_path / "library"
    repo = ImportDraftRepository(library)
    stored = store_image(library, image_bytes(), "image.png")
    existing = repo.items.create_item(ItemCreate(title="Other asset"))
    repo.items.add_image(existing.id, StoredImageInput(**stored.__dict__))
    source = stage(library, "one.png", image_bytes())
    draft = repo.create_draft(payload([source]))
    def fail(*args, **kwargs): raise sqlite3.OperationalError("Synthetic insert failure")
    with monkeypatch.context() as patch:
        patch.setattr(repo.items, "add_image_in_transaction", fail)
        with pytest.raises(ImportDraftConflict): repo.accept_draft(draft.id)
    assert repo.get_draft(draft.id).status == "staged"
    assert rows(library) == {"items": 1, "prompts": 0, "images": 1}
    for name in (stored.original_path, stored.thumb_path, stored.preview_path):
        assert (library / name).is_file()
    assert (library / stored.original_path).read_bytes() == image_bytes()


def test_real_duplicate_and_plain_text_keep_existing_product_semantics(tmp_path):
    repo = ImportDraftRepository(tmp_path / "library")
    draft = repo.create_draft(payload())
    accepted = repo.accept_draft(draft.id)
    assert accepted.item.images == []
    duplicate = repo.create_draft(payload(prompt=payload().prompts[0].text))
    assert duplicate.duplicate_of_item_id == accepted.item.id
    with pytest.raises(ImportDraftConflict, match="duplicate"): repo.accept_draft(duplicate.id)


def directory_link(link, target):
    if os.name == "nt":
        subprocess.run(["cmd.exe", "/d", "/c", "mklink", "/J", str(link), str(target)],
                       check=True, capture_output=True)
    else:
        link.symlink_to(target, target_is_directory=True)


@pytest.mark.parametrize("location", ["root", "child"])
def test_real_staging_directory_link_cannot_read_outside_library(tmp_path, location):
    library = tmp_path / "library"
    repo = ImportDraftRepository(library)
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.png").write_bytes(image_bytes())
    if location == "root":
        link = library / "import-staging"
        relative = "import-staging/secret.png"
    else:
        (library / "import-staging").mkdir()
        link = library / "import-staging" / "linked"
        relative = "import-staging/linked/secret.png"
    directory_link(link, outside)
    try:
        draft = repo.create_draft(payload([relative]))
        with pytest.raises(ImportDraftConflict): repo.accept_draft(draft.id)
        assert_uncommitted(repo, draft.id)
        assert (outside / "secret.png").read_bytes() == image_bytes()
    finally:
        if os.name == "nt": os.rmdir(link)
        else: link.unlink()


@pytest.mark.skipif(os.name == "nt", reason="POSIX symlink cases run on Linux CI; Windows junctions are exercised above")
@pytest.mark.parametrize("kind", ["file", "loop"])
def test_real_staging_file_or_loop_link_is_rejected(tmp_path, kind):
    library = tmp_path / "library"
    repo = ImportDraftRepository(library)
    (library / "import-staging").mkdir()
    target = tmp_path / "outside.png"
    target.write_bytes(image_bytes())
    link = library / "import-staging" / "linked.png"
    link.symlink_to(link if kind == "loop" else target)
    draft = repo.create_draft(payload(["import-staging/linked.png"]))
    with pytest.raises(ImportDraftConflict): repo.accept_draft(draft.id)
    assert_uncommitted(repo, draft.id)


@pytest.mark.parametrize("path", ["C:/outside.png", "C:outside.png", "//server/share/image.png",
                                  "\\\\server\\share\\image.png", "import-staging/../../image.png"])
def test_drive_unc_and_traversal_are_rejected_on_every_platform(tmp_path, path):
    repo = ImportDraftRepository(tmp_path / "library")
    draft = repo.create_draft(payload([path]))
    with pytest.raises(ImportDraftConflict): repo.accept_draft(draft.id)
    assert_uncommitted(repo, draft.id)
