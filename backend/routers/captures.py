import json
import sqlite3
import uuid

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from pydantic import BaseModel, ValidationError
from starlette.concurrency import run_in_threadpool

from backend.db import connect
from backend.schemas import ItemDetail
from backend.services.capture_clients import namespaced_request_id
from backend.services.capture_organizer import connection_status, enqueue_jobs
from backend.services.prompt_language import MAX_PROMPT_CHARACTERS, LanguageDetection, LanguageDetectionRequest, detect_prompt_language
from backend.services.quick_capture import MAX_CAPTURE_BYTES, CaptureError, CaptureFields, capture_item

router = APIRouter()


class CaptureReceipt(BaseModel):
    request_id: uuid.UUID
    item_id: str
    title: str | None = None
    created_at: str | None = None
    organizer: dict | None = None


def _paired_client(request: Request):
    client = getattr(request.state, "capture_client", None)
    if client is None:
        raise HTTPException(403, "A valid browser capture pairing is required")
    return client


@router.get("/captures/connection")
@router.post("/captures/connection")
def capture_connection(request: Request):
    return {**_paired_client(request), "organizer": connection_status(request.app.state.library_path)}


def _receipt(library, internal_id, original_id):
    # Title and terminal organizer state must come from one snapshot; otherwise
    # a fast worker can report succeeded alongside the pre-enrichment title.
    with connect(library) as conn:
        row = conn.execute("SELECT c.item_id,i.title,i.created_at,i.deleted_at,j.status,j.category,k.name collection "
                           "FROM capture_requests c LEFT JOIN items i ON i.id=c.item_id "
                           "LEFT JOIN clusters k ON k.id=i.cluster_id "
                           "LEFT JOIN capture_organizer_jobs j ON j.request_id=c.request_id WHERE c.request_id=?",
                           (str(internal_id),)).fetchone()
    if row is None:
        raise HTTPException(404, "No saved receipt for this request")
    if row["item_id"] is None or row["deleted_at"] is not None:
        raise HTTPException(410, "The captured item was deleted; it will not be recreated")
    return {"request_id": str(original_id), "item_id": row["item_id"], "title": row["title"], "created_at": row["created_at"],
            "organizer": {"status": row["status"] or "disabled", "category": row["category"] or "", "collection": row["collection"]}}


@router.get("/captures/receipts/{request_id}", response_model=CaptureReceipt)
@router.post("/captures/receipts/{request_id}", response_model=CaptureReceipt)
def capture_receipt(request_id: uuid.UUID, request: Request):
    client = _paired_client(request)
    return _receipt(request.app.state.library_path, namespaced_request_id(client["client_id"], request_id), request_id)


@router.post("/captures/detect-language", response_model=LanguageDetection)
def detect_language(payload: LanguageDetectionRequest):
    return detect_prompt_language(payload.text)


@router.post("/captures", response_model=ItemDetail | CaptureReceipt)
async def capture(request: Request, file: UploadFile = File(...), prompt_text: str | None = Form(None),
                  prompt_text_json: str | None = Form(None),
                  request_id: str = Form(...), language: str = Form("auto"), title: str = Form(""),
                  original_filename: str = Form(""),
                  source_name: str = Form(""), source_url: str = Form(""), notes: str = Form("")):
    form = await request.form()
    if sum(hasattr(value, "filename") for _, value in form.multi_items()) != 1:
        raise HTTPException(400, "Capture requires exactly one image")
    if prompt_text_json is not None:
        # Browser multipart fields normalize line endings. JSON escapes retain exact
        # LF/CRLF characters while keeping the request's one image binary field.
        if prompt_text is not None or len(prompt_text_json) > MAX_PROMPT_CHARACTERS * 6 + 2:
            raise HTTPException(400, "Supply one valid prompt representation")
        try:
            decoded = json.loads(prompt_text_json)
        except (ValueError, RecursionError) as exc:
            raise HTTPException(400, "Invalid JSON prompt text") from exc
        if not isinstance(decoded, str):
            raise HTTPException(400, "JSON prompt text must contain a string")
        prompt_text = decoded
    if prompt_text is None:
        raise HTTPException(422, "Prompt text is required")
    try:
        fields = CaptureFields(request_id=request_id, prompt_text=prompt_text, language=language,
                               title=title, original_filename=original_filename,
                               source_name=source_name, source_url=source_url, notes=notes)
    except ValidationError as exc:
        # Do not echo submitted prompt/source fields in validation error payloads.
        raise HTTPException(422, "Invalid capture fields or field length") from exc
    try:
        data = await file.read(MAX_CAPTURE_BYTES + 1)
        paired = getattr(request.state, "capture_client", None)
        original_request_id = str(fields.request_id)
        if paired:
            fields = fields.model_copy(update={"request_id": namespaced_request_id(paired["client_id"], fields.request_id)})
        result = await run_in_threadpool(capture_item, request.app.state.library_path, fields, data)
        enqueue_jobs(request.app.state.library_path)
        if paired:
            return _receipt(request.app.state.library_path, fields.request_id, original_request_id)
        return result
    except CaptureError as exc:
        raise HTTPException(exc.status, str(exc)) from exc
    except (OSError, sqlite3.Error) as exc:
        raise HTTPException(503, "Capture storage is unavailable; retry the same request ID") from exc
