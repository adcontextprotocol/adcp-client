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
 * import { PostgresReplayStore, getReplayStoreMigration } from '@adcp/sdk/signing/server';
 *
 * const pool = new Pool({ connectionString: process.env.DATABASE_URL });
 * // Run on every deploy before traffic; this idempotently upgrades the
 * // guarded-insert function as well as creating the table and indexes.
 * await pool.query(getReplayStoreMigration());
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
const REPLAY_ISOLATION_SQLSTATE = 'AD001';
const DEFAULT_CAP = 100_000;
const LOCK_RETRY_ATTEMPTS = 40;
const VALID_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const MAX_TABLE_NAME_LENGTH = 40;
const MAX_UNIX_SECONDS = 253_402_300_799; // 9999-12-31T23:59:59Z

function assertValidTableName(tableName: string): void {
  if (!VALID_IDENTIFIER.test(tableName) || tableName.length > MAX_TABLE_NAME_LENGTH) {
    throw new Error(
      `Invalid table name: "${tableName}". Must match /^[a-z_][a-z0-9_]*$/ and be at most ${MAX_TABLE_NAME_LENGTH} characters.`
    );
  }
}

/**
 * Reject non-finite or out-of-range timestamps before they reach Postgres.
 * `to_timestamp(NaN)` raises a parse error and `to_timestamp(±Infinity)`
 * silently produces an `infinity` timestamp — neither would lapse replay
 * protection, but a buggy `options.now()` injection point could DoS the
 * verifier with PG errors. Bound conservatively to year 9999, well within
 * PostgreSQL's `timestamptz` range and sufficient for UNIX epoch values.
 */
function assertFiniteSeconds(label: string, value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > MAX_UNIX_SECONDS) {
    throw new TypeError(`PostgresReplayStore: ${label} must be a finite non-negative number; received ${value}`);
  }
}

function replayDatabaseError(operation: string, cause: unknown): Error {
  return new Error(`PostgresReplayStore.${operation}: database operation failed`, { cause });
}

