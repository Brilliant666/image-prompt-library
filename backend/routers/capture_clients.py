from fastapi import APIRouter, Request, Response
from pydantic import BaseModel, Field

from backend.services.capture_clients import require_local_management

router = APIRouter()


class PairCaptureClient(BaseModel):
    extension_id: str = Field(pattern=r"^[a-p]{32}$")
    name: str = Field(default="Browser capture", max_length=100)


@router.get("/capture-clients")
def list_clients(request: Request, response: Response):
    target = require_local_management(request)
    response.headers["Cache-Control"] = "no-store"
    return request.app.state.capture_clients.list(target)


@router.post("/capture-clients", status_code=201)
def pair_client(payload: PairCaptureClient, request: Request, response: Response):
    target = require_local_management(request)
    response.headers["Cache-Control"] = "no-store"
    return request.app.state.capture_clients.create(target, payload.extension_id, payload.name)


@router.delete("/capture-clients/{client_id}", status_code=204)
def revoke_client(client_id: str, request: Request):
    target = require_local_management(request)
    request.app.state.capture_clients.revoke(target, client_id)
    return Response(status_code=204, headers={"Cache-Control": "no-store"})
