"""Responses orchestration over the existing generation queue.

Reference/continuation semantics adapted from CookSleep/gpt-image-playground,
MIT (2026), pinned 1e9d5af60aadd9117a835cc2da43908b8e3370dd.
"""
from __future__ import annotations

import base64
import hashlib
import json
import re
import sqlite3
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import suppress
from threading import RLock
from uuid import uuid4

import httpx

from backend.db import connect
from backend.schemas import GenerationJobCreate
from backend.services.agent_repository import (
    ACTIVE_STATES, AgentError, AgentRepository, REF_TAG, ROUND_MENTION, encoded, milliseconds, safe_model_label,
)
from backend.services.agent_skills import default_skill_sections, read_agent_skill, skill_catalog_instructions, skill_tool, validated_skill_preloads
from backend.services.agent_responses import (
    MAX_RESPONSE_BYTES, ResponseOutput, response_stream, validate_response_payload, read_native_response,
    redact, safe_output, merge_output, output_text,
)
from backend.services.agent_protocol import function_tool, native_image_parameters, tools_for, response_body
from backend.services.agent_context_pipeline import (
    build_input, refs_for_request, history_items, skill_context_items, validated_skill_tool_outputs, prepare_context,
)
from backend.services import agent_execution_timing as timing
from backend.services import agent_editing_task as editing
from backend.services.agent_diagnostics import safe_diagnostics, network_configuration_diagnostics
from backend.services.api_network import ApiNetworkError, create_api_client
from backend.services.agent_image_inputs import encode_verified_image

_executor = ThreadPoolExecutor(max_workers=3, thread_name_prefix="agent-turn")
_lock = RLock()
_futures = {}
_clients = {}
_closing = set()


def safe_http_failure(response, *, secrets=()):
    """Inspect a bounded error body, persist only recognized diagnostic fields."""
    chunks, size = [], 0
    try:
        for chunk in response.iter_bytes():
            size += len(chunk)
            if size > 65536:
                break
            chunks.append(chunk)
    except httpx.TransportError:
        # Failure status was already received. A broken error body must not
        # turn this known rejection into an uncertain paid submission.
        pass
    try:
        body = json.loads(b''.join(chunks))
    except (ValueError, UnicodeError):
        body = {}
    return safe_diagnostics({'http_status': response.status_code,
                             'error': body.get('error') if isinstance(body, dict) else None}, secrets=secrets, allow_message=True)


def exception_diagnostics(exc):
    if isinstance(exc, ApiNetworkError):
        return network_configuration_diagnostics(exc.message)
    if isinstance(exc, AgentError):
        return exc.diagnostics or safe_diagnostics({'category': 'incomplete_stream' if exc.code == 'upstream_outcome_unknown' else
                                                   'reference_missing' if exc.code in {'reference_missing', 'frozen_reference_invalid'} else 'unknown'})
    category = ('read_timeout' if isinstance(exc, httpx.ReadTimeout) else
                'connect_timeout' if isinstance(exc, httpx.ConnectTimeout) else
                'connection_error' if isinstance(exc, httpx.TransportError) else 'unknown')
    return safe_diagnostics({'category': category})


def key_for(library, request_id):
    from pathlib import Path
    return (str(Path(library).resolve()), request_id)


def check_active(repo, request_id):
    request = repo.request(request_id)
    if request["stop_requested"] or request["state"] == "stopped":
        raise AgentError("stopped", "已停止生成。")
    if request["state"] not in ACTIVE_STATES:
        raise AgentError("interrupted", "本轮请求未处于执行状态；不会自动重发。")
    if str(repo.library.resolve()) in _closing:
        raise AgentError("interrupted", "后端已停止，本轮未自动重发。")
    return request


def context_image_url(repo, asset_id):
    from backend.services.generation_jobs import GenerationJobConflict
    try:
        return repo.data_url(asset_id)
    except (GenerationJobConflict, KeyError, OSError):
        raise AgentError("reference_missing", "引用的图片不存在或已清理。", 400) from None


def image_reference_ids(task, prompt, refs, *, reference_ids=None, native_context=None):
    """Validate every image in a local tool call before persisting/enqueuing it."""
    if task and task.get('needsTargetSelection'):
        raise AgentError('editing_target_required', '请明确当前编辑对象和辅助图片角色后再生成。', 400)
    reference_ids = list(dict.fromkeys(REF_TAG.findall(prompt) if reference_ids is None else reference_ids))
    if task and native_context is None:
        required_refs = []
        for aid in editing.required_asset_ids(task):
            # Prefer the exact alias already used by this tool. Adding another
            # alias for its required target would upload the same asset twice.
            alias = next((ref for ref in reference_ids if refs.get(ref) == aid), None)
            if alias is None:
                alias = next((ref for ref, value in reversed(list(refs.items())) if value == aid), None)
            if alias is None:
                raise AgentError('reference_missing', '当前编辑对象或辅助参考不在本轮冻结图片中。', 400)
            required_refs.append(alias)
        # The selected target is always the first edit input; do not silently
        # substitute an older picture when a tool omits its reference tag.
        reference_ids = list(dict.fromkeys([*required_refs[:1], *reference_ids, *required_refs[1:]]))
    if any(not refs.get(ref) for ref in reference_ids):
        raise AgentError("reference_missing", "工具引用了不属于当前分支或已删除的图片。")
    if len(reference_ids) > 4:
        raise AgentError("invalid_reference", "此图片接口最多支持 4 张参考图片。")
    return reference_ids


def create_image_job(repo, request_id, step, call_id, item_id, prompt, refs, *, native=False, reference_ids=None, native_context=None):
    request = check_active(repo, request_id)
    authorization = request["body"]["authorization"]
    if not authorization["allowImageGeneration"]:
        raise AgentError("authorization_denied", "本轮未授权生成图片。")
    with connect(repo.library) as conn:
        linked = conn.execute("SELECT job_id FROM agent_tool_jobs WHERE request_id=? AND step=? AND call_id=? AND item_id=?", (request_id, step, call_id, item_id)).fetchone()
    if linked:
        return repo.jobs.get_job(linked[0])
    reference_ids = image_reference_ids(editing.execution_task(request['round']), prompt, refs,
                                        reference_ids=reference_ids, native_context=native_context)
    parameters = dict(request["body"]["params"])
    parameters["input_images"] = [{"result_path": repo.asset(refs[ref])["path"], "name": ref} for ref in reference_ids]
    parameters["compatible_profile_id"] = request["frozen"]["imageProfileId"]
    image_model = request["frozen"]["imageModel"] or None
    if image_model:
        parameters["model"] = image_model
    metadata = {"agent": {"requestId": request_id, "conversationId": request["conversation_id"], "roundId": request["round_id"],
                           "toolCallId": call_id, "batchCallId": call_id if item_id != "single" else None,
                           "batchItemId": item_id, "step": step, "native": native}}
    if native_context is not None:
        metadata['agent']['nativeReferenceSnapshot'] = native_context
    payload = GenerationJobCreate(provider="agent_native" if native else "openai_compatible", model=image_model,
                                  mode="image_edit" if reference_ids or native_context and native_context['count'] else "text_to_image",
                                  prompt_text=prompt, parameters=parameters)
    with connect(repo.library) as conn:
        conn.execute("BEGIN IMMEDIATE")
        stored = conn.execute("SELECT * FROM agent_requests WHERE id=?", (request_id,)).fetchone()
        if stored["stop_requested"]:
            raise AgentError("stopped", "已停止生成。")
        usage = json.loads(stored["usage"])
        if usage["imageJobsCreated"] >= authorization["maxImageJobs"]:
            raise AgentError("budget_exhausted", "本轮图片额度已用尽。")
        if native:
            from backend.services.agent_native_result_recovery import native_job_id
            job_id = native_job_id(request_id, step, call_id, item_id)
        else:
            job_id = "gen_" + uuid4().hex
        job = repo.jobs.create_job(payload, job_id=job_id, connection=conn, metadata=metadata)
        conn.execute("INSERT INTO agent_tool_jobs VALUES(?,?,?,?,?,?)", (request_id, step, call_id, item_id,
                     "image_generation" if native else "generate_image" if item_id == "single" else "generate_image_batch", job.id))
        usage["imageJobsCreated"] += 1
        conn.execute("UPDATE agent_requests SET usage=? WHERE id=?", (encoded(usage), request_id))
        round_data = json.loads(conn.execute("SELECT data FROM agent_rounds WHERE id=?", (request["round_id"],)).fetchone()[0])
        round_data["outputTaskIds"].append(job.id)
        repo._save_round(conn, round_data)
        repo._touch(conn, request["conversation_id"])
    return job


