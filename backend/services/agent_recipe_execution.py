"""User-confirmed immutable image recipes on the existing Agent and image queues."""
import copy
from contextlib import contextmanager
import hashlib
import json
import re
import time
from uuid import uuid4

from backend.agent_schemas import AgentRoundCreate
from backend.db import connect
from backend.schemas import GenerationJobCreate
from backend.services import agent_editing_task as editing, agent_task_state as state, agent_execution_timing as timing
from backend.services.agent_repository import AgentError, encoded, fingerprint, milliseconds
from backend.services.openai_compatible import normalize_image_parameters, OpenAICompatibleError


def _context(repo, conversation, rounds, body):
    if conversation['revision'] != body.expectedRevision or conversation['active_round_id'] != body.branchRoundId:
        raise AgentError('revision_conflict', '当前对话或分支已改变，请重新确认配方。')
    value = state.current(conversation, rounds, body.branchRoundId)
    if not value or value['taskId'] != body.taskId:
        raise AgentError('task_revision_conflict', '当前创作任务已改变。')
    repo._check_task_revision(value, body.taskRevision)
    if value['selectedPromptVersionId'] != body.promptVersionId:
        raise AgentError('prompt_selection_conflict', '当前选中的 Prompt 已改变。')
    prompt = next((p for p in value['promptVersions'] if p['id'] == body.promptVersionId), None)
    if not prompt or prompt.get('confirmedBy') != 'user' or not prompt['text'].strip():
        raise AgentError('prompt_selection_required', '请先明确选择要执行的 Prompt。', 400)
    if value['unresolvedItems']:
        raise AgentError('task_incomplete', '当前任务仍有未决项，请先确认完整配方。', 400)
    if any(item.get('reason') != 'unreconciled_user_addition' for item in value.get('historyDependencies', [])):
        raise AgentError('task_incomplete', '当前配方仍依赖尚未确认的历史图片或原始要求；请先明确参考图与角色。', 400)
    if value['taskType'] == 'image_edit' and not value.get('target'):
        raise AgentError('editing_target_required', '请先选择本次编辑对象。', 400)
    return value, prompt


