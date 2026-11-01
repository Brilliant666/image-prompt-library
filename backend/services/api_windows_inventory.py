"""Read-only IP Helper inventory for the bounded direct-route helper process.

No WMI, DNS, sockets, credentials or system changes. The caller supplies already
validated DNS addresses and applies the shared route-selection policy afterwards.
ABI: https://learn.microsoft.com/windows/win32/api/netioapi/
"""
from __future__ import annotations

import ctypes as C
import ipaddress
import json
import socket
import sys

U8, U16, U32, U64 = C.c_uint8, C.c_uint16, C.c_uint32, C.c_uint64
LIMIT = 4096


class Sockaddr(C.Union):
    _fields_ = [('raw', U8 * 28), ('alignment', U32)]

    @property
    def family(self):
        return int.from_bytes(bytes(self.raw[:2]), 'little')

    def ip(self):
        if self.family == 2:
            return socket.inet_ntop(socket.AF_INET, bytes(self.raw[4:8]))
        if self.family == 23:
            return socket.inet_ntop(socket.AF_INET6, bytes(self.raw[8:24]))
        raise OSError('Unsupported address family')


class Prefix(C.Structure):
    _fields_ = [('address', Sockaddr), ('length', U8)]


class Route(C.Structure):
    _fields_ = [('luid', U64), ('index', U32), ('prefix', Prefix), ('next_hop', Sockaddr),
                ('site_prefix', U8), ('valid_lifetime', U32), ('preferred_lifetime', U32),
                ('metric', U32), ('protocol', U32), ('loopback', U8), ('autoconfigure', U8),
                ('publish', U8), ('immortal', U8), ('age', U32), ('origin', U32)]


class Unicast(C.Structure):
    _fields_ = [('address', Sockaddr), ('luid', U64), ('index', U32), ('prefix_origin', U32),
                ('suffix_origin', U32), ('valid_lifetime', U32), ('preferred_lifetime', U32),
                ('prefix_length', U8), ('skip_as_source', U8), ('dad_state', U32),
                ('scope', U32), ('created', U64)]


class Interface(C.Structure):
    # WCHAR is always 16 bits on Windows, including when ABI tests run on Unix.
    _fields_ = [('luid', U64), ('index', U32), ('guid', U8 * 16),
                ('alias', U16 * 257), ('description', U16 * 257), ('physical_length', U32),
                ('physical', U8 * 32), ('permanent', U8 * 32), ('mtu', U32), ('type', U32),
                ('tunnel_type', U32), ('media_type', U32), ('physical_medium', U32),
                ('access_type', U32), ('direction', U32), ('flags', U8), ('oper_status', U32),
                ('admin_status', U32), ('media_connected', U32), ('network_guid', U8 * 16),
                ('connection_type', U32), ('counters', U64 * 20)]


class IpInterface(C.Structure):
    _fields_ = [('family', U16), ('luid', U64), ('index', U32), ('max_reassembly', U32),
                ('identifier', U64), ('min_advertisement', U32), ('max_advertisement', U32),
                ('advertising', U8), ('forwarding', U8), ('weak_send', U8), ('weak_receive', U8),
                ('automatic_metric', U8), ('neighbor_detection', U8), ('managed', U8),
                ('other_stateful', U8), ('advertise_default', U8), ('discovery', U32),
                ('dad_transmits', U32), ('base_reachable', U32), ('retransmit', U32),
                ('path_timeout', U32), ('link_behavior', U32), ('link_timeout', U32),
                ('zones', U32 * 16), ('site_prefix', U32), ('metric', U32), ('mtu', U32),
                ('connected', U8), ('wake', U8), ('neighbor', U8), ('router', U8),
                ('reachable', U32), ('transmit_offload', U8), ('receive_offload', U8),
                ('disable_default', U8)]


def _layout_check():
    sizes = ((Sockaddr, 28), (Prefix, 32), (Route, 104), (Unicast, 80),
             (Interface, 1352), (IpInterface, 168))
    offsets = ((Interface.flags, 1152), (Interface.oper_status, 1156),
               (IpInterface.metric, 148), (Unicast.luid, 32), (Route.metric, 84))
    if any(C.sizeof(kind) != size for kind, size in sizes) or any(field.offset != offset for field, offset in offsets):
        raise OSError('Unsupported IP Helper ABI')


