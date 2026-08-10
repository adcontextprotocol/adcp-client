---
'@adcp/sdk': minor
---

Prevent transport diagnostics from deadlocking on large response bodies, expose declaration-level canonical format projection with durable legacy routes, add structured `RegistryClient` HTTP errors, and let `adcpError()` echo request context consistently across its response layers. Instrumented calls that previously stopped after `request_started` on a large response can now complete and emit `response_received` normally.
