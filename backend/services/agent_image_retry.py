"""Explicit image-only retries using the existing generation queue and snapshots."""
from __future__ import annotations

import base64
import hashlib
import json
from io import BytesIO
from pathlib import Path
from typing import Literal

import httpx
from PIL import Image
from pydantic import BaseModel, ConfigDict, Field

from backend.agent_schemas import AgentImageConfig
from backend.db import connect
from backend.schemas import GenerationJobCreate
from backend.services.agent_diagnostics import classify_failure, safe_diagnostics
from backend.services.agent_repository import AgentError, AgentRepository, encoded, fingerprint, profile_digest
from backend.services.api_network import ApiNetworkError, create_api_client
from backend.services.agent_image_inputs import encode_verified_image
from backend.services.generation_jobs import (
    GenerationJobConflict, GenerationJobRepository, _remember_queue_start, now, resolve_generation_input_image_path,
    sanitize_generation_parameters,
)
from backend.services.openai_compatible import OpenAICompatibleConfig, OpenAICompatibleError, OpenAICompatibleProvider, normalize_image_parameters
from backend.services import agent_execution_timing as timing


class RetryParams(BaseModel):
    model_config = ConfigDict(extra='forbid')
    size: str
    quality: str
    output_format: Literal['png', 'jpeg', 'webp']
    output_compression: int | None = Field(default=None, ge=0, le=100)
    moderation: Literal['auto', 'low'] | None = None
    background: Literal['auto', 'opaque', 'transparent'] | None = None


class AgentImageRetryCreate(BaseModel):
    model_config = ConfigDict(extra='forbid')
    retryId: str = Field(min_length=1, max_length=100, pattern=r'^[A-Za-z0-9_-]+$')
    conversationId: str = Field(min_length=1, max_length=100, pattern=r'^[A-Za-z0-9_-]+$')
    configRevision: int = Field(ge=0)
    imageConfig: AgentImageConfig
    params: RetryParams
    confirmed: Literal[True]


def retry_job_id(retry_id):
    return 'gen_retry_' + hashlib.sha256(retry_id.encode('utf-8')).hexdigest()


def _link(job):
    return (job.metadata or {}).get('agentRetry') or (job.metadata or {}).get('agent') or {}