def _load_api():
    # System32 only; never load a DLL from the working directory or PATH.
    api = C.WinDLL('iphlpapi.dll', winmode=0x00000800)
    for name in ('GetIpForwardTable2', 'GetUnicastIpAddressTable'):
        function = getattr(api, name)
        function.argtypes = [U16, C.POINTER(C.c_void_p)]
        function.restype = U32
    for name, kind in (('GetIfEntry2', Interface), ('GetIpInterfaceEntry', IpInterface)):
        function = getattr(api, name)
        function.argtypes = [C.POINTER(kind)]
        function.restype = U32
    api.FreeMibTable.argtypes = [C.c_void_p]
    api.FreeMibTable.restype = None
    return api


def _table(api, name, kind):
    class Table(C.Structure):
        _fields_ = [('count', U32), ('rows', kind * 1)]
    pointer = C.c_void_p()
    try:
        if getattr(api, name)(0, C.byref(pointer)) or not pointer.value:
            raise OSError('IP Helper table unavailable')
        count = U32.from_address(pointer.value).value
        if count > LIMIT:
            raise OSError('IP Helper table exceeds limit')
        # Copy before FreeMibTable; respect the SDK's padded table alignment.
        return [kind.from_buffer_copy(C.string_at(pointer.value + Table.rows.offset + i * C.sizeof(kind), C.sizeof(kind)))
                for i in range(count)]
    finally:
        if pointer.value:
            api.FreeMibTable(pointer)


def native_inventory(targets, *, api=None):
    _layout_check()
    if (not isinstance(targets, list) or not 1 <= len(targets) <= 128
            or any(not isinstance(value, str) or len(value) > 100 for value in targets)):
        raise ValueError('Invalid target addresses')
    for value in targets:
        ipaddress.ip_address(value)
    api = api if api is not None else _load_api()
    routes = _table(api, 'GetIpForwardTable2', Route)
    addresses = _table(api, 'GetUnicastIpAddressTable', Unicast)
    result = dict(targetAddresses=targets, inventoryAvailable=True, adapters=[], routes=[], addresses=[])
    interfaces, metrics, index_luids = {}, {}, {}
    for route in routes:
        family = route.prefix.address.family
        if (family not in (2, 23) or route.prefix.length or int(ipaddress.ip_address(route.prefix.address.ip()))
                or route.loopback or not route.valid_lifetime or not route.preferred_lifetime
                or route.next_hop.family != family or route.metric == 0xFFFFFFFF):
            continue
        identity = (route.index, route.luid)
        if route.index in index_luids and index_luids[route.index] != route.luid:
            raise OSError('Interface index reused during inventory')
        index_luids[route.index] = route.luid
        if identity not in interfaces:
            row = Interface(luid=route.luid, index=route.index)
            if api.GetIfEntry2(C.byref(row)) or (row.index, row.luid) != identity:
                raise OSError('Interface changed during inventory')
            interfaces[identity] = row
            physical = bool(row.flags & 1 and row.flags & 4 and not row.flags & 0x82) and not row.tunnel_type
            up = row.oper_status == 1 and row.admin_status == 1 and row.media_connected == 1 and not row.flags & 0x78
            result['adapters'].append(dict(index=row.index, hardware=physical, virtual=not physical, up=up))
        key = (identity, family)
        if key not in metrics:
            row = IpInterface(family=family, luid=route.luid, index=route.index)
            if api.GetIpInterfaceEntry(C.byref(row)) or (row.index, row.luid, row.family) != (*identity, family):
                raise OSError('IP interface changed during inventory')
            metrics[key] = row
        ip_interface = metrics[key]
        if ip_interface.connected and not ip_interface.disable_default and ip_interface.metric != 0xFFFFFFFF:
            result['routes'].append(dict(index=route.index, prefix='0.0.0.0/0' if family == 2 else '::/0',
                nextHop=route.next_hop.ip(), routeMetric=route.metric, interfaceMetric=ip_interface.metric))
    for row in addresses:
        if (row.index, row.luid) not in interfaces or row.address.family not in (2, 23):
            continue
        result['addresses'].append(dict(index=row.index, address=row.address.ip(), prefixLength=row.prefix_length,
            preferred=row.dad_state == 4 and row.valid_lifetime > 0, skipAsSource=bool(row.skip_as_source),
            preferredLifetime=row.preferred_lifetime, suffixOrigin='Random' if row.suffix_origin == 5 else 'Other'))
    return result


if __name__ == '__main__':
    try:
        print(json.dumps(native_inventory(json.loads(sys.argv[1])), separators=(',', ':')))
    except (OSError, ValueError, IndexError, AttributeError):
        # No raw DLL/system exception text or local addresses in error output.
        sys.exit(1)
