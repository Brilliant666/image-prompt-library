"""Adapters over retained implementations keep old import and patch identities valid.

The public legacy module remains the implementation's stable import location.
Transport mapping and job lifecycle are delegated into the shared provider layer.
There is no fallback protocol and no second attempt inside these adapters.
"""
from __future__ import annotations


def image_provider(**options):
    from backend.services.openai_compatible import OpenAICompatibleProvider
    return OpenAICompatibleProvider(**options)


class OpenAIModelCatalog:
    def discover_models(self, normalized_root, api_key, http_client=None, *, network_settings=None):
        # Preserve the public injection boundary used by local API/transport tests.
        from backend.services.openai_compatible import fetch_models
        return fetch_models(normalized_root, api_key, http_client, network_settings=network_settings)


class ResponsesTextProvider:
    def complete(self, client, url, **request_options):
        # The Agent retains its established event, tool, reasoning and terminal
        # parser. The adapter exposes the original stream without flattening it.
        return client.stream('POST', url, **request_options)
