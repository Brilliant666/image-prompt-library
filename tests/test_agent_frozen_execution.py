"""Execution must fail closed when an established frozen image is damaged."""
import pytest

from backend.services import agent_execution as execution
from backend.services.agent_repository import AgentError
from test_agent_frozen_assets import completed_output
from test_agent_image_selection import repo


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
