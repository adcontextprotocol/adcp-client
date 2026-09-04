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
 * The framework owns request-time task lifecycle. Out-of-process approval
 * workers may use the exported scoped-ref helpers to settle a durably queued
 * task without reconstructing its trusted account/principal scope. Wire-level
 * `tasks/get` integration reads via scoped `getTask`; test harnesses use
 * `awaitTask` to flush the background promise deterministically.
 *
 * Status: Preview / 6.0.
 *
 * @public
 */

import { randomUUID } from 'node:crypto';
import type { AdcpStructuredError, TaskHandoffProgress } from '../async-outcome';
import { stripCtxMetadata, stripImplementationConfig } from '../../ctx-metadata';
import { sanitizeStructuredAdcpError } from '../../errors';

/**
 * AdCP-spec task lifecycle states. Mirrors `enums/task-status.json` —
 * the v6 framework writes `'submitted'` on create, transitions to
 * `'working'` on the first `updateProgress()` call, and terminates at
 * `'completed'` / `'failed'`. `reject()` records a business decline as
 * `'rejected'` without misclassifying it as an execution failure. The other
 * spec states remain available to custom registries.
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

const MAX_PROGRESS_BYTES = 64 * 1024;
const PRIVATE_PROGRESS_KEYS: ReadonlySet<string> = new Set([
  'authorization',
  'bearer',
  'token',
  'accesstoken',
  'refreshtoken',
  'apikey',
  'clientsecret',
  'password',
  'secret',
  'credential',
  'credentials',
  'privatekey',
  'ctxmetadata',
  'implementationconfig',
  'taskref',
  'taskid',
  'accountid',
  'ownerscope',
  'registryid',
]);

function isPrivateProgressKey(key: string): boolean {
  const normalized = key.replace(/[_-]/g, '').toLowerCase();
  return (
    PRIVATE_PROGRESS_KEYS.has(normalized) ||
    normalized.endsWith('token') ||
    normalized.endsWith('secret') ||
    normalized.endsWith('password') ||
    normalized.endsWith('credential') ||
    normalized.endsWith('credentials') ||
    normalized.endsWith('privatekey') ||
    normalized.endsWith('apikey')
  );
}

/** Normalize and bound buyer-readable progress before any registry persists it. */
export function sanitizeTaskProgressForStorage(progress: TaskHandoffProgress): TaskHandoffProgress {
  if (progress == null || typeof progress !== 'object' || Array.isArray(progress)) {
    throw new TypeError('Task progress must be an object');
  }
  const copyString = (key: 'message' | 'current_step'): void => {
    const value = progress[key];
    if (value === undefined) return;
    if (typeof value !== 'string') throw new TypeError(`Task progress ${key} must be a string`);
  };
  copyString('message');
  copyString('current_step');
  if (progress.percentage !== undefined) {
    if (typeof progress.percentage !== 'number' || !Number.isFinite(progress.percentage)) {
      throw new TypeError('Task progress percentage must be a finite number');
    }
    if (progress.percentage < 0 || progress.percentage > 100) {
      throw new RangeError('Task progress percentage must be between 0 and 100');
    }
  }
  for (const key of ['step_number', 'total_steps'] as const) {
    const value = progress[key];
    if (value === undefined) continue;
    if (!Number.isInteger(value) || value < 1) {
      throw new RangeError(`Task progress ${key} must be an integer of at least 1`);
    }
  }
  const json = JSON.stringify(progress, (key, value) => (isPrivateProgressKey(key) ? undefined : value));
  if (json === undefined) throw new TypeError('Task progress must be JSON-serializable');
  if (Buffer.byteLength(json, 'utf8') > MAX_PROGRESS_BYTES) {
    throw new Error(`Task progress JSON exceeds ${MAX_PROGRESS_BYTES} bytes`);
  }
  return JSON.parse(json) as TaskHandoffProgress;
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
   * Whether the buyer wired `push_notification_config.url` and the dispatch
   * had an emitter capable of delivering it. Surfaced to the buyer via
   * `tasks_get`'s spec-defined
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
  /**
   * Opaque identity of the issuing registry partition. Built-ins set it on
   * durable handles and reject it when it names another registry. Optional
   * only for source compatibility with beta.13 custom registries.
   */
  registryId?: string;
}

