"""Resolve a Windows source address for an explicitly requested direct API call.

No routes, adapters or proxy settings are changed. Other platforms keep their
normal routing. Windows results expire after ten seconds; source binding must
still be performed by the caller before connecting. This does not override
packet-filter drivers or prove the public IP seen by an upstream service.
"""

from __future__ import annotations

import base64
from collections import OrderedDict
import ipaddress
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
from urllib.parse import urlsplit


class DirectRouteError(ValueError):
    """A direct route could not be established from safe local evidence."""


_INVALID_URL = "API 地址无效，无法确认直连出口。"
_NO_ROUTE = "无法确认 Windows 物理直连出口，请改用“跟随环境”或检查网络后重试。"
_DNS_FAILED = "无法解析 API 地址，无法确认直连出口，请改用“跟随环境”或检查网络后重试。"
_FAKE_IP = "API 地址解析为代理 Fake-IP，无法确认直连出口，请改用“跟随环境”或检查网络后重试。"
_CACHE_TTL_SECONDS = 10.0
_CACHE_LIMIT = 64
_QUERY_TIMEOUT_SECONDS = 5.0
_cache: OrderedDict[str, tuple[float, str | None]] = OrderedDict()
_cache_lock = threading.Lock()
_FAKE_NETWORKS = (ipaddress.ip_network("198.18.0.0/15"), ipaddress.ip_network("2001:2::/48"))
_LOCAL_NETWORKS = tuple(ipaddress.ip_network(value) for value in (
    "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "fc00::/7",
))

# The hostname is encoded separately, never interpreted as PowerShell source.
# DNS shares the subprocess deadline; no unbounded resolver thread is left behind.
# A local destination can still use normal routing if inventory access fails.
_POWERSHELL_QUERY = r"""
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$targetName = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__HOST__'))
$result = [ordered]@{ targetAddresses = @(); adapters = @(); routes = @(); addresses = @(); inventoryAvailable = $false }
try {
    $result.targetAddresses = @([Net.Dns]::GetHostAddresses($targetName) | ForEach-Object { $_.IPAddressToString })
} catch {
    $result | ConvertTo-Json -Depth 5 -Compress
    exit 0
}
try {
    $result.adapters = @(Get-NetAdapter -Physical -ErrorAction Stop | ForEach-Object {
        @{ index = $_.InterfaceIndex; hardware = $_.HardwareInterface; virtual = $_.Virtual; up = ($_.Status -eq 'Up') }
    })
    $result.routes = @(Get-NetRoute -PolicyStore ActiveStore -ErrorAction Stop |
        Where-Object { $_.DestinationPrefix -in @('0.0.0.0/0', '::/0') -and $_.State.ToString() -eq 'Alive' } |
        ForEach-Object {
            @{ index = $_.InterfaceIndex; prefix = $_.DestinationPrefix; nextHop = $_.NextHop;
               routeMetric = $_.RouteMetric; interfaceMetric = $_.InterfaceMetric }
        })
    $result.addresses = @(Get-NetIPAddress -PolicyStore ActiveStore -ErrorAction Stop | ForEach-Object {
        @{ index = $_.InterfaceIndex; address = $_.IPAddress; prefixLength = $_.PrefixLength;
           preferred = ($_.AddressState.ToString() -eq 'Preferred'); skipAsSource = $_.SkipAsSource;
           preferredLifetime = $_.PreferredLifetime.TotalSeconds; suffixOrigin = $_.SuffixOrigin.ToString() }
    })
    $result.inventoryAvailable = $true
} catch { }
$result | ConvertTo-Json -Depth 5 -Compress
"""


def _address(value: object) -> ipaddress.IPv4Address | ipaddress.IPv6Address:
    if not isinstance(value, str) or len(value) > 100:
        raise DirectRouteError(_NO_ROUTE)
    try:
        return ipaddress.ip_address(value)
    except ValueError:
        raise DirectRouteError(_NO_ROUTE) from None


