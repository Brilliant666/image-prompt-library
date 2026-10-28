"""Model discovery uses synthetic transport only, without generation or paid calls."""
import json
from concurrent.futures import ThreadPoolExecutor
from threading import Event

import httpx
import pytest
from fastapi.testclient import TestClient

from backend.main import create_app
from backend.services import model_catalog
from backend.services import openai_compatible
from backend.services.model_catalog import ERRORS, ModelCatalogCache, empty_catalog
from backend.services.openai_compatible import OpenAICompatibleConfig, ModelCatalogProfileNotFound


@pytest.fixture(autouse=True)
def block_real_network(monkeypatch):
    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", lambda *args, **kwargs: pytest.fail("No real upstream calls"))


@pytest.fixture
def config(tmp_path, monkeypatch):
    path = tmp_path / "private" / "profiles.json"
    monkeypatch.setenv("IMAGE_PROMPT_LIBRARY_OPENAI_COMPATIBLE_CONFIG_PATH", str(path))
    store = OpenAICompatibleConfig(path, tmp_path / "library")
    store.save({"base_url": "https://models.invalid", "api_key": "private-fixture-key",
                "model": "manual/default", "models": ["manual/other"]}, profile_id="one")
    return store


def refresh(config, handler):
    calls = []
    def reply(request):
        calls.append(request)
        assert request.method == "GET" and request.url.path.endswith("/models")
        assert not request.content
        assert request.headers["authorization"] == "Bearer " + config.read("one")["api_key"]
        return handler(request)
    with httpx.Client(transport=httpx.MockTransport(reply), follow_redirects=True) as client:
        catalog = config.refresh_model_catalog("one", client)
    assert len(calls) == 1
    return catalog, calls


def success(config, ids=("discovered/first",)):
    return refresh(config, lambda request: httpx.Response(200, json={"data": [{"id": value} for value in ids]}))[0]


@pytest.mark.parametrize("url,mode,expected", [
    ("https://models.invalid", "versioned", "/v1/models"),
    ("https://models.invalid/proxy/v1/v1/", "versioned", "/proxy/v1/models"),
    ("https://models.invalid/custom/root/", "custom", "/custom/root/models"),
    ("https://models.invalid/", "custom", "/models"),
])
def test_one_get_uses_saved_url_mode_and_key_without_mutating_config(config, url, mode, expected):
    config.save({"base_url": url, "base_url_mode": mode}, profile_id="one")
    before = config.path.read_bytes()
    catalog, calls = refresh(config, lambda request: httpx.Response(200, json={"data": [{"id": "vendor/model@2026"}]}))
    assert calls[0].url.path == expected
    assert calls[0].extensions["timeout"] == {key: model_catalog.CATALOG_TIMEOUT for key in ("connect", "read", "write", "pool")}
    assert catalog["models"] == [{"id": "vendor/model@2026", "image_generation": None}]
    assert catalog["fetched_at"] == catalog["checked_at"] and catalog["error"] is None
    assert config.path.read_bytes() == before
    assert config.read("one")["model"] == "manual/default"
    assert config.read("one")["models"] == ["manual/other"]
    assert config.model_catalog("one") == catalog
    assert config.public("one")["model_catalog"] == catalog
    assert config.public_profiles()["profiles"][0]["model_catalog"] == catalog


def test_capabilities_require_explicit_output_metadata_and_keep_full_ids(config):
    entries = [
        {"id": "gpt-image-named-but-unknown"},
        {"id": "vision-only", "input_modalities": ["text", "image"]},
        {"id": "output-image", "output_modalities": ["image"]},
        {"id": "explicit-yes", "capabilities": {"image_generation": True}},
        {"id": "explicit-no", "capabilities": {"image_generation": False}},
        {"id": "text-only", "output_modalities": ["text"]},
        {"id": "nested-output", "capabilities": {"output_modalities": ["image"]}},
        {"id": "string-true", "capabilities": {"image_generation": "true"}},
        {"id": "conflict", "capabilities": {"image_generation": False}, "output_modalities": ["image"]},
        {"id": "full/vendor/model:2026-10-20", "owned_by": "private-fixture-key"},
        {"id": "output-image", "output_modalities": ["image"]},
        {"id": "duplicate-conflict", "capabilities": {"image_generation": True}},
        {"id": "duplicate-conflict", "capabilities": {"image_generation": False}},
    ]
    catalog, _ = refresh(config, lambda request: httpx.Response(200, json={"data": entries}))
    assert [model["id"] for model in catalog["models"]] == list(dict.fromkeys(entry["id"] for entry in entries))
    assert {model["id"]: model["image_generation"] for model in catalog["models"]} == {
        "gpt-image-named-but-unknown": None, "vision-only": None, "output-image": True,
        "explicit-yes": True, "explicit-no": False, "text-only": False, "nested-output": True,
        "string-true": None, "conflict": None, "full/vendor/model:2026-10-20": None,
        "duplicate-conflict": None,
    }
    assert "private-fixture-key" not in json.dumps(catalog)


