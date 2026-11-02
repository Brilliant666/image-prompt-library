"""Muse Images adaptation with bounded model-list identity detection.

Contract: czg86389-hub/muse2api@1cd01682533dbf2c015fa879a8dc09534b50b4a3.
Uses the existing provider, queue, result validation and local recovery lifecycle.
"""
import re

RATIOS = ('1:1', '16:9', '9:16', '4:3', '3:4')
MAX_REFERENCE_BYTES = 10 * 1024 * 1024
MAX_TOTAL_REFERENCE_BYTES = 24 * 1024 * 1024


def service_preset(settings):
    from backend.services.openai_compatible import OpenAICompatibleError
    value = settings.get('service_preset', 'generic')
    if settings.get('service_preset_mode', 'auto') not in ('auto', 'manual'):
        raise OpenAICompatibleError('Unsupported service preset selection mode')
    if value not in ('generic', 'muse') or (value == 'muse' and settings.get('protocol', 'openai_compatible') != 'openai_compatible'):
        raise OpenAICompatibleError('Unsupported service preset for this protocol')
    return value


def detected_service_preset(models, settings):
    """Only a complete authenticated Muse catalog identifies the adapter.

    A key prefix, model name alone, cached list or mixed relay catalog cannot
    establish the multipart contract. This suggests a draft change only.
    """
    expected = {'muse-image', 'muse-spark', 'muse-video'}
    if settings.get('protocol', 'openai_compatible') != 'openai_compatible' or settings.get('service_preset_mode', 'auto') != 'auto':
        return None
    if len(models) == 3 and {model['id'] for model in models} == expected and all(model.get('owned_by') == 'muse' for model in models):
        return 'muse'
    return None


def normalize_parameters(parameters, default_model=''):
    from backend.services.openai_compatible import OpenAICompatibleError
    result = dict(parameters)
    model = result.get('model') or default_model
    if not isinstance(model, str) or model.strip() != 'muse-image':
        raise OpenAICompatibleError('Muse image generation requires muse-image; text and video models cannot use the image queue')
    if result.get('stream') or result.get('partial_images'):
        raise OpenAICompatibleError('Muse Images uses synchronous final images; disable stream and partial previews')
    ratio = result.get('requested_aspect_ratio', 'auto')
    size = result.get('size', 'auto')
    if ratio == 'auto' and size != 'auto':
        pixels = re.fullmatch(r'([1-9][0-9]{0,5})x([1-9][0-9]{0,5})', str(size))
        if not pixels:
            raise OpenAICompatibleError('Select a Muse aspect ratio instead of an exact pixel size')
        value = int(pixels[1]) / int(pixels[2])
        ratio = next((r for r in RATIOS if abs(value / (int(r.split(':')[0]) / int(r.split(':')[1])) - 1) <= .01), None)
    if ratio not in ('auto', *RATIOS):
        raise OpenAICompatibleError('Muse supports auto, 1:1, 16:9, 9:16, 4:3 or 3:4 aspect ratios')
    result.update(model='muse-image', size='auto', requested_aspect_ratio=ratio,
                  quality='auto', background='auto', output_format='auto', service_preset='muse')
    for key in ('moderation', 'output_compression', 'size_mode', 'aspect_ratio_prompt_injection'):
        result.pop(key, None)
    return result


def image_payload(prompt, normalized, transport, inputs):
    from backend.services.openai_compatible import OpenAICompatibleError
    if len(inputs) > 4 or any(len(item[1]) > MAX_REFERENCE_BYTES for item in inputs) or sum(len(item[1]) for item in inputs) > MAX_TOTAL_REFERENCE_BYTES:
        raise OpenAICompatibleError('Muse accepts at most 4 reference images, 10 MiB per image and 24 MiB total; no request was sent')
    payload = {'model': 'muse-image', 'prompt': prompt, 'n': 1, 'size': 'auto'}
    if normalized['requested_aspect_ratio'] != 'auto':
        payload['aspect_ratio'] = normalized['requested_aspect_ratio']
    if transport['response_format'] == 'b64_json':
        payload['response_format'] = 'b64_json'
    return payload


def annotate_models(models):
    """Annotate returned IDs, never invent models, access checks or API claims."""
    roles = {'muse-image': (True, False), 'muse-spark': (False, True), 'muse-video': (False, False)}
    return [{**model, 'image_generation': roles[model['id']][0],
             'text_generation': roles[model['id']][1], 'capability_source': 'documentation'}
            if model['id'] in roles and model.get('image_generation') is None and model.get('text_generation') is None
            else dict(model) for model in models]


def capabilities():
    return {'source': 'protocol_documentation', 'max_input_images': 4,
            'param_keys': ['model', 'size', 'requested_aspect_ratio'], 'stream': False,
            'aspect_ratios': ['auto', *RATIOS], 'known_models': ['muse-image'], 'output_formats': ['auto']}
