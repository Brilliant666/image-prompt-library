"""Offline regressions for untrusted, signed image-result URLs."""

import socket

import httpx
import pytest

from backend.services import image_download as download

SYSTEM_GETADDRINFO = socket.getaddrinfo


@pytest.fixture(autouse=True)
def public_dns(monkeypatch):
    monkeypatch.setattr(download.socket, "getaddrinfo", lambda *args, **kwargs: [
        (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443))
    ])


def test_pins_public_address_preserves_host_sni_and_omits_credentials():
    requests = []

    def handle(request):
        requests.append(request)
        return httpx.Response(200, content=b"image bytes")

    with httpx.Client(transport=httpx.MockTransport(handle),
                      auth=("private", "password"),
                      headers={"Authorization": "Bearer do-not-send"},
                      cookies={"session": "do-not-send"}) as client:
        assert download.download_image("https://cdn.example.invalid/result.png?sig=secret", 30, client) == b"image bytes"
    assert len(requests) == 1
    request = requests[0]
    assert request.method == "GET"
    assert request.url.host == "93.184.216.34"
    assert request.url.path == "/result.png"
    assert request.url.query == b"sig=secret"
    assert request.headers["Host"] == "cdn.example.invalid"
    assert request.extensions["sni_hostname"] == "cdn.example.invalid"
    assert 0 < request.extensions["timeout"]["read"] <= 30
    assert "authorization" not in request.headers
    assert "cookie" not in request.headers


def test_each_redirect_resolves_and_pins_target(monkeypatch):
    resolved = []
    requests = []

    def resolve(host, port, **kwargs):
        resolved.append(host)
        ip = "93.184.216.34" if len(resolved) == 1 else "8.8.8.8"
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, port))]

    def handle(request):
        requests.append(request)
        if len(requests) == 1:
            return httpx.Response(302, headers={"Location": "https://images.example.invalid/final.png"})
        return httpx.Response(200, content=b"result")

    monkeypatch.setattr(download.socket, "getaddrinfo", resolve)
    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        assert download.download_image("https://cdn.example.invalid/image", 30, client) == b"result"
    assert resolved == ["cdn.example.invalid", "images.example.invalid"]
    assert [r.url.host for r in requests] == ["93.184.216.34", "8.8.8.8"]
    assert requests[1].headers["Host"] == "images.example.invalid"
    assert requests[1].extensions["sni_hostname"] == "images.example.invalid"


@pytest.mark.parametrize("private_ip", ["127.0.0.1", "10.0.0.1", "169.254.169.254", "::1"])
def test_redirect_to_private_target_is_rejected_before_send(monkeypatch, private_ip):
    requests = []

    def resolve(host, port, **kwargs):
        ip = "93.184.216.34" if host == "cdn.example.invalid" else private_ip
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, port))]

    def handle(request):
        requests.append(request)
        return httpx.Response(302, headers={"Location": "https://private.example.invalid/?signature=private-secret"})

    monkeypatch.setattr(download.socket, "getaddrinfo", resolve)
    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        with pytest.raises(download.ImageDownloadError) as error:
            download.download_image("https://cdn.example.invalid/image", 30, client)
    assert error.value.category == "image_url_blocked"
    assert len(requests) == 1
    assert "private-secret" not in str(error.value)


@pytest.mark.parametrize("url", ["file:///etc/passwd", "https://user:password@example.invalid/image", "https://example.invalid:8443/image"])
def test_disallowed_urls_are_never_sent(url):
    requests = []
    with httpx.Client(transport=httpx.MockTransport(lambda request: requests.append(request))) as client:
        with pytest.raises(download.ImageDownloadError) as error:
            download.download_image(url, 30, client)
    assert error.value.category == "image_url_blocked"
    assert requests == []


@pytest.mark.parametrize("headers,body", [({"Content-Length": "9"}, b""), ({}, b"123456789")])
def test_declared_and_streamed_size_limits(monkeypatch, headers, body):
    monkeypatch.setattr(download, "MAX_IMAGE_BYTES", 8)
    requests = []

    def handle(request):
        requests.append(request)
        return httpx.Response(200, headers=headers, stream=httpx.ByteStream(body))

    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        with pytest.raises(download.ImageDownloadError) as error:
            download.download_image("https://cdn.example.invalid/image", 30, client)
    assert error.value.category == "image_too_large"
    assert len(requests) == 1