def native_reference_snapshot(repo, refs, attached_refs):
    """Record exactly the distinct frozen pixels attached to this Responses POST."""
    if attached_refs is None:
        return {'version': 1, 'complete': False, 'count': 0, 'references': [], 'reason': 'context_unavailable'}
    selected, seen = [], set()
    for ref in attached_refs:
        aid = refs.get(ref)
        if not aid:
            raise AgentError('reference_missing', '原生图片上下文引用无法冻结。', 400)
        if aid in seen:
            continue
        seen.add(aid)
        asset = repo.asset(aid)
        selected.append({'ref': ref, 'assetId': aid, 'path': asset['path'], 'sha256': asset['sha256']})
    within_limit = len(selected) <= 4
    return {'version': 1, 'complete': within_limit, 'count': len(selected), 'references': selected,
            **({} if within_limit else {'reason': 'input_limit_exceeded'})}


def record_native_failed_terminal(repo, job_id):
    with connect(repo.library) as conn:
        conn.execute("UPDATE generation_jobs SET metadata=json_set(metadata,'$.agent.nativeTerminalStatus','failed') WHERE id=?",
                     (job_id,))


def native_image(repo, request_id, step, item, refs, secrets=(), *, native_context=None, terminal=False, request_snapshot=None):
    request = request_snapshot or repo.request(request_id)
    if not secrets:
        secrets = [repo.verified_profile(request)["api_key"]]
    # Decode image bytes unchanged; every provider-origin metadata field must
    # cross the same redaction boundary before it can reach a job or SQLite.
    item = {**redact({k: v for k, v in item.items() if k != "result"}, secrets), "result": item.get("result")}
    if not terminal and item.get('status') == 'completed':
        item = {**item, 'status':'in_progress', 'result':None}
    call_id = item.get("id")
    if not isinstance(call_id, str) or not call_id:
        raise AgentError("upstream_error", "原生图像工具缺少稳定的输出标识。")
    native_context = native_context or native_reference_snapshot(repo, refs, None)
    input_refs = [entry['ref'] for entry in native_context['references']] if native_context['complete'] else []
    encoded_result = item.get('result')
    if isinstance(encoded_result,dict):
        encoded_result = next((encoded_result[key] for key in ('b64_json','base64','image','data') if isinstance(encoded_result.get(key),str)),None)
    if terminal and item.get('status') == 'completed' and isinstance(encoded_result,str) and encoded_result:
        from backend.services.agent_native_result_recovery import preserve_native_final
        from backend.services.generation_result_recovery import RecoveryConflict
        from backend.services.generation_jobs import GenerationJobConflict
        # This must precede the first job/mapping INSERT and all timing or task
        # bookkeeping. A failed SQLite write cannot strand paid bytes in RAM.
        job_id = preserve_native_final(repo.library, request, step, item, native_context)
        try:
            result_job = repo.jobs.recover_local_result(job_id)
        except (sqlite3.Error,OSError,RecoveryConflict,GenerationJobConflict):
            raise AgentError('local_result_pending', '图片已取得，本地保存记录待恢复；请检查原结果，不要重新生成。', 409) from None
        with suppress(sqlite3.Error):
            task = editing.execution_task(request['round'])
            attached = {entry['assetId'] for entry in native_context['references']}
            if native_context['complete'] and task and attached == set(editing.required_asset_ids(task)):
                repo.confirm_request_image_roles(request_id, refs)
            if isinstance(item.get('revised_prompt'), str) and item['revised_prompt'].strip():
                repo.record_task_execution(request_id, item['revised_prompt'])
            repo.jobs.record_execution(job_id, phase='completed')
        return result_job
    job = create_image_job(repo, request_id, step, call_id, "single", item.get("revised_prompt") or request["round"]["prompt"], refs,
                           native=True, reference_ids=input_refs, native_context=native_context)
    if job.status in {"succeeded", "accepted"}:
        return job
    revised = item.get('revised_prompt')
    if terminal and item.get('status') in {'completed', 'failed'} and isinstance(revised, str) and revised.strip():
        # An early stream item may have created a row before the actual image
        # prompt arrived. Only a validated final receipt supplies this recipe.
        with connect(repo.library) as conn:
            conn.execute("UPDATE generation_jobs SET prompt_text=?,metadata=json_set(metadata,'$.response.revised_prompt',?) "
                         "WHERE id=? AND provider='agent_native' AND status IN ('queued','running')", (revised, revised, job.id))
    if terminal and item.get('status') == 'completed':
        task = editing.execution_task(repo.request(request_id)['round'])
        attached = {entry['assetId'] for entry in native_context['references']}
        if native_context['complete'] and task and attached == set(editing.required_asset_ids(task)):
            repo.confirm_request_image_roles(request_id, refs)
        if isinstance(revised, str) and revised.strip():
            repo.record_task_execution(request_id, revised)
    result = item.get("result")
    if isinstance(result, dict):
        result = next((result[k] for k in ("b64_json", "base64", "image", "data") if isinstance(result.get(k), str)), None)
    if item.get("status") in {"failed", "incomplete", "cancelled"}:
        if terminal and item.get('status') == 'failed':
            record_native_failed_terminal(repo, job.id)
        repo.jobs.record_execution(job.id, phase='failed')
        return repo.jobs.mark_failed(job.id, "原生图像工具未能生成图片。",
            diagnostics=safe_diagnostics({'error': item.get('error')},
                secrets=(*secrets, request['round']['prompt'], item.get('revised_prompt')), allow_message=True))
    if item.get("status") != "completed":
        if job.status == 'queued':
            repo.record_execution(request_id, phase='generating_images')
            repo.jobs.mark_running(job.id)
            repo.jobs.record_execution(job.id, phase='generating')
            return repo.jobs.get_job(job.id)
        return job
    if not isinstance(result, str) or not result:
        repo.jobs.record_execution(job.id, phase='failed')
        return repo.jobs.mark_failed(job.id, "原生图像工具已完成但未返回图片。", diagnostics={'category': 'missing_image'})
    try:
        data = base64.b64decode(result.split(",", 1)[-1] if result.startswith("data:") else result, validate=True)
    except ValueError:
        raise AgentError("upstream_error", "原生图像结果不是有效的 Base64 图片。") from None
    from io import BytesIO
    from PIL import Image
    try:
        with Image.open(BytesIO(data)) as image:
            extension = {"PNG": "png", "JPEG": "jpg", "WEBP": "webp"}.get(image.format, "png")
    except Exception:
        raise AgentError("upstream_error", "原生图像结果无法解码。") from None
    result_started = timing.monotonic()
    result_job = repo.jobs.stage_result(job.id, data, "native." + extension,
                                 {"provider": "agent_native", "requested": {**native_image_parameters(request["body"]["params"]), **({"model": request["frozen"]["imageModel"]} if request["frozen"]["imageModel"] else {})},
                                  "response": {k: item[k] for k in ("size", "quality", "output_format", "output_compression", "revised_prompt") if k in item}})
    repo.jobs.record_execution(job.id, phase='completed', resultWriteMs=timing.elapsed(result_started))
    return result_job


