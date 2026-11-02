"""API-key native image protocols sharing existing assets, queue and recovery.

Protocol references (not a promise of account/model availability):
https://ai.google.dev/gemini-api/docs/generate-content/image-generation
https://docs.volcengine.com/docs/ark/image-generation-api
"""
from __future__ import annotations
import base64
from datetime import datetime, timezone
import hashlib
import json
import time
from urllib.parse import quote

import httpx
from backend.services.api_network import ApiNetworkError, create_api_client
from backend.services.image_api_stream import ImageStreamError, read_json_response
from backend.services.image_download import MAX_IMAGE_BYTES, ImageDownloadError, download_image
from backend.services.openai_compatible import (
    OpenAICompatibleError, OpenAICompatibleProvider, _inspect_image, _safe_value,
)
from backend.services.agent_diagnostics import safe_diagnostics
from backend.services.providers.base import ImageResult
from backend.services.providers.native_params import GeminiParamMapper, SeedreamParamMapper, SEEDREAM_LEGACY_SINGLE, SEEDREAM_JPEG_ONLY
from backend.services.providers.profiles import execution_identity, normalize_profile_url, protocol


class UnexpectedFinalImages:
    """Retain all valid finals without silently choosing an unauthorized winner."""
    def __init__(self, images):
        self.images = tuple(images)


