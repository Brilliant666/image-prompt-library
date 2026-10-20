"""History pagination must not sort or decode off-page inline image recipes."""
import json

import pytest

from backend.db import connect
from backend.schemas import GenerationJobCreate
from backend.services import generation_jobs
from backend.services.generation_jobs import GenerationJobRepository


@pytest.mark.parametrize("filters", [
    {}, {"status": "failed"}, {"statuses": ["failed", "queued"]},
])
def test_history_limits_large_recipe_reads_to_page_and_keeps_batch_counts(tmp_path, monkeypatch, filters):
    library = tmp_path / "library"
    repo = GenerationJobRepository(library)
    groups = [repo.create_job_set(GenerationJobCreate(
        provider="test_provider", prompt_text=f"Synthetic batch {index}",
    ), 3) for index in range(3)]
    jobs = [job for group in groups for job in group.jobs]
    large_parameters = json.dumps({"legacy_inline_input": "x" * (512 * 1024)})
    with connect(library) as conn:
        for index, job in enumerate(jobs):
            conn.execute(
                "UPDATE generation_jobs SET parameters=?, status=?, created_at=? WHERE id=?",
                (large_parameters, "failed" if index % 2 else "queued",
                 f"2026-01-{index + 1:02d}T00:00:00+00:00", job.id),
            )
        conn.commit()
    selected = [job.id for index, job in reversed(list(enumerate(jobs)))
                if not filters or "statuses" in filters or index % 2]
    expected_ids = selected[1:3]
    recipe_rows_read = []
    recipe_query_plans = []
    original_connect = generation_jobs.connect

    class Cursor:
        def __init__(self, cursor):
            self.cursor = cursor

        def fetchone(self):
            return self.cursor.fetchone()

        def fetchall(self):
            rows = self.cursor.fetchall()
            columns = {column[0] for column in self.cursor.description or []}
            if "parameters" in columns:
                recipe_rows_read.extend(row["id"] for row in rows)
            return rows

    class Connection:
        def __init__(self, connection):
            self.connection = connection

        def __enter__(self):
            return self

        def __exit__(self, *args):
            self.connection.close()

        def execute(self, sql, parameters=()):
            cursor = self.connection.execute(sql, parameters)
            if "parameters" in {column[0] for column in cursor.description or []}:
                recipe_query_plans.extend(
                    row["detail"] for row in self.connection.execute(
                        "EXPLAIN QUERY PLAN " + sql, parameters,
                    ).fetchall()
                )
            return Cursor(cursor)

    monkeypatch.setattr(generation_jobs, "connect", lambda path: Connection(original_connect(path)))
    result = repo.list_jobs(limit=2, offset=1, **filters)
    assert [job.id for job in result.jobs] == expected_ids
    assert result.total == len(selected)
    assert (result.status_counts.queued, result.status_counts.failed) == (5, 4)
    assert sorted(recipe_rows_read) == sorted(expected_ids)
    # Full recipes must be fetched through indexed identity lookups, never a
    # sorter/full scan. Count and ID-only queries may scan lightweight columns.
    assert recipe_query_plans
    assert all("SEARCH generation_jobs" in plan and "TEMP B-TREE" not in plan
               for plan in recipe_query_plans)
    assert all(job.parameters["legacy_inline_input"] == "x" * (512 * 1024) for job in result.jobs)
    for group in result.generation_sets:
        index = next(i for i, value in enumerate(groups) if value.generation_group_id == group.generation_group_id)
        assert (group.queued, group.failed) == ((2, 1) if index % 2 == 0 else (1, 2))
        assert group.jobs == []
    monkeypatch.undo()
    # Paginating leaves durable recipes untouched and detail reads complete.
    full_group = repo.get_generation_set(groups[0].generation_group_id)
    assert len(full_group.jobs) == 3
    assert all(job.parameters["legacy_inline_input"] == "x" * (512 * 1024) for job in full_group.jobs)
