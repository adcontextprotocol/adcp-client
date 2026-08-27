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
 * integration (so buyers can poll the lifecycle) reads via scoped `getTask`;
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

const TERMINAL_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set(['completed', 'failed', 'rejected', 'canceled']);

function isTerminalTaskStatus(status: TaskStatus): boolean {
  return TERMINAL_TASK_STATUSES.has(status);
}

export interface TaskRecord<TResult = unknown, TError extends AdcpStructuredError = AdcpStructuredError> {
  taskId: string;
  /** Tool name that started the task (e.g., 'create_media_buy'). */
  tool: string;
  /** Account that started the task — sessionKey-like for cross-request scoping. */
  accountId: string;
  /** Tenant/principal owner scope used with accountId for list/read isolation. */
  ownerScope?: string;
  /** Current lifecycle state — full AdCP-spec `task-status` enum. */
  status: TaskStatus;
  /** Status message on the final arm (`error.message` on failed). */
  statusMessage?: string;
  /** Canonical terminal artifact on `completed`, `failed`, or `rejected`. */
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

export interface TaskRegistryListOptions {
  accountId: string;
  /** Caller ownership scope derived from authenticated server context. */
  ownerScope: string;
}

/** Account/principal boundary required for buyer-visible task access. */
export interface TaskRegistryScope {
  accountId: string;
  ownerScope: string;
}

/** Defense-in-depth boundary check for custom registry results. */
export function taskRecordMatchesScope(record: TaskRecord, scope: TaskRegistryScope): boolean {
  if (record.accountId !== scope.accountId) return false;
  return (
    record.ownerScope === scope.ownerScope ||
    (record.ownerScope === undefined && scope.ownerScope === `account:${scope.accountId}`)
  );
}

function taskStorageKey(taskId: string, scope: TaskRegistryScope): string {
  return JSON.stringify([scope.accountId, scope.ownerScope, taskId]);
}

export interface TaskRegistryListResult<TResult = unknown> {
  tasks: TaskRecord<TResult>[];
}

// All read/write methods are async to accommodate storage-backed
// implementations (`createPostgresTaskRegistry`). The in-memory impl
// resolves immediately. The framework `await`s every call, so the
// in-memory case pays one microtask per dispatch — negligible.
export interface TaskRegistry {
  /** Confirms that lifecycle methods use the account/principal-scoped v1 signatures. */
  readonly scopeVersion: 1;

  /**
   * Allocate a new task record. Returns the `taskId` the framework hands
   * to `platform.xxxTask(taskId, ...)`. Initial status is `submitted`.
   *
   * `hasWebhook: true` when the buyer wired `push_notification_config.url`
   * — surfaced via `tasks_get`'s `has_webhook` field. Defaults to `false`.
   *
   * `overrideTaskId` — when set, the registry uses this exact string as the
   * task id instead of minting a fresh one. Throws if the id is already
   * registered in the same account/principal scope (uniqueness within that
   * scope is the caller's responsibility).
   */
  create(opts: {
    tool: string;
    accountId: string;
    ownerScope?: string;
    hasWebhook?: boolean;
    overrideTaskId?: string;
  }): Promise<{ taskId: string }>;

  /** Read a task within its account/principal boundary. */
  getTask<TResult = unknown>(taskId: string, scope: TaskRegistryScope): Promise<TaskRecord<TResult> | null>;

  /** Administrative/test access; returns null when an id is ambiguous across scopes. Never expose to buyer traffic. */
  _getTaskUnsafe<TResult = unknown>(taskId: string): Promise<TaskRecord<TResult> | null>;

  /**
   * List tasks owned by a resolved account. Buyer-facing AdCP task
   * reconciliation must use this scoped surface, never the transport-level
   * MCP TaskStore, because MCP task records do not carry AdCP ownership,
   * protocol, or tool metadata.
   *
   * Multi-tenant deployments that share an AdCP account across principals
   * must persist and filter by `ownerScope`. Rows without `ownerScope` are
   * treated as legacy account-scoped rows: built-in registries return them
   * only for the account-fallback owner scope (`account:${accountId}`), not
   * for credential-, agent-, or session-scoped callers.
   */
  list?(opts: TaskRegistryListOptions): Promise<TaskRegistryListResult>;

  /**
   * Mark a task `completed` with the method's return value. No-op if the
   * task is already terminal (idempotent).
   */
  complete<TResult>(taskId: string, scope: TaskRegistryScope, result: TResult): Promise<void>;

  /**
   * Mark a task `failed` with the structured error and, when available, the
   * canonical terminal artifact. No-op if the task is already terminal.
   */
  fail(taskId: string, scope: TaskRegistryScope, error: AdcpStructuredError, result?: unknown): Promise<void>;

  /**
   * Record intermediate progress from `TaskHandoffContext.update(...)`.
   * Transitions the task from `'submitted'` → `'working'` on the first
   * call. No-op on already-terminal tasks. The `progress` payload is
   * written to the record and surfaced to buyers polling `tasks_get`.
   */
  updateProgress(taskId: string, scope: TaskRegistryScope, progress: TaskHandoffProgress): Promise<void>;

