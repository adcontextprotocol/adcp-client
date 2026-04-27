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
import type { AdcpStructuredError } from '../async-outcome';
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
    throw new Error(`Invalid table name "${name}": must match ${VALID_IDENTIFIER}`);
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
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT ${table}_valid_status CHECK (
    -- Only the 3 framework-written values today. The other 6 spec-defined
    -- states ('working', 'input-required', 'canceled', 'rejected',
    -- 'auth-required', 'unknown') are reserved for adopter-emitted
    -- transitions via the v6.1 \`taskRegistry.transition()\` API; the
    -- v6.1 migration will widen this CHECK. Keeping it narrow today
    -- prevents adopters writing the other 6 directly via SQL from
    -- pinning tasks in non-terminal states the framework's
    -- \`complete()\`/\`fail()\` no-op against (their WHERE predicates
    -- match \`status='submitted'\`).
    status IN ('submitted', 'completed', 'failed')
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
    async create(createOpts: { tool: string; accountId: string }): Promise<{ taskId: string }> {
      const taskId = `task_${randomUUID()}`;
      await pool.query(
        `INSERT INTO ${table} (task_id, tool, account_id, status) VALUES ($1, $2, $3, 'submitted')`,
        [taskId, createOpts.tool, createOpts.accountId]
      );
      return { taskId };
    },

    async getTask<TResult = unknown>(taskId: string): Promise<TaskRecord<TResult> | null> {
      const { rows } = await pool.query(
        `SELECT task_id, tool, account_id, status, status_message, result, error, created_at, updated_at
         FROM ${table} WHERE task_id = $1`,
        [taskId]
      );
      if (rows.length === 0) return null;
      return rowToRecord<TResult>(rows[0] as unknown as DbTaskRow);
    },

    async complete<TResult>(taskId: string, result: TResult): Promise<void> {
      await pool.query(
        `UPDATE ${table}
         SET status = 'completed', result = $2::jsonb, updated_at = NOW()
         WHERE task_id = $1 AND status = 'submitted'`,
        [taskId, JSON.stringify(result)]
      );
    },

    async fail(taskId: string, error: AdcpStructuredError): Promise<void> {
      await pool.query(
        `UPDATE ${table}
         SET status = 'failed', error = $2::jsonb, status_message = $3, updated_at = NOW()
         WHERE task_id = $1 AND status = 'submitted'`,
        [taskId, JSON.stringify(error), error.message]
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
