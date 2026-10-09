"""Opt-in image API provider. Secrets live outside the asset library."""
from __future__ import annotations

import base64
import json
import os
import tempfile
from io import BytesIO
from pathlib import Path
from threading import Lock
from urllib.parse import urlsplit, urlunsplit

import httpx
from PIL import Image

from backend.config import resolve_openai_compatible_config_path
from backend.services.generation_jobs import GenerationJobConflict, GenerationJobRepository, resolve_generation_input_image_path
from backend.services.image_store import MAX_IMAGE_PIXELS

PROVIDER_ID = "openai_compatible"
AUTH_MODE = "api_key"
MAX_INPUT_IMAGES = 4
ASPECT_RATIO_SIZES = {
    "auto": "auto", "1:1": "1024x1024", "3:4": "864x1152",
    "9:16": "720x1280", "4:3": "1152x864", "16:9": "1280x720",
}
_config_lock = Lock()


class OpenAICompatibleError(RuntimeError):
    pass


def requested_image_size(parameters):
    # Older jobs retain their explicit size when retried unchanged.
    ratio = parameters.get("requested_aspect_ratio")
    if ratio is None:
        return str(parameters.get("size") or "auto")
    if ratio not in ASPECT_RATIO_SIZES:
        raise OpenAICompatibleError("Unsupported requested aspect ratio")
    return ASPECT_RATIO_SIZES[ratio]


def normalize_base_url(value: str) -> str:
    parts = urlsplit(str(value).strip())
    if parts.scheme not in {"http", "https"} or not parts.hostname or parts.username or parts.password or parts.query or parts.fragment:
        raise OpenAICompatibleError("Base URL must be an HTTP(S) address without credentials, query, or fragment")
    path = parts.path.rstrip("/")
    while path.endswith("/v1"):
        path = path[:-3]
    if "/images/" in path:
        raise OpenAICompatibleError("Base URL must not contain an image endpoint")
    return urlunsplit((parts.scheme, parts.netloc, path + "/v1", "", ""))


class OpenAICompatibleConfig:
    def __init__(self, path=None, library_path=None):
        self.path = Path(path).expanduser() if path else resolve_openai_compatible_config_path()
        self.library_path = library_path
        if library_path is not None:
            self.validate_path(library_path)

    def validate_path(self, library_path):
        if self.path.resolve().is_relative_to(Path(library_path).expanduser().resolve()):
            raise OpenAICompatibleError("Provider credentials must be outside the asset library")

    def read(self):
        defaults = {"display_name": "OpenAI compatible images", "base_url": "", "api_key": "", "model": "", "timeout": 300}
        try:
            if self.path.exists():
                value = json.loads(self.path.read_text(encoding="utf-8"))
                if not isinstance(value, dict):
                    raise ValueError()
                defaults.update({k: value[k] for k in defaults if k in value})
            if any(not isinstance(defaults[k], str) for k in ("display_name", "base_url", "api_key", "model")):
                raise ValueError()
            if not isinstance(defaults["timeout"], int) or not 1 <= defaults["timeout"] <= 1800:
                raise ValueError()
            return defaults
        except Exception:
            raise OpenAICompatibleError("Provider configuration could not be read") from None

    def public(self):
        value = self.read()
        present = bool(value.pop("api_key", ""))
        return {**value, "api_key_present": present}

    def save(self, payload, library_path=None):
        library = library_path if library_path is not None else self.library_path
        if library is None:
            raise OpenAICompatibleError("Active library path is required to save credentials")
        self.validate_path(library)
        with _config_lock:
            value = self.read()
            for field in ("display_name", "base_url", "model"):
                if field in payload:
                    value[field] = str(payload[field] or "").strip()
            value["base_url"] = normalize_base_url(value["base_url"])
            if not value["display_name"] or not value["model"]:
                raise OpenAICompatibleError("Display name and image model are required")
            try:
                value["timeout"] = int(payload.get("timeout", value["timeout"]))
                if not 1 <= value["timeout"] <= 1800:
                    raise ValueError()
            except (ValueError, TypeError):
                raise OpenAICompatibleError("Timeout must be between 1 and 1800 seconds") from None
            if payload.get("remove_api_key"):
                value["api_key"] = ""
            elif str(payload.get("api_key") or "").strip():
                value["api_key"] = str(payload["api_key"]).strip()
            self.path.parent.mkdir(parents=True, exist_ok=True)
            fd, name = tempfile.mkstemp(prefix="compatible-", suffix=".tmp", dir=self.path.parent)
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as stream:
                    json.dump(value, stream, ensure_ascii=False, indent=2)
                    stream.flush()
                    os.fsync(stream.fileno())
                Path(name).chmod(0o600)
                os.replace(name, self.path)
            except Exception:
                Path(name).unlink(missing_ok=True)
                raise OpenAICompatibleError("Provider configuration could not be saved") from None
        return self.public()

    def status(self):
        broken = False
        try:
            value = self.public()
            if value["base_url"]:
                normalize_base_url(value["base_url"])
        except OpenAICompatibleError:
            broken = True
            value = {"display_name": "OpenAI compatible images", "api_key_present": False, "base_url": "", "model": ""}
        ready = bool(value["api_key_present"] and value["base_url"] and value["model"])
        return {"provider": PROVIDER_ID, "display_name": value["display_name"], "auth_mode": AUTH_MODE,
                "optional": True, "configured": bool(value["base_url"]), "authenticated": value["api_key_present"],
                "available": ready, "state": "connected" if ready else "not_connected", "reason": None if ready else "not_configured",
                "status": "auth_error" if broken else ("ready" if ready else "login_required"), "message": "Provider configuration could not be read" if broken else (None if ready else "Configure image API settings first"),
                "can_generate": ready, "features": {"text_to_image": ready, "text_reference_to_image": ready, "image_edit": ready, "title_suggestion": False},
                "max_input_images": MAX_INPUT_IMAGES, "image_models": [value["model"]] if value["model"] else [],
                "default_image_model": value["model"], "model": value["model"], "api_key_present": value["api_key_present"]}


