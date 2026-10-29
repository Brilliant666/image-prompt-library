"""Durable Agent conversations, frozen requests and references in the main library."""
from __future__ import annotations

import hashlib
import json
import re
import time
from io import BytesIO
from pathlib import Path
from urllib.parse import quote
from uuid import uuid4

from PIL import Image

from backend.agent_schemas import AgentConfig, AgentRoundCreate
from backend.db import connect, init_db
from backend.schemas import GenerationJobCreate
from backend.services.generation_jobs import (
    GenerationJobRepository, resolve_generation_input_image_path,
    resolve_generation_write_path, _validate_storeable_image_bytes,
)
from backend.services.image_store import _atomic_write_bytes
from backend.services.openai_compatible import OpenAICompatibleConfig, OpenAICompatibleError, normalize_image_parameters
from backend.services import agent_execution_timing as timing
from backend.services import agent_editing_task as editing
from backend.services import agent_task_state as task_state
from backend.services.api_network import NETWORK_DEFAULTS, network_identity

ACTIVE_STATES = {"queued", "running", "waiting_for_jobs", "stop_requested"}
ROUND_MENTION = re.compile(r"@(?:第)?(\d+)轮图(\d+)")
REF_TAG = re.compile(r'<ref\b[^>]*\bid=[\"\'](round-\d+-(?:image|reference)-\d+)[\"\'][^>]*\s*/?>')


def milliseconds():
    return int(time.time() * 1000)


