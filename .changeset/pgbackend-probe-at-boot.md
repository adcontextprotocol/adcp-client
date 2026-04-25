---
"@adcp/client": minor
---

Add `pgBackend.probe()` and `serve({ readinessCheck })` for fail-fast pool validation

Sellers wiring `createIdempotencyStore({ backend: pgBackend(pool) })` from a `DATABASE_URL` env var previously got a silent failure mode: a bad URL (typo, deprovisioned DB, missing creds) lets the server boot successfully, advertise `IdempotencySupported`, then fail every mutating call indefinitely.

This release adds:

- **`pgBackend.probe()`** — runs `SELECT 1 FROM "<table>" LIMIT 0` at startup, validating both connectivity and that the idempotency table has been migrated. Throws a descriptive error naming the table, root cause, and remediation steps.
- **`IdempotencyStore.probe()`** — delegates to `backend.probe()` when the backend implements it; no-ops for `memoryBackend`.
- **`probeIdempotencyStore(store)`** — convenience export for callers that manage their own lifecycle (Lambda, custom HTTP frameworks).
- **`ServeOptions.readinessCheck?: () => Promise<void>`** — called before `httpServer.listen()`. The server never accepts connections if the check throws, so a misconfigured pool crashes the process at deploy time rather than silently failing live traffic.

Wire the probe in `serve()`:

```ts
const store = createIdempotencyStore({ backend: pgBackend(pool), ttlSeconds: 86400 });
pool.on('error', (err) => console.error('pg pool error', err)); // prevent crash on idle-client errors
serve(createAgent, {
  readinessCheck: () => store.probe(),
});
```

`readinessCheck` is general-purpose — use it for any startup dependency check, not just idempotency.

**Non-breaking.** `createIdempotencyStore` remains synchronous. Existing callers require no changes. Option A (async constructor) is tracked separately as a future major-version enhancement.