def call_responses(repo, request_id, step, refs, *, body_override=None, native_call_id=None):
    request = check_active(repo, request_id)
    profile = repo.verified_profile(request)
    try:
        measured = timing.ModelTiming(repo, request_id, step)
    except Exception:
        # No HTTP submission has begun; instrumentation failure is local.
        repo.update(request_id, outcome='known')
        raise
    config = request["frozen"]
    secret = profile["api_key"]
    foundations = default_skill_sections() if config.get('professionalPromptWorkflows', True) else []
    reused_skills = []
    try:
        projection = prepare_context(repo, request, refs) if body_override is None else None
        attached_refs = projection.attached_refs if projection else None
        if projection:
            reused_skills = projection.skill_receipts
        mask = ((projection.images.data_url(request["round"]["maskImageId"]) if projection else
                 context_image_url(repo, request["round"]["maskImageId"])) if request["round"].get("maskImageId") else None)
        input_items = projection.input if projection else None
        native_context = native_reference_snapshot(repo, refs, attached_refs)
    except AgentError as exc:
        if exc.code in {"reference_missing", "frozen_reference_invalid"}:
            # This preflight runs before HTTP, so failure is safely known.
            repo.update(request_id, outcome="known")
        measured.finish()
        raise
    body, foundations, prior_preloads = response_body(
        request, input_items, mask, secret, reused_skills=reused_skills, body_override=body_override)
    error_secrets = [secret, request['round']['prompt'], *(part.get('text') for entry in body.get('input', [])
        if isinstance(entry, dict) for part in entry.get('content', []) if isinstance(part, dict) and part.get('type') in {'input_text', 'output_text'})]
    output_state = ResponseOutput(request_id, step, request["round"]["responseOutput"], [secret], error_secrets=error_secrets)
    completed = None
    pending_native_images = {}
    native_started = {}
    byte_count = 0

    def publish(items):
        combined = output_state.publish(items)
        repo.update(request_id, output=combined, text=output_text(combined))

    def handle_payload(payload):
        nonlocal completed
        if not isinstance(payload, dict):
            raise AgentError("upstream_error", "Responses 返回格式无效。")
        output = payload.get("output", [])
        contains_image = isinstance(output, list) and any(isinstance(item, dict) and item.get("type") == "image_generation_call" for item in output)
        try:
            validate_response_payload(payload, require_completed=bool(pending_native_images) or contains_image, secrets=error_secrets)
        except AgentError:
            # Explicit failed/incomplete receipts may still report billable
            # usage. There are no confirmed final images to register here.
            with suppress(sqlite3.Error):
                record_model(payload)
                repo.record_response_details(request_id, step, payload, secrets=[secret])
            repo.update(request_id, outcome="known")
            raise
        completed = payload
        if (contains_image or pending_native_images) and not request['body']['authorization']['allowImageGeneration']:
            # A known terminal cannot grant a tool the caller did not authorize.
            # Reject before writing a Native image or successful recovery proof.
            with suppress(sqlite3.Error):
                record_model(payload)
                repo.record_response_details(request_id, step, payload, secrets=[secret])
            repo.update(request_id, outcome='known')
            raise AgentError('authorization_denied', '本轮未授权生成图片。')
        # All valid images in one terminal are protected before the first
        # optional SQLite observation. Do not preserve failed/incomplete output.
        final_images = output if "output" in payload else list(pending_native_images.values())
        from backend.services.agent_native_result_recovery import preserve_native_final, native_job_id
        from backend.services.generation_result_recovery import RecoveryConflict, job_directory
        preservation_errors = []
        final_image_ids = []
        for output_index,image_item in enumerate(final_images):
            if isinstance(image_item,dict) and image_item.get('type') == 'image_generation_call' and image_item.get('status') == 'completed':
                safe_item = {**redact({k:v for k,v in image_item.items() if k != 'result'}, [secret]), 'result':image_item.get('result')}
                final_image_ids.append(native_job_id(request_id,step,safe_item.get('id')))
                try:
                    preserve_native_final(repo.library, request, step, safe_item, native_context, output_index=output_index)
                except (OSError,RecoveryConflict) as exc:
                    preservation_errors.append(exc)
        if preservation_errors:
            # A broken first image/marker cannot abandon the other valid paid
            # images already carried by this same validated terminal receipt.
            for job_id in final_image_ids:
                try:
                    directory = job_directory(repo.library,job_id)
                    if directory.exists() and next(directory.glob('result-*'),None) is not None:
                        raise AgentError('local_result_pending',
                            '图片已取得，但本地恢复记录尚未完整保存；原图已保留，请检查原结果，不要重新生成。', 409) from None
                except (OSError,RecoveryConflict):
                    continue
            raise preservation_errors[0]
        check_active(repo, request_id)
        with suppress(sqlite3.Error):
            measured.event(receiving=True)
            record_model(payload)
            repo.record_response_details(request_id, step, payload, secrets=[secret])
        # Persist finality before optional diagnostics. A later timing write
        # cannot erase this valid terminal receipt or make it replayable.
        with suppress(sqlite3.Error):
            repo.update(request_id, outcome='known')
            measured.finish(completed=True)
        result_started = timing.monotonic()
        for item in output if "output" in payload else pending_native_images.values():
            if isinstance(item, dict) and item.get("type") == "image_generation_call":
                duration = timing.elapsed(native_started[item['id']]) if item.get('id') in native_started else None
                job = native_image(repo, request_id, step, item, refs, [secret], native_context=native_context, terminal=True, request_snapshot=request)
                if duration is not None and job:
                    repo.jobs.record_execution(job.id, providerMs=duration)
        if output:
            combined = output_state.complete(output)
            repo.update(request_id, output=combined, text=output_text(combined))
        repo.record_execution(request_id, add=True, resultProcessingMs=timing.elapsed(result_started))
        return payload

    def record_model(payload):
        if isinstance(payload, dict):
            model = safe_model_label(payload.get("model"), [secret])
            if model:
                repo.update(request_id, returned_model=model)

    if projection:
        try:
            projection.validate()
            repo.record_context_diagnostics(request_id, projection.summary(body))
        except Exception:
            # Preflight/diagnostics failures happen before a paid POST. They
            # must not turn a local failure into an uncertain upstream result.
            repo.update(request_id, outcome='known')
            measured.finish()
            raise
    client = create_api_client(profile, timeout=httpx.Timeout(profile["timeout"], connect=min(10, profile["timeout"])))
    key = key_for(repo.library, request_id)
    with _lock:
        _clients[key] = client
    try:
        repo.record_response_details(request_id, step)
        for skill in [*foundations, *reused_skills]:
            repo.record_skill_read(request_id, skill, preloaded=skill in foundations and skill not in prior_preloads)
        try:
            measured.start_http()
        except Exception:
            repo.update(request_id, outcome='known')
            raise
        with response_stream(client, "POST", profile["base_url"].rstrip("/") + "/responses", is_complete=lambda: completed is not None,
                           headers={"Authorization": "Bearer " + secret, "Content-Type": "application/json"}, json=body,
                           extensions={"trace": measured.transport.trace}) as response:
            measured.headers()
            if not response.is_success:
                # Never interpolate arbitrary upstream bodies/headers into errors.
                repo.update(request_id, outcome="known")
                raise AgentError("upstream_error", f"Responses 返回 HTTP {response.status_code}；请求不会自动重试。", diagnostics=safe_http_failure(response, secrets=error_secrets))
            if "text/event-stream" not in response.headers.get("content-type", ""):
                chunks = []
                for chunk in response.iter_bytes():
                    check_active(repo, request_id)
                    byte_count += len(chunk)
                    if byte_count > MAX_RESPONSE_BYTES:
                        raise AgentError("upstream_error", "Responses 数据过大。")
                    chunks.append(chunk)
                payload = json.loads(b"".join(chunks))
                completed = handle_payload(payload)
            else:
                data_lines, sse_event_id = [], None
                def consume():
                    nonlocal completed, sse_event_id
                    if not data_lines:
                        return
                    data = "\n".join(data_lines)
                    data_lines.clear()
                    event_id, sse_event_id = sse_event_id, None
                    if data == "[DONE]":
                        return
                    event = json.loads(data)
                    kind = event.get("type")
                    if isinstance(kind, str) and kind.startswith('response.') and kind != 'response.completed':
                        with suppress(sqlite3.Error):
                            measured.event(receiving=kind.startswith(('response.output_', 'response.image_generation_call.')))
                    if kind != "response.completed":
                        check_active(repo, request_id)
                    if kind != "response.completed":
                        with suppress(sqlite3.Error):
                            record_model(event.get("response"))
                    if kind in {"error", "response.failed", "response.incomplete"}:
                        repo.record_response_details(request_id, step, event.get("response"), secrets=[secret])
                        repo.update(request_id, outcome="known")
                        source = event.get('response') if isinstance(event.get('response'), dict) else event
                        raise AgentError("upstream_error", "Responses 流未成功完成；不会自动重试。",
                            diagnostics=safe_diagnostics({'error': source.get('error') or source}, secrets=error_secrets, allow_message=True))
                    if kind == "response.output_text.delta":
                        combined = output_state.delta(event, event_id)
                        if combined is not None:
                            with suppress(sqlite3.Error):
                                repo.update(request_id, output=combined, text=output_text(combined))
                    if kind in {"response.output_item.added", "response.output_item.done"}:
                        item = event.get("item")
                        if isinstance(item, dict):
                            if item.get("type") == "image_generation_call":
                                if item.get('id') and kind == 'response.output_item.added':
                                    native_started.setdefault(item['id'], timing.monotonic())
                                if item.get("id") and (kind == "response.output_item.done" or item["id"] not in pending_native_images):
                                    pending_native_images[item["id"]] = item
                                # Item completion is not response completion.
                                # Keep a running job until the final receipt is
                                # validated, even if bytes arrived in this item.
                                with suppress(sqlite3.Error):
                                    native_image(repo, request_id, step, {**item, "status": "in_progress", "result": None}, refs, [secret], native_context=native_context)
                            combined = output_state.item(event)
                            with suppress(sqlite3.Error):
                                repo.update(request_id, output=combined, text=output_text(combined))
                    if kind == "response.image_generation_call.partial_image":
                        # Partial bytes are not persisted in the conversation JSON.
                        tool_id = event.get("item_id")
                        if tool_id:
                            native_started.setdefault(tool_id, timing.monotonic())
                            job = None
                            with suppress(sqlite3.Error):
                                job = native_image(repo, request_id, step, {"id": tool_id, "type": "image_generation_call", "status": "in_progress"}, refs, [secret], native_context=native_context)
                            raw = event.get("partial_image_b64")
                            if job and isinstance(raw, str) and raw:
                                # Preview decoding/storage is best-effort. Keep
                                # reading the paid stream for its valid final;
                                # authorization/stop and terminal checks stay outside.
                                with suppress(sqlite3.Error, OSError, ValueError):
                                    preview = repo.store_asset(base64.b64decode(raw, validate=True), {"kind": "job", "jobId": job.id})
                                    with connect(repo.library) as conn:
                                        latest = conn.execute("SELECT metadata FROM generation_jobs WHERE id=?", (job.id,)).fetchone()
                                        metadata = json.loads(latest[0])
                                        metadata["agent"]["partialImageId"] = preview["id"]
                                        conn.execute("UPDATE generation_jobs SET metadata=? WHERE id=?", (encoded(metadata), job.id))
                                        repo._touch(conn, request["conversation_id"])
                    if kind and kind.startswith("response.web_search_call."):
                        publish([{"type": "web_search_call", "id": event.get("item_id"),
                                  "status": "completed" if kind.endswith("completed") else "failed" if kind.endswith("failed") else "in_progress"}])
                    if kind == "response.completed":
                        payload = event.get("response")
                        # The event supplies finality for gateways omitting status.
                        if isinstance(payload, dict) and "status" not in payload:
                            payload = {**payload, "status": "completed"}
                        completed = handle_payload(payload)
                for line in response.iter_lines():
                    byte_count += len(line.encode("utf-8"))
                    if byte_count > MAX_RESPONSE_BYTES:
                        raise AgentError("upstream_error", "Responses 数据过大。")
                    if line == "":
                        consume()
                        if completed is not None:
                            break
                    elif line.startswith("data:"):
                        data_lines.append(line[5:].lstrip(" "))
                    elif line.startswith("id:"):
                        sse_event_id = line[3:].strip()
                if completed is None:
                    consume()
        if completed is None:
            raise AgentError("upstream_outcome_unknown", "Responses 流已断开，未收到最终结果；不会自动重试。")
        final = output_state.current_output
        # Completion may omit output; current_output retains the streamed items.
        # Some gateways send public summaries in output-item events only.
        repo.record_response_details(request_id, step, {**completed, "output": final}, secrets=[secret])
        return final, redact(completed.get("id"), [secret])
    finally:
        try:
            measured.finish(completed=completed is not None)
        finally:
            with suppress(httpx.TransportError):
                client.close()
            with _lock:
                if _clients.get(key) is client:
                    _clients.pop(key, None)


