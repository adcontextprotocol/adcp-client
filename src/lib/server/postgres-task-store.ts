/**
 * PostgreSQL-backed TaskStore for distributed MCP servers.
 *
 * Replaces InMemoryTaskStore when running multiple server instances behind
 * a load balancer. Tasks are stored in a shared `mcp_tasks` table so any
 * instance can create, retrieve, or update a task regardless of which
 * instance handled the original request.
 *
 * @example
 * ```typescript
 * import { Pool } from 'pg';
 * import { PostgresTaskStore, serve, createTaskCapableServer } from '@adcp/client';
 *
 * const pool = new Pool({ connectionString: process.env.DATABASE_URL });
 * const taskStore = new PostgresTaskStore(pool);
 *
 * serve(({ taskStore }) => createTaskCapableServer('My Agent', '1.0.0', { taskStore }), {
 *   taskStore,
 * });
 * ```
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

/** Page size for listTasks pagination (matches InMemoryTaskStore). */
const PAGE_SIZE = 10;

/**
 * SQL DDL for the `mcp_tasks` table.
 *
 * Consumers should run this in their own migration system. The constant is
 * exported so they can copy it verbatim:
 *
 * ```typescript
 * import { MCP_TASKS_MIGRATION } from '@adcp/client';
 * await pool.query(MCP_TASKS_MIGRATION);
 * ```
 */
export const MCP_TASKS_MIGRATION = `
CREATE TABLE IF NOT EXISTS mcp_tasks (
  task_id         TEXT PRIMARY KEY,
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

  CONSTRAINT valid_task_status CHECK (
    status IN ('working', 'input_required', 'completed', 'failed', 'cancelled')
  )
);

CREATE INDEX IF NOT EXISTS idx_mcp_tasks_expires_at
  ON mcp_tasks(expires_at) WHERE expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_mcp_tasks_created_at
  ON mcp_tasks(created_at);
`.trim();

/** Row shape returned by SELECT queries on mcp_tasks. */
interface TaskRow {
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
 * `cleanupExpiredTasks()` periodically to reclaim storage.
 */
export class PostgresTaskStore implements TaskStore {
  constructor(private readonly db: PgQueryable) {}

  async createTask(
    taskParams: CreateTaskOptions,
    requestId: RequestId,
    request: Request,
    _sessionId?: string
  ): Promise<Task> {
    const taskId = randomBytes(16).toString('hex');
    const ttl = taskParams.ttl ?? null;
    const pollInterval = taskParams.pollInterval ?? 1000;

    const { rows } = await this.db.query(
      `INSERT INTO mcp_tasks (task_id, status, ttl, poll_interval, request_id, request, expires_at)
       VALUES ($1, 'working', $2, $3, $4, $5,
               CASE WHEN $2::integer IS NOT NULL
                    THEN NOW() + ($2::integer || ' milliseconds')::interval
                    ELSE NULL END)
       RETURNING *`,
      [taskId, ttl, pollInterval, String(requestId), JSON.stringify(request)]
    );

    return rowToTask(rows[0] as unknown as TaskRow);
  }

  async getTask(taskId: string, _sessionId?: string): Promise<Task | null> {
    const { rows } = await this.db.query(`SELECT * FROM mcp_tasks WHERE task_id = $1 AND ${NOT_EXPIRED}`, [taskId]);
    return rows.length > 0 ? rowToTask(rows[0] as unknown as TaskRow) : null;
  }

