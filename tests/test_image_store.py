from io import BytesIO
from pathlib import Path
from PIL import Image
import pytest
from backend.services.image_store import store_image


def png_bytes(size=(320, 200), color=(120, 40, 220)):
    buf = BytesIO()
    Image.new("RGB", size, color).save(buf, format="PNG")
    return buf.getvalue()


def test_store_image_creates_original_thumb_and_preview(tmp_path: Path):
    record = store_image(tmp_path / "library", png_bytes(), "sample.png")
    assert record.width == 320
    assert record.height == 200
    assert len(record.file_sha256) == 64
    assert (tmp_path / "library" / record.original_path).exists()
    assert (tmp_path / "library" / record.thumb_path).exists()
    assert (tmp_path / "library" / record.preview_path).exists()
    with Image.open(tmp_path / "library" / record.thumb_path) as thumb:
        assert max(thumb.size) <= 420


def test_store_image_repairs_corrupt_existing_original_without_file_digest(tmp_path: Path, monkeypatch):
    library = tmp_path / "library"
    data = png_bytes()
    monkeypatch.delattr("hashlib.file_digest", raising=False)
    first = store_image(library, data, "sample.png")
    original = library / first.original_path
    original.write_bytes(b"truncated")

    second = store_image(library, data, "sample.png")

    assert second.original_path == first.original_path
    assert original.read_bytes() == data


def test_store_image_rejects_too_many_pixels(tmp_path: Path):
    data = png_bytes(size=(5000, 5000))
    try:
        store_image(tmp_path / "library", data, "huge.png")
    except ValueError as exc:
        assert "too large" in str(exc)
    else:
        raise AssertionError("expected oversized image to be rejected")


@pytest.mark.parametrize("mode", ["RGBA", "LA", "P", "RGB"])
def test_store_image_preserves_transparency_and_original_bytes(tmp_path: Path, mode):
    if mode == "P":
        source = Image.new("P", (1600, 800), 1)
        source.putpalette([0, 0, 0, 120, 40, 220] + [0] * 762)
        source.paste(0, (0, 0, 800, 800))
        source.info["transparency"] = bytes([0, 255])
    elif mode == "RGB":
        # RGB PNG can also encode transparency without an explicit alpha band.
        source = Image.new("RGB", (1600, 800), (120, 40, 220))
        source.paste((0, 0, 0), (0, 0, 800, 800))
        source.info["transparency"] = (0, 0, 0)
    else:
        source = Image.new(mode, (1600, 800), (120, 40, 220, 255) if mode == "RGBA" else (120, 255))
        source.paste((0, 0, 0, 0) if mode == "RGBA" else (0, 0), (0, 0, 800, 800))
    output = BytesIO()
    source.save(output, "PNG")
    data = output.getvalue()
    stored = store_image(tmp_path, data, "transparent.png")
    assert (tmp_path / stored.original_path).read_bytes() == data
    for relative, expected_size in [(stored.thumb_path, (420, 210)), (stored.preview_path, (1400, 700))]:
        with Image.open(tmp_path / relative) as derivative:
            assert derivative.format == "WEBP"
            assert derivative.size == expected_size
            assert "A" in derivative.getbands()
            alpha = derivative.getchannel("A")
            assert alpha.getpixel((10, 10)) == 0
            assert alpha.getpixel((derivative.width - 10, 10)) == 255


def test_store_image_keeps_opaque_derivatives_rgb(tmp_path: Path):
    data = png_bytes()
    stored = store_image(tmp_path, data)
    assert (tmp_path / stored.original_path).read_bytes() == data
    for relative in [stored.thumb_path, stored.preview_path]:
        with Image.open(tmp_path / relative) as derivative:
            assert derivative.mode == "RGB"
            assert derivative.size == (320, 200)