def parse_image_arguments(call):
    try:
        value = json.loads(call.get("arguments", "{}"))
    except (ValueError, TypeError):
        raise AgentError("upstream_error", "模型图像工具参数不是有效 JSON。") from None
    if not isinstance(value, dict):
        raise AgentError("upstream_error", "模型图像工具参数必须是 JSON 对象。")
    return value


def parse_images(call, arguments=None):
    value = parse_image_arguments(call) if arguments is None else arguments
    raw = value.get("images") if call["name"] == "generate_image_batch" else [value]
    if not isinstance(raw, list) or not raw:
        raise AgentError("upstream_error", "模型未提供图片参数。")
    result, seen = [], set()
    for i, item in enumerate(raw):
        if not isinstance(item, dict) or not isinstance(item.get("prompt"), str) or not item["prompt"].strip():
            raise AgentError("upstream_error", "模型提供了空图片提示词。")
        base = str(item.get("id") or f"image_{i + 1}").strip()
        item_id = base
        suffix = 2
        while item_id in seen:
            item_id = f"{base}_{suffix}"
            suffix += 1
        seen.add(item_id)
        result.append({"id": item_id, "prompt": item["prompt"]})
    return result


def execute_calls(repo, request_id, step, output, refs):
    started = timing.monotonic()
    try:
        return _execute_calls(repo, request_id, step, output, refs)
    finally:
        repo.record_execution(request_id, phase='processing_results', add=True, toolsMs=timing.elapsed(started))


