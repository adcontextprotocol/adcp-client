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
 * Error code vocabulary mirroring `schemas/cache/3.0.0/enums/error-code.json`
 * (45 standard codes). Adopters can return platform-specific codes too —
 * agents fall back to the `recovery` classification on unknowns via the
 * `(string & {})` escape hatch on `AdcpStructuredError.code`.
 *
 * TODO(6.0): generate this from `schemas/cache/<version>/enums/error-code.json`
 * via the same codegen pipeline as the rest of `tools.generated.ts`. The
 * hand-maintained list rots; codegen pins it to spec.
 */
export type ErrorCode =
  | 'INVALID_REQUEST'
  | 'AUTH_REQUIRED'
  | 'RATE_LIMITED'
  | 'SERVICE_UNAVAILABLE'
  | 'POLICY_VIOLATION'
  | 'PRODUCT_NOT_FOUND'
  | 'PRODUCT_UNAVAILABLE'
  | 'PRODUCT_EXPIRED'
  | 'PROPOSAL_EXPIRED'
  | 'PROPOSAL_NOT_COMMITTED'
  | 'BUDGET_TOO_LOW'
  | 'BUDGET_EXHAUSTED'
  | 'BUDGET_EXCEEDED'
  | 'CREATIVE_REJECTED'
  | 'CREATIVE_DEADLINE_EXCEEDED'
  | 'CREATIVE_NOT_FOUND'
  | 'UNSUPPORTED_FEATURE'
  | 'AUDIENCE_TOO_SMALL'
  | 'ACCOUNT_NOT_FOUND'
  | 'ACCOUNT_SETUP_REQUIRED'
  | 'ACCOUNT_AMBIGUOUS'
  | 'ACCOUNT_PAYMENT_REQUIRED'
  | 'ACCOUNT_SUSPENDED'
  | 'COMPLIANCE_UNSATISFIED'
  | 'GOVERNANCE_DENIED'
  | 'GOVERNANCE_UNAVAILABLE'
  | 'CAMPAIGN_SUSPENDED'
  | 'CONFLICT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'IDEMPOTENCY_EXPIRED'
  | 'INVALID_STATE'
  | 'IO_REQUIRED'
  | 'MEDIA_BUY_NOT_FOUND'
  | 'NOT_CANCELLABLE'
  | 'PACKAGE_NOT_FOUND'
  | 'PERMISSION_DENIED'
  | 'PLAN_NOT_FOUND'
  | 'REFERENCE_NOT_FOUND'
  | 'REQUOTE_REQUIRED'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_TERMINATED'
  | 'SIGNAL_NOT_FOUND'
  | 'TERMS_REJECTED'
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
 * Structured error envelope. Mirrors `schemas/cache/3.0.0/core/error.json`.
 * The wire schema permits unknown codes but the spec posture is "use the
 * standard vocabulary; agents fall back to recovery classification on
 * unknowns." `ErrorCode | (string & {})` gives autocomplete for the 45
 * standard codes plus an escape hatch for adapter-specific codes.
 *
 * `recovery` is REQUIRED at this interface level. The wire schema makes it
 * optional; we tighten because every adopter needs to declare buyer-recovery
 * intent on every rejection — implicit "terminal" by absence has historically
 * caused buyers to misroute retries.
 */
export interface AdcpStructuredError {
  code: ErrorCode | (string & {});
  recovery: 'transient' | 'correctable' | 'terminal';
  message: string;
  /** Field path associated with the error (e.g., `'packages[0].targeting'`). */
  field?: string;
  /** Suggested fix surfaced to the buyer. */
  suggestion?: string;
  /**
   * Seconds to wait before retrying. REQUIRED by the spec for `RATE_LIMITED`
   * and `SERVICE_UNAVAILABLE`; the framework auto-fills a default if the
   * platform omits it. Adopters MUST clamp to [1, 3600] per spec.
   */
  retry_after?: number;
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

/**
 * Task lifecycle: monotonic. A task transitions `progress*` → `completed | failed`,
 * and `completed` / `failed` are terminal.
 *
 * Bounce-back workflows (e.g., GAM `PENDING_APPROVAL → DRAFT` after a trafficker
 * rejects the line item, then re-submitted) are NOT modeled as a non-terminal
 * rejection here. The platform should emit `failed` with `recovery: 'correctable'`
 * carrying the rejection reason; the buyer issues a fresh `createMediaBuy` (or
 * `updateMediaBuy`) with the corrected payload, which receives a new task envelope.
 *
 * This keeps the type-level contract simple at the cost of losing platform-side
 * task-id correlation on bounce-back. Revisit at v1.1 if other platforms
 * (broadcast TV, DOOH) report the same idiom.
 */
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

/**
 * Stub-shape rejection for methods the platform hasn't implemented yet.
 * Returns `rejected({ code: 'UNSUPPORTED_FEATURE', recovery: 'terminal' })`
 * so the buyer learns the feature is unavailable and stops retrying.
 *
 * Useful while standing up a new adapter — implement methods incrementally
 * and `unimplemented()` everything else without leaving handlers undefined.
 */
export function unimplemented<TResult>(message = 'Method not implemented'): AsyncOutcome<TResult> {
  return rejected({
    code: 'UNSUPPORTED_FEATURE',
    recovery: 'terminal',
    message,
  });
}
