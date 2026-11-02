"""Read-only discovery from in-memory connection drafts; never a paid probe."""
import json
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from backend.main import create_app
from backend.services.api_connections import (
    ApiConnectionProfiles, ConnectionDraftError, MAX_DRAFT_BYTES, discover_connection_draft,
)
from backend.services.model_catalog import ModelCatalogCache
from backend.services.providers.adapters.openai_compatible import OpenAIModelCatalog


@pytest.fixture(autouse=True)
def no_live_calls(monkeypatch):
    monkeypatch.setattr(httpx.HTTPTransport, 'handle_request', lambda *args, **kw: pytest.fail('Live network forbidden'))


@pytest.fixture
def store(tmp_path, monkeypatch):
    path = tmp_path / 'private' / 'connections.json'
    monkeypatch.setenv('IMAGE_PROMPT_LIBRARY_OPENAI_COMPATIBLE_CONFIG_PATH', str(path))
    return ApiConnectionProfiles(path, tmp_path / 'library')


def draft(**changes):
    return {'base_url': 'https://api.invalid', 'protocol': 'openai_compatible',
            'api_key': 'draft-secret-value', 'network_mode': 'environment', **changes}


def run(store, payload, responder):
    calls = []
    def reply(request):
        calls.append(request)
        assert request.method == 'GET' and request.url.path.endswith('/models')
        return responder(request)
    with httpx.Client(transport=httpx.MockTransport(reply)) as transport:
        value = discover_connection_draft(store, payload, transport)
    return value, calls


def models_reply(request):
    return httpx.Response(200, json={'data': [
        {'id': 'chat', 'output_modalities': ['text']},
        {'id': 'picture', 'output_modalities': ['image']},
        {'id': 'multi', 'output_modalities': ['text', 'image']},
        {'id': 'image-sounding-unknown'},
        {'id': 'vision-input-only', 'input_modalities': ['image', 'text']},
    ]})


def test_unsaved_draft_discovers_without_profile_cache_or_job_write(store):
    value, calls = run(store, draft(), models_reply)
    assert len(calls) == 1 and str(calls[0].url) == 'https://api.invalid/v1/models'
    assert calls[0].headers['authorization'] == 'Bearer draft-secret-value'
    assert value['connection_checked'] is True and value['generation_checked'] is False
    assert value['source'] == 'remote' and value['error'] is None
    assert not store.path.exists() and not ModelCatalogCache(store.path).path.exists()
    assert not Path(store.library_path).exists()
    assert 'draft-secret-value' not in json.dumps(value)
    by_id = {item['id']: item for item in value['models']}
    assert by_id['chat']['text_generation'] is True and by_id['chat']['image_generation'] is False
    assert by_id['picture']['image_generation'] is True and by_id['picture']['text_generation'] is False
    assert by_id['multi']['text_generation'] is True and by_id['multi']['image_generation'] is True
    assert by_id['image-sounding-unknown']['image_generation'] is None
    assert by_id['vision-input-only']['text_generation'] is None


def test_saved_secret_only_used_for_same_normalized_target_and_protocol(store):
    store.save(draft(), profile_id='saved')
    before = store.path.read_bytes()
    value, calls = run(store, draft(profile_id='saved', api_key='', base_url='https://api.invalid/v1/'), models_reply)
    assert value['connection_checked'] and len(calls) == 1
    assert store.path.read_bytes() == before and not ModelCatalogCache(store.path).path.exists()
    for changes in ({'base_url': 'https://other.invalid'}, {'protocol': 'gemini_native'}, {'base_url_mode': 'custom'}):
        with pytest.raises(ConnectionDraftError, match='again'):
            run(store, draft(profile_id='saved', api_key='', **changes), models_reply)
    value, calls = run(store, draft(profile_id='saved', base_url='https://other.invalid', api_key='new-draft-secret'), models_reply)
    assert value['connection_checked'] and calls[0].headers['authorization']=='Bearer new-draft-secret'
    assert store.path.read_bytes() == before


def test_saved_proxy_and_key_stay_server_side_and_network_edits_are_transient(store):
    store.save(draft(network_mode='proxy', proxy_url='http://user:private-proxy@proxy.invalid:8080'), profile_id='saved')
    from backend.services.api_connections import prepare_discovery_draft
    before = store.path.read_bytes()
    settings, _ = prepare_discovery_draft(store, {'profile_id':'saved', 'base_url':'https://api.invalid', 'protocol':'openai_compatible'})
    assert settings['proxy_url']=='http://user:private-proxy@proxy.invalid:8080'
    settings, _ = prepare_discovery_draft(store, {'profile_id':'saved', 'base_url':'https://api.invalid', 'network_mode':'direct', 'remove_proxy_url':True})
    assert settings['proxy_url']=='' and store.path.read_bytes()==before


def test_seedream_reference_list_is_not_a_network_or_key_test(store):
    value, calls = run(store, draft(protocol='seedream_native', api_key=''), lambda request: pytest.fail('No request for reference models'))
    assert calls == [] and value['models']
    assert value['source']=='reference' and not value['connection_checked']
    assert value['checked_at'] is None and value['fetched_at'] is None
    assert all(item['capability_source']=='documentation' for item in value['models'])
    assert not store.path.exists()


