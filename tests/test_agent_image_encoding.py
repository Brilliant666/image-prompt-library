"""Lossless request copies use synthetic images and never contact a provider."""
import base64
import hashlib
import json
import os
import struct
import zlib
from io import BytesIO

import httpx
import pytest
from PIL import Image, PngImagePlugin

from backend.agent_schemas import AgentRoundCreate
from backend.db import connect
from backend.services import agent_execution as execution
from backend.services import agent_image_encoding as encoding
from backend.services.agent_image_retry import AgentImageRetryCreate, AgentImageRetryRepository
from backend.services.agent_repository import AgentError
from backend.services.generation_queue import _run_provider_job
from test_agent_context_correctness import add_round, capture_request, pixels
from test_agent_execution_correctness import image_result, transport as native_transport
from test_agent_image_selection import body, repo, set_mode


@pytest.fixture(autouse=True)
def empty_encoding_cache():
    encoding._cache.clear()
    yield
    encoding._cache.clear()


def png_bytes(mode="RGB", color=20, *, size=(320, 240), compress_level=0):
    width, height = size
    if mode == "RGBA":
        raw = bytes(value for y in range(height) for x in range(width)
                    for value in (color, x % 256, y % 256, x % 256))
        image = Image.frombytes(mode, size, raw)
    elif mode == "P":
        image = Image.frombytes(mode, size, bytes((x + y + color) % 4
                                                for y in range(height) for x in range(width)))
        image.putpalette([value for index in range(256) for value in (index, 255 - index, index // 2)])
        image.info["transparency"] = bytes((0, 64, 128, 255))
    elif mode == "I;16":
        image = Image.frombytes(mode, size, b"".join(struct.pack("<H", (x * 257 + color) % 65536)
                                                     for _ in range(height) for x in range(width)))
    else:
        image = Image.new(mode, size, (color, 40, 200))
    metadata = PngImagePlugin.PngInfo()
    metadata.add(b"gAMA", struct.pack(">I", 45455))
    metadata.add_text("Description", "Synthetic metadata must survive request encoding.")
    exif = Image.Exif()
    exif[274] = 6
    output = BytesIO()
    image.save(output, "PNG", compress_level=compress_level, pnginfo=metadata,
               icc_profile=b"synthetic-profile-bytes" * 4, exif=exif, dpi=(144, 144))
    return output.getvalue()


def png_chunks(data):
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    offset = 8
    result = []
    while offset < len(data):
        length = struct.unpack(">I", data[offset:offset + 4])[0]
        chunk = data[offset:offset + length + 12]
        assert len(chunk) == length + 12
        assert zlib.crc32(chunk[4:-4]) & 0xFFFFFFFF == struct.unpack(">I", chunk[-4:])[0]
        result.append((chunk[4:8], chunk))
        offset += len(chunk)
    assert result[-1][0] == b"IEND"
    return result


def assert_same_png(original, transmitted):
    assert [chunk for kind, chunk in png_chunks(transmitted) if kind != b"IDAT"] == [
        chunk for kind, chunk in png_chunks(original) if kind != b"IDAT"]
    with Image.open(BytesIO(original)) as before, Image.open(BytesIO(transmitted)) as after:
        assert after.mode == before.mode
        assert after.size == before.size
        assert after.tobytes() == before.tobytes()
        assert after.getpalette() == before.getpalette()
        assert after.info == before.info
        assert after.getexif().get(274) == before.getexif().get(274) == 6


def decode_url(url):
    prefix, payload = url.split(",", 1)
    assert prefix == "data:image/png;base64"
    return base64.b64decode(payload, validate=True)


@pytest.mark.parametrize("mode", ["RGB", "RGBA", "P", "I;16"])
def test_png_pixels_alpha_palette_precision_and_metadata_are_preserved(mode):
    original = png_bytes(mode)
    assert len(original) >= 65536
    transmitted = encoding.optimize_request_image(original, "image/png")
    assert len(transmitted) < len(original) * 0.5
    assert_same_png(original, transmitted)


def test_actual_request_compresses_selected_refs_without_changing_order_or_originals(repo, monkeypatch):
    originals = [png_bytes(color=20), png_bytes("RGBA", color=60)]
    assets = [repo.store_asset(raw, None)["id"] for raw in originals]
    paths = [repo.library / repo.asset(aid)["path"] for aid in assets]
    root = add_round(repo, "older", "The first image supplies the lighting.", assets=assets[:1])
    add_round(repo, "current", "Compare both images and keep their lighting.", parent=root, assets=assets[1:])
    history = repo.request("current")["history"]
    payload = capture_request(repo, monkeypatch, "current")
    transmitted = [decode_url(url) for url in pixels(payload)]
    assert len(transmitted) == 2
    for original, wire, aid, path in zip(originals, transmitted, assets, paths):
        assert len(wire) < len(original) * 0.5
        assert_same_png(original, wire)
        assert path.read_bytes() == original
        assert repo.asset(aid)["sha256"] == hashlib.sha256(original).hexdigest()
    ref_tags = [part["text"] for item in payload["input"] for part in item.get("content", [])
                if part["type"] == "input_text" and part["text"].startswith('<ref id="')]
    assert ref_tags == ['<ref id="round-1-reference-1" />', '<ref id="round-2-reference-1" />']
    assert repo.request("current")["history"] == history


def test_actual_mask_request_preserves_alpha_and_puts_the_bound_target_first(repo, monkeypatch):
    set_mode(repo, "native")
    auxiliary, target, mask = png_bytes(color=10), png_bytes(color=80), png_bytes("RGBA", color=0)
    auxiliary_id, target_id = [repo.store_asset(raw, None)["id"] for raw in (auxiliary, target)]
    mask_id = repo.store_asset(mask, None, "mask")["id"]
    values = body(repo, "masked").model_dump()
    values.update(refs=[{"kind": "upload", "uploadId": auxiliary_id}, {"kind": "upload", "uploadId": target_id}],
                  mask={"uploadId": mask_id, "targetRefIndex": 1})
    repo.create_round("conversation", AgentRoundCreate.model_validate(values))
    payload = capture_request(repo, monkeypatch, "masked")
    transmitted = [decode_url(url) for url in pixels(payload)]
    assert len(transmitted) == 3
    for original, wire in zip((target, auxiliary, target), transmitted):
        assert_same_png(original, wire)
    tool = next(item for item in payload["tools"] if item["type"] == "image_generation")
    wire_mask = decode_url(tool["input_image_mask"]["image_url"])
    assert len(wire_mask) < len(mask) * 0.5
    assert_same_png(mask, wire_mask)
    assert repo.request("masked")["round"]["maskTargetImageId"] == target_id
    for aid, original in ((auxiliary_id, auxiliary), (target_id, target), (mask_id, mask)):
        assert (repo.library / repo.asset(aid)["path"]).read_bytes() == original


@pytest.mark.parametrize("change", ["tamper", "delete"])
def test_warm_cache_cannot_hide_changed_or_missing_source_before_post(repo, monkeypatch, change):
    original = png_bytes(color=20)
    asset_id = repo.store_asset(original, None)["id"]
    add_round(repo, "current", "Analyze @图1", assets=[asset_id])
    assert len(decode_url(repo.data_url(asset_id))) < len(original)
    path = repo.library / repo.asset(asset_id)["path"]
    if change == "tamper":
        stat = path.stat()
        changed = png_bytes(color=21)
        assert len(changed) == len(original)
        path.write_bytes(changed)
        os.utime(path, ns=(stat.st_atime_ns, stat.st_mtime_ns))
    else:
        path.unlink()
    posts = []
    def respond(request):
        posts.append(request)
        return httpx.Response(200, json={"id": "unexpected", "status": "completed", "output": []})
    monkeypatch.setattr(httpx, "HTTPTransport", lambda **kwargs: httpx.MockTransport(respond))
    repo.update("current", state="running", outcome="known")
    request = repo.request("current")
    with pytest.raises(AgentError) as error:
        execution.call_responses(repo, "current", 1, execution.refs_for_request(repo, request))
    assert error.value.code == ("frozen_reference_invalid" if change == "tamper" else "reference_missing")
    assert posts == []


def test_animated_png_is_passed_through_byte_for_byte():
    first, second = Image.new("RGBA", (320, 240), "red"), Image.new("RGBA", (320, 240), "blue")
    output = BytesIO()
    first.save(output, "PNG", save_all=True, append_images=[second], duration=[100, 200], loop=3, compress_level=0)
    original = output.getvalue()
    assert len(original) > 65536
    with Image.open(BytesIO(original)) as image:
        assert image.n_frames == 2
    assert encoding.optimize_request_image(original, "image/png") == original


@pytest.mark.parametrize(("file_format", "mime"), [("JPEG", "image/jpeg"), ("GIF", "image/gif"), ("BMP", "image/bmp")])
def test_non_png_is_never_reencoded(monkeypatch, file_format, mime):
    output = BytesIO()
    Image.new("RGB", (320, 240), "orange").save(output, file_format)
    original = output.getvalue()
    monkeypatch.setattr(encoding, "MIN_INPUT_BYTES", 0)
    calls = []
    monkeypatch.setattr(encoding, "_recompress_png", lambda data: calls.append(data) or data)
    assert encoding.optimize_request_image(original, mime) == original
    assert calls == []


@pytest.mark.parametrize("limit", ["MIN_INPUT_BYTES", "MAX_INPUT_BYTES"])
def test_input_bounds_skip_compression_before_work(monkeypatch, limit):
    original = png_bytes()
    monkeypatch.setattr(encoding, limit, len(original) + (1 if limit == "MIN_INPUT_BYTES" else -1))
    calls = []
    monkeypatch.setattr(encoding, "_recompress_png", lambda data: calls.append(data) or data)
    assert encoding.optimize_request_image(original, "image/png") == original
    assert calls == []


def test_decompressed_limit_falls_back_without_truncating_image(monkeypatch):
    original = png_bytes()
    compressed_scanlines = b"".join(chunk[8:-4] for kind, chunk in png_chunks(original) if kind == b"IDAT")
    inflated_size = len(zlib.decompress(compressed_scanlines))
    monkeypatch.setattr(encoding, "MAX_DECOMPRESSED_BYTES", inflated_size - 1)
    assert encoding.optimize_request_image(original, "image/png") == original
    encoding._cache.clear()
    monkeypatch.setattr(encoding, "MAX_DECOMPRESSED_BYTES", inflated_size)
    result = encoding.optimize_request_image(original, "image/png")
    assert len(result) < len(original)
    assert_same_png(original, result)


@pytest.mark.parametrize("failure", [OSError("synthetic"), ValueError("synthetic"), zlib.error("synthetic")])
def test_encoder_error_uses_original_valid_bytes(monkeypatch, failure):
    original = png_bytes()
    def fail(data):
        raise failure
    monkeypatch.setattr(encoding, "_recompress_png", fail)
    assert encoding.optimize_request_image(original, "image/png") == original


@pytest.mark.parametrize("damage", ["crc", "truncated", "chunk_length"])
def test_malformed_png_falls_back_without_partial_result(damage):
    original = png_bytes()
    if damage == "crc":
        corrupted = bytearray(original)
        corrupted[original.index(b"IDAT") + 4] ^= 1
        original = bytes(corrupted)
    elif damage == "truncated":
        original = original[:-7]
    else:
        original = original[:8] + struct.pack(">I", 0xFFFFFFFF) + original[12:]
    assert encoding.optimize_request_image(original, "image/png") == original


def test_tiny_potential_savings_do_not_replace_original(monkeypatch):
    original = png_bytes(size=(12, 12))
    monkeypatch.setattr(encoding, "MIN_INPUT_BYTES", 0)
    assert encoding.optimize_request_image(original, "image/png") == original


def make_png_chunk(kind, payload):
    return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)


def pad_png_to_length(data, length):
    payload = b"Padding\x00" + b"." * (length - len(data) - 20)
    assert len(payload) >= 8
    result = data[:-12] + make_png_chunk(b"tEXt", payload) + data[-12:]
    assert len(result) == length
    return result


@pytest.mark.parametrize("extra_byte", [0, 1])
def test_exact_five_percent_savings_is_accepted_but_fraction_below_is_not(extra_byte):
    original = png_bytes(size=(64, 64))
    candidate = encoding._recompress_png(original)
    savings = len(original) - len(candidate)
    assert savings >= 1024
    # Preserved text changes the total size without changing IDAT's savings.
    original = pad_png_to_length(original, savings * 20 + extra_byte)
    candidate = encoding._recompress_png(original)
    assert len(original) - len(candidate) == savings
    result = encoding.optimize_request_image(original, "image/png")
    assert result == (original if extra_byte else candidate)
    assert_same_png(original, result)


@pytest.mark.parametrize("compress_level", [0, 1, 2, 6, 9])
@pytest.mark.parametrize("fragment_header", [False, True])
def test_normal_compression_presets_skip_inflate_even_with_fragmented_zlib_header(monkeypatch, compress_level, fragment_header):
    original = png_bytes(compress_level=compress_level)
    original = pad_png_to_length(original, len(original) + 65536)
    if fragment_header:
        chunks = png_chunks(original)
        compressed = b"".join(chunk[8:-4] for kind, chunk in chunks if kind == b"IDAT")
        replacement = (make_png_chunk(b"IDAT", b"") + make_png_chunk(b"IDAT", compressed[:1])
                       + make_png_chunk(b"IDAT", compressed[1:]))
        rebuilt, replaced = bytearray(original[:8]), False
        for kind, chunk in chunks:
            if kind == b"IDAT":
                if not replaced:
                    rebuilt.extend(replacement)
                    replaced = True
            else:
                rebuilt.extend(chunk)
        original = bytes(rebuilt)
    inflater = encoding.zlib.decompressobj
    calls = []
    def counted(*args, **kwargs):
        calls.append(True)
        return inflater(*args, **kwargs)
    monkeypatch.setattr(encoding.zlib, "decompressobj", counted)
    result = encoding.optimize_request_image(original, "image/png")
    assert calls == ([] if compress_level in (6, 9) else [True])
    if compress_level in (6, 9):
        assert result == original
    elif compress_level == 0:
        assert len(result) < len(original) * 0.5
    assert_same_png(original, result)


def spy_encoder(monkeypatch):
    original_encoder = encoding._recompress_png
    calls = []
    def counted(data):
        calls.append(hashlib.sha256(data).hexdigest())
        return original_encoder(data)
    monkeypatch.setattr(encoding, "_recompress_png", counted)
    return calls


def test_cache_reuses_content_and_evicts_least_recent_entry(monkeypatch):
    monkeypatch.setattr(encoding._cache, "max_entries", 2)
    calls = spy_encoder(monkeypatch)
    first, second, third = [png_bytes(color=color) for color in (10, 20, 30)]
    for original in (first, second, first, third, second):
        assert len(encoding.optimize_request_image(original, "image/png")) < len(original)
    assert calls == [hashlib.sha256(raw).hexdigest() for raw in (first, second, third, second)]


def test_cache_total_byte_limit_evicts_and_oversized_result_is_not_cached(monkeypatch):
    first, second = png_bytes(color=20), png_bytes("RGBA", color=30)
    results = [encoding._recompress_png(raw) for raw in (first, second)]
    monkeypatch.setattr(encoding._cache, "max_bytes", max(map(len, results)))
    calls = spy_encoder(monkeypatch)
    for original in (first, first, second, first):
        assert len(encoding.optimize_request_image(original, "image/png")) < len(original)
    assert len(calls) == 3
    encoding._cache.clear()
    calls.clear()
    monkeypatch.setattr(encoding._cache, "max_bytes", 1)
    for _ in range(2):
        assert len(encoding.optimize_request_image(first, "image/png")) < len(first)
    assert len(calls) == 2


def test_unchanged_cache_entries_do_not_escape_entry_bound(monkeypatch):
    monkeypatch.setattr(encoding._cache, "max_entries", 1)
    monkeypatch.setattr(encoding._cache, "max_bytes", 1)
    calls = []
    def unchanged(data):
        calls.append(data)
        return data
    monkeypatch.setattr(encoding, "_recompress_png", unchanged)
    first, second = png_bytes(color=20), png_bytes(color=30)
    for original in (first, first, second, first):
        assert encoding.optimize_request_image(original, "image/png") == original
    assert calls == [first, second, first]


def native_image_job(repo, *, batch, with_mask=False):
    set_mode(repo, "native")
    originals = [png_bytes(color=20), png_bytes("RGBA", color=80)]
    assets = [repo.store_asset(raw, None)["id"] for raw in originals]
    values = body(repo, "request").model_dump()
    values["refs"] = [{"kind": "upload", "uploadId": aid} for aid in assets]
    original_files = {repo.library / repo.asset(aid)["path"]: raw for aid, raw in zip(assets, originals)}
    mask = None
    if with_mask:
        mask = png_bytes("RGBA", color=0)
        mask_id = repo.store_asset(mask, None, "mask")["id"]
        values["mask"] = {"uploadId": mask_id, "targetRefIndex": 1}
        original_files[repo.library / repo.asset(mask_id)["path"]] = mask
    repo.create_round("conversation", AgentRoundCreate.model_validate(values))
    request = repo.request("request")
    refs = execution.refs_for_request(repo, request)
    reference_ids = ["round-1-reference-1", "round-1-reference-2"]
    snapshot = {"version": 1, "complete": True, "count": 2, "references": [
        {"ref": ref, "assetId": refs[ref], "path": repo.asset(refs[ref])["path"],
         "sha256": repo.asset(refs[ref])["sha256"]} for ref in reference_ids]}
    prompt = 'Blend <ref id="round-1-reference-1" /> with <ref id="round-1-reference-2" />.'
    job = execution.create_image_job(repo, "request", 1, "batch", "one" if batch else "single", prompt,
                                     refs, native=True, reference_ids=reference_ids, native_context=snapshot)
    metadata = {**job.metadata, "response": {"revised_prompt": prompt}}
    with connect(repo.library) as conn:
        conn.execute("UPDATE generation_jobs SET provider=?,metadata=? WHERE id=?",
                     ("agent_native_batch" if batch else "agent_native", json.dumps(metadata), job.id))
    return repo.jobs.get_job(job.id), originals, original_files, mask


def test_native_batch_compresses_outgoing_refs_and_duplicate_dispatch_never_posts(repo, monkeypatch):
    job, originals, original_files, _ = native_image_job(repo, batch=True)
    calls = native_transport(monkeypatch, payload={"id": "batch-response", "status": "completed",
                                                  "output": [image_result()]})
    result = execution.NativeAgentImageProvider().run_job(repo.library, job.id)
    assert result.status == "succeeded"
    assert len(calls) == 1
    transmitted = [decode_url(url) for url in pixels(calls[0])]
    assert len(transmitted) == len(originals)
    for original, wire in zip(originals, transmitted):
        assert len(wire) < len(original) * 0.5
        assert_same_png(original, wire)
    assert calls[0]["input"][0]["content"][0]["text"] == job.prompt_text
    with pytest.raises(AgentError):
        execution.NativeAgentImageProvider().run_job(repo.library, job.id)
    assert len(calls) == 1
    assert repo.jobs.get_job(job.id).status == "succeeded"
    assert all(path.read_bytes() == raw for path, raw in original_files.items())


@pytest.mark.parametrize("source_kind", ["native", "native_batch", "native_mask"])
def test_native_retry_compresses_refs_and_mask_without_rewriting_sources_or_reposting(repo, monkeypatch, source_kind):
    original_job, originals, original_files, mask = native_image_job(
        repo, batch=source_kind == "native_batch", with_mask=source_kind == "native_mask")
    repo.jobs.mark_failed(original_job.id, "Synthetic quota", diagnostics={"http_status": 402,
                                                                          "error": {"code": "insufficient_quota"}})
    repo.update("request", state="failed", outcome="known", error={"code": "image_job_failed", "message": "Synthetic quota"})
    retry_body = AgentImageRetryCreate(retryId="encoding-retry", conversationId="conversation",
        configRevision=repo.config()["revision"], imageConfig={"profileId": None, "model": "gpt-image-agent"},
        params={"size": "1024x1024", "quality": "auto", "output_format": "png"}, confirmed=True)
    retries = AgentImageRetryRepository(repo.library)
    receipt, created = retries.create(original_job.id, retry_body)
    assert created
    retry = receipt["job"]
    assert retry.provider == "agent_native_batch"
    for spec, raw in zip(retry.parameters["input_images"], originals):
        path = repo.library / spec["result_path"]
        assert path.read_bytes() == raw
        original_files[path] = raw
    calls = native_transport(monkeypatch, payload={"id": "retry-response", "status": "completed",
                                                  "output": [image_result()]})
    assert _run_provider_job(repo.library, retry.id, retry.provider).status == "succeeded"
    assert len(calls) == 1
    transmitted = [decode_url(url) for url in pixels(calls[0])]
    expected = list(reversed(originals)) if mask else originals
    assert len(transmitted) == len(expected)
    for original, wire in zip(expected, transmitted):
        assert len(wire) < len(original) * 0.5
        assert_same_png(original, wire)
    assert calls[0]["input"][0]["content"][0]["text"] == original_job.prompt_text
    assert calls[0]["tool_choice"] == {"type": "image_generation"}
    assert calls[0]["max_tool_calls"] == 1
    if mask:
        wire_mask = decode_url(calls[0]["tools"][0]["input_image_mask"]["image_url"])
        assert len(wire_mask) < len(mask) * 0.5
        assert_same_png(mask, wire_mask)
    assert _run_provider_job(repo.library, retry.id, retry.provider).status == "succeeded"
    repeated, created_again = retries.create(original_job.id, retry_body)
    assert not created_again and repeated["job"].id == retry.id
    assert len(calls) == 1
    assert repo.jobs.get_job(original_job.id).status == "failed"
    assert all(path.read_bytes() == raw for path, raw in original_files.items())
