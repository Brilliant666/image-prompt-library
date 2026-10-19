"""Bounded Images API SSE framing; no provider credentials or payload logging."""
from __future__ import annotations

import itertools
import json
import re

from backend.services.image_download import MAX_IMAGE_BYTES

MAX_IMAGE_JSON_BYTES = ((MAX_IMAGE_BYTES + 2) // 3) * 4 + 1024 * 1024
MAX_IMAGE_STREAM_BYTES = MAX_IMAGE_JSON_BYTES * 4
MAX_STREAM_EVENTS = 64


class ImageStreamError(ValueError):
    def __init__(self, category, message):
        super().__init__(message)
        self.category = category


def read_json_response(response):
    content = bytearray()
    for chunk in response.iter_bytes(chunk_size=65536):
        if len(content) + len(chunk) > MAX_IMAGE_JSON_BYTES:
            raise ImageStreamError("response_too_large", "Image API JSON exceeds the response size limit")
        content.extend(chunk)
    try:
        return json.loads(content)
    except (ValueError, UnicodeError):
        raise ImageStreamError("non_json_response", "Image API returned non-JSON content; check API address and gateway") from None


def _lines(response):
    """Accept LF, CRLF and CR across arbitrary HTTP/UTF-8 boundaries."""
    pending = bytearray()
    size = total = 0
    skip_lf = False
    # Do not coalesce into a fixed chunk size: small previews must be delivered
    # while the request is still open, not buffered until completion or 64 KiB.
    for chunk in response.iter_bytes():
        total += len(chunk)
        if total > MAX_IMAGE_STREAM_BYTES:
            raise ImageStreamError("response_too_large", "Image API stream exceeds the response size limit")
        if skip_lf and chunk.startswith(b"\n"):
            chunk = chunk[1:]
        skip_lf = False
        start = 0
        for match in re.finditer(rb"\r\n|\r|\n", chunk):
            part = chunk[start:match.start()]
            size += len(part)
            if size > MAX_IMAGE_JSON_BYTES:
                raise ImageStreamError("response_too_large", "Image API event exceeds the response size limit")
            pending.extend(part)
            try:
                yield pending.decode("utf-8")
            except UnicodeError:
                raise ImageStreamError("invalid_stream", "Image API stream contains invalid UTF-8") from None
            pending = bytearray()
            size = 0
            start = match.end()
            skip_lf = match.group() == b"\r" and start == len(chunk)
        part = chunk[start:]
        size += len(part)
        if size > MAX_IMAGE_JSON_BYTES:
            raise ImageStreamError("response_too_large", "Image API event exceeds the response size limit")
        pending.extend(part)
    if pending:
        try:
            yield pending.decode("utf-8")
        except UnicodeError:
            raise ImageStreamError("invalid_stream", "Image API stream contains invalid UTF-8") from None


def iter_image_events(response):
    data = []
    event = ""
    size = count = 0
    first_line = True
    # Flush a complete JSON event at EOF even when a gateway omits the last blank line.
    for line in itertools.chain(_lines(response), [""]):
        if first_line:
            line = line.removeprefix("\ufeff")
            first_line = False
        if not line:
            if data:
                count += 1
                if count > MAX_STREAM_EVENTS:
                    raise ImageStreamError("invalid_stream", "Image API stream has too many events")
                raw = "\n".join(data)
                if raw == "[DONE]":
                    return
                try:
                    value = json.loads(raw)
                except (ValueError, UnicodeError):
                    raise ImageStreamError("invalid_stream", "Image API stream contains invalid JSON") from None
                if not isinstance(value, dict):
                    raise ImageStreamError("invalid_stream", "Image API events must be JSON objects")
                yield event or value.get("type", ""), value
            data, event, size = [], "", 0
        elif not line.startswith(":"):
            field, separator, value = line.partition(":")
            if separator and value.startswith(" "):
                value = value[1:]
            size += len(line.encode("utf-8"))
            if size > MAX_IMAGE_JSON_BYTES:
                raise ImageStreamError("response_too_large", "Image API event exceeds the response size limit")
            if field == "event":
                event = value
            elif field == "data":
                data.append(value)
