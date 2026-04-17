# State Store Concurrency

`AdcpStateStore` is a document store keyed by `(collection, id)`. This page
documents what concurrent writes look like so sellers can choose a data
layout that matches their consistency needs.

## TL;DR

| Pattern                           | Safety                           |
| --------------------------------- | -------------------------------- |
| `put(col, id, data)`              | Last-writer-wins on the whole row |
| `patch(col, id, partial)`         | Last-writer-wins on the fields in `partial` |
| Two handlers editing the same row | Race: read → compute → write is NOT atomic |
| Two handlers editing **different** rows | Independent — no contention |

## Per-row isolation

Each `(collection, id)` is an independent row. Two handlers writing to
different rows never contend, regardless of concurrency. This is the safest
data layout:

```ts
// Handler A
await ctx.store.put('media_buys', 'mb_alice', buyA);

// Handler B (concurrent, different id)
await ctx.store.put('media_buys', 'mb_bob', buyB);
```

Both succeed. No lost updates.

## Last-writer-wins on the same row

`put` is an upsert. If two handlers write to the same `(collection, id)`
concurrently, the last write wins:

```ts
// T1: writes { budget: 1000 }
await ctx.store.put('media_buys', 'mb_1', { budget: 1000 });

// T2 (concurrent): writes { budget: 2000 }
await ctx.store.put('media_buys', 'mb_1', { budget: 2000 });

// Final row: whichever COMMIT landed last (T1 or T2). The other is gone.
```

`patch` has the same last-writer-wins semantics, but scoped to the fields
you pass. Fields the other writer didn't touch are preserved:

```ts
// Existing: { budget: 1000, status: 'active' }

// T1: patch({ budget: 5000 })
// T2: patch({ status: 'paused' })

// Final: { budget: 5000, status: 'paused' }  ← both survive
```

Patches only interfere when they write the same field.

## The read-modify-write race

If you read a row, compute a new value, and write it back, **there is no
atomicity guarantee between the read and the write.** Two handlers can read
the same pre-state, each compute a new value based on it, and each overwrite
with their version — losing one update.

```ts
// T1
const buy = await ctx.store.get('media_buys', 'mb_1');  // { budget: 1000 }
buy.budget += 500;
await ctx.store.put('media_buys', 'mb_1', buy);         // writes { budget: 1500 }

// T2 (concurrent)
const buy = await ctx.store.get('media_buys', 'mb_1');  // also reads { budget: 1000 }
buy.budget += 300;
await ctx.store.put('media_buys', 'mb_1', buy);         // writes { budget: 1300 }

// Final: whichever wrote last. The other +N is lost.
```

This is the most common concurrency bug with document stores. Two ways to
avoid it:

### 1. Use `patch` for top-level field updates

`patch` is atomic at the **top-level field** in PostgresStateStore
(`data || partial` in the JSONB update clause does a **shallow** merge).
If two handlers `patch` different top-level fields, both survive. If they
patch the same top-level field, last writer wins.

**Shallow merge means nested objects still race.** The JSONB `||` operator
replaces top-level keys wholesale — it does not deep-merge nested objects.
So this is unsafe:

```ts
// Existing: { budget: { total: 1000, spent: 0 } }

// T1: patch({ budget: { total: 5000 } })   — overwrites budget entirely
// T2: patch({ budget: { spent: 100 } })    — overwrites budget entirely

// Final: whichever landed last. The other's budget field is gone.
```

If you need independent updates to nested fields, flatten the nested object
into separate top-level fields (`budget_total`, `budget_spent`), or split
the nested entity into its own row.

### 2. Split entities into separate rows

Prefer per-entity rows (`('media_buys', 'mb_1')`, `('packages', 'pkg_1')`)
over whole-session blobs (`('sessions', 'alice')` containing every field).
Per-entity rows bound the blast radius of a lost write.

## Whole-session blobs: why they're risky

A common pattern is to stuff all per-tenant state into one row:

```ts
const session = await ctx.store.get('sessions', ctx.sessionKey);
session.media_buys[id] = buy;
session.messages.push(message);
await ctx.store.put('sessions', ctx.sessionKey, session);
```

Every handler now reads the full session, mutates it, and writes it back.
Any two concurrent handlers for the same tenant can lose each other's
writes. The symptom is: "a message my handler appended is missing" or
"a media buy I just created isn't there."

