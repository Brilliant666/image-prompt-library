"""Detect Muse only from a bounded, authenticated model-list response.

Detection is a draft suggestion, never a configuration write or a model probe.
"""
import json
from pathlib import Path

import httpx
import pytest

from backend.services.agent_repository import profile_digest, public_profile_digest
from backend.services.api_connections import ConnectionDraftError, discover_connection_draft
from backend.services.model_catalog import ModelCatalogCache, connection_fingerprint, fetch_models
from backend.services.openai_compatible import OpenAICompatibleConfig, OpenAICompatibleError


MODEL_IDS = ('muse-image', 'muse-spark', 'muse-video')


@pytest.fixture(autouse=True)
def no_live_network(monkeypatch):
    monkeypatch.setattr(httpx.HTTPTransport, 'handle_request',
                        lambda *a, **kw: pytest.fail('External network is forbidden'))


@pytest.fixture
def store(tmp_path, monkeypatch):
    value = OpenAICompatibleConfig(tmp_path / 'private' / 'connections.json', tmp_path / 'library')
    monkeypatch.setenv('IMAGE_PROMPT_LIBRARY_OPENAI_COMPATIBLE_CONFIG_PATH', str(value.path))
    return value


def draft(**changes):
    return {'protocol': 'openai_compatible', 'base_url': 'https://service.invalid',
            'api_key': 'custom-synthetic-key', 'base_url_mode': 'versioned',
            'network_mode': 'environment', **changes}


def muse_models():
    return [{'id': identity, 'owned_by': 'muse'} for identity in MODEL_IDS]


def discover(store, payload, entries, callback=None):
    calls = []
    def respond(request):
        calls.append(request)
        assert request.method == 'GET' and request.url.path.endswith('/models')
        if callback:
            callback(request)
        return httpx.Response(200, json={'data': entries})
    with httpx.Client(transport=httpx.MockTransport(respond)) as client:
        value = discover_connection_draft(store, payload, client)
    assert len(calls) == 1
    return value, calls


TARGET_CHANGES = [
    ({}, {'base_url': 'https://other.invalid', 'api_key': 'custom-synthetic-key'}),
    ({}, {'api_key': 'replacement-synthetic-key'}),
    ({}, {'base_url_mode': 'custom', 'api_key': 'custom-synthetic-key'}),
    ({}, {'network_mode': 'direct'}),
    ({}, {'network_mode': 'proxy', 'proxy_url': 'http://proxy.invalid:8080'}),
    ({'network_mode': 'proxy', 'proxy_url': 'http://user:old@proxy.invalid:8080'},
     {'proxy_url': 'http://user:new@proxy.invalid:8080'}),
]


def saved_auto_muse(store, initial):
    store.save(draft(model='muse-image', service_preset='muse', service_preset_mode='auto', **initial),
               profile_id='saved')


@pytest.mark.parametrize('initial,change', TARGET_CHANGES)
def test_changed_auto_muse_full_save_requires_fresh_target_evidence(store, initial, change):
    saved_auto_muse(store, initial)
    before = store.path.read_bytes()
    full = {**store.read('saved'), **change}
    with pytest.raises(OpenAICompatibleError, match='discovery'):
        store.save(full, profile_id='saved')
    assert store.path.read_bytes() == before


@pytest.mark.parametrize('initial,change', TARGET_CHANGES)
def test_changed_auto_muse_partial_save_invalidates_old_adapter(store, initial, change):
    saved_auto_muse(store, initial)
    store.save(change, profile_id='saved')
    assert store.read('saved')['service_preset'] == 'generic'
    assert store.read('saved')['service_preset_mode'] == 'auto'


@pytest.mark.parametrize('initial,change', TARGET_CHANGES)
def test_fresh_discovery_allows_one_changed_target_save_without_more_network(store, initial, change):
    saved_auto_muse(store, initial)
    target = {key: value for key, value in store.read('saved').items()
              if key in {'base_url', 'api_key', 'base_url_mode', 'network_mode', 'proxy_url',
                         'protocol', 'service_preset', 'service_preset_mode'}}
    target.update(change, profile_id='saved')
    result, calls = discover(store, target, muse_models())
    assert result['detected_service_preset'] == 'muse'
    store.save({**store.read('saved'), **change}, profile_id='saved')
    assert store.read('saved')['service_preset'] == 'muse'
    assert store.read('saved')['service_preset_mode'] == 'auto'
    assert len(calls) == 1 and calls[0].method == 'GET'


