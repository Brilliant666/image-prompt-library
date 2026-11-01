# API connection modes

API profiles support direct connections, environment proxy settings, or an
explicit proxy. Direct mode is the default. Saving settings does not call a model.

On Windows, direct mode checks for a usable physical source address and binds
that address before opening the connection. It does not modify routes, adapters,
Windows services or proxy settings. A TUN adapter with a lower route metric is
not treated as a physical exit.

If the Windows NetAdapter/NetTCPIP WMI provider is unavailable, the application
reads the same inventory through the native IP Helper APIs. The helper reuses
the already resolved addresses and runs in an isolated, bounded process. Both
queries share the original deadline; the fallback does not add another timeout
period. Preferred addresses, interface identity, address-family-specific metrics,
physical hardware and connection status are still checked by the same selection
policy. This fallback does not repair the Windows WMI provider itself.

Fake-IP DNS answers, ambiguous physical exits, unavailable addresses and failed
inventory queries still block submission. The application does not silently
switch to an environment proxy or resend a paid request. The short local route
cache is separate from a model provider's Prompt Cache.

Source binding cannot override all packet-filter drivers or prove the public
address seen by a supplier. Successful local inventory checks prove that a
physical source was selected, not that the supplier accepted a request or that
its latency improved.

The Windows CI check exercises real, read-only IP Helper enumeration without
DNS or sockets. Synthetic tests cover table alignment and release, unusable or
virtual interfaces, address changes, tied routes, deadline exhaustion and child
process failures. A CI VM does not need to expose a physical NIC for this check.