def _execute_calls(repo, request_id, step, output, refs):
    from backend.services.generation_queue import enqueue_generation_jobs
    function_outputs = []
    for call in output:
        if call.get("type") != "function_call":
            continue
        call_id, name = call.get("call_id"), call.get("name")
        if not isinstance(call_id, str) or not call_id:
            raise AgentError("upstream_error", "模型工具缺少 call_id。")
        request = check_active(repo, request_id)
        if name == "read_agent_skill" and not request["frozen"].get("professionalPromptWorkflows", True):
            raise AgentError("capability_unsupported", "本轮已关闭图片提示词专业工作流。", 400)
        existing = next((o for o in request["round"]["responseOutput"] if o.get("type") == "function_call_output" and o.get("call_id") == call_id), None)
        if existing:
            function_outputs.append(existing)
            continue
        if name == "read_agent_skill":
            try:
                arguments = json.loads(call.get("arguments", "{}"))
                if not isinstance(arguments, dict) or set(arguments) - {"skill", "section"}:
                    raise ValueError("Invalid skill arguments")
                result = read_agent_skill(arguments.get("skill"), arguments.get("section", "overview"))
            except (ValueError, TypeError):
                result = {"error": "Unknown built-in skill or section. Use the names in the skill catalog."}
            else:
                repo.record_skill_read(request_id, result)
        elif name == "continue_generation":
            if not request["body"]["authorization"]["allowImageGeneration"] or not request["round"]["outputTaskIds"]:
                raise AgentError("authorization_denied", "没有已授权的前置图片可供继续生成。")
            result = {"status": "continued"}
        elif name == 'select_image_references':
            try:
                arguments = json.loads(call.get('arguments', '{}'))
            except (ValueError, TypeError):
                result = {'error': '图片选择参数不是有效 JSON；请使用提供的引用标识。'}
            else:
                result = {'editingTask': repo.select_request_references(request_id, arguments, refs)}
        elif name == 'update_task_context':
            try:
                arguments = json.loads(call.get('arguments', '{}'))
                result = {'taskContext': repo.update_task_context(request_id, arguments, refs)}
            except AgentError as exc:
                result = {'error': exc.message, 'code': exc.code}
            except (ValueError, TypeError):
                result = {'error': '任务状态参数无效；最后有效状态保持不变。'}
        elif name == 'read_task_history':
            arguments = json.loads(call.get('arguments', '{}'))
            numbers = arguments.get('roundNumbers') if isinstance(arguments, dict) else None
            if (not isinstance(arguments, dict) or set(arguments) != {'roundNumbers'} or not isinstance(numbers, list) or not 1 <= len(numbers) <= 6
                    or any(type(number) is not int or number < 1 for number in numbers)):
                raise AgentError('invalid_task_context', '历史读取仅接受指定的分支轮次。', 400)
            rows = [r for r in request['history'] if r['index'] in numbers]
            if {r['index'] for r in rows} != set(numbers):
                raise AgentError('reference_missing', '指定历史不在本轮冻结分支中。', 400)
            evidence = [{'roundId': r['id'], 'roundNumber': r['index'], 'user': r['prompt'],
                         'assistant': r.get('assistantContent', ''),
                         'promptVersions': [{'id': p['id'], 'kind': p['kind'],
                                             'source': {key: p['source'][key] for key in ('kind', 'roundId', 'messageId') if key in p['source']}}
                                            for p in (r.get('taskContext') or {}).get('promptVersions', [])[-8:]],
                         'refs': [ref for ref, aid in refs.items() if aid and ref.startswith(f"round-{r['index']}-")]} for r in rows]
            if len(encoded(evidence).encode('utf-8')) > 200_000:
                result = {'error': '所选历史正文过大，请用户选择更具体的来源或完整分支范围；原文未截断。'}
            else:
                with connect(repo.library) as conn:
                    row = json.loads(conn.execute('SELECT data FROM agent_rounds WHERE id=?', (request['round_id'],)).fetchone()[0])
                    row['contextEvidenceRoundIds'] = list(dict.fromkeys([*row.get('contextEvidenceRoundIds', []), *(r['id'] for r in rows)]))
                    repo._save_round(conn, row)
                result = {'history': evidence, 'pixelsAttachedOnNextStep': True}
        elif name in {"generate_image", "generate_image_batch"}:
            if not request["body"]["authorization"]["allowImageGeneration"]:
                raise AgentError("authorization_denied", "本轮未授权生成图片。")
            if name == "generate_image_batch" and request["round"].get("maskImageId"):
                raise AgentError("capability_unsupported", "遮罩编辑使用单图原生工具，不支持此批量函数。", 400)
            if name == "generate_image" and request["frozen"]["apiConfigMode"] != "hybrid":
                raise AgentError("capability_unsupported", "当前原生模式未启用此函数工具。", 400)
            if request["frozen"]["apiConfigMode"] != "hybrid":
                # Native batch calls are run as bounded individual Responses image
                # tasks through the same job queue, never an Images fallback.
                native = True
            else:
                native = False
            arguments = parse_image_arguments(call)
            images = parse_images(call, arguments)
            remaining = request["body"]["authorization"]["maxImageJobs"] - request["usage"]["imageJobsCreated"]
            with connect(repo.library) as conn:
                already = conn.execute("SELECT count(*) FROM agent_tool_jobs WHERE request_id=? AND step=? AND call_id=?", (request_id, step, call_id)).fetchone()[0]
            if len(images) - already > remaining:
                raise AgentError("budget_exhausted", "本批图片超过本轮剩余额度。")
            selection = arguments.get('referenceSelection')
            update = arguments.get('taskContextUpdate')
            receipt = ({'step': step, 'callId': call_id,
                        'argumentsSha256': hashlib.sha256(encoded(arguments).encode('utf-8')).hexdigest()}
                       if update is not None else None)
            applied = repo.task_update_receipt(request_id, receipt) if receipt else False
            planned = request
            if update is not None and not applied:
                from backend.services import agent_task_state
                candidate = repo.update_task_context(request_id, update, refs, dry_run=True,
                                                    tool_receipt=receipt, reference_selection=selection)
                planned = {**request, 'round': {**request['round'], 'taskContext': candidate,
                    'editingTask': agent_task_state.project_editing(candidate, request['round'].get('editingTask'))}}
            task = (editing.execution_task(planned['round']) if update is not None
                    else editing.select_references(repo, planned, selection, refs) if selection is not None
                    else editing.execution_task(planned['round']))
            # Preflight the whole batch before changing the branch selection or
            # creating its first job. Legacy calls without selection retain the
            # same unresolved-target protection as before.
            for image in images:
                image_reference_ids(task, image['prompt'], refs)
            if update is not None and not applied:
                repo.update_task_context(request_id, update, refs, tool_receipt=receipt, reference_selection=selection)
            # Inline selection/state share the receipt transaction. Recovery
            # reaches the linked-job guard without replaying an older selection.
            if update is None:
                if selection is not None:
                    repo.select_request_references(request_id, selection, refs)
                else:
                    repo.confirm_request_image_roles(request_id, refs)
            jobs = []
            repo.record_execution(request_id, phase='waiting_jobs')
            for image in images:
                job = create_image_job(repo, request_id, step, call_id, image["id"] if name == "generate_image_batch" else "single", image["prompt"], refs, native=native)
                jobs.append((image, job))
                repo.record_task_execution(request_id, image['prompt'])
            if native:
                # Queue-integrated native batch provider is identified explicitly.
                for _, job in jobs:
                    with connect(repo.library) as conn:
                        conn.execute("UPDATE generation_jobs SET provider='agent_native_batch' WHERE id=? AND status='queued'", (job.id,))
                enqueue_generation_jobs(repo.library, provider="agent_native_batch")
            else:
                enqueue_generation_jobs(repo.library, provider="openai_compatible")
            repo.update(request_id, state="waiting_for_jobs")
            generating = False
            while True:
                check_active(repo, request_id)
                current = [repo.jobs.get_job(job.id) for _, job in jobs]
                if any(job.metadata.get('local_result_recovery') for job in current):
                    raise AgentError('local_result_pending', '图片已取得，本地保存记录待恢复；请恢复原结果，不要重新生成。')
                if not generating and any(job.status == 'running' for job in current):
                    generating = True
                    repo.record_execution(request_id, phase='generating_images')
                if all(job.status not in {"queued", "running"} for job in current):
                    break
                time.sleep(0.05)
            results = [{"id": image["id"], "status": "done" if job.status in {"succeeded", "accepted"} else "error",
                        **({} if job.status in {"succeeded", "accepted"} else {"error": job.error or "图像生成失败"})}
                       for (image, _), job in zip(jobs, current)]
            result = {"images": results} if name == "generate_image_batch" else results[0]
        else:
            raise AgentError("capability_unsupported", "模型调用了未启用的工具。", 400)
        item = {"type": "function_call_output", "call_id": call_id, "output": encoded(result)}
        function_outputs.append(item)
        request = repo.request(request_id)
        repo.update(request_id, output=merge_output(request["round"]["responseOutput"], [item]), state="running", outcome="known")
        if name in {"generate_image", "generate_image_batch"} and any(result["status"] == "error" for result in results):
            raise AgentError("image_job_failed", timing.image_failure_message(current))
    return function_outputs


