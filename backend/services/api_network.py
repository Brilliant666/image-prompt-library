"""Per-API connection policy. No route changes, credential logging or POST retries."""
from __future__ import annotations

from urllib.parse import urlsplit, urlunsplit
import time

import httpx
from httpx._utils import URLPattern, get_environment_proxies

from backend.services.api_direct_route import DirectRouteError, direct_local_address


class ApiNetworkError(ValueError):
    """Only fixed, credential-free messages may cross this boundary."""
    def __init__(self, message):
        self.message = message
        super().__init__(message)


NETWORK_DEFAULTS = {"network_mode": "direct", "proxy_url": ""}


def validate_network_settings(settings):
    mode = settings.get("network_mode", "direct")
    proxy = settings.get("proxy_url", "")
    if mode not in ("direct", "environment", "proxy"):
        raise ApiNetworkError("Choose direct, environment or proxy for the API connection.")
    if not isinstance(proxy, str) or len(proxy) > 2048:
        raise ApiNetworkError("Enter a valid HTTP(S) or SOCKS5 proxy address.")
    proxy = proxy.strip()
    if proxy:
        try:
            parts = urlsplit(proxy)
            if (parts.scheme not in ("http", "https", "socks5", "socks5h")
                    or not parts.hostname or parts.path not in ("", "/")
                    or parts.query or parts.fragment or "\\" in proxy
                    or any(ord(c) < 33 or ord(c) > 126 for c in proxy)
                    or parts.port is not None and not 1 <= parts.port <= 65535):
                raise ValueError()
        except ValueError:
            raise ApiNetworkError("Enter a valid HTTP(S) or SOCKS5 proxy address without a path or query.") from None
    if mode == "proxy" and not proxy:
        raise ApiNetworkError("Enter a proxy address before using the proxy connection mode.")
    return {"network_mode": mode, "proxy_url": proxy}


def update_network_settings(current, payload):
    candidate = {key: current.get(key, default) for key, default in NETWORK_DEFAULTS.items()}
    if "network_mode" in payload:
        candidate["network_mode"] = payload["network_mode"]
    if "remove_proxy_url" in payload and type(payload["remove_proxy_url"]) is not bool:
        raise ApiNetworkError("Remove proxy must be true or false.")
    if "proxy_url" in payload and not isinstance(payload["proxy_url"], str):
        raise ApiNetworkError("Proxy address must be text.")
    if payload.get("remove_proxy_url"):
        candidate["proxy_url"] = ""
    elif payload.get("proxy_url", "").strip():
        candidate["proxy_url"] = payload["proxy_url"].strip()
    return validate_network_settings(candidate)


def public_network_settings(settings):
    value = validate_network_settings(settings)
    endpoint = ""
    if value["proxy_url"]:
        parts = urlsplit(value["proxy_url"])
        host = f"[{parts.hostname}]" if ":" in parts.hostname else parts.hostname
        endpoint = urlunsplit((parts.scheme, host + (f":{parts.port}" if parts.port else ""), "", "", ""))
    return {"network_mode": value["network_mode"], "proxy_url_present": bool(value["proxy_url"]),
            "proxy_endpoint": endpoint}


def network_identity(settings):
    """Omit new defaults so existing frozen receipts retain their identity."""
    value = validate_network_settings(settings)
    return {key: value[key] for key, default in NETWORK_DEFAULTS.items() if value[key] != default}


class _DirectBackend:
    def __init__(self, backend):
        self.backend = backend

    def connect_tcp(self, host, port, timeout=None, local_address=None, socket_options=None):
        name = host.decode("ascii") if isinstance(host, bytes) else host
        authority = f"[{name}]" if ":" in name else name
        try:
            started = time.monotonic()
            source = direct_local_address(f"http://{authority}:{port}", timeout=timeout)
        except DirectRouteError as exc:
            raise ApiNetworkError(str(exc)) from None
        if timeout is not None:
            timeout -= time.monotonic() - started
            if timeout <= 0:
                raise ApiNetworkError("Direct route selection timed out before connecting. Check the network connection mode.")
        return self.backend.connect_tcp(host, port, timeout=timeout, local_address=source,
                                        socket_options=socket_options)

    def __getattr__(self, name):
        return getattr(self.backend, name)


def _environment_proxy(url):
    if url is None:
        raise ApiNetworkError("A destination is required to select the environment proxy.")
    # Match using the original hostname, before a secure downloader pins DNS.
    patterns = sorted((URLPattern(key), proxy) for key, proxy in get_environment_proxies().items())
    target = httpx.URL(url)
    return next((proxy for pattern, proxy in patterns if pattern.matches(target)), None)


def create_api_transport(settings, url=None):
    policy = validate_network_settings(settings)
    try:
        proxy = (_environment_proxy(url) if policy["network_mode"] == "environment"
                 else policy["proxy_url"] if policy["network_mode"] == "proxy" else None)
        # HTTPX SOCKS5 resolves at the proxy; normalize the equivalent socks5h spelling.
        if proxy and proxy.startswith("socks5h://"):
            proxy = "socks5://" + proxy[len("socks5h://"):]
        # Keep SSL_CERT_FILE / SSL_CERT_DIR support. Proxy selection is explicit;
        # trust_env here controls TLS trust, not the client's proxy mounts.
        transport = httpx.HTTPTransport(proxy=proxy, trust_env=True, retries=0)
    except (ValueError, ImportError, OSError):
        raise ApiNetworkError("Could not initialize the API connection. Check the proxy and trusted certificate configuration.") from None
    if policy["network_mode"] == "direct" and hasattr(transport, "_pool"):
        transport._pool._network_backend = _DirectBackend(transport._pool._network_backend)
    return transport


def create_api_client(settings, *, timeout, client_factory=None):
    policy = validate_network_settings(settings)
    factory = client_factory or httpx.Client
    if policy["network_mode"] == "environment":
        try:
            # HTTPX's own mount selection preserves HTTP(S)_PROXY/ALL_PROXY/NO_PROXY.
            return factory(timeout=timeout, follow_redirects=False, trust_env=True)
        except (ValueError, ImportError, OSError):
            raise ApiNetworkError("Could not initialize the environment connection. Check its proxy and trusted certificates.") from None
    transport = create_api_transport(policy)
    try:
        return factory(timeout=timeout, follow_redirects=False, trust_env=False, transport=transport)
    except Exception:
        transport.close()
        raise
