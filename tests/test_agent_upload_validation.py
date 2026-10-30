"""Upload validation uses synthetic images, isolated storage and no provider IO."""
import asyncio
from io import BytesIO
import struct
import zlib

from fastapi.testclient import TestClient
from PIL import Image
import pytest

from backend.db import connect
from backend.main import create_app
from backend.routers import agent as agent_router
from backend.services.agent_repository import AgentError, AgentRepository
from backend.services.generation_jobs import _validate_storeable_image_bytes, GenerationJobConflict
from test_agent_workspaces import isolated


LIMIT = 30 * 1024 * 1024


def image_bytes(fmt='PNG', size=(8, 6)):
    output = BytesIO()
    Image.new('RGB', size, (20, 80, 140)).save(output, fmt)
    return output.getvalue()


def header_only_pixels(width, height):
    # A header probe does not allocate the claimed raster. The size limit must
    # reject it before the intentionally mismatched pixel stream is decoded.
    raw = bytearray(image_bytes(size=(1, 1)))
    raw[16:24] = struct.pack('>II', width, height)
    raw[29:33] = struct.pack('>I', zlib.crc32(raw[12:29]) & 0xffffffff)
    return bytes(raw)


def bad_png_checksum():
    raw = bytearray(image_bytes())
    length = struct.unpack('>I', raw[33:37])[0]
    raw[41 + length] ^= 1
    return bytes(raw)


def asset_counts(library):
    with connect(library) as connection:
        count = connection.execute('SELECT count(*) FROM agent_assets').fetchone()[0]
    files = list((library/'generation-references'/'agent').rglob('*'))
    return count, sum(path.is_file() for path in files)


@pytest.fixture
def api(isolated):
    # No lifespan workers are needed for uploads. Every database/configuration
    # root is synthetic; HTTP is the production ASGI upload route.
    app = create_app(isolated)
    client = TestClient(app)
    yield client, isolated
    client.close()


def upload(client, raw, *, filename='synthetic.png', mime='image/png'):
    return client.post('/api/agent/uploads', files={'file': (filename, raw, mime)})


@pytest.mark.parametrize('raw,status,code', [
    (header_only_pixels(5000, 4000), 413, 'image_pixel_limit_exceeded'),
    (header_only_pixels(16_000_001, 1), 413, 'image_pixel_limit_exceeded'),
    (header_only_pixels(20000, 10000), 413, 'image_safety_limit_exceeded'),
    (image_bytes('GIF'), 415, 'image_format_unsupported'),
    (b'not an image despite the png extension', 400, 'image_decode_failed'),
    (image_bytes()[:42], 400, 'image_decode_failed'),
    (bad_png_checksum(), 400, 'image_decode_failed'),
    (image_bytes('JPEG')[:-8], 400, 'image_decode_failed'),
])
def test_invalid_uploads_have_precise_errors_and_create_no_assets(api, raw, status, code):
    client, library = api
    before = asset_counts(library)
    response = upload(client, raw)
    assert response.status_code == status
    detail = response.json()['detail']
    assert detail['code'] == code
    assert '不是有效图片' not in detail['message']
    if code == 'image_pixel_limit_exceeded':
        assert '16,000,000' in detail['message']
    if code == 'image_safety_limit_exceeded':
        assert '20000' not in detail['message'] and '10000' not in detail['message']
    assert asset_counts(library) == before == (0, 0)


def test_file_byte_limit_does_not_guess_total_size_from_bounded_read(api):
    client, library = api
    raw = image_bytes()
    at_limit = raw + bytes(LIMIT - len(raw))
    accepted = upload(client, at_limit)
    assert accepted.status_code == 200
    image = accepted.json()['image']
    repo = AgentRepository(library)
    stored = repo.asset(image['id'])
    assert (library/stored['path']).read_bytes() == at_limit
    before = asset_counts(library)
    for extra in (1, 128):
        response = upload(client, at_limit + bytes(extra))
        assert response.status_code == 413
        detail = response.json()['detail']
        assert detail['code'] == 'image_file_too_large'
        assert '30 MiB' in detail['message']
        assert str(LIMIT + extra) not in detail['message']
        assert asset_counts(library) == before


def test_router_reads_only_limit_plus_one_and_never_persists_rejection(api):
    _, library = api
    class File:
        reads = []
        async def read(self, limit):
            self.reads.append(limit)
            return bytes(limit)
    file = File()
    class State:
        library_path = library
    class App:
        state = State()
    class Request:
        app = App()
    with pytest.raises(AgentError) as failure:
        asyncio.run(agent_router.upload(Request(), file, 'reference'))
    assert failure.value.code == 'image_file_too_large'
    assert file.reads == [LIMIT + 1]
    assert asset_counts(library) == (0, 0)


