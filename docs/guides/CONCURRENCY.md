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
worker per `sessionKey`, or upgrade to optimistic concurrency once
`putIfMatch` lands (see below).

## Coming soon: optimistic concurrency

An RFC is open for `putIfMatch(collection, id, data, expectedVersion)` to
give sellers an atomic compare-and-swap primitive. That will let
read-modify-write loops retry on conflict instead of silently losing data.
Until then, prefer per-entity rows and `patch`.
