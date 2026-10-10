"""Bounded, credential-free downloads of public image results."""
import ipaddress
import os
import socket
import time
from queue import Queue, Empty
from threading import BoundedSemaphore, Thread
from urllib.parse import urljoin

import httpx
import httpcore

MAX_IMAGE_BYTES = 32 * 1024 * 1024
_dns_slots = BoundedSemaphore(4)
FAKE_IP_ENV = "IMAGE_PROMPT_LIBRARY_IMAGE_FAKE_IP_CIDRS"
_FAKE_IP_BOUNDS = (ipaddress.ip_network("198.18.0.0/15"), ipaddress.ip_network("2001:2::/48"))


def _fake_ip_networks():
    """Explicit local proxy opt-in, never an arbitrary private-network allowlist."""
    raw = os.environ.get(FAKE_IP_ENV, "").strip()
    if not raw:
        return ()
    try:
        networks = tuple(ipaddress.ip_network(value.strip(), strict=False) for value in raw.split(","))
        if not networks or any(not any(net.version == bound.version and net.subnet_of(bound) for bound in _FAKE_IP_BOUNDS) for net in networks):
            raise ValueError()
        return networks
    except ValueError:
        raise ImageDownloadError("image_proxy_config", "Fake-IP configuration must contain only benchmark-range subnets used by the local proxy") from None


class ImageDownloadError(ValueError):
    def __init__(self, category, message):
        super().__init__(message)
        self.category = category


def _remaining_timeout(deadline, timeout=None):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise ImageDownloadError("image_download_timeout", "Image download timed out")
    return min(remaining, timeout) if timeout is not None else remaining


class _DeadlineStream(httpcore.NetworkStream):
    """Recalculate the budget for every socket read, including HTTP headers."""
    def __init__(self, stream, deadline):
        self.stream, self.deadline = stream, deadline

    def read(self, max_bytes, timeout=None):
        return self.stream.read(max_bytes, timeout=_remaining_timeout(self.deadline, timeout))

    def write(self, buffer, timeout=None):
        return self.stream.write(buffer, timeout=_remaining_timeout(self.deadline, timeout))

    def start_tls(self, ssl_context, server_hostname=None, timeout=None):
        stream = self.stream.start_tls(ssl_context, server_hostname=server_hostname,
                                       timeout=_remaining_timeout(self.deadline, timeout))
        return _DeadlineStream(stream, self.deadline)

    def close(self):
        self.stream.close()

    def get_extra_info(self, info):
        return self.stream.get_extra_info(info)


class _DeadlineBackend(httpcore.SyncBackend):
    def __init__(self, deadline):
        self.deadline = deadline

    def connect_tcp(self, host, port, timeout=None, local_address=None, socket_options=None):
        stream = super().connect_tcp(host, port, timeout=_remaining_timeout(self.deadline, timeout),
                                     local_address=local_address, socket_options=socket_options)
        return _DeadlineStream(stream, self.deadline)


def _download_client(deadline):
    transport = httpx.HTTPTransport(retries=0)
    # HTTPX exposes no network_backend argument. Keep this integration in one
    # place and exercise it with a real local socket in the regression suite.
    transport._pool._network_backend = _DeadlineBackend(deadline)
    return httpx.Client(trust_env=False, follow_redirects=False, transport=transport)


def _resolve(host, port, timeout):
    # System DNS cannot be cancelled. Bound both the wait and outstanding workers.
    if not _dns_slots.acquire(blocking=False):
        raise ImageDownloadError("image_download_timeout", "Image DNS resolver is busy")
    result = Queue(maxsize=1)
    def worker():
        try:
            result.put(socket.getaddrinfo(host, port, type=socket.SOCK_STREAM))
        except Exception:
            result.put(None)
        finally:
            _dns_slots.release()
    Thread(target=worker, daemon=True).start()
    try:
        addresses = result.get(timeout=max(0, min(timeout, 10)))
    except Empty:
        raise ImageDownloadError("image_download_timeout", "Image DNS lookup timed out") from None
    if addresses is None:
        raise ImageDownloadError("image_download_failed", "Image DNS lookup failed")
    return addresses


def _public_target(raw, timeout=10):
    try:
        url = httpx.URL(raw)
        if url.scheme not in ("https", "http") or not url.host or url.userinfo or url.port not in (None, 80, 443):
            raise ValueError()
        addresses = _resolve(url.host, url.port or (443 if url.scheme == "https" else 80), timeout)
        ips = [ipaddress.ip_address(entry[4][0]) for entry in addresses]
        networks = _fake_ip_networks()
        try:
            ipaddress.ip_address(url.host)
            domain_name = False
        except ValueError:
            domain_name = True
        def permitted(ip):
            return ip.is_global or (domain_name and url.scheme == "https" and any(ip in net for net in networks))
        if not ips or any(not permitted(ip) for ip in ips):
            raise ValueError()
        # Pin the validated address: a second DNS lookup must not reach a private host.
        return url, url.copy_with(host=str(ips[0])), url.host
    except ImageDownloadError:
        raise
    except Exception:
        raise ImageDownloadError("image_url_blocked", "Image URL requires a public address or explicitly configured HTTPS domain Fake-IP range; private addresses and nonstandard ports are blocked") from None


def download_image(raw_url, timeout, client=None):
    deadline = time.monotonic() + min(timeout, 120)
    owned = client is None
    client = client or _download_client(deadline)
    try:
        for hop in range(4):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ImageDownloadError("image_download_timeout", "Image download timed out")
            url, pinned, hostname = _public_target(raw_url, remaining)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ImageDownloadError("image_download_timeout", "Image download timed out")
            # Never reuse the API client, its authorization, cookies or proxy settings.
            request = httpx.Request("GET", pinned, headers={"Host": url.netloc.decode(), "Accept": "image/*"},
                                    extensions={"sni_hostname": hostname, "timeout": dict.fromkeys(("connect", "read", "write", "pool"), remaining)})
            response = client.send(request, stream=True, follow_redirects=False, auth=None)
            try:
                if response.status_code in (301, 302, 303, 307, 308):
                    location = response.headers.get("location")
                    if not location or hop == 3:
                        raise ImageDownloadError("image_redirect", "Image download exceeded redirect limit or received no redirect location")
                    raw_url = urljoin(str(url), location)
                    if url.scheme == "https" and httpx.URL(raw_url).scheme != "https":
                        raise ImageDownloadError("image_url_blocked", "Image redirect cannot downgrade HTTPS")
                    continue
                if response.status_code != 200:
                    raise ImageDownloadError("image_download_http", f"Image download returned HTTP {response.status_code}; generation was not resubmitted")
                length = response.headers.get("content-length", "")
                if length.isdigit() and int(length) > MAX_IMAGE_BYTES:
                    raise ImageDownloadError("image_too_large", "Image exceeds the 32 MiB download limit")
                data = bytearray()
                for chunk in response.iter_bytes():
                    if time.monotonic() > deadline:
                        raise ImageDownloadError("image_download_timeout", "Image download timed out")
                    data.extend(chunk)
                    if len(data) > MAX_IMAGE_BYTES:
                        raise ImageDownloadError("image_too_large", "Image exceeds the 32 MiB download limit")
                return bytes(data)
            finally:
                response.close()
    except ImageDownloadError:
        raise
    except httpx.TimeoutException:
        raise ImageDownloadError("image_download_timeout", "Image download timed out; generation was not resubmitted") from None
    except Exception:
        raise ImageDownloadError("image_download_failed", "Image download failed; generation was not resubmitted") from None
    finally:
        if owned:
            client.close()
