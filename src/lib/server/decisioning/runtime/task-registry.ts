/**
 * In-memory task registry for the v6.0 alpha runtime.
 *
 * Tracks tasks the platform creates via `ctx.startTask()` and consumes
 * via `taskHandle.notify(...)`. Replaces the implicit "platform built
 * its own opaque taskHandle" pattern from the prior commit.
 *
 * Wire-level `tasks/get` integration (so buyers can poll the task
 * lifecycle) is a separate concern — the registry exposes `getTask`
 * for test harnesses and downstream wiring; the AdCP `tasks/get`
 * handler is implemented elsewhere.
 *
 * Status: Preview / 6.0.
 *
 * @public
 */

import { randomUUID } from 'node:crypto';
import type { TaskHandle, TaskUpdate, AdcpStructuredError } from '../async-outcome';

export interface TaskRecord<TResult = unknown, TError extends AdcpStructuredError = AdcpStructuredError> {
  taskId: string;
  /** Tool name that started the task (e.g., 'create_media_buy'). */
  tool: string;
  /** Account that started the task — sessionKey-like for cross-request scoping. */
  accountId: string;
  /** Current lifecycle state. */
  status: 'submitted' | 'progress' | 'completed' | 'failed';
  /** Status message (latest progress note OR final-arm message). */
  statusMessage?: string;
  /** Partial result if the platform supplied one on `submitted({ partialResult })`. */
  partialResult?: TResult;
  /** Terminal result on `completed`. */
  result?: TResult;
  /** Terminal error on `failed`. */
  error?: TError;
  /** ISO 8601 timestamps. */
  createdAt: string;
  updatedAt: string;
}

export interface TaskRegistry {
  startTask<TResult>(opts: { tool: string; accountId: string; partialResult?: TResult }): TaskHandle<TResult>;
  getTask<TResult = unknown>(taskId: string): TaskRecord<TResult> | null;
  /**
   * Register a background completion promise (from `ctx.runAsync` post-timeout
   * await). Tests can `awaitTask(taskId)` to flush the deferred completion
   * deterministically; production callers don't need this.
   *
   * @internal
   */
  _registerBackground(taskId: string, completion: Promise<void>): void;
  /**
   * Await any registered background completion for a task. Resolves
   * immediately if no background is registered or the registered one
   * has already settled. Used by test harnesses + `tasks/get` integration.
   */
  awaitTask(taskId: string): Promise<void>;
}

/**
 * Build an in-memory task registry. Tasks are scoped per-server-instance
 * (created by `createAdcpServerFromPlatform`); not cross-process. Persistent
 * task state for production deployments wires through the
 * `Postgres` / `Redis` task store options on the existing framework — that
 * integration lands with the wire-level `tasks/get` work.
 */
export function createInMemoryTaskRegistry(): TaskRegistry {
  const tasks = new Map<string, TaskRecord<unknown>>();
  const backgrounds = new Map<string, Promise<void>>();

  return {
    startTask<TResult>(opts: { tool: string; accountId: string; partialResult?: TResult }): TaskHandle<TResult> {
      const taskId = `task_${randomUUID()}`;
      const now = new Date().toISOString();
      const record: TaskRecord<TResult> = {
        taskId,
        tool: opts.tool,
        accountId: opts.accountId,
        status: 'submitted',
        createdAt: now,
        updatedAt: now,
        ...(opts.partialResult !== undefined && { partialResult: opts.partialResult }),
      };
      tasks.set(taskId, record as TaskRecord<unknown>);

      return {
        taskId,
        notify(update: TaskUpdate<TResult>): void {
          const existing = tasks.get(taskId) as TaskRecord<TResult> | undefined;
          if (!existing) {
            // Task disappeared — ignore (idempotency-safe).
            return;
          }
          if (existing.status === 'completed' || existing.status === 'failed') {
            // Terminal lock-out; subsequent notifies are no-ops.
            return;
          }
          existing.updatedAt = new Date().toISOString();
          switch (update.kind) {
            case 'progress':
              existing.status = 'progress';
              if (update.status !== undefined) existing.statusMessage = update.status;
              break;
            case 'completed':
              existing.status = 'completed';
              existing.result = update.result;
              break;
            case 'failed':
              existing.status = 'failed';
              existing.error = update.error as AdcpStructuredError;
              existing.statusMessage = update.error.message;
              break;
          }
        },
      };
    },

    getTask<TResult = unknown>(taskId: string): TaskRecord<TResult> | null {
      const record = tasks.get(taskId);
      return (record as TaskRecord<TResult> | undefined) ?? null;
    },

    _registerBackground(taskId: string, completion: Promise<void>): void {
      // Compose the cleanup into the same chain, so awaiting the stored
      // promise also flushes the cleanup. Avoids a separate floating
      // `.finally` that would otherwise trip Node test runners' "promise
      // resolution still pending" detection.
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