@pytest.mark.parametrize('initial,change', TARGET_CHANGES)
def test_manual_muse_target_changes_do_not_require_discovery(store, initial, change):
    saved_auto_muse(store, initial)
    store.save({'service_preset_mode': 'manual'}, profile_id='saved')
    store.save(change, profile_id='saved')
    assert store.read('saved')['service_preset'] == 'muse'
    assert store.read('saved')['service_preset_mode'] == 'manual'


def test_unchanged_auto_muse_keeps_adapter_for_name_model_and_same_target_save(store):
    saved_auto_muse(store, {})
    store.save({'display_name': 'Renamed synthetic Muse', 'model': 'manual-image-alias'}, profile_id='saved')
    store.save(store.read('saved'), profile_id='saved')
    assert store.read('saved')['service_preset'] == 'muse'


def test_failed_or_mixed_discovery_does_not_authorize_changed_auto_muse_save(store):
    saved_auto_muse(store, {})
    change = {'base_url': 'https://other.invalid', 'api_key': 'custom-synthetic-key'}
    result, _ = discover(store, draft(profile_id='saved', **change), muse_models() + [{'id': 'another'}])
    assert not result.get('detected_service_preset')
    before = store.path.read_bytes()
    with pytest.raises(OpenAICompatibleError, match='discovery'):
        store.save({**store.read('saved'), **change}, profile_id='saved')
    assert store.path.read_bytes() == before


@pytest.mark.parametrize('lost', ['expiry', 'restart'])
def test_changed_auto_muse_save_fails_closed_when_discovery_evidence_is_lost(store, monkeypatch, lost):
    from collections import OrderedDict
    from backend.services.providers import muse
    clock = [100.0]
    monkeypatch.setattr(muse, 'monotonic', lambda: clock[0])
    monkeypatch.setattr(muse, '_discovery_evidence', OrderedDict())
    saved_auto_muse(store, {})
    change = {'base_url': 'https://other.invalid', 'api_key': 'custom-synthetic-key'}
    result, calls = discover(store, draft(profile_id='saved', **change), muse_models())
    assert result['detected_service_preset'] == 'muse'
    if lost == 'expiry':
        clock[0] += muse.DISCOVERY_EVIDENCE_TTL
    else:
        muse._discovery_evidence.clear()
    before = store.path.read_bytes()
    with pytest.raises(OpenAICompatibleError, match='discovery'):
        store.save({**store.read('saved'), **change}, profile_id='saved')
    assert store.path.read_bytes() == before and len(calls) == 1


def test_discovery_evidence_is_bounded_and_scoped_to_the_credential_store(store, tmp_path, monkeypatch):
    from collections import OrderedDict
    from backend.services.providers import muse
    monkeypatch.setattr(muse, '_discovery_evidence', OrderedDict())
    targets = []
    for index in range(muse.MAX_DISCOVERY_EVIDENCE + 1):
        target = draft(base_url=f'https://service-{index}.invalid')
        result, _ = discover(store, target, muse_models())
        assert result['detected_service_preset'] == 'muse'
        targets.append(target)
    assert len(muse._discovery_evidence) == muse.MAX_DISCOVERY_EVIDENCE
    assert all(len(identity) == 64 and isinstance(deadline, float)
               for identity, deadline in muse._discovery_evidence.items())
    assert not muse.has_recent_muse_detection(targets[0], store.path)
    assert muse.has_recent_muse_detection(targets[-1], store.path)
    other = OpenAICompatibleConfig(tmp_path / 'other-private' / 'connections.json', tmp_path / 'other-library')
    saved_auto_muse(other, {})
    before = other.path.read_bytes()
    with pytest.raises(OpenAICompatibleError, match='discovery'):
        other.save({**other.read('saved'), 'base_url': targets[-1]['base_url'],
                    'api_key': 'custom-synthetic-key'}, profile_id='saved')
    assert other.path.read_bytes() == before


