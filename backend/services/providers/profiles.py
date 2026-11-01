"""Explicit API protocol identities and endpoint roots, independent of brand names."""
from __future__ import annotations
import hashlib
import json
from urllib.parse import urlsplit, urlunsplit

API_PROTOCOLS = ('openai_compatible', 'gemini_native', 'seedream_native')


def protocol(settings):
    value = settings.get('protocol', 'openai_compatible')
    if value not in API_PROTOCOLS:
        from backend.services.openai_compatible import OpenAICompatibleError
        raise OpenAICompatibleError('Unsupported API protocol; select the protocol documented by this connection')
    return value


def normalize_profile_url(value, mode='versioned', protocol_id='openai_compatible'):
    from backend.services.openai_compatible import OpenAICompatibleError, normalize_base_url
    if protocol_id == 'openai_compatible':
        return normalize_base_url(value, mode)
    if protocol_id not in API_PROTOCOLS or mode not in ('versioned', 'custom'):
        raise OpenAICompatibleError('Unsupported API protocol or URL mode')
    parts = urlsplit(str(value).strip())
    if (parts.scheme not in {'http', 'https'} or not parts.hostname or parts.username or parts.password
            or parts.query or parts.fragment):
        raise OpenAICompatibleError('Base URL must be an HTTP(S) root without credentials, query or fragment')
    try:
        _ = parts.port
    except ValueError:
        raise OpenAICompatibleError('Invalid API port') from None
    path = parts.path.rstrip('/')
    if '/images/' in path or '/models/' in path or ':generateContent' in path:
        raise OpenAICompatibleError('Base URL must not contain a generation endpoint or model')
    if mode == 'versioned':
        if protocol_id == 'gemini_native':
            if not path.endswith(('/v1', '/v1beta')):
                path += '/v1beta'
        elif not path.endswith('/api/v3'):
            path += '/api/v3'
    return urlunsplit((parts.scheme, parts.netloc, path, '', ''))


def execution_identity(settings):
    """Private nonreversible connection identity; never a credential or a public API value."""
    from backend.services.api_network import network_identity
    selected = {key: settings.get(key) for key in
                ('id', 'base_url', 'api_key', 'model', 'timeout', 'base_url_mode', 'stream', 'partial_images', 'response_format')}
    selected.update(protocol=protocol(settings), network=network_identity(settings))
    return hashlib.sha256(json.dumps(selected, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()


def normalize_profile_parameters(parameters, settings, default_model=None):
    from .registry import get_provider
    selected = protocol(settings)
    mapper = get_provider(selected).mapper_factory
    if mapper is None:
        from backend.services.openai_compatible import OpenAICompatibleError
        raise OpenAICompatibleError('Selected protocol does not support image parameters')
    return mapper().normalize(parameters, settings.get('model', '') if default_model is None else default_model)