/**
 * Serializable trusted-internal handle for a task registry row.
 *
 * Persist this complete value before acknowledging an approval-queue write.
 * It deliberately never appears on the AdCP buyer wire: `accountId` and
 * `ownerScope` are server-side authorization boundaries, not buyer data.
 */
export interface ScopedTaskRef extends TaskRegistryScope {
  taskId: string;
}

/** Non-enumerating result of a scoped lifecycle mutation. */
export type TaskMutationOutcome =
  | { outcome: 'applied' }
  | { outcome: 'already_terminal'; status: TaskStatus }
  | { outcome: 'not_found_in_scope' };

/**
 * Lifecycle result accepted from custom beta.13 registries. Built-in
 * registries always return `TaskMutationOutcome`; `void` preserves source
 * compatibility while existing custom implementations adopt strict outcomes.
 */
export type TaskRegistryMutationResult = TaskMutationOutcome | void;

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

  /** Whether stored rows can be reopened by a different process after restart. */
  readonly durability?: 'durable' | 'process-local';

  /**
   * Identity bound into every durable task reference issued by this registry.
   * It is stable for the lifetime of stored records and rotates when a
   * test-only `clear()` invalidates them. Custom registries must provide it
   * before using worker-settlement helpers. It is never buyer-visible.
   */
  readonly registryId?: string;

  /**
   * Allocate a new task record. Returns the complete scoped reference the
   * framework passes to the handoff context. Initial status is `submitted`.
   *
   * `hasWebhook: true` when dispatch has both a buyer
   * `push_notification_config.url` and an emitter capable of delivering it
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
  }): Promise<ScopedTaskRef>;

  /** Read a task within its account/principal boundary. */
  getTask<TResult = unknown>(taskId: string, scope: TaskRegistryScope): Promise<TaskRecord<TResult> | null>;

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
   * Mark a task `completed` with the method's return value. Returns an
   * idempotent terminal outcome or a non-enumerating scoped miss.
   */
  complete<TResult>(taskId: string, scope: TaskRegistryScope, result: TResult): Promise<TaskRegistryMutationResult>;

  /**
   * Mark a task `failed` with the structured error and, when available, the
   * canonical terminal artifact. Returns an idempotent terminal outcome or a
   * non-enumerating scoped miss.
   */
  fail(
    taskId: string,
    scope: TaskRegistryScope,
    error: AdcpStructuredError,
    result?: unknown
  ): Promise<TaskRegistryMutationResult>;

  /**
   * Mark a task `rejected` after a business decision. Unlike `fail()`, a
   * rejection has no structured execution error. Use `fail()` only when the
   * task execution itself failed.
   *
   * Optional for source compatibility with custom registries published before
   * rejections had a writer. `rejectScopedTask()` refuses clearly when absent.
   */
  reject?(
    taskId: string,
    scope: TaskRegistryScope,
    result: unknown,
    reason?: string
  ): Promise<TaskRegistryMutationResult>;

  /**
   * Record intermediate progress from `TaskHandoffContext.update(...)`.
   * Transitions the task from `'submitted'` → `'working'` on the first
   * call. Reports already-terminal and scoped-miss outcomes. The `progress` payload is
   * written to the record and surfaced to buyers polling `tasks_get`.
   */
  updateProgress(
    taskId: string,
    scope: TaskRegistryScope,
    progress: TaskHandoffProgress
  ): Promise<TaskRegistryMutationResult>;

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
   * records between repeated storyboard runs. Implementations must invalidate
   * every previously issued handle (for example by rotating `registryId`)
   * before allowing a scoped task id to be reused. Persistent registries
   * should omit it unless they can safely flush their configured backend.
   */
  clear?(): void | Promise<void>;
}

