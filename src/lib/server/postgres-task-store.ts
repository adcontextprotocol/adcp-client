/**
 * PostgreSQL-backed TaskStore for distributed MCP servers.
 *
 * Replaces InMemoryTaskStore when running multiple server instances behind
 * a load balancer. Tasks are stored in a shared table so any instance can
 * create, retrieve, or update a task regardless of which instance handled
 * the original request.
 *
 * @example
 * ```typescript
 * import { Pool } from 'pg';
 * import {
 *   PostgresTaskStore,
 *   serve,
 *   createTaskCapableServer,
 *   verifyBearer,
 *   taskScopeFromPrincipal,
 * } from '@adcp/sdk';
 *
 * const pool = new Pool({ connectionString: process.env.DATABASE_URL });
 * const taskStore = new PostgresTaskStore(pool);
 *
 * serve(({ taskStore }) => createTaskCapableServer('My Agent', '1.0.0', { taskStore }), {
 *   taskStore,
 *   authenticate: verifyBearer({ jwksUri, issuer, audience }),
 *   taskScope: taskScopeFromPrincipal,
 * });
 * ```
 *
 * `serve()`'s legacy transport is stateless, so authenticated multi-caller
 * deployments use `taskScope` to bind every TaskStore call to a stable,
 * server-controlled principal. Direct TaskStore integrations pass that scope
 * through the `sessionId` argument on every client-facing operation.
 * Task-ID-only calls are reserved for trusted background workers; stateless
 * single-tenant servers may explicitly set `allowUnscopedAccess: true`.
 */

import { randomBytes } from 'node:crypto';
import { isTerminal } from '@modelcontextprotocol/sdk/experimental/tasks/interfaces.js';
import type { TaskStore, CreateTaskOptions } from '@modelcontextprotocol/sdk/experimental/tasks/interfaces.js';
import type { Task, RequestId, Result, Request } from '@modelcontextprotocol/sdk/types.js';

/**
 * Minimal subset of the `pg.Pool` interface used by PostgresTaskStore.
 *
 * Accepting this instead of a concrete Pool lets callers pass any
 * pg-compatible query executor (connection pools, transaction wrappers, etc.)
 * without forcing a hard dependency on the `pg` package.
 */
export interface PgQueryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}

/** Configuration for PostgresTaskStore. */
export interface PostgresTaskStoreOptions {
  /** Table name for task storage. Lowercase letters, digits, underscores; at most 40 characters. Defaults to `"adcp_mcp_tasks"`. */
  tableName?: string;
  /**
   * Permit task operations without a session ID. Unscoped listing includes
   * only unowned legacy/stateless tasks; task-ID operations act as privileged
   * capability access for background workers. Disabled by default because
   * callers cannot be isolated in a shared stateless namespace. Enable only
   * on a separate trusted-worker store or a trusted single-tenant server.
   */
  allowUnscopedAccess?: boolean;
}

/** Default table name — vendor-prefixed to avoid collisions in consumer databases. */
const DEFAULT_TABLE = 'adcp_mcp_tasks';

/** Validates a SQL identifier to prevent injection via table/constraint names. */
const VALID_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const MAX_TABLE_NAME_LENGTH = 40;
const MAX_POSTGRES_INTEGER = 2_147_483_647;

function assertValidTableName(tableName: string): void {
  if (!VALID_IDENTIFIER.test(tableName) || tableName.length > MAX_TABLE_NAME_LENGTH) {
    throw new Error(
      `Invalid table name "${tableName}": must match ${VALID_IDENTIFIER} and be at most ${MAX_TABLE_NAME_LENGTH} characters`
    );
  }
}

function assertNonNegativePostgresInteger(label: string, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > MAX_POSTGRES_INTEGER) {
    throw new TypeError(`${label} must be a non-negative PostgreSQL integer (0-${MAX_POSTGRES_INTEGER})`);
  }
}

