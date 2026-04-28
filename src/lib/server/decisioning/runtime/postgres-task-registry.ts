/**
 * PostgreSQL-backed `TaskRegistry` for the v6.0 decisioning runtime.
 *
 * The default `createInMemoryTaskRegistry()` loses task state on process
 * restart and doesn't share state across instances behind a load balancer —
 * fine for tests and local dev, broken for production HITL paths
 * (`createMediaBuyTask`, `syncCreativesTask`, etc.). Wire this in via
 * `createAdcpServerFromPlatform({ taskRegistry: createPostgresTaskRegistry({ pool }) })`
 * to persist task lifecycle across requests, processes, and crashes.
 *
 * @example
 * ```typescript
 * import { Pool } from 'pg';
 * import {
 *   createAdcpServerFromPlatform,
 *   createPostgresTaskRegistry,
 *   getDecisioningTaskRegistryMigration,
 * } from '@adcp/client/server/decisioning';
 *
 * const pool = new Pool({ connectionString: process.env.DATABASE_URL });
 *
 * // Run once at boot — idempotent CREATE TABLE IF NOT EXISTS.
 * await pool.query(getDecisioningTaskRegistryMigration());
 *
 * const server = createAdcpServerFromPlatform(platform, {
 *   name: 'My Ad Network',
 *   version: '1.0.0',
 *   taskRegistry: createPostgresTaskRegistry({ pool }),
 * });
 * ```
 *
 * **Background-completion lifecycle.** `_registerBackground` / `awaitTask`
 * are PROCESS-LOCAL — promises don't serialize. When a HITL `*Task` method
 * is invoked, the returned promise lives on the originating process; if
 * that process restarts before the method completes, the task record stays
 * in `submitted` state in Postgres but no `awaitTask` resolution is
 * possible from a different instance. Production HITL flows that span
 * process boundaries should drive completion via webhook → an explicit
 * `complete()` / `fail()` call from the webhook handler, not via
 * `awaitTask`. The MCP `tasks/get` wire path reads via `getTask` and is
 * already cross-instance.
 *
 * Status: Preview / 6.0.
 *
 * @public
 */

import { randomUUID } from 'node:crypto';
import type { AdcpStructuredError, TaskHandoffProgress } from '../async-outcome';
import type { TaskRecord, TaskRegistry, TaskStatus } from './task-registry';

/**
 * Minimal subset of the `pg.Pool` interface used by the registry.
 * Mirrors `PgQueryable` in `postgres-task-store.ts` so callers can pass
 * pools, transaction wrappers, or any pg-compatible query executor.
 */
export interface PgQueryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}

export interface CreatePostgresTaskRegistryOptions {
  /** A `pg.Pool` instance (or any `PgQueryable`). */
  pool: PgQueryable;
  /**
   * Table name. Defaults to `'adcp_decisioning_tasks'` (vendor-prefixed to
   * avoid collisions with the MCP-level `adcp_mcp_tasks` table from
   * `PostgresTaskStore` and any consumer tables).
   *
   * Must match `^[a-z_][a-z0-9_]*$` — schema-qualified names are not
   * supported by this validator. Set search_path on the pool if you need
   * a non-default schema.
   */
  tableName?: string;
}

/** Default table name — vendor-prefixed to avoid collisions. */
const DEFAULT_TABLE = 'adcp_decisioning_tasks';

/** Validates a SQL identifier to prevent injection via table names. */
const VALID_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

function assertValidIdentifier(name: string): void {
  if (!VALID_IDENTIFIER.test(name)) {
    throw new Error(
      `Invalid table name "${name}": must be lowercase letters, digits, ` +
        `or underscores, starting with a letter or underscore.`
    );
  }
}

