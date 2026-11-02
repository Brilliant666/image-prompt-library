"""Connection-level discovery without saving drafts or invoking a model.

The legacy store and routes remain compatible with frozen tasks. This façade is
protocol-neutral; credential ownership is checked before any network request.
"""
from datetime import datetime, timezone
from threading import BoundedSemaphore

from backend.services.api_network import update_network_settings, validate_network_settings
from backend.services.model_catalog import ModelCatalogError, connection_fingerprint
from backend.services.openai_compatible import OpenAICompatibleConfig, OpenAICompatibleError
from backend.services.providers.profiles import normalize_profile_url, protocol
from backend.services.providers.registry import catalog_for_profile

ApiConnectionProfiles = OpenAICompatibleConfig
_DISCOVERY_SLOTS = BoundedSemaphore(4)
MAX_DRAFT_BYTES = 32 * 1024
_FIELDS = {'profile_id', 'protocol', 'service_preset', 'service_preset_mode', 'base_url', 'base_url_mode', 'api_key',
           'network_mode', 'proxy_url', 'remove_proxy_url'}
_MESSAGES = {
    'invalid_draft': 'Check the draft address, protocol and network settings.',
    'key_required': 'Enter an API key for this connection.',
    'key_reentry_required': 'Enter the API key again for the changed address or protocol.',
    'profile_missing': 'The saved connection no longer exists. Reload connections.',
    'permission': 'The service denied model-list access.',
    'timeout': 'The model-list request timed out.',
    'connection': 'Could not connect to the model-list endpoint.',
    'http': 'The service did not provide a supported model list.',
    'invalid': 'The service returned an invalid model list.',
    'limit': 'The model list exceeded the supported size limit.',
    'empty': 'The service returned no models. Manual model IDs are still allowed.',
    'network_config': 'Check the connection network mode, proxy and direct route.',
    'changed': 'The saved connection changed during discovery. Check the current draft again.',
    'busy': 'Other model-list checks are running. Try again after they finish.',
}


class ConnectionDraftError(ValueError):
    def __init__(self, code='invalid_draft'):
        self.code = code
        super().__init__(_MESSAGES[code])


def _root(settings):
    return normalize_profile_url(settings['base_url'], settings['base_url_mode'], protocol(settings))


def prepare_discovery_draft(store, payload):
    """Read the bound saved secret only; never modify the store or cache."""
    if not isinstance(payload, dict) or set(payload) - _FIELDS:
        raise ConnectionDraftError()
    profile_id = payload.get('profile_id')
    previous = None
    if profile_id is not None:
        try:
            store._validate_id(profile_id)
            previous = store.read(profile_id)
        except (ValueError, OSError, OpenAICompatibleError):
            raise ConnectionDraftError('profile_missing') from None
    value = store._defaults()
    if previous:
        value.update(previous)
    for key in ('protocol', 'service_preset', 'service_preset_mode', 'base_url', 'base_url_mode'):
        if key in payload:
            if not isinstance(payload[key], str) or len(payload[key]) > 2048:
                raise ConnectionDraftError()
            value[key] = payload[key].strip()
    supplied = payload.get('api_key', '')
    if not isinstance(supplied, str) or len(supplied) > 8192 or any(ord(c) < 32 or ord(c) == 127 for c in supplied):
        raise ConnectionDraftError()
    try:
        selected = protocol(value)
        from backend.services.providers.muse import service_preset
        service_preset(value)
        root = _root(value)
        if not root:
            raise ConnectionDraftError()
        value.update(update_network_settings(value, payload))
        value.update(validate_network_settings(value))
        # Omitted or blank input never rebinds a stored secret to a new target.
        if supplied.strip():
            value['api_key'] = supplied.strip()
        elif previous and previous.get('api_key'):
            if selected != protocol(previous) or root != _root(previous):
                raise ConnectionDraftError('key_reentry_required')
        if not value.get('api_key') and selected != 'seedream_native':
            raise ConnectionDraftError('key_required')
        value['base_url'] = root
        baseline = connection_fingerprint(previous, _root(previous)) if previous else None
        return value, baseline
    except ConnectionDraftError:
        raise
    except (ValueError, TypeError, KeyError, OpenAICompatibleError):
        raise ConnectionDraftError() from None


def discover_connection_draft(store, payload, http_client=None):
    settings, baseline = prepare_discovery_draft(store, payload)
    selected = protocol(settings)
    source = 'reference' if selected == 'seedream_native' else 'remote'
    result = {'models': [], 'fetched_at': None, 'checked_at': None, 'error': None,
              'error_code': None, 'source': source, 'connection_checked': False,
              'generation_checked': False}
    if not _DISCOVERY_SLOTS.acquire(blocking=False):
        raise ConnectionDraftError('busy')
    try:
        try:
            models = catalog_for_profile(settings).discover_models(
                _root(settings), settings['api_key'], http_client,
                network_settings=settings, include_metadata=True)
        except ModelCatalogError as exc:
            result.update(error=_MESSAGES.get(exc.code, _MESSAGES['invalid']), error_code=exc.code)
            return result
        if baseline is not None:
            try:
                current = store.read(payload['profile_id'])
                matches = baseline == connection_fingerprint(current, _root(current))
            except (ValueError, OSError, OpenAICompatibleError):
                matches = False
            if not matches:
                result.update(error=_MESSAGES['changed'], error_code='changed')
                return result
        # Static reference models never prove reachability, key validity or access.
        checked_at = datetime.now(timezone.utc).isoformat() if source == 'remote' else None
        from backend.services.providers.muse import detected_service_preset, annotate_models
        detected = detected_service_preset(models, settings)
        if detected:
            result['detected_service_preset'] = detected
        if settings.get('service_preset') == 'muse' or detected == 'muse':
            models = annotate_models(models)
        result.update(models=models, fetched_at=checked_at, checked_at=checked_at,
                      connection_checked=source == 'remote')
        return result
    finally:
        _DISCOVERY_SLOTS.release()