def generation_finishes_request(repo, request, calls):
    """Only an explicit, successful terminal image call can omit a summary POST."""
    if len(calls) != 1 or calls[0].get("name") not in {"generate_image", "generate_image_batch"}:
        return False
    try:
        arguments = json.loads(calls[0].get("arguments", "{}"))
    except (ValueError, TypeError):
        return False
    if not isinstance(arguments, dict) or arguments.get("finish_after_generation") is not True:
        return False
    # Prefer the normal multi-step path for explicit extra deliverables, even
    # when a provider incorrectly marks its image call as terminal.
    if re.search(r"分析|比较|对比|解释|评价|评估|总结|提示词|先.+再|然后|之后|接着|"
                 r"\b(?:analy[sz]e|compare|explain|evaluate|summari[sz]e|prompt|then|afterward)\b",
                 request["round"]["prompt"], re.I | re.S):
        return False
    if request["stop_requested"] or not request["round"]["outputTaskIds"]:
        return False
    paired = [o for o in request["round"]["responseOutput"]
              if o.get("type") == "function_call_output" and o.get("call_id") == calls[0].get("call_id")]
    if len(paired) != 1:
        return False
    try:
        result = json.loads(paired[0]["output"])
        results = result.get("images") if calls[0]["name"] == "generate_image_batch" else [result]
        if not isinstance(results, list) or not results or any(r.get("status") != "done" for r in results):
            return False
    except (ValueError, TypeError, KeyError, AttributeError):
        return False
    return all(repo.jobs.get_job(jid).status in {"succeeded", "accepted"} for jid in request["round"]["outputTaskIds"])


def run_request(library, request_id):
    from backend.services.generation_queue import _provider_slots
    repo = AgentRepository(library)
    try:
        direct_request = repo.request(request_id)
        if direct_request['round'].get('kind') == 'prompt_execution':
            if direct_request['state'] not in ACTIVE_STATES:
                return
            from backend.services.agent_recipe_execution import run_execution
            run_execution(repo, request_id)
            return
        while True:
            request = check_active(repo, request_id)
            repo.verified_profile(request)
            pending = next((s for s in reversed(request["steps"]) if s["state"] == "completed"), None)
            if pending:
                output = json.loads(pending["output"])
                calls = [o for o in output if o.get("type") == "function_call"]
                paired = {o.get("call_id") for o in request["round"]["responseOutput"] if o.get("type") == "function_call_output"}
                if any(c.get("call_id") not in paired for c in calls):
                    execute_calls(repo, request_id, pending["step"], output, refs_for_request(repo, request))
                    request = check_active(repo, request_id)
                state_answer_complete = (calls and all(c.get('name') == 'update_task_context' for c in calls)
                    and bool(output_text(output).strip()) and all('error' not in json.loads(o.get('output', '{}'))
                        for o in request['round']['responseOutput'] if o.get('type') == 'function_call_output' and o.get('call_id') in {c.get('call_id') for c in calls}))
                if not calls or state_answer_complete or generation_finishes_request(repo, request, calls):
                    current_jobs = [repo.jobs.get_job(jid) for jid in request['round']['outputTaskIds']]
                    if any(job.status not in {"succeeded", "accepted"} for job in current_jobs):
                        raise AgentError("image_job_failed", timing.image_failure_message(current_jobs))
                    repo.update(request_id, state="completed", outcome="known")
                    return
            if request["usage"]["responseStepsStarted"] >= request["body"]["authorization"]["maxToolRounds"]:
                raise AgentError("budget_exhausted", "本轮工具调用轮数已用尽；请查看本轮结果，需要继续时明确发起新请求。")
            preparation_started = timing.monotonic()
            refs = refs_for_request(repo, request)
            repo.record_execution(request_id, phase='preparing', add=True, preparationMs=timing.elapsed(preparation_started))
            step = request["usage"]["responseStepsStarted"] + 1
            with connect(repo.library) as conn:
                conn.execute("BEGIN IMMEDIATE")
                stored = conn.execute("SELECT stop_requested FROM agent_requests WHERE id=?", (request_id,)).fetchone()
                if stored[0]:
                    raise AgentError("stopped", "已停止生成。")
                usage = dict(request["usage"], responseStepsStarted=step)
                conn.execute("INSERT INTO agent_steps(request_id,step,state) VALUES(?,?,'sending')", (request_id, step))
                conn.execute("UPDATE agent_requests SET usage=?,state='running',upstream_outcome='unknown' WHERE id=?", (encoded(usage), request_id))
                repo._touch(conn, request["conversation_id"])
            native = request["frozen"]["apiConfigMode"] != "hybrid" and request["body"]["authorization"]["allowImageGeneration"]
            acquired = False
            try:
                if native:
                    while not _provider_slots.acquire(timeout=0.1):
                        check_active(repo, request_id)
                    acquired = True
                check_active(repo, request_id)
                output, response_id = call_responses(repo, request_id, step, refs)
            finally:
                if acquired:
                    _provider_slots.release()
            with connect(repo.library) as conn:
                conn.execute("UPDATE agent_steps SET state='completed',output=?,response_id=? WHERE request_id=? AND step=?", (encoded(output), response_id, request_id, step))
            result_started = timing.monotonic()
            request = repo.request(request_id)
            combined = merge_output(request["round"]["responseOutput"], output)
            repo.update(request_id, output=combined, text=output_text(combined), response_id=response_id, outcome="known")
            repo.record_execution(request_id, add=True, resultProcessingMs=timing.elapsed(result_started))
    except Exception as exc:
        if isinstance(exc, ApiNetworkError):
            repo.update(request_id, outcome="known")
        request = repo.request(request_id)
        failed_native = []
        local_pending = isinstance(exc,AgentError) and exc.code == 'local_result_pending'
        for jid in request["round"]["outputTaskIds"]:
            job = repo.jobs.get_job(jid)
            if repo.jobs.local_result_recovery(jid) is not None:
                local_pending = True
                continue
            if job.provider == "agent_native" and job.status in {"queued", "running"}:
                repo.jobs.mark_failed(jid, "原生图片请求未完成；不会自动重试。", diagnostics=exception_diagnostics(exc))
                failed_native.append(jid)
        if request["stop_requested"]:
            repo.update(request_id, state="stopped", error={"code": "stopped", "message": "已停止生成。"})
        else:
            code = 'local_result_pending' if local_pending else exc.code if isinstance(exc, AgentError) else "network_configuration" if isinstance(exc, ApiNetworkError) else "upstream_outcome_unknown" if request["upstream_outcome"] == "unknown" else "upstream_error"
            message = '图片已取得，本地保存记录待恢复；请检查原结果，不要重新生成。' if local_pending else exc.message if isinstance(exc, (AgentError, ApiNetworkError)) else "Agent 请求未完成；原请求不会自动重试。"
            state = "interrupted" if code == "interrupted" and request["upstream_outcome"] != "unknown" else "unknown" if request["upstream_outcome"] == "unknown" else "failed"
            repo.update(request_id, state=state, error={"code": code, "message": message, 'diagnostics': exception_diagnostics(exc)})
        # Optional diagnostics are last. Even another instrumentation error
        # must leave the request and its claimed jobs in durable terminal states.
        from backend.services.agent_diagnostics import classify_failure
        for jid in failed_native:
            repo.jobs.record_execution(jid, phase='unknown' if classify_failure(exception_diagnostics(exc))['outcomeUnknown'] else 'failed')
    finally:
        with _lock:
            _futures.pop(key_for(library, request_id), None)


