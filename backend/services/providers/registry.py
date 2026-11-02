"""Explicit registry. Registration alone never authorizes an automated job."""
from __future__ import annotations
from types import MappingProxyType
from typing import Mapping

from .base import ProviderDescriptor
from .errors import ProviderError
from .params import OpenAIImageParamMapper
from .adapters.openai_compatible import OpenAIModelCatalog, ResponsesTextProvider, image_provider


def _api_executor(**options):
    from .job_runner import ApiProfileExecutor
    return ApiProfileExecutor(**options)


def _gemini_image(**options):
    from .adapters.native_images import GeminiImageProvider
    return GeminiImageProvider(**options)


def _seedream_image(**options):
    from .adapters.native_images import SeedreamImageProvider
    return SeedreamImageProvider(**options)


def _gemini_catalog():
    from .adapters.native_catalogs import GeminiModelCatalog
    return GeminiModelCatalog()


def _seedream_catalog():
    from .adapters.native_catalogs import SeedreamModelCatalog
    return SeedreamModelCatalog()


def _gemini_mapper():
    from .native_params import GeminiParamMapper
    return GeminiParamMapper()


def _seedream_mapper():
    from .native_params import SeedreamParamMapper
    return SeedreamParamMapper()


def _codex_executor(**options):
    from backend.services.openai_codex_native import OpenAICodexNativeProvider
    return OpenAICodexNativeProvider(**options)


def _grok_executor(**options):
    from backend.services.xai_grok_oauth import XaiGrokOAuthProvider
    return XaiGrokOAuthProvider(**options)


def _native_batch_executor(**options):
    from backend.services.agent_execution import NativeAgentImageProvider
    return NativeAgentImageProvider(**options)


_DESCRIPTORS = MappingProxyType({
    'openai_compatible': ProviderDescriptor(
        'openai_compatible', 'OpenAI compatible', 'api_key',
        executor_factory=_api_executor, image_factory=image_provider,
        catalog_factory=OpenAIModelCatalog, text_factory=ResponsesTextProvider,
        mapper_factory=OpenAIImageParamMapper),
    'gemini_native': ProviderDescriptor(
        'gemini_native', 'Gemini GenerateContent', 'api_key', image_factory=_gemini_image,
        catalog_factory=_gemini_catalog, mapper_factory=_gemini_mapper),
    'seedream_native': ProviderDescriptor(
        'seedream_native', 'Seedream Images', 'api_key', image_factory=_seedream_image,
        catalog_factory=_seedream_catalog, mapper_factory=_seedream_mapper),
    'openai_codex_oauth_native': ProviderDescriptor(
        'openai_codex_oauth_native', 'ChatGPT / Codex OAuth', 'codex_oauth_native',
        executor_factory=_codex_executor, legacy_executor=True),
    'xai_grok_oauth': ProviderDescriptor(
        'xai_grok_oauth', 'Grok OAuth', 'grok_oauth_device',
        executor_factory=_grok_executor, legacy_executor=True),
    'agent_native_batch': ProviderDescriptor(
        'agent_native_batch', 'Agent native image tool', 'inherited_profile',
        executor_factory=_native_batch_executor, legacy_executor=True),
})


def descriptors() -> tuple[ProviderDescriptor, ...]:
    return tuple(_DESCRIPTORS.values())


def get_provider(provider_id: str) -> ProviderDescriptor:
    try:
        return _DESCRIPTORS[provider_id]
    except (KeyError, TypeError):
        raise ProviderError('Unsupported provider; no request was sent', category='capability_unsupported') from None


def automated_provider_ids() -> frozenset[str]:
    return frozenset(item.id for item in descriptors() if item.automated)


def executor_for(provider_id: str, **options):
    descriptor = get_provider(provider_id)
    if descriptor.executor_factory is None:
        raise ProviderError('This provider has no automated image executor', category='capability_unsupported')
    return descriptor.executor_factory(**options)


def protocol_for_profile(profile: Mapping) -> str:
    # Missing means the legacy protocol, never a guess based on a model alias.
    value = profile.get('protocol', 'openai_compatible')
    if not isinstance(value, str) or not value:
        raise ProviderError('Invalid profile protocol', category='request_error')
    return value


def image_provider_for_profile(profile: Mapping, **options):
    descriptor = get_provider(protocol_for_profile(profile))
    if descriptor.auth_mode != 'api_key' or descriptor.image_factory is None:
        raise ProviderError('The selected profile has no API-key image protocol', category='capability_unsupported')
    return descriptor.image_factory(**options)


def catalog_for_profile(profile: Mapping):
    descriptor = get_provider(protocol_for_profile(profile))
    if descriptor.catalog_factory is None:
        raise ProviderError('This protocol does not offer model discovery', category='capability_unsupported')
    return descriptor.catalog_factory()


def text_provider_for_profile(profile: Mapping):
    descriptor = get_provider(protocol_for_profile(profile))
    if descriptor.text_factory is None:
        raise ProviderError('This profile cannot run the Agent Responses protocol', category='capability_unsupported')
    return descriptor.text_factory()