def create_execution(repo, cid, body):
    serialized = body.model_dump(exclude_none=True)
    digest = fingerprint({'conversationId': cid, **{k: v for k, v in serialized.items() if k != 'expectedRevision'}})
    with connect(repo.library) as conn:
        old = conn.execute('SELECT * FROM agent_requests WHERE id=?', (body.requestId,)).fetchone()
        if old:
            if old['conversation_id'] != cid or old['fingerprint'] != digest:
                raise AgentError('request_id_conflict', '此请求身份已用于不同配方。')
            return repo.prompt_execution_receipt(body.requestId, cid), False
        conversation, rounds = repo._conversation(conn, cid), repo._rounds(conn, cid)
    task, prompt = _context(repo, conversation, rounds, body)
    if repo.config()['config']['apiConfigMode'] == 'off':
        raise AgentError('capability_unsupported', 'Current API 尚无已验证的直接执行路径；可保留普通会话生图，或主动选择 Native / Hybrid。', 400)
    request_body = AgentRoundCreate.model_validate({
        'requestId': body.requestId, 'expectedRevision': body.expectedRevision, 'parentRoundId': body.branchRoundId,
        'prompt': prompt['text'], 'configRevision': body.configRevision, 'params': body.params.model_dump(),
        'imageCount': body.imageCount, 'imageConfig': body.imageConfig.model_dump() if body.imageConfig else None,
        'authorization': {'scope': 'this_request', 'allowImageGeneration': True, 'maxToolRounds': 1, 'maxImageJobs': body.imageCount}})
    frozen = repo.resolve_config(request_body)
    native = frozen['apiConfigMode'] == 'native'
    history = repo.path(rounds, body.branchRoundId)
    if history and history[-1].get('maskImageId'):
        raise AgentError('capability_unsupported', '直接执行暂不支持带蒙版配方；请使用原编辑流程。', 400)
    try:
        parameters = normalize_image_parameters(body.params.model_dump(exclude_none=True),
                                               default_model=frozen['imageModel'] or 'native-default')
    except OpenAICompatibleError as exc:
        raise AgentError('invalid_parameters', str(exc), 400) from None
    references = []
    for index, image in enumerate(([task['target']] if task.get('target') else []) + task.get('auxiliaries', [])):
        asset = repo.asset(image['assetId'])
        repo._check_frozen_asset(asset, encoded(image['source']))
        references.append({**copy.deepcopy(image), 'role': 'target' if index == 0 and task.get('target') else image['role'],
                           'order': index, 'path': asset['path'], 'sha256': asset['sha256']})
    if len(references) > 4 or len({r['assetId'] for r in references}) != len(references):
        raise AgentError('invalid_reference', '配方图片必须明确且不可重复，合计最多四张。', 400)
    parameters.update(compatible_profile_id=frozen['imageProfileId'])
    if frozen['imageModel']:
        parameters['model'] = frozen['imageModel']
    elif native:
        parameters.pop('model', None)
    parameters['input_images'] = [{'result_path': r['path'], 'name': f'recipe-reference-{r["order"] + 1}'} for r in references]
    # The confirmed Prompt is submitted byte-for-byte, including whitespace.
    parameters['aspect_ratio_prompt_injection'] = False
    if not native:
        parameters = repo.jobs._freeze_compatible_request(GenerationJobCreate(provider='openai_compatible',
            model=frozen['imageModel'], prompt_text=prompt['text'], parameters=parameters)).parameters
    # Reference tags remain exact text. Reject a tag that would address pixels
    # absent from the confirmed recipe rather than silently importing history.
    bindings = editing.references(history, [r['assetId'] for r in references], len(history) + 1)
    source_assets = {encoded(r['source']): r['assetId'] for r in references}
    for row in history:
        for index, job_id in enumerate(editing.all_output_ids(row), 1):
            asset_id = source_assets.get(encoded({'kind': 'job', 'jobId': job_id}))
            if asset_id:
                bindings[f'round-{row["index"]}-image-{index}'] = asset_id
    for reference in re.findall(r'''<ref\b[^>]*\bid=["'](round-\d+-(?:image|reference)-\d+)["']''', prompt['text']):
        if bindings.get(reference) not in {r['assetId'] for r in references}:
            raise AgentError('reference_missing', '选中 Prompt 引用了配方之外或缺失的图片，请先确认引用。', 400)
    if any(not 1 <= int(slot) <= len(references) for slot in re.findall(r'@图(\d+)', prompt['text'])):
        raise AgentError('reference_missing', '选中 Prompt 引用的当前图片不在完整配方中。', 400)
    for number, slot in re.findall(r'@(?:第)?(\d+)轮图(\d+)', prompt['text']):
        if bindings.get(f'round-{number}-image-{slot}') not in {r['assetId'] for r in references}:
            raise AgentError('reference_missing', '选中 Prompt 引用的历史图片不在完整配方中。', 400)
    for reference in references:
        reference['refs'] = sorted(ref for ref, asset_id in bindings.items() if asset_id == reference['assetId'])
    rid, now = 'round_' + uuid4().hex, milliseconds()
    recipe = {'version': 1, 'requestId': body.requestId, 'sourceBranchRoundId': body.branchRoundId,
              'taskId': task['taskId'], 'taskRevision': task['revision'], 'promptVersionId': prompt['id'],
              'prompt': prompt['text'], 'promptSource': copy.deepcopy(prompt['source']), 'references': references,
              'params': copy.deepcopy(parameters), 'imageCount': body.imageCount, 'mode': frozen['apiConfigMode']}
    recipe['confirmation'] = {'completeRecipe': True, 'confirmedBy': 'user', 'promptVersionId': prompt['id'],
                              'referenceAssetIds': [r['assetId'] for r in references]}
    recipe['fingerprint'] = fingerprint(recipe)
    operation_task = copy.deepcopy(task)
    operation_task['branchRoundId'] = rid
    frozen['_executionKind'] = 'prompt_execution'
    round_data = {'id': rid, 'kind': 'prompt_execution', 'index': len(history) + 1, 'parentRoundId': body.branchRoundId,
        'userMessageId': 'user_' + uuid4().hex, 'assistantMessageId': 'assistant_' + uuid4().hex,
        'prompt': prompt['text'], 'inputImageIds': [r['assetId'] for r in references], 'taskImageIds': [],
        'maskTargetImageId': None, 'maskImageId': None, 'outputTaskIds': [], 'responseOutput': [], 'status': 'running',
        'error': None, 'createdAt': now, 'finishedAt': None, 'requestId': body.requestId, 'derivedFromRoundId': None,
        'assistantContent': '', 'execution': timing.empty_execution(), 'editingTask': state.project_editing(operation_task),
        'taskContext': operation_task, 'imageCount': body.imageCount, 'contextScope': 'task', 'historyRoundIds': [],
        'directRecipe': recipe}
    with connect(repo.library) as conn:
        conn.execute('BEGIN IMMEDIATE')
        old = conn.execute('SELECT * FROM agent_requests WHERE id=?', (body.requestId,)).fetchone()
        if old:
            if old['conversation_id'] != cid or old['fingerprint'] != digest:
                raise AgentError('request_id_conflict', '此请求身份已用于不同配方。')
            replay = True
        else:
            _context(repo, repo._conversation(conn, cid), repo._rounds(conn, cid), body)
            config_revision = conn.execute('SELECT revision FROM agent_config WHERE singleton=1').fetchone()[0]
            if config_revision != body.configRevision:
                raise AgentError('config_revision_conflict', '生图配置已改变，请重新确认配方。')
            if conn.execute("SELECT 1 FROM agent_requests WHERE conversation_id=? AND state IN ('queued','running','waiting_for_jobs','stop_requested')", (cid,)).fetchone():
                raise AgentError('request_active', '当前对话已有执行中的请求。')
            for reference in references:
                repo._check_frozen_asset(repo.asset(reference['assetId']), encoded(reference['source']))
            conn.execute('INSERT INTO agent_rounds(id,conversation_id,parent_round_id,request_id,data) VALUES(?,?,?,?,?)',
                         (rid, cid, body.branchRoundId, body.requestId, encoded(round_data)))
            conn.execute("INSERT INTO agent_requests(id,conversation_id,round_id,fingerprint,body,frozen,history,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'queued',?,?)",
                         (body.requestId, cid, rid, digest, encoded(request_body.model_dump()), encoded(frozen), encoded([]), now, now))
            for number in range(body.imageCount):
                job_id = 'gen_recipe_' + hashlib.sha256(f'{body.requestId}:{number}'.encode()).hexdigest()
                metadata = {'agent': {'requestId': body.requestId, 'conversationId': cid, 'roundId': rid,
                    'toolCallId': 'confirmed-recipe', 'batchItemId': str(number + 1), 'step': 0,
                    'native': native, 'executionKind': 'prompt_execution', 'recipeFingerprint': recipe['fingerprint']}}
                job = repo.jobs.create_job(GenerationJobCreate(provider='agent_native_batch' if native else 'openai_compatible',
                    model=frozen['imageModel'] or None, mode='image_edit' if references else 'text_to_image',
                    prompt_text=prompt['text'], parameters=parameters), job_id=job_id, connection=conn, metadata=metadata)
                conn.execute('INSERT INTO agent_tool_jobs VALUES(?,?,?,?,?,?)',
                             (body.requestId, 0, 'confirmed-recipe', str(number + 1), 'prompt_execution', job.id))
                round_data['outputTaskIds'].append(job.id)
            conn.execute('UPDATE agent_requests SET usage=? WHERE id=?',
                         (encoded({'responseStepsStarted': 0, 'imageJobsCreated': body.imageCount}), body.requestId))
            repo._save_round(conn, round_data)
            conn.execute('UPDATE agent_conversations SET active_round_id=? WHERE id=?', (rid, cid))
            repo._touch(conn, cid)
            replay = False
    return repo.prompt_execution_receipt(body.requestId, cid), not replay


