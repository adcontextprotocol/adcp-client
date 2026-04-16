import type { TaskResult, TaskResultFailure, AdcpErrorInfo } from '../core/ConversationTypes';

/**
 * Check if a failed TaskResult is retryable (transient error with recovery hint).
 * Always returns false for successful results.
 */
export function isRetryable<T>(
  result: TaskResult<T>
): result is TaskResultFailure<T> & { adcpError: AdcpErrorInfo } {
  return !result.success && result.adcpError?.recovery === 'transient';
}

/**
 * Get the recommended retry delay in milliseconds.
 * Uses the agent-provided retryAfterMs if available, otherwise returns defaultMs.
 * Returns 0 if the result is not retryable.
 */
export function getRetryDelay<T>(result: TaskResult<T>, defaultMs = 5000): number {
  if (!isRetryable(result)) return 0;
  return result.adcpError.retryAfterMs ?? defaultMs;
}
