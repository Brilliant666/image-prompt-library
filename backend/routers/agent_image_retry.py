from fastapi import APIRouter, Path, Query, Request
from fastapi.responses import JSONResponse

from backend.routers.generation_jobs import _sanitize_generation_job_record
from backend.services.agent_image_retry import AgentImageRetryCreate, AgentImageRetryRepository
from backend.services.generation_queue import enqueue_generation_jobs

router = APIRouter(prefix='/generation-jobs', tags=['agent'])


def public_receipt(receipt):
    return {**receipt, 'job': _sanitize_generation_job_record(receipt['job']).model_dump()}


@router.get('/retry-submissions/{retry_id}')
def get_retry(request: Request, retry_id: str = Path(..., min_length=1, max_length=100, pattern=r'^[A-Za-z0-9_-]+$'),
              conversation_id: str = Query(..., min_length=1, max_length=100, pattern=r'^[A-Za-z0-9_-]+$')):
    return public_receipt(AgentImageRetryRepository(request.app.state.library_path).receipt(retry_id, conversation_id))


@router.post('/{job_id}/retry-current')
def create_retry(job_id: str, payload: AgentImageRetryCreate, request: Request):
    receipt, created = AgentImageRetryRepository(request.app.state.library_path).create(job_id, payload)
    if created:
        enqueue_generation_jobs(request.app.state.library_path, provider='openai_compatible')
    return JSONResponse(public_receipt(receipt), status_code=202 if created else 200)
