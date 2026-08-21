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
const DEFAULT_LEGACY_RETENTION_GRACE_SECONDS = 120;
const VALID_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
// The derived `idx_${table}_retain_until` identifier must also fit Postgres's
// 63-byte limit. All allowed characters are one byte, and the wrapper is 17.
const MAX_TABLE_NAME_LENGTH = 46;

export interface PgBackendOptions {
  /** Table name. Must be lowercase letters/digits/underscores. Defaults to `"adcp_idempotency"`. */
  tableName?: string;
  /**
   * Physical grace for rows written by pre-retainUntil SDKs. Must be at
   * least the store's clockSkewSeconds. Defaults to 120 seconds.
   */
  legacyRetentionGraceSeconds?: number;
}

function legacyRetentionGraceSeconds(options?: PgBackendOptions): number {
  const seconds = options?.legacyRetentionGraceSeconds ?? DEFAULT_LEGACY_RETENTION_GRACE_SECONDS;
  if (!Number.isSafeInteger(seconds) || seconds < 0) {
    throw new TypeError('legacyRetentionGraceSeconds must be a non-negative safe integer.');
  }
  return seconds;
}

function retentionExpression(seconds: number): string {
  return `GREATEST(COALESCE(retain_until, expires_at), expires_at + INTERVAL '${seconds} seconds')`;
}

/**
 * Validate a SQL identifier against the allowlist and return it quoted.
 * Centralizes the defense-in-depth check so every query uses a
 * consistently-quoted identifier — future edits to the allowlist only
 * have to happen here.
 */
function quoteIdent(name: string): string {
  if (!VALID_IDENTIFIER.test(name) || name.length > MAX_TABLE_NAME_LENGTH) {
    throw new Error(
      `Invalid SQL identifier "${name}": must match ${VALID_IDENTIFIER} and be at most ${MAX_TABLE_NAME_LENGTH} characters`
    );
  }
  return `"${name}"`;
}

function pgDatabaseError(operation: string, cause: unknown): Error {
  return new Error(`pgBackend.${operation}: database operation failed`, { cause });
}

/**
 * Generate the DDL for the idempotency table.
 *
 * @example
 * ```typescript
 * import { getIdempotencyMigration } from '@adcp/sdk/server';
 * await pool.query(getIdempotencyMigration());
 * ```
 */