def _is_fake(address: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    checked = getattr(address, "ipv4_mapped", None) or address
    return any(checked.version == net.version and checked in net for net in _FAKE_NETWORKS)


def _is_local(address: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    checked = getattr(address, "ipv4_mapped", None) or address
    return (checked.is_loopback or checked.is_link_local or checked.is_unspecified
            or any(checked.version == net.version and checked in net for net in _LOCAL_NETWORKS))


def _integer(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= 0xFFFFFFFF


def _rows(payload: dict, name: str) -> list[dict]:
    values = payload.get(name)
    if not isinstance(values, list) or len(values) > 4096 or any(not isinstance(row, dict) for row in values):
        raise DirectRouteError(_NO_ROUTE)
    return values


def _source_for_route(route: dict, rows: list[dict], family: int) -> str | None:
    try:
        gateway = _address(route.get("nextHop"))
    except DirectRouteError:
        return None
    if gateway.version != family or gateway.is_unspecified or gateway.is_loopback or gateway.is_multicast or _is_fake(gateway):
        return None
    candidates = []
    for row in rows:
        lifetime = row.get("preferredLifetime")
        if (row.get("index") != route["index"] or row.get("preferred") is not True
                or row.get("skipAsSource") is not False or isinstance(lifetime, bool)
                or not isinstance(lifetime, (int, float)) or not math.isfinite(lifetime) or lifetime <= 0):
            continue
        try:
            address = _address(row.get("address"))
        except DirectRouteError:
            continue
        if (address.version != family or address.is_unspecified or address.is_loopback
                or address.is_link_local or address.is_multicast or _is_fake(address)):
            continue
        if not address.is_global and not _is_local(address):
            continue
        if family == 6 and (not address.is_global or address.ipv4_mapped is not None):
            continue
        if family == 4:
            prefix = row.get("prefixLength")
            if not _integer(prefix) or prefix > 32 or gateway not in ipaddress.ip_network(f"{address}/{prefix}", strict=False):
                continue
        # All candidates belong to the same verified interface. Prefer a privacy
        # IPv6 address when available, then use a deterministic preferred address.
        candidates.append((row.get("suffixOrigin") != "Random", int(address), str(address)))
    return min(candidates)[2] if candidates else None


def _select_source(payload: object) -> str | None:
    if not isinstance(payload, dict):
        raise DirectRouteError(_NO_ROUTE)
    resolved = payload.get("targetAddresses")
    if not isinstance(resolved, list) or not resolved or len(resolved) > 128:
        raise DirectRouteError(_DNS_FAILED)
    targets = [_address(value) for value in resolved]
    if any(_is_fake(address) for address in targets):
        raise DirectRouteError(_FAKE_IP)
    if all(_is_local(address) for address in targets):
        return None
    if any(_is_local(address) or not address.is_global or getattr(address, "ipv4_mapped", None) is not None for address in targets):
        raise DirectRouteError(_NO_ROUTE)
    if payload.get("inventoryAvailable") is not True:
        raise DirectRouteError(_NO_ROUTE)
    adapters, routes, addresses = (_rows(payload, name) for name in ("adapters", "routes", "addresses"))
    physical = {row["index"] for row in adapters
                if _integer(row.get("index")) and row["index"] > 0 and row.get("hardware") is True
                and row.get("virtual") is False and row.get("up") is True}
    # Preserve the resolver's family preference, but require a usable physical
    # source. A tied exit is ambiguous, even if another family would be usable.
    for family in dict.fromkeys(address.version for address in targets):
        candidates = []
        for route in routes:
            index = route.get("index")
            if (not _integer(index) or index not in physical
                    or route.get("prefix") != ("0.0.0.0/0" if family == 4 else "::/0")
                    or not _integer(route.get("routeMetric")) or not _integer(route.get("interfaceMetric"))):
                continue
            source = _source_for_route(route, addresses, family)
            if source is not None:
                candidates.append((route["routeMetric"] + route["interfaceMetric"], index, route["nextHop"], source))
        if candidates:
            best_metric = min(row[0] for row in candidates)
            best = {row[1:] for row in candidates if row[0] == best_metric}
            if len(best) != 1:
                raise DirectRouteError(_NO_ROUTE)
            return best.pop()[2]
    raise DirectRouteError(_NO_ROUTE)


def _probe_windows(host: str, *, timeout: float) -> str | None:
    encoded_host = base64.b64encode(host.encode("utf-8")).decode("ascii")
    script = _POWERSHELL_QUERY.replace("__HOST__", encoded_host)
    encoded_script = base64.b64encode(script.encode("utf-16-le")).decode("ascii")
    executable = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32/WindowsPowerShell/v1.0/powershell.exe"
    try:
        result = subprocess.run(
            [str(executable), "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded_script],
            capture_output=True, timeout=timeout, check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000),
        )
        if result.returncode != 0 or len(result.stdout) > 512 * 1024:
            raise DirectRouteError(_NO_ROUTE)
        payload = json.loads(result.stdout.decode("utf-8-sig"))
    except (OSError, subprocess.SubprocessError, UnicodeError, ValueError):
        raise DirectRouteError(_NO_ROUTE) from None
    return _select_source(payload)


def _remaining(deadline: float) -> float:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise DirectRouteError(_NO_ROUTE)
    return min(_QUERY_TIMEOUT_SECONDS, remaining)


def direct_local_address(url: str, *, timeout: float | None = None) -> str | None:
    """Return a pre-connect source binding, or None for normal local routing.

    Only Windows needs this workaround for system-wide TUN routes. Container,
    Linux and macOS network namespaces/routing are left to their host settings.
    Errors are fixed text and contain neither the URL nor subprocess output.
    ``timeout`` bounds route lookup including cache-lock waits. The caller must
    subtract elapsed lookup time from its remaining network timeout.
    """
    if sys.platform != "win32":
        return None
    if timeout is not None and (isinstance(timeout, bool) or not isinstance(timeout, (int, float))
                                or not math.isfinite(timeout) or timeout <= 0):
        raise DirectRouteError(_NO_ROUTE)
    deadline = time.monotonic() + min(_QUERY_TIMEOUT_SECONDS, timeout if timeout is not None else _QUERY_TIMEOUT_SECONDS)
    try:
        parsed = urlsplit(url)
        host = (parsed.hostname or "").rstrip(".").lower()
        if (parsed.scheme not in ("http", "https") or not host or len(host) > 253
                or parsed.username is not None or parsed.password is not None
                or any(char.isspace() for char in host)):
            raise ValueError
        _ = parsed.port
    except (TypeError, ValueError):
        raise DirectRouteError(_INVALID_URL) from None
    if host == "localhost" or host.endswith(".localhost"):
        return None
    try:
        literal = ipaddress.ip_address(host)
    except ValueError:
        literal = None
    if literal is not None:
        if _is_fake(literal):
            raise DirectRouteError(_FAKE_IP)
        if _is_local(literal):
            return None
    if not _cache_lock.acquire(timeout=_remaining(deadline)):
        raise DirectRouteError(_NO_ROUTE)
    try:
        _remaining(deadline)
        now = time.monotonic()
        cached = _cache.get(host)
        if cached is not None and cached[0] > now:
            _cache.move_to_end(host)
            return cached[1]
    finally:
        _cache_lock.release()
    # Do not serialize slow subprocesses behind the cache lock. Concurrent
    # misses may perform duplicate read-only probes, each with its own deadline.
    value = _probe_windows(host, timeout=_remaining(deadline))
    if not _cache_lock.acquire(timeout=_remaining(deadline)):
        raise DirectRouteError(_NO_ROUTE)
    try:
        _remaining(deadline)
        _cache[host] = (time.monotonic() + _CACHE_TTL_SECONDS, value)
        _cache.move_to_end(host)
        while len(_cache) > _CACHE_LIMIT:
            _cache.popitem(last=False)
    finally:
        _cache_lock.release()
    return value