function databaseOperationError(operation: string, cause: unknown): Error {
  return new Error(`PostgresTaskStore.${operation}: database operation failed`, { cause });
}

/** Page size for listTasks pagination (matches InMemoryTaskStore). */
const PAGE_SIZE = 10;

/**
 * Generate the SQL DDL for the task store table.
 *
 * Constraint and index names are derived from the table name to avoid
 * collisions when multiple stores share the same database.
 *
 * @example
 * ```typescript
 * import { getMcpTasksMigration } from '@adcp/sdk';
 * await pool.query(getMcpTasksMigration()); // creates adcp_mcp_tasks
 * await pool.query(getMcpTasksMigration({ tableName: 'my_tasks' })); // custom name
 * ```
 */
export function getMcpTasksMigration(options?: { tableName?: string }): string {
  const table = options?.tableName ?? DEFAULT_TABLE;
  assertValidTableName(table);
  return `
CREATE TABLE IF NOT EXISTS ${table} (
  task_id         TEXT PRIMARY KEY,
  session_id      TEXT,
  status          TEXT NOT NULL DEFAULT 'working',
  ttl             INTEGER,
  poll_interval   INTEGER NOT NULL DEFAULT 1000,
  status_message  TEXT,
  request_id      TEXT NOT NULL,
  request         JSONB NOT NULL,
  result          JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ,

  CONSTRAINT ${table}_valid_status CHECK (
    status IN ('working', 'input_required', 'completed', 'failed', 'cancelled')
  )
);

-- Upgrade tables created before session ownership was recorded. Existing rows
-- remain addressable by task ID, but are never exposed by session-scoped lists.
ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS session_id TEXT;

CREATE INDEX IF NOT EXISTS idx_${table}_expires_at
  ON ${table}(expires_at) WHERE expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_${table}_session_created_at
  ON ${table}(session_id, created_at, task_id);
`.trim();
}

/** Backward-compatible constant using the default table name. */
export const MCP_TASKS_MIGRATION = getMcpTasksMigration();

/** Row shape returned by SELECT queries. */
interface TaskRow {
  session_id: string | null;
  task_id: string;
  status: Task['status'];
  ttl: number | null;
  poll_interval: number;
  status_message: string | null;
  request_id: string;
  request: Record<string, unknown>;
  result: Record<string, unknown> | null;
  created_at: string;
  last_updated_at: string;
  expires_at: string | null;
}

/** Convert a database row to an MCP Task object. */
function rowToTask(row: TaskRow): Task {
  const task: Task = {
    taskId: row.task_id,
    status: row.status,
    ttl: row.ttl,
    createdAt: new Date(row.created_at).toISOString(),
    lastUpdatedAt: new Date(row.last_updated_at).toISOString(),
  };
  if (row.poll_interval != null) {
    task.pollInterval = row.poll_interval;
  }
  if (row.status_message != null) {
    task.statusMessage = row.status_message;
  }
  return task;
}

/** WHERE clause that filters out expired tasks. */
const NOT_EXPIRED = `(expires_at IS NULL OR expires_at > NOW())`;

/**
 * PostgreSQL-backed implementation of the MCP SDK TaskStore interface.
 *
 * All reads filter out expired tasks (via `expires_at`), so no background
 * timer is needed — expired tasks are simply invisible. Call
 * `cleanupExpired()` periodically to reclaim storage.
 */
export class PostgresTaskStore implements TaskStore {
  private readonly table: string;
  private readonly allowUnscopedAccess: boolean;

  constructor(
    private readonly db: PgQueryable,
    options?: PostgresTaskStoreOptions
  ) {
    this.table = options?.tableName ?? DEFAULT_TABLE;
    this.allowUnscopedAccess = options?.allowUnscopedAccess ?? false;
    assertValidTableName(this.table);
  }

