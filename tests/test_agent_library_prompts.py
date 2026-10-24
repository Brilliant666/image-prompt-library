"""Library acceptance resolves Agent-only references without rewriting its recipe."""
import hashlib
from io import BytesIO

from PIL import Image

from backend.db import connect
from backend.schemas import GenerationJobAcceptAsNewItemRequest, GenerationJobCreate, ItemCreate, PromptIn
from backend.services.agent_execution import create_image_job
from test_agent_image_selection import body, repo


def png(color):
    stream = BytesIO()
    Image.new("RGB", (24, 16), color).save(stream, "PNG")
    return stream.getvalue()


def ready_agent_job(repo, prompt, *, repeated_asset=False):
    repo.create_round("conversation", body(repo))
    first, second = png("orange"), png("blue")
    first_id = repo.store_asset(first, None)["id"]
    second_id = first_id if repeated_asset else repo.store_asset(second, None)["id"]
    refs = {"round-1-reference-1": first_id, "round-1-reference-2": second_id}
    job = create_image_job(repo, "request", 1, "call", "single", prompt, refs)
    repo.jobs.stage_result(job.id, png("green"), "result.png")
    return repo.jobs.get_job(job.id), first, first if repeated_asset else second


def test_library_acceptance_uses_readable_reference_order_and_preserves_exact_recipe(repo):
    raw = '  根据 <ref id="round-1-reference-2" />\n融合 <ref id="round-1-reference-1" />，再看 <ref id="round-1-reference-2" />。  '
    job, first, second = ready_agent_job(repo, raw)
    before = repo.request("request")
    accepted = repo.jobs.accept_result_as_new_item(job.id)
    prompt = accepted.item.prompts[0]
    assert prompt.text == '  根据 【参考图1】\n融合 【参考图2】，再看 【参考图1】。  '
    provenance = prompt.provenance["agent_reference_prompt"]
    assert provenance["raw_text"] == raw
    assert provenance["references"] == [
        {"id": "round-1-reference-2", "label": "参考图1", "input_index": 1, "sha256": hashlib.sha256(second).hexdigest()},
        {"id": "round-1-reference-1", "label": "参考图2", "input_index": 2, "sha256": hashlib.sha256(first).hexdigest()},
    ]
    refs = [image for image in accepted.item.images if image.role == "reference_image"]
    assert [(repo.library / image.original_path).read_bytes() for image in refs] == [second, first]
    persisted = repo.jobs.get_job(job.id)
    assert persisted.prompt_text == raw
    assert persisted.parameters == job.parameters
    assert repo.request("request")["body"] == before["body"]
    assert repo.request("request")["history"] == before["history"]


def test_unrelated_literal_tags_and_explicit_prompt_override_are_not_rewritten(repo):
    raw = 'Keep <ref id="round-1-reference-1" /> as the source.'
    job, _, _ = ready_agent_job(repo, raw)
    manual = 'Example XML: <ref id="round-1-reference-1" />; user wording stays exact.  '
    accepted = repo.jobs.accept_result_as_new_item(job.id, GenerationJobAcceptAsNewItemRequest(
        prompts=[PromptIn(language="en", text=manual, is_original=True, is_primary=True)],
    ))
    assert accepted.item.prompts[0].text == manual
    assert "agent_reference_prompt" not in accepted.item.prompts[0].provenance
    assert repo.jobs.get_job(job.id).prompt_text == raw


def test_ordinary_gallery_literal_reference_xml_is_preserved(repo):
    raw = 'Document literal XML: <ref id="round-1-reference-1" />  '
    job = repo.jobs.create_job(GenerationJobCreate(provider="manual_upload", prompt_text=raw))
    repo.jobs.stage_result(job.id, png("green"), "result.png")
    accepted = repo.jobs.accept_result_as_new_item(job.id)
    assert accepted.item.prompts[0].text == raw
    assert "agent_reference_prompt" not in accepted.item.prompts[0].provenance


def test_duplicate_asset_labels_follow_library_reference_deduplication(repo):
    raw = '<ref id="round-1-reference-1" /> and <ref id="round-1-reference-2" />'
    job, _, _ = ready_agent_job(repo, raw, repeated_asset=True)
    accepted = repo.jobs.accept_result_as_new_item(job.id)
    assert accepted.item.prompts[0].text == '【参考图1】 and 【参考图1】'
    assert len([image for image in accepted.item.images if image.role == "reference_image"]) == 1


def test_only_known_exact_markers_are_resolved_and_existing_library_is_untouched(repo):
    raw = 'Use <ref id="round-1-reference-1" />'
    job, _, _ = ready_agent_job(repo, raw)
    old = repo.jobs.items.create_item(ItemCreate(title="Existing archive", prompts=[PromptIn(language="en", text=raw)]))
    edited = raw + '\nLiteral <ref id="round-99-image-1" /> and <ref id="example" /> and &lt;ref id="round-1-reference-1" /&gt;'
    with connect(repo.library) as connection:
        connection.execute("UPDATE generation_jobs SET edited_prompt_text=? WHERE id=?", (edited, job.id))
        connection.commit()
    accepted = repo.jobs.accept_result_as_new_item(job.id)
    assert accepted.item.prompts[0].text == edited.replace('<ref id="round-1-reference-1" />', '【参考图1】')
    assert accepted.item.prompts[0].provenance["agent_reference_prompt"]["raw_text"] == edited
    assert repo.jobs.get_job(job.id).prompt_text == raw
    assert repo.jobs.get_job(job.id).edited_prompt_text == edited
    assert repo.jobs.items.get_item(old.id).prompts[0].text == raw


def test_agent_metadata_without_real_tool_job_link_does_not_rewrite_literal_xml(repo):
    raw = 'Literal <ref id="round-1-reference-1" />'
    asset = repo.store_asset(png("orange"), None)
    job = repo.jobs.create_job(GenerationJobCreate(
        provider="manual_upload", prompt_text=raw,
        parameters={"input_images": [{"result_path": repo.asset(asset["id"])["path"], "name": "round-1-reference-1"}]},
    ), metadata={"agent": {"requestId": "unknown"}})
    repo.jobs.stage_result(job.id, png("green"), "result.png")
    accepted = repo.jobs.accept_result_as_new_item(job.id)
    assert accepted.item.prompts[0].text == raw
    assert "agent_reference_prompt" not in accepted.item.prompts[0].provenance