export interface PostgresReplayStoreOptions {
  /** Table name. Lowercase letters, digits, underscores; at most 40 characters. Defaults to `adcp_replay_cache`. */
  tableName?: string;
  /**
   * Max retained (unexpired) nonces per `(keyid, scope)` pair before
   * `insert` returns `'rate_abuse'`. Mirrors `InMemoryReplayStore`'s
   * `maxEntriesPerKeyid`. Defaults to 100,000.
   *
   * Inserts for the same `(keyid, scope)` are serialized with a PostgreSQL
   * advisory lock, so the cap remains a hard invariant under concurrency.
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
 * Generate the SQL DDL for the replay-cache table and guarded-insert function.
 * Idempotent — rerun on every deploy before constructing
 * `PostgresReplayStore`, including for existing tables.
 *
 * Schema:
 * - `(keyid, scope, nonce)` is the primary key. A table-specific function
 *   serializes each `(keyid, scope)` with a transaction advisory lock, checks
 *   replay and cap precedence, and recycles expired same-nonce rows atomically.
 * - `expires_at` carries the per-row TTL since Postgres has no native TTL.
 *   Lookups filter `expires_at > now()`; expired rows are deleted by the
 *   exported {@link sweepExpiredReplays} helper which callers schedule
 *   themselves.
 */
export function getReplayStoreMigration(tableName: string = DEFAULT_TABLE): string {
  return renderReplayStoreMigration(tableName);
}

function renderReplayStoreMigration(tableName: string): string {
  assertValidTableName(tableName);
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

    -- Keep the lock, replay check, cap check, and insert on one PostgreSQL
    -- backend even when the caller uses a query-only pool or PgBouncer. The
    -- transaction-scoped lock is released automatically at commit/rollback;
    -- as a VOLATILE PL/pgSQL function, each SQL command receives the current
    -- READ COMMITTED snapshot after the lock has been acquired.
    CREATE OR REPLACE FUNCTION ${tableName}_insert_guarded(
      p_keyid TEXT,
      p_scope TEXT,
      p_nonce TEXT,
      p_now DOUBLE PRECISION,
      p_expires_at DOUBLE PRECISION,
      p_cap BIGINT
    ) RETURNS TEXT
    LANGUAGE plpgsql
    VOLATILE
    AS $adcp_replay_guard$
    DECLARE
      active_count BIGINT;
    BEGIN
      IF current_setting('transaction_isolation') <> 'read committed' THEN
        RAISE EXCEPTION
          'adcp replay insertion requires READ COMMITTED transaction isolation'
          USING ERRCODE = '${REPLAY_ISOLATION_SQLSTATE}';
      END IF;

      IF NOT pg_try_advisory_xact_lock(
        hashtextextended(jsonb_build_array(p_keyid, p_scope)::text, 0)
      ) THEN
        RETURN 'lock_busy';
      END IF;

      IF EXISTS (
        SELECT 1 FROM ${tableName}
        WHERE keyid = p_keyid
          AND scope = p_scope
          AND nonce = p_nonce
          AND expires_at > to_timestamp(p_now)
      ) THEN
        RETURN 'replayed';
      END IF;

      SELECT count(*) INTO active_count
      FROM ${tableName}
      WHERE keyid = p_keyid
        AND scope = p_scope
        AND expires_at > to_timestamp(p_now);

      IF active_count >= p_cap THEN
        RETURN 'rate_abuse';
      END IF;

      INSERT INTO ${tableName} (keyid, scope, nonce, expires_at)
      VALUES (p_keyid, p_scope, p_nonce, to_timestamp(p_expires_at))
      ON CONFLICT (keyid, scope, nonce) DO UPDATE
        SET expires_at = EXCLUDED.expires_at
        WHERE ${tableName}.expires_at <= to_timestamp(p_now);

      IF FOUND THEN
        RETURN 'ok';
      END IF;
      RETURN 'replayed';
    END
    $adcp_replay_guard$;
  `;
}

export class PostgresReplayStore implements ReplayStore {
  private readonly db: PgQueryable;
  private readonly tableName: string;
  private readonly cap: number;

  constructor(db: PgQueryable, options: PostgresReplayStoreOptions = {}) {
    const tableName = options.tableName ?? DEFAULT_TABLE;
    assertValidTableName(tableName);
    this.db = db;
    this.tableName = tableName;
    this.cap = options.cap ?? DEFAULT_CAP;
    if (!Number.isSafeInteger(this.cap) || this.cap <= 0) {
      throw new Error(`PostgresReplayStore: cap must be a positive safe integer. Got ${this.cap}.`);
    }
  }

  private async query(operation: string, text: string, values?: unknown[]): ReturnType<PgQueryable['query']> {
    try {
      return await this.db.query(text, values);
    } catch (err) {
      throw replayDatabaseError(operation, err);
    }
  }

  async has(keyid: string, scope: string, nonce: string, now: number): Promise<boolean> {
    assertFiniteSeconds('now', now);
    const result = await this.query(
      'has',
      `SELECT 1 FROM ${this.tableName}
       WHERE keyid = $1 AND scope = $2 AND nonce = $3 AND expires_at > to_timestamp($4)
       LIMIT 1`,
      [keyid, scope, nonce, now]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async isCapHit(keyid: string, scope: string, now: number): Promise<boolean> {
    assertFiniteSeconds('now', now);
    const result = await this.query(
      'isCapHit',
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
   * Atomically check replay → cap → insert inside the migration-installed
   * PostgreSQL function. Result precedence matches `InMemoryReplayStore`:
   * replay wins over rate_abuse wins over ok.
   *
   * Recycles expired rows in place via `ON CONFLICT DO UPDATE WHERE
   * existing-is-expired`. Without that, a same-nonce insert *after* the
   * previous registration's TTL elapsed (but before the sweeper ran)
   * would falsely report `'replayed'` — the sync `InMemoryReplayStore`
   * prunes expired entries before the existence check, so we have to
   * achieve the same semantics here without a separate prune step.
   *
   * The function tries a transaction-scoped advisory lock before it reads.
   * Busy scopes retry outside the query, releasing pooled connections between
   * attempts so one hot signer cannot starve unrelated persistence work. Keeping
   * each attempt server-side preserves connection affinity for pools, transaction
   * wrappers, and transaction-pooling proxies alike. The function fails closed
   * outside READ COMMITTED, where an outer transaction's stale snapshot could
   * otherwise outlive a lock wait.
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
    assertFiniteSeconds('expiresAt', expiresAt);
    for (let attempt = 0; attempt <= LOCK_RETRY_ATTEMPTS; attempt++) {
      let result: Awaited<ReturnType<PgQueryable['query']>>;
      try {
        result = await this.db.query(
          `SELECT ${this.tableName}_insert_guarded($1, $2, $3, $4, $5, $6)::text AS result`,
          [keyid, scope, nonce, now, expiresAt, this.cap]
        );
      } catch (err) {
        if (typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '42883') {
          throw new Error(
            `PostgresReplayStore database migration is outdated: rerun getReplayStoreMigration("${this.tableName}") before serving traffic.`,
            { cause: err }
          );
        }
        if (typeof err === 'object' && err !== null && (err as { code?: unknown }).code === REPLAY_ISOLATION_SQLSTATE) {
          throw new Error('PostgresReplayStore.insert requires READ COMMITTED transaction isolation.', {
            cause: err,
          });
        }
        throw replayDatabaseError('insert', err);
      }

      const row = result.rows[0] as { result?: unknown } | undefined;
      if (!row) {
        throw new Error('PostgresReplayStore.insert: query returned no rows');
      }
      const guardedResult = row.result;
      if (
        guardedResult !== 'ok' &&
        guardedResult !== 'replayed' &&
        guardedResult !== 'rate_abuse' &&
        guardedResult !== 'lock_busy'
      ) {
        throw new Error('PostgresReplayStore.insert: guarded database function returned an unexpected value');
      }
      if (guardedResult !== 'lock_busy') return guardedResult;
      if (attempt === LOCK_RETRY_ATTEMPTS) {
        throw new Error('PostgresReplayStore.insert: replay scope remained busy after bounded lock retries');
      }

      // Linear bounded backoff with small jitter avoids a lock-step retry herd.
      const delayMs = Math.min(2 + attempt, 10) + Math.floor(Math.random() * 3);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
    throw new Error('PostgresReplayStore.insert: exhausted replay lock retries');
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
  assertValidTableName(tableName);
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const batchSize = options.batchSize;
  assertFiniteSeconds('sweep now', now);
  if (batchSize !== undefined && (!Number.isSafeInteger(batchSize) || batchSize <= 0)) {
    throw new TypeError('PostgresReplayStore: sweep batchSize must be a positive safe integer');
  }

  if (batchSize === undefined) {
    let result: Awaited<ReturnType<PgQueryable['query']>>;
    try {
      result = await db.query(`DELETE FROM ${tableName} WHERE expires_at <= to_timestamp($1)`, [now]);
    } catch (err) {
      throw replayDatabaseError('sweepExpiredReplays', err);
    }
    return { deleted: result.rowCount ?? 0 };
  }
  // Bounded sweep — use a CTE to delete only `batchSize` rows. Useful when
  // the table has accumulated a long tail and a single DELETE would
  // hold a long table lock.
  let result: Awaited<ReturnType<PgQueryable['query']>>;
  try {
    result = await db.query(
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
      AND ${tableName}.nonce = expired.nonce
      AND ${tableName}.expires_at <= to_timestamp($1)`,
      [now, batchSize]
    );
  } catch (err) {
    throw replayDatabaseError('sweepExpiredReplays', err);
  }
  return { deleted: result.rowCount ?? 0 };
}
