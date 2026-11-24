import { createHash, randomUUID } from 'node:crypto';

import { TaskTimeoutError, type GovernanceOutcomeRecovery } from '../errors';
import { MAX_TIMER_DELAY_MS, throwIfAborted, withAbortSignal } from '../protocols/abort';
import type { TaskOptions } from './ConversationTypes';

const TASK_OPERATION_ID = Symbol('adcp.taskOperationId');
/** Set while the id is a placeholder the dispatch may replace with one derived from its idempotency key. */
const TASK_OPERATION_ID_PROVISIONAL = Symbol('adcp.taskOperationIdProvisional');
const TASK_DEADLINE_ERROR = Symbol('adcp.taskDeadlineError');

type DeadlineTaskOptions<TOptions extends TaskOptions = TaskOptions> = TOptions & {
  [TASK_OPERATION_ID]: string;
  [TASK_OPERATION_ID_PROVISIONAL]?: true;
  [TASK_DEADLINE_ERROR]?: TaskTimeoutError;
};

/** Give a child dispatch its own correlation id while retaining the parent deadline and cancellation. */
export function childTaskOptions(options?: TaskOptions): TaskOptions {
  const child = { ...options };
  delete child.operationId;
  delete (child as Partial<DeadlineTaskOptions>)[TASK_OPERATION_ID];
  delete (child as Partial<DeadlineTaskOptions>)[TASK_OPERATION_ID_PROVISIONAL];
  return child;
}

/**
 * The default operation id for a request that carries an idempotency key.
 *
 * A seller hashes the whole request under its idempotency key, including
 * `push_notification_config`, whose `operation_id` and URL carry this id. A
 * retry under the same key must therefore send the same id, or the seller
 * answers IDEMPOTENCY_CONFLICT (adcp-client#3693). The key is hashed rather
 * than embedded, because webhook URLs are logged and the key is a
 * retry-pattern oracle.
 */
export function idempotentOperationId(agentId: string, taskName: string, idempotencyKey: string): string {
  const digest = createHash('sha256')
    .update(JSON.stringify(['adcp-operation-id/v1', agentId, taskName, idempotencyKey]))
    .digest('hex');
  return `idem-${digest.slice(0, 40)}`;
}

/**
 * Settle one dispatch's operation id. A caller-supplied id wins. Otherwise a
 * request with an idempotency key takes {@link idempotentOperationId}, and the
 * call's deadline error, if it still names this dispatch's placeholder, is
 * re-pointed at it. Without a key the placeholder
 * assigned by {@link withTaskDeadline} (or a fresh UUID) stands.
 */
export function resolveDispatchOperationId(
  options: TaskOptions,
  idempotent: { agentId: string; taskName: string; idempotencyKey: string | undefined }
): { operationId: string; derivedFromIdempotencyKey: boolean } {
  const assigned = getTaskOperationId(options);
  const provisional =
    assigned === undefined || (options as Partial<DeadlineTaskOptions>)[TASK_OPERATION_ID_PROVISIONAL] === true;
  if (!provisional) return { operationId: assigned, derivedFromIdempotencyKey: false };
  if (idempotent.idempotencyKey === undefined) {
    return { operationId: assigned ?? randomUUID(), derivedFromIdempotencyKey: false };
  }
  const operationId = idempotentOperationId(idempotent.agentId, idempotent.taskName, idempotent.idempotencyKey);
  const error = (options as Partial<DeadlineTaskOptions>)[TASK_DEADLINE_ERROR];
  // A child dispatch shares its parent's deadline error; only the dispatch
  // that owns the placeholder it names may re-point it.
  if (error && error.taskId === assigned) {
    (error as { taskId: string }).taskId = operationId;
    error.message = `Task ${operationId} timed out after ${error.timeout}ms`;
  }
  return { operationId, derivedFromIdempotencyKey: true };
}

export function getTaskOperationId(options: TaskOptions | undefined): string | undefined {
  const operationId = options?.operationId;
  if (
    operationId !== undefined &&
    (typeof operationId !== 'string' ||
      !/^(?!\.+$)[A-Za-z0-9_.:-]{1,255}$/.test(operationId) ||
      operationId.startsWith('delivery_route:'))
  ) {
    throw new TypeError(
      'operationId must contain 1–255 letters, digits, underscores, periods, colons, or hyphens; dot-only IDs and the delivery_route: prefix are reserved.'
    );
  }
  const internalId = (options as DeadlineTaskOptions | undefined)?.[TASK_OPERATION_ID];
  if (internalId !== undefined && operationId !== undefined && internalId !== operationId) {
    throw new TypeError('operationId does not match the operation already assigned to this call.');
  }
  return internalId ?? operationId;
}

export function attachTaskDeadlineIdempotencyKey(options: TaskOptions, idempotencyKey: string): void {
  const error = (options as DeadlineTaskOptions)[TASK_DEADLINE_ERROR];
  if (!error) return;
  error.idempotency_key = idempotencyKey;
  error.idempotencyKey = idempotencyKey;
}

export function attachTaskDeadlineGovernanceRecovery(options: TaskOptions, recovery: GovernanceOutcomeRecovery): void {
  const error = (options as DeadlineTaskOptions)[TASK_DEADLINE_ERROR];
  if (error) error.governanceRecovery = recovery;
}

/**
 * Run one complete SDK task under the caller's absolute wall-clock deadline.
 *
 * The consumed timeout is removed from the nested options so lower layers do
 * not start a second deadline. They still receive the composed signal, while
 * `workingTimeout` remains the transport's separate resettable idle timeout.
 */
export async function withTaskDeadline<T, TOptions extends TaskOptions = TaskOptions>(
  options: TOptions | undefined,
  run: (effectiveOptions: DeadlineTaskOptions<TOptions>) => Promise<T>
): Promise<T> {
  const existing = options as DeadlineTaskOptions<TOptions> | undefined;
  const assigned = getTaskOperationId(existing);
  const taskId = assigned ?? randomUUID();
  const provisional = assigned === undefined || existing?.[TASK_OPERATION_ID_PROVISIONAL] === true;
  const timeout = options?.timeout;
  const baseOptions = {
    ...options,
    timeout: undefined,
    [TASK_OPERATION_ID]: taskId,
    ...(provisional && { [TASK_OPERATION_ID_PROVISIONAL]: true }),
  } as DeadlineTaskOptions<TOptions>;
  throwIfAborted(options?.signal);
  if (timeout === undefined || timeout === 0) return run(baseOptions);

  if (!Number.isFinite(timeout) || timeout < 0 || timeout > MAX_TIMER_DELAY_MS) {
    throw new RangeError(`timeout must be a finite non-negative number <= ${MAX_TIMER_DELAY_MS}`);
  }

  const timeoutError = new TaskTimeoutError(taskId, timeout);
  return withAbortSignal(
    [options?.signal],
    timeout,
    signal =>
      run({
        ...baseOptions,
        signal,
        [TASK_DEADLINE_ERROR]: timeoutError,
      }),
    { timeoutError }
  );
}
