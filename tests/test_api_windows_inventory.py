"""IP Helper ABI and synthetic table tests; no model, DNS or socket requests."""
import ctypes as C
import ipaddress
import json
from pathlib import Path
import subprocess
import sys

import pytest

from backend.services import api_windows_inventory as native
from backend.services.api_direct_route import DirectRouteError, _select_source


def address(value):
    ip = ipaddress.ip_address(value)
    result = native.Sockaddr()
    result.raw[:2] = (2 if ip.version == 4 else 23).to_bytes(2, 'little')
    start = 4 if ip.version == 4 else 8
    result.raw[start:start + len(ip.packed)] = ip.packed
    return result


class Api:
    def __init__(self):
        self.routes, self.addresses, self.adapters, self.metrics = [], [], {}, {}
        self.buffers, self.freed, self.error, self.too_many = [], [], None, False
        self.add(12, 1012, '192.168.20.50', '192.168.20.1', physical=True, metric=30)
        self.add(39, 1039, '198.18.0.1', '198.18.0.2', physical=False, metric=0)

    def add(self, index, luid, source, gateway, *, physical, metric):
        ip = ipaddress.ip_address(source)
        family = 2 if ip.version == 4 else 23
        route = native.Route(index=index, luid=luid, next_hop=address(gateway), valid_lifetime=3600, preferred_lifetime=3600)
        route.prefix.address = address('0.0.0.0' if family == 2 else '::')
        self.routes.append(route)
        self.addresses.append(native.Unicast(index=index, luid=luid, address=address(source),
            prefix_length=24 if family == 2 else 64, dad_state=4, valid_lifetime=3600, preferred_lifetime=3600))
        self.adapters[index] = dict(flags=5 if physical else 0, tunnel_type=0, oper_status=1, admin_status=1, media_connected=1)
        self.metrics[(index, family)] = metric

    def table(self, rows, kind, pointer, name):
        class Table(C.Structure):
            _fields_ = [('count', native.U32), ('rows', kind * len(rows))]
        table = Table(count=4097 if self.too_many else len(rows), rows=(kind * len(rows))(*rows))
        self.buffers.append(table)
        C.cast(pointer, C.POINTER(C.c_void_p)).contents.value = C.addressof(table)
        return 5 if self.error == name else 0

    def GetIpForwardTable2(self, family, pointer):
        assert family == 0
        return self.table(self.routes, native.Route, pointer, 'routes')

    def GetUnicastIpAddressTable(self, family, pointer):
        assert family == 0
        return self.table(self.addresses, native.Unicast, pointer, 'addresses')

    def FreeMibTable(self, pointer):
        self.freed.append(pointer.value)

    def GetIfEntry2(self, pointer):
        row = pointer._obj
        for key, value in self.adapters[row.index].items():
            setattr(row, key, value)
        if self.error == 'identity':
            row.luid += 1
        return 5 if self.error == 'interface' else 0

    def GetIpInterfaceEntry(self, pointer):
        row = pointer._obj
        row.connected = 1
        row.metric = self.metrics[(row.index, row.family)]
        return 5 if self.error == 'metric' else 0


def inventory(api):
    return native.native_inventory(['93.184.216.34'], api=api)


def test_abi_and_table_alignment_copy_and_release():
    native._layout_check()
    api = Api()
    data = inventory(api)
    assert _select_source(data) == '192.168.20.50'
    assert len(api.freed) == 2 and len(set(api.freed)) == 2
    assert data['routes'][0]['interfaceMetric'] == 30
    # Returned Python data is independent of freed native buffers.
    for buffer in api.buffers:
        C.memset(C.addressof(buffer), 0, C.sizeof(buffer))
    assert _select_source(data) == '192.168.20.50'


@pytest.mark.parametrize('field,value', [('flags', 4), ('flags', 7), ('flags', 133),
    ('flags', 21), ('flags', 37), ('flags', 69), ('flags', 13),
    ('oper_status', 2), ('admin_status', 2), ('media_connected', 2), ('tunnel_type', 1)])
def test_unverified_physical_or_disconnected_interface_is_not_selected(field, value):
    api = Api()
    api.adapters[12][field] = value
    with pytest.raises(DirectRouteError):
        _select_source(inventory(api))


@pytest.mark.parametrize('field,value', [('skip_as_source', 1), ('dad_state', 3),
    ('preferred_lifetime', 0), ('valid_lifetime', 0), ('luid', 999)])
def test_address_state_and_interface_ownership_are_preserved(field, value):
    api = Api()
    setattr(api.addresses[0], field, value)
    with pytest.raises(DirectRouteError):
        _select_source(inventory(api))


def test_native_inventory_preserves_tied_routes_and_ipv6_family_metrics():
    api = Api()
    api.add(7, 1007, '10.0.0.50', '10.0.0.1', physical=True, metric=30)
    with pytest.raises(DirectRouteError):
        _select_source(inventory(api))
    api = Api()
    api.add(12, 1012, '2001:4860:1234::20', 'fe80::1', physical=True, metric=42)
    api.addresses[-1].suffix_origin = 5
    data = native.native_inventory(['2001:4860:4860::8888'], api=api)
    assert _select_source(data) == '2001:4860:1234::20'
    assert data['routes'][-1]['interfaceMetric'] == 42
    assert data['addresses'][-1]['suffixOrigin'] == 'Random'


@pytest.mark.parametrize('failure', ['routes', 'addresses', 'interface', 'metric', 'identity', 'too_many'])
def test_api_failure_or_oversize_table_fails_and_frees_all_allocations(failure):
    api = Api()
    api.error, api.too_many = failure, failure == 'too_many'
    with pytest.raises(OSError):
        inventory(api)
    assert len(api.freed) == len(api.buffers)


def test_index_reuse_cannot_merge_two_different_interface_identities():
    api = Api()
    api.add(12, 2012, '10.0.0.50', '10.0.0.1', physical=True, metric=30)
    with pytest.raises(OSError):
        inventory(api)


@pytest.mark.skipif(sys.platform != 'win32', reason='Read-only Windows IP Helper ABI/API integration')
def test_real_windows_helper_process_reads_inventory_without_dns_or_sockets():
    # A CI VM need not expose a physical NIC. Verify real API decoding in the
    # isolated helper process, not internet reachability or supplier acceptance.
    helper = Path(native.__file__)
    result = subprocess.run([sys.executable, '-I', '-B', str(helper), '["93.184.216.34"]'],
        capture_output=True, timeout=5, creationflags=subprocess.CREATE_NO_WINDOW)
    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data['inventoryAvailable'] is True
    assert data['targetAddresses'] == ['93.184.216.34']
    assert all(isinstance(data[name], list) for name in ('adapters', 'routes', 'addresses'))
    assert all(isinstance(row['index'], int) and isinstance(row['hardware'], bool) for row in data['adapters'])
