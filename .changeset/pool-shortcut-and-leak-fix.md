---
'@adcp/sdk': minor
---

Pool shortcut on `createAdcpServerFromPlatform`, real ctx_metadata strip-on-wire chokepoint, Postgres operations guide.

**`opts.pool` shortcut.** Pass a `pg.Pool` (or any `PgQueryable`) and the framework wires `idempotency` + `ctxMetadata` + `taskRegistry` internally with sensible defaults. Explicit per-store opts still win — pool fills only the unset ones. New `getAllAdcpMigrations()` returns combined DDL for all three tables.

```ts
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
await pool.query(getAllAdcpMigrations());

createAdcpServerFromPlatform(myPlatform, {
  name: '...', version: '...',
  pool,                                     // wires all three persistence stores
});
```

Slim skill `Run it` section updated to use the shortcut as the canonical bootstrap.

**Strip-on-wire chokepoint actually runs now.** Previous shipping (6.1.0) added `WireShape<T>` compile-time enforcement + `stripCtxMetadata` helper, but the runtime walk wasn't wired into the dispatch path — handler returns containing `ctx_metadata` flowed straight to the wire. Fix: `projectSync` (the single async-handler chokepoint every framework-derived tool dispatches through) now calls `stripCtxMetadata` after `mapResult` and before idempotency cache write. Mutates the response object in place; every handler builds a fresh response per call so this is safe.

Defense surfaces now covered:
- Compile-time: `WireShape<T>` strips at the type level
- Runtime: `stripCtxMetadata` shape-aware walk runs at the `projectSync` chokepoint
- Idempotency cache replay: strip runs BEFORE the cache write, so cached responses stay clean
- Symbol tag: retrieved blobs carry `[ADCP_INTERNAL_TAG]` (won't survive `JSON.stringify`)

New comprehensive negative test (`test/server-ctx-metadata-leak-paranoia.test.js`): builds a hostile platform that returns `ctx_metadata` on every resource at every nesting level, dispatches every wire tool, asserts no buyer-facing payload contains `LEAK_CANARY` or `ctx_metadata` anywhere. 9 tools × 3 leak detectors per tool. **This regression-blocks any future strip-bypass.**

**Postgres operations guide** at `docs/guides/POSTGRES.md`: schema + index rationale per table, sizing guidance, connection pool sizing, statement timeout recommendations, vacuum/autovacuum guidance, monitoring queries, cleanup cadence, multi-tenant deployment notes, backup/DR risk model. Closes the "how do implementors think about the database we ship?" gap.

223 tests passing on focused suite (added 9 leak paranoia + 3 pool shortcut).