/**
 * Cap on `result` / `error` JSONB column size. Adopter `*Task` returns are
 * written verbatim — a buggy or malicious adopter handing back a 1GB
 * result would OOM the Node process before pg complains. 4MB matches the
 * default Postgres `toast` row threshold and gives plenty of headroom for
 * legitimate task payloads.
 *
 * **This cap protects the DB write path only.** Adopter code that
 * serializes `result` / `error` for logs, metrics, or downstream services
 * MUST impose its own size cap — `JSON.stringify(result)` in a logger
 * call is unbounded.
 */
const MAX_RESULT_BYTES = 4 * 1024 * 1024;

function assertResultSize(json: string, taskId: string): void {
  // `Buffer.byteLength` is utf-8 byte length, which is what Postgres stores.
  if (Buffer.byteLength(json, 'utf8') > MAX_RESULT_BYTES) {
    throw new Error(
      `Task ${taskId}: result/error JSON exceeds ${MAX_RESULT_BYTES} bytes ` +
        `(adopter *Task method returned an oversized payload — investigate ` +
        `whether the body should be persisted via blob storage and referenced).`
    );
  }
}

/**
 * Wrap `JSON.stringify` with a clearer error when the adopter `*Task`
 * return contains circular references. Default `TypeError: Converting
 * circular structure to JSON` doesn't surface the task id; this version
 * bubbles a registry-write error pointing at the adopter return shape.
 */
