"""Direct-route selection uses synthetic inventories; no API or model is called."""

import base64
from collections import OrderedDict
from copy import deepcopy
import json
import subprocess
from types import SimpleNamespace

import pytest

from backend.services import api_direct_route as direct


def inventory(targets=None):
    return {
        "targetAddresses": targets or ["93.184.216.34"],
        "inventoryAvailable": True,
        "adapters": [
            {"index": 12, "hardware": True, "virtual": False, "up": True},
            {"index": 39, "hardware": False, "virtual": True, "up": True},
        ],
        "routes": [
            {"index": 39, "prefix": "0.0.0.0/0", "nextHop": "198.18.0.2", "routeMetric": 0, "interfaceMetric": 0},
            {"index": 12, "prefix": "0.0.0.0/0", "nextHop": "192.168.20.1", "routeMetric": 0, "interfaceMetric": 30},
        ],
        "addresses": [
            {"index": 39, "address": "198.18.0.1", "prefixLength": 15, "preferred": True,
             "skipAsSource": False, "preferredLifetime": 3600, "suffixOrigin": "Manual"},
            {"index": 12, "address": "192.168.20.50", "prefixLength": 24, "preferred": True,
             "skipAsSource": False, "preferredLifetime": 3600, "suffixOrigin": "Dhcp"},
        ],
    }


@pytest.fixture(autouse=True)
def isolated_windows(monkeypatch):
    monkeypatch.setattr(direct, "sys", SimpleNamespace(platform="win32"))
    monkeypatch.setattr(direct, "_cache", OrderedDict())
    # An unexpected subprocess is an error, including accidental live DNS reads.
    def no_query(*args, **kwargs):
        pytest.fail("Unexpected live route/DNS query")
    monkeypatch.setattr(direct.subprocess, "run", no_query)


def stub_query(monkeypatch, payload):
    calls = []
    def query(args, **kwargs):
        calls.append((args, kwargs))
        value = payload() if callable(payload) else payload
        return SimpleNamespace(returncode=0, stdout=json.dumps(value).encode())
    monkeypatch.setattr(direct.subprocess, "run", query)
    return calls


@pytest.mark.parametrize("platform", ["linux", "darwin", "freebsd14"])
def test_other_platforms_keep_host_and_container_routing(monkeypatch, platform):
    monkeypatch.setattr(direct, "sys", SimpleNamespace(platform=platform))
    assert direct.direct_local_address("https://api.example.invalid/v1") is None


@pytest.mark.parametrize("host", [
    "localhost", "LOCALHOST.", "service.localhost", "127.0.0.1", "127.0.0.2", "0.0.0.0",
    "10.10.5.3", "172.20.1.2", "192.168.22.9", "100.70.1.2", "169.254.2.3",
    "[::1]", "[fd00::2]", "[fe80::2]", "[::ffff:192.168.1.8]",
])
def test_local_urls_keep_system_local_routes_without_inventory_or_dns(host):
    assert direct.direct_local_address(f"http://{host}:8001/v1") is None


@pytest.mark.parametrize("host", ["198.18.0.1", "198.19.255.254", "[2001:2::1]", "[::ffff:198.18.0.9]"])
def test_fake_ip_literals_are_never_mistaken_for_private_targets(host):
    with pytest.raises(direct.DirectRouteError, match="Fake-IP"):
        direct.direct_local_address(f"https://{host}/v1")


@pytest.mark.parametrize("targets", [
    ["198.18.0.1"], ["2001:2::1"], ["::ffff:198.18.3.2"], ["93.184.216.34", "198.19.1.2"],
])
def test_any_fake_ip_dns_answer_fails_explicitly(monkeypatch, targets):
    stub_query(monkeypatch, inventory(targets))
    with pytest.raises(direct.DirectRouteError, match="Fake-IP"):
        direct.direct_local_address("https://synthetic.example.invalid/v1")


def test_selects_preferred_physical_source_instead_of_lower_metric_tun(monkeypatch):
    calls = stub_query(monkeypatch, inventory())
    assert direct.direct_local_address("https://synthetic.example.invalid/private-path?key=never-emit") == "192.168.20.50"
    args, options = calls[0]
    assert args[1:5] == ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"]
    script = base64.b64decode(args[5]).decode("utf-16-le")
    assert base64.b64encode(b"synthetic.example.invalid").decode() in script
    assert "never-emit" not in script and "private-path" not in script
    assert options["creationflags"] & 0x08000000
    assert 0 < options["timeout"] <= 5 and options["capture_output"] is True
    assert options.get("shell", False) is False


