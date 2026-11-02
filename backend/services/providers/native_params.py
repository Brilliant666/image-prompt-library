"""Native image controls: bounded, explicit mappings, not model-name protocol guesses."""
from __future__ import annotations
from copy import deepcopy
import re

GEMINI_RATIOS = ('1:1', '1:4', '4:1', '1:8', '8:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9')
GEMINI_IMAGE_MODELS = (
    'gemini-nano-banana-2.1', 'gemini-3.1-flash-image', 'gemini-3.1-flash-lite-image',
    'gemini-3-pro-image-preview', 'gemini-3-pro-image',
    'gemini-2.5-flash-image', 'gemini-2.5-flash-image-preview',
)
SEEDREAM_MODELS = (
    'doubao-seedream-5-0-pro-260628', 'doubao-seedream-5-0-flash-260915',
    'doubao-seedream-5-0-lite-260128',
    'doubao-seedream-4-5-251128', 'doubao-seedream-4-0-250828',
)
SEEDREAM_LEGACY_SINGLE = frozenset(SEEDREAM_MODELS[2:])
SEEDREAM_JPEG_ONLY = frozenset(SEEDREAM_MODELS[-2:])
GEMINI_STANDARD_RATIOS = tuple(value for value in GEMINI_RATIOS if value not in {'1:4', '4:1', '1:8', '8:1'})


def gemini_model_options(model):
    exact = model.removeprefix('models/')
    if exact in {'gemini-2.5-flash-image', 'gemini-2.5-flash-image-preview'}:
        return GEMINI_STANDARD_RATIOS, ('auto',)
    if exact in {'gemini-3-pro-image', 'gemini-3-pro-image-preview'}:
        return GEMINI_STANDARD_RATIOS, ('auto', '1K', '2K', '4K')
    if exact == 'gemini-nano-banana-2.1':
        return GEMINI_RATIOS, ('auto', '1K', '2K', '4K')
    if exact == 'gemini-3.1-flash-lite-image':
        return GEMINI_STANDARD_RATIOS, ('auto', '1K')
    # Unknown aliases retain explicit controls; they are not declared supported.
    return GEMINI_RATIOS, ('auto', '512', '1K', '2K', '4K')


def seedream_model_options(model):
    if model in SEEDREAM_MODELS[:2]:
        return ('auto', '1K', '1.5K', '2K'), 921_600, 4_624_220
    if model == 'doubao-seedream-5-0-lite-260128':
        return ('auto', '2K', '3K', '4K'), 3_686_400, 16_777_216
    if model == 'doubao-seedream-4-5-251128':
        return ('auto', '2K', '4K'), 3_686_400, 16_777_216
    if model == 'doubao-seedream-4-0-250828':
        return ('auto', '1K', '2K', '4K'), 921_600, 16_777_216
    return ('auto', '1K', '1.5K', '2K', '3K', '4K'), 921_600, 16_777_216


def _fail(message):
    from backend.services.openai_compatible import OpenAICompatibleError
    raise OpenAICompatibleError(message)


def _base(parameters, default_model, allowed):
    result = deepcopy(dict(parameters or {}))
    model = result.get('model') or default_model
    if not isinstance(model, str) or not model.strip() or len(model.strip()) > 200 or any(ord(c) < 32 for c in model):
        _fail('A complete model ID is required')
    result['model'] = model.strip()
    options = result.get('provider_options')
    if options is None:
        options = {}
    if not isinstance(options, dict) or set(options) - set(allowed):
        _fail('Unsupported native provider options; request was not sent')
    result['provider_options'] = options
    for key in ('quality', 'background', 'moderation'):
        if result.get(key) not in (None, 'auto'):
            _fail(f'{key} is not mapped by this native protocol; select auto or remove the explicit value')
    for key in ('input_fidelity', 'mask', 'mask_url', 'mask_image', 'seed', 'negative_prompt'):
        if result.get(key) is not None:
            _fail(f'{key} is not supported by this native adapter; request was not sent')
    allowed_fields = {
        'model', 'size', 'quality', 'background', 'output_format', 'output_compression',
        'moderation', 'protocol', 'protocol_profile_fingerprint', 'provider_options',
        'base_url_mode', 'stream', 'partial_images', 'response_format', 'n',
        'compatible_profile_id', 'compatible_profile_name', 'input_images',
        'requested_aspect_ratio', 'aspect_ratio_prompt_injection', 'size_mode',
        'prompt_template', 'prompt_template_values', 'prompt_template_resolved_text',
    }
    if set(result) - allowed_fields:
        _fail('Unknown native request fields cannot be mapped; no request was sent')
    if result.get('n', 1) != 1 or type(result.get('n', 1)) is not int:
        _fail('Native output count must be one per queued task')
    if result.get('output_compression') is not None:
        _fail('Output compression is not supported by this native protocol')
    if result.get('stream') is True or result.get('partial_images') not in (None, 0):
        _fail('Native image streaming is not enabled in this adapter')
    if result.get('aspect_ratio_prompt_injection') is True:
        _fail('Use the native aspect ratio control; automatic Prompt rewriting is not supported')
    if result.get('size_mode') is not None:
        _fail('Use the native size controls instead of the OpenAI automatic-pixel policy')
    result.setdefault('quality', 'auto')
    result.setdefault('background', 'auto')
    result.setdefault('output_format', 'auto')
    result.setdefault('size', 'auto')
    return result