function safeStringify(value: unknown, taskId: string): string {
  try {
    return JSON.stringify(value);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Task ${taskId}: adopter *Task return is not JSON-serializable: ${msg}. ` +
        `Strip circular refs / non-plain-data before returning from your *Task method.`
    );
  }
}

/**
 * Generate the SQL DDL for the decisioning task registry table.
 *
 * Run once at boot (idempotent — `CREATE TABLE IF NOT EXISTS`). Constraint
 * and index names are derived from the table name to avoid collisions when
 * multiple registries share the same database.
 *
 * @example
 * ```typescript
 * import { getDecisioningTaskRegistryMigration } from '@adcp/client/server/decisioning';
 * await pool.query(getDecisioningTaskRegistryMigration());
 * await pool.query(getDecisioningTaskRegistryMigration({ tableName: 'my_tasks' }));
 * ```
 */
export function getDecisioningTaskRegistryMigration(options?: { tableName?: string }): string {
  const table = options?.tableName ?? DEFAULT_TABLE;
  assertValidIdentifier(table);
  return `
CREATE TABLE IF NOT EXISTS ${table} (
  task_id         TEXT PRIMARY KEY,
  tool            TEXT NOT NULL,
  account_id      TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'submitted',
  status_message  TEXT,
  result          JSONB,
  error           JSONB,
  progress        JSONB,
  has_webhook     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT ${table}_valid_status CHECK (
    -- Framework-written values: 'submitted' (initial), 'working'
    -- (after first updateProgress() call), 'completed' / 'failed'
    -- (terminal). The other 5 spec-defined states ('input-required',
    -- 'canceled', 'rejected', 'auth-required', 'unknown') are reserved
    -- for adopter-emitted transitions via the v6.1
    -- \`taskRegistry.transition()\` API; the v6.1 migration will widen
    -- this CHECK.
    status IN ('submitted', 'working', 'completed', 'failed')
  )
);

CREATE INDEX IF NOT EXISTS idx_${table}_account_id
  ON ${table}(account_id);

CREATE INDEX IF NOT EXISTS idx_${table}_status_created
  ON ${table}(status, created_at);
`.trim();
}

interface DbTaskRow {
  task_id: string;
  tool: string;
  account_id: string;
  status: TaskStatus;
  status_message: string | null;
  result: unknown;
  error: AdcpStructuredError | null;
  progress: TaskHandoffProgress | null;
  has_webhook: boolean;
  created_at: Date;
  updated_at: Date;
}

function rowToRecord<TResult>(row: DbTaskRow): TaskRecord<TResult> {
  return {
    taskId: row.task_id,
    tool: row.tool,
    accountId: row.account_id,
    status: row.status,
    ...(row.status_message !== null && { statusMessage: row.status_message }),
    ...(row.result !== null && row.result !== undefined && { result: row.result as TResult }),
    ...(row.error !== null && row.error !== undefined && { error: row.error }),
    ...(row.progress !== null && row.progress !== undefined && { progress: row.progress }),
    ...(row.has_webhook && { hasWebhook: true }),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * Build a Postgres-backed `TaskRegistry`.
 *
 * Idempotency: `complete()` and `fail()` are no-ops on already-terminal
 * tasks, matching `createInMemoryTaskRegistry()`. The terminal-state guard
 * is enforced via SQL `WHERE status = 'submitted'` predicates so concurrent
 * webhook deliveries can't race to overwrite each other.
 */
export function createPostgresTaskRegistry(opts: CreatePostgresTaskRegistryOptions): TaskRegistry {
  const table = opts.tableName ?? DEFAULT_TABLE;
  assertValidIdentifier(table);
  const pool = opts.pool;

  // Process-local background tracking — see file header note. Promises
  // can't be persisted; cross-instance HITL completion happens via
  // webhook → explicit complete()/fail(), not via awaitTask.
  const backgrounds = new Map<string, Promise<void>>();

  return {
    async create(createOpts: { tool: string; accountId: string; hasWebhook?: boolean }): Promise<{ taskId: string }> {
      const taskId = `task_${randomUUID()}`;
      await pool.query(
        `INSERT INTO ${table} (task_id, tool, account_id, status, has_webhook) VALUES ($1, $2, $3, 'submitted', $4)`,
        [taskId, createOpts.tool, createOpts.accountId, createOpts.hasWebhook === true]
      );
      return { taskId };
    },

    async getTask<TResult = unknown>(taskId: string): Promise<TaskRecord<TResult> | null> {
      const { rows } = await pool.query(
        `SELECT task_id, tool, account_id, status, status_message, result, error, progress, has_webhook, created_at, updated_at
         FROM ${table} WHERE task_id = $1`,
        [taskId]
      );
      if (rows.length === 0) return null;
      return rowToRecord<TResult>(rows[0] as unknown as DbTaskRow);
    },

    async complete<TResult>(taskId: string, result: TResult): Promise<void> {
      const json = safeStringify(result, taskId);
      assertResultSize(json, taskId);
      await pool.query(
        `UPDATE ${table}
         SET status = 'completed', result = $2::jsonb, updated_at = NOW()
         WHERE task_id = $1 AND status NOT IN ('completed', 'failed')`,
        [taskId, json]
      );
    },

    async fail(taskId: string, error: AdcpStructuredError): Promise<void> {
      const json = safeStringify(error, taskId);
      assertResultSize(json, taskId);
      await pool.query(
        `UPDATE ${table}
         SET status = 'failed', error = $2::jsonb, status_message = $3, updated_at = NOW()
         WHERE task_id = $1 AND status NOT IN ('completed', 'failed')`,
        [taskId, json, error.message]
      );
    },

    async updateProgress(taskId: string, progress: TaskHandoffProgress): Promise<void> {
      const json = safeStringify(progress, taskId);
      await pool.query(
        `UPDATE ${table}
         SET progress = $2::jsonb,
             status = CASE WHEN status = 'submitted' THEN 'working' ELSE status END,
             updated_at = NOW()
         WHERE task_id = $1 AND status NOT IN ('completed', 'failed')`,
        [taskId, json]
      );
    },

    _registerBackground(taskId: string, completion: Promise<void>): void {
      const composed: Promise<void> = completion.then(
        () => {
          if (backgrounds.get(taskId) === composed) backgrounds.delete(taskId);
        },
        () => {
          if (backgrounds.get(taskId) === composed) backgrounds.delete(taskId);
        }
      );
      backgrounds.set(taskId, composed);
    },

    async awaitTask(taskId: string): Promise<void> {
      const pending = backgrounds.get(taskId);
      if (pending) await pending;
    },
  } satisfies TaskRegistry;
}
