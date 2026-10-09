"""Opt-in image API provider. Secrets live outside the asset library."""
from __future__ import annotations

import base64
import json
import os
import re
import tempfile
import time
from datetime import datetime, timezone
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
IMAGE_25_MODELS = tuple(f"gpt-image-2.5-{variant}{snapshot}" for variant in ("flare", "sunburst") for snapshot in ("", "-2026-09-08"))


class OpenAICompatibleError(RuntimeError):
    def __init__(self, message, diagnostics=None):
        super().__init__(message)
        self.diagnostics = diagnostics or {"category": "local_validation"}


def requested_image_size(parameters):
    # Explicit pixels (including auto) and frozen historical values always win.
    if parameters.get("size") is not None:
        return str(parameters["size"])
    ratio = parameters.get("requested_aspect_ratio")
    if ratio is None:
        return str(parameters.get("size") or "auto")
    if ratio not in ASPECT_RATIO_SIZES:
        raise OpenAICompatibleError("Unsupported requested aspect ratio")
    return ASPECT_RATIO_SIZES[ratio]


def normalize_image_parameters(parameters, default_model=""):
    result = dict(parameters or {})
    model = result.get("model") or default_model
    if not isinstance(model, str) or not model.strip():
        raise OpenAICompatibleError("Image model is required")
    result["model"] = model.strip()
    result["size"] = requested_image_size(result)
    result["quality"] = result.get("quality", "low")
    if result["size"] != "auto" and not re.fullmatch(r"([1-9][0-9]*)x([1-9][0-9]*)", result["size"]):
        raise OpenAICompatibleError("Size must be auto or WIDTHxHEIGHT positive integers")
    qualities = {"auto", "low", "medium", "high"}
    if result["model"] in IMAGE_25_MODELS:
        qualities |= {"xhigh", "max"}
        if result["size"] != "auto":
            match = re.fullmatch(r"([1-9][0-9]*)x([1-9][0-9]*)", result["size"])
            if not match:
                raise OpenAICompatibleError("Size must be auto or WIDTHxHEIGHT positive integers")
            width, height = map(int, match.groups())
            if max(width, height) > 3840 or width % 16 or height % 16 or max(width, height) > 3 * min(width, height) or not 655360 <= width * height <= 8294400:
                raise OpenAICompatibleError("Image 2.5 size requires multiples of 16, edges <=3840, ratio <=3 and 655360–8294400 pixels")
    if not isinstance(result["quality"], str) or result["quality"] not in qualities:
        raise OpenAICompatibleError("Unsupported quality for the selected image model")
    result["background"] = result.get("background", "auto")
    result["output_format"] = result.get("output_format", "png")
    if result["background"] not in ("auto", "opaque", "transparent"):
        raise OpenAICompatibleError("Background must be auto, opaque or transparent")
    if result["output_format"] not in ("png", "jpeg", "webp"):
        raise OpenAICompatibleError("Output format must be png, jpeg or webp")
    if result["background"] == "transparent" and result["output_format"] == "jpeg":
        raise OpenAICompatibleError("Transparent background requires PNG or WebP; JPEG is incompatible")
    if result["output_format"] == "png":
        result.pop("output_compression", None)
    elif "output_compression" in result:
        compression = result["output_compression"]
        if type(compression) is not int or not 0 <= compression <= 100:
            raise OpenAICompatibleError("Output compression must be an integer from 0 to 100")
    return result