  private assertScope(operation: string, sessionId?: string): void {
    if (!sessionId && !this.allowUnscopedAccess) {
      throw new Error(
        `PostgresTaskStore.${operation} requires a non-empty MCP session ID; set allowUnscopedAccess only on a trusted worker or single-tenant server`
      );
    }
  }

  private async query(operation: string, text: string, values?: unknown[]): ReturnType<PgQueryable['query']> {
    try {
      return await this.db.query(text, values);
    } catch (err) {
      throw databaseOperationError(operation, err);
    }
  }

  /**
   * Create a new task. Pass `taskParams.taskId` to use a caller-supplied ID verbatim
   * (useful for compliance-controller scenarios where the runner needs deterministic
   * task IDs). If omitted, a random hex ID is generated. Throws if the supplied ID
   * is empty / longer than 128 chars, or already exists. The 128-char ceiling is an
   * SDK policy (matches typical request-id / session-id field lengths and keeps
   * the task_id index efficient) — Postgres TEXT itself imposes no limit.
   *
   * Task IDs remain globally unique, as required by MCP. When a session ID is
   * supplied it is recorded as the task owner and enforced on session-bound
   * reads and writes. Calls that omit `sessionId` address a task by its
   * cryptographically random ID; this privileged/capability path is required by
   * MCP background workers, which receive only the task ID. Caller-supplied
   * IDs used without a session must therefore be unguessable.
   */
  async createTask(
    taskParams: CreateTaskOptions & { taskId?: string },
    requestId: RequestId,
    request: Request,
    sessionId?: string
  ): Promise<Task> {
    this.assertScope('createTask', sessionId);
    if (taskParams.taskId !== undefined) {
      if (typeof taskParams.taskId !== 'string' || taskParams.taskId.length === 0) {
        throw new Error('taskId must be a non-empty string when supplied');
      }
      if (taskParams.taskId.length > 128) {
        throw new Error(`taskId must be 128 characters or fewer (got ${taskParams.taskId.length})`);
      }
    }
    const taskId = taskParams.taskId ?? randomBytes(16).toString('hex');
    const ttl = taskParams.ttl ?? null;
    const pollInterval = taskParams.pollInterval ?? 1000;
    if (ttl !== null) assertNonNegativePostgresInteger('ttl', ttl);
    assertNonNegativePostgresInteger('pollInterval', pollInterval);

    try {
      const { rows } = await this.db.query(
        `INSERT INTO ${this.table} (session_id, task_id, status, ttl, poll_interval, request_id, request, expires_at)
         VALUES ($1, $2, 'working', $3, $4, $5, $6,
                 CASE WHEN $3::integer IS NOT NULL
                      THEN NOW() + ($3::integer || ' milliseconds')::interval
                      ELSE NULL END)
         RETURNING *`,
        [sessionId ?? null, taskId, ttl, pollInterval, String(requestId), JSON.stringify(request)]
      );

      return rowToTask(rows[0] as unknown as TaskRow);
    } catch (err) {
      // Unique constraint violation — a task with this ID already exists.
      if (typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505') {
        throw new Error(
          `Task with ID ${taskId} already exists. Use a different taskId or retrieve the existing task via getTask().`,
          { cause: err }
        );
      }
      throw databaseOperationError('createTask', err);
    }
  }

  async getTask(taskId: string, sessionId?: string): Promise<Task | null> {
    this.assertScope('getTask', sessionId);
    const sessionFilter = sessionId === undefined ? '' : 'AND session_id = $2';
    const values = sessionId === undefined ? [taskId] : [taskId, sessionId];
    const { rows } = await this.query(
      'getTask',
      `SELECT * FROM ${this.table} WHERE task_id = $1 ${sessionFilter} AND ${NOT_EXPIRED}`,
      values
    );
    return rows.length > 0 ? rowToTask(rows[0] as unknown as TaskRow) : null;
  }