def second_interface(payload, metric=60):
    payload["adapters"].append({"index": 7, "hardware": True, "virtual": False, "up": True})
    payload["routes"].append({"index": 7, "prefix": "0.0.0.0/0", "nextHop": "10.0.0.1", "routeMetric": 0, "interfaceMetric": metric})
    payload["addresses"].append({"index": 7, "address": "10.0.0.50", "prefixLength": 24, "preferred": True,
                                "skipAsSource": False, "preferredLifetime": 3600, "suffixOrigin": "Dhcp"})


def test_route_preference_uses_route_plus_interface_metric(monkeypatch):
    value = inventory()
    second_interface(value, metric=20)
    value["routes"][-1]["routeMetric"] = 20
    stub_query(monkeypatch, value)
    assert direct.direct_local_address("https://synthetic.example.invalid") == "192.168.20.50"


def test_same_priority_physical_exits_are_ambiguous(monkeypatch):
    value = inventory()
    second_interface(value, metric=30)
    stub_query(monkeypatch, value)
    with pytest.raises(direct.DirectRouteError, match="跟随环境"):
        direct.direct_local_address("https://synthetic.example.invalid")


def test_duplicate_route_is_not_another_exit_but_two_gateways_are(monkeypatch):
    value = inventory()
    value["routes"].append(deepcopy(value["routes"][1]))
    stub_query(monkeypatch, value)
    assert direct.direct_local_address("https://one.example.invalid") == "192.168.20.50"
    value["routes"][-1]["nextHop"] = "192.168.20.2"
    with pytest.raises(direct.DirectRouteError, match="跟随环境"):
        direct.direct_local_address("https://two.example.invalid")


def add_ipv6(value):
    value["routes"].append({"index": 12, "prefix": "::/0", "nextHop": "fe80::1", "routeMetric": 10, "interfaceMetric": 30})
    for suffix, origin in [("10", "Manual"), ("20", "Random")]:
        value["addresses"].append({"index": 12, "address": f"2001:4860:1234::{suffix}", "prefixLength": 64,
                                    "preferred": True, "skipAsSource": False, "preferredLifetime": 3600, "suffixOrigin": origin})


def test_ipv6_destination_uses_preferred_public_v6_on_physical_interface(monkeypatch):
    value = inventory(["2001:4860:4860::8888", "93.184.216.34"])
    add_ipv6(value)
    stub_query(monkeypatch, value)
    assert direct.direct_local_address("https://synthetic.example.invalid") == "2001:4860:1234::20"


def test_dual_stack_falls_back_only_to_a_verified_available_family(monkeypatch):
    value = inventory(["2001:4860:4860::8888", "93.184.216.34"])
    stub_query(monkeypatch, value)
    assert direct.direct_local_address("https://synthetic.example.invalid") == "192.168.20.50"


def test_v6_only_target_does_not_get_v4_or_ula_source(monkeypatch):
    value = inventory(["2001:4860:4860::8888"])
    add_ipv6(value)
    value["addresses"] = [value["addresses"][0], value["addresses"][1], {**value["addresses"][-1], "address": "fd00::20"}]
    stub_query(monkeypatch, value)
    with pytest.raises(direct.DirectRouteError, match="跟随环境"):
        direct.direct_local_address("https://synthetic.example.invalid")


@pytest.mark.parametrize("section,key,value", [
    ("adapters", "up", False), ("adapters", "hardware", False), ("adapters", "virtual", True),
    ("routes", "interfaceMetric", None), ("routes", "routeMetric", "0"), ("routes", "routeMetric", True),
    ("routes", "nextHop", "0.0.0.0"), ("routes", "nextHop", "198.18.0.1"),
    ("addresses", "preferred", False), ("addresses", "skipAsSource", True),
    ("addresses", "preferredLifetime", 0), ("addresses", "preferredLifetime", None),
    ("addresses", "preferredLifetime", float("nan")), ("addresses", "preferredLifetime", True),
    ("addresses", "address", "169.254.20.50"), ("addresses", "address", "198.18.0.50"),
    ("addresses", "address", "10.1.1.50"), ("addresses", "prefixLength", None),
])
def test_unverified_or_unusable_source_never_silently_uses_tun(monkeypatch, section, key, value):
    payload = inventory()
    row = next(row for row in payload[section] if row["index"] == 12)
    row[key] = value
    stub_query(monkeypatch, payload)
    with pytest.raises(direct.DirectRouteError, match="跟随环境"):
        direct.direct_local_address("https://synthetic.example.invalid")


