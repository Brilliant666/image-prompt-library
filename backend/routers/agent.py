import asyncio
import time

from fastapi import APIRouter, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.concurrency import run_in_threadpool

from backend.agent_schemas import AgentConfigSave, AgentConversationCreate, AgentConversationPatch, AgentResume, AgentRoundCreate
from backend.services.agent_execution import schedule_request, stop_request
from backend.services.agent_repository import ACTIVE_STATES, AgentError, AgentRepository, encoded

router = APIRouter(prefix="/agent", tags=["agent"])
PROGRESS_INTERVAL = 0.15
PROGRESS_HEARTBEAT = 10.0


def repo(request):
    return AgentRepository(request.app.state.library_path)


@router.get("/config")
def get_config(request: Request):
    return repo(request).config()


@router.put("/config")
def save_config(payload: AgentConfigSave, request: Request):
    return repo(request).save_config(payload)


@router.get("/conversations")
def list_conversations(request: Request, limit: int = Query(50, ge=1, le=100), cursor: str | None = Query(None, pattern=r"^\d+$"),
                       q: str | None = Query(None, max_length=200)):
    return repo(request).list_conversations(limit, cursor, q)


@router.post("/conversations")
def create_conversation(payload: AgentConversationCreate, request: Request):
    return repo(request).create_conversation(payload)


@router.get("/conversations/{conversation_id}")
def get_conversation(conversation_id: str, request: Request):
    return repo(request).snapshot(conversation_id)


@router.patch("/conversations/{conversation_id}")
def patch_conversation(conversation_id: str, payload: AgentConversationPatch, request: Request):
    return repo(request).patch_conversation(conversation_id, payload)


@router.delete("/conversations/{conversation_id}")
def delete_conversation(conversation_id: str, request: Request):
    return repo(request).delete(conversation_id)


@router.post("/conversations/{conversation_id}/rounds")
def create_round(conversation_id: str, payload: AgentRoundCreate, request: Request):
    result, created = repo(request).create_round(conversation_id, payload)
    if created:
        schedule_request(request.app.state.library_path, payload.requestId)
    return JSONResponse(result, status_code=202 if created else 200)


@router.delete("/conversations/{conversation_id}/rounds/{round_id}")
def delete_round(conversation_id: str, round_id: str, request: Request):
    return repo(request).delete(conversation_id, round_id)


@router.get("/requests/{request_id}")
def get_request(request_id: str, request: Request):
    return repo(request).snapshot(request_id=request_id)


async def progress_events(request, repository, request_id, token, snapshot):
    """Observe durable progress only. Disconnecting never cancels or retries work."""
    last_sent = time.monotonic()
    while not await request.is_disconnected():
        if snapshot is not None:
            yield "event: snapshot\ndata: " + encoded(snapshot) + "\n\n"
            last_sent = time.monotonic()
            if snapshot["request"]["state"] not in ACTIVE_STATES:
                return
            snapshot = None
        elif time.monotonic() - last_sent >= PROGRESS_HEARTBEAT:
            yield "event: heartbeat\ndata: {}\n\n"
            last_sent = time.monotonic()
        await asyncio.sleep(PROGRESS_INTERVAL)
        if await request.is_disconnected():
            return
        try:
            current = await run_in_threadpool(repository.progress_token, request_id)
            if current != token:
                # Capture the marker before the snapshot so an update during
                # assembly is observed again rather than accidentally skipped.
                token = current
                snapshot = await run_in_threadpool(repository.snapshot, request_id=request_id)
        except AgentError:
            # A removed conversation is no longer observable. The browser can
            # reconcile its selection through the ordinary GET fallback.
            return


@router.get("/requests/{request_id}/events")
async def get_request_events(request_id: str, request: Request):
    repository = await run_in_threadpool(repo, request)
    token = await run_in_threadpool(repository.progress_token, request_id)
    snapshot = await run_in_threadpool(repository.snapshot, request_id=request_id)
    return StreamingResponse(progress_events(request, repository, request_id, token, snapshot),
                             media_type="text/event-stream",
                             headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})


@router.post("/requests/{request_id}/stop")
def stop(request_id: str, request: Request):
    return stop_request(request.app.state.library_path, request_id)


@router.post("/requests/{request_id}/resume")
def resume(request_id: str, payload: AgentResume, request: Request):
    repository = repo(request)
    created = repository.resume(request_id, payload.resumeId)
    if created:
        schedule_request(request.app.state.library_path, request_id)
    return JSONResponse(repository.snapshot(request_id=request_id), status_code=202 if created else 200)


@router.post("/uploads")
async def upload(request: Request, file: UploadFile = File(...), kind: str = Form("reference")):
    if kind not in {"reference", "mask"}:
        raise HTTPException(400, detail={"code": "invalid_reference", "message": "上传用途无效。"})
    image = repo(request).store_asset(await file.read(30 * 1024 * 1024 + 1), None, kind)
    return {"uploadId": image["id"], "image": image}