export function createInMemoryTaskRegistry(): TaskRegistry {
  const tasks = new Map<string, TaskRecord<unknown>>();
  const backgrounds = new Map<string, Promise<void>>();
  let registryId = `memory:${randomUUID()}`;

  return {
    scopeVersion: 1,
    durability: 'process-local',
    get registryId(): string {
      return registryId;
    },
    async create(opts: {
      tool: string;
      accountId: string;
      ownerScope?: string;
      hasWebhook?: boolean;
      overrideTaskId?: string;
    }): Promise<ScopedTaskRef> {
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
      return { taskId, ...scope, registryId };
    },

    async getTask<TResult = unknown>(taskId: string, scope: TaskRegistryScope): Promise<TaskRecord<TResult> | null> {
      if (scope.registryId !== undefined && scope.registryId !== registryId) return null;
      const record = tasks.get(taskStorageKey(taskId, scope));
      return (record as TaskRecord<TResult> | undefined) ?? null;
    },

    async list(opts: TaskRegistryListOptions): Promise<TaskRegistryListResult> {
      return {
        tasks: Array.from(tasks.values()).filter(
          record => record.accountId === opts.accountId && record.ownerScope === opts.ownerScope
        ),
      };
    },

    async complete<TResult>(taskId: string, scope: TaskRegistryScope, result: TResult): Promise<TaskMutationOutcome> {
      if (scope.registryId !== undefined && scope.registryId !== registryId) return { outcome: 'not_found_in_scope' };
      const existing = tasks.get(taskStorageKey(taskId, scope));
      if (!existing) return { outcome: 'not_found_in_scope' };
      if (isTerminalTaskStatus(existing.status)) return { outcome: 'already_terminal', status: existing.status };
      existing.status = 'completed';
      existing.result = result;
      existing.updatedAt = new Date().toISOString();
      return { outcome: 'applied' };
    },

    async fail(
      taskId: string,
      scope: TaskRegistryScope,
      error: AdcpStructuredError,
      result?: unknown
    ): Promise<TaskMutationOutcome> {
      if (scope.registryId !== undefined && scope.registryId !== registryId) return { outcome: 'not_found_in_scope' };
      const existing = tasks.get(taskStorageKey(taskId, scope));
      if (!existing) return { outcome: 'not_found_in_scope' };
      if (isTerminalTaskStatus(existing.status)) return { outcome: 'already_terminal', status: existing.status };
      existing.status = 'failed';
      existing.error = error;
      if (result !== undefined) existing.result = result;
      existing.statusMessage = error.message;
      existing.updatedAt = new Date().toISOString();
      return { outcome: 'applied' };
    },

    async reject(
      taskId: string,
      scope: TaskRegistryScope,
      result: unknown,
      reason?: string
    ): Promise<TaskMutationOutcome> {
      if (reason !== undefined && typeof reason !== 'string') {
        throw new TypeError('Task rejection reason must be a string');
      }
      if (scope.registryId !== undefined && scope.registryId !== registryId) return { outcome: 'not_found_in_scope' };
      const existing = tasks.get(taskStorageKey(taskId, scope));
      if (!existing) return { outcome: 'not_found_in_scope' };
      if (isTerminalTaskStatus(existing.status)) return { outcome: 'already_terminal', status: existing.status };
      existing.status = 'rejected';
      existing.result = result;
      existing.error = undefined;
      existing.statusMessage = reason;
      existing.updatedAt = new Date().toISOString();
      return { outcome: 'applied' };
    },

    async updateProgress(
      taskId: string,
      scope: TaskRegistryScope,
      progress: TaskHandoffProgress
    ): Promise<TaskMutationOutcome> {
      if (scope.registryId !== undefined && scope.registryId !== registryId) return { outcome: 'not_found_in_scope' };
      const existing = tasks.get(taskStorageKey(taskId, scope));
      if (!existing) return { outcome: 'not_found_in_scope' };
      if (isTerminalTaskStatus(existing.status)) return { outcome: 'already_terminal', status: existing.status };
      const sanitized = sanitizeTaskProgressForStorage(progress);
      if (existing.status === 'submitted') existing.status = 'working';
      existing.progress = sanitized;
      existing.updatedAt = new Date().toISOString();
      return { outcome: 'applied' };
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
      if (scope.registryId !== undefined && scope.registryId !== registryId) return;
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
      // Invalidate every pre-reset handle before a caller can reuse a forced
      // task id. Otherwise an old in-flight completion could settle a new
      // task with the same account/owner/id tuple after compliance.reset().
      registryId = `memory:${randomUUID()}`;
    },
  };
}

