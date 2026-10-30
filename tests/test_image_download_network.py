"""API-network downloads retain public-target pinning and credential isolation."""

import socket

import httpcore
import httpx
import pytest

from backend.services import image_download as download


class RecordingStream(httpcore.NetworkStream):
    def __init__(self, responses):
        self.responses = list(responses)
        self.writes = []
        self.tls_names = []
        self.timeouts = []
        self.closed = False

    def read(self, max_bytes, timeout=None):
        self.timeouts.append(timeout)
        return self.responses.pop(0) if self.responses else b""

    def write(self, buffer, timeout=None):
        self.writes.append(buffer)
        self.timeouts.append(timeout)

    def start_tls(self, ssl_context, server_hostname=None, timeout=None):
        self.tls_names.append(server_hostname)
        self.timeouts.append(timeout)
        assert ssl_context.check_hostname
        return self

    def close(self):
        self.closed = True

    def get_extra_info(self, info):
        return None


class RecordingBackend(httpcore.NetworkBackend):
    def __init__(self, stream):
        self.stream = stream
        self.connections = []

    def connect_tcp(self, host, port, timeout=None, local_address=None, socket_options=None):
        self.connections.append((host, port, timeout, local_address, socket_options))
        return self.stream


@pytest.fixture(autouse=True)
def public_dns(monkeypatch):
    monkeypatch.setattr(download.socket, "getaddrinfo", lambda host, port, **kwargs: [
        (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", port)),
    ])


def install_recording_transport(monkeypatch, response_sets):
    from backend.services import api_network
    original = api_network.create_api_transport
    created = []

    def factory(settings, url=None):
        transport = original(settings, url=url)
        stream = RecordingStream(response_sets[len(created)])
        backend = RecordingBackend(stream)
        transport._pool._network_backend = backend
        created.append((httpx.URL(url), transport, backend, stream))
        return transport

    monkeypatch.setattr(api_network, "create_api_transport", factory)
    return created


OK = b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nimage"
CONNECTED = b"HTTP/1.1 200 Connection established\r\n\r\n"


@pytest.mark.parametrize("origin_scheme", ["http", "https"])
@pytest.mark.parametrize("proxy_scheme", ["http", "https"])
def test_proxy_uses_pinned_destination_and_correct_tls_names(monkeypatch, origin_scheme, proxy_scheme):
    responses = [CONNECTED, OK] if origin_scheme == "https" else [OK]
    created = install_recording_transport(monkeypatch, [responses])
    settings = {"network_mode": "proxy", "proxy_url": f"{proxy_scheme}://proxy-user:proxy-pass@proxy.example.invalid:8080",
                "api_key": "private-api-key"}
    assert download.download_image(f"{origin_scheme}://cdn.example.invalid/image?sig=private", 30,
                                   network_settings=settings) == b"image"
    original_url, transport, backend, stream = created[0]
    assert original_url.host == "cdn.example.invalid"
    assert transport._pool._network_backend.delegate is backend
    assert backend.connections[0][:2] == ("proxy.example.invalid", 8080)
    expected_tls = (["proxy.example.invalid"] if proxy_scheme == "https" else [])
    expected_tls += (["cdn.example.invalid"] if origin_scheme == "https" else [])
    assert stream.tls_names == expected_tls
    wire = b"".join(stream.writes)
    assert b"private-api-key" not in wire
    assert b"Cookie:" not in wire
    assert b"Host: cdn.example.invalid\r\n" in wire
    if origin_scheme == "https":
        assert wire.startswith(b"CONNECT 93.184.216.34:443 HTTP/1.1\r\n")
        connect, get = wire.split(b"\r\n\r\n", 1)
        assert b"Proxy-Authorization: Basic " in connect
        assert b"Proxy-Authorization" not in get
        assert get.startswith(b"GET /image?sig=private HTTP/1.1\r\n")
    else:
        assert wire.startswith(b"GET http://93.184.216.34/image?sig=private HTTP/1.1\r\n")
    assert all(value is not None and 0 < value <= 30 for value in stream.timeouts)
    assert stream.closed


@pytest.mark.parametrize("scheme", ["socks5", "socks5h"])
def test_socks_uses_pinned_ip_and_bounds_handshake_io_without_timeout(monkeypatch, scheme):
    responses = [b"\x05\x02", b"\x01\x00", b"\x05\x00\x00\x01\x00\x00\x00\x00\x00\x00", OK]
    created = install_recording_transport(monkeypatch, [responses])
    assert download.download_image("https://cdn.example.invalid/image", 30, network_settings={
        "network_mode": "proxy", "proxy_url": f"{scheme}://proxy-user:proxy-pass@proxy.example.invalid:1080",
    }) == b"image"
    _, transport, backend, stream = created[0]
    assert transport._pool._network_backend.delegate is backend
    assert backend.connections[0][:2] == ("proxy.example.invalid", 1080)
    wire = b"".join(stream.writes)
    assert b"\x05\x01\x00\x01" + socket.inet_aton("93.184.216.34") + b"\x01\xbb" in wire
    get = wire[wire.index(b"GET "):]
    assert b"proxy-user" not in get and b"proxy-pass" not in get
    assert b"Authorization" not in get
    assert b"Host: cdn.example.invalid\r\n" in get
    assert stream.tls_names == ["cdn.example.invalid"]
    # httpcore's SOCKS negotiation uses read/write(timeout=None). The delegate
    # must still receive the remaining total download deadline on every call.
    assert all(value is not None and 0 < value <= 30 for value in stream.timeouts)
    assert stream.closed


def test_environment_no_proxy_recomputed_from_original_hostname_each_hop(monkeypatch):
    for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("HTTPS_PROXY", "http://proxy-user:proxy-pass@proxy.example.invalid:8080")
    monkeypatch.setenv("NO_PROXY", "images.example.invalid")
    redirect = (b"HTTP/1.1 302 Found\r\nContent-Length: 0\r\n"
                b"Location: https://images.example.invalid/final\r\nSet-Cookie: private=must-not-forward\r\n\r\n")
    created = install_recording_transport(monkeypatch, [[CONNECTED, redirect], [OK]])
    assert download.download_image("https://cdn.example.invalid/image", 30,
                                   network_settings={"network_mode": "environment"}) == b"image"
    assert [row[0].host for row in created] == ["cdn.example.invalid", "images.example.invalid"]
    assert [row[2].connections[0][0] for row in created] == ["proxy.example.invalid", "93.184.216.34"]
    second_wire = b"".join(created[1][3].writes)
    assert b"Host: images.example.invalid\r\n" in second_wire
    assert b"Authorization" not in second_wire
    assert b"Cookie" not in second_wire
    assert created[1][3].tls_names == ["images.example.invalid"]
    assert all(row[3].closed for row in created)


@pytest.mark.parametrize("blocked_ip", ["127.0.0.1", "169.254.169.254", "::1"])
def test_proxy_redirect_does_not_delegate_private_target_resolution(monkeypatch, blocked_ip):
    monkeypatch.setattr(download.socket, "getaddrinfo", lambda host, port, **kwargs: [
        (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34" if host == "cdn.example.invalid" else blocked_ip, port)),
    ])
    redirect = (b"HTTP/1.1 302 Found\r\nContent-Length: 0\r\n"
                b"Location: https://private.example.invalid/image\r\n\r\n")
    created = install_recording_transport(monkeypatch, [[CONNECTED, redirect]])
    with pytest.raises(download.ImageDownloadError) as caught:
        download.download_image("https://cdn.example.invalid/image", 30, network_settings={
            "network_mode": "proxy", "proxy_url": "http://proxy.example.invalid:8080",
        })
    assert caught.value.category == "image_url_blocked"
    assert len(created) == 1
    assert created[0][3].closed


def test_direct_download_keeps_selected_backend_and_original_host(monkeypatch):
    created = install_recording_transport(monkeypatch, [[OK]])
    assert download.download_image("https://cdn.example.invalid/image", 30,
                                   network_settings={"network_mode": "direct"}) == b"image"
    _, transport, backend, stream = created[0]
    assert transport._pool._network_backend.delegate is backend
    assert backend.connections[0][:2] == ("93.184.216.34", 443)
    assert stream.tls_names == ["cdn.example.invalid"]
    assert b"Authorization" not in b"".join(stream.writes)


def test_no_network_settings_keeps_legacy_factory(monkeypatch):
    from backend.services import api_network
    monkeypatch.setattr(api_network, "create_api_transport", lambda *a, **kw: pytest.fail("Legacy download used API network policy"))
    with download._download_client(download.time.monotonic() + 30) as client:
        assert client._trust_env is False
        assert isinstance(client._transport._pool._network_backend.delegate, httpcore.SyncBackend)


def test_explicit_download_client_remains_credential_free_test_injection():
    seen = []
    with httpx.Client(transport=httpx.MockTransport(lambda request: seen.append(request) or httpx.Response(200, content=b"image")),
                      auth=("private", "password"), headers={"Authorization": "Bearer private"},
                      cookies={"private": "cookie"}) as client:
        assert download.download_image("https://cdn.example.invalid/image", 30, client,
                                       network_settings={"network_mode": "direct"}) == b"image"
    assert "authorization" not in seen[0].headers
    assert "cookie" not in seen[0].headers