def fail_unstarted_agent_job(repo, job_id, message):
    from backend.services.generation_jobs import now
    timestamp = now()
    with connect(repo.library) as conn:
        conn.execute("UPDATE generation_jobs SET status='failed',error=?,completed_at=?,updated_at=? WHERE id=? AND status='queued'",
                     (message, timestamp, timestamp, job_id))


def run_compatible_agent_job(library, job_id):
    """Resolve credentials once per dispatch; defaults cannot redirect this job."""
    from backend.services.openai_compatible import OpenAICompatibleConfig, OpenAICompatibleProvider
    repo = AgentRepository(library)
    job = repo.jobs.get_job(job_id)
    link = job.metadata['agent']
    request_id = link['requestId']
    try:
        request = check_active(repo, request_id)
        profile = repo.verified_profile(request, image=True)
        if link.get('executionKind') == 'prompt_execution':
            from backend.services.agent_recipe_execution import verify_job_recipe
            verify_job_recipe(repo, request, job)
        class FrozenConfig:
            def validate_path(self, library_path):
                OpenAICompatibleConfig(library_path=library_path).validate_path(library_path)

            def read(self, profile_id=None):
                check_active(repo, request_id)
                return dict(profile)
        client = create_api_client(profile, timeout=profile["timeout"])
        key = (*key_for(library, request_id), job_id, uuid4().hex)
        with _lock:
            _clients[key] = client
        try:
            provider_class = OpenAICompatibleProvider
            if link.get('executionKind') == 'prompt_execution':
                class RecipeProvider(OpenAICompatibleProvider):
                    def _input_images(self, selected_job, library_path):
                        images = super()._input_images(selected_job, library_path)
                        verify_job_recipe(repo, check_active(repo, request_id), selected_job,
                                          input_bytes=[image[1] for image in images])
                        return images
                provider_class = RecipeProvider
            provider_client = client
            if link.get('executionKind') == 'prompt_execution':
                from backend.services.agent_recipe_execution import RecipeDispatchClient
                provider_client = RecipeDispatchClient(client, library, job)
            return provider_class(config=FrozenConfig(), http_client=provider_client).run_job(library, job_id)
        finally:
            client.close()
            with _lock:
                _clients.pop(key, None)
    except Exception as exc:
        # The provider owns failures after its atomic mark_running claim. A
        # losing/duplicate worker must never fail another worker's active job.
        fail_unstarted_agent_job(repo, job_id, exc.message if isinstance(exc, (AgentError, ApiNetworkError)) else "Agent 图片请求未完成；不会自动重试。")
        raise


