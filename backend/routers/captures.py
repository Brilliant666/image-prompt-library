import json
import sqlite3
import uuid

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from pydantic import BaseModel, ValidationError
from starlette.concurrency import run_in_threadpool

from backend.db import connect
from backend.schemas import ItemDetail
from backend.services.capture_clients import namespaced_request_id
from backend.services.prompt_language import MAX_PROMPT_CHARACTERS, LanguageDetection, LanguageDetectionRequest, detect_prompt_language
from backend.services.quick_capture import MAX_CAPTURE_BYTES, CaptureError, CaptureFields, capture_item

router = APIRouter()


class CaptureReceipt(BaseModel):
    request_id: uuid.UUID
    item_id: str


def _paired_client(request: Request):
    client = getattr(request.state, "capture_client", None)
    if client is None:
        raise HTTPException(403, "A valid browser capture pairing is required")
    return client


@router.get("/captures/connection")
@router.post("/captures/connection")
def capture_connection(request: Request):
    return _paired_client(request)


@router.get("/captures/receipts/{request_id}", response_model=CaptureReceipt)
@router.post("/captures/receipts/{request_id}", response_model=CaptureReceipt)
def capture_receipt(request_id: uuid.UUID, request: Request):
    client = _paired_client(request)
    with connect(request.app.state.library_path) as conn:
        row = conn.execute("SELECT item_id FROM capture_requests WHERE request_id=?",
                           (str(namespaced_request_id(client["client_id"], request_id)),)).fetchone()
    if row is None:
        raise HTTPException(404, "No saved receipt for this request")
    if row["item_id"] is None:
        raise HTTPException(410, "The captured item was deleted; it will not be recreated")
    return {"request_id": str(request_id), "item_id": row["item_id"]}


@router.post("/captures/detect-language", response_model=LanguageDetection)
def detect_language(payload: LanguageDetectionRequest):
    return detect_prompt_language(payload.text)


@router.post("/captures", response_model=ItemDetail | CaptureReceipt)
async def capture(request: Request, file: UploadFile = File(...), prompt_text: str | None = Form(None),
                  prompt_text_json: str | None = Form(None),
                  request_id: str = Form(...), language: str = Form("auto"), title: str = Form(""),
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
                               title=title, source_name=source_name, source_url=source_url, notes=notes)
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
        if paired:
            return CaptureReceipt(request_id=original_request_id, item_id=result.id)
        return result
    except CaptureError as exc:
        raise HTTPException(exc.status, str(exc)) from exc
    except (OSError, sqlite3.Error) as exc:
        raise HTTPException(503, "Capture storage is unavailable; retry the same request ID") from exc
