"""Revocable, loopback-only capture credentials, kept outside library backups.

Only credential hashes are stored. Every request is bound to its extension
origin, local authority, and library instance; this is not a general API key.
"""
from __future__ import annotations

import hashlib
from contextlib import contextmanager
import hmac
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import tempfile
from threading import RLock
from urllib.parse import urlsplit
import uuid

from fastapi import HTTPException, Request

from backend.config import resolve_capture_clients_path, validate_app_owned_paths
from backend.repositories import now
from backend.services.library_archives import LibraryArchiveError, LibraryOperationLock

_LOCK = RLock()
EXTENSION_ID = re.compile(r"[a-p]{32}\Z")
EXTENSION_ORIGIN = re.compile(r"chrome-extension://([a-p]{32})\Z")
_TOKEN = re.compile(r"ipl_capture_[A-Za-z0-9_-]{43}\Z")
_RECEIPT = re.compile(r"/api/captures/receipts/[0-9a-fA-F-]{36}\Z")
CAPTURE_HEADERS = {"content-type", "x-capture-token", "x-capture-instance"}


def local_target_origin(request: Request) -> str:
    """Never resolve a supplied hostname or accept forwarded-host headers."""
    try:
        parsed = urlsplit(f"{request.url.scheme}://{request.headers.get('host', '')}")
        port = parsed.port
    except ValueError:
        raise HTTPException(403, "Capture pairing requires a loopback address") from None
    if parsed.scheme not in {"http", "https"} or parsed.hostname not in {"localhost", "127.0.0.1"} or parsed.username or parsed.password:
        raise HTTPException(403, "Capture pairing requires localhost or 127.0.0.1")
    if request.client is None:
        raise HTTPException(403, "Capture pairing requires a local connection")
    try:
        local_peer = ipaddress.ip_address(request.client.host).is_loopback
    except ValueError:
        local_peer = False
    if not local_peer:
        raise HTTPException(403, "Capture pairing requires a local connection")
    default_port = 443 if parsed.scheme == "https" else 80
    return f"{parsed.scheme}://{parsed.hostname}" + (f":{port}" if port and port != default_port else "")


def require_local_management(request: Request) -> str:
    target = local_target_origin(request)
    # Explicit same-origin browser authorization is needed to issue/revoke keys.
    # Do not extend the development CORS exception to credential management.
    origin = request.headers.get("origin")
    if origin != target and not (
        request.method == "GET" and not origin and request.headers.get("sec-fetch-site") == "same-origin"
    ):
        raise HTTPException(403, "Open pairing settings in the local library")
    if getattr(request.state, "capture_client", None) is not None:
        raise HTTPException(403, "Capture credentials cannot manage pairings")
    return target


def capture_route_allowed(path: str, method: str) -> bool:
    if method == "POST" and path in {"/api/captures", "/api/captures/detect-language"}:
        return True
    # Chrome may omit Origin on extension GETs with host permission. POST
    # aliases retain the exact same identity checks and read-only behavior.
    return method in {"GET", "POST"} and (path == "/api/captures/connection" or _RECEIPT.fullmatch(path) is not None)


def namespaced_request_id(client_id: str, request_id: str | uuid.UUID) -> uuid.UUID:
    return uuid.uuid5(uuid.UUID(client_id), str(uuid.UUID(str(request_id))))


