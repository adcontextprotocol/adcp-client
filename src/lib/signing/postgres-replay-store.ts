/**
 * PostgreSQL-backed `ReplayStore` for distributed AdCP verifier deployments.
 *
 * Replaces `InMemoryReplayStore` when running multiple verifier instances
 * behind a load balancer. The default in-memory store is per-process; a
 * signature captured by an attacker can be replayed against a sibling
 * instance whose cache hasn't seen the nonce. Sharing replay state via
 * Postgres closes that hole using a `(keyid, scope, nonce)` primary key
 * the verifier checks on every signed request.
 *
 * @example
 * ```typescript
 * import { Pool } from 'pg';
 * import { PostgresReplayStore, getReplayStoreMigration } from '@adcp/client/signing/server';
 *
 * const pool = new Pool({ connectionString: process.env.DATABASE_URL });
 * await pool.query(getReplayStoreMigration());          // run once at boot
 *
 * const replayStore = new PostgresReplayStore(pool);
 *
 * app.use(createExpressVerifier({
 *   capability: { ... },
 *   jwks,
 *   replayStore,                                        // <-- shared across instances
 *   resolveOperation: mcpToolNameResolver,
 * }));
 *
 * // Schedule the sweeper somewhere (cron, app timer, pg_cron, etc.):
 * setInterval(() => sweepExpiredReplays(pool).catch(console.error), 60_000);
 * ```
 *
 * Reuses the structural `PgQueryable` interface from `postgres-task-store`
 * so the SDK stays free of a hard `pg` dependency — callers pass any
 * pg-compatible query executor.
 */

import type { PgQueryable } from '../server/postgres-task-store';
import type { ReplayInsertResult, ReplayStore } from './replay';

const DEFAULT_TABLE = 'adcp_replay_cache';
const DEFAULT_CAP = 100_000;
const VALID_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/**
 * Reject non-finite or out-of-range timestamps before they reach Postgres.
 * `to_timestamp(NaN)` raises a parse error and `to_timestamp(±Infinity)`
 * silently produces an `infinity` timestamp — neither would lapse replay
 * protection, but a buggy `options.now()` injection point could DoS the
 * verifier with PG errors. Bound to JS-safe-integer territory; verifiers
 * pass UNIX seconds, not microseconds, so the upper bound is effectively
 * "year 9999 plus epsilon."
 */
function assertFiniteSeconds(label: string, value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new TypeError(`PostgresReplayStore: ${label} must be a finite non-negative number; received ${value}`);
  }
}

export interface PostgresReplayStoreOptions {
  /** Table name. Lowercase letters, digits, underscores only. Defaults to `adcp_replay_cache`. */
  tableName?: string;
  /**
   * Max retained (unexpired) nonces per `(keyid, scope)` pair before
   * `insert` returns `'rate_abuse'`. Mirrors `InMemoryReplayStore`'s
   * `maxEntriesPerKeyid`. Defaults to 100,000.
   *
   * The cap is **best-effort** under concurrency: two simultaneous inserts
   * at `cap-1` can both observe `n = cap-1` from the same MVCC snapshot
   * and both insert, briefly overshooting by one. This matches
   * `InMemoryReplayStore` semantics — the cap is a soft DoS guard, not a
   * hard invariant.
   */
  cap?: number;
}

/**
 * Pre-baked migration SQL for the default `adcp_replay_cache` table. Use
 * when callers don't need a custom table name. Mirrors the convention of
 * `MCP_TASKS_MIGRATION` (`postgres-task-store.ts`) and `ADCP_STATE_MIGRATION`
 * (`postgres-state-store.ts`).
 */
export const REPLAY_CACHE_MIGRATION: string = renderReplayStoreMigration(DEFAULT_TABLE);

/**
 * Generate the SQL DDL for the replay-cache table. Idempotent — safe to
 * run on existing tables. Run once at server startup, before constructing
 * `PostgresReplayStore`.
 *
 * Schema:
 * - `(keyid, scope, nonce)` is the primary key, so concurrent inserts of
 *   the same tuple serialize against the unique index — the second insert
 *   silently fails via `ON CONFLICT DO NOTHING`, which the adapter detects
 *   to return `'replayed'`.
 * - `expires_at` carries the per-row TTL since Postgres has no native TTL.
 *   Lookups filter `expires_at > now()`; expired rows are deleted by the
 *   exported {@link sweepExpiredReplays} helper which callers schedule
 *   themselves.
 */
