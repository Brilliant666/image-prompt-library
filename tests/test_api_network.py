"""Connection policies exercised against local sockets; no provider/model calls."""
import base64
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import ssl
from threading import Thread

import certifi
import httpx
import pytest

from backend.services import api_network as network


@contextmanager
def endpoint():
    calls = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            body = self.rfile.read(int(self.headers.get("content-length", "0")))
            calls.append((self.path, dict(self.headers), body))
            self.send_response(200)
            self.send_header("Content-Length", "2")
            self.end_headers()
            self.wfile.write(b"ok")

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    worker = Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}", calls
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=2)


@pytest.fixture(autouse=True)
def no_system_proxy(monkeypatch):
    for key in ("http_proxy", "https_proxy", "all_proxy", "no_proxy",
                "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"):
        monkeypatch.delenv(key, raising=False)


@pytest.mark.parametrize("mode", ["direct", "environment", "proxy"])
def test_real_transport_routes_one_synthetic_post_to_selected_endpoint(monkeypatch, mode):
    with endpoint() as (origin, origin_calls), endpoint() as (proxy, proxy_calls):
        monkeypatch.setenv("HTTP_PROXY", proxy)
        monkeypatch.setenv("NO_PROXY", "")
        policy = {"network_mode": mode, "proxy_url": proxy}
        body = b"synthetic upload, no images or private prompts"
        with network.create_api_client(policy, timeout=3) as client:
            result = client.post(origin + "/upload", content=body)
        assert result.status_code == 200
        selected = origin_calls if mode == "direct" else proxy_calls
        assert len(selected) == 1 and selected[0][2] == body
        assert selected[0][0] == ("/upload" if mode == "direct" else origin + "/upload")
        assert not (proxy_calls if mode == "direct" else origin_calls)


def test_environment_respects_no_proxy_and_explicit_proxy_does_not(monkeypatch):
    with endpoint() as (origin, origin_calls), endpoint() as (proxy, proxy_calls):
        monkeypatch.setenv("HTTP_PROXY", proxy)
        monkeypatch.setenv("NO_PROXY", "127.0.0.1")
        with network.create_api_client({"network_mode": "environment"}, timeout=3) as client:
            client.post(origin + "/first", content=b"first")
        with network.create_api_client({"network_mode": "proxy", "proxy_url": proxy}, timeout=3) as client:
            client.post(origin + "/second", content=b"second")
        assert [call[2] for call in origin_calls] == [b"first"]
        assert [call[2] for call in proxy_calls] == [b"second"]


def test_proxy_credentials_only_sent_in_explicit_proxy_mode(monkeypatch):
    with endpoint() as (origin, origin_calls), endpoint() as (proxy, proxy_calls):
        credentialed = proxy.replace("://", "://sample-user:sample-pass@")
        monkeypatch.setenv("HTTP_PROXY", credentialed)
        with network.create_api_client({"network_mode": "direct", "proxy_url": credentialed}, timeout=3) as client:
            client.post(origin + "/direct", content=b"direct")
        with network.create_api_client({"network_mode": "proxy", "proxy_url": credentialed}, timeout=3) as client:
            client.post(origin + "/proxy", content=b"proxy")
        assert "proxy-authorization" not in {key.lower() for key in origin_calls[0][1]}
        authorization = {key.lower(): value for key, value in proxy_calls[0][1].items()}["proxy-authorization"]
        assert authorization == "Basic " + base64.b64encode(b"sample-user:sample-pass").decode()


@pytest.mark.parametrize("mode", ["direct", "proxy", "environment"])
def test_tls_stays_verified_and_custom_ca_remains_supported(monkeypatch, mode):
    monkeypatch.setenv("SSL_CERT_FILE", certifi.where())
    calls = []
    original = ssl.create_default_context

    def context(*args, **kwargs):
        calls.append(kwargs)
        value = original(*args, **kwargs)
        assert value.verify_mode == ssl.CERT_REQUIRED and value.check_hostname is True
        return value

    monkeypatch.setattr(ssl, "create_default_context", context)
    with network.create_api_client({"network_mode": mode, "proxy_url": "http://127.0.0.1:9"}, timeout=3):
        pass
    assert calls and all(item.get("cafile") == certifi.where() for item in calls)