def test_gemini_draft_uses_native_catalog_and_keeps_unknown_capabilities_unknown(store):
    def respond(request):
        assert request.headers['x-goog-api-key']=='draft-secret-value'
        assert 'authorization' not in request.headers
        return httpx.Response(200,json={'models':[
            {'name':'models/gemini-nano-banana-2.1','supportedGenerationMethods':['generateContent']},
            {'name':'models/custom-text-sounding','supportedGenerationMethods':['generateContent']},
            {'name':'models/embed','supportedGenerationMethods':['embedContent']}]})
    value,calls=run(store,draft(protocol='gemini_native'),respond)
    assert calls[0].url.path=='/v1beta/models'
    assert value['models'][0]['image_generation'] is True
    assert value['models'][1]['text_generation'] is None
    assert value['models'][2]['text_generation'] is False


@pytest.mark.parametrize('status', [401,403,429,500,302])
def test_failures_and_redirects_never_leak_keys_or_retry(store,status):
    value,calls=run(store,draft(),lambda req:httpx.Response(status,text='draft-secret-value',headers={'location':'https://else.invalid'}))
    assert len(calls)==1 and value['error_code']
    assert not value['connection_checked'] and 'draft-secret-value' not in json.dumps(value)
    assert not store.path.exists()


def test_saved_connection_replacement_or_deletion_during_discovery_rejects_result(store):
    for mutation in ('change','delete'):
        store.save(draft(),profile_id='saved')
        def respond(request):
            if mutation=='change': store.save({'api_key':'replacement'},profile_id='saved')
            else: store.delete('saved')
            return models_reply(request)
        value,_=run(store,draft(profile_id='saved',api_key=''),respond)
        assert value['error_code']=='changed' and value['models']==[]


@pytest.mark.parametrize('payload', [[],None,{'unknown':'draft-secret-value'},
    draft(base_url='https://user:secret@api.invalid'),draft(api_key='bad\nkey'),
    draft(protocol='unknown'),draft(network_mode='unexpected'),draft(proxy_url='ftp://secret'),
    draft(profile_id='missing'),draft(api_key=''),draft(protocol=[]),draft(base_url=None)])
def test_invalid_drafts_stop_before_network(store,payload):
    with pytest.raises(ConnectionDraftError):
        run(store,payload,lambda req:pytest.fail('Invalid input cannot reach network'))


def test_preview_route_is_bounded_same_origin_no_store_and_secret_safe(store,monkeypatch):
    calls=[]
    with httpx.Client(transport=httpx.MockTransport(lambda req:(calls.append(req) or models_reply(req)))) as transport:
        original=OpenAIModelCatalog.discover_models
        monkeypatch.setattr(OpenAIModelCatalog,'discover_models',lambda self,root,key,client=None,**kw:original(self,root,key,transport,**kw))
        client=TestClient(create_app(library_path=store.library_path))
        endpoint='/api/generation-providers/api-connections/models/preview'
        response=client.post(endpoint,json=draft())
        assert response.status_code==200 and response.headers['cache-control']=='no-store'
        assert response.json()['connection_checked'] and len(calls)==1
        assert not store.path.exists() and not ModelCatalogCache(store.path).path.exists()
        assert 'draft-secret-value' not in response.text
        assert client.post(endpoint,json=draft(),headers={'Origin':'https://foreign.invalid'}).status_code==403
        bad=client.post(endpoint,json=draft(api_key=['secret-array']))
        assert bad.status_code==422 and 'secret-array' not in bad.text
        large=client.post(endpoint,content=b' '*(MAX_DRAFT_BYTES+1))
        assert large.status_code==422
        assert len(calls)==1


def test_preview_route_rejects_deep_json_without_echoing_request_body(store):
    client=TestClient(create_app(library_path=store.library_path))
    response=client.post('/api/generation-providers/api-connections/models/preview',
                         content=b'['*1500+b'"private-nested-key"'+b']'*1500)
    assert response.status_code==400
    assert 'private-nested-key' not in response.text
    assert not store.path.exists()


def test_discovery_capacity_is_bounded_and_error_paths_release_slots(store,monkeypatch):
    from threading import BoundedSemaphore
    from backend.services import api_connections
    slot=BoundedSemaphore(1)
    monkeypatch.setattr(api_connections,'_DISCOVERY_SLOTS',slot)
    assert slot.acquire(blocking=False)
    try:
        with pytest.raises(ConnectionDraftError,match='Other model-list'):
            run(store,draft(),lambda req:pytest.fail('Busy checks cannot connect'))
    finally:
        slot.release()
    result,_=run(store,draft(),lambda req:httpx.Response(403))
    assert result['error_code']=='permission'
    success,_=run(store,draft(),models_reply)
    assert success['connection_checked']


def test_conflicting_output_claims_are_not_silently_classified(store):
    response={'data':[
        {'id':'conflict','output_modalities':['text']},
        {'id':'conflict','output_modalities':['image']},
        {'id':'none','capabilities':{'image_generation':False}},
    ]}
    result,_=run(store,draft(),lambda req:httpx.Response(200,json=response))
    assert result['models'][0]['image_generation'] is None
    assert result['models'][0]['text_generation'] is None
    assert result['models'][1]['text_generation'] is None