function requireMutationOutcome(outcome: TaskRegistryMutationResult): TaskMutationOutcome {
  if (outcome === undefined) {
    throw new Error(
      'Custom TaskRegistry returned no lifecycle mutation outcome. Implement applied/already_terminal/not_found_in_scope before using scoped worker settlement.'
    );
  }
  return outcome;
}

function verifyWorkerRefBinding(registry: TaskRegistry, ref: ScopedTaskRef): TaskMutationOutcome | undefined {
  if (typeof registry.registryId !== 'string' || registry.registryId.length === 0) {
    throw new Error(
      'TaskRegistry has no registryId. Configure a stable registry/storage identity before using scoped worker settlement.'
    );
  }
  if (typeof ref.registryId !== 'string' || ref.registryId.length === 0) {
    throw new Error(
      'ScopedTaskRef has no registryId. Persist a newly issued complete handle before using scoped worker settlement.'
    );
  }
  if (registry.registryId !== ref.registryId) return { outcome: 'not_found_in_scope' };
  return undefined;
}

async function ensureWorkerSettlementIsSafe(
  registry: TaskRegistry,
  ref: ScopedTaskRef
): Promise<TaskMutationOutcome | undefined> {
  const mismatch = verifyWorkerRefBinding(registry, ref);
  if (mismatch) return mismatch;
  const record = await registry.getTask(ref.taskId, ref);
  if (record == null) return { outcome: 'not_found_in_scope' };
  if (record.hasWebhook) {
    throw new Error(
      'Registry-only scoped settlement is unavailable for tasks with push notifications. Use createPostgresTaskSettlementCoordinator() with completeScopedPushTask()/failScopedPushTask() for crash-safe PostgreSQL settlement.'
    );
  }
  return undefined;
}

function stripIssuedTaskRef(value: unknown, ref: ScopedTaskRef): void {
  const visited = new WeakSet<object>();

  const matches = (candidate: unknown): candidate is Record<string, unknown> => {
    if (candidate == null || typeof candidate !== 'object') return false;
    const record = candidate as Record<string, unknown>;
    return record.taskId === ref.taskId && record.accountId === ref.accountId && record.ownerScope === ref.ownerScope;
  };

  const visit = (current: unknown): void => {
    if (current == null || typeof current !== 'object' || visited.has(current)) return;
    visited.add(current);
    const record = current as Record<string, unknown>;
    if (matches(record)) {
      delete record.taskId;
      delete record.accountId;
      delete record.ownerScope;
      delete record.registryId;
      return;
    }
    for (const [key, nested] of Object.entries(record)) {
      if (matches(nested)) delete record[key];
      else visit(nested);
    }
  };

  visit(value);
}

