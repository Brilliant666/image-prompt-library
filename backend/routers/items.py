from fastapi import APIRouter, HTTPException, Request
from backend.repositories import ItemRepository
from backend.schemas import ItemBatchRequest, ItemBatchResult, ItemCreate, ItemDetail, ItemList, ItemUpdate
from backend.services.capture_organizer import gallery_title_status
router = APIRouter()

def repo(request: Request): return ItemRepository(request.app.state.library_path)

def not_found(exc: KeyError):
    raise HTTPException(404, "Item not found") from exc

@router.get("/items", response_model=ItemList)
def list_items(request: Request, q: str | None=None, cluster: str | None=None, tag: str | None=None, favorite: bool | None=None, archived: bool | None=False, sort: str="updated_desc", limit: int=100, offset: int=0, trashed: bool=False):
    return repo(request).list_items(q=q, cluster=cluster, tag=tag, favorite=favorite, archived=archived, sort=sort, limit=min(limit,1000), offset=offset, trashed=trashed)

@router.post("/items", response_model=ItemDetail)
def create_item(request: Request, payload: ItemCreate):
    try: return repo(request).create_item(payload)
    except ValueError as exc: raise HTTPException(400, str(exc)) from exc

@router.post("/items/batch", response_model=ItemBatchResult)
def batch_items(request: Request, payload: ItemBatchRequest):
    if payload.action == "move_collection":
        payload.cluster_name = payload.cluster_name.strip() if payload.cluster_name else None
        if not (payload.cluster_id or payload.cluster_name):
            raise HTTPException(400, "cluster_id or cluster_name is required")
    try: return repo(request).batch_items(payload)
    except ValueError as exc: raise HTTPException(400, str(exc)) from exc

@router.get("/items/{item_id}", response_model=ItemDetail)
def get_item(request: Request, item_id: str):
    try: return repo(request).get_item(item_id, include_trashed=True)
    except KeyError as exc: not_found(exc)

@router.get("/items/{item_id}/gallery-title-status")
def get_gallery_title_status(request: Request, item_id: str):
    try: return gallery_title_status(request.app.state.library_path, item_id)
    except KeyError as exc: not_found(exc)

@router.patch("/items/{item_id}", response_model=ItemDetail)
def update_item(request: Request, item_id: str, payload: ItemUpdate):
    try: return repo(request).update_item(item_id, payload)
    except KeyError as exc: not_found(exc)
    except ValueError as exc: raise HTTPException(400, str(exc)) from exc

@router.delete("/items/{item_id}", response_model=ItemDetail)
def delete_item(request: Request, item_id: str):
    try: return repo(request).delete_item(item_id)
    except KeyError as exc: not_found(exc)

@router.post("/items/{item_id}/favorite", response_model=ItemDetail)
def favorite_item(request: Request, item_id: str):
    try: return repo(request).toggle_favorite(item_id)
    except KeyError as exc: not_found(exc)


@router.post("/items/{item_id}/restore", response_model=ItemDetail)
def restore_item(request: Request, item_id: str):
    try: return repo(request).restore_item(item_id)
    except KeyError as exc: not_found(exc)


@router.delete("/items/{item_id}/permanent", response_model=ItemDetail)
def permanently_delete_item(request: Request, item_id: str, confirmed: bool = False):
    if not confirmed:
        raise HTTPException(400, "Explicit confirmation is required for permanent deletion")
    try: return repo(request).purge_item(item_id)
    except KeyError as exc: not_found(exc)
    except ValueError as exc: raise HTTPException(409, str(exc)) from exc