@pytest.mark.parametrize('fmt,filename,mime', [
    ('PNG', 'wrong.jpg', 'text/plain'),
    ('JPEG', 'wrong.png', 'image/webp'),
    ('WEBP', 'wrong.gif', 'application/octet-stream'),
])
def test_supported_content_ignores_filename_and_mime_and_preserves_original(api, fmt, filename, mime):
    client, library = api
    raw = image_bytes(fmt)
    response = upload(client, raw, filename=filename, mime=mime)
    assert response.status_code == 200
    image = response.json()['image']
    assert image['width'] == 8 and image['height'] == 6
    repo = AgentRepository(library)
    assert (library/repo.asset(image['id'])['path']).read_bytes() == raw


def test_actual_pixel_boundary_accepts_valid_original(api):
    client, library = api
    raw = image_bytes(size=(4000, 4000))
    response = upload(client, raw)
    assert response.status_code == 200
    image = response.json()['image']
    assert image['width'] * image['height'] == 16_000_000
    assert (library/AgentRepository(library).asset(image['id'])['path']).read_bytes() == raw


def test_shared_gallery_validator_preserves_classification_and_value_error_contract():
    with pytest.raises(GenerationJobConflict) as failure:
        _validate_storeable_image_bytes(header_only_pixels(5000, 4000))
    assert isinstance(failure.value, ValueError)
    assert failure.value.code == 'image_pixel_limit_exceeded'
    assert failure.value.status == 413
    assert '5000' in str(failure.value) and '4000' in str(failure.value)


@pytest.mark.parametrize('raw,status,code', [
    (header_only_pixels(5000, 4000), 413, 'image_pixel_limit_exceeded'),
    (header_only_pixels(20000, 10000), 413, 'image_safety_limit_exceeded'),
    (b'broken synthetic image', 400, 'image_decode_failed'),
])
def test_gallery_result_upload_reports_same_classification_without_result_files(api, raw, status, code):
    client, library = api
    job = client.post('/api/generation-jobs', json={'prompt_text': 'synthetic upload validation'}).json()
    response = client.post(f"/api/generation-jobs/{job['id']}/result",
                           files={'file': ('synthetic.png', raw, 'image/png')})
    assert response.status_code == status
    assert response.json()['detail']['code'] == code
    record = AgentRepository(library).jobs.get_job(job['id'])
    assert record.result_path is None
    assert not any(path.is_file() for path in (library/'generation-results').rglob('*'))


def test_gallery_reference_pixel_failure_keeps_same_code_and_creates_no_frozen_asset(api):
    from backend.schemas import GenerationJobCreate
    client, library = api
    repo = AgentRepository(library)
    job = repo.jobs.create_job(GenerationJobCreate(prompt_text='synthetic stored result'))
    job = repo.jobs.stage_result(job.id, image_bytes(), 'synthetic.png')
    (library/job.result_path).write_bytes(header_only_pixels(5000, 4000))
    with pytest.raises(AgentError) as failure:
        repo.resolve_ref({'kind': 'job', 'jobId': job.id})
    assert failure.value.code == 'image_pixel_limit_exceeded'
    assert failure.value.status == 413
    assert asset_counts(library) == (0, 0)


def test_gallery_keeps_preexisting_gif_support_while_agent_has_explicit_format_limit(api):
    client, _ = api
    raw = image_bytes('GIF')
    assert upload(client, raw).json()['detail']['code'] == 'image_format_unsupported'
    job = client.post('/api/generation-jobs', json={'prompt_text': 'synthetic gif result'}).json()
    response = client.post(f"/api/generation-jobs/{job['id']}/result",
                           files={'file': ('synthetic.gif', raw, 'image/gif')})
    assert response.status_code == 200


def test_gallery_file_byte_limit_is_classified_without_mutating_job(api):
    client, library = api
    raw = image_bytes()
    job = client.post('/api/generation-jobs', json={'prompt_text': 'synthetic bounded upload'}).json()
    response = client.post(f"/api/generation-jobs/{job['id']}/result",
        files={'file': ('synthetic.png', raw + bytes(LIMIT + 1 - len(raw)), 'image/png')})
    assert response.status_code == 413
    assert response.json()['detail']['code'] == 'image_file_too_large'
    assert '30 MiB' in response.json()['detail']['message']
    assert AgentRepository(library).jobs.get_job(job['id']).result_path is None


def test_pillow_safety_warning_promoted_to_error_stays_a_safe_classification(api):
    import warnings
    client, library = api
    with warnings.catch_warnings():
        warnings.simplefilter('error', Image.DecompressionBombWarning)
        response = upload(client, header_only_pixels(10000, 10000))
    assert response.status_code == 413
    assert response.json()['detail']['code'] == 'image_safety_limit_exceeded'
    assert asset_counts(library) == (0, 0)
