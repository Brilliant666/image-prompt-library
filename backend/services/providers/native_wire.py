"""Verify the actual native wire at the existing confirmed-recipe POST boundary."""
from __future__ import annotations
import base64
from .profiles import normalize_profile_url, protocol
from .registry import image_provider_for_profile


def verify_recipe_wire(profile, job, method, url, options):
    from backend.services.agent_repository import AgentError
    from backend.services.image_download import MAX_IMAGE_BYTES
    try:
        if method != 'POST' or options.get('files') or options.get('data'):
            raise ValueError()
        body = options.get('json')
        if not isinstance(body, dict): raise ValueError()
        selected = protocol(profile)
        images = []
        if selected == 'gemini_native':
            content = body['contents']
            if len(content) != 1 or content[0]['role'] != 'user': raise ValueError()
            parts = content[0]['parts']
            prompt = parts[0]['text']
            for index, part in enumerate(parts[1:]):
                inline = part['inlineData']
                encoded, mime = inline['data'], inline['mimeType']
                if not isinstance(encoded, str) or len(encoded) > ((MAX_IMAGE_BYTES + 2) // 3) * 4: raise ValueError()
                images.append((f'reference-{index}', base64.b64decode(encoded, validate=True), mime))
        elif selected == 'seedream_native':
            prompt = body['prompt']
            values = body.get('image', [])
            if not isinstance(values, list): raise ValueError()
            for index, value in enumerate(values):
                if not isinstance(value, str) or len(value) > ((MAX_IMAGE_BYTES + 2) // 3) * 4 + 128: raise ValueError()
                header, encoded = value.split(',', 1)
                if not header.startswith('data:image/') or not header.endswith(';base64'): raise ValueError()
                images.append((f'reference-{index}', base64.b64decode(encoded, validate=True), header[5:-7]))
        else:
            raise ValueError()
        if not isinstance(prompt, str) or len(images) > 4: raise ValueError()
        provider = image_provider_for_profile(profile)
        normalized = provider.mapper_type().normalize(job.parameters, job.model or profile['model'])
        endpoint, expected, _ = provider._request(prompt, normalized, images)
        root = normalize_profile_url(profile['base_url'], job.parameters.get('base_url_mode', profile['base_url_mode']), selected)
        if str(url) != root + endpoint or body != expected:
            raise ValueError()
        return prompt, [data for _, data, _ in images]
    except (ValueError, TypeError, KeyError, IndexError):
        raise AgentError('recipe_changed', '原生请求内容与已确认配方不一致；未调用图片接口。', 400) from None
