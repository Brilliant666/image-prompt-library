"""Per-POST image reuse keeps source validation and business identity intact."""
import base64
import hashlib
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
import os
from pathlib import Path

from PIL import Image
import pytest

from backend.db import connect
from backend.services import agent_image_inputs as inputs, generation_jobs
from backend.services.agent_repository import AgentError
from backend.services.generation_jobs import GenerationJobConflict
from test_agent_image_selection import repo


def stored(repo, color=20):
    output = BytesIO()
    Image.new('RGB', (32, 32), (color, 30, 40)).save(output, 'PNG', compress_level=0)
    data = output.getvalue()
    image = repo.store_asset(data, None)
    return image['id'], repo.library / repo.asset(image['id'])['path'], data


def decode(value):
    return base64.b64decode(value.split(',', 1)[1], validate=True)


def test_same_asset_reuses_verified_read_and_encoding_with_fresh_validation(repo):
    asset_id, path, original = stored(repo)
    session = inputs.ImageInputSession(repo)
    first = session.data_url(asset_id)
    identity = session.identity(asset_id)
    assert session.data_url(asset_id) == first
    session.validate()
    assert identity == (asset_id, repo.asset(asset_id)['sha256'], 'image/png', inputs.ENCODING_POLICY)
    assert session.metrics == {'imageReads': 1, 'imageValidations': 3, 'imageEncodings': 1,
                               'imageCacheHits': 1, 'imageCacheBytes': len(first),
                               'imageCacheLimitBytes': 64 * 1024 * 1024}
    assert decode(first) == original and path.read_bytes() == original


def test_identical_content_keeps_distinct_business_asset_identities(repo):
    first, _, raw = stored(repo)
    second = repo.store_asset(raw, None)['id']
    session = inputs.ImageInputSession(repo)
    assert session.data_url(first) == session.data_url(second)
    a, b = session.identity(first), session.identity(second)
    assert a[0] != b[0] and a[1:] == b[1:]
    assert session.metrics['imageReads'] == session.metrics['imageEncodings'] == 2
    assert session.metrics['imageCacheHits'] == 0


@pytest.mark.parametrize('operation', ['cache_hit', 'preflight'])
@pytest.mark.parametrize('change', ['deleted', 'same_size_restored_mtime', 'database_path'])
def test_source_change_cannot_be_hidden_by_request_cache(repo, operation, change):
    asset_id, path, original = stored(repo)
    session = inputs.ImageInputSession(repo)
    session.data_url(asset_id)
    if change == 'deleted':
        path.unlink()
    elif change == 'same_size_restored_mtime':
        _, _, changed = stored(repo, 21)
        assert len(original) == len(changed)
        before = path.stat()
        path.write_bytes(changed)
        os.utime(path, ns=(before.st_atime_ns, before.st_mtime_ns))
    else:
        with connect(repo.library) as conn:
            conn.execute('UPDATE agent_assets SET path=? WHERE id=?', ('../outside.png', asset_id))
    with pytest.raises(AgentError) as failure:
        session.data_url(asset_id) if operation == 'cache_hit' else session.validate()
    assert failure.value.code in {'reference_missing', 'frozen_reference_invalid'}
    assert session.metrics['imageCacheHits'] == 0


def test_initial_read_verifies_sha_even_if_same_size_and_timestamp(repo):
    asset_id, path, original = stored(repo)
    _, _, changed = stored(repo, 21)
    assert len(original) == len(changed)
    before = path.stat()
    path.write_bytes(changed)
    os.utime(path, ns=(before.st_atime_ns, before.st_mtime_ns))
    with pytest.raises(AgentError, match='已冻结') as failure:
        inputs.ImageInputSession(repo).data_url(asset_id)
    assert failure.value.code == 'frozen_reference_invalid'


def test_change_during_read_is_rejected_before_encoding(repo, monkeypatch):
    asset_id, path, _ = stored(repo)
    _, _, changed = stored(repo, 21)
    original_read = Path.read_bytes
    def changed_read(value):
        data = original_read(value)
        if value == path:
            value.write_bytes(changed)
        return data
    monkeypatch.setattr(Path, 'read_bytes', changed_read)
    session = inputs.ImageInputSession(repo)
    with pytest.raises(AgentError):
        session.data_url(asset_id)
    assert session.metrics['imageEncodings'] == 0


@pytest.mark.parametrize('bound', ['bytes', 'entries'])
def test_cache_bounds_pass_through_every_image_and_preflight_includes_uncached(repo, bound):
    first, _, raw = stored(repo)
    second, second_path, other = stored(repo, 21)
    first_size = len(inputs.encode_verified_image(raw, 'image/png'))
    session = inputs.ImageInputSession(repo, max_images=1 if bound == 'entries' else 64,
                                       max_bytes=first_size if bound == 'bytes' else 64 * 1024 * 1024)
    assert decode(session.data_url(first)) == raw
    assert decode(session.data_url(second)) == other
    assert decode(session.data_url(second)) == other
    assert session.metrics['imageCacheBytes'] == first_size
    assert session.metrics['imageEncodings'] == 3
    assert session.data_url(first) == inputs.encode_verified_image(raw, 'image/png')
    assert session.metrics['imageCacheHits'] == 1
    second_path.unlink()
    with pytest.raises(AgentError):
        session.validate()


