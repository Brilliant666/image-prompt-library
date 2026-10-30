"""Synthetic supplier failures and measured image stages, never live services."""
import json

import httpx
import pytest

from backend.schemas import GenerationJobCreate
from backend.services.generation_jobs import GenerationJobRepository
from backend.services.openai_compatible import OpenAICompatibleProvider, OpenAICompatibleError
from test_openai_compatible import config, png


@pytest.mark.parametrize('status,code,kind', [
    (402, 'insufficient_quota', 'quota'),
    (404, 'model_not_found', 'model_unsupported'),
    (400, 'moderation_blocked', 'moderation'),
    (429, 'rate_limit_exceeded', 'rate_limit'),
    (503, 'server_error', 'service'),
    (400, 'unrecognized', 'unknown'),
])
def test_image_failure_is_structured_private_and_never_retried(config, status, code, kind):
    calls = []
    def respond(request):
        calls.append(request)
        return httpx.Response(status, json={'error': {'code': code,
            'message': 'PRIVATE PROMPT and https://private.invalid/?key=hidden',
            'arbitrary': 'PRIVATE RESPONSE'}}, headers={'x-request-id': 'private-upstream-identity'})
    repo = GenerationJobRepository(config.library_path)
    job = repo.create_job(GenerationJobCreate(provider='openai_compatible', prompt_text='Synthetic blue cube'))
    with httpx.Client(transport=httpx.MockTransport(respond)) as client:
        with pytest.raises(OpenAICompatibleError):
            OpenAICompatibleProvider(config, client).run_job(config.library_path, job.id)
    result = repo.get_job(job.id)
    assert result.status == 'failed'
    assert result.metadata['failure']['kind'] == kind
    assert not result.metadata['failure']['outcomeUnknown']
    rendered = json.dumps({'error': result.error, 'diagnostics': result.metadata['error_diagnostics']})
    assert all(value not in rendered for value in ['PRIVATE', 'private.invalid', 'private-upstream-identity', 'hidden'])
    assert result.metadata['execution']['timings']['providerMs'] >= 0
    assert len(calls) == 1


def test_disconnect_is_unknown_and_keeps_an_unmeasured_result_write(config):
    def respond(request):
        raise httpx.ReadTimeout('private transport error', request=request)
    repo = GenerationJobRepository(config.library_path)
    job = repo.create_job(GenerationJobCreate(provider='openai_compatible', prompt_text='Synthetic cube'))
    with httpx.Client(transport=httpx.MockTransport(respond)) as client:
        with pytest.raises(OpenAICompatibleError):
            OpenAICompatibleProvider(config, client).run_job(config.library_path, job.id)
    result = repo.get_job(job.id)
    assert result.metadata['failure']['outcomeUnknown'] is True
    assert result.metadata['execution']['timings']['resultWriteMs'] is None
    assert result.metadata['execution']['timings']['providerMs'] >= 0


def test_legacy_diagnostics_are_redacted_on_read_without_rewriting_history(config):
    from backend.db import connect
    repo = GenerationJobRepository(config.library_path)
    job = repo.create_job(GenerationJobCreate(provider='manual_upload', prompt_text='Synthetic cube'))
    metadata = {'error_diagnostics': {'http_status': 402, 'category': 'api_error',
        'endpoint': 'https://private.invalid', 'error': {'code': 'insufficient_quota', 'message': 'PRIVATE PROMPT'}}}
    raw = json.dumps(metadata)
    with connect(config.library_path) as conn:
        conn.execute("UPDATE generation_jobs SET status='failed',error=?,metadata=? WHERE id=?", ('PRIVATE PROMPT raw JSON', raw, job.id))
        conn.commit()
    result = repo.get_job(job.id)
    assert result.metadata['failure']['kind'] == 'quota'
    assert 'PRIVATE' not in result.model_dump_json()
    with connect(config.library_path) as conn:
        saved = conn.execute('SELECT metadata FROM generation_jobs WHERE id=?', (job.id,)).fetchone()[0]
    assert saved == raw


def test_queue_time_uses_same_process_monotonic_origin_and_restart_is_unknown(config, monkeypatch):
    from backend.services import generation_jobs
    ticks = iter([10.0, 12.75, 20.0])
    monkeypatch.setattr(generation_jobs.time, 'monotonic', lambda: next(ticks))
    repo = GenerationJobRepository(config.library_path)
    job = repo.create_job(GenerationJobCreate(provider='manual_upload', prompt_text='Synthetic cube'))
    # Execution may be claimed through a different repository in the same worker.
    claimed = GenerationJobRepository(config.library_path).mark_running(job.id)
    assert claimed.metadata['execution']['timings']['queueMs'] == 2750
    other = repo.create_job(GenerationJobCreate(provider='manual_upload', prompt_text='Synthetic sphere'))
    with generation_jobs._QUEUE_CLOCK_LOCK:
        generation_jobs._QUEUE_CLOCKS.pop((str(config.library_path.resolve()), other.id))
    claimed = repo.mark_running(other.id)
    assert claimed.metadata['execution']['timings']['queueMs'] is None


def test_measured_success_and_late_timing_failure_never_changes_result(config, monkeypatch, caplog):
    repo = GenerationJobRepository(config.library_path)
    job = repo.create_job(GenerationJobCreate(provider='openai_compatible', prompt_text='Synthetic cube'))
    provider = OpenAICompatibleProvider(config)
    monkeypatch.setattr(provider, 'generate', lambda *args, **kwargs: (png(), 'test.png', {'request_diagnostics': {'provider_ms': 120}}))
    record = GenerationJobRepository._record_execution
    def late_failure(self, job_id, phase=None, **durations):
        if phase == 'completed':
            raise OSError('synthetic metrics write failure')
        return record(self, job_id, phase, **durations)
    monkeypatch.setattr(GenerationJobRepository, '_record_execution', late_failure)
    result = provider.run_job(config.library_path, job.id)
    assert result.status == 'succeeded'
    assert 'Execution timing was not recorded (OSError)' in caplog.text
    assert 'synthetic metrics' not in caplog.text
    assert repo.get_job(job.id).status == 'succeeded'
    assert repo.get_job(job.id).result_path


def test_timing_write_failure_before_dispatch_does_not_leave_running_job(config, monkeypatch, caplog):
    import sqlite3
    repo = GenerationJobRepository(config.library_path)
    job = repo.create_job(GenerationJobCreate(provider='openai_compatible', prompt_text='Synthetic cube'))
    calls = []
    provider = OpenAICompatibleProvider(config)
    def generate(*args, **kwargs):
        calls.append(True)
        return png(), 'test.png', {}
    monkeypatch.setattr(provider, 'generate', generate)
    def unavailable_measurement(*args, **kwargs):
        raise sqlite3.OperationalError('synthetic timing write failed')
    monkeypatch.setattr(GenerationJobRepository, '_record_execution', unavailable_measurement)
    provider.run_job(config.library_path, job.id)
    assert repo.get_job(job.id).status == 'succeeded'
    assert len(calls) == 1
    assert 'Execution timing was not recorded (OperationalError)' in caplog.text
    assert repo.get_job(job.id).metadata['execution']['timings']['providerMs'] is None
