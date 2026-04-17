---
'@adcp/client': minor
---

Optimistic concurrency primitives on `AdcpStateStore`.

**New**

- `putIfMatch(collection, id, data, expectedVersion)` — atomic compare-and-swap. Returns `{ok: true, version}` on success, `{ok: false, currentVersion}` on conflict. `expectedVersion: null` means insert-only.
- `getWithVersion(collection, id)` — read a document with its row version.
- `patchWithRetry(store, collection, id, updateFn, options?)` — get → compute → putIfMatch → retry loop for read-modify-write updates. Throws `PatchConflictError` after `maxAttempts` (default 5).
- Both built-in stores (`InMemoryStateStore`, `PostgresStateStore`) track a monotonically increasing `version` per row. Every `put`/`patch`/`putIfMatch` bumps it.
- Sessioned stores (`createSessionedStore` / `store.scoped(key)`) proxy the new methods through so scoped views get CAS for free.

**Postgres migration**

- `getAdcpStateMigration()` adds `version INTEGER NOT NULL DEFAULT 1` via `ADD COLUMN IF NOT EXISTS`. Existing rows start at version 1. No data rewrite.

**Docs**

- `docs/guides/CONCURRENCY.md` gains a section covering `patchWithRetry`, `putIfMatch`, and when to reach for each.

No breaking changes. Both new methods are optional on the `AdcpStateStore` interface; custom stores that don't implement them keep working.
