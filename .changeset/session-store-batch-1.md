---
'@adcp/client': minor
---

SessionStore ergonomics + state-store validation (batch 1 of upstream feedback).

**New**
- `store.scoped(sessionKey)` on every `AdcpStateStore` — returns a session-isolated view that auto-prefixes ids and filters `list()` by `_session_key`. Exported standalone as `createSessionedStore(store, key)` for custom stores.
- `HandlerContext.sessionKey` + `resolveSessionKey` hook on `createAdcpServer`. Sellers derive the scoping key once; handlers read `ctx.sessionKey` instead of re-parsing params.
- `StateError` with typed codes (`INVALID_COLLECTION`, `INVALID_ID`, `PAYLOAD_TOO_LARGE`, …), built-in charset/length validation on every store operation, configurable `maxDocumentBytes` (5 MB default) on `InMemoryStateStore` and `PostgresStateStore`.
- `structuredSerialize` / `structuredDeserialize` helpers so handlers can round-trip `Map`, `Set`, and `Date` through the state store without writing per-type converters.

**Docs**
- `docs/guides/CONCURRENCY.md` — explicit last-writer-wins vs per-row isolation model, the read-modify-write race on whole-session blobs, and why per-entity rows are safer.
- `docs/guides/TASKRESULT-5-MIGRATION.md` — the four migration patterns for the 5.0 discriminated-union `TaskResult` (success check, error extraction, status narrowing, intermediate states).

No breaking changes. `scoped` on `AdcpStateStore` is an optional method; custom store implementations that don't define it keep working.