export function getReplayStoreMigration(tableName: string = DEFAULT_TABLE): string {
  return renderReplayStoreMigration(tableName);
}

function renderReplayStoreMigration(tableName: string): string {
  if (!VALID_IDENTIFIER.test(tableName)) {
    throw new Error(`Invalid table name: "${tableName}". Must match /^[a-z_][a-z0-9_]*$/.`);
  }
  return `
    CREATE TABLE IF NOT EXISTS ${tableName} (
      keyid       TEXT NOT NULL,
      scope       TEXT NOT NULL,
      nonce       TEXT NOT NULL,
      expires_at  TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (keyid, scope, nonce)
    );

    CREATE INDEX IF NOT EXISTS idx_${tableName}_expires_at
      ON ${tableName}(expires_at);

    CREATE INDEX IF NOT EXISTS idx_${tableName}_keyid_scope_active
      ON ${tableName}(keyid, scope, expires_at);
  `;
}

export class PostgresReplayStore implements ReplayStore {
  private readonly db: PgQueryable;
  private readonly tableName: string;
  private readonly cap: number;

  constructor(db: PgQueryable, options: PostgresReplayStoreOptions = {}) {
    const tableName = options.tableName ?? DEFAULT_TABLE;
    if (!VALID_IDENTIFIER.test(tableName)) {
      throw new Error(`Invalid table name: "${tableName}". Must match /^[a-z_][a-z0-9_]*$/.`);
    }
    this.db = db;
    this.tableName = tableName;
    this.cap = options.cap ?? DEFAULT_CAP;
  }

