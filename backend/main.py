from contextlib import asynccontextmanager
import asyncio
import os
import ipaddress
import re
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from .config import APP_VERSION, resolve_hidden_features, resolve_library_path, resolve_library_storage_path, validate_app_owned_paths
from .db import get_db_path, init_db
from .routers import agent, app_updates, capture_clients, capture_organizer, captures, cleanup, clusters, generation_jobs, generation_providers, images, import_drafts, items, tags
from .services.capture_clients import CAPTURE_HEADERS, CaptureClients, capture_route_allowed, local_target_origin
from .services.library_archives import LibraryOperationLock
from .services.capture_organizer import drain_jobs, recover_jobs
from .services.generation_queue import AUTOMATED_PROVIDER_IDS, enqueue_generation_jobs, recover_interrupted_generation_jobs
from .services.agent_execution import drain_agent_requests, recover_agent_requests
from .services.agent_repository import AgentError

DEFAULT_FRONTEND_DIST_PATH = Path(__file__).resolve().parents[1] / "frontend" / "dist"

FRONTEND_INDEX_CACHE_HEADERS = {
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    "Pragma": "no-cache",
    "Expires": "0",
}
FRONTEND_ASSET_CACHE_HEADERS = {"Cache-Control": "public, max-age=31536000, immutable"}
SAFE_HTTP_METHODS = {"GET", "HEAD", "OPTIONS"}
DEFAULT_DEVELOPMENT_ORIGINS = {"http://127.0.0.1:5177", "http://localhost:5177"}


def _normalized_origin(value: str) -> tuple[str, str, int] | None:
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError:
        return None
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
    ):
        return None
    return parsed.scheme, parsed.hostname.rstrip(".").lower(), port or (443 if parsed.scheme == "https" else 80)


def _development_origins() -> set[str]:
    origins = set(DEFAULT_DEVELOPMENT_ORIGINS)
    configured = os.environ.get("IMAGE_PROMPT_LIBRARY_DEVELOPMENT_ORIGINS", "")
    for raw_origin in configured.split(","):
        origin = raw_origin.strip().rstrip("/")
        if not origin:
            continue
        if _normalized_origin(origin) is None:
            raise ValueError(f"Invalid development origin: {raw_origin.strip()}")
        origins.add(origin)
    return origins


def _browser_write_origin_allowed(request: Request, development_origin_authorities: set[tuple[str, str, int]]) -> bool:
    origin = request.headers.get("origin")
    if origin:
        authority = _normalized_origin(origin)
        if authority is None:
            return False
        if authority in development_origin_authorities:
            return True
        host = request.headers.get("host")
        request_authority = _normalized_origin(f"{request.url.scheme}://{host}") if host else None
        return authority == request_authority
    return request.headers.get("sec-fetch-site", "").lower() != "cross-site"


def _allowed_hostnames() -> set[str]:
    names = {"localhost"}
    for value in os.environ.get("IMAGE_PROMPT_LIBRARY_ALLOWED_HOSTS", "").split(","):
        name = value.strip().lower().rstrip(".")
        if not name:
            continue
        if len(name) > 253 or any(
            not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label)
            for label in name.split(".")
        ):
            raise ValueError("IMAGE_PROMPT_LIBRARY_ALLOWED_HOSTS requires exact hostnames, without ports or wildcards")
        names.add(name)
    return names


def _request_host_allowed(request: Request, names: set[str]) -> bool:
    hosts = request.headers.getlist("host")
    if len(hosts) != 1 or any(char.isspace() or char in "/\\?#@" for char in hosts[0]):
        return False
    authority = _normalized_origin(f"http://{hosts[0]}")
    if authority is None:
        return False
    hostname = authority[1]
    if hostname in names:
        return True
    try:
        # Literal IPs preserve LAN/IPv6 access without trusting DNS resolution.
        if "%" in hostname:
            return False
        ipaddress.ip_address(hostname)
        return True
    except ValueError:
        return False


def frontend_file_response(path: Path, *, is_index: bool) -> FileResponse:
    headers = FRONTEND_INDEX_CACHE_HEADERS if is_index else FRONTEND_ASSET_CACHE_HEADERS
    return FileResponse(path, headers=headers)