  /**
   * Register the background completion promise the framework spawned for
   * the `*Task` invocation. Tests await this for deterministic settlement;
   * production callers don't need it.
   */
  _registerBackground(taskId: string, scope: TaskRegistryScope, completion: Promise<void>): void;

  /**
   * Await any registered background completion for a task. Resolves
   * immediately if no background is registered or it has already settled.
   * Used by test harnesses + `tasks/get` integration.
   */
  awaitTask(taskId: string, scope: TaskRegistryScope): Promise<void>;

  /** Administrative/test wait across every scope sharing this public task id. Never expose to buyer traffic. */
  _awaitTaskUnsafe(taskId: string): Promise<void>;

  /**
   * Optional test-harness flush. In-memory registries expose this so
   * `AdcpServer.compliance.reset()` can clear hardcoded overrideTaskId
   * records between repeated storyboard runs. Persistent registries should
   * omit it unless they can safely flush their configured backend.
   */
  clear?(): void | Promise<void>;
}

export function createInMemoryTaskRegistry(): TaskRegistry {
  const tasks = new Map<string, TaskRecord<unknown>>();
  const backgrounds = new Map<string, Promise<void>>();

  return {
    scopeVersion: 1,
    async create(opts: {
      tool: string;
      accountId: string;
      ownerScope?: string;
      hasWebhook?: boolean;
      overrideTaskId?: string;
    }): Promise<{ taskId: string }> {
      const taskId = opts.overrideTaskId ?? `task_${randomUUID()}`;
      const scope = { accountId: opts.accountId, ownerScope: opts.ownerScope ?? `account:${opts.accountId}` };
      const storageKey = taskStorageKey(taskId, scope);
      if (tasks.has(storageKey)) {
        throw new Error(`task_id already registered: ${taskId}`);
      }
      const now = new Date().toISOString();
      tasks.set(storageKey, {
        taskId,
        tool: opts.tool,
        accountId: opts.accountId,
        ownerScope: opts.ownerScope ?? `account:${opts.accountId}`,
        status: 'submitted',
        ...(opts.hasWebhook && { hasWebhook: true }),
        createdAt: now,
        updatedAt: now,
      });
      return { taskId };
    },

    async getTask<TResult = unknown>(taskId: string, scope: TaskRegistryScope): Promise<TaskRecord<TResult> | null> {
      const record = tasks.get(taskStorageKey(taskId, scope));
      return (record as TaskRecord<TResult> | undefined) ?? null;
    },

    async _getTaskUnsafe<TResult = unknown>(taskId: string): Promise<TaskRecord<TResult> | null> {
      const matches = Array.from(tasks.values()).filter(record => record.taskId === taskId);
      return matches.length === 1 ? (matches[0] as TaskRecord<TResult>) : null;
    },

    async list(opts: TaskRegistryListOptions): Promise<TaskRegistryListResult> {
      return {
        tasks: Array.from(tasks.values()).filter(
          record => record.accountId === opts.accountId && record.ownerScope === opts.ownerScope
        ),
      };
    },

    async complete<TResult>(taskId: string, scope: TaskRegistryScope, result: TResult): Promise<void> {
      const existing = tasks.get(taskStorageKey(taskId, scope));
      if (!existing) return;
      if (isTerminalTaskStatus(existing.status)) return;
      existing.status = 'completed';
      existing.result = result;
      existing.updatedAt = new Date().toISOString();
    },

    async fail(taskId: string, scope: TaskRegistryScope, error: AdcpStructuredError, result?: unknown): Promise<void> {
      const existing = tasks.get(taskStorageKey(taskId, scope));
      if (!existing) return;
      if (isTerminalTaskStatus(existing.status)) return;
      existing.status = 'failed';
      existing.error = error;
      if (result !== undefined) existing.result = result;
      existing.statusMessage = error.message;
      existing.updatedAt = new Date().toISOString();
    },

    async updateProgress(taskId: string, scope: TaskRegistryScope, progress: TaskHandoffProgress): Promise<void> {
      const existing = tasks.get(taskStorageKey(taskId, scope));
      if (!existing) return;
      if (isTerminalTaskStatus(existing.status)) return;
      if (existing.status === 'submitted') existing.status = 'working';
      existing.progress = progress;
      existing.updatedAt = new Date().toISOString();
    },

    _registerBackground(taskId: string, scope: TaskRegistryScope, completion: Promise<void>): void {
      const storageKey = taskStorageKey(taskId, scope);
      const composed: Promise<void> = completion.then(
        () => {
          if (backgrounds.get(storageKey) === composed) backgrounds.delete(storageKey);
        },
        () => {
          if (backgrounds.get(storageKey) === composed) backgrounds.delete(storageKey);
        }
      );
      backgrounds.set(storageKey, composed);
    },

    async awaitTask(taskId: string, scope: TaskRegistryScope): Promise<void> {
      const pending = backgrounds.get(taskStorageKey(taskId, scope));
      if (pending) await pending;
    },

    async _awaitTaskUnsafe(taskId: string): Promise<void> {
      const pending = Array.from(backgrounds.entries())
        .filter(([key]) => (JSON.parse(key) as [string, string, string])[2] === taskId)
        .map(([, completion]) => completion);
      await Promise.all(pending);
    },

    clear(): void {
      tasks.clear();
      backgrounds.clear();
    },
  };
}
