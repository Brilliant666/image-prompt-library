"""Execution must fail closed when an established frozen image is damaged."""
import httpx
import pytest

from backend.services import agent_execution as execution
from backend.services.agent_repository import AgentError
from test_agent_frozen_assets import add_round, completed_output
from test_agent_image_selection import repo
from test_agent_workspaces import image_bytes


def test_execution_does_not_hide_invalid_frozen_result(repo):
    _, job_id = completed_output(repo, "result")
    asset_id = repo.resolve_ref({"kind": "job", "jobId": job_id})
    (repo.library / repo.asset(asset_id)["path"]).unlink()

    with pytest.raises(AgentError, match="已冻结") as failure:
        execution.refs_for_request(repo, repo.request("result"))
    assert failure.value.code == "frozen_reference_invalid"


def test_never_frozen_removed_result_retains_explicit_missing_slot(repo):
    _, job_id = completed_output(repo, "result")
    repo.jobs.discard_job(job_id)

    refs = execution.refs_for_request(repo, repo.request("result"))
    assert refs == {"round-1-image-1": None}


def test_worker_marks_changed_snapshot_as_known_preflight_failure_without_post(repo, monkeypatch):
    root, job_id = completed_output(repo, "result")
    request, _ = add_round(repo, "pending", root)
    frozen = request["history"][0]["frozenOutputImages"][0]
    (repo.library / repo.asset(frozen)["path"]).write_bytes(image_bytes("red"))
    posts = []

    def unexpected_post(request):
        posts.append(request)
        return httpx.Response(200, json={"status": "completed", "output": []})

    monkeypatch.setattr(httpx, "HTTPTransport", lambda **kwargs: httpx.MockTransport(unexpected_post))
    execution.run_request(repo.library, "pending")
    final = repo.request("pending")
    assert posts == []
    assert final["state"] == "failed"
    assert final["upstream_outcome"] == "known"
    assert final["error"]["code"] == "frozen_reference_invalid"
    assert final["usage"]["imageJobsCreated"] == 0
    assert repo.jobs.get_job(job_id).status == "succeeded"
