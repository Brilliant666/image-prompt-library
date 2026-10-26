"""Explicit image-only retries using the existing generation queue and snapshots."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field
from typing import Literal

from backend.agent_schemas import AgentImageConfig
from backend.db import connect
from backend.schemas import GenerationJobCreate
from backend.services.agent_diagnostics import classify_failure, safe_diagnostics
from backend.services.agent_repository import AgentError, AgentRepository, encoded, fingerprint
from backend.services.generation_jobs import (
    GenerationJobRepository, _remember_queue_start, now, resolve_generation_input_image_path,
    sanitize_generation_parameters,
)
from backend.services.openai_compatible import OpenAICompatibleConfig, OpenAICompatibleError, OpenAICompatibleProvider


class RetryParams(BaseModel):
    model_config = ConfigDict(extra='forbid')
    size: str | None = None
    quality: str | None = None
    output_format: Literal['png', 'jpeg', 'webp'] | None = None
    output_compression: int | None = Field(default=None, ge=0, le=100)
    moderation: Literal['auto', 'low'] | None = None
    background: Literal['auto', 'opaque', 'transparent'] | None = None


class AgentImageRetryCreate(BaseModel):
    model_config = ConfigDict(extra='forbid')
    retryId: str = Field(min_length=1, max_length=100, pattern=r'^[A-Za-z0-9_-]+$')
    conversationId: str = Field(min_length=1, max_length=100, pattern=r'^[A-Za-z0-9_-]+$')
    configRevision: int = Field(ge=0)
    imageConfig: AgentImageConfig
    params: RetryParams | None = None
    confirmed: Literal[True]


def retry_job_id(retry_id):
    return 'gen_retry_' + hashlib.sha256(retry_id.encode('utf-8')).hexdigest()


def _link(job):
    return (job.metadata or {}).get('agentRetry') or (job.metadata or {}).get('agent') or {}


def _known_failure(job):
    diagnostics = (job.metadata or {}).get('error_diagnostics') or {}
    failure = classify_failure(diagnostics)
    if failure['outcomeUnknown'] or not (
        type(diagnostics.get('http_status')) is int and diagnostics['http_status'] >= 400
        or failure['kind'] in {'quota', 'model_unsupported', 'moderation', 'rate_limit', 'authentication', 'reference_missing'}
        or diagnostics.get('category') == 'local_validation'
    ):
        raise AgentError('retry_outcome_unknown', '原图片请求的结果尚未确认，请先核对原请求；不会自动重放。')


class AgentImageRetryRepository:
    def __init__(self, library):
        self.library = Path(library)
        self.jobs = GenerationJobRepository(library)

    def receipt(self, retry_id, conversation_id):
        try:
            job = self.jobs.get_job(retry_job_id(retry_id))
        except KeyError:
            raise AgentError('not_found', '尚未找到这次图片重试，请保留原提交身份。', 404) from None
        link = (job.metadata or {}).get('agentRetry', {})
        if link.get('retryId') != retry_id or link.get('conversationId') != conversation_id:
            raise AgentError('not_found', '图片重试不存在。', 404)
        with connect(self.library) as conn:
            AgentRepository(self.library)._conversation(conn, conversation_id)
        return {'retryId': retry_id, 'sourceJobId': link['sourceJobId'], 'job': job}

    def _source(self, conn, job_id, conversation_id):
        row = conn.execute('SELECT * FROM generation_jobs WHERE id=?', (job_id,)).fetchone()
        if not row:
            raise AgentError('not_found', '原图片任务不存在。', 404)
        job = self.jobs._record_from_row(row)
        link = _link(job)
        round_row = conn.execute('SELECT data FROM agent_rounds WHERE id=? AND conversation_id=? AND deleted=0',
                                 (link.get('roundId'), conversation_id)).fetchone()
        conversation = conn.execute('SELECT id FROM agent_conversations WHERE id=? AND deleted=0', (conversation_id,)).fetchone()
        if not conversation or not round_row or link.get('conversationId') != conversation_id:
            raise AgentError('not_found', '原图片任务不属于此会话的有效轮次。', 404)
        root_id = link.get('rootSourceJobId') or job.id
        if root_id not in json.loads(round_row['data']).get('outputTaskIds', []):
            raise AgentError('not_found', '原图片任务的来源记录不可用。', 404)
        if job.provider != 'openai_compatible':
            raise AgentError('capability_unsupported', '原生 Responses 图片请使用“修改提示词后重新生成”；不会转换为 Images API。', 400)
        if job.status != 'failed':
            raise AgentError('retry_not_failed', '只能直接重试已明确失败的图片任务。')
        _known_failure(job)
        root = conn.execute('SELECT metadata FROM generation_jobs WHERE id=?', (root_id,)).fetchone()
        if not root:
            raise AgentError('not_found', '原图片任务的来源记录不可用。', 404)
        # The root tracks the latest attempt across retry-of-retry branches.
        # Traverse older chains as well, rather than treating a failed parent
        # as permission to bypass its still-running child.
        for metadata in (json.loads(root['metadata']), job.metadata or {}):
            previous_id = metadata.get('latestRetryJobId') or metadata.get('retried_by_generation_job_id')
            visited = set()
            while previous_id:
                if previous_id in visited or len(visited) >= 1000:
                    raise AgentError('retry_pending', '重试来源链需要核对，不会重复提交。')
                visited.add(previous_id)
                previous = conn.execute('SELECT * FROM generation_jobs WHERE id=?', (previous_id,)).fetchone()
                if not previous or previous['status'] != 'failed':
                    raise AgentError('retry_pending', '原图片已有重试，请先检查该任务，不会重复提交。')
                previous_job = self.jobs._record_from_row(previous)
                _known_failure(previous_job)
                previous_id = previous_job.metadata.get('latestRetryJobId') or previous_job.metadata.get('retried_by_generation_job_id')
        return job, link, root_id

    def _references(self, conn, job):
        """Use only the original frozen file, never refresh a mutable Library source."""
        inputs = (job.parameters or {}).get('input_images') or []
        if not isinstance(inputs, list) or len(inputs) > 4:
            raise AgentError('reference_missing', '原始参考图片记录无效。', 400)
        if not inputs and (job.mode in {'image_edit', 'text_reference_to_image'}
                           or job.reference_image_ids or (job.metadata or {}).get('reference_image_copies')):
            raise AgentError('reference_missing', '原始参考图片缺失，请明确重新选择图片。', 400)
        specs, hashes = [], []
        expected = {item.get('path'): item.get('sha256') for item in (job.metadata or {}).get('agentRetry', {}).get('referenceHashes', [])}
        expected.update({item.get('copied_path'): item.get('sha256') for item in (job.metadata or {}).get('reference_image_copies', []) if isinstance(item, dict)})
        for raw in inputs:
            path_value = raw.get('result_path') if isinstance(raw, dict) else None
            try:
                if not isinstance(path_value, str) or not path_value:
                    raise ValueError('missing snapshot')
                path, _ = resolve_generation_input_image_path(self.library, path_value, allowed_roots={'generation-references'})
                row = conn.execute('SELECT sha256 FROM agent_assets WHERE path=?', (path_value,)).fetchone()
                digest = row['sha256'] if row else expected.get(path_value)
                if not digest or hashlib.sha256(path.read_bytes()).hexdigest() != digest:
                    raise ValueError('snapshot mismatch')
            except (OSError, ValueError):
                raise AgentError('reference_missing', '原始冻结参考图片缺失或已改变；不会使用其他图片替代。', 400) from None
            specs.append({'result_path': path_value, 'name': str(raw.get('name') or 'reference')})
            hashes.append({'path': path_value, 'sha256': digest})
        return specs, hashes

    def create(self, source_job_id, body: AgentImageRetryCreate):
        serialized = body.model_dump(exclude_none=True)
        if body.params is not None:
            # An explicit null clears an optional recorded setting; it must not
            # share the same submission identity as an omitted override.
            serialized['params'] = body.params.model_dump(exclude_unset=True)
        request_fingerprint = fingerprint({'sourceJobId': source_job_id, **serialized})
        job_id = retry_job_id(body.retryId)
        # Receipt replay precedes current-config/source checks: an acknowledged
        # submission stays readable after the user changes settings or assets.
        try:
            old = self.receipt(body.retryId, body.conversationId)
        except AgentError as exc:
            if exc.status != 404:
                raise
        else:
            if old['job'].metadata['agentRetry']['payloadFingerprint'] != request_fingerprint:
                raise AgentError('request_id_conflict', '此重试身份已用于不同请求。')
            return old, False
        agent = AgentRepository(self.library)
        document = agent.config()
        if document['revision'] != body.configRevision:
            raise AgentError('config_revision_conflict', 'Agent 设置已改变，请重新确认本次生图配置。')
        if document['config']['apiConfigMode'] != 'hybrid':
            raise AgentError('capability_unsupported', '直接图片重试仅用于 Hybrid Images 模式；原生模式请修改后重新生成。', 400)
        profile_id = body.imageConfig.profileId or document['config']['imageProfileId']
        if not profile_id:
            raise AgentError('configuration_incomplete', '请选择本次重试使用的生图供应商。', 400)
        try:
            profile = OpenAICompatibleConfig(library_path=self.library).read(profile_id)
        except (ValueError, OpenAICompatibleError):
            raise AgentError('configuration_incomplete', '所选生图供应商不存在。', 400) from None
        model = body.imageConfig.model.strip() or profile['model'].strip()
        if not profile['api_key'] or not profile['base_url'] or not model:
            raise AgentError('configuration_incomplete', '所选生图供应商或模型配置不完整。', 400)
        timestamp = now()
        with connect(self.library) as conn:
            conn.execute('BEGIN IMMEDIATE')
            existing = conn.execute('SELECT * FROM generation_jobs WHERE id=?', (job_id,)).fetchone()
            if existing:
                job = self.jobs._record_from_row(existing)
                if (job.metadata or {}).get('agentRetry', {}).get('payloadFingerprint') != request_fingerprint:
                    raise AgentError('request_id_conflict', '此重试身份已用于不同请求。')
                return {'retryId': body.retryId, 'sourceJobId': source_job_id, 'job': job}, False
            job, source, root_id = self._source(conn, source_job_id, body.conversationId)
            inputs, reference_hashes = self._references(conn, job)
            parameters = dict(job.parameters or {})
            requested = (job.metadata or {}).get('requested', {})
            for key in ('size', 'quality', 'background', 'output_format', 'output_compression', 'moderation', 'requested_aspect_ratio', 'aspect_ratio_prompt_injection'):
                if isinstance(requested, dict) and key in requested:
                    parameters[key] = requested[key]
            if body.params:
                for key, value in body.params.model_dump(exclude_unset=True).items():
                    if value is None:
                        parameters.pop(key, None)
                    else:
                        parameters[key] = value
            for key in ('compatible_profile_name', 'base_url_mode', 'stream', 'partial_images', 'response_format'):
                parameters.pop(key, None)
            parameters.update(compatible_profile_id=profile_id, model=model, input_images=inputs)
            try:
                payload = self.jobs._freeze_compatible_request(GenerationJobCreate(provider='openai_compatible', model=model,
                    prompt_text=job.prompt_text, edited_prompt_text=job.edited_prompt_text, parameters=parameters, mode=job.mode))
            except (ValueError, OpenAICompatibleError) as exc:
                raise AgentError('invalid_parameters', '重试参数无效，请检查当前供应商的图片参数。', 400) from None
            parameters, copies = self.jobs._prepare_reference_input_clones(job_id, payload.parameters)
            parameters = sanitize_generation_parameters(parameters)
            lineage = {'retryId': body.retryId, 'payloadFingerprint': request_fingerprint,
                'conversationId': body.conversationId, 'roundId': source['roundId'],
                'sourceRequestId': source.get('sourceRequestId') or source.get('requestId'),
                'sourceJobId': job.id, 'rootSourceJobId': root_id,
                'profileId': profile_id, 'profileDigest': fingerprint(profile), 'referenceHashes': reference_hashes}
            metadata = {'agentRetry': lineage, 'retry_of_generation_job_id': job.id, 'retry_reason': 'agent_current_config',
                        **({'reference_image_copies': copies} if copies else {})}
            metadata = sanitize_generation_parameters(metadata, redact_image_data=True)
            conn.execute('''INSERT INTO generation_jobs(id,source_item_id,mode,provider,model,status,prompt_language,
                prompt_text,edited_prompt_text,reference_image_ids,parameters,metadata,created_at,updated_at)
                VALUES(?,?,?,?,?,'queued',?,?,?,?,?,?,?,?)''',
                (job_id, job.source_item_id, job.mode, 'openai_compatible', model, job.prompt_language,
                 job.prompt_text, job.edited_prompt_text, encoded(job.reference_image_ids), encoded(parameters), encoded(metadata), timestamp, timestamp))
            source_metadata = dict(job.metadata or {})
            source_metadata['latestRetryJobId'] = job_id
            conn.execute('UPDATE generation_jobs SET metadata=?,updated_at=? WHERE id=?', (encoded(source_metadata), timestamp, job.id))
            if root_id != job.id:
                root_row = conn.execute('SELECT metadata FROM generation_jobs WHERE id=?', (root_id,)).fetchone()
                root_metadata = json.loads(root_row['metadata'])
                root_metadata['latestRetryJobId'] = job_id
                conn.execute('UPDATE generation_jobs SET metadata=?,updated_at=? WHERE id=?', (encoded(root_metadata), timestamp, root_id))
            agent._touch(conn, body.conversationId)
        _remember_queue_start(self.library, job_id)
        return self.receipt(body.retryId, body.conversationId), True


def run_agent_image_retry(library, job_id):
    """No Responses planning: verify this new identity, then use Images provider."""
    jobs = GenerationJobRepository(library)
    job = jobs.get_job(job_id)
    if job.status in {'succeeded', 'accepted'}:
        return job
    link = (job.metadata or {}).get('agentRetry', {})
    try:
        profile = OpenAICompatibleConfig(library_path=library).read(link['profileId'])
        if fingerprint(profile) != link.get('profileDigest'):
            raise AgentError('profile_changed', '本次重试的生图连接已改变，请明确重新确认配置。')
        with connect(library) as conn:
            owner = conn.execute('''SELECT 1 FROM agent_rounds r JOIN agent_conversations c ON c.id=r.conversation_id
                WHERE r.id=? AND c.id=? AND r.deleted=0 AND c.deleted=0''', (link.get('roundId'), link.get('conversationId'))).fetchone()
            if not owner:
                raise AgentError('not_found', '重试所属会话或轮次已删除，未调用图片接口。', 404)
            AgentImageRetryRepository(library)._references(conn, job)
        class FrozenConfig:
            def validate_path(self, path):
                OpenAICompatibleConfig(library_path=path).validate_path(path)
            def read(self, profile_id=None):
                return dict(profile)
        return OpenAICompatibleProvider(config=FrozenConfig()).run_job(library, job_id)
    except Exception as exc:
        # Only pre-dispatch queued failures belong to this wrapper. Never undo
        # another worker's claim or a result already durably persisted.
        with connect(library) as conn:
            conn.execute('BEGIN IMMEDIATE')
            row = conn.execute('SELECT metadata FROM generation_jobs WHERE id=? AND status=?', (job_id, 'queued')).fetchone()
            if row:
                metadata = json.loads(row['metadata'])
                missing_reference = isinstance(exc, AgentError) and exc.code == 'reference_missing'
                metadata['error_diagnostics'] = safe_diagnostics({'category': 'reference_missing' if missing_reference else 'local_validation'})
                metadata['failure'] = classify_failure(metadata['error_diagnostics'], code='reference_missing' if missing_reference else None)
                execution = metadata.setdefault('execution', {'version': 1,
                    'timings': {key: None for key in ('queueMs', 'preparationMs', 'providerMs', 'resultWriteMs')}})
                execution['phase'] = 'failed'
                conn.execute("UPDATE generation_jobs SET status='failed',error=?,metadata=?,updated_at=?,completed_at=? WHERE id=? AND status='queued'",
                             ('重试的连接或冻结参考图片已改变；未调用图片接口。', encoded(metadata), now(), now(), job_id))
        raise