class CaptureClients:
    def __init__(self, library: Path | str):
        self.library = Path(library).resolve()
        self.path = resolve_capture_clients_path()
        # Persist the library binding as a digest rather than leaking local paths
        # to an extension or its pairing package.
        self.library_key = hashlib.sha256(os.path.normcase(str(self.library)).encode()).hexdigest()

    def _read(self) -> dict:
        if not self.path.exists():
            return {"version": 1, "instances": {}}
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            if data.get("version") != 1 or not isinstance(data.get("instances"), dict):
                raise ValueError()
            for instance in data["instances"].values():
                uuid.UUID(instance["instance_id"])
                if not isinstance(instance["clients"], dict):
                    raise ValueError()
                for client_id, value in instance["clients"].items():
                    uuid.UUID(client_id)
                    if (EXTENSION_ID.fullmatch(value["extension_id"]) is None
                            or not isinstance(value["name"], str) or not isinstance(value["created_at"], str)
                            or not value.get("revoked") and re.fullmatch(r"[a-f0-9]{64}", value["token_hash"]) is None):
                        raise ValueError()
            return data
        except (OSError, ValueError, TypeError, KeyError, AttributeError):
            raise HTTPException(503, "Capture pairing storage is unavailable") from None

    def _write(self, data: dict) -> None:
        validate_app_owned_paths(self.library)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix="capture-clients-", suffix=".tmp", dir=self.path.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                json.dump(data, stream, ensure_ascii=False, indent=2)
                stream.flush()
                os.fsync(stream.fileno())
            Path(temporary).chmod(0o600)
            os.replace(temporary, self.path)
        except OSError:
            Path(temporary).unlink(missing_ok=True)
            raise HTTPException(503, "Capture pairing storage could not be saved") from None

    def _key(self, target: str) -> str:
        return hashlib.sha256(f"{self.library_key}\n{target}".encode()).hexdigest()

    @contextmanager
    def _editing(self):
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            # Reuse the existing cross-process file lease; concurrent app
            # instances must not overwrite each other's pairings.
            with _LOCK, LibraryOperationLock(self.path.parent, _lock_path=self.path.with_suffix(".lock")):
                yield
        except (OSError, LibraryArchiveError):
            raise HTTPException(503, "Capture pairing storage is busy or unavailable; retry later") from None

    def _instance(self, data: dict, target: str) -> dict | None:
        return data["instances"].get(self._key(target))

    @staticmethod
    def _public(client_id: str, value: dict) -> dict:
        return {"client_id": client_id, **{key: value[key] for key in ("extension_id", "name", "created_at")}}

    def list(self, target: str) -> dict:
        with _LOCK:
            instance = self._instance(self._read(), target)
            return {"instance_id": instance["instance_id"] if instance else None,
                    "clients": [self._public(key, value) for key, value in instance["clients"].items() if not value.get("revoked")]
                    if instance else []}

    def create(self, target: str, extension_id: str, name: str) -> dict:
        if EXTENSION_ID.fullmatch(extension_id) is None:
            raise HTTPException(422, "A Chrome extension ID must contain 32 letters from a to p")
        token = "ipl_capture_" + secrets.token_urlsafe(32)
        client_id = str(uuid.uuid4())
        with self._editing():
            data = self._read()
            instance = data["instances"].setdefault(self._key(target), {"instance_id": str(uuid.uuid4()), "clients": {}})
            client = {"extension_id": extension_id, "name": name.strip() or "Browser capture",
                      "created_at": now(), "token_hash": hashlib.sha256(token.encode()).hexdigest()}
            instance["clients"][client_id] = client
            self._write(data)
            return {**self._public(client_id, client), "instance_id": instance["instance_id"],
                    "target_origin": target, "token": token}

    def revoke(self, target: str, client_id: str) -> None:
        with self._editing():
            data = self._read()
            instance = self._instance(data, target)
            if not instance or client_id not in instance["clients"]:
                raise HTTPException(404, "Pairing not found")
            # Keep non-secret origin metadata so revoked clients can read a 401
            # instead of an opaque CORS failure; the hash no longer authenticates.
            value = instance["clients"][client_id]
            value["revoked"] = True
            value.pop("token_hash", None)
            self._write(data)

    def known_origin(self, target: str, origin: str) -> bool:
        match = EXTENSION_ORIGIN.fullmatch(origin)
        if match is None:
            return False
        with _LOCK:
            instance = self._instance(self._read(), target)
            return bool(instance and any(value["extension_id"] == match[1] for value in instance["clients"].values()))

    def authenticate(self, target: str, origin: str, token: str, instance_id: str) -> dict:
        match = EXTENSION_ORIGIN.fullmatch(origin)
        if match is None or _TOKEN.fullmatch(token) is None:
            raise HTTPException(401, "Capture pairing is missing or invalid; reconnect in the local library")
        digest = hashlib.sha256(token.encode()).hexdigest()
        with _LOCK:
            instance = self._instance(self._read(), target)
            if instance and instance["instance_id"] == instance_id:
                for client_id, value in instance["clients"].items():
                    if value["extension_id"] == match[1] and not value.get("revoked") and hmac.compare_digest(value["token_hash"], digest):
                        return {"client_id": client_id, "instance_id": instance["instance_id"]}
        raise HTTPException(401, "Capture pairing is missing, revoked, or belongs to another local instance")
