from fastapi import APIRouter, HTTPException, Request, Response

from backend.services.capture_clients import require_local_management
from backend.services.capture_organizer import OrganizerConfig, OrganizerError

router = APIRouter()


def _store(request, response):
    require_local_management(request)
    response.headers["Cache-Control"] = "no-store"
    return OrganizerConfig(request.app.state.library_path)


@router.get("/capture-organizer/config")
def get_config(request: Request, response: Response):
    try:
        return _store(request, response).public()
    except OrganizerError as exc:
        raise HTTPException(503, str(exc)) from None


@router.put("/capture-organizer/config")
async def save_config(request: Request, response: Response):
    store = _store(request, response)
    # Avoid Pydantic's input echo for credential-bearing payload validation.
    body = await request.body()
    if len(body) > 16 * 1024:
        raise HTTPException(413, "Organizer configuration is too large")
    try:
        payload = await request.json()
        if not isinstance(payload, dict):
            raise ValueError()
        return store.save(payload)
    except OrganizerError as exc:
        raise HTTPException(422, str(exc)) from None
    except (ValueError, TypeError, RecursionError):
        raise HTTPException(422, "Invalid organizer configuration") from None


@router.post("/capture-organizer/check")
def check_config(request: Request, response: Response):
    try:
        value = _store(request, response).public()
        return {**value, "message": "Configuration checked locally; no model request was sent"}
    except OrganizerError as exc:
        raise HTTPException(422, str(exc)) from None