def create_app(library_path: Path | str | None = None, frontend_dist_path: Path | str | None = None) -> FastAPI:
    library = resolve_library_path(library_path)
    validate_app_owned_paths(library)
    frontend_dist = Path(frontend_dist_path).resolve() if frontend_dist_path is not None else DEFAULT_FRONTEND_DIST_PATH.resolve()
    # Initialization and the running app share the same sibling lease as
    # backup/restore. This keeps database and media replacement offline without
    # introducing a second process-management system.
    with LibraryOperationLock(library):
        init_db(library)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        with LibraryOperationLock(library):
            try:
                recover_jobs(library)
                for provider in AUTOMATED_PROVIDER_IDS:
                    recover_interrupted_generation_jobs(library, provider=provider)
                recover_agent_requests(library)
                for provider in AUTOMATED_PROVIDER_IDS:
                    enqueue_generation_jobs(library, provider=provider)
                yield
            finally:
                await asyncio.to_thread(drain_agent_requests, library)
                # No metadata worker may write after backup/restore can acquire
                # the library lease. Pending jobs remain durable and unstarted.
                await asyncio.to_thread(drain_jobs, library)

    app = FastAPI(title="Image Prompt Library", version=APP_VERSION, lifespan=lifespan)
    @app.exception_handler(AgentError)
    async def agent_error_handler(request: Request, exc: AgentError):
        return JSONResponse(status_code=exc.status, content={"detail": {"code": exc.code, "message": exc.message}})
    app.state.library_path = library
    app.state.frontend_dist_path = frontend_dist
    app.state.capture_clients = CaptureClients(library)
    allowed_hostnames = _allowed_hostnames()
    development_origins = _development_origins()
    development_origin_authorities = {
        authority for origin in development_origins if (authority := _normalized_origin(origin)) is not None
    }
    app.add_middleware(CORSMiddleware, allow_origins=sorted(development_origins), allow_credentials=True, allow_methods=["*"], allow_headers=["*"])

    @app.middleware("http")
    async def reject_cross_origin_api_writes(request: Request, call_next):
        if not _request_host_allowed(request, allowed_hostnames):
            return JSONResponse(status_code=400, content={"detail": "Unrecognized request host"})
        origin = request.headers.get("origin", "")
        capture_request = origin.startswith("chrome-extension:") or any(
            header in request.headers for header in ("x-capture-token", "x-capture-instance")
        ) or request.headers.get("authorization", "").lower().startswith("bearer ipl_capture_")
        if capture_request:
            cors_headers = {"Cache-Control": "no-store"}
            try:
                target = local_target_origin(request)
                store = request.app.state.capture_clients
                if store.known_origin(target, origin):
                    cors_headers.update({"Access-Control-Allow-Origin": origin, "Vary": "Origin"})
                preflight = request.method == "OPTIONS" and "access-control-request-method" in request.headers
                method = request.headers.get("access-control-request-method", "").upper() if preflight else request.method
                if not capture_route_allowed(request.url.path, method):
                    raise HTTPException(403, "Capture pairing does not authorize this route")
                if preflight:
                    headers = {part.strip().lower() for part in request.headers.get("access-control-request-headers", "").split(",") if part.strip()}
                    if not store.known_origin(target, origin) or not headers.issubset(CAPTURE_HEADERS):
                        raise HTTPException(403, "Capture preflight is not authorized")
                    cors_headers.update({"Access-Control-Allow-Methods": method,
                                         "Access-Control-Allow-Headers": ", ".join(sorted(CAPTURE_HEADERS)),
                                         "Access-Control-Max-Age": "60"})
                    if request.headers.get("access-control-request-private-network") == "true":
                        cors_headers["Access-Control-Allow-Private-Network"] = "true"
                    return Response(status_code=204, headers=cors_headers)
                request.state.capture_client = store.authenticate(
                    target, origin, request.headers.get("x-capture-token", ""), request.headers.get("x-capture-instance", "")
                )
            except HTTPException as exc:
                return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail}, headers=cors_headers)
            response = await call_next(request)
            response.headers.update(cors_headers)
            return response
        if (
            request.url.path.startswith("/api/")
            and request.method.upper() not in SAFE_HTTP_METHODS
            and not _browser_write_origin_allowed(request, development_origin_authorities)
        ):
            return JSONResponse(status_code=403, content={"detail": "Cross-origin write requests are not allowed"})
        return await call_next(request)

    app.include_router(items.router, prefix="/api")
    app.include_router(captures.router, prefix="/api")
    app.include_router(capture_clients.router, prefix="/api")
    app.include_router(capture_organizer.router, prefix="/api")
    app.include_router(images.router, prefix="/api")
    app.include_router(clusters.router, prefix="/api")
    app.include_router(tags.router, prefix="/api")
    app.include_router(import_drafts.router, prefix="/api")
    app.include_router(generation_jobs.router, prefix="/api")
    app.include_router(generation_providers.router, prefix="/api")
    app.include_router(agent.router, prefix="/api")
    app.include_router(app_updates.router, prefix="/api")
    app.include_router(cleanup.router, prefix="/api")
    @app.get("/api/health")
    def health(): return {"ok": True, "version": APP_VERSION}
    @app.get("/api/config")
    def config(): return {"version": APP_VERSION, "library_path": str(library), "database_path": str(get_db_path(library)), "preferred_prompt_language": "zh_hant", "features": resolve_hidden_features()}
    @app.api_route("/api/{api_path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
    def unknown_api(api_path: str):
        raise HTTPException(status_code=404)
    @app.get("/media/{media_path:path}")
    def media(media_path: str):
        safe_roots = {"originals", "thumbs", "previews", "generation-results", "generation-references"}
        parts = Path(media_path).parts
        if not parts or parts[0] not in safe_roots:
            raise HTTPException(status_code=404)
        try:
            candidate = resolve_library_storage_path(library, media_path)
            allowed_root = resolve_library_storage_path(library, parts[0])
            candidate.relative_to(allowed_root)
        except ValueError as exc:
            raise HTTPException(status_code=404) from exc
        if not candidate.is_file():
            raise HTTPException(status_code=404)
        return FileResponse(candidate)

    def serve_frontend_path(frontend_path: str = ""):
        if frontend_path == "api" or frontend_path.startswith("api/"):
            raise HTTPException(status_code=404)
        index = frontend_dist / "index.html"
        if not index.is_file():
            raise HTTPException(status_code=404, detail="Frontend build not found. Run `npm run build` first, or use `./scripts/dev.sh` for development.")
        candidate = (frontend_dist / frontend_path).resolve() if frontend_path else index.resolve()
        try:
            candidate.relative_to(frontend_dist)
        except ValueError as exc:
            raise HTTPException(status_code=404) from exc
        if candidate.is_file():
            return frontend_file_response(candidate, is_index=candidate == index.resolve())
        return frontend_file_response(index, is_index=True)

    @app.get("/")
    def frontend_root():
        return serve_frontend_path()

    @app.get("/{frontend_path:path}")
    def frontend_app(frontend_path: str):
        return serve_frontend_path(frontend_path)
    return app

app = create_app()