@pytest.mark.parametrize("failure,category", [
    (httpx.ReadTimeout, "image_download_timeout"),
    (httpx.ConnectError, "image_download_failed"),
])
def test_transport_failures_are_redacted_without_retry(failure, category):
    requests = []
    signed_url = "https://cdn.example.invalid/image?signature=sensitive-token"

    def handle(request):
        requests.append(request)
        raise failure(f"failed downloading {signed_url}", request=request)

    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        with pytest.raises(download.ImageDownloadError) as error:
            download.download_image(signed_url, 30, client)
    assert error.value.category == category
    assert "sensitive-token" not in str(error.value)
    assert "cdn.example.invalid" not in str(error.value)
    assert len(requests) == 1


def test_http_failure_has_status_without_response_secrets_or_retry():
    requests = []

    def handle(request):
        requests.append(request)
        return httpx.Response(503, text="secret response body", headers={"Retry-After": "0"})

    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        with pytest.raises(download.ImageDownloadError) as error:
            download.download_image("https://cdn.example.invalid/image?sig=secret-query", 30, client)
    assert error.value.category == "image_download_http"
    assert "503" in str(error.value)
    assert "secret" not in str(error.value)
    assert len(requests) == 1


def test_total_deadline_stops_before_download(monkeypatch):
    ticks = iter([0, 31])
    monkeypatch.setattr(download.time, "monotonic", lambda: next(ticks))
    requests = []
    with httpx.Client(transport=httpx.MockTransport(lambda request: requests.append(request))) as client:
        with pytest.raises(download.ImageDownloadError) as error:
            download.download_image("https://cdn.example.invalid/image", 30, client)
    assert error.value.category == "image_download_timeout"
    assert requests == []


def test_deadline_checked_while_reading_body(monkeypatch):
    ticks = iter([0, 1, 31])
    monkeypatch.setattr(download.time, "monotonic", lambda: next(ticks))
    with httpx.Client(transport=httpx.MockTransport(
        lambda request: httpx.Response(200, stream=httpx.ByteStream(b"image"))
    )) as client:
        with pytest.raises(download.ImageDownloadError) as error:
            download.download_image("https://cdn.example.invalid/image", 30, client)
    assert error.value.category == "image_download_timeout"


def test_mixed_public_private_dns_answers_fail_closed(monkeypatch):
    monkeypatch.setattr(download.socket, "getaddrinfo", lambda *args, **kwargs: [
        (socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, 443))
        for ip in ("93.184.216.34", "127.0.0.1")
    ])
    requests = []
    with httpx.Client(transport=httpx.MockTransport(lambda request: requests.append(request))) as client:
        with pytest.raises(download.ImageDownloadError) as error:
            download.download_image("https://cdn.example.invalid/image", 30, client)
    assert error.value.category == "image_url_blocked"
    assert requests == []


@pytest.mark.parametrize("location,category,expected_requests", [
    ("http://cdn.example.invalid/image", "image_url_blocked", 1),
    ("/again", "image_redirect", 4),
    (None, "image_redirect", 1),
])
def test_redirect_policy(location, category, expected_requests):
    requests = []

    def handle(request):
        requests.append(request)
        return httpx.Response(302, headers={"Location": location} if location else {})

    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        with pytest.raises(download.ImageDownloadError) as error:
            download.download_image("https://cdn.example.invalid/image", 30, client)
    assert error.value.category == category
    assert len(requests) == expected_requests


def test_dns_wait_is_bounded(monkeypatch):
    from threading import Event
    release = Event()
    def slow_dns(*args, **kwargs):
        release.wait(2)
        return []
    monkeypatch.setattr(download.socket, "getaddrinfo", slow_dns)
    try:
        with pytest.raises(download.ImageDownloadError) as caught:
            download._resolve("cdn.example.invalid", 443, 0.01)
        assert caught.value.category == "image_download_timeout"
    finally:
        release.set()


@pytest.mark.parametrize("ip", ["198.18.0.10", "198.18.255.254", "2001:2::a", "2001:2::ffff"])
def test_explicit_fake_ip_mode_supports_rotating_addresses(monkeypatch, ip):
    monkeypatch.setenv(download.FAKE_IP_ENV, "198.18.0.0/16,2001:2::/64")
    monkeypatch.setattr(download.socket, "getaddrinfo", lambda *a, **kw: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip,443))])
    seen=[]
    def handle(request):
        seen.append(request)
        return httpx.Response(200,content=b"image")
    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        assert download.download_image("https://cdn.example.invalid/img",30,client)==b"image"
    assert seen[0].url.host == ip
    assert seen[0].headers['host']=='cdn.example.invalid'
    assert seen[0].extensions['sni_hostname']=='cdn.example.invalid'