function sanitizeEmbeddedStructuredErrors(value: unknown): void {
  const visited = new WeakSet<object>();
  const visit = (current: unknown): void => {
    if (current == null || typeof current !== 'object' || visited.has(current)) return;
    visited.add(current);
    if (Array.isArray(current)) {
      for (const item of current) visit(item);
      return;
    }
    const record = current as Record<string, unknown>;
    if (Array.isArray(record.errors)) {
      record.errors = record.errors.map(error =>
        error != null &&
        typeof error === 'object' &&
        typeof (error as Record<string, unknown>).code === 'string' &&
        typeof (error as Record<string, unknown>).message === 'string'
          ? sanitizeStructuredAdcpError(error as { code: string; message: string })
          : error
      );
    }
    for (const nested of Object.values(record)) visit(nested);
  };
  visit(value);
}

/** Remove server-only fields before a task result becomes buyer-readable. */
export function sanitizeTaskResultForWire<T>(result: T, taskRef?: ScopedTaskRef): T {
  if (result != null && typeof result === 'object') {
    stripCtxMetadata(result as Record<string, unknown>);
    stripImplementationConfig(result as Record<string, unknown>);
    sanitizeEmbeddedStructuredErrors(result);
    if (taskRef) stripIssuedTaskRef(result, taskRef);
  }
  return result;
}

/** @internal Clone and sanitize a legacy/custom stored result before buyer egress. */
export function _sanitizeStoredTaskResultForWire<T>(result: T, taskRef: ScopedTaskRef): T | undefined {
  try {
    const clone = structuredClone(result);
    const sanitized = sanitizeTaskResultForWire(clone, taskRef);
    const json = JSON.stringify(sanitized);
    return json === undefined ? undefined : (JSON.parse(json) as T);
  } catch {
    return undefined;
  }
}

/** Complete a task using the exact trusted handle returned by `create()`. */
export async function completeScopedTask<TResult>(
  registry: TaskRegistry,
  ref: ScopedTaskRef,
  result: TResult
): Promise<TaskMutationOutcome> {
  const refused = await ensureWorkerSettlementIsSafe(registry, ref);
  if (refused) return refused;
  return requireMutationOutcome(await registry.complete(ref.taskId, ref, sanitizeTaskResultForWire(result, ref)));
}

/** Fail a task using the exact trusted handle returned by `create()`. */
export async function failScopedTask(
  registry: TaskRegistry,
  ref: ScopedTaskRef,
  error: AdcpStructuredError,
  result?: unknown
): Promise<TaskMutationOutcome> {
  const refused = await ensureWorkerSettlementIsSafe(registry, ref);
  if (refused) return refused;
  return requireMutationOutcome(
    await registry.fail(
      ref.taskId,
      ref,
      sanitizeStructuredAdcpError(error),
      result === undefined ? undefined : sanitizeTaskResultForWire(result, ref)
    )
  );
}

/** Reject a task using the exact trusted handle returned by `create()`. */
export async function rejectScopedTask(
  registry: TaskRegistry,
  ref: ScopedTaskRef,
  result: unknown,
  reason?: string
): Promise<TaskMutationOutcome> {
  const refused = await ensureWorkerSettlementIsSafe(registry, ref);
  if (refused) return refused;
  if (typeof registry.reject !== 'function') {
    throw new Error(
      'TaskRegistry does not implement reject(). Upgrade the custom registry before using scoped business-rejection settlement.'
    );
  }
  return requireMutationOutcome(await registry.reject(ref.taskId, ref, sanitizeTaskResultForWire(result, ref), reason));
}

/** Record task progress using the exact trusted handle returned by `create()`. */
export async function updateScopedTaskProgress(
  registry: TaskRegistry,
  ref: ScopedTaskRef,
  progress: TaskHandoffProgress
): Promise<TaskMutationOutcome> {
  const refused = verifyWorkerRefBinding(registry, ref);
  if (refused) return refused;
  return requireMutationOutcome(
    await registry.updateProgress(ref.taskId, ref, sanitizeTaskProgressForStorage(progress))
  );
}
