"""Verified image inputs shared only within one outgoing model request.

The retained cache contains request derivatives, never replacements for original
assets. Business identity remains separate from content identity. Every reuse
and the final preflight revalidate the source path and its file change marker.
"""
from __future__ import annotations

import base64
import hashlib
import os
from io import BytesIO
from threading import RLock

from backend.services.agent_image_encoding import optimize_request_image
from backend.services.agent_repository import AgentError
from backend.services.generation_jobs import GenerationJobConflict, _verify_image_source, resolve_generation_input_image_file


MAX_CACHE_IMAGES = 64
MAX_CACHE_BYTES = 64 * 1024 * 1024
ENCODING_POLICY = "lossless-png-v1"


def encode_verified_image(data: bytes, mime: str) -> str:
    """Encode original bytes whose storage/integrity checks the caller completed."""
    return f"data:{mime};base64," + base64.b64encode(optimize_request_image(data, mime)).decode("ascii")


def _file_version(path):
    # Windows st_ctime is creation time, not a change marker. FileBasicInfo's
    # ChangeTime detects same-size rewrites even if LastWriteTime is restored.
    if os.name == "nt":
        import ctypes
        import msvcrt
        from ctypes import wintypes

        class FileBasicInfo(ctypes.Structure):
            _fields_ = [(name, ctypes.c_longlong) for name in
                        ("CreationTime", "LastAccessTime", "LastWriteTime", "ChangeTime")] + [
                            ("FileAttributes", wintypes.DWORD)]

        query = ctypes.WinDLL("kernel32", use_last_error=True).GetFileInformationByHandleEx
        query.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
        query.restype = wintypes.BOOL
        descriptor = os.open(path, os.O_RDONLY | os.O_BINARY)
        try:
            info = FileBasicInfo()
            if not query(msvcrt.get_osfhandle(descriptor), 0, ctypes.byref(info), ctypes.sizeof(info)):
                raise ctypes.WinError(ctypes.get_last_error())
            value = os.fstat(descriptor)
            changed = info.ChangeTime
        finally:
            os.close(descriptor)
    else:
        value = path.stat()
        changed = value.st_ctime_ns
    return value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, changed


class ImageInputSession:
    """One POST's bounded encoding cache and complete source preflight list."""

    def __init__(self, repo, *, max_images=MAX_CACHE_IMAGES, max_bytes=MAX_CACHE_BYTES):
        self.repo = repo
        self.max_images = min(MAX_CACHE_IMAGES, max(0, int(max_images)))
        self.max_bytes = min(MAX_CACHE_BYTES, max(0, int(max_bytes)))
        self._cache = {}
        # Small identity/version receipts are retained even when encoded pixels
        # exceed the cache limit, so validate() still covers every sent image.
        self._seen = {}
        self._lock = RLock()
        self.metrics = {"imageReads": 0, "imageValidations": 0, "imageEncodings": 0,
                        "imageCacheHits": 0, "imageCacheBytes": 0,
                        "imageCacheLimitBytes": self.max_bytes}

    def _inspect(self, asset_id):
        self.metrics["imageValidations"] += 1
        try:
            asset = self.repo.asset(asset_id)
            path = resolve_generation_input_image_file(self.repo.library, asset["path"])
            return asset, path, _file_version(path)
        except AgentError:
            raise
        except (GenerationJobConflict, KeyError, OSError, ValueError):
            raise AgentError("reference_missing", "参考图片不可用，请重新选择。", 400) from None

    @staticmethod
    def _receipt(asset_id, asset, path, mime, version):
        return (asset_id, asset["sha256"], mime, ENCODING_POLICY), (str(path), version)

    def _checked(self, asset_id):
        asset, path, version = self._inspect(asset_id)
        previous = self._seen.get(asset_id)
        # MIME is trusted only after verifying original bytes, never from the
        # database label. Cache hits use that receipt after checking its version.
        mime = previous[0][2] if previous else None
        try:
            receipt = self._receipt(asset_id, asset, path, mime, version)
        except KeyError:
            raise AgentError("reference_missing", "参考图片不可用，请重新选择。", 400) from None
        if previous is not None and receipt != previous:
            raise AgentError("frozen_reference_invalid", "已冻结的参考图片缺失或损坏；不会用其他图片替换。", 400)
        return path, receipt

    def data_url(self, asset_id):
        with self._lock:
            path, receipt = self._checked(asset_id)
            if asset_id in self._cache:
                self.metrics["imageCacheHits"] += 1
                return self._cache[asset_id]
            try:
                self.metrics["imageReads"] += 1
                data = path.read_bytes()
                if hashlib.sha256(data).hexdigest() != receipt[0][1] or _file_version(path) != receipt[1][1]:
                    raise AgentError("frozen_reference_invalid", "已冻结的参考图片缺失或损坏；不会用其他图片替换。", 400)
                mime = _verify_image_source(BytesIO(data))
            except AgentError:
                raise
            except (GenerationJobConflict, OSError, ValueError):
                raise AgentError("reference_missing", "参考图片不可用，请重新选择。", 400) from None
            receipt = ((asset_id, receipt[0][1], mime, ENCODING_POLICY), receipt[1])
            self.metrics["imageEncodings"] += 1
            result = encode_verified_image(data, mime)
            self._seen[asset_id] = receipt
            # Keep existing entries useful; oversized/new images pass through
            # uncached rather than being truncated, omitted, or evicting inputs.
            if len(self._cache) < self.max_images and self.metrics["imageCacheBytes"] + len(result) <= self.max_bytes:
                self._cache[asset_id] = result
                self.metrics["imageCacheBytes"] += len(result)
            return result

    def identity(self, asset_id):
        """Return (business asset ID, content SHA, MIME, encoding policy)."""
        with self._lock:
            if asset_id not in self._seen:
                self.data_url(asset_id)
            return self._seen[asset_id][0]

    def validate(self):
        """Check every used source immediately before POST, including uncached ones."""
        with self._lock:
            for asset_id in self._seen:
                self._checked(asset_id)