  async has(keyid: string, scope: string, nonce: string, now: number): Promise<boolean> {
    assertFiniteSeconds('now', now);
    const result = await this.db.query(
      `SELECT 1 FROM ${this.tableName}
       WHERE keyid = $1 AND scope = $2 AND nonce = $3 AND expires_at > to_timestamp($4)
       LIMIT 1`,
      [keyid, scope, nonce, now]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async isCapHit(keyid: string, scope: string, now: number): Promise<boolean> {
    assertFiniteSeconds('now', now);
    const result = await this.db.query(
      `SELECT count(*)::bigint AS active FROM ${this.tableName}
       WHERE keyid = $1 AND scope = $2 AND expires_at > to_timestamp($3)`,
      [keyid, scope, now]
    );
    const row = result.rows[0] as { active: string | number } | undefined;
    if (!row) return false;
    // count(*)::bigint returns string in node-postgres by default; coerce.
    const active = typeof row.active === 'string' ? Number(row.active) : row.active;
    return active >= this.cap;
  }

  /**
   * Atomically check replay → cap → insert in a single MVCC-snapshotted
   * statement. Result precedence matches `InMemoryReplayStore`: replay
   * wins over rate_abuse wins over ok.
   *
   * Recycles expired rows in place via `ON CONFLICT DO UPDATE WHERE
   * existing-is-expired`. Without that, a same-nonce insert *after* the
   * previous registration's TTL elapsed (but before the sweeper ran)
   * would falsely report `'replayed'` — the sync `InMemoryReplayStore`
   * prunes expired entries before the existence check, so we have to
   * achieve the same semantics here without a separate prune step.
   *
   * The `RETURNING 1` is empty when (a) the cap blocked the insert
   * (`WHERE` clause filtered the conditional INSERT to zero rows) or
   * (b) the concurrent-same-nonce race lost — another transaction
   * inserted the same `(keyid, scope, nonce)` between this statement's
   * snapshot and our `ON CONFLICT`. Both branches are handled by the
   * outer `CASE`.
   */
  async insert(
    keyid: string,
    scope: string,
    nonce: string,
    ttlSeconds: number,
    now: number
  ): Promise<ReplayInsertResult> {
    assertFiniteSeconds('now', now);
    assertFiniteSeconds('ttlSeconds', ttlSeconds);
    const expiresAt = now + ttlSeconds;
    const result = await this.db.query(
      `WITH
        existing AS (
          SELECT 1 FROM ${this.tableName}
          WHERE keyid = $1 AND scope = $2 AND nonce = $3 AND expires_at > to_timestamp($4)
        ),
        active AS (
          SELECT count(*)::bigint AS n FROM ${this.tableName}
          WHERE keyid = $1 AND scope = $2 AND expires_at > to_timestamp($4)
        ),
        upsert AS (
          INSERT INTO ${this.tableName} (keyid, scope, nonce, expires_at)
          SELECT $1, $2, $3, to_timestamp($5)
          WHERE NOT EXISTS (SELECT 1 FROM existing)
            AND (SELECT n FROM active) < $6::bigint
          ON CONFLICT (keyid, scope, nonce) DO UPDATE
            SET expires_at = EXCLUDED.expires_at
            WHERE ${this.tableName}.expires_at <= to_timestamp($4)
          RETURNING 1
        )
      SELECT
        CASE
          WHEN EXISTS (SELECT 1 FROM existing) THEN 'replayed'
          WHEN (SELECT n FROM active) >= $6::bigint THEN 'rate_abuse'
          WHEN EXISTS (SELECT 1 FROM upsert) THEN 'ok'
          ELSE 'replayed'
        END AS result`,
      [keyid, scope, nonce, now, expiresAt, this.cap]
    );
    const row = result.rows[0] as { result: ReplayInsertResult } | undefined;
    if (!row) {
      throw new Error('PostgresReplayStore.insert: query returned no rows');
    }
    return row.result;
  }
}

export interface SweepExpiredReplaysOptions {
  /** Table name. Defaults to `adcp_replay_cache`. */
  tableName?: string;
  /** Current time in seconds (UNIX epoch). Defaults to `Date.now() / 1000`. */
  now?: number;
  /**
   * Limit the number of rows deleted per call. Useful for very large
   * tables where a single `DELETE` would lock the table too long. When
   * unset, deletes all expired rows in one statement.
   */
  batchSize?: number;
}

/**
 * Delete expired rows from the replay-cache table. Postgres has no native
 * TTL; callers schedule this helper themselves (cron, an app-side timer,
 * a `pg_cron` job, etc.).
 *
 * Returns the count of rows deleted, so callers can tune sweep frequency
 * against observed accumulation. A typical schedule is once per minute
 * for moderate-traffic verifiers; a hot-path verifier signing thousands
 * per second may want every 10–15 seconds.
 *
 * @example
 * ```typescript
 * setInterval(async () => {
 *   const { deleted } = await sweepExpiredReplays(pool);
 *   if (deleted > 0) metrics.replayCacheSweep(deleted);
 * }, 60_000);
 * ```
 */
export async function sweepExpiredReplays(
  db: PgQueryable,
  options: SweepExpiredReplaysOptions = {}
): Promise<{ deleted: number }> {
  const tableName = options.tableName ?? DEFAULT_TABLE;
  if (!VALID_IDENTIFIER.test(tableName)) {
    throw new Error(`Invalid table name: "${tableName}". Must match /^[a-z_][a-z0-9_]*$/.`);
  }
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const batchSize = options.batchSize;

  if (batchSize === undefined) {
    const result = await db.query(`DELETE FROM ${tableName} WHERE expires_at <= to_timestamp($1)`, [now]);
    return { deleted: result.rowCount ?? 0 };
  }
  // Bounded sweep — use a CTE to delete only `batchSize` rows. Useful when
  // the table has accumulated a long tail and a single DELETE would
  // hold a long table lock.
  const result = await db.query(
    `WITH expired AS (
      SELECT keyid, scope, nonce
      FROM ${tableName}
      WHERE expires_at <= to_timestamp($1)
      LIMIT $2
    )
    DELETE FROM ${tableName}
    USING expired
    WHERE ${tableName}.keyid = expired.keyid
      AND ${tableName}.scope = expired.scope
      AND ${tableName}.nonce = expired.nonce`,
    [now, batchSize]
  );
  return { deleted: result.rowCount ?? 0 };
}