@pytest.mark.parametrize('key', ['custom-synthetic-key', 'm2a_fixture-key'])
@pytest.mark.parametrize('mode', [None, 'auto'])
def test_strong_model_identity_detects_muse_without_saving_or_generating(store, key, mode):
    payload = draft(api_key=key, **({'service_preset_mode': mode} if mode else {}))
    result, calls = discover(store, payload, muse_models())
    assert result['detected_service_preset'] == 'muse'
    assert result['source'] == 'remote' and result['connection_checked'] is True
    assert result['generation_checked'] is False and result['error_code'] is None
    assert result['fetched_at'] and result['checked_at']
    models = {model['id']: model for model in result['models']}
    assert models['muse-image']['image_generation'] is True
    assert models['muse-spark']['text_generation'] is True
    assert models['muse-video']['image_generation'] is False and models['muse-video']['text_generation'] is False
    assert all(model['capability_source'] == 'documentation' for model in models.values())
    assert calls[0].headers['authorization'] == 'Bearer ' + key
    assert key not in json.dumps(result)
    assert not store.path.exists() and not ModelCatalogCache(store.path).path.exists()
    assert not Path(store.library_path).exists()


@pytest.mark.parametrize('entries', [
    [{'id': identity} for identity in MODEL_IDS],
    [{'id': 'muse-image', 'owned_by': 'muse'}, {'id': 'muse-spark', 'owned_by': 'muse'}],
    muse_models() + [{'id': 'other-image', 'owned_by': 'muse'}],
    [{'id': identity, 'owned_by': 'other'} for identity in MODEL_IDS],
    [{'id': identity, 'owned_by': 'Muse'} for identity in MODEL_IDS],
    [{'id': identity, 'owned_by': 'muse' if identity != 'muse-video' else 'other'} for identity in MODEL_IDS],
    muse_models() + [{'id': 'muse-image', 'owned_by': 'other'}],
    [{'id': 'muse-spark'}] + muse_models(),
    [{'id': 'unrelated-chat', 'owned_by': 'muse'}],
])
def test_key_prefix_and_names_alone_do_not_infer_a_service(store, entries):
    result, _ = discover(store, draft(api_key='m2a_synthetic-prefix-only'), entries)
    assert not result.get('detected_service_preset')
    assert result['connection_checked'] and result['generation_checked'] is False
    # Unproven image-looking names do not acquire image capability claims.
    assert all(model['image_generation'] is None for model in result['models'])
    assert not store.path.exists()


@pytest.mark.parametrize('preset', ['generic', 'muse'])
def test_manual_mode_keeps_explicit_adaptation_and_never_suggests_an_override(store, preset):
    store.save(draft(service_preset=preset, service_preset_mode='manual', model='muse-image'), profile_id='saved')
    before = store.path.read_bytes()
    result, _ = discover(store, draft(profile_id='saved', api_key='',
        service_preset=preset, service_preset_mode='manual'), muse_models())
    assert not result.get('detected_service_preset')
    assert store.read('saved')['service_preset'] == preset
    assert store.path.read_bytes() == before
    if preset == 'generic':
        assert all(model['image_generation'] is None for model in result['models'])
    else:
        assert next(model for model in result['models'] if model['id'] == 'muse-image')['image_generation'] is True


def test_auto_is_legacy_default_and_manual_changes_request_and_catalog_identity(store):
    store.save(draft(model='muse-image'), profile_id='saved')
    saved = store.read('saved')
    assert saved['service_preset_mode'] == 'auto'
    assert store.public('saved')['service_preset_mode'] == 'auto'
    absent = {key: value for key, value in saved.items() if key != 'service_preset_mode'}
    manual = {**saved, 'service_preset_mode': 'manual'}
    assert profile_digest(saved) == profile_digest(absent)
    assert public_profile_digest(saved) == public_profile_digest(absent)
    assert connection_fingerprint(saved, saved['base_url']) == connection_fingerprint(absent, absent['base_url'])
    assert profile_digest(manual) != profile_digest(saved)
    assert public_profile_digest(manual) != public_profile_digest(saved)
    assert connection_fingerprint(manual, manual['base_url']) != connection_fingerprint(saved, saved['base_url'])