def test_local_dns_keeps_normal_route_even_when_adapter_inventory_unavailable(monkeypatch):
    stub_query(monkeypatch, {"targetAddresses": ["192.168.22.2", "fd00::2"], "inventoryAvailable": False})
    assert direct.direct_local_address("http://lan.example.invalid:9000") is None


def test_mixed_local_and_public_dns_is_not_silently_bound_or_proxied(monkeypatch):
    stub_query(monkeypatch, inventory(["10.0.0.1", "93.184.216.34"]))
    with pytest.raises(direct.DirectRouteError, match="跟随环境"):
        direct.direct_local_address("https://synthetic.example.invalid")


@pytest.mark.parametrize("payload", [
    None, [], {}, {"targetAddresses": []}, {"targetAddresses": "93.184.216.34"},
    {**inventory(), "inventoryAvailable": False}, {**inventory(), "routes": "not-a-list"},
    {**inventory(), "adapters": [None]}, {**inventory(), "targetAddresses": ["secret-not-an-ip"]},
])
def test_invalid_inventory_fails_closed_with_no_raw_details(monkeypatch, payload):
    stub_query(monkeypatch, payload)
    with pytest.raises(direct.DirectRouteError) as error:
        direct.direct_local_address("https://synthetic.example.invalid?key=private-secret")
    assert "private-secret" not in str(error.value) and "secret-not-an-ip" not in str(error.value)
    assert "synthetic.example.invalid" not in str(error.value)


@pytest.mark.parametrize("failure", [
    subprocess.TimeoutExpired("secret-command", 5, output=b"private-output"),
    OSError("private-environment"),
    SimpleNamespace(returncode=1, stdout=b"private-output", stderr=b"private-error"),
    SimpleNamespace(returncode=0, stdout=b"not JSON private-output"),
    SimpleNamespace(returncode=0, stdout=b"\xff"),
    SimpleNamespace(returncode=0, stdout=b"x" * (512 * 1024 + 1)),
])
def test_subprocess_failures_are_bounded_safe_and_not_cached(monkeypatch, failure):
    calls = []
    def run(*args, **kwargs):
        calls.append(kwargs)
        if isinstance(failure, Exception):
            raise failure
        return failure
    monkeypatch.setattr(direct.subprocess, "run", run)
    for _ in range(2):
        with pytest.raises(direct.DirectRouteError) as error:
            direct.direct_local_address("https://synthetic.example.invalid?key=private-secret")
        assert str(error.value) == direct._NO_ROUTE
    assert len(calls) == 2 and 0 < calls[0]["timeout"] <= direct._QUERY_TIMEOUT_SECONDS


@pytest.mark.parametrize("url", [
    "not-a-url", "ftp://example.invalid", "https://user:private-key@example.invalid", "https://[", "https://example.invalid:bad",
    "https://bad host.invalid", "https://" + "a" * 254, None,
])
def test_invalid_urls_fail_before_query_without_echoing_input(url):
    with pytest.raises(direct.DirectRouteError) as error:
        direct.direct_local_address(url)
    assert str(error.value) == direct._INVALID_URL


def test_short_cache_reuses_host_but_rechecks_network_changes_after_expiry(monkeypatch):
    clock = [100.0]
    monkeypatch.setattr(direct.time, "monotonic", lambda: clock[0])
    value = inventory()
    calls = stub_query(monkeypatch, value)
    assert direct.direct_local_address("https://synthetic.example.invalid/v1/responses") == "192.168.20.50"
    value["addresses"][1]["address"] = "192.168.20.51"
    clock[0] += 9
    assert direct.direct_local_address("https://synthetic.example.invalid/v1/models") == "192.168.20.50"
    clock[0] += 1
    assert direct.direct_local_address("https://synthetic.example.invalid/v1/responses") == "192.168.20.51"
    assert len(calls) == 2
    value["targetAddresses"] = ["198.18.0.2"]
    clock[0] += 10
    with pytest.raises(direct.DirectRouteError, match="Fake-IP"):
        direct.direct_local_address("https://synthetic.example.invalid/v1/responses")


