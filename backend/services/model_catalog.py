"""Bounded, explicit model discovery. Catalogs never change generation settings."""
from __future__ import annotations

import hashlib
import json
import os
import tempfile
import time
from datetime import datetime
from pathlib import Path

import httpx
from backend.services.api_network import ApiNetworkError, create_api_client, network_identity

MAX_CATALOG_BYTES = 2 * 1024 * 1024
MAX_CATALOG_MODELS = 1000
MAX_MODEL_ID_LENGTH = 200
MAX_CACHE_BYTES = 8 * 1024 * 1024
CATALOG_TIMEOUT = 15.0

ERRORS = {
    "not_configured": "Save an API URL and API key before refreshing models.",
    "permission": "The provider denied access to its model list. Check the saved API key and permissions.",
    "timeout": "The model list request timed out. Try refreshing again later.",
    "connection": "Could not connect to the model list endpoint.",
    "http": "The provider could not return its model list. Check that this connection supports GET /models.",
    "invalid": "The provider returned an invalid model list.",
    "limit": "The provider model list exceeded the supported size limit.",
    "empty": "The provider returned no models. Any previously fetched models have been kept.",
    "changed": "The saved connection changed during refresh. Refresh the current connection again.",
    "superseded": "A newer model refresh has started. The older response was discarded.",
    "cache": "The saved model cache could not be read. Refresh the model list again.",
    "network_config": "The API network connection could not be prepared. Check the selected network mode, proxy and direct route.",
}


def empty_catalog():
    return {"models": [], "fetched_at": None, "checked_at": None, "error": None}


def connection_fingerprint(settings, normalized_root):
    # The digest is private cache metadata, never a credential or a public field.
    value = [normalized_root, settings.get("base_url_mode", "versioned"), settings.get("api_key", "")]
    network = network_identity(settings)
    if network:
        value.append(network)
    return hashlib.sha256(json.dumps(value, ensure_ascii=False).encode("utf-8")).hexdigest()


class ModelCatalogError(RuntimeError):
    def __init__(self, code):
        self.code = code
        super().__init__(ERRORS[code])


def _valid_id(value, secret=""):
    return (isinstance(value, str) and 0 < len(value) <= MAX_MODEL_ID_LENGTH
            and value == value.strip() and not any(ord(char) < 32 or ord(char) == 127 for char in value)
            and not (secret and secret in value))


def _image_generation(entry):
    claims = set()
    capabilities = entry.get("capabilities")
    if isinstance(capabilities, dict) and type(capabilities.get("image_generation")) is bool:
        claims.add(capabilities["image_generation"])
    for source in (entry, capabilities):
        modalities = source.get("output_modalities") if isinstance(source, dict) else None
        if isinstance(modalities, list) and modalities and all(isinstance(item, str) for item in modalities):
            claims.add("image" in [item.lower() for item in modalities])
    # Input vision capability and model names do not establish image output support.
    return next(iter(claims)) if len(claims) == 1 else None


def parse_models(payload, secret=""):
    if not isinstance(payload, dict) or not isinstance(payload.get("data"), list):
        raise ModelCatalogError("invalid")
    entries = payload["data"]
    if len(entries) > MAX_CATALOG_MODELS:
        raise ModelCatalogError("limit")
    if not entries:
        raise ModelCatalogError("empty")
    models = {}
    claims = {}
    for entry in entries:
        if not isinstance(entry, dict) or not _valid_id(entry.get("id"), secret):
            raise ModelCatalogError("invalid")
        model_id = entry["id"]
        models.setdefault(model_id, {"id": model_id, "image_generation": None})
        capability = _image_generation(entry)
        if capability is not None:
            claims.setdefault(model_id, set()).add(capability)
    for model_id, values in claims.items():
        models[model_id]["image_generation"] = next(iter(values)) if len(values) == 1 else None
    return list(models.values())


