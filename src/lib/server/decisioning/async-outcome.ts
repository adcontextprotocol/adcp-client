/**
 * Error vocabulary + structured error class for `DecisioningPlatform`.
 *
 * Adopters write per-tool methods (sync OR `*Task` HITL variant), return
 * the success value, or `throw new AdcpError(...)` for structured rejection.
 * The framework projects the structured fields onto the wire `adcp_error`
 * envelope; generic thrown errors map to `SERVICE_UNAVAILABLE`.
 *
 * `AsyncOutcome<T>` and the `ok` / `submitted` / `rejected` constructors
 * remain as the framework's internal projection vocabulary; adopter code
 * doesn't return them.
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
 * via the same codegen pipeline as the rest of `tools.generated.ts`.
 */
export const KNOWN_ERROR_CODES = [
  'INVALID_REQUEST',
  'AUTH_REQUIRED',
  'RATE_LIMITED',
  'SERVICE_UNAVAILABLE',
  'POLICY_VIOLATION',
  'PRODUCT_NOT_FOUND',
  'PRODUCT_UNAVAILABLE',
  'PRODUCT_EXPIRED',
  'PROPOSAL_EXPIRED',
  'PROPOSAL_NOT_COMMITTED',
  'BUDGET_TOO_LOW',
  'BUDGET_EXHAUSTED',
  'BUDGET_EXCEEDED',
  'CREATIVE_REJECTED',
  'CREATIVE_DEADLINE_EXCEEDED',
  'CREATIVE_NOT_FOUND',
  'UNSUPPORTED_FEATURE',
  'AUDIENCE_TOO_SMALL',
  'ACCOUNT_NOT_FOUND',
  'ACCOUNT_SETUP_REQUIRED',
  'ACCOUNT_AMBIGUOUS',
  'ACCOUNT_PAYMENT_REQUIRED',
  'ACCOUNT_SUSPENDED',
  'COMPLIANCE_UNSATISFIED',
  'GOVERNANCE_DENIED',
  'GOVERNANCE_UNAVAILABLE',
  'CAMPAIGN_SUSPENDED',
  'CONFLICT',
  'IDEMPOTENCY_CONFLICT',
  'IDEMPOTENCY_EXPIRED',
  'INVALID_STATE',
  'IO_REQUIRED',
  'MEDIA_BUY_NOT_FOUND',
  'NOT_CANCELLABLE',
  'PACKAGE_NOT_FOUND',
  'PERMISSION_DENIED',
  'PLAN_NOT_FOUND',
  'REFERENCE_NOT_FOUND',
  'REQUOTE_REQUIRED',
  'SESSION_NOT_FOUND',
  'SESSION_TERMINATED',
  'SIGNAL_NOT_FOUND',
  'TERMS_REJECTED',
  'VALIDATION_ERROR',
  'VERSION_UNSUPPORTED',
] as const;

export type ErrorCode = (typeof KNOWN_ERROR_CODES)[number];

const KNOWN_ERROR_CODE_SET: ReadonlySet<string> = new Set(KNOWN_ERROR_CODES);

/**
 * Detect typoed error codes in `AdcpError` constructor calls. The
 * `code: ErrorCode | (string & {})` escape hatch keeps platform-specific
 * codes available, but it also defeats autocomplete on misspellings —
 * `'BUDGET_TO_LOW'` (typo) compiles fine. The runtime warns once per
 * unknown code so `npm run dev` log review surfaces typos before they
 * ship to a buyer who can't pattern-match `recovery`.
 *
 * Set `ADCP_DECISIONING_ALLOW_CUSTOM_CODES=1` to silence the warn for
 * platforms that intentionally mint vendor-specific codes
 * (`'GAM_INTERNAL_QUOTA_EXCEEDED'` etc.).
 */
const warnedUnknownCodes = new Set<string>();
function maybeWarnUnknownErrorCode(code: string): void {
  if (KNOWN_ERROR_CODE_SET.has(code)) return;
  if (process.env.ADCP_DECISIONING_ALLOW_CUSTOM_CODES === '1') return;
  if (warnedUnknownCodes.has(code)) return;
  warnedUnknownCodes.add(code);
  // eslint-disable-next-line no-console
  console.warn(
    `[adcp/decisioning] AdcpError code "${code}" is not in the known ErrorCode set ` +
      `(45 standard codes per schemas/cache/3.0.0/enums/error-code.json). ` +
      `If this is intentional (vendor-specific code), set ADCP_DECISIONING_ALLOW_CUSTOM_CODES=1. ` +
      `Otherwise check spelling against the ErrorCode union.`
  );
}

