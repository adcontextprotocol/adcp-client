/**
 * Postgres backend for `CtxMetadataStore`.
 *
 * Stores one row per `(account_id, kind, id)` flattened to
 * `scoped_key TEXT PRIMARY KEY` with the JSONB `value`, the JSONB
 * `resource` (framework-owned wire shape for auto-hydration), and an
 * optional `expires_at` timestamp. `bulkGet` uses `ANY($1::text[])` to
 * avoid dynamic SQL expansion and parameter-count limits.
 *
 * **Cleanup contract.** No auto-eviction. Adopters running with
 * row-level `expires_at` should periodically call
 * `cleanupExpiredCtxMetadata(db)` to bound table size — Postgres
 * performance dies before disk does, so monitor row count.
 *
 * **Migration on upgrade.** The `resource` column was added to the
 * default migration; deployments that originally ran the older
 * `getCtxMetadataMigration()` must re-run it after upgrading. The new
 * migration is idempotent (`ALTER TABLE … ADD COLUMN IF NOT EXISTS`)
 * and additive — existing rows get `NULL` for `resource`, which the
 * framework treats as "not yet hydrated" (next read of the same
 * resource by ID will repopulate it).
 *
 * @example
 * ```ts
 * import { Pool } from 'pg';
 * import {
 *   createCtxMetadataStore,
 *   pgCtxMetadataStore,
 *   getCtxMetadataMigration,
 * } from '@adcp/sdk/server';
 *
 * const pool = new Pool({ connectionString: process.env.DATABASE_URL });
 * await pool.query(getCtxMetadataMigration());
 *
 * const ctxMetadata = createCtxMetadataStore({ backend: pgCtxMetadataStore(pool) });
 * ```
 */

import type { CtxMetadataBackend, CtxMetadataEntry } from '../store';
import type { PgQueryable } from '../../postgres-task-store';

const DEFAULT_TABLE = 'adcp_ctx_metadata';
const VALID_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

export interface PgCtxMetadataBackendOptions {
  /** Table name. Must be lowercase letters/digits/underscores. Defaults to `"adcp_ctx_metadata"`. */
  tableName?: string;
}

function quoteIdent(name: string): string {
  if (!VALID_IDENTIFIER.test(name)) {
    throw new Error(`Invalid SQL identifier "${name}": must match ${VALID_IDENTIFIER}`);
  }
  return `"${name}"`;
}

/**
 * DDL for the ctx-metadata table. Run once per deployment from your bootstrap.
 *
 * @example
 * ```ts
 * await pool.query(getCtxMetadataMigration());
 * ```
 */
export function getCtxMetadataMigration(options?: PgCtxMetadataBackendOptions): string {
  const tableName = options?.tableName ?? DEFAULT_TABLE;
  const table = quoteIdent(tableName);
  const indexTable = tableName;
  // ALTER TABLE … ADD COLUMN IF NOT EXISTS is the idempotent upgrade
  // path for deployments that ran a pre-7.9 migration without the
  // `resource` column. No-op on fresh tables (column already exists
  // from CREATE TABLE); adds the column on existing tables.
  return `
CREATE TABLE IF NOT EXISTS ${table} (
  scoped_key  TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  resource    JSONB,
  expires_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS resource JSONB;

CREATE INDEX IF NOT EXISTS idx_${indexTable}_expires_at
  ON ${table}(expires_at)
  WHERE expires_at IS NOT NULL;
`.trim();
}

export const CTX_METADATA_MIGRATION = getCtxMetadataMigration();

/**
 * Create a Postgres-backed ctx-metadata cache.
 *
 * Pass a connection pool (or any `PgQueryable`) and optionally a custom
 * table name. Run `getCtxMetadataMigration()` once per deployment.
 *
 * **Startup probe.** Call `store.probe()` (via `serve()`'s
 * `readinessCheck`) before accepting traffic to catch a bad
 * `DATABASE_URL` at boot rather than on the first ctx_metadata write.
 */