  async storeTaskResult(
    taskId: string,
    status: 'completed' | 'failed',
    result: Result,
    sessionId?: string
  ): Promise<void> {
    this.assertScope('storeTaskResult', sessionId);
    // Atomic check-and-update: only modify if task exists and is non-terminal.
    const { rowCount, rows } = await this.query(
      'storeTaskResult',
      `UPDATE ${this.table}
       SET status = $2,
           result = $3,
           last_updated_at = NOW(),
           expires_at = CASE WHEN ttl IS NOT NULL
                             THEN NOW() + (ttl || ' milliseconds')::interval
                             ELSE NULL END
       WHERE task_id = $1
         AND ($4::text IS NULL OR session_id = $4)
         AND status NOT IN ('completed', 'failed', 'cancelled')
         AND ${NOT_EXPIRED}
       RETURNING status`,
      [taskId, status, JSON.stringify(result), sessionId ?? null]
    );

    if (!rowCount || rows.length === 0) {
      // Distinguish "not found" / "expired" from "already terminal".
      const { rows: existing } = await this.query(
        'storeTaskResult',
        `SELECT status FROM ${this.table}
         WHERE task_id = $1 AND ($2::text IS NULL OR session_id = $2) AND ${NOT_EXPIRED}`,
        [taskId, sessionId ?? null]
      );
      if (existing.length === 0) {
        throw new Error(`Task with ID ${taskId} not found`);
      }
      throw new Error(
        `Cannot store result for task ${taskId} in terminal status '${existing[0]!.status}'. Task results can only be stored once.`
      );
    }
  }

  async getTaskResult(taskId: string, sessionId?: string): Promise<Result> {
    this.assertScope('getTaskResult', sessionId);
    const { rows } = await this.query(
      'getTaskResult',
      `SELECT result FROM ${this.table}
       WHERE task_id = $1 AND ($2::text IS NULL OR session_id = $2) AND ${NOT_EXPIRED}`,
      [taskId, sessionId ?? null]
    );

    if (rows.length === 0) {
      throw new Error(`Task with ID ${taskId} not found`);
    }
    const row = rows[0]!;
    if (row.result == null) {
      throw new Error(`Task ${taskId} has no result stored`);
    }
    return row.result as Result;
  }

  async updateTaskStatus(
    taskId: string,
    status: Task['status'],
    statusMessage?: string,
    sessionId?: string
  ): Promise<void> {
    this.assertScope('updateTaskStatus', sessionId);
    // Atomic: only update if not already in a terminal state.
    const { rowCount, rows } = await this.query(
      'updateTaskStatus',
      `UPDATE ${this.table}
       SET status = $2,
           status_message = COALESCE($3, status_message),
           last_updated_at = NOW(),
           expires_at = CASE
             WHEN $2 IN ('completed', 'failed', 'cancelled') AND ttl IS NOT NULL
               THEN NOW() + (ttl || ' milliseconds')::interval
             ELSE expires_at END
       WHERE task_id = $1
         AND ($4::text IS NULL OR session_id = $4)
         AND status NOT IN ('completed', 'failed', 'cancelled')
         AND ${NOT_EXPIRED}
       RETURNING status`,
      [taskId, status, statusMessage ?? null, sessionId ?? null]
    );

    if (!rowCount || rows.length === 0) {
      const { rows: existing } = await this.query(
        'updateTaskStatus',
        `SELECT status FROM ${this.table}
         WHERE task_id = $1 AND ($2::text IS NULL OR session_id = $2) AND ${NOT_EXPIRED}`,
        [taskId, sessionId ?? null]
      );
      if (existing.length === 0) {
        throw new Error(`Task with ID ${taskId} not found`);
      }
      throw new Error(
        `Cannot update task ${taskId} from terminal status '${existing[0]!.status}' to '${status}'. Terminal states (completed, failed, cancelled) cannot transition to other states.`
      );
    }
  }

