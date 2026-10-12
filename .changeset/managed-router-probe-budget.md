---
'@adcp/sdk': patch
---

`createReportingManagedDeliveryAdapterRouterV1` now rejects a `probeTimeoutMilliseconds` at or above the runtime's 30 second probe deadline (exported as `REPORTING_ADAPTER_PROBE_DEADLINE_MILLISECONDS_V1`). A longer per-route budget let the runtime deadline fire first, so the startup error no longer named the failing route.
