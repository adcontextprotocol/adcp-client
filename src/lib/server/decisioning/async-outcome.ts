/**
 * Async-completion primitives for `DecisioningPlatform`.
 *
 * Adopters write plain `async (req, ctx) => Promise<T>` methods and either
 * return the success value (framework projects to the wire success arm) or
 * `throw new AdcpError(...)` for structured rejection (framework projects
 * to the wire error envelope with code/recovery/field/suggestion/retry_after).
 * In-process async work that may exceed `getProducts`-style timeouts uses
 * `ctx.runAsync(opts, fn)`; out-of-process completion uses `ctx.startTask()`
 * (see `RequestContext` in `./context.ts`).
 *
 * `AsyncOutcome<T>` and its `ok` / `submitted` / `rejected` constructors
 * remain in the runtime as the framework's internal projection vocabulary;
 * adopter code does not return them.
 *
 * Status: Preview / 6.0.
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
  /**
   * Partial result available immediately, before the async workflow completes.
   * Use when the platform creates a real entity that the buyer should see
   * NOW — e.g., GAM creates an Order in `PENDING_APPROVAL` state and the
   * buyer should see the buy with `status: pending_start` while a trafficker
   * reviews. Framework projects this onto the wire so MCP buyers see
   * `structuredContent.partial_result` and A2A buyers see it in the artifact
   * data alongside `adcp_task_id`. The terminal value (the same shape) flows
   * through `taskHandle.notify({ kind: 'completed', result })`.
   */
  partialResult?: TResult;
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
 *
 * Adopter code throws `AdcpError` (the class wrapper); the framework catches
 * and projects the structured fields onto the wire envelope. Internal
 * projection paths construct `AdcpStructuredError` literals.
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
 * Throwable structured error. Adopter code uses this to fail a specialism
 * method with a buyer-facing wire envelope:
 *
 * ```ts
 * createMediaBuy: async (req, ctx) => {
 *   if (req.total_budget.amount < this.floor) {
 *     throw new AdcpError('BUDGET_TOO_LOW', {
 *       recovery: 'correctable',
 *       message: `Floor is $${this.floor} CPM`,
 *       field: 'total_budget.amount',
 *       suggestion: `Raise total_budget to at least ${this.floor * 1000}`,
 *     });
 *   }
 *   return await this.gam.createOrder(req);
 * }
 * ```
 *
 * Framework catches `AdcpError` thrown from any specialism method and
 * projects the structured fields onto the wire `adcp_error` envelope.
 * Generic thrown errors (`Error`, `TypeError`, etc.) are mapped to
 * `SERVICE_UNAVAILABLE` with `recovery: 'transient'`.
 *
 * `recovery` is REQUIRED on the constructor; pass `'correctable'` for
 * buyer-fixable errors, `'transient'` for upstream outages, `'terminal'`
 * for permission/account/policy denials.
 */
export class AdcpError extends Error {
  readonly name = 'AdcpError' as const;
  readonly code: ErrorCode | (string & {});
  readonly recovery: 'transient' | 'correctable' | 'terminal';
  readonly field?: string;
  readonly suggestion?: string;
  readonly retry_after?: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode | (string & {}),
    options: {
      recovery: 'transient' | 'correctable' | 'terminal';
      message: string;
      field?: string;
      suggestion?: string;
      retry_after?: number;
      details?: Record<string, unknown>;
    }
  ) {
    super(options.message);
    this.code = code;
    this.recovery = options.recovery;
    if (options.field !== undefined) this.field = options.field;
    if (options.suggestion !== undefined) this.suggestion = options.suggestion;
    if (options.retry_after !== undefined) this.retry_after = options.retry_after;
    if (options.details !== undefined) this.details = options.details;
  }

  /** Coerce to the structured envelope shape the framework projects to the wire. */
  toStructuredError(): AdcpStructuredError {
    return {
      code: this.code,
      recovery: this.recovery,
      message: this.message,
      ...(this.field !== undefined && { field: this.field }),
      ...(this.suggestion !== undefined && { suggestion: this.suggestion }),
      ...(this.retry_after !== undefined && { retry_after: this.retry_after }),
      ...(this.details !== undefined && { details: this.details }),
    };
  }
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
// Internal projection vocabulary
//
// The framework's runtime constructs `AsyncOutcome` literals when projecting
// platform results onto the wire. Adopter code returns plain `T` and throws
// `AdcpError`; these functions are not part of the adopter surface.
// ---------------------------------------------------------------------------

/** @internal */
export function ok<TResult>(result: TResult): AsyncOutcome<TResult> {
  return { kind: 'sync', result };
}

/** @internal */
export function submitted<TResult>(
  taskHandle: TaskHandle<TResult>,
  options?: { estimatedCompletion?: Date; message?: string; partialResult?: TResult }
): AsyncOutcome<TResult> {
  return {
    kind: 'submitted',
    taskHandle,
    estimatedCompletion: options?.estimatedCompletion,
    message: options?.message,
    partialResult: options?.partialResult,
  };
}

/** @internal */
export function rejected<TResult>(error: AdcpStructuredError): AsyncOutcome<TResult> {
  return { kind: 'rejected', error };
}

// Internal helper retained for the projection layer (see runtime/from-platform.ts).
/** @internal */
export function _aggregateRejected<TResult>(
  errors: ReadonlyArray<AdcpStructuredError>,
  options?: { code?: ErrorCode | (string & {}); recovery?: AdcpStructuredError['recovery']; message?: string }
): AsyncOutcome<TResult> {
  const head = errors[0];
  if (!head) {
    return rejected({
      code: options?.code ?? 'INVALID_REQUEST',
      recovery: options?.recovery ?? 'correctable',
      message: options?.message ?? 'Request rejected (no specific errors supplied)',
    });
  }
  const rest = errors.slice(1);
  return rejected({
    code: options?.code ?? head.code,
    recovery: options?.recovery ?? head.recovery,
    message: options?.message ?? head.message,
    field: head.field,
    suggestion: head.suggestion,
    retry_after: head.retry_after,
    details: { ...head.details, errors: rest },
  });
}
