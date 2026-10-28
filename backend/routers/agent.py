import asyncio
import time

from fastapi import APIRouter, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.concurrency import run_in_threadpool

from backend.agent_schemas import AgentConfigSave, AgentConversationCreate, AgentConversationPatch, AgentEditingTaskPatch, AgentResume, AgentRoundCreate
from backend.services.agent_execution import schedule_request, stop_request
from backend.services.agent_repository import ACTIVE_STATES, AgentError, AgentRepository, encoded
from backend.services.agent_progress import ProgressLimit, ProgressSession

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


@router.patch('/conversations/{conversation_id}/editing-task')
def patch_editing_task(conversation_id: str, payload: AgentEditingTaskPatch, request: Request):
    return repo(request).patch_editing_task(conversation_id, payload)


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


async def progress_events(request, repository, request_id, token, snapshot, structure=None):
    """Observe durable progress only; retain one bounded current-round view."""
    if structure is None:
        structure = await run_in_threadpool(repository.progress_structure, request_id)
    session = ProgressSession(snapshot)
    initial = session.initial(snapshot)
    terminal = snapshot['request']['state'] not in ACTIVE_STATES
    snapshot = None
    if await request.is_disconnected():
        return
    if terminal:
        # Snapshot assembly spans several reads. A safe resume can otherwise
        # pair an old terminal request with the new conversation revision and
        # make the client stop observing before it receives any correction.
        try:
            if (await run_in_threadpool(repository.progress_token, request_id) != token
                    or await run_in_threadpool(repository.progress_structure, request_id) != structure):
                yield 'event: resync\ndata: {"reason":"structure_changed"}\n\n'
                return
        except AgentError:
            yield 'event: fallback\ndata: {"reason":"unavailable"}\n\n'
            return
    yield 'event: snapshot\nid: ' + session.identity['epoch'] + ':0\ndata: ' + encoded(initial) + '\n\n'
    initial = None
    if terminal:
        return
    if session.view is None:
        yield 'event: fallback\ndata: {"reason":"view_limit"}\n\n'
        return
    last_sent = time.monotonic()
    while not await request.is_disconnected():
        if time.monotonic() - last_sent >= PROGRESS_HEARTBEAT:
            yield "event: heartbeat\ndata: {}\n\n"
            last_sent = time.monotonic()
        await asyncio.sleep(PROGRESS_INTERVAL)
        if await request.is_disconnected():
            return
        try:
            current = await run_in_threadpool(repository.progress_token, request_id)
            current_structure = await run_in_threadpool(repository.progress_structure, request_id)
            if current_structure != structure:
                yield 'event: resync\ndata: {"reason":"structure_changed"}\n\n'
                return
            if current != token:
                # Capture before assembly, never stamp an older view with a
                # newer marker. Concurrent writes are picked up next iteration.
                token = current
                view = await run_in_threadpool(repository.progress_view, request_id)
                # A branch/history change while projecting must be a resync,
                # not a patch that silently updates only part of the history.
                if await run_in_threadpool(repository.progress_structure, request_id) != structure:
                    yield 'event: resync\ndata: {"reason":"structure_changed"}\n\n'
                    return
                if (view['request']['state'] not in ACTIVE_STATES
                        and await run_in_threadpool(repository.progress_token, request_id) != token):
                    # Do not publish a stale terminal view when a concurrent
                    # resume committed while the projection was being built.
                    continue
                patch = session.patch(view)
                if patch:
                    yield 'event: patch\nid: ' + session.identity['epoch'] + ':' + str(session.sequence) + '\ndata: ' + encoded(patch) + '\n\n'
                    last_sent = time.monotonic()
                if view['request']['state'] not in ACTIVE_STATES:
                    return
        except ProgressLimit as exc:
            yield 'event: fallback\ndata: ' + encoded({'reason': str(exc)}) + '\n\n'
            return
        except AgentError:
            yield 'event: fallback\ndata: {"reason":"unavailable"}\n\n'
            return
        except ValueError:
            yield 'event: resync\ndata: {"reason":"structure_changed"}\n\n'
            return


@router.get("/requests/{request_id}/events")
async def get_request_events(request_id: str, request: Request):
    repository = await run_in_threadpool(repo, request)
    token = await run_in_threadpool(repository.progress_token, request_id)
    structure = await run_in_threadpool(repository.progress_structure, request_id)
    snapshot = await run_in_threadpool(repository.snapshot, request_id=request_id)
    # Every GET begins a new epoch/snapshot, including an expired Last-Event-ID.
    # Reconnecting restores observation and never schedules provider work.
    return StreamingResponse(progress_events(request, repository, request_id, token, snapshot, structure),
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
