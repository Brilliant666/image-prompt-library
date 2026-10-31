"""Local, job-bound receipts for validated final image results.

The image is durably written before this receipt, and the receipt precedes the
SQLite result transaction. This module never calls a provider or claims an
unrecorded file as a successful result. Receipts live beside the existing result
and are included by the portable library archive, not in a second queue.
"""
from __future__ import annotations

import hashlib
from io import BytesIO
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat

from PIL import Image

from backend.services.image_store import MAX_IMAGE_PIXELS, _atomic_write_bytes

RECEIPT_NAME = 'local-result.json'
MAX_RECEIPT_BYTES = 16 * 1024
# Native Responses already accepts an 80 MiB JSON/SSE envelope, which can carry
# nearly 60 MiB of decoded image data. A local recovery limit must cover that
# existing bounded protocol; the separate image-download cap remains 32 MiB.
MAX_RESULT_BYTES = 64 * 1024 * 1024
PENDING_MESSAGE = '图片已取得，本地保存记录待恢复；请恢复原结果，不要重新生成。'
BLOCKED_MESSAGE = '本地结果需要核对；文件与恢复记录已保留，不会重新请求供应商。'


class RecoveryConflict(ValueError):
    pass


def identity(job):
    agent = (job.metadata or {}).get('agentRetry') or (job.metadata or {}).get('agent') or {}
    value = {key: getattr(job, key, None) for key in
             ('id', 'provider', 'model', 'prompt_text', 'edited_prompt_text', 'parameters',
              'created_at', 'source_item_id', 'source_image_id', 'source_prompt_id', 'mode',
              'reference_image_ids', 'prompt_language', 'generation_group_id',
              'generation_group_index','generation_group_size')}
    value['agent'] = {key: agent.get(key) for key in
                      ('requestId','sourceRequestId','toolCallId','roundId','conversationId','retryId')}
    raw = json.dumps(value, sort_keys=True, ensure_ascii=True, separators=(',',':')).encode()
    return hashlib.sha256(raw).hexdigest()


def job_directory(library, job_id):
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,160}', job_id):
        raise RecoveryConflict(BLOCKED_MESSAGE)
    library = Path(library).resolve()
    root = library/'generation-results'
    directory = root/job_id
    for path in (root, directory):
        if os.path.lexists(path):
            info = path.lstat()
            if stat.S_ISLNK(info.st_mode) or getattr(info,'st_file_attributes',0) & 0x400 or not stat.S_ISDIR(info.st_mode):
                raise RecoveryConflict(BLOCKED_MESSAGE)
    if directory.resolve() != directory:
        raise RecoveryConflict(BLOCKED_MESSAGE)
    return directory


