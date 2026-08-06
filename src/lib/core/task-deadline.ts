import { randomUUID } from 'node:crypto';

import { TaskTimeoutError, type GovernanceOutcomeRecovery } from '../errors';
import { MAX_TIMER_DELAY_MS, throwIfAborted, withAbortSignal } from '../protocols/abort';
import type { TaskOptions } from './ConversationTypes';

const TASK_OPERATION_ID = Symbol('adcp.taskOperationId');
const TASK_DEADLINE_ERROR = Symbol('adcp.taskDeadlineError');

type DeadlineTaskOptions<TOptions extends TaskOptions = TaskOptions> = TOptions & {
  [TASK_OPERATION_ID]: string;
  [TASK_DEADLINE_ERROR]?: TaskTimeoutError;
};

export function getTaskOperationId(options: TaskOptions | undefined): string | undefined {
  return (options as DeadlineTaskOptions | undefined)?.[TASK_OPERATION_ID];
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
  const taskId = existing?.[TASK_OPERATION_ID] ?? randomUUID();
  const timeout = options?.timeout;
  const baseOptions = { ...options, timeout: undefined, [TASK_OPERATION_ID]: taskId } as DeadlineTaskOptions<TOptions>;
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