def _known_failure(job):
    diagnostics = (job.metadata or {}).get('error_diagnostics') or {}
    failure = classify_failure(diagnostics)
    native_terminal = (job.provider in {'agent_native', 'agent_native_batch'}
                       and _link(job).get('nativeTerminalStatus') == 'failed')
    if failure['outcomeUnknown'] or not (
        type(diagnostics.get('http_status')) is int and diagnostics['http_status'] >= 400
        or failure['kind'] in {'quota', 'model_unsupported', 'moderation', 'rate_limit', 'authentication', 'reference_missing'}
        or diagnostics.get('category') == 'local_validation'
        or native_terminal
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

    def _terminal(self, job, *, require_asset=False):
        if job.status == 'failed':
            _known_failure(job)
        elif job.status in {'succeeded', 'accepted'}:
            if require_asset:
                try:
                    self.jobs._prepare_result_image(job)
                except (GenerationJobConflict, OSError, ValueError):
                    raise AgentError('reference_missing', '原图片结果已缺失或改变，不能从此结果发起重试。', 400) from None
        else:
            raise AgentError('retry_not_terminal', '只能重试已有图片结果或已明确失败的任务；进行中和未知请求不会重放。')

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
        if job.provider not in {'openai_compatible', 'agent_native', 'agent_native_batch'}:
            raise AgentError('capability_unsupported', '此图片任务不支持 Agent 图片重试。', 400)
        self._terminal(job, require_asset=True)
        if job.provider == 'agent_native':
            revised = (job.metadata or {}).get('response', {}).get('revised_prompt')
            if not isinstance(revised, str) or not revised.strip():
                raise AgentError('prompt_unavailable', '原生图片未记录可靠的实际生图提示词，不能直接重试；请通过原会话明确重新生成。', 400)
            # Older direct Responses jobs stored only current-turn attachments,
            # although the model could also see historical branch pixels. An
            # empty/partial recipe must never silently turn into text-to-image.
            snapshot = (job.metadata or {}).get('agent', {}).get('nativeReferenceSnapshot')
            inputs = (job.parameters or {}).get('input_images')
            if (not isinstance(snapshot, dict) or snapshot.get('version') != 1 or snapshot.get('complete') is not True
                    or type(snapshot.get('count')) is not int or not isinstance(inputs, list)
                    or snapshot['count'] != len(inputs) or not 0 <= snapshot['count'] <= 4
                    or not isinstance(snapshot.get('references'), list) or len(snapshot['references']) != len(inputs)
                    or any(not isinstance(ref, dict) or not isinstance(spec, dict)
                           or (ref.get('ref'), ref.get('path')) != (spec.get('name'), spec.get('result_path'))
                           or not isinstance(ref.get('sha256'), str) or len(ref['sha256']) != 64
                           for ref, spec in zip(snapshot['references'], inputs))):
                raise AgentError('reference_missing', '原生图片的原始参考图记录不完整，不能直接重试；请重新确认参考图。', 400)
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
                if not previous or previous['status'] not in {'failed', 'succeeded', 'accepted'}:
                    raise AgentError('retry_pending', '原图片已有重试，请先检查该任务，不会重复提交。')
                previous_job = self.jobs._record_from_row(previous)
                self._terminal(previous_job)
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
        native_snapshot = (job.metadata or {}).get('agent', {}).get('nativeReferenceSnapshot') or {}
        expected.update({item.get('path'): item.get('sha256') for item in native_snapshot.get('references', []) if isinstance(item, dict)})
        for raw in inputs:
            path_value = raw.get('result_path') if isinstance(raw, dict) else None
            try:
                if not isinstance(path_value, str) or not path_value:
                    raise ValueError('missing snapshot')
                path, _ = resolve_generation_input_image_path(self.library, path_value, allowed_roots={'generation-references'})
                row = conn.execute('SELECT sha256 FROM agent_assets WHERE path=?', (path_value,)).fetchone()
                digest = expected.get(path_value) or (row['sha256'] if row else None)
                if not digest or hashlib.sha256(path.read_bytes()).hexdigest() != digest:
                    raise ValueError('snapshot mismatch')
            except (OSError, ValueError):
                raise AgentError('reference_missing', '原始冻结参考图片缺失或已改变；不会使用其他图片替代。', 400) from None
            specs.append({'result_path': path_value, 'name': str(raw.get('name') or 'reference')})
            hashes.append({'path': path_value, 'sha256': digest})
        mask = (job.metadata or {}).get('agentRetry', {}).get('maskReference')
        if mask:
            self._check_mask(mask, specs)
        return specs, hashes

    def _check_mask(self, mask, inputs):
        try:
            path, _ = resolve_generation_input_image_path(self.library, mask['path'], allowed_roots={'generation-references'})
            if (hashlib.sha256(path.read_bytes()).hexdigest() != mask['sha256']
                    or mask['targetPath'] not in {item['result_path'] for item in inputs}):
                raise ValueError('mask snapshot mismatch')
        except (OSError, ValueError, KeyError, TypeError):
            raise AgentError('reference_missing', '原始冻结蒙版或目标图片缺失或已改变；不会忽略蒙版继续生成。', 400) from None

    def _mask(self, conn, job, source, inputs):
        previous = (job.metadata or {}).get('agentRetry', {}).get('maskReference')
        if previous:
            self._check_mask(previous, inputs)
            return previous
        round_data = json.loads(conn.execute('SELECT data FROM agent_rounds WHERE id=?', (source['roundId'],)).fetchone()[0])
        if not round_data.get('maskImageId'):
            return None
        mask = conn.execute('SELECT path,sha256 FROM agent_assets WHERE id=?', (round_data['maskImageId'],)).fetchone()
        target = conn.execute('SELECT path FROM agent_assets WHERE id=?', (round_data.get('maskTargetImageId'),)).fetchone()
        if not mask or not target:
            raise AgentError('reference_missing', '原始冻结蒙版或目标图片缺失。', 400)
        value = {'path': mask['path'], 'sha256': mask['sha256'], 'targetPath': target['path']}
        self._check_mask(value, inputs)
        return value

    def create(self, source_job_id, body: AgentImageRetryCreate):
        serialized = body.model_dump(exclude_none=True)
        # Preserve the exact submitted controls in the idempotency identity,
        # including the distinction between omitted and explicitly null values.
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
        config = document['config']
        native = config['apiConfigMode'] == 'native'
        if config['apiConfigMode'] == 'off':
            raise AgentError('capability_unsupported', '请先启用 Agent 生图模式再重试图片。', 400)
        if native and body.imageConfig.profileId is not None:
            raise AgentError('capability_unsupported', '原生生图使用当前文本 API 配置，不能指定独立图片供应商。', 400)
        profile_id = config['textProfileId'] if native else body.imageConfig.profileId or config['imageProfileId']
        if not profile_id:
            raise AgentError('configuration_incomplete', '请选择本次重试使用的生图供应商。', 400)
        try:
            profile = OpenAICompatibleConfig(library_path=self.library).read(profile_id)
        except (ValueError, OpenAICompatibleError):
            raise AgentError('configuration_incomplete', '所选生图供应商不存在。', 400) from None
        model = body.imageConfig.model.strip() or ('' if native else profile['model'].strip())
        text_model = config['textModel'].strip() if native else None
        if not profile['api_key'] or not profile['base_url'] or (not text_model if native else not model):
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
            if native != (job.provider in {'agent_native', 'agent_native_batch'}):
                raise AgentError('capability_unsupported', '当前模式与原图片接口不同；不会自动转换 Images 和 Responses 协议。', 400)
            inputs, reference_hashes = self._references(conn, job)
            mask = self._mask(conn, job, source, inputs) if native else None
            # Current shared controls are the complete settings snapshot. Never
            # inherit hidden/omitted settings from an older image's recipe.
            parameters = body.params.model_dump(exclude_none=True)
            parameters.update(compatible_profile_id=profile_id, model=model, input_images=inputs)
            provider = 'agent_native_batch' if native else 'openai_compatible'
            try:
                if native:
                    # Validate image settings without inventing a model for the
                    # wire when the Responses provider chooses its default.
                    parameters = normalize_image_parameters({**parameters, 'model': model or 'native-default'})
                    parameters['model'] = model
                else:
                    parameters = self.jobs._freeze_compatible_request(GenerationJobCreate(provider=provider, model=model,
                        prompt_text=job.prompt_text, edited_prompt_text=job.edited_prompt_text, parameters=parameters, mode=job.mode)).parameters
            except (ValueError, OpenAICompatibleError):
                raise AgentError('invalid_parameters', '重试参数无效，请检查当前供应商的图片参数。', 400) from None
            parameters, copies = self.jobs._prepare_reference_input_clones(job_id, parameters)
            parameters = sanitize_generation_parameters(parameters)
            lineage = {'retryId': body.retryId, 'payloadFingerprint': request_fingerprint,
                'conversationId': body.conversationId, 'roundId': source['roundId'],
                'sourceRequestId': source.get('sourceRequestId') or source.get('requestId'),
                'sourceJobId': job.id, 'rootSourceJobId': root_id,
                'profileId': profile_id, 'profileDigest': profile_digest(profile), 'referenceHashes': reference_hashes,
                **({'textModel': text_model} if native else {}), **({'maskReference': mask} if mask else {})}
            source_round = json.loads(conn.execute('SELECT data FROM agent_rounds WHERE id=?', (source['roundId'],)).fetchone()[0])
            recipe = source_round.get('directRecipe')
            if recipe:
                lineage['confirmedRecipe'] = {'recipeFingerprint': recipe['fingerprint'], 'taskId': recipe['taskId'],
                    'taskRevision': recipe['taskRevision'], 'promptVersionId': recipe['promptVersionId'],
                    'promptSource': recipe['promptSource'], 'sourceRoundId': source['roundId']}
            metadata = {'agentRetry': lineage, 'retry_of_generation_job_id': job.id, 'retry_reason': 'agent_current_config',
                        **({'reference_image_copies': copies} if copies else {})}
            metadata = sanitize_generation_parameters(metadata, redact_image_data=True)
            conn.execute('''INSERT INTO generation_jobs(id,source_item_id,mode,provider,model,status,prompt_language,
                prompt_text,edited_prompt_text,reference_image_ids,parameters,metadata,created_at,updated_at)
                VALUES(?,?,?,?,?,'queued',?,?,?,?,?,?,?,?)''',
                (job_id, job.source_item_id, job.mode, provider, model or None, job.prompt_language,
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
    """Submit this new identity once, using its original protocol and snapshots."""
    jobs = GenerationJobRepository(library)
    job = jobs.get_job(job_id)
    if job.status != 'queued':
        return job
    link = (job.metadata or {}).get('agentRetry', {})
    try:
        profile = OpenAICompatibleConfig(library_path=library).read(link['profileId'])
        if profile_digest(profile) != link.get('profileDigest'):
            raise AgentError('profile_changed', '本次重试的生图连接已改变，请明确重新确认配置。')
        with connect(library) as conn:
            owner = conn.execute('''SELECT 1 FROM agent_rounds r JOIN agent_conversations c ON c.id=r.conversation_id
                WHERE r.id=? AND c.id=? AND r.deleted=0 AND c.deleted=0''', (link.get('roundId'), link.get('conversationId'))).fetchone()
            if not owner:
                raise AgentError('not_found', '重试所属会话或轮次已删除，未调用图片接口。', 404)
            AgentImageRetryRepository(library)._references(conn, job)
        if job.provider == 'agent_native_batch':
            return _run_native_retry(library, job, profile)
        class FrozenConfig:
            def validate_path(self, path):
                OpenAICompatibleConfig(library_path=path).validate_path(path)
            def read(self, profile_id=None):
                return dict(profile)
        if link.get('confirmedRecipe'):
            from backend.services.agent_recipe_execution import RecipeDispatchClient
            with create_api_client(profile, timeout=profile['timeout']) as client:
                return OpenAICompatibleProvider(config=FrozenConfig(), http_client=RecipeDispatchClient(client, library, job)).run_job(library, job_id)
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


def _run_native_retry(library, job, profile):
    """One forced Responses image tool call; no Agent planning or old turn replay."""
    from backend.services.agent_execution import (
        exception_diagnostics, native_image_parameters, read_native_response,
        redact, response_stream, safe_http_failure,
    )
    jobs = GenerationJobRepository(library)
    link = job.metadata['agentRetry']
    started, provider_started, provider_ms, claimed = timing.monotonic(), None, None, False

    def check_owner():
        with connect(library) as conn:
            owner = conn.execute('''SELECT 1 FROM agent_rounds r JOIN agent_conversations c ON c.id=r.conversation_id
                WHERE r.id=? AND c.id=? AND r.deleted=0 AND c.deleted=0''', (link['roundId'], link['conversationId'])).fetchone()
            if not owner:
                raise AgentError('not_found', '重试所属会话或轮次已删除。', 404)

    try:
        jobs.mark_running(job.id, queued_only=True)
        claimed = True
        content = [{'type': 'input_text', 'text': job.edited_prompt_text or job.prompt_text}]
        inputs = list(job.parameters.get('input_images', []))
        mask = link.get('maskReference')
        if mask:
            inputs.sort(key=lambda spec: spec['result_path'] != mask['targetPath'])
        confirmed_recipe = None
        if link.get('confirmedRecipe'):
            confirmed_recipe = AgentRepository(library).request(link['sourceRequestId'])['round']['directRecipe']
        for index, spec in enumerate(inputs):
            path, mime = resolve_generation_input_image_path(library, spec['result_path'], allowed_roots={'generation-references'})
            if confirmed_recipe:
                from backend.services.agent_recipe_execution import native_recipe_binding
                content.append(native_recipe_binding(confirmed_recipe['references'][index]))
            content.append({'type': 'input_image', 'image_url': encode_verified_image(path.read_bytes(), mime)})
        image_tool = {'type': 'image_generation', 'action': 'auto', **native_image_parameters(job.parameters)}
        if job.model:
            image_tool['model'] = job.model
        if mask:
            path, mime = resolve_generation_input_image_path(library, mask['path'], allowed_roots={'generation-references'})
            image_tool['input_image_mask'] = {'image_url': encode_verified_image(path.read_bytes(), mime)}
        body = {'model': link['textModel'], 'stream': False, 'input': [{'role': 'user', 'content': content}],
                'tools': [image_tool], 'tool_choice': {'type': 'image_generation'}, 'max_tool_calls': 1}
        check_owner()
        jobs.record_execution(job.id, phase='generating', preparationMs=timing.elapsed(started))
        payload = None
        with create_api_client(profile, timeout=httpx.Timeout(profile['timeout'], connect=min(10, profile['timeout']))) as client:
            provider_started = timing.monotonic()
            if link.get('confirmedRecipe'):
                from backend.services.agent_recipe_execution import record_recipe_dispatch
                recipe = AgentRepository(library).request(link['sourceRequestId'])['round']['directRecipe']
                actual = [base64.b64decode(item['image_url'].split(',', 1)[1]) for item in content if item['type'] == 'input_image']
                if (content[0]['text'] != recipe['prompt'] or recipe['fingerprint'] != link['confirmedRecipe']['recipeFingerprint']
                        or len(actual) != len(recipe['references']) or any(hashlib.sha256(data).hexdigest() != reference['sha256']
                        for data, reference in zip(actual, recipe['references']))):
                    raise AgentError('reference_missing', '原配方图片已改变；未调用图片接口。', 400)
                record_recipe_dispatch(library, job)
            with response_stream(client, 'POST', profile['base_url'].rstrip('/') + '/responses', is_complete=lambda: payload is not None,
                                 headers={'Authorization': 'Bearer ' + profile['api_key']}, json=body) as response:
                if not response.is_success:
                    raise AgentError('upstream_error', f'原生图片接口返回 HTTP {response.status_code}。', diagnostics=safe_http_failure(response))
                payload = read_native_response(response, check_owner)
                provider_ms = timing.elapsed(provider_started)
        jobs.record_execution(job.id, phase='processing_results', providerMs=provider_ms)
        result_started = timing.monotonic()
        images = [item for item in payload.get('output', []) if isinstance(item, dict) and item.get('type') == 'image_generation_call']
        if len(images) == 1 and images[0].get('status') == 'failed':
            # This marker is written only after read_native_response accepted a
            # completed parent receipt. A generic error or timeout is not proof.
            with connect(library) as conn:
                conn.execute('BEGIN IMMEDIATE')
                row = conn.execute("SELECT metadata FROM generation_jobs WHERE id=? AND status='running'", (job.id,)).fetchone()
                if row:
                    metadata = json.loads(row['metadata'])
                    metadata['agentRetry']['nativeTerminalStatus'] = 'failed'
                    conn.execute('UPDATE generation_jobs SET metadata=? WHERE id=?', (encoded(metadata), job.id))
            raise AgentError('upstream_error', '原生图像工具明确返回失败。', diagnostics={'error': images[0].get('error')})
        if len(images) != 1 or images[0].get('status') != 'completed' or not images[0].get('result'):
            raise AgentError('upstream_error', '原生单图重试未返回恰好一张完整图片。')
        value = images[0]['result']
        if isinstance(value, dict):
            value = next((value[k] for k in ('b64_json', 'base64', 'image', 'data') if isinstance(value.get(k), str)), None)
        try:
            if not isinstance(value, str) or not value:
                raise ValueError('missing image bytes')
            data = base64.b64decode(value.split(',', 1)[-1] if value.startswith('data:') else value, validate=True)
            with Image.open(BytesIO(data)) as image:
                image.verify()
                extension = {'PNG': 'png', 'JPEG': 'jpg', 'WEBP': 'webp'}.get(image.format, 'png')
        except (ValueError, OSError):
            raise AgentError('upstream_error', '原生图片结果无法解码。') from None
        check_owner()
        revised = redact(images[0].get('revised_prompt'), [profile['api_key']])
        jobs.stage_result(job.id, data, 'native.' + extension, {'provider': 'agent_native_batch',
            'requested': {k: v for k, v in image_tool.items() if k not in {'type', 'action', 'input_image_mask'}},
            'response': {'response_id': redact(payload.get('id'), [profile['api_key']]),
                         **({'revised_prompt': revised} if isinstance(revised, str) and revised.strip() else {})}})
        jobs.record_execution(job.id, phase='completed', resultWriteMs=timing.elapsed(result_started))
        return jobs.get_job(job.id)
    except Exception as exc:
        if claimed and jobs.get_job(job.id).status == 'running':
            diagnostics = exception_diagnostics(exc) if provider_started is not None else safe_diagnostics({'category': 'local_validation'})
            measurements = {'providerMs': provider_ms if provider_ms is not None else timing.elapsed(provider_started)} if provider_started is not None else {'preparationMs': timing.elapsed(started)}
            jobs.mark_failed(job.id, exc.message if isinstance(exc, (AgentError, ApiNetworkError)) else '原生图片请求未完成；不会自动重试。', diagnostics=diagnostics)
            jobs.record_execution(job.id, phase='unknown' if classify_failure(diagnostics)['outcomeUnknown'] else 'failed', **measurements)
        raise