def _regular(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or getattr(info,'st_file_attributes',0) & 0x400:
        raise RecoveryConflict(BLOCKED_MESSAGE)
    return info


def _read_regular(path, limit):
    before = _regular(path)
    if before.st_size > limit:
        raise RecoveryConflict(BLOCKED_MESSAGE)
    flags = os.O_RDONLY | getattr(os,'O_BINARY',0) | getattr(os,'O_NOFOLLOW',0)
    with os.fdopen(os.open(path,flags),'rb') as stream:
        opened = os.fstat(stream.fileno())
        identity_before = (before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns)
        if identity_before != (opened.st_dev,opened.st_ino,opened.st_size,opened.st_mtime_ns):
            raise RecoveryConflict(BLOCKED_MESSAGE)
        data = stream.read(limit + 1)
        after = os.fstat(stream.fileno())
    current = _regular(path)
    if (len(data) > limit or identity_before != (after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns)
            or identity_before != (current.st_dev,current.st_ino,current.st_size,current.st_mtime_ns)):
        raise RecoveryConflict(BLOCKED_MESSAGE)
    return data


def _image_details(data):
    if not data or len(data) > MAX_RESULT_BYTES:
        raise RecoveryConflict(BLOCKED_MESSAGE)
    try:
        with Image.open(BytesIO(data)) as image:
            fmt, width, height = image.format, image.width, image.height
            if fmt not in {'PNG','JPEG','WEBP','GIF'} or width * height > MAX_IMAGE_PIXELS:
                raise ValueError()
            image.verify()
        with Image.open(BytesIO(data)) as image:
            image.load()
    except Exception as exc:
        raise RecoveryConflict(BLOCKED_MESSAGE) from exc
    return {'sha256':hashlib.sha256(data).hexdigest(), 'bytes':len(data),
            'format':fmt, 'width':width, 'height':height}


def write_receipt(library, job, result_path, data):
    directory = job_directory(library, job.id)
    relative = PurePosixPath(result_path)
    if relative.parts[:2] != ('generation-results',job.id) or len(relative.parts) != 3:
        raise RecoveryConflict(BLOCKED_MESSAGE)
    value = {'schema':1, 'job_id':job.id, 'provider':job.provider,
             'identity_sha256':identity(job), 'terminal':'completed',
             'result':{'path':result_path, **_image_details(data)}}
    target = directory/RECEIPT_NAME
    if target.exists():
        previous = validate_receipt(library, job)
        if previous != value:
            raise RecoveryConflict(BLOCKED_MESSAGE)
        return previous
    _atomic_write_bytes(target, json.dumps(value, sort_keys=True, ensure_ascii=True, separators=(',',':')).encode())
    return value


def validate_receipt(library, job):
    """Validate format, frozen identity and bytes independently of job status.

    Archive validation can retain a receipt after a user cancellation. Whether
    that result may be registered is deliberately decided under the DB lock.
    """
    directory = job_directory(library, job.id)
    path = directory/RECEIPT_NAME
    try:
        value = json.loads(_read_regular(path,MAX_RECEIPT_BYTES))
        if set(value) != {'schema','job_id','provider','identity_sha256','terminal','result'}:
            raise ValueError()
        if (type(value['schema']) is not int or value['schema'] != 1 or value['job_id'] != job.id or value['provider'] != job.provider
                or value['identity_sha256'] != identity(job) or value['terminal'] != 'completed'):
            raise ValueError()
        result = value['result']
        if set(result) != {'path','sha256','bytes','format','width','height'}:
            raise ValueError()
        if any(type(result[key]) is not int or result[key] <= 0 for key in ('bytes','width','height')):
            raise ValueError()
        relative = PurePosixPath(result['path'])
        if (relative.is_absolute() or relative.parts[:2] != ('generation-results',job.id)
                or len(relative.parts) != 3 or '\\' in result['path'] or '..' in relative.parts
                or not re.fullmatch(r'result-[a-f0-9]{12,64}\.(?:png|jpg|jpeg|webp|gif)', relative.name)):
            raise ValueError()
        image_path = directory/relative.name
        data = _read_regular(image_path,MAX_RESULT_BYTES)
        actual = _image_details(data)
        if result != {'path':relative.as_posix(), **actual}:
            raise ValueError()
        candidates = [p.name for p in directory.glob('result-*') if p.is_file()
                      and re.fullmatch(r'result-[a-f0-9]{12,64}\.(?:png|jpg|jpeg|webp|gif)',p.name)]
        if candidates != [relative.name]:
            raise ValueError()
        return value
    except (OSError,ValueError,TypeError,KeyError) as exc:
        raise RecoveryConflict(BLOCKED_MESSAGE) from exc


def evidence(library, job):
    """Cheap existence check; full decode is reserved for explicit recovery."""
    try:
        directory = job_directory(library, job.id)
        receipt = directory/RECEIPT_NAME
        if os.path.lexists(receipt):
            return True
        # An image whose receipt could not be written must still block a paid
        # retry, but is never automatically promoted by filename or short hash.
        return (not job.result_path and directory.exists()
                and any(re.fullmatch(r'result-[a-f0-9]{12,64}\.(?:png|jpg|jpeg|webp|gif)',p.name)
                        for p in directory.glob('result-*')))
    except (OSError,RecoveryConflict):
        # A rejected preflight has authoritatively sent no provider request.
        # All other unsafe directories remain blocked: they may hide an
        # already obtained final result and must never trigger a paid replay.
        # Codex validates these roots before mark_running and before any POST.
        # Let only its never-dispatched queued job reach that rejecting
        # preflight; other providers/started jobs retain the conservative gate.
        never_dispatched_codex = (getattr(job,'provider',None) == 'openai_codex_oauth_native'
            and getattr(job,'status',None) == 'queued' and getattr(job,'started_at',False) is None)
        metadata = getattr(job,'metadata',None)
        return not (never_dispatched_codex
            or isinstance(metadata,dict) and metadata.get('_generation_preflight_failed') is True)


def clear_receipt(library, job):
    """Only called after a same-hash SQLite commit; failed cleanup is harmless."""
    try:
        path = job_directory(library,job.id)/RECEIPT_NAME
        path.unlink(missing_ok=True)
    except OSError:
        pass


def describe_evidence(library, job):
    """Project bounded receipt structure, never claim unverified bytes valid.

    List/snapshot responses must not decode every historical image. Actual
    recovery still checks all bytes and dimensions under the database claim.
    """
    if not evidence(library,job):
        return None
    blocked = {'state':'blocked','message':BLOCKED_MESSAGE,'can_recover':False}
    try:
        directory = job_directory(library,job.id)
        value = json.loads(_read_regular(directory/RECEIPT_NAME,MAX_RECEIPT_BYTES))
        if (not isinstance(value,dict) or set(value) != {'schema','job_id','provider','identity_sha256','terminal','result'}
                or type(value['schema']) is not int or value['schema'] != 1
                or value['job_id'] != job.id or value['provider'] != job.provider
                or value['identity_sha256'] != identity(job) or value['terminal'] != 'completed'):
            return blocked
        result = value['result']
        if not isinstance(result,dict) or set(result) != {'path','sha256','bytes','format','width','height'}:
            return blocked
        if (not isinstance(result['path'],str) or not re.fullmatch(r'[a-f0-9]{64}',str(result['sha256']))
                or result['format'] not in {'PNG','JPEG','WEBP','GIF'}
                or any(type(result[key]) is not int or result[key] <= 0 for key in ('bytes','width','height'))
                or result['bytes'] > MAX_RESULT_BYTES or result['width'] * result['height'] > MAX_IMAGE_PIXELS):
            return blocked
        relative = PurePosixPath(result['path'])
        if (relative.is_absolute() or '\\' in result['path'] or len(relative.parts) != 3
                or relative.parts[:2] != ('generation-results',job.id)
                or not re.fullmatch(r'result-[a-f0-9]{12,64}\.(?:png|jpg|jpeg|webp|gif)',relative.name)):
            return blocked
        candidates = [p for p in directory.glob('result-*')
                      if re.fullmatch(r'result-[a-f0-9]{12,64}\.(?:png|jpg|jpeg|webp|gif)',p.name)]
        if len(candidates) != 1 or candidates[0].name != relative.name or _regular(candidates[0]).st_size != result['bytes']:
            return blocked
        if job.status in {'succeeded','accepted'} and job.result_sha256 == result['sha256']:
            return None
        if (job.status not in {'queued','running','failed'} or job.result_path
                or job.metadata.get('_generation_accept_claim') or job.metadata.get('retried_by_generation_job_id')):
            return blocked
        return {'state':'pending','message':'图片已取得，本地保存记录待核对；请检查原结果，不要重新生成。','can_recover':True}
    except (OSError,ValueError,TypeError,KeyError):
        return blocked