If you must keep the blob layout, funnel all writes through a single
worker per `sessionKey`, or use [`patchWithRetry`](#optimistic-concurrency-patchwithretry)
for atomic read-modify-write.

## Per-session isolation

If every handler's state is scoped to a tenant/brand/publisher account, use
the session-scoping primitives instead of threading a key through every call:

```ts
import { createAdcpServer, scopedStore, requireSessionKey } from '@adcp/client/server';

const server = createAdcpServer({
  name: 'My Publisher', version: '1.0.0',
  stateStore,
  resolveSessionKey: ({ account }) => account?.tenant_id,
  mediaBuy: {
    createMediaBuy: async (params, ctx) => {
      const sessionKey = requireSessionKey(ctx);
      const store = scopedStore(ctx.store, sessionKey);

      // Scoped: isolated to this tenant. No cross-tenant leaks.
      await store.put('media_buys', 'mb_1', { status: 'active' });
      const { items } = await store.list('media_buys');
    },
  },
});
```

**Rules the scoped wrapper enforces:**

- `sessionKey` and `id` must be `[A-Za-z0-9_.-]{1,256}` — `:` is reserved as
  the scope-path separator.
- Every scoped write injects a `_session_key` field and every scoped read
  strips it. If you query the raw Postgres table yourself, you will see
  this column; omit it from your application view.
- Payloads that already contain `_session_key` are rejected at write time —
  rename that field in your document if you hit this.
- `list()` cursors are valid **only within the session** that produced them.
  Don't pass a cursor from session A to session B.

## Optimistic concurrency: `patchWithRetry`

For read-modify-write loops (counters, append-to-array, conditional state
machines) use `patchWithRetry`. Both built-in stores (`InMemoryStateStore`,
`PostgresStateStore`) track a monotonically increasing `version` per row so
updates can compare-and-swap.

### Which primitive when

- **Counter / accumulator** → `patchWithRetry`.
- **Idempotent "create if not exists"** → `putIfMatch(..., null)`, ignore conflict.
- **Guarded state transition** (e.g., "only archive if status=active") → `getWithVersion` + `putIfMatch` with custom retry logic.
- **Independent top-level fields** → plain `patch` is simpler and atomic at the field level (see above).

### `patchWithRetry` (recommended)

Handles the get → compute → putIfMatch → retry loop for you:

```ts
import { patchWithRetry } from '@adcp/client/server';

await patchWithRetry(ctx.store, 'media_buys', 'mb_1', current => ({
  ...(current ?? {}),
  budget_spent: (current?.budget_spent ?? 0) + cost,
}));
```

- Retries up to 5 times by default (jittered exponential backoff between attempts).
  Pass `{ maxAttempts: N, backoffMs: attempt => ... }` to tune.
- If an intervening writer bumps the row between your read and write,
  the closure runs again with the new pre-state.
- If the row is deleted between read and write, throws `PatchConflictError`
  with `reason: 'deleted_during_retry'` to avoid silently resurrecting it.
  Opt in to resurrection with `{ allowResurrection: true }`.
- Throws `PatchConflictError` after exhausting attempts — almost always
  means a hot row; split it into per-entity rows.
- Returning `null` from the update closure aborts without writing.

### `putIfMatch` (primitive)

If you want the raw primitive:

```ts
const current = await ctx.store.getWithVersion('media_buys', 'mb_1');
const next = { ...(current?.data ?? {}), status: 'approved' };
const result = await ctx.store.putIfMatch(
  'media_buys',
  'mb_1',
  next,
  current?.version ?? null
);
if (!result.ok) {
  // Someone else wrote first. result.currentVersion tells you what's there now.
  // Re-read and retry, or abort the operation.
}
```

- `expectedVersion: null` means "row must not exist" — insert-only.
- On success, `result.version` is the row's new version.
- On conflict, `result.currentVersion` is what the store has on disk
  (or `null` if the row doesn't exist at all).
- Both operands are validated the same as `put` (charset, size, reserved fields).

### Postgres migration

The `version` column is added by `getAdcpStateMigration()`; existing
databases pick it up via `ADD COLUMN IF NOT EXISTS`. Existing rows start
at version 1 — a seller's first `putIfMatch` against an existing row after
upgrade will see `currentVersion: 1`, the same shape as a freshly inserted
row. Treat the number as opaque; `patchWithRetry` handles both paths.

Do not attach triggers that suppress `UPDATE` or return `OLD` for the state
table — `putIfMatch` relies on affected-row count to detect conflicts, and
trigger-suppressed writes look identical to real conflicts. Same for RLS
policies that silently reject writes.
