/**
 * Postgres backend for the idempotency store.
 *
 * Stores one row per `(principal, key, [extraScope])` with the canonical
 * payload hash, the cached response (JSONB), and an `expires_at`
 * timestamp. Lookups index on `scoped_key` (PRIMARY KEY).
 *
 * **Atomicity caveat.** The middleware calls `check()` → handler →
 * `save()`. The `save()` write runs AFTER the handler commits its own
 * business writes, in a separate transaction. A crash between "handler
 * commits" and "save() commits" can leak side effects without an
 * idempotency row, so a retry re-executes. To get strict
 * exactly-once behavior, either:
 *
 * - Run the handler's business writes and the idempotency save in the
 *   same transaction (pass the transaction client as `PgQueryable` when
 *   constructing the backend for that request), OR
 * - Accept that a crash window exists and rely on the handler's own
 *   natural-key checks to dedup on retry.
 *
 * The middleware as-shipped does the latter. Callers who need the
 * former can construct a request-scoped `pgBackend(tx)` and pass it as
 * the idempotency store per-request.
 */

import type { IdempotencyBackend, IdempotencyCacheEntry } from '../store';
import type { PgQueryable } from '../../postgres-task-store';

const DEFAULT_TABLE = 'adcp_idempotency';
const VALID_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

export interface PgBackendOptions {
  /** Table name. Must be lowercase letters/digits/underscores. Defaults to `"adcp_idempotency"`. */
  tableName?: string;
}

/**
 * Validate a SQL identifier against the allowlist and return it quoted.
 * Centralizes the defense-in-depth check so every query uses a
 * consistently-quoted identifier — future edits to the allowlist only
 * have to happen here.
 */
function quoteIdent(name: string): string {
  if (!VALID_IDENTIFIER.test(name)) {
    throw new Error(`Invalid SQL identifier "${name}": must match ${VALID_IDENTIFIER}`);
  }
  return `"${name}"`;
}

/**
 * Generate the DDL for the idempotency table.
 *
 * @example
 * ```typescript
 * import { getIdempotencyMigration } from '@adcp/client/server';
 * await pool.query(getIdempotencyMigration());
 * ```
 */
export function getIdempotencyMigration(options?: PgBackendOptions): string {
  const tableName = options?.tableName ?? DEFAULT_TABLE;
  const table = quoteIdent(tableName);
  const indexTable = tableName; // already validated by quoteIdent, safe to interpolate
  return `
CREATE TABLE IF NOT EXISTS ${table} (
  scoped_key    TEXT PRIMARY KEY,
  payload_hash  TEXT NOT NULL,
  response      JSONB NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_${indexTable}_expires_at
  ON ${table}(expires_at);
`.trim();
}

/**
 * Backward-compatible constant using the default table name.
 */
export const IDEMPOTENCY_MIGRATION = getIdempotencyMigration();

/**
 * Create a Postgres-backed idempotency cache.
 *
 * Pass a connection pool (or any `PgQueryable`) and optionally a custom
 * table name. Run `getIdempotencyMigration()` once per deployment to
 * create the table.
 */
export function pgBackend(db: PgQueryable, options: PgBackendOptions = {}): IdempotencyBackend {
  const table = quoteIdent(options.tableName ?? DEFAULT_TABLE);

  return {
    async get(scopedKey: string): Promise<IdempotencyCacheEntry | null> {
      const result = await db.query(
        `SELECT payload_hash, response, EXTRACT(EPOCH FROM expires_at)::BIGINT AS expires_at FROM ${table} WHERE scoped_key = $1`,
        [scopedKey]
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        payloadHash: row.payload_hash as string,
        response: row.response as unknown,
        expiresAt: Number(row.expires_at),
      };
    },

    async put(scopedKey: string, entry: IdempotencyCacheEntry): Promise<void> {
      await db.query(
        `INSERT INTO ${table} (scoped_key, payload_hash, response, expires_at)
         VALUES ($1, $2, $3::jsonb, TO_TIMESTAMP($4))
         ON CONFLICT (scoped_key) DO UPDATE SET
           payload_hash = EXCLUDED.payload_hash,
           response = EXCLUDED.response,
           expires_at = EXCLUDED.expires_at`,
        [scopedKey, entry.payloadHash, JSON.stringify(entry.response), entry.expiresAt]
      );
    },

    async putIfAbsent(scopedKey: string, entry: IdempotencyCacheEntry): Promise<boolean> {
      // Insert only if absent OR the existing row is expired — this lets a
      // stale claim from a crashed handler be reclaimed on retry.
      const result = await db.query(
        `INSERT INTO ${table} (scoped_key, payload_hash, response, expires_at)
         VALUES ($1, $2, $3::jsonb, TO_TIMESTAMP($4))
         ON CONFLICT (scoped_key) DO UPDATE SET
           payload_hash = EXCLUDED.payload_hash,
           response = EXCLUDED.response,
           expires_at = EXCLUDED.expires_at
         WHERE ${table}.expires_at < NOW()
         RETURNING scoped_key`,
        [scopedKey, entry.payloadHash, JSON.stringify(entry.response), entry.expiresAt]
      );
      return (result.rowCount ?? 0) > 0;
    },

    async delete(scopedKey: string): Promise<void> {
      await db.query(`DELETE FROM ${table} WHERE scoped_key = $1`, [scopedKey]);
    },
  };
}

/**
 * Delete expired entries. Run periodically (e.g., every hour) to bound
 * table size. Returns the number of rows deleted.
 */
export async function cleanupExpiredIdempotency(
  db: PgQueryable,
  options: PgBackendOptions = {}
): Promise<number> {
  const table = quoteIdent(options.tableName ?? DEFAULT_TABLE);
  const result = await db.query(`DELETE FROM ${table} WHERE expires_at < NOW()`);
  return result.rowCount ?? 0;
}