def _safe_value(value, secret, depth=0):
    if depth > 6:
        return "[NESTED VALUE OMITTED]"
    if isinstance(value, str):
        value = value.replace(secret, "[REDACTED]") if secret else value
        value = re.sub(r"https?://[^\s\"<>]+", "[URL REDACTED]", value)
        value = re.sub(r"(?i)(?:authorization|cookie)\s*[:=][^\r\n]*", "[REDACTED]", value)
        value = re.sub(r"(?i)(bearer\s+\S+|(?:api[_-]?key|authorization|cookie|(?:client[_-]?)?secret|password|(?:access[_-]?|refresh[_-]?|session[_-]?)?token)[\"']?\s*[:=]\s*[\"']?[^\s,;\"'}]+|sk-[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_.-]+)", "[REDACTED]", value)
        value = re.sub(r"[A-Za-z0-9+/=_-]{128,}", "[LONG VALUE REDACTED]", value)
        return value[:1500]
    if isinstance(value, dict):
        safe = {}
        for key, item in list(value.items())[:40]:
            key = str(key)
            token_count = re.fullmatch(r"(?:input|output|prompt|completion|total|cached|reasoning|image|text|audio|accepted_prediction|rejected_prediction)_tokens", key)
            token_details = re.fullmatch(r"(?:input|output|prompt|completion)_tokens_details", key)
            allowed_usage = (token_count and type(item) in (int, float)) or (token_details and isinstance(item, dict))
            if re.search(r"(?i)authorization|cookie|token|secret|password|api.?key|b64|url", key) and not allowed_usage:
                continue
            safe[_safe_value(key, secret, depth + 1)[:100]] = _safe_value(item, secret, depth + 1)
        return safe
    if isinstance(value, list):
        return [_safe_value(item, secret, depth + 1) for item in value[:40]]
    return value if value is None or isinstance(value, (bool, int, float)) else None


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
                "status": "auth_error" if broken else ("ready" if ready else "login_required"), "message": "Provider configuration could not be read" if broken else ("Locally configured; live connectivity and image generation are not verified" if ready else "Configure image API settings first"),
                "verification": {"configuration_complete": ready, "connectivity_verified": False, "image_generation_verified": False},
                "can_generate": ready, "features": {"text_to_image": ready, "text_reference_to_image": ready, "image_edit": ready, "title_suggestion": False},
                "max_input_images": MAX_INPUT_IMAGES, "image_models": list(dict.fromkeys(([value["model"]] if value["model"] else []) + list(IMAGE_25_MODELS))),
                "default_image_model": value["model"], "model": value["model"], "api_key_present": value["api_key_present"]}