@pytest.mark.parametrize("url,ip", [("https://198.18.0.10/image","198.18.0.10"),("http://cdn.example.invalid/image","198.18.0.10"),("https://cdn.example.invalid/image","127.0.0.1"),("https://cdn.example.invalid/image","192.168.1.1"),("https://cdn.example.invalid/image","169.254.169.254"),("https://cdn.example.invalid/image","198.19.0.1")])
def test_fake_ip_opt_in_does_not_open_other_targets(monkeypatch,url,ip):
    monkeypatch.setenv(download.FAKE_IP_ENV,"198.18.0.0/16,2001:2::/64")
    monkeypatch.setattr(download.socket,"getaddrinfo",lambda *a,**kw:[(socket.AF_INET,socket.SOCK_STREAM,6,"",(ip,443))])
    with pytest.raises(download.ImageDownloadError) as e: download._public_target(url)
    assert e.value.category=='image_url_blocked'


@pytest.mark.parametrize("value", ["0.0.0.0/0","192.168.0.0/16","::/0","bad"])
def test_fake_ip_configuration_cannot_allow_arbitrary_private_ranges(monkeypatch,value):
    monkeypatch.setenv(download.FAKE_IP_ENV,value)
    with pytest.raises(download.ImageDownloadError) as e: download._public_target("https://cdn.example.invalid/x")
    assert e.value.category=='image_proxy_config'


def test_fake_ip_is_blocked_by_default(monkeypatch):
    monkeypatch.delenv(download.FAKE_IP_ENV,raising=False)
    monkeypatch.setattr(download.socket,"getaddrinfo",lambda *a,**kw:[(socket.AF_INET,socket.SOCK_STREAM,6,"",("198.18.0.10",443))])
    with pytest.raises(download.ImageDownloadError) as e: download._public_target("https://cdn.example.invalid/x")
    assert e.value.category=='image_url_blocked'


def test_tiny_stream_chunks_do_not_hide_deadline(monkeypatch):
    now = [0.0]
    yielded = []
    monkeypatch.setattr(download.time, "monotonic", lambda: now[0])

    class SlowChunks(httpx.SyncByteStream):
        def __iter__(self):
            for _ in range(20):
                now[0] += 1
                yielded.append(1)
                yield b"x"

    with httpx.Client(transport=httpx.MockTransport(
        lambda request: httpx.Response(200, stream=SlowChunks())
    )) as client:
        with pytest.raises(download.ImageDownloadError) as error:
            download.download_image("https://cdn.example.invalid/image", 3, client)
    assert error.value.category == "image_download_timeout"
    assert len(yielded) == 4


@pytest.mark.parametrize("phase", ["headers", "body", "stalled_body"])
def test_real_socket_total_deadline_bounds_slow_response(monkeypatch, phase):
    """A peer sending within each read timeout must not reset the total budget."""
    import time
    from threading import Event, Thread

    finished = Event()
    accepted = Event()
    monkeypatch.setattr(socket, "getaddrinfo", SYSTEM_GETADDRINFO)
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    port = listener.getsockname()[1]

    def serve():
        try:
            connection, _ = listener.accept()
            accepted.set()
            with connection:
                connection.recv(4096)
                if phase == "headers":
                    chunks = [bytes([byte]) for byte in b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n"]
                else:
                    connection.sendall(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n")
                    chunks = [b"x"] * 100
                for chunk in chunks:
                    if finished.wait(0.04):
                        return
                    connection.sendall(chunk)
                    if phase == "stalled_body":
                        finished.wait(2)
                        return
        except OSError:
            pass

    # This isolated test bypasses address validation only for its own local peer.
    url = httpx.URL(f"http://127.0.0.1:{port}/image")
    monkeypatch.setattr(download, "_public_target", lambda *args: (url, url, "127.0.0.1"))
    worker = Thread(target=serve, daemon=True)
    worker.start()
    started = time.monotonic()
    try:
        with pytest.raises(download.ImageDownloadError) as error:
            download.download_image("https://cdn.example.invalid/image", 0.25)
        elapsed = time.monotonic() - started
        assert error.value.category == "image_download_timeout"
        assert accepted.is_set()
        assert elapsed < 0.9
    finally:
        finished.set()
        listener.close()
        worker.join(2)
