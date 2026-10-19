import json
import sqlite3

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from pydantic import ValidationError
from starlette.concurrency import run_in_threadpool

from backend.schemas import ItemDetail
from backend.services.prompt_language import MAX_PROMPT_CHARACTERS, LanguageDetection, LanguageDetectionRequest, detect_prompt_language
from backend.services.quick_capture import MAX_CAPTURE_BYTES, CaptureError, CaptureFields, capture_item

router = APIRouter()


@router.post("/captures/detect-language", response_model=LanguageDetection)
def detect_language(payload: LanguageDetectionRequest):
    return detect_prompt_language(payload.text)


@router.post("/captures", response_model=ItemDetail)
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
        return await run_in_threadpool(capture_item, request.app.state.library_path, fields, data)
    except CaptureError as exc:
        raise HTTPException(exc.status, str(exc)) from exc
    except (OSError, sqlite3.Error) as exc:
        raise HTTPException(503, "Capture storage is unavailable; retry the same request ID") from exc