export function getIdempotencyMigration(options?: PgBackendOptions): string {
  const tableName = options?.tableName ?? DEFAULT_TABLE;
  const table = quoteIdent(tableName);
  const indexTable = tableName; // already validated by quoteIdent, safe to interpolate
  legacyRetentionGraceSeconds(options);
  return `
CREATE TABLE IF NOT EXISTS ${table} (
  scoped_key    TEXT PRIMARY KEY,
  payload_hash  TEXT NOT NULL,
  response      JSONB NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  retain_until  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS retain_until TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_${indexTable}_retain_until
  ON ${table}(retain_until, expires_at);
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
 *
 * **Multi-agent namespace.** The official `serve()` path automatically adds
 * its canonical host to the idempotency principal before this backend sees a
 * key. Low-level integrations that bypass `serve()` and can receive the same
 * principal/key on multiple logical agents MUST use distinct `tableName`
 * values (or separate schemas/databases). Construct one store per logical
 * agent and pass the matching store to that agent's server factory:
 *
 * ```ts
 * await pool.query(getIdempotencyMigration({ tableName: 'seller_a_idempotency' }));
 * const sellerAIdempotency = createIdempotencyStore({
 *   backend: pgBackend(pool, { tableName: 'seller_a_idempotency' }),
 * });
 * ```
 *
 * Reusing one table without an equivalent trusted host discriminator can
 * replay one agent's cached response on another when their server-controlled
 * principal and buyer key collide.
 *
 * **Startup probe.** Call `store.probe()` (or `probeIdempotencyStore(store)`)
 * before your server starts accepting traffic to catch a bad `DATABASE_URL`
 * at boot rather than on the first mutating request. Wire it via:
 *
 * ```ts
 * serve(createAgent, {
 *   readinessCheck: () => store.probe(),
 * });
 * ```
 *
 * **Idle-client errors.** `pg.Pool` re-emits network drop / PG restart
 * errors on the pool itself. Without a listener, Node's `EventEmitter`
 * default-throws and crashes the process. Add one in your bootstrap:
 *
 * ```ts
 * pool.on('error', (err) => console.error('pg pool error', err));
 * ```
 */
export function pgBackend(db: PgQueryable, options: PgBackendOptions = {}): IdempotencyBackend {
  // tableName is trusted SDK config (compile-time / startup), not user input —
  // quoteIdent validates the identifier shape and is safe to interpolate.
  const table = quoteIdent(options.tableName ?? DEFAULT_TABLE);
  const legacyGraceSeconds = legacyRetentionGraceSeconds(options);
  const retention = retentionExpression(legacyGraceSeconds);
  const query = async (operation: string, text: string, values?: unknown[]): ReturnType<PgQueryable['query']> => {
    try {
      return await db.query(text, values);
    } catch (err) {
      throw pgDatabaseError(operation, err);
    }
  };

  return {
    legacyRetentionGraceSeconds: legacyGraceSeconds,
    async probe(): Promise<void> {
      try {
        // Name every runtime-required column so readiness fails before serving
        // mutations when an existing table has not run the current migration.
        await db.query(`SELECT scoped_key, payload_hash, response, expires_at, retain_until FROM ${table} LIMIT 0`);
      } catch (err) {
        throw new Error(
          `idempotency backend probe failed: cannot reach the "${options.tableName ?? DEFAULT_TABLE}" table. ` +
            `The pool is unreachable or the table has not been migrated — the server would advertise ` +
            `IdempotencySupported but every mutating call would fail. ` +
            `Run getIdempotencyMigration() to create the table, or check DATABASE_URL. ` +
            `See server logs for the underlying cause.`,
          { cause: err }
        );
      }
    },

    async get(scopedKey: string): Promise<IdempotencyCacheEntry | null> {
      const result = await query(
        'get',
        `SELECT payload_hash, response,
                EXTRACT(EPOCH FROM expires_at)::BIGINT AS expires_at,
                EXTRACT(EPOCH FROM ${retention})::BIGINT AS retain_until
         FROM ${table} WHERE scoped_key = $1`,
        [scopedKey]
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        payloadHash: row.payload_hash as string,
        response: row.response as unknown,
        expiresAt: Number(row.expires_at),
        retainUntil: Number(row.retain_until),
      };
    },

    async put(scopedKey: string, entry: IdempotencyCacheEntry): Promise<void> {
      await query(
        'put',
        `INSERT INTO ${table} (scoped_key, payload_hash, response, expires_at, retain_until)
         VALUES ($1, $2, $3::jsonb, TO_TIMESTAMP($4), TO_TIMESTAMP($5))
         ON CONFLICT (scoped_key) DO UPDATE SET
           payload_hash = EXCLUDED.payload_hash,
           response = EXCLUDED.response,
           expires_at = EXCLUDED.expires_at,
           retain_until = EXCLUDED.retain_until`,
        [
          scopedKey,
          entry.payloadHash,
          JSON.stringify(entry.response),
          entry.expiresAt,
          entry.retainUntil ?? entry.expiresAt,
        ]
      );
    },

    async putIfAbsent(scopedKey: string, entry: IdempotencyCacheEntry): Promise<boolean> {
      // Insert only if absent OR the existing row is expired — this lets a
      // stale claim from a crashed handler be reclaimed on retry.
      const result = await query(
        'putIfAbsent',
        `INSERT INTO ${table} (scoped_key, payload_hash, response, expires_at, retain_until)
         VALUES ($1, $2, $3::jsonb, TO_TIMESTAMP($4), TO_TIMESTAMP($5))
         ON CONFLICT (scoped_key) DO UPDATE SET
           payload_hash = EXCLUDED.payload_hash,
           response = EXCLUDED.response,
           expires_at = EXCLUDED.expires_at,
           retain_until = EXCLUDED.retain_until
         WHERE ${table}.expires_at < DATE_TRUNC('second', NOW())
         RETURNING scoped_key`,
        [
          scopedKey,
          entry.payloadHash,
          JSON.stringify(entry.response),
          entry.expiresAt,
          entry.retainUntil ?? entry.expiresAt,
        ]
      );
      return (result.rowCount ?? 0) > 0;
    },

    async replaceIfPayloadHash(
      scopedKey: string,
      expectedPayloadHash: string,
      entry: IdempotencyCacheEntry
    ): Promise<boolean> {
      const result = await query(
        'replaceIfPayloadHash',
        `UPDATE ${table}
         SET payload_hash = $3, response = $4::jsonb, expires_at = TO_TIMESTAMP($5)
             , retain_until = TO_TIMESTAMP($6)
         WHERE scoped_key = $1 AND payload_hash = $2
         RETURNING scoped_key`,
        [
          scopedKey,
          expectedPayloadHash,
          entry.payloadHash,
          JSON.stringify(entry.response),
          entry.expiresAt,
          entry.retainUntil ?? entry.expiresAt,
        ]
      );
      return (result.rowCount ?? 0) > 0;
    },

    async deleteIfPayloadHash(scopedKey: string, expectedPayloadHash: string): Promise<boolean> {
      const result = await query(
        'deleteIfPayloadHash',
        `DELETE FROM ${table} WHERE scoped_key = $1 AND payload_hash = $2 RETURNING scoped_key`,
        [scopedKey, expectedPayloadHash]
      );
      return (result.rowCount ?? 0) > 0;
    },

    async delete(scopedKey: string): Promise<void> {
      await query('delete', `DELETE FROM ${table} WHERE scoped_key = $1`, [scopedKey]);
    },
  };
}

/**
 * Delete expired entries. Run periodically (e.g., every hour) to bound
 * table size. Returns the number of rows deleted.
 */
export async function cleanupExpiredIdempotency(db: PgQueryable, options: PgBackendOptions = {}): Promise<number> {
  const table = quoteIdent(options.tableName ?? DEFAULT_TABLE);
  const graceSeconds = legacyRetentionGraceSeconds(options);
  let result: Awaited<ReturnType<PgQueryable['query']>>;
  try {
    result = await db.query(
      `DELETE FROM ${table}
       WHERE (
         retain_until IS NULL
         AND expires_at < DATE_TRUNC('second', NOW()) - INTERVAL '${graceSeconds} seconds'
       ) OR (
         retain_until IS NOT NULL
         AND retain_until < DATE_TRUNC('second', NOW())
         AND expires_at < DATE_TRUNC('second', NOW()) - INTERVAL '${graceSeconds} seconds'
       )`
    );
  } catch (err) {
    throw pgDatabaseError('cleanupExpiredIdempotency', err);
  }
  return result.rowCount ?? 0;
}