def _inspect_image(data, details=False):
    try:
        with Image.open(BytesIO(data)) as image:
            if image.width * image.height > MAX_IMAGE_PIXELS:
                raise ValueError()
            image.verify()
        with Image.open(BytesIO(data)) as image:
            image.load()
            if image.format not in {"PNG", "JPEG", "WEBP"}:
                raise ValueError()
            if details:
                has_alpha = "A" in image.getbands() or "transparency" in image.info
                return {"format": image.format, "width": image.width, "height": image.height,
                        "has_alpha": has_alpha, "has_transparent_pixels": has_alpha and image.convert("RGBA").getchannel("A").getextrema()[0] < 255}
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
        normalized = normalize_image_parameters(parameters, settings["model"])
        if not isinstance(prompt, str) or not prompt.strip():
            raise OpenAICompatibleError("Generation prompt is required")
        payload = {key: normalized[key] for key in ("model", "size", "quality", "background", "output_format", "output_compression") if key in normalized}
        payload.update(prompt=prompt, n=1)
        inputs = input_images or []
        endpoint = "/images/edits" if inputs else "/images/generations"
        url = normalize_base_url(settings["base_url"]) + endpoint
        started_at = datetime.now(timezone.utc).isoformat()
        started = time.monotonic()
        diagnostics = {"endpoint": url, "started_at": started_at}

        def fail(category, message, error=None):
            diagnostics.update(category=category, elapsed_seconds=round(time.monotonic() - started, 3))
            if isinstance(error, dict):
                diagnostics["error"] = {key: _safe_value(error[key], settings["api_key"]) for key in ("type", "code", "param", "message") if key in error}
            summary = json.dumps({k: v for k, v in diagnostics.items() if k != "endpoint"}, ensure_ascii=False)
            raise OpenAICompatibleError(message + "; no automatic retry was attempted. " + summary, dict(diagnostics)) from None

        client = self.http_client or httpx.Client(timeout=settings["timeout"], follow_redirects=False, transport=httpx.HTTPTransport(retries=0))
        try:
            kwargs = {"data": {k: str(v) for k, v in payload.items()}, "files": [("image[]", item) for item in inputs]} if inputs else {"json": payload}
            response = client.post(url, headers={"Authorization": "Bearer " + settings["api_key"], "Accept": "application/json"},
                                   timeout=settings["timeout"], follow_redirects=False, **kwargs)
        except httpx.ConnectTimeout:
            fail("connect_timeout", "Connection timed out; check service logs before resubmitting, upstream billing is unknown")
        except httpx.TimeoutException:
            fail("read_timeout", "Request timed out; upstream may still be generating and charging, check service logs before resubmitting")
        except Exception:
            fail("connection_error", "Image API connection failed; check service logs before resubmitting")
        finally:
            if self.http_client is None:
                client.close()
        diagnostics.update(http_status=response.status_code, content_type=_safe_value(response.headers.get("content-type"), settings["api_key"]),
                           request_id=_safe_value(response.headers.get("x-request-id") or response.headers.get("request-id"), settings["api_key"]),
                           retry_after=_safe_value(response.headers.get("retry-after"), settings["api_key"]))
        try:
            body = response.json()
        except (ValueError, UnicodeError):
            fail("non_json_response", f"Image API returned HTTP {response.status_code} with non-JSON content; check API address, proxy, login/verification and gateway pages")
        if not isinstance(body, dict):
            fail("invalid_json_response", "Image API JSON must be an object")
        error_body = body.get("error")
        if not diagnostics["request_id"]:
            request_id = body.get("request_id") or (error_body.get("request_id") if isinstance(error_body, dict) else None)
            if isinstance(request_id, str):
                diagnostics["request_id"] = _safe_value(request_id, settings["api_key"])
        if response.status_code != 200 or body.get("error"):
            category = {401: "authentication", 403: "permission_or_group", 404: "route_or_model", 429: "rate_limit"}.get(response.status_code, "upstream_error" if response.status_code >= 500 else "api_error")
            fail(category, f"Image API returned HTTP {response.status_code}; inspect API credentials, group permissions, model routing or limits as appropriate", body.get("error"))
        if not isinstance(body.get("data"), list) or len(body["data"]) != 1 or not isinstance(body["data"][0], dict):
            fail("missing_image", "Image API must return exactly one image")
        first = body["data"][0]
        encoded = first.get("b64_json")
        if not isinstance(encoded, str) or not encoded:
            fail("missing_image", "Image API returned no base64 image; URL-only responses are not supported")
        try:
            data = base64.b64decode(encoded, validate=True)
        except (ValueError, TypeError):
            fail("base64_decode", "Image API returned invalid Base64")
        try:
            decoded = _inspect_image(data, details=True)
        except OpenAICompatibleError:
            fail("image_decode", "Image API Base64 did not decode to a supported safe image")
        fmt, width, height = decoded["format"], decoded["width"], decoded["height"]
        fields = ("model", "size", "generation_id", "quality", "background", "output_format", "output_compression", "usage", "revised_prompt", "request_id", "created")
        top = {key: _safe_value(body[key], settings["api_key"]) for key in fields if key in body}
        item = {key: _safe_value(first[key], settings["api_key"]) for key in fields if key in first}
        actual = {key: item[key] if key in item else top.get(key) for key in fields}
        for key in ("model", "size", "quality", "background", "output_format", "generation_id"):
            if actual[key] is not None and not isinstance(actual[key], str):
                actual[key] = None
        actual["request_id"] = actual.get("request_id") or diagnostics["request_id"]
        actual.update(top_level=top, data_item=item, model_label_kind="service_returned_label")
        requested = dict(payload)
        if "requested_aspect_ratio" in parameters:
            requested["requested_aspect_ratio"] = parameters["requested_aspect_ratio"]
        mismatches = []
        if payload["size"] != "auto" and payload["size"] != f"{width}x{height}":
            mismatches.append({"field": "size", "requested": payload["size"], "actual": f"{width}x{height}"})
        if payload["output_format"] != fmt.lower():
            mismatches.append({"field": "output_format", "requested": payload["output_format"], "actual": fmt.lower()})
        if payload["background"] == "transparent" and not decoded["has_transparent_pixels"]:
            mismatches.append({"field": "background", "requested": "transparent", "actual": "no_transparent_pixels"})
        metadata = {"provider": PROVIDER_ID, "auth_mode": AUTH_MODE, "requested": requested, "response": actual,
                    "model": actual.get("model"), "image_model": actual.get("model"), "decoded_image": decoded, "mismatches": mismatches,
                    "request_diagnostics": {**diagnostics, "elapsed_seconds": round(time.monotonic() - started, 3)},
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
            prompt = job.edited_prompt_text if job.edited_prompt_text is not None else (job.prompt_text or "")
            if not prompt.strip():
                raise OpenAICompatibleError("Generation prompt is required")
            inputs = self._input_images(job, Path(library_path))
            if getattr(job, "mode", "text_to_image") in {"image_edit", "text_reference_to_image"} and not inputs:
                raise OpenAICompatibleError("This generation mode requires a reference image")
            parameters = dict(job.parameters or {})
            if getattr(job, "model", None):
                parameters["model"] = job.model
            if not parameters.get("model"):
                parameters["model"] = ((getattr(job, "metadata", {}) or {}).get("requested") or {}).get("model")
            if not parameters.get("model"):
                raise OpenAICompatibleError("This legacy job has no frozen request model; select a model and create a new task before generating")
            data, filename, metadata = self.generate(prompt, parameters, inputs)
            metadata["source_job_id"] = job_id
            return repo.stage_result(job_id, data, filename, metadata)
        except Exception as exc:
            message = str(exc) if isinstance(exc, OpenAICompatibleError) else "Compatible image generation failed; no automatic retry was attempted"
            diagnostics = exc.diagnostics if isinstance(exc, OpenAICompatibleError) else {"category": "internal_error"}
            repo.mark_failed(job_id, message, diagnostics=diagnostics)
            raise OpenAICompatibleError(message, diagnostics) from None
