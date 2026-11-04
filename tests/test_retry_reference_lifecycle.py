"""References survive supported discard/retry and cleanup with their original bytes."""
import base64
from email import policy
from email.parser import BytesParser

import httpx
import pytest

from backend.repositories import ItemRepository
from backend.schemas import GenerationJobCreate
from backend.services.generation_jobs import GenerationJobRepository
from backend.services.library_cleanup import LibraryCleanupService
from backend.services.openai_compatible import OpenAICompatibleConfig, OpenAICompatibleProvider
from test_agent_workspaces import image_bytes
from test_data_safety import add_stored_image


@pytest.mark.parametrize('kind', ['upload', 'library', 'generated', 'frozen'])
def test_discard_retry_keeps_exact_references_through_cleanup_and_repository_reopen(tmp_path, monkeypatch, kind):
    library = tmp_path / 'library'
    config = OpenAICompatibleConfig(tmp_path / 'private' / 'provider.json', library)
    monkeypatch.setenv('IMAGE_PROMPT_LIBRARY_OPENAI_COMPATIBLE_CONFIG_PATH', str(config.path))
    config.save({'base_url': 'https://provider.invalid/v1', 'api_key': 'synthetic-only-key',
                 'model': 'synthetic-image', 'network_mode': 'environment'}, profile_id='fixture')
    jobs = GenerationJobRepository(library)
    pixels = [image_bytes('red'), image_bytes('blue')]
    references, source_jobs, source_items = [], [], []
    for index, data in enumerate(pixels):
        if kind == 'upload':
            references.append({'data_url': 'data:image/png;base64,' + base64.b64encode(data).decode()})
        elif kind == 'library':
            items = ItemRepository(library)
            item, stored = add_stored_image(items, library, data)
            image = items.get_item(item.id).images[0]
            references.append({'source': 'library', 'image_id': image.id})
            source_items.append(item.id)
        elif kind == 'generated':
            source = jobs.create_job(GenerationJobCreate(provider='manual_upload', prompt_text='Synthetic source'))
            source = jobs.stage_result(source.id, data, 'source.png')
            references.append({'result_path': source.result_path, 'name': f'source-{index}.png'})
            source_jobs.append(source.id)
        else:
            path = library / 'generation-references' / 'retained-fixture' / f'input-{index}.png'
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
            references.append({'result_path': path.relative_to(library).as_posix()})
    prompt = '  Synthetic exact edit\nKeep the ordered reference pixels.  '
    original = jobs.create_job(GenerationJobCreate(provider='openai_compatible', prompt_text=prompt,
        parameters={'compatible_profile_id': 'fixture', 'input_images': references}))
    original = jobs.stage_result(original.id, image_bytes('green'), 'result.png')
    frozen_paths = [entry['result_path'] for entry in original.parameters['input_images']]
    retried = jobs.discard_and_retry_job(original.id)
    assert retried.discarded_job.status == 'discarded'
    assert not (library / original.result_path).exists()
    for source_id in source_jobs:
        jobs.discard_job(source_id)
    for item_id in source_items:
        jobs.items.delete_item(item_id)
        jobs.items.purge_item(item_id)
    cleanup = LibraryCleanupService(library)
    cleanup.apply(cleanup.preview(), remove_broken_image_records=True, remove_unreferenced_files=True)
    reopened = GenerationJobRepository(library)
    retry = reopened.get_job(retried.retry_job.id)
    assert retry.prompt_text == prompt
    assert [entry['result_path'] for entry in retry.parameters['input_images']] == frozen_paths
    assert [(library / path).read_bytes() for path in frozen_paths] == pixels
    calls = []
    def handler(request):
        calls.append(request)
        assert request.url.path == '/v1/images/edits'
        message = BytesParser(policy=policy.default).parsebytes(
            ('Content-Type: ' + request.headers['content-type'] + '\r\nMIME-Version: 1.0\r\n\r\n').encode() + request.content)
        parts = list(message.iter_parts())
        sent_pixels = [part.get_payload(decode=True) for part in parts
                       if part.get_param('name', header='content-disposition') == 'image[]']
        sent_prompt = next(part.get_payload(decode=True).decode() for part in parts
                           if part.get_param('name', header='content-disposition') == 'prompt')
        assert sent_pixels == pixels and sent_prompt == prompt
        return httpx.Response(200, json={'data': [{'b64_json': base64.b64encode(image_bytes('purple')).decode()}]})
    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        result = OpenAICompatibleProvider(config, client).run_job(library, retry.id)
    assert result.status == 'succeeded' and len(calls) == 1
    assert (library / result.result_path).read_bytes() == image_bytes('purple')
    assert [(library / path).read_bytes() for path in frozen_paths] == pixels