@pytest.mark.parametrize('mode', [None, '', 'AUTO', 'muse', False, {}, []])
def test_invalid_detection_mode_cannot_be_saved_or_discovered(store, mode):
    store.save(draft(model='muse-image'), profile_id='saved')
    before = store.path.read_bytes()
    with pytest.raises(OpenAICompatibleError):
        store.save({'service_preset_mode': mode}, profile_id='saved')
    assert store.path.read_bytes() == before
    with pytest.raises(ConnectionDraftError):
        discover(store, draft(service_preset_mode=mode), muse_models())


def test_saved_key_is_used_only_for_unchanged_target_and_detection_does_not_rebind_it(store):
    store.save(draft(model='muse-image'), profile_id='saved')
    before = store.path.read_bytes()
    result, calls = discover(store, draft(profile_id='saved', api_key='', service_preset_mode='auto'), muse_models())
    assert result['detected_service_preset'] == 'muse'
    assert calls[0].headers['authorization'] == 'Bearer custom-synthetic-key'
    assert store.path.read_bytes() == before
    with pytest.raises(ConnectionDraftError, match='again'):
        discover(store, draft(profile_id='saved', api_key='', base_url='https://other.invalid',
            service_preset_mode='auto'), muse_models())
    assert store.path.read_bytes() == before


def test_late_discovery_cannot_override_a_new_manual_choice(store):
    store.save(draft(model='muse-image'), profile_id='saved')
    result, _ = discover(store, draft(profile_id='saved', api_key='', service_preset_mode='auto'), muse_models(),
        lambda request: store.save({'service_preset_mode': 'manual'}, profile_id='saved'))
    assert result['error_code'] == 'changed'
    assert result['connection_checked'] is False and not result.get('detected_service_preset')
    assert result['models'] == [] and result['fetched_at'] is None and result['checked_at'] is None
    assert store.read('saved')['service_preset_mode'] == 'manual'


@pytest.mark.parametrize('status', [401, 500])
def test_failed_discovery_never_uses_key_prefix_as_a_successful_detection(store, status):
    calls = []
    def respond(request):
        calls.append(request)
        return httpx.Response(status, json={'data': muse_models()})
    with httpx.Client(transport=httpx.MockTransport(respond)) as client:
        result = discover_connection_draft(store, draft(api_key='m2a_fixture'), client)
    assert len(calls) == 1 and result['error_code']
    assert not result.get('detected_service_preset')
    assert result['fetched_at'] is None and result['connection_checked'] is False


@pytest.mark.parametrize('protocol', ['gemini_native', 'seedream_native'])
def test_native_protocols_are_not_auto_converted_to_muse(store, protocol):
    calls = []
    def respond(request):
        calls.append(request)
        return httpx.Response(200, json={'models': [
            {'name': identity, 'owned_by': 'muse', 'supportedGenerationMethods': ['generateContent']}
            for identity in MODEL_IDS]})
    with httpx.Client(transport=httpx.MockTransport(respond)) as client:
        result = discover_connection_draft(store, draft(protocol=protocol, service_preset_mode='auto'), client)
    assert not result.get('detected_service_preset')
    assert len(calls) == (1 if protocol == 'gemini_native' else 0)
    if protocol == 'seedream_native':
        assert result['source'] == 'reference' and result['fetched_at'] is None
        assert result['connection_checked'] is False


@pytest.mark.parametrize('metadata', [False, True])
def test_only_allowlisted_owned_by_is_exposed_from_real_model_fetch(metadata):
    secret = 'fixture-secret-owner'
    entries = [
        {'id': 'owned', 'owned_by': 'muse'},
        {'id': 'unowned', 'owned_by': secret},
        {'id': 'upper', 'owned_by': 'Muse'},
        {'id': 'structured', 'owned_by': {'id': 'muse'}},
    ]
    with httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(200, json={'data': entries}))) as client:
        result = fetch_models('https://service.invalid/v1', secret, client, include_metadata=metadata)
    by_id = {entry['id']: entry for entry in result}
    if metadata:
        assert by_id['owned']['owned_by'] == 'muse'
    else:
        assert 'owned_by' not in by_id['owned']
    assert all('owned_by' not in by_id[name] for name in ('unowned', 'upper', 'structured'))
    assert secret not in json.dumps(result)