class NativeAgentImageProvider:
    """One native batch image occupies one existing generation queue slot."""
    def run_job(self, library, job_id):
        preparation_started = timing.monotonic()
        repo = AgentRepository(library)
        job = repo.jobs.get_job(job_id)
        link = (job.metadata or {}).get("agent", {})
        request_id = link.get("requestId")
        client, key, claimed = None, (*key_for(library, request_id), job_id, uuid4().hex), False
        provider_started, provider_ms = None, None
        try:
            request = check_active(repo, request_id)
            profile = repo.verified_profile(request)
            if job.status != "queued":
                raise AgentError("resume_not_safe", "原生图片任务不会重复提交。")
            if link.get('executionKind') == 'prompt_execution':
                from backend.services.agent_recipe_execution import verify_job_recipe
                verify_job_recipe(repo, request, job)
            repo.jobs.mark_running(job_id, **({'queued_only': True} if link.get('executionKind') == 'prompt_execution' else {}))
            claimed = True
            content = [{"type": "input_text", "text": job.prompt_text}]
            recipe_bytes = [] if link.get('executionKind') == 'prompt_execution' else None
            from backend.services.generation_jobs import resolve_generation_input_image_path
            for spec in job.parameters.get("input_images", []):
                path, mime = resolve_generation_input_image_path(repo.library, spec["result_path"])
                if recipe_bytes is not None:
                    from backend.services.agent_recipe_execution import native_recipe_binding
                    reference = request['round']['directRecipe']['references'][len(recipe_bytes)]
                    data = path.read_bytes()
                    recipe_bytes.append(data)
                    content.append(native_recipe_binding(reference))
                    content.append({"type": "input_image", "image_url": encode_verified_image(data, mime)})
                else:
                    content.append({"type": "input_image", "image_url": encode_verified_image(path.read_bytes(), mime)})
            image_tool = {"type": "image_generation", "action": "auto",
                          **native_image_parameters(request["body"]["params"])}
            if request["frozen"]["imageModel"]:
                image_tool["model"] = request["frozen"]["imageModel"]
            body = {"model": request["frozen"]["textModel"], "stream": False, "input": [{"role": "user", "content": content}],
                    "tools": [image_tool], "tool_choice": {"type": "image_generation"}, "max_tool_calls": 1}
            check_active(repo, request_id)
            if link.get('executionKind') == 'prompt_execution':
                verify_job_recipe(repo, request, job, input_bytes=recipe_bytes)
            repo.record_response_details(request_id, link.get("step", 1), native_job_id=job_id)
            client = create_api_client(profile, timeout=httpx.Timeout(profile["timeout"], connect=min(10, profile["timeout"])))
            with _lock:
                _clients[key] = client
            payload = None
            repo.jobs.record_execution(job_id, phase='generating', preparationMs=timing.elapsed(preparation_started))
            provider_started = timing.monotonic()
            if link.get('executionKind') == 'prompt_execution':
                from backend.services.agent_recipe_execution import record_recipe_dispatch
                record_recipe_dispatch(library, job)
            # No image is staged until a successful final response is validated.
            with response_stream(client, "POST", profile["base_url"].rstrip("/") + "/responses", is_complete=lambda: payload is not None,
                                 headers={"Authorization": "Bearer " + profile["api_key"]}, json=body) as response:
                if not response.is_success:
                    raise AgentError("upstream_error", f"原生图片接口返回 HTTP {response.status_code}。",
                        diagnostics=safe_http_failure(response, secrets=(profile['api_key'], job.prompt_text)))
                payload = read_native_response(response, lambda: check_active(repo, request_id), secrets=(profile['api_key'], job.prompt_text))
                provider_ms = timing.elapsed(provider_started)
            result_started = timing.monotonic()
            images = [item for item in payload.get("output", []) if isinstance(item, dict) and item.get("type") == "image_generation_call"]
            if len(images) == 1 and images[0].get('status') == 'failed':
                record_native_failed_terminal(repo, job_id)
                raise AgentError('upstream_error', '原生图像工具未能生成图片。', diagnostics=safe_diagnostics(
                    {'error': images[0].get('error')}, secrets=(profile['api_key'], job.prompt_text), allow_message=True))
            if len(images) != 1 or images[0].get("status") != "completed" or not images[0].get("result"):
                raise AgentError("upstream_error", "原生单图任务未返回恰好一张图片。")
            value = images[0]["result"]
            if isinstance(value, dict):
                value = next((value[k] for k in ("b64_json", "base64", "image", "data") if isinstance(value.get(k), str)), None)
            from PIL import Image
            from io import BytesIO
            try:
                if not isinstance(value, str) or not value:
                    raise ValueError("missing image bytes")
                data = base64.b64decode(value.split(",", 1)[-1] if value.startswith("data:") else value, validate=True)
                with Image.open(BytesIO(data)) as image:
                    image.verify()
                    extension = {"PNG": "png", "JPEG": "jpg", "WEBP": "webp"}.get(image.format, "png")
            except (ValueError, OSError):
                raise AgentError("upstream_error", "原生图片结果无法解码。") from None
            revised = redact(images[0].get('revised_prompt'), [profile['api_key']])
            repo.jobs.stage_result(job_id, data, "native." + extension,
                                         {"provider": "agent_native_batch", "requested": {k: v for k, v in image_tool.items() if k not in {"type", "action"}},
                                          "response": {"response_id": redact(payload.get("id"), [profile["api_key"]]),
                                                       **({'revised_prompt': revised} if isinstance(revised, str) and revised.strip() else {})}}, job_snapshot=job)
            repo.jobs.record_execution(job_id, phase='processing_results', providerMs=provider_ms)
            repo.record_response_details(request_id, link.get("step", 1), payload, native_job_id=job_id, secrets=[profile["api_key"]])
            repo.jobs.record_execution(job_id, phase='completed', resultWriteMs=timing.elapsed(result_started))
            return repo.jobs.get_job(job_id)
        except Exception as exc:
            if repo.jobs.local_result_recovery(job_id) is not None:
                return repo.jobs.get_job(job_id)
            if claimed and repo.jobs.get_job(job_id).status == "running":
                from backend.services.agent_diagnostics import classify_failure
                diagnostics = exception_diagnostics(exc)
                measurements = {'providerMs': provider_ms if provider_ms is not None else timing.elapsed(provider_started)} if provider_started is not None else {
                    'preparationMs': timing.elapsed(preparation_started)}
                repo.jobs.mark_failed(job_id, exc.message if isinstance(exc, (AgentError, ApiNetworkError)) else "原生图片请求未完成；不会自动重试。", diagnostics=diagnostics)
                repo.jobs.record_execution(job_id, phase='unknown' if classify_failure(diagnostics)['outcomeUnknown'] else 'failed', **measurements)
            elif not claimed:
                fail_unstarted_agent_job(repo, job_id, exc.message if isinstance(exc, (AgentError, ApiNetworkError)) else "原生图片请求未完成；不会自动重试。")
            raise
        finally:
            if client:
                with suppress(httpx.TransportError):
                    client.close()
            with _lock:
                if _clients.get(key) is client:
                    _clients.pop(key, None)


def schedule_request(library, request_id):
    key = key_for(library, request_id)
    with _lock:
        if (key not in _futures or _futures[key].done()) and key[0] not in _closing:
            _futures[key] = _executor.submit(run_request, library, request_id)


def stop_request(library, request_id):
    result = AgentRepository(library).stop(request_id)
    with _lock:
        clients = [client for key, client in _clients.items() if key[:2] == key_for(library, request_id)]
    for client in clients:
        with suppress(Exception):
            client.close()
    return result


def recover_agent_requests(library):
    repo = AgentRepository(library)
    repo.jobs.recover_local_results()
    with _lock:
        _closing.discard(str(repo.library.resolve()))
    interrupted_images = repo.jobs.mark_running_provider_jobs_failed("agent_native", "原生图片请求被后端重启中断；未自动重发。")
    for job in interrupted_images:
        # No live monotonic origin survives a restart. Preserve measured fields
        # without deriving a duration from timestamps or implying safe replay.
        repo.jobs.record_execution(job.id, phase='unknown')
        repo.jobs.mark_failed(job.id, "原生图片请求被后端重启中断；未自动重发。", diagnostics={'category': 'incomplete_stream'})
    with connect(repo.library) as conn:
        rows = conn.execute("SELECT id,state,upstream_outcome FROM agent_requests WHERE state IN ('queued','running','waiting_for_jobs','stop_requested')").fetchall()
    for row in rows:
        if row["state"] == "queued" and row["upstream_outcome"] == "not_sent":
            schedule_request(library, row["id"])
        else:
            repo.update(row["id"], state="unknown" if row["upstream_outcome"] == "unknown" else "interrupted",
                        error={"code": "upstream_outcome_unknown" if row["upstream_outcome"] == "unknown" else "interrupted", "message": "后端重启中断了本轮请求；未自动重发。"})


def drain_agent_requests(library):
    from pathlib import Path
    path = str(Path(library).resolve())
    with _lock:
        _closing.add(path)
        clients = [c for key, c in _clients.items() if key[0] == path]
        futures = [f for key, f in _futures.items() if key[0] == path]
    for client in clients:
        with suppress(Exception):
            client.close()
    for future in futures:
        with suppress(Exception):
            future.result()
    # Child image workers must finish before the app releases its library lease.
    # Their HTTP clients were closed above; no worker can schedule a new call.
    from backend.services import generation_queue
    with connect(library) as conn:
        job_ids = {row[0] for row in conn.execute("SELECT job_id FROM agent_tool_jobs")}
    while True:
        with generation_queue._lock:
            pending = job_ids.intersection(generation_queue._active)
        if not pending:
            break
        time.sleep(0.05)
