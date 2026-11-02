"""Request intent is separate from transport. No profile, model or endpoint guessing."""
from __future__ import annotations
from copy import deepcopy
from dataclasses import dataclass
from typing import Any, Mapping


@dataclass(frozen=True)
class CanonicalImageRequest:
    prompt: str
    parameters: Mapping[str, Any]

    def copied_parameters(self) -> dict[str, Any]:
        # Preserve unknown historical fields and falsy values, especially zero.
        # Each protocol validates its own extension fields before dispatch.
        return deepcopy(dict(self.parameters))


@dataclass(frozen=True)
class MappedImageRequest:
    normalized: dict[str, Any]
    transport: dict[str, Any]
    payload: dict[str, Any]
    effective_prompt: str


class OpenAIImageParamMapper:
    def normalize(self, parameters: Mapping[str, Any], default_model: str = '') -> dict[str, Any]:
        from backend.services.openai_compatible import normalize_image_parameters
        return normalize_image_parameters(dict(parameters), default_model)

    def to_wire(self, request: CanonicalImageRequest, settings: Mapping[str, Any]) -> MappedImageRequest:
        from backend.services.openai_compatible import (
            ASPECT_RATIO_SIZES, OpenAICompatibleConfig, OpenAICompatibleError,
        )
        normalized = self.normalize(request.copied_parameters(), settings['model'])
        transport = {key: normalized.get(key, settings[key]) for key in
                     ('base_url_mode', 'stream', 'partial_images', 'response_format')}
        OpenAICompatibleConfig._validate_options({**settings, **transport})
        if not isinstance(request.prompt, str) or not request.prompt.strip():
            raise OpenAICompatibleError('Generation prompt is required')
        payload = {key: normalized[key] for key in
                   ('model', 'size', 'quality', 'background', 'output_format', 'output_compression', 'moderation')
                   if key in normalized}
        prompt = request.prompt
        ratio = normalized.get('requested_aspect_ratio', 'auto')
        if normalized.get('aspect_ratio_prompt_injection') is True and ratio in ASPECT_RATIO_SIZES and ratio != 'auto':
            prompt += f'\n\nRequested output aspect ratio: {ratio} (width:height). Compose the image in this aspect ratio.'
        payload.update(prompt=prompt, n=1)
        if transport['stream']:
            payload.update(stream=True, partial_images=transport['partial_images'])
        if transport['response_format'] == 'b64_json':
            payload['response_format'] = 'b64_json'
        return MappedImageRequest(normalized, transport, payload, prompt)