def run_execution(repo, request_id):
    from backend.services.agent_execution import check_active
    from backend.services.generation_queue import enqueue_generation_jobs
    request = check_active(repo, request_id)
    recipe = request['round']['directRecipe']
    # Revalidate before either provider can submit. No live source refresh.
    for image in recipe['references']:
        repo._check_frozen_asset(repo.asset(image['assetId']), encoded(image['source']))
    repo.verified_profile(request, image=True)
    repo.update(request_id, state='waiting_for_jobs', outcome='known')
    enqueue_generation_jobs(repo.library, provider='agent_native_batch' if recipe['mode'] == 'native' else 'openai_compatible')
    while True:
        check_active(repo, request_id)
        jobs = [repo.jobs.get_job(jid) for jid in request['round']['outputTaskIds']]
        if any(job.metadata.get('local_result_recovery') for job in jobs):
            raise AgentError('local_result_pending', '图片已取得，本地保存记录待恢复；请恢复原结果，不要重新生成。')
        if all(job.status not in {'queued', 'running'} for job in jobs):
            break
        time.sleep(0.05)
    failed = [job for job in jobs if job.status not in {'succeeded', 'accepted'}]
    if failed:
        from backend.services.agent_diagnostics import classify_failure
        unknown = any(classify_failure(job.metadata.get('error_diagnostics'))['outcomeUnknown'] for job in failed)
        repo.update(request_id, state='unknown' if unknown else 'failed', outcome='unknown' if unknown else 'known',
                    error={'code': 'image_outcome_unknown' if unknown else 'image_job_failed',
                           'message': '图片执行结果未确认；不会自动重发。' if unknown else '图片执行失败；原配方和编辑对象已保留。'})
        return
    repo.update(request_id, state='completed', outcome='known')


