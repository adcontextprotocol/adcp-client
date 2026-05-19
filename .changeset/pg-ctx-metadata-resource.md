---
'@adcp/sdk': minor
---

fix(server): `pgCtxMetadataStore` now persists the framework-owned `resource` field on every backend op

Closes adcp-client#1859. The pg backend at `src/lib/server/ctx-metadata/backends/pg.ts` was silently dropping `CtxMetadataEntry.resource` on read AND write, while the memory and Redis siblings preserved it. An adopter swapping pg ↔ memory ↔ Redis would see different auto-hydration behavior on string-id references: with pg, `resource` came back `undefined` on every read; the framework's hydration path fell through to "resource not cached" and re-fetched. With Redis (just landed in #1858), `resource` round-trips correctly, so adopters who switched substrates would silently regain hydration behavior — looking like a Redis-specific gain.

**Fix.** Three changes in one place:

- **Migration adds `resource JSONB` column.** `getCtxMetadataMigration()` now emits `CREATE TABLE` with `resource JSONB` plus an `ALTER TABLE … ADD COLUMN IF NOT EXISTS` clause for adopters running an older migration. Idempotent on fresh tables (column already exists), additive on existing tables (column added, existing rows get NULL).
- **`get` + `bulkGet` round-trip the field.** SELECT now includes `resource`; the returned `CtxMetadataEntry` carries `resource` when the row column is non-NULL and omits the key entirely otherwise — matches the memory + Redis backends' object shape for `assert.deepEqual` tests.
- **`put` writes the field via static SQL + CASE expressions.** Replaces the dynamic `expiresAtClause` builder that grew conditional `params.push()` calls; new shape passes all four params unconditionally and uses `CASE WHEN $N::text IS NULL THEN NULL ELSE $N::jsonb END` to avoid `null::jsonb` producing JSON 'null' (not SQL NULL) and `TO_TIMESTAMP(NULL)` raising.

**Migration on upgrade.** Adopters running a pre-7.9 `getCtxMetadataMigration()` must re-run it after upgrading. The new migration is idempotent — `CREATE TABLE IF NOT EXISTS` and `ALTER TABLE … ADD COLUMN IF NOT EXISTS` mean it's safe to re-apply on every boot. Existing rows get `NULL` for `resource`, which the framework treats as "not yet hydrated" (next read of the same resource by ID will repopulate it via the normal hydration path).

**Test coverage.** 13 new integration tests in `test/lib/ctx-metadata-pg.test.js` (skipped without `DATABASE_URL`) covering: migration creates the column, migration is idempotent, migration upgrades a pre-7.9 table, `put`/`get`/`bulkGet` round-trip `resource`, entries without `resource` omit the key on read (no `undefined` leakage), `put` overwrites resource on conflict, `put` can clear a previously-set resource, expiry round-trip, unicode/nested resource shapes, `cleanupExpiredCtxMetadata` still works against the new schema. All 13 pass against local Postgres. Full ctx-metadata suite (pg + Redis + memory = 65 tests) passes.

**Why minor (not patch).** The migration changes the published `getCtxMetadataMigration()` output. Adopters must re-run it on upgrade to get the column; deployments that don't will fail at the first `get` (the SELECT references a missing column). The behavior change is observable, so the version bump reflects that — not a breaking change in the API surface, but a breaking change in the operational contract.
