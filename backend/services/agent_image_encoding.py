"""Lossless, request-only PNG compression. Never rewrites stored image assets.

Recompressing IDAT preserves the *filtered scanline bytes*, not just an RGB
rendering: palette, alpha, 16-bit samples, EXIF and colour metadata stay intact.
Other formats/animations and unsupported PNG structures pass through unchanged.
"""
from collections import OrderedDict
from threading import Lock
import hashlib
import struct
import zlib


MIN_INPUT_BYTES = 64 * 1024
MAX_INPUT_BYTES = 32 * 1024 * 1024
MAX_DECOMPRESSED_BYTES = 128 * 1024 * 1024
_SIGNATURE = b"\x89PNG\r\n\x1a\n"
_BLOCK = 64 * 1024
# These ancillary chunks may safely be preserved across a lossless IDAT change.
_KNOWN_CHUNKS = {b"IHDR", b"PLTE", b"IDAT", b"IEND", b"cHRM", b"gAMA",
                 b"iCCP", b"sBIT", b"sRGB", b"bKGD", b"hIST", b"tRNS",
                 b"pHYs", b"sPLT", b"tIME", b"iTXt", b"tEXt", b"zTXt", b"eXIf"}


class _ImageCache:
    """Bound retained bytes AND entries, including negative compression results."""
    def __init__(self, max_bytes=32 * 1024 * 1024, max_entries=128):
        self.max_bytes, self.max_entries = max_bytes, max_entries
        self.entries = OrderedDict()
        self.size = 0
        self.lock = Lock()

    def get(self, key):
        with self.lock:
            value = self.entries.get(key)
            if value is not None:
                self.entries.move_to_end(key)
            return value

    def put(self, key, value):
        with self.lock:
            if len(value) > self.max_bytes or self.max_entries < 1:
                return
            previous = self.entries.pop(key, b"")
            self.size += len(value) - len(previous)
            self.entries[key] = value
            while self.size > self.max_bytes or len(self.entries) > self.max_entries:
                _, removed = self.entries.popitem(last=False)
                self.size -= len(removed)

    def clear(self):
        with self.lock:
            self.entries.clear()
            self.size = 0


_cache = _ImageCache()


def _recompress_png(data):
    """Return original bytes on any unsupported structure; bound inflate work."""
    offset, idat_start, idat_end = 8, None, None
    idat_parts = []
    expected = None
    ended = False
    for _ in range(4096):
        if offset + 12 > len(data):
            return data
        length = struct.unpack_from(">I", data, offset)[0]
        end = offset + 12 + length
        if end > len(data):
            return data
        kind = data[offset + 4:offset + 8]
        chunk = memoryview(data)[offset + 8:end - 4]
        crc = zlib.crc32(chunk, zlib.crc32(kind)) & 0xffffffff
        if crc != struct.unpack_from(">I", data, end - 4)[0]:
            return data
        if kind in {b"acTL", b"fcTL", b"fdAT"}:
            return data  # Never flatten or re-encode animated PNGs.
        if kind not in _KNOWN_CHUNKS and not (kind[0] & 32 and kind[3] & 32):
            return data  # Unknown critical or unsafe-to-copy ancillary chunk.
        if offset == 8:
            if kind != b"IHDR" or length != 13:
                return data
            width, height, depth, colour, compression, filtering, interlace = struct.unpack(">IIBBBBB", chunk)
            channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}.get(colour)
            depths = {0: {1, 2, 4, 8, 16}, 2: {8, 16}, 3: {1, 2, 4, 8}, 4: {8, 16}, 6: {8, 16}}
            if not channels or depth not in depths[colour] or not width or not height or compression or filtering or interlace:
                return data
            expected = ((width * channels * depth + 7) // 8 + 1) * height
            if expected > MAX_DECOMPRESSED_BYTES:
                return data
        elif kind == b"IHDR":
            return data
        if kind == b"IDAT":
            if idat_end is not None and offset != idat_end:
                return data  # Only the standard contiguous IDAT sequence.
            if idat_start is None:
                idat_start = offset
            idat_end = end
            idat_parts.append(chunk)
        if kind == b"IEND":
            ended = length == 0 and end == len(data)
            break
        offset = end
    if not ended or idat_start is None:
        return data

    header = bytearray()
    for part in idat_parts:
        header.extend(part[:2 - len(header)])
        if len(header) == 2:
            break
    if len(header) != 2 or header[1] >> 6 >= 2:
        # FLEVEL is only a hint, not a promise of optimal compression. Skip
        # normal/max encodings conservatively rather than spending CPU on
        # already compressed photos. The fallback is always the original.
        return data
    # A fast deflate level captures most savings without adding a long local
    # preparation phase. No PNG filtering, decoding or colour conversion.
    inflater, deflater = zlib.decompressobj(), zlib.compressobj(level=2)
    compressed, inflated = bytearray(), 0
    for part in idat_parts:
        pending = part
        while pending:
            # One extra byte detects data exceeding IHDR without allocating it.
            raw = inflater.decompress(pending, min(_BLOCK, expected - inflated + 1))
            inflated += len(raw)
            if inflated > expected or inflater.unused_data:
                return data
            compressed.extend(deflater.compress(raw))
            if len(compressed) >= idat_end - idat_start:
                return data
            pending = inflater.unconsumed_tail
    if not inflater.eof or inflated != expected:
        return data
    compressed.extend(deflater.flush())
    crc = zlib.crc32(compressed, zlib.crc32(b"IDAT")) & 0xffffffff
    replacement = struct.pack(">I", len(compressed)) + b"IDAT" + compressed + struct.pack(">I", crc)
    return data[:idat_start] + replacement + data[idat_end:]


def optimize_request_image(data: bytes, mime: str) -> bytes:
    """Best effort after the caller's original-asset integrity checks.

    The cache is only an in-memory derivative: it cannot make a missing/changed
    frozen source valid. Callers must still read and verify their source first.
    """
    if mime != "image/png" or not MIN_INPUT_BYTES <= len(data) <= MAX_INPUT_BYTES or not data.startswith(_SIGNATURE):
        return data
    key = hashlib.sha256(data).digest()
    cached = _cache.get(key)
    if cached is not None:
        return cached or data
    try:
        candidate = _recompress_png(data)
    except (OSError, ValueError, OverflowError, struct.error, zlib.error):
        candidate = data
    savings = len(data) - len(candidate)
    if savings < 1024 or savings * 20 < len(data):
        candidate = data
    # Negative entries retain only a digest, never a second copy of a large PNG.
    _cache.put(key, candidate if candidate is not data else b"")
    return candidate
