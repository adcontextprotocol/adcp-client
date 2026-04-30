/**
 * In-memory task registry for the v6.0 alpha runtime.
 *
 * The framework owns task lifecycle. When an adopter method returns a
 * `TaskHandoff` marker, the framework:
 *   1. Allocates a `taskId` and writes a `submitted` record.
 *   2. Returns the submitted envelope to the buyer immediately.
 *   3. Runs the handoff function in the background.
 *   4. Updates the record on progress (`updateProgress`) and terminal
 *      state (`complete` / `fail`) from the method's return/throw.
 *
 * Adopters never call into the registry directly. Wire-level `tasks/get`
 * integration (so buyers can poll the lifecycle) reads via `getTask`;
 * test harnesses use `awaitTask` to flush the background promise
 * deterministically.
 *
 * Status: Preview / 6.0.
 *
 * @public
 */

import { randomUUID } from 'node:crypto';
import type { AdcpStructuredError, TaskHandoffProgress } from '../async-outcome';

/**
 * AdCP-spec task lifecycle states. Mirrors `enums/task-status.json` —
 * the v6 framework writes `'submitted'` on create, transitions to
 * `'working'` on the first `updateProgress()` call, and terminates at
 * `'completed'` / `'failed'`. The other states (`'input-required'`,
 * `'canceled'`, `'rejected'`, `'auth-required'`, `'unknown'`) are
 * reserved for adopter-emitted transitions via the forthcoming
 * `taskRegistry.transition()` API (v6.1).
 */
export type TaskStatus =
  | 'submitted'
  | 'working'
  | 'input-required'
  | 'completed'
  | 'canceled'
  | 'failed'
  | 'rejected'
  | 'auth-required'
  | 'unknown';

export interface TaskRecord<TResult = unknown, TError extends AdcpStructuredError = AdcpStructuredError> {
  taskId: string;
  /** Tool name that started the task (e.g., 'create_media_buy'). */
  tool: string;
  /** Account that started the task — sessionKey-like for cross-request scoping. */
  accountId: string;
  /** Current lifecycle state — full AdCP-spec `task-status` enum. */
  status: TaskStatus;
  /** Status message on the final arm (`error.message` on failed). */
  statusMessage?: string;
  /** Terminal result on `completed`. */
  result?: TResult;
  /** Terminal error on `failed`. */
  error?: TError;
  /**
   * Intermediate progress from `TaskHandoffContext.update(...)` calls.
   * Written by the background handoff function; surfaced to buyers polling
   * `tasks_get` via the spec `progress` field.
   */
  progress?: TaskHandoffProgress;
  /**
   * Whether the buyer wired `push_notification_config.url` on the original
   * request. Surfaced to the buyer via `tasks_get`'s spec-defined
   * `has_webhook: boolean` field so they can decide between long-poll vs.
   * single-shot polling.
   */
  hasWebhook?: boolean;
  /** ISO 8601 timestamps. */
  createdAt: string;
  updatedAt: string;
}

// All read/write methods are async to accommodate storage-backed
// implementations (`createPostgresTaskRegistry`). The in-memory impl
// resolves immediately. The framework `await`s every call, so the
// in-memory case pays one microtask per dispatch — negligible.
export interface TaskRegistry {
  /**
   * Allocate a new task record. Returns the `taskId` the framework hands
   * to `platform.xxxTask(taskId, ...)`. Initial status is `submitted`.
   *
   * `hasWebhook: true` when the buyer wired `push_notification_config.url`
   * — surfaced via `tasks_get`'s `has_webhook` field. Defaults to `false`.
   */
  create(opts: { tool: string; accountId: string; hasWebhook?: boolean }): Promise<{ taskId: string }>;

  /** Read a task by id. Returns `null` if unknown. */
  getTask<TResult = unknown>(taskId: string): Promise<TaskRecord<TResult> | null>;

  /**
   * Mark a task `completed` with the method's return value. No-op if the
   * task is already terminal (idempotent).
   */
  complete<TResult>(taskId: string, result: TResult): Promise<void>;

  /**
   * Mark a task `failed` with the structured error. No-op if the task is
   * already terminal (idempotent).
   */
  fail(taskId: string, error: AdcpStructuredError): Promise<void>;

  /**
   * Record intermediate progress from `TaskHandoffContext.update(...)`.
   * Transitions the task from `'submitted'` → `'working'` on the first
   * call. No-op on already-terminal tasks. The `progress` payload is
   * written to the record and surfaced to buyers polling `tasks_get`.
   */
  updateProgress(taskId: string, progress: TaskHandoffProgress): Promise<void>;

  /**
   * Register the background completion promise the framework spawned for
   * the `*Task` invocation. Tests await this for deterministic settlement;
   * production callers don't need it.
   *
   * @internal
   */
  _registerBackground(taskId: string, completion: Promise<void>): void;

  /**
   * Await any registered background completion for a task. Resolves
   * immediately if no background is registered or it has already settled.
   * Used by test harnesses + `tasks/get` integration.
   */
  awaitTask(taskId: string): Promise<void>;
}

export function createInMemoryTaskRegistry(): TaskRegistry {
  const tasks = new Map<string, TaskRecord<unknown>>();
  const backgrounds = new Map<string, Promise<void>>();

  return {
    async create(opts: { tool: string; accountId: string; hasWebhook?: boolean }): Promise<{ taskId: string }> {
      const taskId = `task_${randomUUID()}`;
      const now = new Date().toISOString();
      tasks.set(taskId, {
        taskId,
        tool: opts.tool,
        accountId: opts.accountId,
        status: 'submitted',
        ...(opts.hasWebhook && { hasWebhook: true }),
        createdAt: now,
        updatedAt: now,
      });
      return { taskId };
    },

    async getTask<TResult = unknown>(taskId: string): Promise<TaskRecord<TResult> | null> {
      const record = tasks.get(taskId);
      return (record as TaskRecord<TResult> | undefined) ?? null;
    },

    async complete<TResult>(taskId: string, result: TResult): Promise<void> {
      const existing = tasks.get(taskId);
      if (!existing) return;
      if (existing.status === 'completed' || existing.status === 'failed') return;
      existing.status = 'completed';
      existing.result = result;
      existing.updatedAt = new Date().toISOString();
    },

    async fail(taskId: string, error: AdcpStructuredError): Promise<void> {
      const existing = tasks.get(taskId);
      if (!existing) return;
      if (existing.status === 'completed' || existing.status === 'failed') return;
      existing.status = 'failed';
      existing.error = error;
      existing.statusMessage = error.message;
      existing.updatedAt = new Date().toISOString();
    },

    async updateProgress(taskId: string, progress: TaskHandoffProgress): Promise<void> {
      const existing = tasks.get(taskId);
      if (!existing) return;
      if (existing.status === 'completed' || existing.status === 'failed') return;
      if (existing.status === 'submitted') existing.status = 'working';
      existing.progress = progress;
      existing.updatedAt = new Date().toISOString();
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
  };
}
