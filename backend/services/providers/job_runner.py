"""Shared API-key image lifecycle; local recovery always precedes paid retry.

Extracted from the existing OpenAI-compatible runner without changing its claim,
freeze, preview, finality or recovery behavior. Legacy OAuth and Native executors
remain separate and continue using the original queue/receipt guards.
"""
from pathlib import Path
import time
from backend.services.generation_jobs import GenerationJobRepository, GenerationJobConflict
from backend.services.agent_diagnostics import safe_diagnostics


def run_image_job(provider, library_path, job_id, *, provider_id, error_type,
                  repository_factory=GenerationJobRepository):
    repo = repository_factory(library_path)
    job = repo.get_job(job_id)
    if job.provider != provider_id:
        raise GenerationJobConflict("Generation job provider must be openai_compatible")
    if job.status == "succeeded":
        return job
    if job.status != "queued":
        raise GenerationJobConflict("Generation job must be queued; failed paid jobs require explicit resubmission")
    # The earlier read is not a claim: another dispatcher may have already
    # called this paid request and persisted its failure in the meantime.
    repo.mark_running(job_id, queued_only=True)
    preparation_started = time.monotonic()
    try:
        repo.record_execution(job_id, 'preparing')
        provider.config.validate_path(library_path)
        prompt = job.edited_prompt_text if job.edited_prompt_text is not None else (job.prompt_text or "")
        if not prompt.strip():
            raise error_type("Generation prompt is required")
        inputs = provider._input_images(job, Path(library_path))
        if getattr(job, "mode", "text_to_image") in {"image_edit", "text_reference_to_image"} and not inputs:
            raise error_type("This generation mode requires a reference image")
        parameters = dict(job.parameters or {})
        # Old jobs belonged to the original single provider, never a later default.
        parameters.setdefault("compatible_profile_id", "legacy")
        # Old queued tasks must keep their original nonstreaming request behavior.
        for key, value in {"base_url_mode": "versioned", "stream": False, "partial_images": 0, "response_format": "auto"}.items():
            parameters.setdefault(key, value)
        if getattr(job, "model", None):
            parameters["model"] = job.model
        if not parameters.get("model"):
            parameters["model"] = ((getattr(job, "metadata", {}) or {}).get("requested") or {}).get("model")
        if not parameters.get("model"):
            raise error_type("This legacy job has no frozen request model; select a model and create a new task before generating")
        repo.record_execution(job_id, 'generating', preparationMs=(time.monotonic() - preparation_started) * 1000)
        data, filename, metadata = provider.generate(prompt, parameters, inputs,
            on_partial=lambda data, metadata: repo.stage_stream_preview(job_id, data, metadata))
        metadata["source_job_id"] = job_id
        provider_ms = (metadata.get('request_diagnostics') or {}).get('provider_ms')
        if 'request_diagnostics' in metadata:
            metadata['request_diagnostics'] = safe_diagnostics(metadata['request_diagnostics'])
        write_started = time.monotonic()
        repo.stage_result(job_id, data, filename, metadata, job_snapshot=job)
        repo.record_execution(job_id, 'processing_results', providerMs=provider_ms)
    except Exception as exc:
        # A result receipt that was persisted must never be reclassified by
        # a later instrumentation/read failure.
        if repo.get_job(job_id).status in {'succeeded', 'accepted'}:
            raise
        if isinstance(repo.local_result_recovery(job_id), dict):
            # A provider success followed by a local write failure is not a
            # failed paid request. The original receipt can be repaired.
            return repo.get_job(job_id)
        message = str(exc) if isinstance(exc, error_type) else "Compatible image generation failed; no automatic retry was attempted"
        diagnostics = exc.diagnostics if isinstance(exc, error_type) else {"category": "internal_error"}
        repo.mark_failed(job_id, message, diagnostics=diagnostics)
        repo.record_execution(job_id, 'failed', providerMs=diagnostics.get('provider_ms'))
        raise error_type(message, diagnostics) from None
    repo.record_execution(job_id, 'completed', resultWriteMs=(time.monotonic() - write_started) * 1000)
    return repo.get_job(job_id)
