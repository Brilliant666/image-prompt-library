"""Small allowlisted diagnostics; provider prose is never a UI contract."""
from __future__ import annotations

import hashlib
import logging
import math
import re
import sqlite3
from urllib.parse import urlsplit


def record_measurement(write, *args, **kwargs):
    """Keep optional timing storage separate from paid-request receipts.

    Storage failures are reported without private exception text. A missing
    measurement remains unknown; it must not undo a durable business result.
    Programming/validation errors still propagate.
    """
    try:
        write(*args, **kwargs)
    except (sqlite3.Error, OSError) as exc:
        logging.getLogger(__name__).warning('Execution timing was not recorded (%s)', type(exc).__name__)
        return False
    return True

_CODES = frozenset({
    'insufficient_quota', 'insufficient_balance', 'billing_hard_limit_reached',
    'model_not_found', 'unsupported_model', 'unsupported_endpoint', 'moderation_blocked',
    'content_policy_violation', 'safety_violation', 'rate_limit_exceeded', 'server_error',
    'invalid_api_key', 'authentication_error', 'permission_error', 'image_generation_user_error',
    'service_error', 'api_error', 'invalid_request_error', 'unrecognized',
})
_CATEGORIES = frozenset({
    'authentication', 'permission_or_group', 'route_or_model', 'rate_limit', 'upstream_error',
    'api_error', 'local_validation', 'internal_error', 'connect_timeout', 'read_timeout',
    'connection_error', 'incomplete_stream', 'invalid_stream', 'non_json_response',
    'invalid_json_response', 'missing_image', 'image_too_large', 'base64_decode', 'image_decode',
    'preview_storage', 'image_download_http', 'reference_missing', 'unknown',
})
_MODERATION = frozenset({'sexual', 'sexual/minors', 'violence', 'violence/graphic', 'hate',
    'hate/threatening', 'harassment', 'harassment/threatening', 'self-harm', 'self-harm/intent',
    'self-harm/instructions', 'illicit', 'illicit/violent'})
_MESSAGES = {
    'quota': '生图供应商余额或额度不足，请检查账户或选择可用配置。',
    'model_unsupported': '当前供应商不支持所选模型或接口，请检查生图配置。',
    'moderation': '供应商安全审核拒绝了本次请求；可以自行修改需求，不会自动重试或切换供应商。',
    'rate_limit': '供应商限制了请求频率，请稍后手动重试。',
    'service': '供应商服务暂时异常，请检查任务状态后再决定是否重试。',
    'network': '连接超时或中断，结果尚不确定；请先核对原请求，不要重复提交。',
    'reference_missing': '参考图片缺失或已不可用，请重新选择原图片。',
    'authentication': '供应商认证或权限不满足，请检查配置。',
    'unknown': '本次图片请求未完成，原因未明确，请查看诊断信息。',
}


def duration_ms(value):
    return round(float(value), 3) if type(value) in (int, float) and math.isfinite(value) and 0 <= value <= 86_400_000 else None


def safe_diagnostics(raw):
    if not isinstance(raw, dict):
        return {}
    category = raw.get('category')
    result = {'category': category if isinstance(category, str) and category in _CATEGORIES else 'unknown'}
    status = raw.get('http_status')
    if type(status) is int and 100 <= status <= 599:
        result['http_status'] = status
    for key in ('elapsed_seconds',):
        value = raw.get(key)
        if type(value) in (int, float) and math.isfinite(value) and 0 <= value <= 86400:
            result[key] = round(value, 3)
    identity = raw.get('request_id')
    if isinstance(identity, str) and identity:
        result['request_id'] = identity if re.fullmatch(r'sha256:[0-9a-f]{16}', identity) else 'sha256:' + hashlib.sha256(identity.encode()).hexdigest()[:16]
    retry_after = raw.get('retry_after')
    if isinstance(retry_after, (str, int)) and str(retry_after).isdigit() and len(str(retry_after)) <= 5:
        result['retry_after'] = str(retry_after)
    if raw.get('response_transport') in ('json', 'sse'):
        result['response_transport'] = raw['response_transport']
    endpoint = raw.get('endpoint')
    if isinstance(endpoint, str):
        try:
            path = urlsplit(endpoint).path
            route = next((route for route in ('/images/generations', '/images/edits', '/responses') if path.endswith(route)), None)
            if route:
                result['endpoint'] = route
        except ValueError:
            pass
    error = raw.get('error')
    if isinstance(error, dict):
        safe = {key: error[key] if isinstance(error.get(key), str) and error[key] in _CODES else 'unrecognized'
                for key in ('type', 'code') if key in error}
        if error.get('param') in ('model', 'size', 'quality', 'prompt', 'image', 'background', 'output_format'):
            safe['param'] = error['param']
        moderation = error.get('moderation_details')
        if isinstance(moderation, dict):
            safe['moderation_details'] = {'moderation_stage': moderation.get('moderation_stage') if moderation.get('moderation_stage') in ('input', 'output') else 'unknown'}
            if isinstance(moderation.get('categories'), list):
                safe['moderation_details']['categories'] = sorted({v for v in moderation['categories'] if isinstance(v, str) and v in _MODERATION})
        result['error'] = safe
    return result


def classify_failure(raw=None, *, code=None):
    data = safe_diagnostics(raw)
    error = data.get('error', {})
    codes = {error.get('code'), error.get('type'), code}
    status, category = data.get('http_status'), data.get('category')
    uncertain = category in {'connect_timeout', 'read_timeout', 'connection_error', 'incomplete_stream', 'preview_storage'} or code in {'unknown', 'upstream_unknown', 'upstream_outcome_unknown', 'interrupted'}
    kind = 'unknown'
    if codes & {'reference_missing', 'frozen_reference_invalid', 'reference_unavailable'} or category == 'reference_missing':
        kind = 'reference_missing'
    elif codes & {'moderation_blocked', 'content_policy_violation', 'safety_violation'}:
        kind = 'moderation'
    elif codes & {'insufficient_quota', 'insufficient_balance', 'billing_hard_limit_reached'}:
        kind = 'quota'
    elif codes & {'model_not_found', 'unsupported_model', 'unsupported_endpoint'} or category == 'route_or_model' or status == 404:
        kind = 'model_unsupported'
    elif category == 'rate_limit' or status == 429:
        kind = 'rate_limit'
    elif category in {'authentication', 'permission_or_group'} or status in (401, 403):
        kind = 'authentication'
    elif uncertain:
        kind = 'network'
    elif category == 'upstream_error' or (status is not None and status >= 500):
        kind = 'service'
    return {'kind': kind, 'message': _MESSAGES[kind], 'outcomeUnknown': uncertain}