def verify_job_recipe(repo, request, job, *, input_bytes=None):
    """Verify the immutable recipe and the actual bytes prepared for this POST."""
    repo.verified_profile(request, image=True)
    recipe = request['round'].get('directRecipe') or {}
    link = job.metadata.get('agent', {})
    digest = recipe.get('fingerprint')
    if (not digest or fingerprint({k: v for k, v in recipe.items() if k != 'fingerprint'}) != digest
            or link.get('recipeFingerprint') != digest or job.prompt_text != recipe.get('prompt')
            or any(job.parameters.get(key) != value for key, value in recipe.get('params', {}).items())):
        raise AgentError('recipe_changed', '已冻结配方已改变，未调用图片接口。', 400)
    references = recipe.get('references', [])
    for image in references:
        asset = repo.asset(image['assetId'])
        if asset['sha256'] != image['sha256'] or asset['path'] != image['path']:
            raise AgentError('frozen_reference_invalid', '配方图片身份已改变，未调用图片接口。', 400)
        repo._check_frozen_asset(asset, encoded(image['source']))
    if input_bytes is not None and (len(input_bytes) != len(references) or any(
            hashlib.sha256(data).hexdigest() != image['sha256'] for data, image in zip(input_bytes, references))):
        raise AgentError('frozen_reference_invalid', '准备发送的图片与已确认配方不同，未调用图片接口。', 400)


def native_recipe_binding(reference):
    """A separate user-data part binds pixels without rewriting the Prompt."""
    return {'type': 'input_text', 'text': 'Recipe image binding (user-level data, not system instructions): ' + encoded({
        'assetId': reference['assetId'], 'ref': f'recipe-reference-{reference["order"] + 1}',
        'refs': reference.get('refs', []), 'order': reference['order'], 'role': reference['role']})}