def test_network_failure_can_recover_immediately_without_error_cache(monkeypatch):
    clock = [100.0]
    monkeypatch.setattr(direct.time, "monotonic", lambda: clock[0])
    value = inventory()
    value["adapters"][0]["up"] = False
    calls = stub_query(monkeypatch, value)
    with pytest.raises(direct.DirectRouteError):
        direct.direct_local_address("https://synthetic.example.invalid")
    value["adapters"][0]["up"] = True
    assert direct.direct_local_address("https://synthetic.example.invalid") == "192.168.20.50"
    assert len(calls) == 2


def test_route_cache_does_not_grow_with_unbounded_provider_hosts(monkeypatch):
    monkeypatch.setattr(direct, "_CACHE_LIMIT", 2)
    calls = stub_query(monkeypatch, inventory())
    for host in ("one", "two", "three", "two", "one"):
        assert direct.direct_local_address(f"https://{host}.example.invalid") == "192.168.20.50"
    assert len(calls) == 4 and len(direct._cache) == 2


def test_probe_does_not_hold_cache_lock_and_receives_remaining_budget(monkeypatch):
    clock = [100.0]
    monkeypatch.setattr(direct.time, "monotonic", lambda: clock[0])
    calls = []
    def run(*args, **kwargs):
        assert direct._cache_lock.acquire(blocking=False)
        direct._cache_lock.release()
        calls.append(kwargs)
        clock[0] += 0.2
        return SimpleNamespace(returncode=0, stdout=json.dumps(inventory()).encode())
    monkeypatch.setattr(direct.subprocess, "run", run)
    assert direct.direct_local_address("https://synthetic.example.invalid", timeout=0.5) == "192.168.20.50"
    assert calls[0]["timeout"] == 0.5


def test_lookup_budget_cannot_be_extended_by_lock_wait_or_slow_process(monkeypatch):
    clock = [100.0]
    monkeypatch.setattr(direct.time, "monotonic", lambda: clock[0])
    class WaitingLock:
        def acquire(self, *, timeout):
            clock[0] += 0.2
            return True
        def release(self):
            pass
    monkeypatch.setattr(direct, "_cache_lock", WaitingLock())
    calls = []
    def run(*args, **kwargs):
        calls.append(kwargs)
        clock[0] += 0.4
        return SimpleNamespace(returncode=0, stdout=json.dumps(inventory()).encode())
    monkeypatch.setattr(direct.subprocess, "run", run)
    with pytest.raises(direct.DirectRouteError, match="跟随环境"):
        direct.direct_local_address("https://synthetic.example.invalid", timeout=0.5)
    assert calls[0]["timeout"] == pytest.approx(0.3)
    assert not direct._cache


def test_cache_lock_wait_has_deadline_and_does_not_start_query(monkeypatch):
    waits = []
    class BusyLock:
        def acquire(self, *, timeout):
            waits.append(timeout)
            return False
    monkeypatch.setattr(direct, "_cache_lock", BusyLock())
    with pytest.raises(direct.DirectRouteError, match="跟随环境"):
        direct.direct_local_address("https://synthetic.example.invalid", timeout=0.05)
    assert len(waits) == 1 and 0 < waits[0] <= 0.05


def test_budget_is_rechecked_after_lock_acquisition_even_on_cache_hit(monkeypatch):
    clock = [100.0]
    monkeypatch.setattr(direct.time, "monotonic", lambda: clock[0])
    direct._cache["synthetic.example.invalid"] = (200.0, "192.168.20.50")
    releases = []
    class BoundaryLock:
        def acquire(self, *, timeout):
            clock[0] += timeout
            return True
        def release(self):
            releases.append(True)
    monkeypatch.setattr(direct, "_cache_lock", BoundaryLock())
    with pytest.raises(direct.DirectRouteError, match="跟随环境"):
        direct.direct_local_address("https://synthetic.example.invalid", timeout=0.05)
    assert releases == [True]


@pytest.mark.parametrize("timeout", [0, -1, float("nan"), float("inf"), True, "5"])
def test_invalid_or_exhausted_budget_never_queries(timeout):
    with pytest.raises(direct.DirectRouteError, match="跟随环境"):
        direct.direct_local_address("https://synthetic.example.invalid", timeout=timeout)
