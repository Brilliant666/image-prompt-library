from io import BytesIO

from fastapi.testclient import TestClient
from PIL import Image
import pytest

from backend.main import create_app


@pytest.mark.parametrize("format", ["PNG", "WEBP"])
def test_transparent_generation_survives_staging_acceptance_and_restart(tmp_path, format):
    library = tmp_path / "library"
    source = Image.new("RGBA", (64, 32), (20, 100, 200, 255))
    source.paste((0, 0, 0, 0), (0, 0, 32, 32))
    output = BytesIO()
    source.save(output, format)
    data = output.getvalue()
    with TestClient(create_app(library_path=library)) as client:
        created = client.post("/api/generation-jobs", json={
            "provider": "manual_upload", "prompt_text": "A transparent object",
        })
        assert created.status_code == 200
        job_id = created.json()["id"]
        staged = client.post(f"/api/generation-jobs/{job_id}/result", files={
            "file": (f"generated.{format.lower()}", data, f"image/{format.lower()}"),
        })
        assert staged.status_code == 200
        assert client.get(f"/media/{staged.json()['result_path']}").content == data
        accepted = client.post(f"/api/generation-jobs/{job_id}/accept-as-new-item")
        assert accepted.status_code == 200
        item_id = accepted.json()["item"]["id"]

    with TestClient(create_app(library_path=library)) as client:
        record = client.get(f"/api/items/{item_id}").json()["images"][0]
        assert client.get(f"/media/{record['original_path']}").content == data
        for name in ["thumb_path", "preview_path"]:
            response = client.get(f"/media/{record[name]}")
            assert response.status_code == 200
            with Image.open(BytesIO(response.content)) as derivative:
                alpha = derivative.getchannel("A")
                assert alpha.getpixel((8, 8)) == 0
                assert alpha.getpixel((56, 8)) == 255