export function pgCtxMetadataStore(db: PgQueryable, options: PgCtxMetadataBackendOptions = {}): CtxMetadataBackend {
  const table = quoteIdent(options.tableName ?? DEFAULT_TABLE);

  return {
    async probe(): Promise<void> {
      try {
        await db.query(`SELECT 1 FROM ${table} LIMIT 0`);
      } catch (err) {
        const cause = err instanceof Error ? err.message : String(err);
        throw new Error(
          `ctx_metadata backend probe failed: cannot reach the "${options.tableName ?? DEFAULT_TABLE}" table. ` +
            `Run getCtxMetadataMigration() to create it, or check DATABASE_URL. Cause: ${cause}`
        );
      }
    },

    async get(scopedKey: string): Promise<CtxMetadataEntry | null> {
      const result = await db.query(
        `SELECT value, resource, EXTRACT(EPOCH FROM expires_at)::BIGINT AS expires_at
           FROM ${table} WHERE scoped_key = $1`,
        [scopedKey]
      );
      const row = result.rows[0];
      if (!row) return null;
      const entry: CtxMetadataEntry = { value: row.value as unknown };
      // `resource` is omitted (not set to undefined) when null in the
      // column — keeps the JS object shape identical to the memory and
      // Redis backends for tests that compare via `assert.deepEqual`.
      if (row.resource != null) entry.resource = row.resource as unknown;
      if (row.expires_at != null) entry.expiresAt = Number(row.expires_at);
      return entry;
    },

    async bulkGet(scopedKeys: readonly string[]): Promise<Map<string, CtxMetadataEntry>> {
      if (scopedKeys.length === 0) return new Map();
      const result = await db.query(
        `SELECT scoped_key, value, resource, EXTRACT(EPOCH FROM expires_at)::BIGINT AS expires_at
           FROM ${table}
           WHERE scoped_key = ANY($1::text[])`,
        [scopedKeys]
      );
      const out = new Map<string, CtxMetadataEntry>();
      for (const row of result.rows) {
        const entry: CtxMetadataEntry = { value: row.value as unknown };
        if (row.resource != null) entry.resource = row.resource as unknown;
        if (row.expires_at != null) entry.expiresAt = Number(row.expires_at);
        out.set(row.scoped_key as string, entry);
      }
      return out;
    },

    async put(scopedKey: string, entry: CtxMetadataEntry): Promise<void> {
      // Always pass all four params; CASE expressions handle NULL casts
      // because raw `null::jsonb` would produce JSON 'null' (not SQL
      // NULL) and `TO_TIMESTAMP(NULL)` raises. Keeps the SQL static
      // and avoids the conditional-clause complexity that grew with
      // the `resource` field.
      await db.query(
        `INSERT INTO ${table} (scoped_key, value, resource, expires_at)
         VALUES (
           $1,
           $2::jsonb,
           CASE WHEN $3::text IS NULL THEN NULL ELSE $3::jsonb END,
           CASE WHEN $4::bigint IS NULL THEN NULL ELSE TO_TIMESTAMP($4::bigint) END
         )
         ON CONFLICT (scoped_key) DO UPDATE SET
           value = EXCLUDED.value,
           resource = EXCLUDED.resource,
           expires_at = EXCLUDED.expires_at,
           updated_at = NOW()`,
        [
          scopedKey,
          JSON.stringify(entry.value),
          entry.resource !== undefined ? JSON.stringify(entry.resource) : null,
          entry.expiresAt ?? null,
        ]
      );
    },

    async delete(scopedKey: string): Promise<void> {
      await db.query(`DELETE FROM ${table} WHERE scoped_key = $1`, [scopedKey]);
    },
  };
}

/**
 * Delete entries whose `expires_at` is past. Run periodically (e.g.,
 * hourly) to bound table size for adopters using row-level TTLs.
 * Returns the number of rows deleted.
 */
export async function cleanupExpiredCtxMetadata(
  db: PgQueryable,
  options: PgCtxMetadataBackendOptions = {}
): Promise<number> {
  const table = quoteIdent(options.tableName ?? DEFAULT_TABLE);
  const result = await db.query(`DELETE FROM ${table} WHERE expires_at IS NOT NULL AND expires_at < NOW()`);
  return result.rowCount ?? 0;
}