@pytest.mark.parametrize("status,error", [(401, "permission"), (403, "permission"), (429, "http"), (500, "http"), (302, "http")])
def test_http_error_or_redirect_is_sanitized_and_keeps_same_connection_cache(config, status, error):
    previous = success(config)
    catalog, calls = refresh(config, lambda request: httpx.Response(status, text="private-fixture-key provider internal error",
                          headers={"location": "https://must-not-follow.invalid/secret"}))
    assert len(calls) == 1
    assert catalog["models"] == previous["models"]
    assert catalog["fetched_at"] == previous["fetched_at"]
    assert catalog["checked_at"] >= previous["checked_at"]
    assert catalog["error"] == ERRORS[error]
    assert config.model_catalog("one") == catalog
    assert "private-fixture-key" not in json.dumps(catalog)
    assert "must-not-follow" not in json.dumps(catalog)


@pytest.mark.parametrize("exception,error", [(httpx.ReadTimeout, "timeout"), (httpx.ConnectTimeout, "timeout"), (httpx.ConnectError, "connection")])
def test_network_error_never_exposes_exception_or_retries(config, exception, error):
    def fail(request):
        raise exception("private-fixture-key https://internal.invalid/private", request=request)
    catalog, _ = refresh(config, fail)
    assert catalog == {**empty_catalog(), "checked_at": catalog["checked_at"], "error": ERRORS[error]}
    assert catalog["checked_at"] is not None


@pytest.mark.parametrize("payload", [None, [], {}, {"data": None}, {"data": [{}]}, {"data": ["secret"]},
    {"data": [{"id": ""}]}, {"data": [{"id": " leading"}]}, {"data": [{"id": "bad\nvalue"}]},
    {"data": [{"id": "x" * 201}]}, {"data": [{"id": "private-fixture-key"}]}, {"data": [{"id": 7}]}])
def test_malformed_lists_are_not_partially_cached(config, payload):
    previous = success(config)
    catalog, _ = refresh(config, lambda request: httpx.Response(200, json=payload))
    assert catalog["error"] == ERRORS["invalid"]
    assert catalog["models"] == previous["models"]
    assert catalog["fetched_at"] == previous["fetched_at"]


@pytest.mark.parametrize("body", [b"not-json private-fixture-key", b"\xff", b"[" * 1500])
def test_malformed_body_is_fixed_error(config, body):
    catalog, _ = refresh(config, lambda request: httpx.Response(200, content=body))
    assert catalog["error"] == ERRORS["invalid"]
    assert "private-fixture-key" not in json.dumps(catalog)


def test_empty_list_retains_prior_success(config):
    previous = success(config)
    catalog, _ = refresh(config, lambda request: httpx.Response(200, json={"data": []}))
    assert catalog["error"] == ERRORS["empty"]
    assert catalog["models"] == previous["models"] and catalog["fetched_at"] == previous["fetched_at"]


class Chunks(httpx.SyncByteStream):
    def __init__(self, chunks):
        self.chunks = chunks
    def __iter__(self):
        yield from self.chunks


@pytest.mark.parametrize("kind", ["length", "stream", "count"])
def test_response_size_and_entry_count_are_bounded(config, monkeypatch, kind):
    if kind == "length":
        response = httpx.Response(200, headers={"content-length": str(model_catalog.MAX_CATALOG_BYTES + 1)}, stream=Chunks([b"{} "]))
    elif kind == "stream":
        monkeypatch.setattr(model_catalog, "MAX_CATALOG_BYTES", 40)
        response = httpx.Response(200, stream=Chunks([b"{" * 30, b"x" * 30]))
    else:
        response = httpx.Response(200, json={"data": [{"id": "duplicate"}] * (model_catalog.MAX_CATALOG_MODELS + 1)})
    catalog, _ = refresh(config, lambda request: response)
    assert catalog["error"] == ERRORS["limit"] and catalog["models"] == []


def test_slow_chunks_obey_elapsed_deadline(config, monkeypatch):
    clock = iter([0, 16])
    monkeypatch.setattr(model_catalog.time, "monotonic", lambda: next(clock))
    # A ready mock response avoids involving httpx's clock between our checks.
    response = httpx.Response(200, stream=Chunks([b'{"data":[{"id":"synthetic"}]}']))
    catalog, _ = refresh(config, lambda request: response)
    assert catalog["error"] == ERRORS["timeout"]


@pytest.mark.parametrize("change", [{"api_key": "replacement-fixture-key"}, {"base_url": "https://other.invalid"}, {"base_url_mode": "custom"}])
def test_connection_change_never_exposes_previous_provider_catalog(config, change):
    success(config)
    config.save(change, profile_id="one")
    assert config.model_catalog("one") == empty_catalog()
    assert config.public("one")["model_catalog"] == empty_catalog()
    catalog, _ = refresh(config, lambda request: httpx.Response(403, text="new key rejected"))
    assert catalog["models"] == [] and catalog["fetched_at"] is None