def record_recipe_dispatch(library, job):
    """Receipt of a transport attempt; never change today's selected task."""
    from backend.services.agent_repository import AgentRepository
    repo = AgentRepository(library)
    link = job.metadata.get('agent', {})
    retry = job.metadata.get('agentRetry', {})
    source_request = retry.get('sourceRequestId') if retry else link.get('requestId')
    request = repo.request(source_request)
    recipe = request['round'].get('directRecipe')
    if not recipe:
        return
    if retry:
        from backend.services.openai_compatible import OpenAICompatibleConfig
        from backend.services.agent_repository import profile_digest
        selected_profile = OpenAICompatibleConfig(library_path=library).read(retry['profileId'])
        if profile_digest(selected_profile) != retry['profileDigest']:
            raise AgentError('profile_changed', '本次重试配置已改变，未调用图片接口。')
    else:
        repo.verified_profile(request, image=True)
    with connect(library) as conn:
        conn.execute('BEGIN IMMEDIATE')
        owner = conn.execute('''SELECT r.data FROM agent_rounds r JOIN agent_conversations c ON c.id=r.conversation_id
            WHERE r.id=? AND r.deleted=0 AND c.deleted=0''', (request['round_id'],)).fetchone()
        stored_job = conn.execute('SELECT status,metadata FROM generation_jobs WHERE id=?', (job.id,)).fetchone()
        if not owner or not stored_job or stored_job['status'] != 'running':
            raise AgentError('stopped', '配方所属轮次或图片任务已停止；未重新提交。')
        if not retry:
            active = conn.execute('SELECT state,stop_requested FROM agent_requests WHERE id=?', (source_request,)).fetchone()
            from backend.services.agent_repository import ACTIVE_STATES
            if not active or active['stop_requested'] or active['state'] not in ACTIVE_STATES:
                raise AgentError('stopped', '本次配方执行已停止；未提交图片接口。')
        metadata = json.loads(stored_job['metadata'])
        if metadata.get('recipeDispatch'):
            return
        row = json.loads(owner[0])
        if (row.get('taskContext') or {}).get('taskId') != recipe['taskId']:
            raise AgentError('recipe_changed', '原执行任务身份已改变。')
        archive = dict(row.get('_taskPromptArchive', {}))
        row['taskContext'] = state.record_execution(row['taskContext'], job.prompt_text,
                                                   round_id=row['id'], prompt_archive=archive)
        executed_id = row['taskContext']['executedPromptVersionId']
        executed = next(p for p in row['taskContext']['promptVersions'] if p['id'] == executed_id)
        executed.update(source=copy.deepcopy(recipe['promptSource']), confirmedBy='user',
                        execution={'kind': 'confirmed_recipe', 'promptVersionId': recipe['promptVersionId']})
        if archive:
            row['_taskPromptArchive'] = archive
        metadata['recipeDispatch'] = {'sourceRequestId': source_request, 'sourceRoundId': row['id'],
            'taskId': recipe['taskId'], 'taskRevision': recipe['taskRevision'], 'promptVersionId': recipe['promptVersionId'],
            'executedPromptVersionId': executed_id, 'recipeFingerprint': recipe['fingerprint'],
            'attemptedAt': milliseconds()}
        repo._save_round(conn, row)
        conn.execute('UPDATE generation_jobs SET metadata=? WHERE id=?', (encoded(metadata), job.id))
        repo._touch(conn, request['conversation_id'])


class RecipeDispatchClient:
    """Keep the shared Images adapter, recording only at its actual HTTP boundary."""
    def __init__(self, client, library, job):
        self.client, self.library, self.job = client, library, job

    def __getattr__(self, name):
        return getattr(self.client, name)

    @contextmanager
    def stream(self, method, url, **kwargs):
        from backend.services.agent_repository import AgentRepository
        repo = AgentRepository(self.library)
        link = self.job.metadata.get('agent', {})
        retry = self.job.metadata.get('agentRetry', {})
        source_request = retry.get('sourceRequestId') if retry else link.get('requestId')
        request = repo.request(source_request)
        recipe = request['round']['directRecipe']
        if retry:
            from backend.services.openai_compatible import OpenAICompatibleConfig
            from backend.services.agent_repository import profile_digest
            profile = OpenAICompatibleConfig(library_path=self.library).read(retry['profileId'])
            if profile_digest(profile) != retry['profileDigest']:
                raise AgentError('profile_changed', '本次重试配置已改变，未调用图片接口。')
        else:
            repo.verified_profile(request, image=True)
        expected = retry.get('confirmedRecipe', {}).get('recipeFingerprint') if retry else link.get('recipeFingerprint')
        if recipe.get('fingerprint') != expected or fingerprint({k: v for k, v in recipe.items() if k != 'fingerprint'}) != expected:
            raise AgentError('recipe_changed', '原配方来源已改变，未调用图片接口。', 400)
        payload = kwargs.get('data', kwargs.get('json', {}))
        inputs = [spec[1][1] for spec in kwargs.get('files', [])]
        if payload.get('prompt') != recipe['prompt'] or len(inputs) != len(recipe['references']) or any(
                hashlib.sha256(data).hexdigest() != reference['sha256'] for data, reference in zip(inputs, recipe['references'])):
            raise AgentError('recipe_changed', '准备发送的 Prompt 或图片与已确认配方不同。', 400)
        record_recipe_dispatch(self.library, self.job)
        with self.client.stream(method, url, **kwargs) as response:
            yield response