def encoded(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def fingerprint(value):
    return hashlib.sha256(encoded(value).encode("utf-8")).hexdigest()


def profile_digest(profile):
    return fingerprint({**{k: v for k, v in profile.items() if k not in NETWORK_DEFAULTS},
                        **network_identity(profile)})


class AgentError(ValueError):
    def __init__(self, code, message, status=409, *, diagnostics=None):
        self.code, self.message, self.status = code, message, status
        from backend.services.agent_diagnostics import safe_diagnostics
        self.diagnostics = safe_diagnostics(diagnostics)
        super().__init__(message)


def public_profile_digest(profile):
    return fingerprint({k: profile.get(k) for k in ("id", "base_url", "model", "timeout")})


def safe_model_label(value, secrets=()):
    """Keep only bounded display text; model metadata must never echo credentials."""
    if not isinstance(value, str):
        return None
    for secret in secrets:
        if secret:
            value = value.replace(secret, "[redacted]")
    return "".join(character for character in value if character.isprintable()).strip()[:256] or None


def model_info(frozen, round_data):
    saved = round_data.get("modelInfo", {})
    return {"requestedModel": safe_model_label(frozen.get("textModel")),
            "providerName": safe_model_label(frozen.get("_textProviderName")),
            "returnedModels": [label for value in saved.get("returnedModels", [])
                               if (label := safe_model_label(value))][:50]}


TOKEN_FIELDS = ("inputTokens", "outputTokens", "totalTokens", "cachedInputTokens", "reasoningTokens")


def response_usage(payload):
    """Only numeric provider token counts belong in public response details."""
    usage = payload.get("usage") if isinstance(payload, dict) else None
    usage = usage if isinstance(usage, dict) else {}
    inputs = usage.get("input_tokens_details")
    outputs = usage.get("output_tokens_details")
    values = (usage.get("input_tokens"), usage.get("output_tokens"), usage.get("total_tokens"),
              inputs.get("cached_tokens") if isinstance(inputs, dict) else None,
              outputs.get("reasoning_tokens") if isinstance(outputs, dict) else None)
    return {key: value if type(value) is int and 0 <= value <= 2 ** 53 - 1 else None
            for key, value in zip(TOKEN_FIELDS, values)}


def public_reasoning_summaries(payload, secrets=()):
    """Expose explicit provider summaries, never reasoning content or opaque state."""
    output = payload.get("output") if isinstance(payload, dict) else None
    summaries = []
    shortened = "\n（摘要过长，仅显示部分）"
    for item in output if isinstance(output, list) else []:
        if not isinstance(item, dict) or item.get("type") != "reasoning":
            continue
        parts = item.get("summary")
        for part in parts if isinstance(parts, list) else []:
            if not isinstance(part, dict) or part.get("type") != "summary_text" or not isinstance(part.get("text"), str):
                continue
            text = part["text"]
            for secret in secrets:
                if secret:
                    text = text.replace(secret, "[redacted]")
            text = "".join(c for c in text if c.isprintable() or c in "\n\t").strip()
            if len(text) > 4000:
                text = text[:4000 - len(shortened)] + shortened
            if text and text not in summaries:
                if len(summaries) >= 8:
                    if not summaries[-1].endswith(shortened):
                        summaries[-1] = summaries[-1][:4000 - len(shortened)] + shortened
                    return summaries
                summaries.append(text)
    return summaries


def aggregate_response_usage(steps):
    # An unknown counter is not zero, including a started call without a receipt.
    counts = [item["usage"] for item in steps]
    totals = {}
    for field in TOKEN_FIELDS:
        values = [item.get(field) for item in counts]
        total = sum(values) if counts and all(value is not None for value in values) else None
        totals[field] = total if total is not None and total <= 2 ** 53 - 1 else None
    return {**totals, "reportedSteps": sum(any(value is not None for value in item.values()) for item in counts),
            "totalSteps": len(steps), "complete": bool(steps) and all(totals[field] is not None for field in TOKEN_FIELDS[:3])}


class AgentRepository:
    def __init__(self, library_path):
        self.library = Path(library_path)
        init_db(self.library)
        self.jobs = GenerationJobRepository(self.library)

    def config(self):
        with connect(self.library) as conn:
            row = conn.execute("SELECT * FROM agent_config WHERE singleton=1").fetchone()
        config = AgentConfig.model_validate(json.loads(row["config"]) if row else {}).model_dump()
        profiles = OpenAICompatibleConfig(library_path=self.library).public_profiles()["profiles"]
        issues = []
        if not config["textModel"].strip():
            issues.append({"code": "configuration_incomplete", "field": "textModel", "message": "请选择 Responses 文本模型。"})
        selected = next((p for p in profiles if p["id"] == config["textProfileId"]), None)
        if config["apiConfigMode"] != "off" and (not selected or not selected["configured"]):
            issues.append({"code": "configuration_incomplete", "field": "textProfileId", "message": "请选择已配置的文本 API 配置。"})
        image_issues = []
        if config["apiConfigMode"] == "hybrid":
            image = next((p for p in profiles if p["id"] == config["imageProfileId"]), None)
            if not image or not image["configured"]:
                image_issues.append({"code": "configuration_incomplete", "field": "imageProfileId", "message": "请选择已配置的图片 API 配置；仍可发送纯文本消息。"})
            elif not (config["imageModel"].strip() or image["model"].strip()):
                image_issues.append({"code": "configuration_incomplete", "field": "imageModel", "message": "请选择图片模型，或设置该图片 API 配置的默认模型。"})
        return {"revision": row["revision"] if row else 0, "config": config, "profiles": profiles,
                "ready": not issues, "issues": issues,
                "imageReady": not issues and not image_issues, "imageIssues": image_issues,
                "capabilities": {"modes": ["off", "native", "hybrid"], "maxInputImages": 4,
                                 "maxToolRounds": 50, "maxImageJobs": 20, "webSearch": True,
                                 "masks": config["apiConfigMode"] != "hybrid", "progressTransport": "sse"}}

    def save_config(self, payload):
        with connect(self.library) as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute("SELECT revision FROM agent_config WHERE singleton=1").fetchone()
            revision = row[0] if row else 0
            if revision != payload.expectedRevision:
                raise AgentError("revision_conflict", "设置已改变，请重新加载。")
            conn.execute("INSERT INTO agent_config VALUES(1,?,?) ON CONFLICT(singleton) DO UPDATE SET revision=excluded.revision,config=excluded.config",
                         (revision + 1, encoded(payload.config.model_dump())))
        return self.config()

    def _conversation(self, conn, cid):
        row = conn.execute("SELECT * FROM agent_conversations WHERE id=? AND deleted=0", (cid,)).fetchone()
        if row is None:
            raise AgentError("not_found", "对话不存在。", 404)
        return row

    def _touch(self, conn, cid):
        conn.execute("UPDATE agent_conversations SET revision=revision+1,updated_at=? WHERE id=?", (milliseconds(), cid))

    def _rounds(self, conn, cid):
        rounds = [json.loads(r[0]) for r in conn.execute("SELECT data FROM agent_rounds WHERE conversation_id=? AND deleted=0 ORDER BY rowid", (cid,))]
        by_id = {r['id']: r for r in rounds}
        for value in rounds:
            value['retryTaskIds'] = []
        for row in conn.execute("SELECT id,metadata FROM generation_jobs WHERE json_extract(metadata,'$.agentRetry.conversationId')=? ORDER BY created_at,id", (cid,)):
            link = json.loads(row['metadata'])['agentRetry']
            if link.get('roundId') in by_id:
                by_id[link['roundId']].setdefault('retryTaskIds', []).append(row['id'])
        return rounds

    def _save_round(self, conn, value):
        conn.execute("UPDATE agent_rounds SET data=?,parent_round_id=? WHERE id=?",
                     (encoded(value), value["parentRoundId"], value["id"]))
        # Every round mutation, including late timing/diagnostic receipts, must
        # advance its observation marker in the same transaction. Millisecond
        # wall time alone can alias two writes and hide a historical change.
        conn.execute('UPDATE agent_requests SET updated_at=MAX(updated_at+1,?) WHERE round_id=?',
                     (milliseconds(), value['id']))

    def create_conversation(self, payload):
        now = milliseconds()
        context = task_state.new('', None)
        context['revision'] = 0
        drafts = {editing.branch_key(None): task_state.envelope(None, context)}
        with connect(self.library) as conn:
            conn.execute("INSERT OR IGNORE INTO agent_conversations(id,title,created_at,updated_at,editing_tasks) VALUES(?,?,?,?,?)",
                         (payload.id, payload.title, now, now, encoded(drafts)))
        return self.snapshot(payload.id)

    def list_conversations(self, limit=50, cursor=None, q=None):
        offset = int(cursor or 0)
        query = (q or "").strip()
        where, parameters = "c.deleted=0", []
        if query:
            # Search only visible prose; tool arguments and internal response JSON
            # must not make an otherwise unrelated conversation match.
            pattern = "%" + query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
            where += """ AND (c.title LIKE ? ESCAPE '\\' OR EXISTS (
                SELECT 1 FROM agent_rounds r WHERE r.conversation_id=c.id AND r.deleted=0
                AND (json_extract(r.data, '$.prompt') LIKE ? ESCAPE '\\'
                  OR json_extract(r.data, '$.assistantContent') LIKE ? ESCAPE '\\')
            ))"""
            parameters.extend([pattern, pattern, pattern])
        with connect(self.library) as conn:
            rows = conn.execute(f"SELECT c.* FROM agent_conversations c WHERE {where} ORDER BY c.updated_at DESC,c.id LIMIT ? OFFSET ?",
                                (*parameters, limit + 1, offset)).fetchall()
            values = []
            for row in rows[:limit]:
                running = conn.execute("SELECT id FROM agent_requests WHERE conversation_id=? AND state IN ('queued','running','waiting_for_jobs','stop_requested') LIMIT 1", (row["id"],)).fetchone()
                values.append({"id": row["id"], "title": row["title"], "activeRoundId": row["active_round_id"],
                               "createdAt": row["created_at"], "updatedAt": row["updated_at"], "revision": row["revision"],
                               "roundCount": conn.execute("SELECT count(*) FROM agent_rounds WHERE conversation_id=? AND deleted=0", (row["id"],)).fetchone()[0],
                               "runningRequestId": running[0] if running else None})
        return {"conversations": values, "nextCursor": str(offset + limit) if len(rows) > limit else None}

    def patch_conversation(self, cid, payload):
        with connect(self.library) as conn:
            conn.execute("BEGIN IMMEDIATE")
            current = self._conversation(conn, cid)
            if current["revision"] != payload.expectedRevision:
                raise AgentError("revision_conflict", "对话已改变，请重新加载。")
            if "activeRoundId" in payload.model_fields_set:
                if payload.activeRoundId and not any(r["id"] == payload.activeRoundId for r in self._rounds(conn, cid)):
                    raise AgentError("not_found", "分支不存在。", 404)
                conn.execute("UPDATE agent_conversations SET active_round_id=? WHERE id=?", (payload.activeRoundId, cid))
            if payload.title is not None:
                conn.execute("UPDATE agent_conversations SET title=? WHERE id=?", (payload.title, cid))
            self._touch(conn, cid)
        return self.snapshot(cid)

    def patch_editing_task(self, cid, payload):
        with connect(self.library) as conn:
            conversation = self._conversation(conn, cid)
            rounds = self._rounds(conn, cid)
        if payload.branchRoundId and not any(r['id'] == payload.branchRoundId for r in rounds):
            raise AgentError('not_found', '编辑任务分支不存在。', 404)
        if conversation['revision'] != payload.expectedRevision:
            raise AgentError('revision_conflict', '对话已改变，请重新加载。')
        value = None
        if payload.task is not None:
            branch_history = self.path(rounds, payload.branchRoundId)
            allowed_round_ids = {row['id'] for row in branch_history}
            known_assets = self._legacy_frozen_assets(branch_history)
            current_task = editing.current_task(conversation, rounds, payload.branchRoundId)
            for image in ([current_task['target']] if current_task and current_task.get('target') else []) + (current_task.get('auxiliaries', []) if current_task else []):
                known_assets[encoded(image['source'])] = image['assetId']
            def selected(ref):
                source_key = encoded(ref.model_dump(exclude_none=True))
                known = known_assets.get(source_key)
                aid = self._check_frozen_asset(self.asset(known), source_key) if known else self.resolve_ref(ref)
                if ref.kind == 'upload':
                    with connect(self.library) as conn:
                        owners = conn.execute("""SELECT id FROM agent_rounds WHERE deleted=0 AND (
                            EXISTS(SELECT 1 FROM json_each(data,'$.inputImageIds') WHERE value=?) OR
                            EXISTS(SELECT 1 FROM json_each(data,'$.taskImageIds') WHERE value=?))""", (aid, aid)).fetchall()
                    if owners and not any(owner['id'] in allowed_round_ids for owner in owners):
                        raise AgentError('invalid_reference', '此上传图片不属于当前分支；请通过图库明确导入或重新添加。', 400)
                return editing.asset_selection(self, aid)
            value = {'version': 1, 'conversationId': cid, 'branchRoundId': payload.branchRoundId,
                     'target': selected(payload.task.target) if payload.task.target else None,
                     'auxiliaries': [{**selected(item.ref), 'role': item.role} for item in payload.task.auxiliaries],
                     'requirements': payload.task.requirements, 'constraints': payload.task.constraints,
                     'workflow': payload.task.workflow, 'needsTargetSelection': payload.task.target is None,
                     'configIdentity': None}
            images = editing.required_asset_ids(value)
            if len(images) != len(value['auxiliaries']) + (1 if value['target'] else 0):
                raise AgentError('invalid_reference', '编辑对象和辅助参考不能重复。', 400)
        with connect(self.library) as conn:
            conn.execute('BEGIN IMMEDIATE')
            current = self._conversation(conn, cid)
            if current['revision'] != payload.expectedRevision:
                raise AgentError('revision_conflict', '对话已改变，请重新加载。')
            if conn.execute("SELECT 1 FROM agent_requests WHERE conversation_id=? AND state IN ('queued','running','waiting_for_jobs','stop_requested')", (cid,)).fetchone():
                raise AgentError('request_active', '请等待本轮完成后再修改编辑任务。')
            drafts = json.loads(current['editing_tasks'])
            context = task_state.current(current, rounds, payload.branchRoundId)
            # Existing editing controls remain compatible, while new state
            # cannot retain a stale target or erase branch-local provenance.
            if context is not None:
                context = task_state.advance(context, value, prompt=payload.task.requirements if payload.task else '',
                                             branch_id=payload.branchRoundId, boundary=payload.task is None, explicit_target=True)
                if payload.task:
                    context['constraints'] = [{'id': task_state.identifier('constraint'), 'text': text, 'status': 'active',
                                                'source': task_state.source('user', payload.branchRoundId)}
                                               for text in payload.task.constraints]
                archive = self._task_prompt_archive(current, payload.branchRoundId)
                if context['taskId'] != (task_state.current(current, rounds, payload.branchRoundId) or {}).get('taskId'):
                    archive = {}
                drafts[editing.branch_key(payload.branchRoundId)] = task_state.envelope(value, context, archive)
            else:
                drafts[editing.branch_key(payload.branchRoundId)] = value
            conn.execute('UPDATE agent_conversations SET editing_tasks=? WHERE id=?', (encoded(drafts), cid))
            self._touch(conn, cid)
        return self.snapshot(cid)

    def _task_asset_selector(self, cid, rounds, branch_id, context=None, *, frozen_refs=None):
        """Validate branch ownership and frozen bytes before a state mutation."""
        branch_history = self.path(rounds, branch_id)
        allowed_round_ids = {row['id'] for row in branch_history}
        known_assets = self._legacy_frozen_assets(branch_history)
        for image in ([context['target']] if context and context.get('target') else []) + (context.get('auxiliaries', []) if context else []):
            known_assets[encoded(image['source'])] = image['assetId']

        def selected(ref):
            if isinstance(ref, str):
                if frozen_refs is None or ref not in frozen_refs:
                    raise AgentError('reference_missing', '图片不在本轮冻结引用中。', 400)
                asset_id = frozen_refs[ref]
                asset = self.asset(asset_id)
                self._check_frozen_asset(asset, asset['source'])
                return editing.asset_selection(self, asset_id)
            from backend.agent_schemas import AgentRef
            from pydantic import ValidationError
            try:
                parsed = AgentRef.model_validate(ref)
            except ValidationError:
                raise AgentError('invalid_reference', '图片引用无效。', 400) from None
            source_key = encoded(parsed.model_dump(exclude_none=True))
            known = known_assets.get(source_key)
            asset_id = self._check_frozen_asset(self.asset(known), source_key) if known else self.resolve_ref(parsed)
            if frozen_refs is not None and asset_id not in frozen_refs.values():
                raise AgentError('invalid_reference', '模型只能选择本轮冻结引用。', 400)
            if parsed.kind == 'upload':
                with connect(self.library) as conn:
                    owners = conn.execute("""SELECT id FROM agent_rounds WHERE deleted=0 AND (
                        EXISTS(SELECT 1 FROM json_each(data,'$.inputImageIds') WHERE value=?) OR
                        EXISTS(SELECT 1 FROM json_each(data,'$.taskImageIds') WHERE value=?))""", (asset_id, asset_id)).fetchall()
                if owners and not any(owner['id'] in allowed_round_ids for owner in owners):
                    raise AgentError('invalid_reference', '此上传图片不属于当前分支。', 400)
            return editing.asset_selection(self, asset_id)
        return selected

    def _task_source_validator(self, rounds, branch_id):
        allowed = {row['id']: row for row in self.path(rounds, branch_id)}

        def validate(provenance, text):
            if (not isinstance(provenance, dict) or set(provenance) - {'kind', 'roundId', 'messageId'}
                    or not isinstance(provenance.get('kind'), str) or provenance['kind'] not in {'user', 'model'}
                    or not isinstance(provenance.get('roundId'), str)
                    or provenance['roundId'] not in allowed):
                raise AgentError('invalid_task_source', 'Prompt 来源不属于当前分支。', 400)
            row = allowed[provenance['roundId']]
            kind = provenance['kind']
            message_id = row['userMessageId'] if kind == 'user' else row['assistantMessageId']
            if provenance.get('messageId') and provenance['messageId'] != message_id:
                raise AgentError('invalid_task_source', 'Prompt 来源消息不匹配。', 400)
            original = row['prompt'] if kind == 'user' else row.get('assistantContent', '')
            if text is not None and text not in original:
                raise AgentError('invalid_task_source', '所选 Prompt 必须保留来源消息原文。', 400)
            return {**provenance, 'messageId': message_id}
        return validate

    @staticmethod
    def _task_prompt_archive(conversation, branch_id):
        draft = json.loads(conversation['editing_tasks']).get(editing.branch_key(branch_id))
        return dict(draft.get('_taskPromptArchive', {})) if isinstance(draft, dict) else {}

    def _task_prompt_restorer(self, conversation, rounds, branch_id, context):
        task_id = (context or {}).get('taskId')
        versions = {}
        for row in self.path(rounds, branch_id):
            if (row.get('taskContext') or {}).get('taskId') == task_id:
                versions.update({p['id']: p for p in row['taskContext']['promptVersions']})
                versions.update(row.get('_taskPromptArchive', {}))
            draft = json.loads(conversation['editing_tasks']).get(editing.branch_key(row['id']))
            if isinstance(draft, dict) and (draft.get('taskContext') or {}).get('taskId') == task_id:
                versions.update(draft.get('_taskPromptArchive', {}))
        versions.update(self._task_prompt_archive(conversation, branch_id))
        return versions.get

    def patch_task_context(self, cid, payload):
        with connect(self.library) as conn:
            conversation = self._conversation(conn, cid)
            rounds = self._rounds(conn, cid)
        if payload.branchRoundId and not any(row['id'] == payload.branchRoundId for row in rounds):
            raise AgentError('not_found', '任务分支不存在。', 404)
        if conversation['revision'] != payload.expectedRevision:
            raise AgentError('revision_conflict', '对话已改变，请重新加载。')
        old = task_state.current(conversation, rounds, payload.branchRoundId)
        self._check_task_revision(old, payload.taskRevision)
        prompt_archive = self._task_prompt_archive(conversation, payload.branchRoundId)
        value = task_state.apply(old, payload.operations, actor='user', branch_id=payload.branchRoundId,
                                 select_asset=self._task_asset_selector(cid, rounds, payload.branchRoundId, old),
                                 validate_source=self._task_source_validator(rounds, payload.branchRoundId),
                                 prompt_archive=prompt_archive,
                                 restore_prompt=self._task_prompt_restorer(conversation, rounds, payload.branchRoundId, old))
        if old and value['taskId'] != old['taskId']:
            prompt_archive = {}
        old_edit = editing.current_task(conversation, rounds, payload.branchRoundId)
        edit = task_state.project_editing(value, old_edit)
        with connect(self.library) as conn:
            conn.execute('BEGIN IMMEDIATE')
            current = self._conversation(conn, cid)
            if current['revision'] != payload.expectedRevision:
                raise AgentError('revision_conflict', '对话已改变，请重新加载。')
            self._check_task_revision(task_state.current(current, self._rounds(conn, cid), payload.branchRoundId),
                                      payload.taskRevision)
            if conn.execute("SELECT 1 FROM agent_requests WHERE conversation_id=? AND state IN ('queued','running','waiting_for_jobs','stop_requested')", (cid,)).fetchone():
                raise AgentError('request_active', '请等待本轮完成后再修改当前任务。')
            drafts = json.loads(current['editing_tasks'])
            drafts[editing.branch_key(payload.branchRoundId)] = task_state.envelope(edit, value, prompt_archive)
            conn.execute('UPDATE agent_conversations SET editing_tasks=? WHERE id=?', (encoded(drafts), cid))
            self._touch(conn, cid)
        return self.snapshot(cid)

    @staticmethod
    def _check_task_revision(context, revision):
        if revision is not None and (context or {}).get('revision', 0) != revision:
            raise AgentError('task_revision_conflict', '当前任务已改变，请重新读取任务状态。')

    def delete(self, cid, round_id=None):
        with connect(self.library) as conn:
            conn.execute("BEGIN IMMEDIATE")
            active = conn.execute("SELECT 1 FROM agent_requests WHERE conversation_id=? AND state IN ('queued','running','waiting_for_jobs','stop_requested')", (cid,)).fetchone()
            if active:
                raise AgentError("request_active", "请先停止当前对话请求。")
            if round_id is None:
                conn.execute("UPDATE agent_conversations SET deleted=1 WHERE id=?", (cid,))
                return {"id": cid, "deleted": True}
            self._conversation(conn, cid)
            rounds = self._rounds(conn, cid)
            target = next((r for r in rounds if r["id"] == round_id), None)
            if target:
                conn.execute("UPDATE agent_rounds SET deleted=1 WHERE id=?", (round_id,))
                old_paths = {r["id"]: self.path(rounds, r["id"]) for r in rounds}
                remaining = [r for r in rounds if r["id"] != round_id]
                for r in remaining:
                    if r["parentRoundId"] == round_id:
                        r["parentRoundId"] = target["parentRoundId"]
                for r in remaining:
                    new_path = self.path(remaining, r["id"])
                    indices = {part["id"]: i + 1 for i, part in enumerate(new_path)}
                    old_path = old_paths[r["id"]]
                    def remap(match):
                        old = int(match[1]) - 1
                        if old >= len(old_path):
                            return match[0]
                        index = indices.get(old_path[old]["id"])
                        return f"@第{index}轮图{match[2]}" if index else f"@已删除轮次图{match[2]}"
                    r["prompt"] = ROUND_MENTION.sub(remap, r["prompt"])
                    r["index"] = len(new_path)
                    self._save_round(conn, r)
                conn.execute("UPDATE agent_conversations SET active_round_id=? WHERE id=? AND active_round_id=?", (remaining[-1]["id"] if remaining else None, cid, round_id))
                draft_row = self._conversation(conn, cid)
                drafts = json.loads(draft_row['editing_tasks'])
                drafts.pop(editing.branch_key(round_id), None)
                conn.execute('UPDATE agent_conversations SET editing_tasks=? WHERE id=?', (encoded(drafts), cid))
                self._touch(conn, cid)
        return self.snapshot(cid)

    @staticmethod
    def path(rounds, round_id):
        by_id = {r["id"]: r for r in rounds}
        result, seen = [], set()
        while round_id and round_id not in seen:
            seen.add(round_id)
            value = by_id.get(round_id)
            if not value:
                break
            result.insert(0, value)
            round_id = value["parentRoundId"]
        return result

    def store_asset(self, data, source, kind="reference"):
        if len(data) > 30 * 1024 * 1024:
            raise AgentError("invalid_reference", "参考图片不能超过 30 MiB。", 413)
        try:
            _validate_storeable_image_bytes(data)
        except ValueError:
            raise AgentError("invalid_reference", "上传内容不是有效图片。", 400) from None
        with Image.open(BytesIO(data)) as im:
            fmt, width, height = im.format, im.width, im.height
        if fmt not in {"PNG", "JPEG", "WEBP"}:
            raise AgentError("invalid_reference", "请使用 PNG、JPEG 或 WebP 图片。", 400)
        asset_id = "agentimg_" + uuid4().hex
        if source is None:
            source = {"kind": "upload", "uploadId": asset_id}
        suffix = {"PNG": "png", "JPEG": "jpg", "WEBP": "webp"}[fmt]
        relative = f"generation-references/agent/{asset_id}.{suffix}"
        path = resolve_generation_write_path(self.library, relative, allowed_root="generation-references")
        path.parent.mkdir(parents=True, exist_ok=True)
        _atomic_write_bytes(path, data)
        with connect(self.library) as conn:
            conn.execute("INSERT INTO agent_assets VALUES(?,?,?,?,?,?,?,?,?)", (asset_id, encoded(source), relative,
                         Image.MIME[fmt], width, height, hashlib.sha256(data).hexdigest(), milliseconds(), kind))
        return self.image(asset_id)

    def asset(self, asset_id):
        with connect(self.library) as conn:
            row = conn.execute("SELECT * FROM agent_assets WHERE id=?", (asset_id,)).fetchone()
        if row is None:
            raise AgentError("reference_missing", "参考图片不存在。", 404)
        return dict(row)

    def image(self, asset_id):
        if asset_id.startswith("output_"):
            job_id = asset_id[7:]
            try:
                job = self.jobs.get_job(job_id)
                path = job.result_path if job.status in {"succeeded", "accepted"} else None
                available = bool(path and (self.library / path).is_file())
                partial = (job.metadata or {}).get("agent", {}).get("partialImageId")
                preview = self.image(partial) if partial and job.status in {"queued", "running"} else None
                return {"id": asset_id, "source": {"kind": "job", "jobId": job_id},
                        "status": "available" if available else "pending" if job.status in {"queued", "running"} else "removed",
                        "url": "/media/" + quote(path, safe="/") if available else preview["url"] if preview else None, "thumbnailUrl": None,
                        "width": job.result_width, "height": job.result_height, "sha256": job.result_sha256,
                        "mimeType": Image.MIME.get({".png": "PNG", ".jpg": "JPEG", ".jpeg": "JPEG", ".webp": "WEBP"}.get(Path(path or "").suffix))}
            except KeyError:
                return {"id": asset_id, "source": {"kind": "job", "jobId": job_id}, "status": "removed",
                        "url": None, "thumbnailUrl": None, "width": None, "height": None, "sha256": None, "mimeType": None}
        asset = self.asset(asset_id)
        available = (self.library / asset["path"]).is_file()
        return {"id": asset_id, "source": json.loads(asset["source"]), "status": "available" if available else "removed",
                "url": "/media/" + quote(asset["path"], safe="/") if available else None, "thumbnailUrl": None,
                "width": asset["width"], "height": asset["height"], "mimeType": asset["mime_type"], "sha256": asset["sha256"]}

    def _check_frozen_asset(self, asset, source_key):
        """Never repair an established snapshot from a possibly changed source."""
        try:
            if not asset or encoded(json.loads(asset["source"])) != source_key or asset["kind"] != "reference":
                raise ValueError("snapshot identity mismatch")
            path, _ = resolve_generation_input_image_path(
                self.library, asset["path"], allowed_roots={"generation-references"})
            if hashlib.sha256(path.read_bytes()).hexdigest() != asset["sha256"]:
                raise ValueError("snapshot bytes changed")
        except (ValueError, OSError, KeyError):
            raise AgentError("frozen_reference_invalid", "已冻结的参考图片缺失或损坏；不会用其他图片替换。", 400) from None
        return asset["id"]

    def _freeze_source(self, ref, legacy_asset_id=None):
        source_key = encoded(ref)
        # Serialize the first freeze across threads/processes. Atomic file replace
        # precedes the transaction commit, so a visible mapping always has complete
        # bytes. A crash before commit leaves one deterministic, unreferenced file;
        # retry validates the original source and uses that same path, not a new UUID.
        with connect(self.library) as conn:
            lookup = "SELECT a.* FROM agent_frozen_sources f JOIN agent_assets a ON a.id=f.asset_id WHERE f.source_key=?"
            mapped = conn.execute(lookup, (source_key,)).fetchone()
            if mapped:
                return self._check_frozen_asset(mapped, source_key)
            # Most reads reuse immutable snapshots without taking a writer lock.
            # On a miss, another request may win before this transaction starts.
            conn.execute("BEGIN IMMEDIATE")
            mapped = conn.execute(lookup, (source_key,)).fetchone()
            if mapped:
                return self._check_frozen_asset(mapped, source_key)
            if legacy_asset_id:
                legacy = conn.execute("SELECT * FROM agent_assets WHERE id=?", (legacy_asset_id,)).fetchone()
                asset_id = self._check_frozen_asset(legacy, source_key)
                conn.execute("INSERT INTO agent_frozen_sources(source_key,asset_id) VALUES(?,?)", (source_key, asset_id))
                return asset_id
            try:
                if ref["kind"] == "library":
                    _, path, _ = self.jobs.resolve_library_reference(ref["imageId"])
                else:
                    job = self.jobs.get_job(ref["jobId"])
                    if job.status not in {"succeeded", "accepted"} or not job.result_path:
                        raise KeyError(ref["jobId"])
                    path, _ = resolve_generation_input_image_path(self.library, job.result_path)
                data = path.read_bytes()
            except (KeyError, ValueError, OSError):
                raise AgentError("reference_missing", "参考图片已删除或尚未生成。", 400) from None
            if len(data) > 30 * 1024 * 1024:
                raise AgentError("invalid_reference", "参考图片不能超过 30 MiB。", 413)
            try:
                _validate_storeable_image_bytes(data)
                with Image.open(BytesIO(data)) as im:
                    fmt, width, height = im.format, im.width, im.height
                suffix = {"PNG": "png", "JPEG": "jpg", "WEBP": "webp"}[fmt]
            except (ValueError, KeyError, OSError):
                raise AgentError("invalid_reference", "参考图片不是有效的 PNG、JPEG 或 WebP。", 400) from None
            source_digest = hashlib.sha256(source_key.encode("utf-8")).hexdigest()
            asset_id = "agentimg_frozen_" + source_digest
            relative = f"generation-references/agent/frozen/{source_digest}.{suffix}"
            frozen_path = resolve_generation_write_path(self.library, relative, allowed_root="generation-references")
            frozen_path.parent.mkdir(parents=True, exist_ok=True)
            _atomic_write_bytes(frozen_path, data)
            conn.execute("INSERT INTO agent_assets VALUES(?,?,?,?,?,?,?,?,?)", (asset_id, source_key, relative,
                         Image.MIME[fmt], width, height, hashlib.sha256(data).hexdigest(), milliseconds(), "reference"))
            conn.execute("INSERT INTO agent_frozen_sources(source_key,asset_id) VALUES(?,?)", (source_key, asset_id))
            return asset_id

    def _legacy_frozen_assets(self, history):
        """Adopt only proven snapshots from this parent's already-frozen ancestry.

        Native previews have the same source job ID, so searching agent_assets by
        source alone is unsafe. One parent-history read supplies all candidates;
        no startup rewrite or scan of every conversation/request is necessary.
        """
        if not history:
            return {}
        candidates = {}
        with connect(self.library) as conn:
            row = conn.execute("SELECT history FROM agent_requests WHERE id=?", (history[-1]["requestId"],)).fetchone()
            # Persisted input IDs are also proven references, including Library
            # images whose originals have since been deleted. Uploads and masks
            # retain their separate ownership and never become source mappings.
            input_ids = list({aid for item in history for aid in editing.all_input_ids(item)})
            for asset in conn.execute("SELECT a.id,a.source FROM agent_assets a JOIN json_each(?) i ON i.value=a.id WHERE a.kind='reference' ORDER BY a.created_at,a.id",
                                      (encoded(input_ids),)):
                source = json.loads(asset["source"])
                if source.get("kind") in {"job", "library"}:
                    candidates.setdefault(encoded(source), asset["id"])
        if not row:
            return candidates
        candidates.update(self._output_snapshot_candidates(history, [json.loads(row[0])]))
        return candidates

    @staticmethod
    def _output_snapshot_candidates(history, snapshots):
        ancestors = {item["id"]: item for item in history}
        candidates = {}
        for item in (item for snapshot in snapshots for item in snapshot):
            ancestor = ancestors.get(item.get("id"))
            if not ancestor:
                continue
            for index, asset_id in enumerate(item.get("frozenOutputImages") or []):
                jobs = editing.all_output_ids(ancestor)
                old_jobs = editing.all_output_ids(item)
                if asset_id and index < len(jobs) and index < len(old_jobs) and jobs[index] == old_jobs[index]:
                    candidates.setdefault(encoded({"kind": "job", "jobId": jobs[index]}), asset_id)
        return candidates

    def _legacy_ancestor_outputs(self, cid, history):
        # Only used after a missing live source and a cheap matching-asset check.
        # An old parent may have lost its snapshot after Gallery cleanup, while
        # an earlier request on this exact branch still owns the original bytes.
        # Fetch the ancestry in ONE query, never all conversations/per-source scans.
        request_ids = encoded([item["requestId"] for item in history])
        with connect(self.library) as conn:
            rows = conn.execute("SELECT history FROM agent_requests WHERE conversation_id=? AND id IN (SELECT value FROM json_each(?)) ORDER BY created_at DESC,id DESC",
                                (cid, request_ids)).fetchall()
        return self._output_snapshot_candidates(history, [json.loads(row[0]) for row in rows])

    def resolve_ref(self, ref, *, legacy_asset_id=None):
        ref = ref.model_dump(exclude_none=True) if hasattr(ref, "model_dump") else ref
        key = {"library": "imageId", "job": "jobId", "upload": "uploadId"}.get(ref.get("kind"))
        if not key or set(ref) != {"kind", key} or not ref.get(key):
            raise AgentError("invalid_reference", "参考图片标识无效。", 400)
        if ref["kind"] == "upload":
            asset = self.asset(ref[key])
            if json.loads(asset["source"]).get("kind") != "upload":
                raise AgentError("invalid_reference", "上传图片标识无效。", 400)
            resolve_generation_input_image_path(self.library, asset["path"])
            return asset["id"]
        return self._freeze_source(ref, legacy_asset_id)

    def data_url(self, asset_id):
        from backend.services.agent_image_inputs import ImageInputSession
        return ImageInputSession(self).data_url(asset_id)

    def resolve_config(self, body):
        document = self.config()
        if document["revision"] != body.configRevision:
            raise AgentError("config_revision_conflict", "设置已改变，请重新加载。")
        config = dict(document["config"])
        store = OpenAICompatibleConfig(library_path=self.library)
        text_id = body.activeProfileId if config["apiConfigMode"] == "off" else config["textProfileId"]
        if not text_id or not config["textModel"].strip():
            raise AgentError("configuration_incomplete", "请选择文本 API 配置和 Responses 模型。", 400)
        try:
            text = store.read(text_id)
        except (ValueError, OpenAICompatibleError):
            raise AgentError("configuration_incomplete", "所选文本 API 配置不存在。", 400) from None
        if not text["api_key"] or not text["base_url"]:
            raise AgentError("configuration_incomplete", "文本 API 配置不完整。", 400)
        auth = body.authorization
        if auth.allowImageGeneration and body.imageCount > config['maxImageJobs']:
            raise AgentError('authorization_denied', f'本轮希望生成 {body.imageCount} 张图片，超过当前设置的图片上限 {config["maxImageJobs"]} 张。', 400)
        if auth.maxToolRounds > config["maxToolRounds"] or auth.maxImageJobs > config["maxImageJobs"]:
            raise AgentError("authorization_denied", "请求额度超过当前设置。", 400)
        if auth.allowWebSearch and not config["webSearch"]:
            raise AgentError("authorization_denied", "当前设置未启用网络搜索。", 400)
        if (not auth.allowImageGeneration and auth.maxImageJobs != 0) or (auth.allowImageGeneration and auth.maxImageJobs < 1):
            raise AgentError("authorization_denied", "生图授权与图片额度不一致。", 400)
        if auth.allowImageGeneration and body.imageCount > auth.maxImageJobs:
            raise AgentError('authorization_denied', f'本轮希望生成 {body.imageCount} 张图片，超过本轮可生成的 {auth.maxImageJobs} 张。', 400)
        selection = body.imageConfig
        if selection is not None:
            if config["apiConfigMode"] != "hybrid" and selection.profileId is not None:
                raise AgentError("capability_unsupported", "原生生图使用文本 API 配置，不能指定独立图片供应商。", 400)
            if selection.profileId is not None:
                config["imageProfileId"] = selection.profileId
            config["imageModel"] = selection.model.strip()
        image = text if config["apiConfigMode"] != "hybrid" else None
        # A turn-local selection is validated and frozen even for text-only
        # requests; it never grants permission to create an image job.
        if (auth.allowImageGeneration or selection is not None) and config["apiConfigMode"] == "hybrid":
            if not config["imageProfileId"]:
                raise AgentError("configuration_incomplete", "请选择图片 API 配置。", 400)
            try:
                image = store.read(config["imageProfileId"])
            except (ValueError, OpenAICompatibleError):
                raise AgentError("configuration_incomplete", "所选图片 API 配置不存在。", 400) from None
            model = config["imageModel"].strip() or image["model"].strip()
            if not image["api_key"] or not image["base_url"] or not model:
                raise AgentError("configuration_incomplete", "图像 API 配置不完整。", 400)
            config["imageModel"] = model
        digests = {text["id"]: profile_digest(text)}
        if image:
            digests[image["id"]] = profile_digest(image)
        config.update(textProfileId=text["id"], imageProfileId=image["id"] if image else None,
                      textProfileFingerprint=public_profile_digest(text),
                      imageProfileFingerprint=public_profile_digest(image) if image else None,
                      _textProviderName=safe_model_label(text.get("display_name"), [text["api_key"]]),
                      _profileDigests=digests)
        return config

    def verified_profile(self, request, image=False):
        frozen = request["frozen"]
        pid = frozen["imageProfileId" if image else "textProfileId"]
        if not pid:
            raise AgentError("configuration_incomplete", "本轮未配置此 API，不能回退到其他供应商。")
        try:
            profile = OpenAICompatibleConfig(library_path=self.library).read(pid)
        except (ValueError, OpenAICompatibleError):
            raise AgentError("profile_changed", "本轮 API 配置已删除，请明确发起新请求。") from None
        if profile_digest(profile) != frozen["_profileDigests"].get(pid):
            raise AgentError("profile_changed", "本轮 API 配置已改变，请明确发起新请求。")
        return profile

    def create_round(self, cid, body: AgentRoundCreate):
        preparation_started = timing.monotonic()
        serialized = body.model_dump(exclude_none=True)
        digest_body = {k: v for k, v in serialized.items() if k != "expectedRevision"}
        # Preserve idempotency for bodies saved before task context existed.
        for field, default in (('contextScope', 'task'), ('historyRoundIds', [])):
            if digest_body.get(field) == default:
                digest_body.pop(field, None)
        if body.imageCount == 1:
            # The compatible default must preserve receipts created before the
            # explicit count field existed; omitted and explicit one are equal.
            digest_body.pop('imageCount', None)
        digest_body["conversationId"] = cid
        digest = fingerprint(digest_body)
        with connect(self.library) as conn:
            old = conn.execute("SELECT * FROM agent_requests WHERE id=?", (body.requestId,)).fetchone()
            if old:
                if old["fingerprint"] != digest:
                    raise AgentError("request_id_conflict", "此 requestId 已用于不同请求。")
                return self.snapshot(cid, body.requestId), False
            conversation = self._conversation(conn, cid)
            rounds = self._rounds(conn, cid)
        frozen = self.resolve_config(body)
        try:
            normalize_image_parameters(body.params.model_dump(exclude_none=True), default_model=frozen["imageModel"] or "native-image-generation")
        except OpenAICompatibleError as exc:
            raise AgentError("invalid_parameters", str(exc), 400) from None
        if not body.prompt.strip():
            raise AgentError("invalid_reference", "请输入消息。", 400)
        if body.parentRoundId and not any(r["id"] == body.parentRoundId for r in rounds):
            raise AgentError("not_found", "父轮次不存在。", 404)
        if body.origin != "send":
            original = next((r for r in rounds if r["id"] == body.derivedFromRoundId), None)
            if not original or original["parentRoundId"] != body.parentRoundId:
                raise AgentError("invalid_reference", "编辑或重新生成的源分支不匹配。", 400)
            if body.origin == "regenerate" and original["prompt"] != body.prompt:
                raise AgentError("invalid_reference", "更改提示词请使用编辑分支。", 400)
        reuse_inputs = False
        if body.derivedFromRoundId:
            original = next((r for r in rounds if r["id"] == body.derivedFromRoundId), None)
            if original:
                original_request = self.request(original["requestId"])
                reuse_inputs = original_request["body"].get("refs", []) == serialized["refs"]
        history = self.path(rounds, body.parentRoundId)
        branch_ids = {row['id'] for row in history}
        if len(set(body.historyRoundIds)) != len(body.historyRoundIds) or any(rid not in branch_ids for rid in body.historyRoundIds):
            raise AgentError('invalid_context_scope', '所选历史轮次必须属于当前分支。', 400)
        if body.contextScope != 'selected' and body.historyRoundIds:
            raise AgentError('invalid_context_scope', '只有指定历史范围时才能选择历史轮次。', 400)
        legacy_outputs = self._legacy_frozen_assets(history)
        ancestral_outputs = None

        def resolve_frozen(ref):
            nonlocal ancestral_outputs
            ref = ref.model_dump(exclude_none=True) if hasattr(ref, "model_dump") else ref
            source_key = encoded(ref)
            try:
                return self.resolve_ref(ref, legacy_asset_id=legacy_outputs.get(source_key))
            except AgentError as exc:
                if exc.code != "reference_missing" or ref.get("kind") != "job" or not history:
                    raise
                if ancestral_outputs is None:
                    with connect(self.library) as conn:
                        possible = conn.execute("SELECT 1 FROM agent_assets WHERE source=? AND kind='reference' LIMIT 1", (source_key,)).fetchone()
                    if not possible:
                        raise
                    ancestral_outputs = self._legacy_ancestor_outputs(cid, history)
                candidate = ancestral_outputs.get(source_key)
                if not candidate:
                    raise
                return self.resolve_ref(ref, legacy_asset_id=candidate)

        inputs = list(original["inputImageIds"]) if reuse_inputs else [
            resolve_frozen(ref) for ref in body.refs]
        for aid in inputs:
            asset = self.asset(aid)
            resolve_generation_input_image_path(self.library, asset["path"])
        if any(int(match[1]) < 1 or int(match[1]) > len(inputs) for match in re.finditer(r"@图(\d+)", body.prompt)):
            raise AgentError("reference_missing", "引用的当前图片不存在。", 400)
        mask_id = None
        if body.mask:
            if frozen["apiConfigMode"] == "hybrid":
                raise AgentError("capability_unsupported", "当前混合图片接口尚不支持遮罩。", 400)
            if body.mask.targetRefIndex >= len(inputs):
                raise AgentError("invalid_reference", "遮罩目标不存在。", 400)
            mask_id = self.resolve_ref({"kind": "upload", "uploadId": body.mask.uploadId})
            target, mask = self.asset(inputs[body.mask.targetRefIndex]), self.asset(mask_id)
            if (target["width"], target["height"]) != (mask["width"], mask["height"]):
                raise AgentError("invalid_reference", "遮罩和目标图片尺寸必须一致。", 400)
            with Image.open(self.library / mask["path"]) as mask_image:
                if "A" not in mask_image.getbands() and "transparency" not in mask_image.info:
                    raise AgentError("invalid_reference", "遮罩必须包含透明通道。", 400)
        for historical in history:
            historical["frozenOutputImages"] = []
            for jid in editing.all_output_ids(historical):
                try:
                    ref = {"kind": "job", "jobId": jid}
                    historical["frozenOutputImages"].append(resolve_frozen(ref))
                except AgentError as exc:
                    if exc.code != "reference_missing":
                        raise
                    historical["frozenOutputImages"].append(None)
        for match in ROUND_MENTION.finditer(body.prompt):
            index, slot = int(match[1]) - 1, int(match[2]) - 1
            if index < 0 or index >= len(history) or slot < 0 or slot >= len(history[index]["frozenOutputImages"]) or not history[index]["frozenOutputImages"][slot]:
                raise AgentError("reference_missing", "引用的历史图片不在当前分支或已删除。", 400)
        inherited_task = editing.current_task(conversation, rounds, body.parentRoundId)
        inherited_context = task_state.current(conversation, rounds, body.parentRoundId)
        if body.origin != 'send' and body.derivedFromRoundId:
            inherited_task = editing.current_task(conversation, rounds, body.derivedFromRoundId)
            inherited_context = task_state.current(conversation, rounds, body.derivedFromRoundId)
        self._check_task_revision(inherited_context, body.taskRevision)
        pending_selection = bool(inherited_context and inherited_context.get('pendingUserTask') and inherited_task)
        if pending_selection or inherited_context and inherited_context.get('targetExplicit') and inputs and not editing.task_boundary(body.prompt):
            task = inherited_task
        else:
            task = editing.infer_task(self, inherited_task, conversation_id=cid, parent_id=body.parentRoundId,
                                      prompt=body.prompt, inputs=inputs, history=history, config=frozen)
        historical_assets = {aid for row in history for aid in [*editing.all_input_ids(row), *row.get('frozenOutputImages', [])] if aid}
        task_inputs = [aid for aid in editing.required_asset_ids(task) if aid not in inputs and aid not in historical_assets]
        for aid in task_inputs:
            # Freeze the stable identity into this request. Missing originals
            # never silently redirect to a different Gallery/Library picture.
            asset = self.asset(aid)
            resolve_generation_input_image_path(self.library, asset['path'])
        if len(set(inputs) | set(editing.required_asset_ids(task))) > 4:
            raise AgentError('invalid_reference', '当前编辑对象与参考图片合计最多 4 张；请调整当前任务。', 400)
        now, rid = milliseconds(), "round_" + uuid4().hex
        if task:
            task['branchRoundId'] = rid
        requirements_history = []
        if task and task.get('requirementsInHistory'):
            requirements_history = [row['id'] for row in history if (row.get('editingTask') or {}).get('requirementsInHistory')
                                    or (row.get('editingTask') or {}).get('target') == task.get('target')]
        context = task_state.advance(inherited_context, task, prompt=body.prompt, branch_id=rid,
                                     boundary=editing.task_boundary(body.prompt), requirements_history=requirements_history)
        if task:
            task['taskId'] = context['taskId']
        if (not inherited_context and history and not editing.task_boundary(body.prompt)
                and not (inputs and task and not task.get('continuesTask'))):
            for historical in history:
                task_state.dependency(context, historical['id'], 'legacy_context_missing')
            task_state.refresh(context)
        if body.contextScope == 'selected':
            # A user-selected history scope supersedes implicit carryover of
            # ordinary chat additions. Proven overflow/legacy evidence remains
            # required; compact context must never pretend it was reconciled.
            selected_rounds = set(body.historyRoundIds)
            context['historyDependencies'] = [item for item in context['historyDependencies']
                if item['reason'] != 'unreconciled_user_addition' or item['roundId'] in selected_rounds]
            task_state.refresh(context)
        if inherited_context and inherited_context.get('targetExplicit') and inputs and task and task.get('target'):
            if any(aid not in editing.required_asset_ids(task) for aid in inputs):
                context['unresolvedItems'] = [*context['unresolvedItems'], '新增附件尚未指定角色；当前明确选择的编辑对象保持不变。']
                task_state.refresh(context)
        round_data = {"id": rid, "index": len(history) + 1, "parentRoundId": body.parentRoundId,
                      "userMessageId": "user_" + uuid4().hex, "assistantMessageId": "assistant_" + uuid4().hex,
                      "prompt": body.prompt, "inputImageIds": inputs, "maskTargetImageId": inputs[body.mask.targetRefIndex] if body.mask else None,
                      "maskImageId": mask_id, "outputTaskIds": [], "responseOutput": [], "status": "running", "error": None,
                      "createdAt": now, "finishedAt": None, "requestId": body.requestId, "derivedFromRoundId": body.derivedFromRoundId,
                      "assistantContent": "", "execution": timing.empty_execution(timing.elapsed(preparation_started)),
                      "editingTask": task, "taskImageIds": task_inputs, "imageCount": body.imageCount,
                      "taskContext": context, "contextScope": body.contextScope, "historyRoundIds": body.historyRoundIds}
        with connect(self.library) as conn:
            conn.execute("BEGIN IMMEDIATE")
            replay = conn.execute("SELECT fingerprint FROM agent_requests WHERE id=?", (body.requestId,)).fetchone()
            if replay:
                if replay[0] != digest:
                    raise AgentError("request_id_conflict", "此 requestId 已用于不同请求。")
            else:
                current = self._conversation(conn, cid)
                if current["revision"] != body.expectedRevision:
                    raise AgentError("revision_conflict", "对话已改变，请重新加载。")
                current_context = task_state.current(current, self._rounds(conn, cid), body.derivedFromRoundId
                                                     if body.origin != 'send' and body.derivedFromRoundId else body.parentRoundId)
                self._check_task_revision(current_context, body.taskRevision)
                if conn.execute("SELECT 1 FROM agent_requests WHERE conversation_id=? AND state IN ('queued','running','waiting_for_jobs','stop_requested')", (cid,)).fetchone():
                    raise AgentError("request_active", "当前对话已有进行中的请求。")
                conn.execute("INSERT INTO agent_rounds(id,conversation_id,parent_round_id,request_id,data) VALUES(?,?,?,?,?)", (rid, cid, body.parentRoundId, body.requestId, encoded(round_data)))
                conn.execute("INSERT INTO agent_requests(id,conversation_id,round_id,fingerprint,body,frozen,history,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'queued',?,?)",
                             (body.requestId, cid, rid, digest, encoded(serialized), encoded(frozen), encoded(history), now, now))
                conn.execute("UPDATE agent_conversations SET active_round_id=? WHERE id=?", (rid, cid))
                self._touch(conn, cid)
        return self.snapshot(cid, body.requestId), not bool(replay)

    def request(self, request_id):
        with connect(self.library) as conn:
            row = conn.execute("SELECT * FROM agent_requests WHERE id=?", (request_id,)).fetchone()
            if not row:
                raise AgentError("not_found", "请求不存在。", 404)
            value = dict(row)
            for key in ("body", "frozen", "history", "usage", "error"):
                value[key] = json.loads(value[key]) if value[key] else None
            value["round"] = json.loads(conn.execute("SELECT data FROM agent_rounds WHERE id=?", (row["round_id"],)).fetchone()[0])
            value["steps"] = [dict(r) for r in conn.execute("SELECT * FROM agent_steps WHERE request_id=? ORDER BY step", (request_id,))]
        return value

    def create_prompt_execution(self, cid, body):
        from backend.services.agent_recipe_execution import create_execution
        return create_execution(self, cid, body)

    def prompt_execution_receipt(self, request_id, cid):
        request = self.request(request_id)
        if request['conversation_id'] != cid or request['round'].get('kind') != 'prompt_execution':
            raise AgentError('not_found', '提示词执行回执不存在。', 404)
        return self.snapshot(cid, request_id)

    def select_request_references(self, request_id, arguments, refs):
        request = self.request(request_id)
        task = editing.select_references(self, request, arguments, refs)
        with connect(self.library) as conn:
            conn.execute('BEGIN IMMEDIATE')
            stored = conn.execute('SELECT * FROM agent_requests WHERE id=?', (request_id,)).fetchone()
            if stored['stop_requested'] or stored['state'] not in ACTIVE_STATES:
                raise AgentError('stopped', '本轮已结束，不能继续修改图片选择。')
            conversation = self._conversation(conn, stored['conversation_id'])
            if conversation['active_round_id'] != stored['round_id']:
                raise AgentError('task_branch_conflict', '当前分支已改变，迟到的选择不会覆盖新分支。')
            current = json.loads(conn.execute('SELECT data FROM agent_rounds WHERE id=? AND deleted=0',
                                             (stored['round_id'],)).fetchone()[0])
            old_context = request['round'].get('taskContext')
            self._check_task_revision(current.get('taskContext'), (old_context or {}).get('revision'))
            if current.get('editingTask') != request['round'].get('editingTask'):
                raise AgentError('task_revision_conflict', '当前图片选择已改变，迟到的选择不会覆盖。')
            current['editingTask'] = task
            if current.get('taskContext'):
                context = current['taskContext']
                context['target'] = task.get('target') if task else None
                context['auxiliaries'] = task.get('auxiliaries', []) if task else []
                context['taskType'] = 'image_edit' if task else 'chat'
                context['revision'] += 1
                context['unresolvedItems'] = [item for item in context['unresolvedItems'] if item != '请选择本次编辑对象。']
                task_state.refresh(context)
            self._save_round(conn, current)
            self._touch(conn, stored['conversation_id'])
        return editing.context_data(task, refs)

    def update_task_context(self, request_id, arguments, refs):
        """Apply a normal same-response state tool under task and branch CAS."""
        from backend.agent_schemas import AgentTaskOperation
        from pydantic import ValidationError
        if not isinstance(arguments, dict) or set(arguments) != {'taskId', 'taskRevision', 'branchRoundId', 'operations'}:
            raise AgentError('invalid_task_context', '任务状态工具参数无效。', 400)
        request = self.request(request_id)
        old = request['round'].get('taskContext')
        if (not old or old['taskId'] != arguments['taskId'] or arguments['branchRoundId'] != request['round_id']
                or type(arguments['taskRevision']) is not int):
            raise AgentError('task_revision_conflict', '任务标识或分支已改变。')
        self._check_task_revision(old, arguments['taskRevision'])
        try:
            if not isinstance(arguments['operations'], list) or not 1 <= len(arguments['operations']) <= 24:
                raise ValueError()
            # String refs are frozen conversational labels. Convert them only
            # after validating the exact label against the supplied branch map.
            operations = []
            for item in arguments['operations']:
                operation = dict(item)
                def source_ref(ref):
                    if not isinstance(ref, str):
                        return ref
                    if ref not in refs:
                        raise AgentError('reference_missing', '图片不在本轮冻结引用中。', 400)
                    return json.loads(self.asset(refs[ref])['source'])
                if operation.get('ref'):
                    operation['ref'] = source_ref(operation['ref'])
                if operation.get('auxiliaries'):
                    operation['auxiliaries'] = [{**aux, 'ref': source_ref(aux['ref'])} for aux in operation['auxiliaries']]
                operations.append(AgentTaskOperation.model_validate(operation))
        except AgentError:
            raise
        except (ValidationError, ValueError, TypeError, KeyError):
            raise AgentError('invalid_task_context', '任务状态工具操作无效。', 400) from None
        with connect(self.library) as conn:
            conversation = self._conversation(conn, request['conversation_id'])
            rounds = self._rounds(conn, request['conversation_id'])
        prompt_archive = dict(request['round'].get('_taskPromptArchive', {}))
        value = task_state.apply(old, operations, actor='model', branch_id=request['round_id'],
                                 select_asset=self._task_asset_selector(request['conversation_id'], rounds, request['round_id'], old,
                                                                        frozen_refs=refs),
                                 validate_source=self._task_source_validator(rounds, request['round_id']),
                                 user_text=request['round']['prompt'], prompt_archive=prompt_archive)
        with connect(self.library) as conn:
            conn.execute('BEGIN IMMEDIATE')
            stored = conn.execute('SELECT * FROM agent_requests WHERE id=?', (request_id,)).fetchone()
            conversation = self._conversation(conn, stored['conversation_id'])
            if stored['stop_requested'] or stored['state'] not in ACTIVE_STATES:
                raise AgentError('stopped', '本轮已结束，不能继续修改任务状态。')
            if conversation['active_round_id'] != request['round_id']:
                raise AgentError('task_branch_conflict', '当前分支已改变，迟到的状态不会覆盖新分支。')
            current_row = conn.execute('SELECT data FROM agent_rounds WHERE id=? AND deleted=0', (stored['round_id'],)).fetchone()
            if not current_row:
                raise AgentError('not_found', '当前轮次不存在。', 404)
            current = json.loads(current_row[0])
            self._check_task_revision(current.get('taskContext'), arguments['taskRevision'])
            if (current.get('taskContext') or {}).get('taskId') != arguments['taskId']:
                raise AgentError('task_revision_conflict', '当前任务已改变。')
            current['taskContext'] = value
            if prompt_archive:
                current['_taskPromptArchive'] = prompt_archive
            current['editingTask'] = task_state.project_editing(value, current.get('editingTask'))
            self._save_round(conn, current)
            self._touch(conn, stored['conversation_id'])
        return value

    def record_task_execution(self, request_id, prompt):
        """Receipt only: this neither generates pixels nor confirms a draft."""
        with connect(self.library) as conn:
            conn.execute('BEGIN IMMEDIATE')
            request = conn.execute('SELECT * FROM agent_requests WHERE id=?', (request_id,)).fetchone()
            current = json.loads(conn.execute('SELECT data FROM agent_rounds WHERE id=?', (request['round_id'],)).fetchone()[0])
            if not current.get('taskContext'):
                return None
            prompt_archive = dict(current.get('_taskPromptArchive', {}))
            updated = task_state.record_execution(current['taskContext'], prompt, round_id=request['round_id'],
                                                  prompt_archive=prompt_archive)
            if updated == current['taskContext']:
                return updated
            current['taskContext'] = updated
            if prompt_archive:
                current['_taskPromptArchive'] = prompt_archive
            self._save_round(conn, current)
            self._touch(conn, request['conversation_id'])
            return current['taskContext']

    def update(self, request_id, *, state=None, output=None, text=None, response_id=None, error=None, outcome=None, returned_model=None):
        with connect(self.library) as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute("SELECT * FROM agent_requests WHERE id=?", (request_id,)).fetchone()
            if row["stop_requested"] and state not in {None, "stopped"}:
                state = "stopped"
            round_data = json.loads(conn.execute("SELECT data FROM agent_rounds WHERE id=?", (row["round_id"],)).fetchone()[0])
            if returned_model is not None:
                info = model_info(json.loads(row["frozen"]), round_data)
                label = safe_model_label(returned_model)
                if label and label not in info["returnedModels"]:
                    info["returnedModels"] = (info["returnedModels"] + [label])[:50]
                round_data["modelInfo"] = info
            if output is not None:
                round_data["responseOutput"] = output
            if text is not None:
                round_data["assistantContent"] = text
            if response_id:
                round_data["responseId"] = response_id
            if state:
                round_data["status"] = "running" if state in ACTIVE_STATES else "done" if state == "completed" else "error"
                round_data["finishedAt"] = None if state in ACTIVE_STATES else milliseconds()
                if round_data.get('execution') and state not in ACTIVE_STATES:
                    round_data['execution']['phase'] = state if state in {'completed', 'stopped', 'unknown'} else 'failed'
                    for measured in round_data['execution']['modelSteps']:
                        if measured['state'] == 'running':
                            measured['state'] = 'interrupted'
            if error:
                round_data["error"] = error["message"]
            self._save_round(conn, round_data)
            conn.execute("UPDATE agent_requests SET state=?,error=?,upstream_outcome=? WHERE id=?",
                         (state or row["state"], encoded(error) if error else row["error"], outcome or row["upstream_outcome"], request_id))
            self._touch(conn, row["conversation_id"])

    def record_context_diagnostics(self, request_id, summary):
        """Latest bounded composition receipt, part of the existing round backup."""
        with connect(self.library) as conn:
            conn.execute('BEGIN IMMEDIATE')
            row = conn.execute('SELECT round_id,conversation_id FROM agent_requests WHERE id=?', (request_id,)).fetchone()
            data = json.loads(conn.execute('SELECT data FROM agent_rounds WHERE id=?', (row['round_id'],)).fetchone()[0])
            data['contextDiagnostics'] = summary
            self._save_round(conn, data)
            self._touch(conn, row['conversation_id'])

    def record_execution(self, request_id, *, phase=None, step=None, state=None, add=False, **durations):
        """Finite phase boundaries only; never called for each text delta."""
        from backend.services.agent_diagnostics import record_measurement
        return record_measurement(self._record_execution, request_id, phase=phase, step=step, state=state, add=add, **durations)

    def _record_execution(self, request_id, *, phase=None, step=None, state=None, add=False, **durations):
        with connect(self.library) as conn:
            conn.execute('BEGIN IMMEDIATE')
            request = conn.execute('SELECT conversation_id,round_id,state FROM agent_requests WHERE id=?', (request_id,)).fetchone()
            if not request:
                raise AgentError('not_found', '请求不存在。', 404)
            data = json.loads(conn.execute('SELECT data FROM agent_rounds WHERE id=?', (request['round_id'],)).fetchone()[0])
            measured = data.setdefault('execution', timing.empty_execution())
            timing.apply_measurement(measured, phase=phase if request['state'] in ACTIVE_STATES else None,
                                     step=step, state=state, add=add, **durations)
            self._save_round(conn, data)
            self._touch(conn, request['conversation_id'])

    def record_response_details(self, request_id, step, payload=None, *, native_job_id=None, secrets=()):
        """Upsert one physical Responses call; duplicate SSE receipts cannot add usage."""
        identity = "image:" + native_job_id if native_job_id else f"model:{step}"
        payload = payload if isinstance(payload, dict) else {}
        with connect(self.library) as conn:
            conn.execute("BEGIN IMMEDIATE")
            request = conn.execute("SELECT conversation_id,round_id,usage FROM agent_requests WHERE id=?", (request_id,)).fetchone()
            round_data = json.loads(conn.execute("SELECT data FROM agent_rounds WHERE id=?", (request["round_id"],)).fetchone()[0])
            details = round_data.setdefault("responseDetails", {"version": 1, "steps": [], "skills": []})
            # A safe resume after an application update may have earlier steps
            # without receipts. Keep their usage unknown rather than claiming
            # that the newly instrumented calls cover the complete round.
            started = json.loads(request["usage"])["responseStepsStarted"]
            known = {item["id"] for item in details["steps"]}
            for index in range(1, started + 1):
                if f"model:{index}" not in known:
                    details["steps"].append({"id": f"model:{index}", "step": index, "kind": "model",
                                             "responseId": None, "model": None, "usage": response_usage({}), "summaries": []})
            previous = next((item for item in details["steps"] if item["id"] == identity), None)
            if previous is None:
                previous = {"id": identity, "step": step, "kind": "native_image" if native_job_id else "model",
                            "responseId": None, "model": None, "usage": response_usage({}), "summaries": []}
                details["steps"].append(previous)
            for key, value in response_usage(payload).items():
                if value is not None:
                    previous["usage"][key] = value
            for key in ("model", "responseId"):
                value = safe_model_label(payload.get("id" if key == "responseId" else key), secrets)
                if value:
                    previous[key] = value
            summaries = public_reasoning_summaries(payload, secrets)
            if summaries:
                previous["summaries"] = summaries
            details["usage"] = aggregate_response_usage(details["steps"])
            self._save_round(conn, round_data)
            self._touch(conn, request["conversation_id"])

    def record_skill_read(self, request_id, result, *, preloaded=False):
        # Only bundled attribution is public; preloads keep an authenticated,
        # finite application-guidance receipt separate from real tool history.
        fields = ("skill", "section", "title", "source", "revision", "license")
        value = {key: safe_model_label(result.get(key)) for key in fields}
        if not all(value.values()):
            return
        with connect(self.library) as conn:
            conn.execute("BEGIN IMMEDIATE")
            request = conn.execute("SELECT conversation_id,round_id FROM agent_requests WHERE id=?", (request_id,)).fetchone()
            round_data = json.loads(conn.execute("SELECT data FROM agent_rounds WHERE id=?", (request["round_id"],)).fetchone()[0])
            details = round_data.setdefault("responseDetails", {"version": 1, "steps": [], "skills": []})
            if value not in details["skills"]:
                details["skills"].append(value)
            if preloaded:
                from backend.services.agent_skills import validated_skill_preloads
                receipt = validated_skill_preloads([{'skillPreloads': [result]}])
                if receipt:
                    records = round_data.setdefault('skillPreloads', [])
                    if receipt[0] not in records:
                        records.append(receipt[0])
            details["usage"] = aggregate_response_usage(details["steps"])
            self._save_round(conn, round_data)
            self._touch(conn, request["conversation_id"])

    def snapshot(self, cid=None, request_id=None):
        request = self.request(request_id) if request_id else None
        cid = cid or request["conversation_id"]
        with connect(self.library) as conn:
            conversation = self._conversation(conn, cid)
            rounds = self._rounds(conn, cid)
            # Read historical identities from their own request, never today's
            # profile. Older requests do not claim a provider name was recorded.
            historical_requests = {row['id']: {**dict(row), 'body': json.loads(row['body']), 'error': json.loads(row['error']) if row['error'] else None}
                                   for row in conn.execute('SELECT id,state,upstream_outcome,body,error,frozen FROM agent_requests WHERE conversation_id=?', (cid,))}
            completed_text = {row[0] for row in conn.execute("SELECT DISTINCT s.request_id FROM agent_steps s JOIN agent_requests r ON r.id=s.request_id WHERE r.conversation_id=? AND s.state='completed'", (cid,))}
            frozen_configs = {rid: json.loads(row['frozen']) for rid, row in historical_requests.items()}
            task = editing.current_task(conversation, rounds, conversation['active_round_id'])
            for round_data in rounds:
                round_data["modelInfo"] = model_info(frozen_configs.get(round_data["requestId"], {}), round_data)
            if request is None and rounds:
                current = next((r for r in rounds if r["id"] == conversation["active_round_id"]), rounds[-1])
                request = self.request(current["requestId"])
        return self._public_snapshot(conversation, rounds, request, historical_requests, completed_text, task)

    def _public_snapshot(self, conversation, rounds, request, historical_requests, completed_text, task):
        """Shared public projection for complete history and one observed round."""
        cid = conversation['id']
        context = task_state.current(conversation, rounds, conversation['active_round_id'])
        jobs, assets, messages = {}, {}, []
        for r in rounds:
            r.pop('_taskPromptArchive', None)  # Exact old drafts remain restorable without bloating public context.
            for aid in editing.all_input_ids(r) + ([r["maskImageId"]] if r["maskImageId"] else []):
                assets[aid] = self.image(aid)
            for jid in editing.all_output_ids(r):
                try:
                    jobs[jid] = self.jobs.get_job(jid).model_dump()
                    preview = (jobs[jid].get("metadata") or {}).get("agent", {}).get("partialImageId")
                    if preview:
                        assets[preview] = self.image(preview)
                except KeyError:
                    pass
                assets["output_" + jid] = self.image("output_" + jid)
            own_request = historical_requests.get(r['requestId'])
            r['resultSummary'] = timing.result_summary(r, own_request, jobs, r['requestId'] in completed_text)
            r['execution'] = r.get('execution')
            r.pop('skillPreloads', None)  # Public details expose attribution, not repeated guidance bodies.
            from backend.services.agent_diagnostics import classify_failure
            failures = [classify_failure((jobs[jid].get('metadata') or {}).get('error_diagnostics'))
                        for jid in r['outputTaskIds'] if jid in jobs and jobs[jid]['status'] == 'failed']
            own_error = own_request.get('error') if own_request else None
            r['failure'] = next((failure for failure in failures if failure['kind'] != 'unknown'), None) or (
                classify_failure(own_error.get('diagnostics'), code=own_error.get('code')) if own_error else failures[0] if failures else None)
            messages.extend([
                {"id": r["userMessageId"], "role": "user", "content": r["prompt"], "roundId": r["id"], "createdAt": r["createdAt"],
                 "inputImageIds": r["inputImageIds"], "maskImageId": r["maskImageId"], "maskTargetImageId": r["maskTargetImageId"]},
                {"id": r["assistantMessageId"], "role": "assistant", "content": r.pop("assistantContent", ""), "roundId": r["id"],
                 "createdAt": r["createdAt"], "outputTaskIds": r["outputTaskIds"]},
            ])
        request_view = None
        if request:
            with connect(self.library) as conn:
                links = conn.execute("SELECT * FROM agent_tool_jobs WHERE request_id=? ORDER BY step,rowid", (request["id"],)).fetchall()
            calls = {}
            for link in links:
                key = (link["step"], link["call_id"])
                call = calls.setdefault(key, {"id": f"{request['id']}:{link['step']}:{link['call_id']}", "step": link["step"],
                                             "callId": link["call_id"], "name": link["name"], "state": "completed", "itemIds": [], "jobIds": [], "error": None})
                call["itemIds"].append(link["item_id"])
                call["jobIds"].append(link["job_id"])
                job = jobs.get(link["job_id"])
                if job and job["status"] in {"queued", "running"}:
                    call["state"] = "running"
                elif not job or job["status"] in {"failed", "cancelled", "discarded"}:
                    call["state"], call["error"] = "failed", job.get("error") if job else "图片已删除"
            request_view = {"id": request["id"], "conversationId": request["conversation_id"], "roundId": request["round_id"],
                            "state": request["state"], "frozenConfig": {k: v for k, v in request["frozen"].items() if not k.startswith("_")},
                            "modelInfo": model_info(request["frozen"], request["round"]),
                            "params": request["body"]["params"], "imageCount": request["body"].get('imageCount', 1),
                            "authorization": request["body"]["authorization"], "usage": request["usage"], "toolCalls": list(calls.values()),
                            "canResume": request["state"] == "interrupted" and request["upstream_outcome"] != "unknown" and not request["stop_requested"],
                            "recoveryReason": request["error"]["message"] if request["error"] else None,
                            "upstreamOutcome": request["upstream_outcome"], "stopRequested": bool(request["stop_requested"]),
                            "upstreamMayContinue": bool(request["stop_requested"] and request["upstream_outcome"] == "unknown"), "error": request["error"]}
        from backend.routers.generation_jobs import _sanitize_generation_job_record
        from backend.schemas import GenerationJobRecord
        for aid in editing.required_asset_ids(task):
            assets[aid] = self.image(aid)
        for aid in editing.required_asset_ids(context):
            assets[aid] = self.image(aid)
        return {"schemaVersion": 1, "revision": conversation["revision"],
                "conversation": {"id": cid, "title": conversation["title"], "activeRoundId": conversation["active_round_id"],
                                 "createdAt": conversation["created_at"], "updatedAt": conversation["updated_at"], "rounds": rounds, "messages": messages},
                "request": request_view, "editingTask": task, "taskContext": context,
                "contextMode": 'task' if context else 'legacy',
                "jobs": [_sanitize_generation_job_record(GenerationJobRecord(**j)).model_dump() for j in jobs.values()], "images": list(assets.values())}

    def progress_view(self, request_id):
        """Read only the observed round; never parse its frozen full history.

        Caller captures the progress token first so a concurrent write while
        resolving current jobs/images is observed again on the next poll.
        """
        from backend.services.agent_progress import limited_view
        with connect(self.library) as conn:
            conn.execute('BEGIN')
            row = conn.execute('''SELECT id,conversation_id,round_id,body,frozen,state,usage,error,
                stop_requested,upstream_outcome FROM agent_requests WHERE id=?''', (request_id,)).fetchone()
            if row is None:
                raise AgentError('not_found', '请求不存在。', 404)
            request = dict(row)
            for key in ('body', 'frozen', 'usage', 'error'):
                request[key] = json.loads(request[key]) if request[key] else None
            conversation = self._conversation(conn, request['conversation_id'])
            if conversation['active_round_id'] != request['round_id']:
                raise AgentError('progress_branch_changed', '当前分支已改变，请重新读取状态。')
            stored = conn.execute('SELECT data FROM agent_rounds WHERE id=? AND deleted=0', (request['round_id'],)).fetchone()
            if stored is None:
                raise AgentError('not_found', '请求不存在。', 404)
            round_data = json.loads(stored['data'])
            round_data['retryTaskIds'] = [row['id'] for row in conn.execute('''SELECT id FROM generation_jobs
                WHERE json_extract(metadata,'$.agentRetry.conversationId')=?
                AND json_extract(metadata,'$.agentRetry.roundId')=? ORDER BY created_at,id''',
                (request['conversation_id'], request['round_id']))]
            round_data['modelInfo'] = model_info(request['frozen'], round_data)
            request['round'] = round_data
            completed_text = {request_id} if conn.execute("SELECT 1 FROM agent_steps WHERE request_id=? AND state='completed' LIMIT 1",
                                                         (request_id,)).fetchone() else set()
            task = editing.current_task(conversation, [round_data], request['round_id'])
        return limited_view(self._public_snapshot(conversation, [round_data], request, {request_id: request}, completed_text, task))

    def progress_structure(self, request_id):
        """Small structural marker, excluding text and current-round progress.

        Old-round request/job changes require a complete resync. SQL reads only
        identities/status markers, never historical prompts, frozen inputs or
        image files. Ordinary current-request tokens keep this marker stable.
        """
        with connect(self.library) as conn:
            row = conn.execute('''SELECT c.id,c.title,c.active_round_id,c.editing_tasks,r.round_id
                FROM agent_requests r JOIN agent_conversations c ON c.id=r.conversation_id
                WHERE r.id=? AND c.deleted=0''', (request_id,)).fetchone()
            if row is None:
                raise AgentError('not_found', '请求不存在。', 404)
            structure = [tuple(row), [tuple(value) for value in conn.execute('''SELECT a.id,a.parent_round_id,a.deleted,
                CASE WHEN r.id!=? THEN r.updated_at ELSE NULL END
                FROM agent_rounds a JOIN agent_requests r ON r.id=a.request_id
                WHERE a.conversation_id=? ORDER BY a.rowid''', (request_id, row['id']))]]
            structure.append([tuple(value) for value in conn.execute('''SELECT j.id,j.status,j.updated_at,j.result_path,j.accepted_image_id
                FROM agent_tool_jobs t JOIN agent_requests r ON r.id=t.request_id JOIN generation_jobs j ON j.id=t.job_id
                WHERE r.conversation_id=? AND r.id!=? ORDER BY j.id''', (row['id'], request_id))])
            structure.append([tuple(value) for value in conn.execute('''SELECT id,status,updated_at,result_path,accepted_image_id
                FROM generation_jobs WHERE json_extract(metadata,'$.agentRetry.conversationId')=?
                AND json_extract(metadata,'$.agentRetry.roundId')!=? ORDER BY id''', (row['id'], row['round_id']))])
        return fingerprint(structure)

    def progress_token(self, request_id):
        """Read a small change marker without assembling images or full history."""
        with connect(self.library) as conn:
            row = conn.execute("""SELECT c.revision,r.state,r.updated_at,a.deleted
                FROM agent_requests r JOIN agent_conversations c ON c.id=r.conversation_id
                JOIN agent_rounds a ON a.id=r.round_id
                WHERE r.id=? AND c.deleted=0""", (request_id,)).fetchone()
            if row is None or row["deleted"]:
                raise AgentError("not_found", "请求不存在。", 404)
            jobs = conn.execute("""SELECT j.id,j.status,j.updated_at,j.result_path,j.accepted_image_id,j.error,j.metadata
                FROM generation_jobs j WHERE j.id IN (SELECT job_id FROM agent_tool_jobs WHERE request_id=?)
                OR (json_extract(j.metadata,'$.agentRetry.conversationId')=(SELECT conversation_id FROM agent_requests WHERE id=?)
                    AND json_extract(j.metadata,'$.agentRetry.roundId')=(SELECT round_id FROM agent_requests WHERE id=?))
                ORDER BY j.id""", (request_id, request_id, request_id)).fetchall()
            return tuple(row), tuple(tuple(job) for job in jobs)

    def stop(self, request_id):
        request = self.request(request_id)
        if request["state"] not in ACTIVE_STATES:
            return self.snapshot(request_id=request_id)
        with connect(self.library) as conn:
            conn.execute("UPDATE agent_requests SET stop_requested=1 WHERE id=?", (request_id,))
        for jid in request["round"]["outputTaskIds"]:
            try:
                if self.jobs.get_job(jid).status in {"queued", "running"}:
                    self.jobs.cancel_job(jid)
            except (ValueError, KeyError):
                pass
        self.update(request_id, state="stopped", error={"code": "stopped", "message": "已停止生成。"})
        return self.snapshot(request_id=request_id)

    def resume(self, request_id, resume_id):
        with connect(self.library) as conn:
            conn.execute("BEGIN IMMEDIATE")
            old = conn.execute("SELECT request_id FROM agent_resumes WHERE id=?", (resume_id,)).fetchone()
            if old:
                if old[0] != request_id:
                    raise AgentError("request_id_conflict", "此恢复标识已用于其他请求。")
                return False
            row = conn.execute("SELECT * FROM agent_requests WHERE id=?", (request_id,)).fetchone()
            if not row or row["state"] != "interrupted" or row["upstream_outcome"] == "unknown" or row["stop_requested"]:
                raise AgentError("resume_not_safe", "无法安全恢复；原请求不会自动重发。")
            self._conversation(conn, row["conversation_id"])
            if not conn.execute("SELECT 1 FROM agent_rounds WHERE id=? AND deleted=0", (row["round_id"],)).fetchone():
                raise AgentError("resume_not_safe", "原轮次已删除，不能恢复请求。")
            if conn.execute("SELECT 1 FROM agent_requests WHERE conversation_id=? AND id!=? AND state IN ('queued','running','waiting_for_jobs','stop_requested')", (row["conversation_id"], request_id)).fetchone():
                raise AgentError("request_active", "当前对话已有进行中的请求。")
            conn.execute("INSERT INTO agent_resumes VALUES(?,?)", (resume_id, request_id))
            conn.execute("UPDATE agent_requests SET state='queued',error=NULL WHERE id=?", (request_id,))
            round_data = json.loads(conn.execute("SELECT data FROM agent_rounds WHERE id=?", (row["round_id"],)).fetchone()[0])
            round_data.update(status="running", error=None, finishedAt=None)
            self._save_round(conn, round_data)
            self._touch(conn, row["conversation_id"])
        return True