def _inspect_image(data):
    try:
        with Image.open(BytesIO(data)) as image:
            if image.width * image.height > MAX_IMAGE_PIXELS:
                raise ValueError()
            image.verify()
        with Image.open(BytesIO(data)) as image:
            image.load()
            if image.format not in {"PNG", "JPEG", "WEBP"}:
                raise ValueError()
            return image.format, image.width, image.height
    except Exception:
        raise OpenAICompatibleError("Image data could not be decoded safely") from None


class OpenAICompatibleProvider:
    def __init__(self, config=None, http_client=None):
        self.config = config or OpenAICompatibleConfig()
        self.http_client = http_client

    def _input_images(self, job, library_path):
        raw_images = (job.parameters or {}).get("input_images") or []
        if not raw_images:
            raw_images = [{"source": "library", "image_id": image_id} for image_id in getattr(job, "reference_image_ids", [])]
            if not raw_images:
                raw_images = [{"result_path": copy.get("copied_path")} for copy in (getattr(job, "metadata", {}) or {}).get("reference_image_copies", [])]
        if not isinstance(raw_images, list) or len(raw_images) > MAX_INPUT_IMAGES:
            raise OpenAICompatibleError("Invalid reference image list")
        images = []
        repo = GenerationJobRepository(library_path)
        for raw in raw_images:
            if not isinstance(raw, dict):
                raise OpenAICompatibleError("Invalid reference image")
            if raw.get("source") == "library" and raw.get("image_id"):
                if raw.get("result_path"):
                    path, mime = resolve_generation_input_image_path(library_path, raw["result_path"], allowed_roots={"generation-references"})
                else:
                    _, path, mime = repo.resolve_library_reference(raw["image_id"])
                data = path.read_bytes()
            elif raw.get("data_url"):
                header, _, encoded = raw["data_url"].partition(",")
                if not header.startswith("data:image/") or ";base64" not in header:
                    raise OpenAICompatibleError("Invalid reference image data")
                data = base64.b64decode(encoded, validate=True)
            elif raw.get("result_path"):
                path, mime = resolve_generation_input_image_path(library_path, raw["result_path"])
                data = path.read_bytes()
            else:
                raise OpenAICompatibleError("Missing reference image")
            fmt, _, _ = _inspect_image(data)
            ext = {"PNG": "png", "JPEG": "jpg", "WEBP": "webp"}[fmt]
            images.append((f"reference-{len(images) + 1}.{ext}", data, Image.MIME[fmt]))
        return images

    def generate(self, prompt, parameters, input_images=None):
        settings = self.config.read()
        if not settings["api_key"]:
            raise OpenAICompatibleError("Image API key is missing")
        model = parameters.get("model") or settings["model"]
        if not isinstance(model, str) or not model.strip():
            raise OpenAICompatibleError("Image model is required")
        payload = {"model": model.strip(), "prompt": prompt, "n": 1,
                   "size": requested_image_size(parameters), "quality": str(parameters.get("quality") or "low")}
        if parameters.get("output_format"):
            payload["output_format"] = str(parameters["output_format"])
        inputs = input_images or []
        endpoint = "/images/edits" if inputs else "/images/generations"
        client = self.http_client or httpx.Client(timeout=settings["timeout"], follow_redirects=False, transport=httpx.HTTPTransport(retries=0))
        try:
            kwargs = {"data": {k: str(v) for k, v in payload.items()}, "files": [("image[]", item) for item in inputs]} if inputs else {"json": payload}
            response = client.post(normalize_base_url(settings["base_url"]) + endpoint,
                                   headers={"Authorization": "Bearer " + settings["api_key"], "Accept": "application/json"},
                                   timeout=settings["timeout"], follow_redirects=False, **kwargs)
        except Exception:
            raise OpenAICompatibleError("Image API request failed or timed out; no automatic retry was attempted") from None
        finally:
            if self.http_client is None:
                client.close()
        if response.status_code != 200:
            raise OpenAICompatibleError(f"Image API returned HTTP {response.status_code}; no automatic retry was attempted")
        try:
            body = response.json()
            if not isinstance(body, dict) or not isinstance(body.get("data"), list) or len(body["data"]) != 1 or not isinstance(body["data"][0], dict):
                raise ValueError()
            first = body["data"][0]
            encoded = first.get("b64_json")
            if not isinstance(encoded, str) or not encoded:
                raise ValueError()
            data = base64.b64decode(encoded, validate=True)
            fmt, width, height = _inspect_image(data)
            # Only explicitly returned values belong to response metadata.
            actual = {key: first.get(key) or body.get(key) for key in ("model", "size", "generation_id")}
            actual = {key: value.strip() if isinstance(value, str) and value.strip() else None for key, value in actual.items()}
            actual.update({key: body.get(key) for key in ("quality", "output_format", "usage")})
            # Defensive redaction if a misbehaving upstream echoes credentials.
            serialized = json.dumps(actual, ensure_ascii=False).replace(settings["api_key"], "[REDACTED]")
            actual = json.loads(serialized)
        except Exception:
            raise OpenAICompatibleError("Image API returned no valid decodable base64 image; URL-only responses are not supported") from None
        requested = {k: v for k, v in payload.items() if k != "prompt"}
        if "requested_aspect_ratio" in parameters:
            requested["requested_aspect_ratio"] = parameters["requested_aspect_ratio"]
        metadata = {"provider": PROVIDER_ID, "auth_mode": AUTH_MODE, "requested": requested, "response": actual,
                    "model": actual.get("model"), "image_model": actual.get("model"), "decoded_image": {"width": width, "height": height, "format": fmt},
                    "mode": "image_edit" if inputs else "text_to_image", "input_image_count": len(inputs)}
        extension = {"PNG": "png", "JPEG": "jpg", "WEBP": "webp"}[fmt]
        return data, "openai-compatible." + extension, metadata

    def run_job(self, library_path, job_id):
        repo = GenerationJobRepository(library_path)
        job = repo.get_job(job_id)
        if job.provider != PROVIDER_ID:
            raise GenerationJobConflict("Generation job provider must be openai_compatible")
        if job.status == "succeeded":
            return job
        if job.status != "queued":
            raise GenerationJobConflict("Generation job must be queued; failed paid jobs require explicit resubmission")
        repo.mark_running(job_id)
        try:
            self.config.validate_path(library_path)
            prompt = (job.edited_prompt_text or job.prompt_text or "").strip()
            if not prompt:
                raise OpenAICompatibleError("Generation prompt is required")
            inputs = self._input_images(job, Path(library_path))
            if getattr(job, "mode", "text_to_image") in {"image_edit", "text_reference_to_image"} and not inputs:
                raise OpenAICompatibleError("This generation mode requires a reference image")
            parameters = dict(job.parameters or {})
            if getattr(job, "model", None):
                parameters["model"] = job.model
            data, filename, metadata = self.generate(prompt, parameters, inputs)
            metadata["source_job_id"] = job_id
            return repo.stage_result(job_id, data, filename, metadata)
        except Exception as exc:
            message = str(exc) if isinstance(exc, OpenAICompatibleError) else "Compatible image generation failed; no automatic retry was attempted"
            repo.mark_failed(job_id, message)
            raise OpenAICompatibleError(message) from None