  async storeTaskResult(
    taskId: string,
    status: 'completed' | 'failed',
    result: Result,
    _sessionId?: string
  ): Promise<void> {
    // Atomic check-and-update: only modify if task exists and is non-terminal.
    const { rowCount, rows } = await this.db.query(
      `UPDATE mcp_tasks
       SET status = $2,
           result = $3,
           last_updated_at = NOW(),
           expires_at = CASE WHEN ttl IS NOT NULL
                             THEN NOW() + (ttl || ' milliseconds')::interval
                             ELSE NULL END
       WHERE task_id = $1
         AND status NOT IN ('completed', 'failed', 'cancelled')
         AND ${NOT_EXPIRED}
       RETURNING status`,
      [taskId, status, JSON.stringify(result)]
    );

    if (!rowCount || rows.length === 0) {
      // Distinguish "not found" / "expired" from "already terminal".
      const { rows: existing } = await this.db.query(
        `SELECT status FROM mcp_tasks WHERE task_id = $1 AND ${NOT_EXPIRED}`,
        [taskId]
      );
      if (existing.length === 0) {
        throw new Error(`Task with ID ${taskId} not found`);
      }
      throw new Error(
        `Cannot store result for task ${taskId} in terminal status '${existing[0]!.status}'. Task results can only be stored once.`
      );
    }
  }

  async getTaskResult(taskId: string, _sessionId?: string): Promise<Result> {
    const { rows } = await this.db.query(`SELECT result FROM mcp_tasks WHERE task_id = $1 AND ${NOT_EXPIRED}`, [
      taskId,
    ]);

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
    _sessionId?: string
  ): Promise<void> {
    // Atomic: only update if not already in a terminal state.
    const { rowCount, rows } = await this.db.query(
      `UPDATE mcp_tasks
       SET status = $2,
           status_message = COALESCE($3, status_message),
           last_updated_at = NOW(),
           expires_at = CASE
             WHEN $2 IN ('completed', 'failed', 'cancelled') AND ttl IS NOT NULL
               THEN NOW() + (ttl || ' milliseconds')::interval
             ELSE expires_at END
       WHERE task_id = $1
         AND status NOT IN ('completed', 'failed', 'cancelled')
         AND ${NOT_EXPIRED}
       RETURNING status`,
      [taskId, status, statusMessage ?? null]
    );

    if (!rowCount || rows.length === 0) {
      const { rows: existing } = await this.db.query(
        `SELECT status FROM mcp_tasks WHERE task_id = $1 AND ${NOT_EXPIRED}`,
        [taskId]
      );
      if (existing.length === 0) {
        throw new Error(`Task with ID ${taskId} not found`);
      }
      throw new Error(
        `Cannot update task ${taskId} from terminal status '${existing[0]!.status}' to '${status}'. Terminal states (completed, failed, cancelled) cannot transition to other states.`
      );
    }
  }

  async listTasks(cursor?: string, _sessionId?: string): Promise<{ tasks: Task[]; nextCursor?: string }> {
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

      ({ rows: rawRows } = await this.db.query(
        `SELECT *, created_at::text AS created_at_raw FROM mcp_tasks
         WHERE ${NOT_EXPIRED}
           AND (created_at, task_id) > ($1::timestamptz, $2)
         ORDER BY created_at, task_id
         LIMIT $3`,
        [cursorCreatedAt, cursorTaskId, PAGE_SIZE + 1]
      ));
    } else {
      ({ rows: rawRows } = await this.db.query(
        `SELECT *, created_at::text AS created_at_raw FROM mcp_tasks
         WHERE ${NOT_EXPIRED}
         ORDER BY created_at, task_id
         LIMIT $1`,
        [PAGE_SIZE + 1]
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
   * No-op — PostgresTaskStore has no timers or background processes.
   * Matches the cleanup() method that InMemoryTaskStore exposes.
   */
  cleanup(): void {
    // Nothing to clean up — no timers.
  }
}

/**
 * Delete expired tasks from the `mcp_tasks` table.
 *
 * Call this on a schedule (e.g., every 5 minutes) to reclaim storage.
 * Reads automatically filter expired rows, so this is purely a storage
 * optimization — not required for correctness.
 *
 * @returns The number of deleted rows.
 */
export async function cleanupExpiredTasks(db: PgQueryable): Promise<number> {
  const { rowCount } = await db.query(`DELETE FROM mcp_tasks WHERE expires_at IS NOT NULL AND expires_at <= NOW()`);
  return rowCount ?? 0;
}
