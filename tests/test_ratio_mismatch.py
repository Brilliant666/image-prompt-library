"""Dimension diagnostics use decoded pixels, never service-reported size."""
import base64
from io import BytesIO

import httpx
from PIL import Image
import pytest

from backend.services.openai_compatible import (
    ASPECT_RATIO_RELATIVE_TOLERANCE, image_dimension_mismatches,
    OpenAICompatibleConfig, OpenAICompatibleProvider,
)


@pytest.mark.parametrize("size,ratio,width,height,expected", [
    ("auto", "9:16", 1024, 1024, [("requested_aspect_ratio", "output_mismatch")]),
    ("auto", "9:16", 900, 1600, []),
    ("auto", "9:16", 941, 1672, []),  # integer rounding is comfortably within 1%
    ("auto", "9:16", 910, 1600, [("requested_aspect_ratio", "output_mismatch")]),
    ("auto", "auto", 1024, 1024, []),
    ("auto", "0:16", 1024, 1024, []),
    ("900x1600", "9:16", 900, 1600, []),
    ("900x1600", "9:16", 1024, 1024, [("size", None)]),
    ("1024x1024", "9:16", 1024, 1024, [("requested_aspect_ratio", "request_settings_conflict")]),
    ("1024x1024", "9:16", 900, 1600, [("requested_aspect_ratio", "request_settings_conflict"), ("size", None)]),
    ("auto", "9:16", None, None, []),
])
def test_dimension_semantics(size, ratio, width, height, expected):
    assert ASPECT_RATIO_RELATIVE_TOLERANCE == 0.01
    issues = image_dimension_mismatches({"size": size, "requested_aspect_ratio": ratio}, {"width": width, "height": height})
    assert [(issue["field"], issue.get("kind")) for issue in issues] == expected


@pytest.mark.parametrize("dimensions,warn", [((1024, 1024), True), ((900, 1600), False), ((941, 1672), False)])
def test_mock_provider_records_decoded_ratio_and_preserves_original(tmp_path, dimensions, warn):
    config = OpenAICompatibleConfig(tmp_path / "provider.json", tmp_path / "library")
    config.save({"base_url": "https://example.invalid/v1", "api_key": "test-only", "model": "gpt-image-2.5-flare"})
    output = BytesIO()
    Image.new("RGBA", dimensions, (10, 20, 30, 255)).save(output, "PNG")
    original = output.getvalue()
    calls = []
    def respond(request):
        calls.append(request)
        return httpx.Response(200, json={"size": "900x1600", "quality": "medium", "data": [{"b64_json": base64.b64encode(original).decode()}]})
    with httpx.Client(transport=httpx.MockTransport(respond)) as client:
        data, _, metadata = OpenAICompatibleProvider(config, client).generate("Synthetic fixture", {
            "size": "auto", "requested_aspect_ratio": "9:16", "aspect_ratio_prompt_injection": True,
            "quality": "max", "background": "transparent", "output_format": "webp",
        })
    assert len(calls) == 1
    assert data == original  # no crop, resize, regeneration, or re-encoding
    assert (metadata["decoded_image"]["width"], metadata["decoded_image"]["height"]) == dimensions
    assert metadata["response"]["size"] == "900x1600"
    fields = [issue["field"] for issue in metadata["mismatches"]]
    assert ("requested_aspect_ratio" in fields) == warn
    assert {"output_format", "background", "quality"} <= set(fields)
