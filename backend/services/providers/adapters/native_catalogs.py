"""Bounded native catalogs; model names alone never establish capabilities."""
from __future__ import annotations
import json
import time

import httpx
from backend.services.api_network import ApiNetworkError, create_api_client
from backend.services.model_catalog import (
    CATALOG_TIMEOUT, MAX_CATALOG_BYTES, MAX_CATALOG_MODELS, ModelCatalogError, _valid_id,
)
from backend.services.providers.native_params import GEMINI_IMAGE_MODELS, SEEDREAM_MODELS


class GeminiModelCatalog:
    def discover_models(self, normalized_root, api_key, http_client=None, *, network_settings=None, include_metadata=False):
        client = http_client
        started = time.monotonic()
        models, token, seen_tokens, total = [], None, set(), 0
        try:
            client = client or create_api_client(network_settings or {}, timeout=CATALOG_TIMEOUT)
            for _ in range(20):
                remaining = CATALOG_TIMEOUT - (time.monotonic() - started)
                if remaining <= 0: raise ModelCatalogError('timeout')
                params = {'pageSize': 100}
                if token: params['pageToken'] = token
                with client.stream('GET', normalized_root + '/models', params=params,
                        headers={'x-goog-api-key': api_key, 'Accept': 'application/json'},
                        timeout=remaining, follow_redirects=False) as response:
                    if response.status_code in (401, 403): raise ModelCatalogError('permission')
                    if not 200 <= response.status_code < 300: raise ModelCatalogError('http')
                    chunks = []
                    for chunk in response.iter_bytes():
                        total += len(chunk)
                        if total > MAX_CATALOG_BYTES: raise ModelCatalogError('limit')
                        if time.monotonic() - started > CATALOG_TIMEOUT: raise ModelCatalogError('timeout')
                        chunks.append(chunk)
                    try: body = json.loads(b''.join(chunks))
                    except (ValueError, UnicodeError, RecursionError): raise ModelCatalogError('invalid') from None
                if not isinstance(body, dict) or not isinstance(body.get('models'), list):
                    raise ModelCatalogError('invalid')
                for item in body['models']:
                    if not isinstance(item, dict) or not _valid_id(item.get('name'), api_key):
                        raise ModelCatalogError('invalid')
                    identity = item['name']
                    methods = item.get('supportedGenerationMethods', [])
                    if not isinstance(methods, list) or any(not isinstance(value, str) for value in methods):
                        raise ModelCatalogError('invalid')
                    image = True if identity.removeprefix('models/') in GEMINI_IMAGE_MODELS else (
                        False if methods and 'generateContent' not in methods else None)
                    model = {'id': identity, 'image_generation': image}
                    if include_metadata:
                        model.update(text_generation=False if methods and 'generateContent' not in methods else None,
                                     capability_source='documentation' if image is True else 'api' if image is False else 'unknown')
                    models.append(model)
                    if len(models) > MAX_CATALOG_MODELS: raise ModelCatalogError('limit')
                token = body.get('nextPageToken')
                if not token:
                    if not models: raise ModelCatalogError('empty')
                    return list({entry['id']: entry for entry in models}.values())
                if not isinstance(token, str) or len(token) > 4096 or token in seen_tokens or api_key in token:
                    raise ModelCatalogError('invalid')
                seen_tokens.add(token)
            raise ModelCatalogError('limit')
        except ApiNetworkError:
            raise ModelCatalogError('network_config') from None
        except httpx.TimeoutException:
            raise ModelCatalogError('timeout') from None
        except (httpx.HTTPError, OSError):
            raise ModelCatalogError('connection') from None
        finally:
            if http_client is None and client is not None: client.close()


class SeedreamModelCatalog:
    def discover_models(self, normalized_root, api_key, http_client=None, *, network_settings=None, include_metadata=False):
        # This documented reference list is NOT a network/permission test.
        # Endpoint IDs and other aliases can still be entered manually.
        return [{'id': identity, 'image_generation': True,
                 **({'text_generation': False, 'capability_source': 'documentation'} if include_metadata else {})}
                for identity in SEEDREAM_MODELS]
