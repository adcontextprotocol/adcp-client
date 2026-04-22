---
'@adcp/client': minor
---

Add `createDefaultTestControllerStore` to `@adcp/client/testing` — a default factory that wires every `force_*`, `simulate_*`, `seed_*` scenario against a generic `DefaultSessionShape`. Sellers provide `loadSession` / `saveSession` and get a conformance-ready `TestControllerStore` without hand-rolling 300+ lines of boilerplate. Supports partial overrides for sellers who need to customize specific handlers.
