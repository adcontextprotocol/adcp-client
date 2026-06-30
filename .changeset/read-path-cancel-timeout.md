---
"@adcp/sdk": minor
---

Add read-path cancellation and bounded A2A agent-card discovery. `getAgentInfo()`, `getCapabilities()`, and task calls such as `getProducts()` now accept `AbortSignal` through their options, and `transport.requestTimeoutMs` controls the read-path request timeout with a default 60s cap for A2A agent-card fetches.