class NativeApiImageProvider(OpenAICompatibleProvider):
    protocol_id = ''
    mapper_type = None

    def _settings(self, parameters):
        settings = self.config.read(parameters.get('compatible_profile_id'))
        if not settings.get('api_key'):
            raise OpenAICompatibleError('Image API key is missing')
        if protocol(settings) != self.protocol_id or parameters.get('protocol', self.protocol_id) != self.protocol_id:
            raise OpenAICompatibleError('The saved API protocol changed; create a new explicit request')
        frozen = parameters.get('protocol_profile_fingerprint')
        if frozen is not None and frozen != execution_identity(settings):
            raise OpenAICompatibleError('The saved native connection changed; create a new explicit request')
        return settings

    def _request(self, prompt, normalized, inputs):
        raise NotImplementedError

    def _results(self, body, fail):
        raise NotImplementedError

    def generate(self, prompt, parameters, input_images=None, on_partial=None):
        settings = self._settings(parameters)
        normalized = self.mapper_type().normalize({**parameters,
            **{key: parameters.get(key, settings[key]) for key in ('stream', 'partial_images', 'response_format')}}, settings['model'])
        if not isinstance(prompt, str) or not prompt.strip():
            raise OpenAICompatibleError('Generation prompt is required')
        inputs = input_images or []
        if not isinstance(inputs, (list, tuple)) or len(inputs) > 4:
            raise OpenAICompatibleError('Native image requests support at most four ordered references in this application')
        for item in inputs:
            if not isinstance(item, (list, tuple)) or len(item) != 3 or not isinstance(item[1], bytes):
                raise OpenAICompatibleError('Invalid reference image')
            if len(item[1]) > (10 * 1024 * 1024 if self.protocol_id == 'seedream_native' else MAX_IMAGE_BYTES):
                raise OpenAICompatibleError('Reference image exceeds the native adapter input limit; original was not changed')
            decoded_format, _, _ = _inspect_image(item[1])
            if item[2] != {'PNG': 'image/png', 'JPEG': 'image/jpeg', 'WEBP': 'image/webp'}[decoded_format]:
                raise OpenAICompatibleError('Reference MIME does not match the actual image format')
        endpoint, payload, headers = self._request(prompt, normalized, inputs)
        root = normalize_profile_url(settings['base_url'], parameters.get('base_url_mode', settings['base_url_mode']), self.protocol_id)
        # Inline image protocols must fail before a paid POST if the transport
        # itself is too large. No automatic cloud upload or resolution change.
        limit = 20 * 1024 * 1024 if self.protocol_id == 'gemini_native' else 64 * 1024 * 1024
        if len(json.dumps(payload, ensure_ascii=False).encode()) > limit:
            raise OpenAICompatibleError('Native inline request exceeds its local size budget; choose fewer or smaller references')
        if self.protocol_id == 'gemini_native': headers['x-goog-api-key'] = settings['api_key']
        else: headers['Authorization'] = 'Bearer ' + settings['api_key']
        headers['Accept'] = 'application/json'
        started = time.monotonic()
        diagnostics = {'endpoint': root + endpoint, 'started_at': datetime.now(timezone.utc).isoformat(),
                       'response_transport': 'json', 'protocol': self.protocol_id}
        def fail(category, message, error=None):
            diagnostics.update(category=category, provider_ms=round((time.monotonic() - started) * 1000, 3),
                               elapsed_seconds=round(time.monotonic() - started, 3))
            if error is not None:
                diagnostics.update(safe_diagnostics({'error': error}, secrets=(settings['api_key'], prompt)))
            raise OpenAICompatibleError(message + '; no automatic retry was attempted.', dict(diagnostics)) from None
        client = self.http_client
        try:
            client = client or create_api_client(settings, timeout=settings['timeout'])
            with client.stream('POST', root + endpoint, headers=headers, json=payload,
                               timeout=settings['timeout'], follow_redirects=False) as response:
                diagnostics.update(http_status=response.status_code,
                    request_id=_safe_value(response.headers.get('x-request-id') or response.headers.get('request-id'), settings['api_key']),
                    retry_after=_safe_value(response.headers.get('retry-after'), settings['api_key']))
                body = read_json_response(response)
                if not response.is_success:
                    category = {401: 'authentication', 403: 'permission_or_group', 404: 'route_or_model', 429: 'rate_limit'}.get(
                        response.status_code, 'upstream_error' if response.status_code >= 500 else 'api_error')
                    fail(category, f'Native image API returned HTTP {response.status_code}', body.get('error') if isinstance(body, dict) else None)
            if not isinstance(body, dict): fail('invalid_json_response', 'Native image API must return an object')
            if body.get('error'): fail('api_error', 'Native image API returned an error', body['error'])
        except OpenAICompatibleError:
            raise
        except ApiNetworkError:
            fail('local_validation', 'API network configuration could not be prepared')
        except ImageStreamError as exc:
            fail(exc.category, str(exc))
        except httpx.ConnectTimeout:
            fail('connect_timeout', 'Native image connection timed out; check the original request')
        except httpx.TimeoutException:
            fail('read_timeout', 'Native image request timed out; upstream outcome is unknown')
        except (httpx.HTTPError, OSError):
            fail('connection_error', 'Native image connection failed; upstream outcome is unknown')
        finally:
            if self.http_client is None and client is not None: client.close()
        entries, mixed = self._results(body, fail)
        images, image_errors = [], []
        for entry in entries:
            try:
                encoded, image_url = entry.get('b64_json'), entry.get('url')
                if isinstance(encoded, str) and encoded:
                    if len(encoded) > ((MAX_IMAGE_BYTES + 2) // 3) * 4:
                        fail('image_too_large', 'Native result exceeds the local byte limit')
                    try: data = base64.b64decode(encoded, validate=True)
                    except (ValueError, TypeError): fail('base64_decode', 'Native result Base64 is invalid')
                elif isinstance(image_url, str) and image_url:
                    try: data = download_image(image_url, settings['timeout'], self.download_client, network_settings=settings)
                    except ImageDownloadError as exc: fail(exc.category, str(exc))
                else:
                    fail('missing_image', 'Native final result contains no image data')
                decoded = _inspect_image(data, details=True)
                fmt = decoded['format']
                expected_mime = entry.get('mime')
                if expected_mime and expected_mime not in {'PNG': {'image/png'}, 'JPEG': {'image/jpeg', 'image/jpg'}, 'WEBP': {'image/webp'}}[fmt]:
                    fail('image_decode', 'Native image MIME and decoded format disagree')
                requested = {key: value for key, value in normalized.items()
                             if key not in {'input_images', 'protocol_profile_fingerprint'}}
                requested.update(prompt=prompt, protocol=self.protocol_id, compatible_profile_id=settings['id'],
                                 compatible_profile_name=settings['display_name'])
                safe_response = _safe_value({key: body[key] for key in ('usage', 'usageMetadata', 'modelVersion', 'created', 'id') if key in body}, settings['api_key'])
                diagnostics.update(provider_ms=round((time.monotonic() - started) * 1000, 3),
                                   elapsed_seconds=round(time.monotonic() - started, 3))
                metadata = {'provider': 'openai_compatible', 'protocol': self.protocol_id, 'auth_mode': 'api_key',
                            'requested': requested, 'response': safe_response, 'decoded_image': decoded,
                            'request_diagnostics': dict(diagnostics), 'input_image_count': len(inputs),
                            'mode': 'image_edit' if inputs else 'text_to_image'}
                extension = {'PNG': 'png', 'JPEG': 'jpg', 'WEBP': 'webp'}[fmt]
                images.append(ImageResult(data, self.protocol_id + '.' + extension, metadata))
            except OpenAICompatibleError as exc:
                image_errors.append(exc)
        if not images and image_errors: raise image_errors[0]
        if not images: fail('missing_image', 'The native response did not contain a final image')
        if len(images) != 1 or mixed or image_errors: return UnexpectedFinalImages(images)
        return images[0]


class GeminiImageProvider(NativeApiImageProvider):
    protocol_id = 'gemini_native'
    mapper_type = GeminiParamMapper

    def _request(self, prompt, normalized, inputs):
        image_config = {}
        options = normalized['provider_options']
        if options.get('aspect_ratio', 'auto') != 'auto': image_config['aspectRatio'] = options['aspect_ratio']
        if options.get('resolution', 'auto') != 'auto': image_config['imageSize'] = options['resolution']
        parts = [{'text': prompt}, *[{'inlineData': {'mimeType': mime, 'data': base64.b64encode(data).decode()}}
                                    for _, data, mime in inputs]]
        config = {'responseModalities': ['TEXT', 'IMAGE'], 'candidateCount': 1}
        if image_config: config['imageConfig'] = image_config
        model = normalized['model'].removeprefix('models/')
        return '/models/' + quote(model, safe='-._~') + ':generateContent', {
            'contents': [{'role': 'user', 'parts': parts}], 'generationConfig': config}, {}

    def _results(self, body, fail):
        feedback = body.get('promptFeedback')
        if isinstance(feedback, dict) and feedback.get('blockReason'):
            fail('moderation', 'The provider refused this image request')
        candidates = body.get('candidates')
        if not isinstance(candidates, list) or not candidates or len(candidates) > 16:
            fail('missing_image', 'Gemini returned no usable image candidate')
        images, failures = [], []
        for candidate in candidates:
            if not isinstance(candidate, dict):
                failures.append(('invalid_json_response', 'Invalid Gemini candidate'))
                continue
            if candidate.get('finishReason') != 'STOP':
                reason = candidate.get('finishReason')
                if reason in {'SAFETY', 'IMAGE_SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'RECITATION'}:
                    failures.append(('moderation', 'The provider refused this image output'))
                else:
                    failures.append(('incomplete_stream', 'Gemini did not confirm a complete final candidate'))
                # A refused/incomplete candidate's pixels are not successful finals.
                continue
            content = candidate.get('content')
            parts = content.get('parts') if isinstance(content, dict) else None
            if not isinstance(parts, list) or len(parts) > 128:
                failures.append(('invalid_json_response', 'Invalid Gemini image content'))
                continue
            for part in parts:
                if not isinstance(part, dict):
                    failures.append(('invalid_json_response', 'Invalid Gemini part'))
                    continue
                inline = part.get('inlineData', part.get('inline_data'))
                if inline is None or part.get('thought') is True:
                    continue
                if not isinstance(inline, dict):
                    failures.append(('image_decode', 'Invalid Gemini inline image'))
                    continue
                images.append({'b64_json': inline.get('data'), 'mime': inline.get('mimeType', inline.get('mime_type'))})
        if not images and failures:
            fail(*failures[0])
        # Confirmed final pixels survive unrelated failed candidates; the runner
        # retains them for inspection rather than falsely declaring full success.
        return images, bool(failures)


class SeedreamImageProvider(NativeApiImageProvider):
    protocol_id = 'seedream_native'
    mapper_type = SeedreamParamMapper

    def _request(self, prompt, normalized, inputs):
        payload = {'model': normalized['model'], 'prompt': prompt}
        if normalized['size'] != 'auto': payload['size'] = normalized['size']
        if normalized['model'] in SEEDREAM_LEGACY_SINGLE: payload['sequential_image_generation'] = 'disabled'
        if normalized['output_format'] != 'auto' and normalized['model'] not in SEEDREAM_JPEG_ONLY:
            payload['output_format'] = normalized['output_format']
        if normalized.get('response_format', 'auto') != 'auto': payload['response_format'] = normalized['response_format']
        if 'watermark' in normalized['provider_options']: payload['watermark'] = normalized['provider_options']['watermark']
        if inputs: payload['image'] = ['data:' + mime + ';base64,' + base64.b64encode(data).decode() for _, data, mime in inputs]
        return '/images/generations', payload, {}

    def _results(self, body, fail):
        entries = body.get('data')
        if not isinstance(entries, list) or not entries or len(entries) > 16:
            fail('missing_image', 'Seedream returned no usable image result')
        valid = [entry for entry in entries if isinstance(entry, dict) and not entry.get('error')]
        if not valid: fail('api_error', 'Seedream reported unsuccessful image outputs')
        return valid, len(valid) != len(entries)
