"""Public fixed errors carry uncertainty separately from their failure category."""
from __future__ import annotations
from typing import Literal

Outcome = Literal['not_sent', 'known_failure', 'unknown', 'local_result_pending']
CATEGORIES = frozenset({'not_configured', 'capability_unsupported', 'authentication',
    'rate_limit', 'request_error', 'moderation', 'network', 'timeout', 'upstream'})


class ProviderError(RuntimeError):
    def __init__(self, message: str, *, category: str, outcome: Outcome = 'not_sent',
                 diagnostics: dict | None = None):
        if category not in CATEGORIES or outcome not in {'not_sent', 'known_failure', 'unknown', 'local_result_pending'}:
            raise ValueError('Invalid provider failure classification')
        super().__init__(message)
        self.category = category
        self.outcome = outcome
        # Callers must supply already-sanitized diagnostics, never raw responses.
        self.diagnostics = dict(diagnostics or {})


LEGACY_CATEGORY_MAP = {
    'local_validation': 'request_error', 'authentication': 'authentication',
    'permission_or_group': 'authentication', 'route_or_model': 'capability_unsupported',
    'rate_limit': 'rate_limit', 'connect_timeout': 'timeout', 'read_timeout': 'timeout',
    'connection_error': 'network', 'api_error': 'request_error',
    'upstream_error': 'upstream', 'invalid_json_response': 'upstream',
    'incomplete_stream': 'upstream', 'missing_image': 'upstream',
    'image_too_large': 'upstream', 'base64_decode': 'upstream', 'image_decode': 'upstream',
    'invalid_stream': 'upstream', 'moderation': 'moderation',
}
