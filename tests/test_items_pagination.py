import pytest
from fastapi.testclient import TestClient

from backend.db import connect
from backend.main import create_app


@pytest.mark.parametrize("query", [{}, {"q": "PaginationProbe"}, {"cluster": "collection-a"}, {"tag": "pagination"}])
def test_filtered_item_pages_continue_past_one_thousand(tmp_path, query):
    library = tmp_path / "library"
    client = TestClient(create_app(library_path=library))
    stamp = "2026-01-01T00:00:00Z"
    ids = [f"pagination-{index:04d}" for index in range(1001)]
    with connect(library) as conn:
        conn.execute("INSERT INTO clusters(id,name,created_at,updated_at) VALUES(?,?,?,?)", ("collection-a", "Pagination", stamp, stamp))
        conn.execute("INSERT INTO tags(id,name,created_at) VALUES(?,?,?)", ("pagination-tag", "pagination", stamp))
        conn.executemany("INSERT INTO items(id,title,slug,cluster_id,created_at,updated_at) VALUES(?,?,?,?,?,?)", [
            (item_id, "PaginationProbe", item_id, "collection-a", stamp, stamp) for item_id in reversed(ids)
        ])
        conn.executemany("INSERT INTO item_tags(item_id,tag_id) VALUES(?,?)", [(item_id, "pagination-tag") for item_id in ids])
        conn.commit()
    collected = []
    for offset in range(0, 1001, 100):
        response = client.get("/api/items", params={**query, "sort": "updated_desc", "limit": 100, "offset": offset})
        assert response.status_code == 200
        result = response.json()
        assert result["total"] == 1001
        assert result["offset"] == offset
        assert result["limit"] == 100
        collected.extend(item["id"] for item in result["items"])
    assert collected == ids
    assert client.get("/api/items", params={**query, "limit": 100, "offset": 1001}).json()["items"] == []


@pytest.mark.parametrize("sort", ["updated_desc", "created_desc", "created_asc", "title_asc", "title_desc", "source_asc", "model_asc"])
def test_item_pagination_has_a_stable_unique_tie_breaker(tmp_path, sort):
    library = tmp_path / "library"
    client = TestClient(create_app(library_path=library))
    stamp = "2026-01-01T00:00:00Z"
    ids = ["a", "b", "c", "d"]
    with connect(library) as conn:
        conn.executemany("INSERT INTO items(id,title,slug,created_at,updated_at) VALUES(?,?,?,?,?)", [
            (item_id, "Same title", item_id, stamp, stamp) for item_id in reversed(ids)
        ])
        conn.commit()
    first = client.get("/api/items", params={"sort": sort, "limit": 2}).json()
    second = client.get("/api/items", params={"sort": sort, "limit": 2, "offset": 2}).json()
    assert [item["id"] for item in first["items"] + second["items"]] == ids