def fetch_models(normalized_root, api_key, http_client=None, *, network_settings=None):
    """One GET only. Never follow redirects, retry, or send a generation request."""
    client = http_client
    started = time.monotonic()
    try:
        client = client or create_api_client(network_settings or {}, timeout=CATALOG_TIMEOUT)
        with client.stream("GET", normalized_root + "/models", headers={
            "Authorization": "Bearer " + api_key, "Accept": "application/json",
        }, timeout=CATALOG_TIMEOUT, follow_redirects=False) as response:
            if response.status_code in (401, 403):
                raise ModelCatalogError("permission")
            if not 200 <= response.status_code < 300:
                raise ModelCatalogError("http")
            content_length = response.headers.get("content-length")
            if content_length and content_length.isdecimal() and int(content_length) > MAX_CATALOG_BYTES:
                raise ModelCatalogError("limit")
            chunks, size = [], 0
            # Bound decoded bytes as well, so compressed responses cannot bypass the limit.
            for chunk in response.iter_bytes():
                if time.monotonic() - started > CATALOG_TIMEOUT:
                    raise ModelCatalogError("timeout")
                size += len(chunk)
                if size > MAX_CATALOG_BYTES:
                    raise ModelCatalogError("limit")
                chunks.append(chunk)
            try:
                payload = json.loads(b"".join(chunks))
            except (ValueError, UnicodeError, RecursionError):
                raise ModelCatalogError("invalid") from None
            return parse_models(payload, api_key)
    except ApiNetworkError:
        raise ModelCatalogError("network_config") from None
    except httpx.TimeoutException:
        raise ModelCatalogError("timeout") from None
    except (httpx.HTTPError, OSError):
        raise ModelCatalogError("connection") from None
    finally:
        if http_client is None and client is not None:
            client.close()


class ModelCatalogCache:
    """Disposable sidecar outside the library; at most one connection per profile."""
    def __init__(self, config_path):
        path = Path(config_path)
        self.path = path.with_name(path.stem + ".model-catalog.json")

    def _document(self):
        if not self.path.exists():
            return {"version": 1, "profiles": {}}
        with self.path.open("rb") as stream:
            raw = stream.read(MAX_CACHE_BYTES + 1)
        if len(raw) > MAX_CACHE_BYTES:
            raise ValueError()
        document = json.loads(raw)
        if not isinstance(document, dict) or document.get("version") != 1 or not isinstance(document.get("profiles"), dict):
            raise ValueError()
        return document

    def read(self, profile_id, fingerprint, secret=""):
        try:
            entry = self._document()["profiles"].get(profile_id)
            if not isinstance(entry, dict) or entry.get("fingerprint") != fingerprint:
                return empty_catalog()
            value = entry["catalog"]
            if not isinstance(value, dict) or set(value) != set(empty_catalog()):
                raise ValueError()
            if not isinstance(value["models"], list) or len(value["models"]) > MAX_CATALOG_MODELS:
                raise ValueError()
            seen = set()
            for model in value["models"]:
                if (not isinstance(model, dict) or set(model) != {"id", "image_generation"}
                        or not _valid_id(model.get("id"), secret)
                        or (model["image_generation"] is not None and type(model["image_generation"]) is not bool)
                        or model["id"] in seen):
                    raise ValueError()
                seen.add(model["id"])
            for field in ("fetched_at", "checked_at"):
                if value[field] is not None:
                    if not isinstance(value[field], str) or len(value[field]) > 40:
                        raise ValueError()
                    datetime.fromisoformat(value[field])
            if value["error"] is not None and value["error"] not in ERRORS.values():
                raise ValueError()
            return value
        except (OSError, ValueError, KeyError, TypeError, RecursionError):
            return {**empty_catalog(), "error": ERRORS["cache"]}

    def write(self, profile_id, fingerprint, catalog, profile_ids, library_path):
        if self.path.resolve().is_relative_to(Path(library_path).expanduser().resolve()):
            raise ValueError("Model cache must be outside the asset library")
        try:
            document = self._document()
        except (OSError, ValueError, TypeError, RecursionError):
            document = {"version": 1, "profiles": {}}
        # Never retain deleted profiles or prior connections in the disposable cache.
        document["profiles"] = {key: value for key, value in document["profiles"].items() if key in profile_ids}
        document["profiles"][profile_id] = {"fingerprint": fingerprint, "catalog": catalog}
        raw = json.dumps(document, ensure_ascii=False, indent=2).encode("utf-8")
        if len(raw) > MAX_CACHE_BYTES:
            raise ValueError("Model cache size limit exceeded")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, name = tempfile.mkstemp(prefix="model-catalog-", suffix=".tmp", dir=self.path.parent)
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(raw)
                stream.flush()
                os.fsync(stream.fileno())
            Path(name).chmod(0o600)
            os.replace(name, self.path)
        finally:
            Path(name).unlink(missing_ok=True)