/**
 * Structured error envelope. Mirrors `schemas/cache/3.0.0/core/error.json`.
 *
 * `recovery` is REQUIRED at this interface level. The wire schema makes it
 * optional; we tighten because every adopter needs to declare buyer-recovery
 * intent on every rejection — implicit "terminal" by absence has historically
 * caused buyers to misroute retries.
 *
 * Adopter code throws `AdcpError` (the class wrapper); the framework catches
 * and projects the structured fields onto the wire envelope.
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
   * and `SERVICE_UNAVAILABLE`; framework auto-fills if omitted.
   * Adopters MUST clamp to [1, 3600] per spec.
   */
  retry_after?: number;
  details?: Record<string, unknown>;
}

/**
 * Throwable structured error. Adopter code throws this to fail a specialism
 * method with a buyer-facing wire envelope.
 *
 * ```ts
 * createMediaBuy: async (req, ctx) => {
 *   if (req.total_budget.amount < this.floor) {
 *     throw new AdcpError('BUDGET_TOO_LOW', {
 *       recovery: 'correctable',
 *       message: `Floor is $${this.floor} CPM`,
 *       field: 'total_budget.amount',
 *     });
 *   }
 *   return await this.gam.createOrder(req);
 * }
 * ```
 *
 * Framework catches `AdcpError` from any specialism method and projects
 * the structured fields onto the wire `adcp_error` envelope.
 * Generic thrown errors map to `SERVICE_UNAVAILABLE` with `recovery: 'transient'`.
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
    maybeWarnUnknownErrorCode(code);
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

  /**
   * Override `Error.toString` so default `console.error(err)` /
   * CloudWatch / structured-log adopters see the `code` and `recovery`
   * alongside the message rather than the bare `AdcpError: <message>`
   * default. Triage in operator dashboards needs the code more than
   * the stack.
   */
  override toString(): string {
    return `AdcpError [${this.code}, ${this.recovery}]: ${this.message}`;
  }
}

// ---------------------------------------------------------------------------
// TaskHandoff — unified hybrid-seller shape
// ---------------------------------------------------------------------------

/**
 * Brand value framework checks at the dispatch seam to detect "this method
 * is handing off to a task." Module-level constant so adopters can't construct
 * one without going through `ctx.handoffToTask(fn)`.
 */
const TASK_HANDOFF_BRAND: unique symbol = Symbol.for('@adcp/decisioning/task-handoff');

/**
 * Marker the framework recognizes as "promote this call to a task."
 * Returned from `ctx.handoffToTask(fn)`. Type parameter `TResult` is the
 * eventual terminal artifact `fn` resolves to.
 *
 * Adopters never construct this directly — `ctx.handoffToTask(fn)` is the
 * only sanctioned producer. The framework's dispatch layer detects the
 * brand, allocates a `task_id`, returns the spec-defined `Submitted`
 * envelope to the buyer, and runs `fn` in the background. `fn`'s return
 * value becomes the task's terminal artifact; `throw AdcpError` becomes
 * the terminal error.
 *
 * Status: Preview / 6.0.
 *
 * @public
 */
export interface TaskHandoff<TResult> {
  readonly [TASK_HANDOFF_BRAND]: true;
  /** @internal — framework consumes this; adopters never read it. */
  readonly _taskFn: (taskCtx: TaskHandoffContext) => Promise<TResult>;
}

/**
 * Context the framework supplies to the handoff function. Mirrors
 * `RequestContext.task` from the deprecated `*Task` shape — `id` is the
 * framework-issued task id, `update`/`heartbeat` are the same affordances.
 *
 * @public
 */
export interface TaskHandoffContext {
  readonly id: string;
  update(progress: TaskHandoffProgress): Promise<void>;
  heartbeat(): Promise<void>;
}

export interface TaskHandoffProgress {
  message?: string;
  percentage?: number;
  step_number?: number;
  total_steps?: number;
  current_step?: string;
}

/**
 * Construct a `TaskHandoff<T>` marker. The framework's `ctx.handoffToTask`
 * helper invokes this; adopters don't call it directly.
 *
 * @internal
 */
export function _createTaskHandoff<TResult>(
  fn: (taskCtx: TaskHandoffContext) => Promise<TResult>
): TaskHandoff<TResult> {
  return {
    [TASK_HANDOFF_BRAND]: true,
    _taskFn: fn,
  };
}

/**
 * Type guard — does the value the adopter returned mark a task handoff?
 *
 * @internal
 */
export function isTaskHandoff<TResult>(value: unknown): value is TaskHandoff<TResult> {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<symbol, unknown>)[TASK_HANDOFF_BRAND] === true
  );
}