@pytest.mark.parametrize("scheme", ["http", "https", "socks5", "socks5h"])
def test_proxy_transport_is_explicit_and_has_no_retries(scheme):
    transport = network.create_api_transport({"network_mode": "proxy", "proxy_url": scheme + "://127.0.0.1:9"})
    try:
        assert transport._pool._proxy_url.host == b"127.0.0.1"
        assert transport._pool._retries == 0
    finally:
        transport.close()


@pytest.mark.parametrize("value", ["ftp://user:secret@example.test:1", "http://example.test:0",
    "http://example.test:65536", "http://example.test/path", "http://example.test/?secret=x",
    "http://example.test/#secret", "http://example.test/\nsecret", "http://example.test\\secret",
    "http://user:中文@example.test", "not-a-proxy", 42])
def test_invalid_proxy_is_rejected_without_echo(value):
    with pytest.raises(network.ApiNetworkError) as caught:
        network.validate_network_settings({"network_mode": "proxy", "proxy_url": value})
    assert "secret" not in str(caught.value) and "example.test" not in str(caught.value)


def test_direct_source_is_bound_before_connect_and_budget_is_reduced(monkeypatch):
    calls, clock = [], [0.0]

    def route(url, *, timeout):
        assert url == "http://provider.example:443" and timeout == 3
        clock[0] += 1
        return "192.0.2.5"

    class Backend:
        def connect_tcp(self, host, port, **kwargs):
            calls.append((host, port, kwargs))
            return "stream"

    monkeypatch.setattr(network, "direct_local_address", route)
    monkeypatch.setattr(network.time, "monotonic", lambda: clock[0])
    assert network._DirectBackend(Backend()).connect_tcp("provider.example", 443, timeout=3) == "stream"
    assert calls == [("provider.example", 443, {"timeout": 2, "local_address": "192.0.2.5", "socket_options": None})]


def test_expired_route_selection_never_opens_socket(monkeypatch):
    clock = [0.0]

    def route(url, **kwargs):
        clock[0] = 5
        return "192.0.2.5"

    class Backend:
        def connect_tcp(self, *args, **kwargs):
            pytest.fail("Expired route must not open a connection")

    monkeypatch.setattr(network, "direct_local_address", route)
    monkeypatch.setattr(network.time, "monotonic", lambda: clock[0])
    with pytest.raises(network.ApiNetworkError, match="timed out"):
        network._DirectBackend(Backend()).connect_tcp("provider.example", 443, timeout=3)


def test_route_failure_does_not_fallback_to_environment_or_replay(monkeypatch):
    attempts = []

    def route(url, **kwargs):
        attempts.append(url)
        raise network.DirectRouteError("无法确认直连出口")

    monkeypatch.setattr(network, "direct_local_address", route)
    with endpoint() as (origin, calls):
        monkeypatch.setenv("HTTP_PROXY", origin)
        with network.create_api_client({}, timeout=3) as client:
            with pytest.raises(network.ApiNetworkError, match="无法确认"):
                client.post(origin + "/upload", content=b"synthetic")
        assert not calls and len(attempts) == 1


def test_environment_transport_matches_original_hostname_before_dns_pinning(monkeypatch):
    monkeypatch.setenv("HTTPS_PROXY", "http://127.0.0.1:9876")
    monkeypatch.setenv("NO_PROXY", ".excluded.example")
    policy = {"network_mode": "environment"}
    proxied = network.create_api_transport(policy, "https://cdn.example/picture")
    excluded = network.create_api_transport(policy, "https://cdn.excluded.example/picture")
    try:
        assert proxied._pool._proxy_url.port == 9876
        assert not hasattr(excluded._pool, "_proxy_url")
    finally:
        proxied.close()
        excluded.close()
