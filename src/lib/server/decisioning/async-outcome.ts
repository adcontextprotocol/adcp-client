/**
 * Universal async pattern for DecisioningPlatform decision points.
 *
 * Every decision-point method that can be slow returns `AsyncOutcome<T>`.
 * One discriminated union, one task envelope mechanism, one webhook-or-poll
 * completion path. Methods that always-sync return `Promise<T>` directly;
 * async-eligible methods that mostly-sync still wrap so the platform can
 * return `{ kind: 'submitted' }` when a patch triggers an approval workflow.
 *
 * Status: Preview / 6.0. Not yet wired into the framework.
 *
 * @public
 */

/**
 * Error code vocabulary. Mirrors `schemas/cache/3.0.0/enums/error-code.json`
 * (45 standard codes). Adopters can return platform-specific codes too —
 * agents fall back to the `recovery` classification on unknowns.
 *
 * TODO(6.0): generate this from `schemas/cache/<version>/enums/error-code.json`
 * via the same codegen pipeline as the rest of `tools.generated.ts`.
 */
export type ErrorCode =
  | 'INVALID_REQUEST'
  | 'AUTH_REQUIRED'
  | 'RATE_LIMITED'
  | 'SERVICE_UNAVAILABLE'
  | 'POLICY_VIOLATION'
  | 'PRODUCT_NOT_FOUND'
  | 'PRODUCT_UNAVAILABLE'
  | 'PROPOSAL_EXPIRED'
  | 'BUDGET_TOO_LOW'
  | 'CREATIVE_REJECTED'
  | 'UNSUPPORTED_FEATURE'
  | 'AUDIENCE_TOO_SMALL'
  | 'ACCOUNT_NOT_FOUND'
  | 'ACCOUNT_SETUP_REQUIRED'
  | 'ACCOUNT_AMBIGUOUS'
  | 'ACCOUNT_PAYMENT_REQUIRED'
  | 'ACCOUNT_SUSPENDED'
  | 'COMPLIANCE_UNSATISFIED'
  | 'GOVERNANCE_DENIED'
  | 'BUDGET_EXHAUSTED'
  | 'BUDGET_EXCEEDED'
  | 'CONFLICT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'IDEMPOTENCY_REQUIRED'
  | 'IDEMPOTENCY_EXPIRED'
  | 'TERMS_REJECTED'
  | 'PERMISSION_DENIED'
  | 'NOT_FOUND'
  | 'VALIDATION_ERROR'
  | 'VERSION_UNSUPPORTED';

/**
 * Discriminated union returned by any decision-point method that can complete
 * synchronously, defer to an async task, or reject. Framework owns task
 * envelope generation, polling, webhook emission, retry, dedup.
 */
export type AsyncOutcome<TResult, TError extends AdcpStructuredError = AdcpStructuredError> =
  | AsyncOutcomeSync<TResult>
  | AsyncOutcomeSubmitted<TResult, TError>
  | AsyncOutcomeRejected<TError>;

export interface AsyncOutcomeSync<TResult> {
  kind: 'sync';
  result: TResult;
}

export interface AsyncOutcomeSubmitted<TResult, TError extends AdcpStructuredError = AdcpStructuredError> {
  kind: 'submitted';
  taskHandle: TaskHandle<TResult, TError>;
  /** Hint for buyer-side polling intervals. Optional. */
  estimatedCompletion?: Date;
  /** Human-readable status note. Optional. */
  message?: string;
}

export interface AsyncOutcomeRejected<TError extends AdcpStructuredError = AdcpStructuredError> {
  kind: 'rejected';
  error: TError;
}

/**
 * Structured error envelope. The wire schema permits unknown codes but the
 * spec posture is "use the standard vocabulary; agents fall back to recovery
 * classification on unknowns." `ErrorCode | (string & {})` gives autocomplete
 * for the 45 standard codes plus an escape hatch for adapter-specific codes.
 *
 * `recovery` is the field that drives buyer behavior — never omit it.
 */
export interface AdcpStructuredError {
  code: ErrorCode | (string & {});
  recovery: 'transient' | 'correctable' | 'terminal';
  message: string;
  details?: Record<string, unknown>;
}

/**
 * Handle the framework hands to the buyer (via task envelope) and to the
 * platform (so it can push terminal state). The platform calls
 * `taskHandle.notify()` when its backend learns the task is done; framework
 * polls only as a fallback for platforms that haven't wired webhook ingress.
 */
export interface TaskHandle<TResult = unknown, TError extends AdcpStructuredError = AdcpStructuredError> {
  /** Stable task identifier; survives retries and cross-process. */
  readonly taskId: string;

  /**
   * Push a status update to the framework. Called by the platform from its
   * own webhook handlers (e.g., when GAM emits an order-status notification).
   * Framework dedupes, retries the buyer-side webhook on failure, and ignores
   * updates after a terminal one. Safe to call from any context.
   */
  notify(update: TaskUpdate<TResult, TError>): void;
}

export type TaskUpdate<TResult = unknown, TError extends AdcpStructuredError = AdcpStructuredError> =
  | TaskUpdateProgress
  | TaskUpdateCompleted<TResult>
  | TaskUpdateFailed<TError>;

export interface TaskUpdateProgress {
  kind: 'progress';
  status?: string;
  /** 0..1 if known; omit otherwise. */
  percent?: number;
}

export interface TaskUpdateCompleted<TResult> {
  kind: 'completed';
  result: TResult;
}

export interface TaskUpdateFailed<TError extends AdcpStructuredError = AdcpStructuredError> {
  kind: 'failed';
  error: TError;
}

// ---------------------------------------------------------------------------
// Construction helpers — adopters return these instead of literal { kind: ... }
// objects. Helpers narrow the shape per branch and keep the discriminator
// framework-controlled.
// ---------------------------------------------------------------------------

/** Synchronous success. Most happy paths use this. */
export function ok<TResult>(result: TResult): AsyncOutcome<TResult> {
  return { kind: 'sync', result };
}

/**
 * Submitted — the platform has handed work to its async pipeline. Framework
 * generates the task envelope; buyer can poll `tasks/get` or wait for the
 * completion webhook to push_notification_config.url. The platform calls
 * `taskHandle.notify(...)` when its backend learns the task completes.
 */
export function submitted<TResult>(
  taskHandle: TaskHandle<TResult>,
  options?: { estimatedCompletion?: Date; message?: string }
): AsyncOutcome<TResult> {
  return {
    kind: 'submitted',
    taskHandle,
    estimatedCompletion: options?.estimatedCompletion,
    message: options?.message,
  };
}

/** Terminal rejection. `recovery` field guides buyer behavior. */
export function rejected<TResult>(error: AdcpStructuredError): AsyncOutcome<TResult> {
  return { kind: 'rejected', error };
}