class GeminiParamMapper:
    def normalize(self, parameters, default_model=''):
        result = _base(parameters, default_model, ('aspect_ratio', 'resolution'))
        if result['size'] != 'auto':
            _fail('Gemini uses aspect ratio and resolution, not WIDTHxHEIGHT; set size to auto')
        if result['output_format'] != 'auto':
            _fail('Gemini output format is supplied by the model; choose auto')
        if result.get('response_format') not in (None, 'auto'):
            _fail('Gemini inline image data does not use response_format')
        options = result['provider_options']
        ratio = options.get('aspect_ratio', 'auto')
        ratios, resolutions = gemini_model_options(result['model'])
        if not isinstance(ratio, str) or ratio != 'auto' and ratio not in ratios:
            _fail('Unsupported Gemini aspect ratio')
        if result.get('requested_aspect_ratio') not in (None, 'auto', ratio):
            _fail('Native aspect ratio conflicts with the saved recipe')
        size = options.get('resolution', 'auto')
        if not isinstance(size, str) or size not in resolutions:
            _fail('Unsupported Gemini resolution')
        exact_model = result['model'].removeprefix('models/')
        if exact_model in {'gemini-2.5-flash-image', 'gemini-2.5-flash-image-preview'} and size != 'auto':
            _fail('This Gemini model does not support an explicit imageSize')
        return result


class SeedreamParamMapper:
    def normalize(self, parameters, default_model=''):
        result = _base(parameters, default_model, ('watermark',))
        if result.get('requested_aspect_ratio') not in (None, 'auto'):
            _fail('Seedream uses native size; select dimensions instead of a separate aspect-ratio hint')
        options = result['provider_options']
        if 'watermark' in options and type(options['watermark']) is not bool:
            _fail('Watermark must be true or false')
        if result['output_format'] not in ('auto', 'png', 'jpeg'):
            _fail('Seedream output format must be auto, png or jpeg')
        if result['model'] in SEEDREAM_JPEG_ONLY and result['output_format'] not in ('auto', 'jpeg'):
            _fail('This Seedream model produces JPEG; PNG cannot be requested')
        if result.get('response_format') not in (None, 'auto', 'url', 'b64_json'):
            _fail('Seedream response format must be auto, url or b64_json')
        size = result['size']
        choices, minimum, maximum = seedream_model_options(result['model'])
        match = re.fullmatch(r'([1-9][0-9]{0,4})x([1-9][0-9]{0,4})', size) if isinstance(size, str) else None
        if match:
            width, height = map(int, match.groups())
            if not minimum <= width * height <= maximum or max(width, height) > 16 * min(width, height):
                _fail('Seedream dimensions exceed the selected model bounds')
        elif size not in choices:
            _fail('Unsupported Seedream size for the selected model')
        return result


def protocol_capabilities(protocol_id):
    if protocol_id == 'gemini_native':
        return {'source': 'protocol_documentation', 'input_modalities': ['text', 'image'],
                'output_modalities': ['image'], 'max_input_images': 4,
                'param_keys': ['model', 'provider_options'], 'stream': False,
                'aspect_ratios': ['auto', *GEMINI_RATIOS], 'resolutions': ['auto', '512', '1K', '2K', '4K'],
                'known_models': list(GEMINI_IMAGE_MODELS), 'output_formats': ['auto']}
    if protocol_id == 'seedream_native':
        return {'source': 'protocol_documentation', 'input_modalities': ['text', 'image'],
                'output_modalities': ['image'], 'max_input_images': 4,
                'param_keys': ['model', 'size', 'output_format', 'provider_options'], 'stream': False,
                'sizes': ['auto', '1K', '1.5K', '2K', '3K', '4K'],
                'known_models': list(SEEDREAM_MODELS), 'output_formats': ['auto', 'png', 'jpeg']}
    return {'source': 'protocol_documentation', 'max_input_images': 4,
            'param_keys': ['model', 'size', 'quality', 'background', 'output_format', 'output_compression', 'moderation'],
            'stream': True}