def test_constructor_cannot_raise_hard_limits_and_zero_disables_retention(repo):
    limited = inputs.ImageInputSession(repo, max_images=1000, max_bytes=1 << 40)
    assert limited.max_images == 64 and limited.max_bytes == 64 * 1024 * 1024
    asset_id, _, raw = stored(repo)
    session = inputs.ImageInputSession(repo, max_images=0)
    for _ in range(2):
        assert decode(session.data_url(asset_id)) == raw
    assert session.metrics['imageCacheBytes'] == session.metrics['imageCacheHits'] == 0
    assert session.metrics['imageReads'] == session.metrics['imageEncodings'] == 2


def test_concurrent_reads_share_one_session_but_other_post_has_own_cache(repo):
    asset_id, _, raw = stored(repo)
    session = inputs.ImageInputSession(repo)
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(session.data_url, [asset_id] * 16))
    assert all(decode(result) == raw for result in results)
    assert session.metrics['imageReads'] == session.metrics['imageEncodings'] == 1
    assert session.metrics['imageCacheHits'] == 15
    next_request = inputs.ImageInputSession(repo)
    assert next_request.data_url(asset_id) == results[0]
    assert next_request.metrics['imageReads'] == 1
    assert next_request.metrics['imageCacheHits'] == 0


@pytest.mark.parametrize('failure', [GenerationJobConflict('private path'), KeyError('private key'), OSError('private path')])
def test_path_failures_become_public_agent_errors(repo, monkeypatch, failure):
    asset_id, _, _ = stored(repo)
    def fail(*args, **kwargs):
        raise failure
    monkeypatch.setattr(inputs, 'resolve_generation_input_image_file', fail)
    with pytest.raises(AgentError) as caught:
        inputs.ImageInputSession(repo).data_url(asset_id)
    assert caught.value.code == 'reference_missing'
    assert 'private' not in caught.value.message


def test_repository_compatibility_entry_uses_common_verified_encoder(repo, monkeypatch):
    asset_id, path, raw = stored(repo)
    calls = []
    def encode(data, mime):
        calls.append((data, mime))
        return 'synthetic-data-url'
    monkeypatch.setattr(inputs, 'encode_verified_image', encode)
    assert repo.data_url(asset_id) == 'synthetic-data-url'
    assert calls == [(raw, 'image/png')]
    assert path.read_bytes() == raw


def test_cache_reuse_validates_in_memory_once_without_pil_reopening_the_file(repo, monkeypatch):
    asset_id, path, raw = stored(repo)
    image_open, read_bytes = Image.open, Path.read_bytes
    opened, reads = [], []
    def count_open(source, *args, **kwargs):
        opened.append(source)
        return image_open(source, *args, **kwargs)
    def count_read(value):
        reads.append(value)
        return read_bytes(value)
    monkeypatch.setattr(Image, 'open', count_open)
    monkeypatch.setattr(Path, 'read_bytes', count_read)
    session = inputs.ImageInputSession(repo)
    for _ in range(5):
        assert decode(session.data_url(asset_id)) == raw
        session.validate()
    assert reads == [path]
    assert len(opened) == 1 and isinstance(opened[0], BytesIO)
    assert session.metrics['imageReads'] == session.metrics['imageEncodings'] == 1
    # Existing callers still receive full file verification from their old API.
    resolved, mime = generation_jobs.resolve_generation_input_image_path(repo.library, repo.asset(asset_id)['path'])
    assert resolved == path and mime == 'image/png'
    assert opened[-1] == path


def test_matching_hash_does_not_make_invalid_png_valid(repo):
    asset_id, path, _ = stored(repo)
    broken = b'\x89PNG\r\n\x1a\nnot-a-valid-image'
    path.write_bytes(broken)
    with connect(repo.library) as conn:
        conn.execute('UPDATE agent_assets SET sha256=? WHERE id=?', (hashlib.sha256(broken).hexdigest(), asset_id))
    session = inputs.ImageInputSession(repo)
    with pytest.raises(AgentError):
        session.data_url(asset_id)
    assert session.metrics['imageEncodings'] == session.metrics['imageCacheBytes'] == 0


def test_cache_hit_checks_safe_path_before_reusing_pixels(repo, monkeypatch):
    asset_id, _, _ = stored(repo)
    session = inputs.ImageInputSession(repo)
    session.data_url(asset_id)
    def rejected(*args, **kwargs):
        raise GenerationJobConflict('path replaced by symlink')
    monkeypatch.setattr(inputs, 'resolve_generation_input_image_file', rejected)
    with pytest.raises(AgentError):
        session.data_url(asset_id)
    assert session.metrics['imageCacheHits'] == 0
    assert session.metrics['imageReads'] == 1


def test_mime_identity_comes_from_verified_bytes_not_database_label(repo):
    asset_id, _, _ = stored(repo)
    with connect(repo.library) as conn:
        conn.execute('UPDATE agent_assets SET mime_type=? WHERE id=?', ('image/jpeg', asset_id))
    session = inputs.ImageInputSession(repo)
    assert session.data_url(asset_id).startswith('data:image/png;')
    assert session.identity(asset_id)[2] == 'image/png'