def test_profiles_are_isolated_and_other_setting_changes_keep_cache(config):
    previous = success(config)
    config.copy_profile("one", "two")
    assert config.model_catalog("two") == empty_catalog()
    config.save({"model": "new-manual-default", "models": ["another/manual"], "display_name": "Renamed"}, profile_id="one")
    config.set_default("two")
    config.reorder_profiles(["two", "one"])
    assert config.model_catalog("one") == previous
    assert config.model_catalog("two") == empty_catalog()


def test_missing_key_and_unknown_profile_never_use_network(config):
    config.save({"remove_api_key": True}, profile_id="one")
    assert config.refresh_model_catalog("one")["error"] == ERRORS["not_configured"]
    assert not ModelCatalogCache(config.path).path.exists()
    with pytest.raises(ModelCatalogProfileNotFound):
        config.refresh_model_catalog("absent")


def test_local_public_reads_never_write_or_connect_and_sidecar_contains_no_secrets(config):
    assert config.model_catalog("one") == empty_catalog()
    assert config.public("one")["model_catalog"] == empty_catalog()
    assert not ModelCatalogCache(config.path).path.exists()
    catalog = success(config)
    cache_path = ModelCatalogCache(config.path).path
    before = config.path.read_bytes(), cache_path.read_bytes()
    assert not cache_path.resolve().is_relative_to(config.library_path.resolve())
    assert "private-fixture-key" not in cache_path.read_text()
    assert "https://models.invalid" not in cache_path.read_text()
    assert config.status()["profiles"][0]["model_catalog"] == catalog
    assert config.model_catalog("one") == catalog
    assert before == (config.path.read_bytes(), cache_path.read_bytes())


def test_corrupt_cache_does_not_break_provider_config_or_leak_content(config):
    path = ModelCatalogCache(config.path).path
    path.write_text("private-fixture-key malformed", encoding="utf-8")
    assert config.public("one")["configured"] is True
    assert config.model_catalog("one")["error"] == ERRORS["cache"]
    assert "private-fixture-key" not in json.dumps(config.public_profiles())
    assert success(config)["error"] is None


@pytest.mark.parametrize("operation", ["key", "delete"])
def test_connection_change_or_delete_during_request_discards_response(config, operation):
    ready, release = Event(), Event()
    def delayed(request):
        ready.set()
        assert release.wait(5)
        return httpx.Response(200, json={"data": [{"id": "old-provider-result"}]})
    with ThreadPoolExecutor() as executor:
        pending = executor.submit(refresh, config, delayed)
        assert ready.wait(5)
        if operation == "key":
            config.save({"api_key": "changed-fixture-key"}, profile_id="one")
        else:
            config.delete("one")
        release.set()
        if operation == "delete":
            with pytest.raises(ModelCatalogProfileNotFound):
                pending.result(timeout=5)
        else:
            result, _ = pending.result(timeout=5)
            assert result["models"] == [] and result["error"] == ERRORS["changed"]
            assert config.model_catalog("one") == empty_catalog()
    assert not ModelCatalogCache(config.path).path.exists()


def test_concurrent_refresh_cannot_overwrite_newer_result(config):
    ready, release = Event(), Event()
    def delayed(request):
        ready.set()
        assert release.wait(5)
        return httpx.Response(200, json={"data": [{"id": "older-response"}]})
    with ThreadPoolExecutor() as executor:
        pending = executor.submit(refresh, config, delayed)
        assert ready.wait(5)
        fresh = success(config, ["newer-response"])
        release.set()
        old, _ = pending.result(timeout=5)
    assert old["error"] == ERRORS["superseded"] and old["models"] == fresh["models"]
    assert config.model_catalog("one") == fresh


def test_real_routes_use_only_saved_profile_and_get_is_local(config, monkeypatch):
    calls = []
    def reply(request):
        calls.append(request)
        assert str(request.url) == "https://models.invalid/v1/models"
        assert request.headers["authorization"] == "Bearer private-fixture-key"
        return httpx.Response(200, json={"data": [{"id": "route-model"}]})
    with httpx.Client(transport=httpx.MockTransport(reply)) as upstream:
        original = openai_compatible.fetch_models
        monkeypatch.setattr(openai_compatible, "fetch_models", lambda root, key, client=None, **kwargs: original(root, key, upstream, **kwargs))
        client = TestClient(create_app(library_path=config.library_path))
        root = "/api/generation-providers/openai-compatible/profiles"
        assert client.get(root + "/one/models").json() == empty_catalog()
        assert client.get(root).json()["profiles"][0]["model_catalog"] == empty_catalog()
        assert calls == []
        result = client.post(root + "/one/models/refresh", json={"base_url": "https://unsaved.invalid", "api_key": "must-not-use"})
        assert result.status_code == 200 and result.json()["error"] is None
        assert client.get(root + "/one/models").json() == result.json()
        assert len(calls) == 1 and calls[0].method == "GET"
        assert client.post(root + "/missing/models/refresh").status_code == 404
        assert client.get(root + "/missing/models").status_code == 404
        foreign = client.post(root + "/one/models/refresh", headers={"Origin": "https://foreign.invalid"})
        assert foreign.status_code == 403
        assert len(calls) == 1
        assert "private-fixture-key" not in result.text and "must-not-use" not in result.text