  async listTasks(cursor?: string, sessionId?: string): Promise<{ tasks: Task[]; nextCursor?: string }> {
    this.assertScope('listTasks', sessionId);
    const sessionValue = sessionId ?? null;
    let rawRows: Record<string, unknown>[];

    if (cursor) {
      // Decode cursor: "created_at|task_id" — split on first | only,
      // so task IDs containing | are handled correctly.
      const sepIndex = cursor.indexOf('|');
      if (sepIndex < 1) {
        throw new Error(`Invalid cursor: ${cursor}`);
      }
      const cursorCreatedAt = cursor.slice(0, sepIndex);
      const cursorTaskId = cursor.slice(sepIndex + 1);
      if (!cursorTaskId || isNaN(Date.parse(cursorCreatedAt))) {
        throw new Error(`Invalid cursor: ${cursor}`);
      }

      ({ rows: rawRows } = await this.query(
        'listTasks',
        `SELECT *, created_at::text AS created_at_raw FROM ${this.table}
         WHERE ${NOT_EXPIRED}
           AND session_id IS NOT DISTINCT FROM $3
           AND (created_at, task_id) > ($1::timestamptz, $2)
         ORDER BY created_at, task_id
         LIMIT $4`,
        [cursorCreatedAt, cursorTaskId, sessionValue, PAGE_SIZE + 1]
      ));
    } else {
      ({ rows: rawRows } = await this.query(
        'listTasks',
        `SELECT *, created_at::text AS created_at_raw FROM ${this.table}
         WHERE ${NOT_EXPIRED}
           AND session_id IS NOT DISTINCT FROM $1
         ORDER BY created_at, task_id
         LIMIT $2`,
        [sessionValue, PAGE_SIZE + 1]
      ));
    }

    const rows = rawRows as unknown as (TaskRow & { created_at_raw: string })[];
    const hasMore = rows.length > PAGE_SIZE;
    const pageRows = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
    const tasks = pageRows.map(rowToTask);

    let nextCursor: string | undefined;
    if (hasMore && pageRows.length > 0) {
      const last = pageRows[pageRows.length - 1]!;
      // Use the raw PostgreSQL text representation to preserve microsecond
      // precision. JavaScript Date only has millisecond precision, which
      // causes keyset pagination to re-include rows when multiple tasks
      // share the same millisecond.
      nextCursor = `${last.created_at_raw}|${last.task_id}`;
    }

    return { tasks, nextCursor };
  }

  /**
   * Delete expired tasks from the table.
   *
   * Call this on a schedule (e.g., every 5 minutes) to reclaim storage.
   * Reads automatically filter expired rows, so this is purely a storage
   * optimization — not required for correctness.
   *
   * @returns The number of deleted rows.
   */
  async cleanupExpired(): Promise<number> {
    const { rowCount } = await this.query(
      'cleanupExpired',
      `DELETE FROM ${this.table} WHERE expires_at IS NOT NULL AND expires_at <= NOW()`
    );
    return rowCount ?? 0;
  }

  /**
   * No-op — PostgresTaskStore has no timers or background processes.
   * Matches the cleanup() method that InMemoryTaskStore exposes.
   */
  cleanup(): void {
    // Nothing to clean up — no timers.
  }
}

/**
 * Delete expired tasks from the task store table.
 *
 * Standalone version of `PostgresTaskStore.cleanupExpired()` for use
 * without a store instance.
 *
 * @returns The number of deleted rows.
 */
export async function cleanupExpiredTasks(db: PgQueryable, tableName: string = DEFAULT_TABLE): Promise<number> {
  assertValidTableName(tableName);
  let rowCount: number | null;
  try {
    ({ rowCount } = await db.query(`DELETE FROM ${tableName} WHERE expires_at IS NOT NULL AND expires_at <= NOW()`));
  } catch (err) {
    throw databaseOperationError('cleanupExpiredTasks', err);
  }
  return rowCount ?? 0;
}
