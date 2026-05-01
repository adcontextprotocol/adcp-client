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

import { ErrorCodeValues } from '../../types/enums.generated';
import { getErrorRecovery, type StandardErrorCode } from '../../types/error-codes';

/**
 * Error code vocabulary mirroring `schemas/cache/<version>/enums/error-code.json`.
 * Derived from the generated `ErrorCodeValues` array so adding a code to the
 * spec lights up everywhere downstream (typo warn, `ErrorCode` union,
 * autocomplete) without a hand-edit. Adopters can return platform-specific
 * codes too — agents fall back to the `recovery` classification on unknowns
 * via the `(string & {})` escape hatch on `AdcpStructuredError.code`.
 */
export const KNOWN_ERROR_CODES = ErrorCodeValues;

export type ErrorCode = StandardErrorCode;

const KNOWN_ERROR_CODE_SET: ReadonlySet<string> = new Set<string>(KNOWN_ERROR_CODES);

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
      `(${KNOWN_ERROR_CODES.length} standard codes per schemas/cache/<version>/enums/error-code.json). ` +
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
      /**
       * Recovery classification. Optional — defaults to the spec-correct
       * value for any standard `code` (via `getErrorRecovery`). Pass an
       * explicit value only to override the spec default for a vendor-
       * specific reason; for non-standard codes the default is `correctable`.
       */
      recovery?: 'transient' | 'correctable' | 'terminal';
      message: string;
      field?: string;
      suggestion?: string;
      retry_after?: number;
      details?: Record<string, unknown>;
    }
  ) {
    super(options.message);
    this.code = code;
    this.recovery = options.recovery ?? getErrorRecovery(code) ?? 'correctable';
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
 * The handoff function lives in a WeakMap keyed by the `TaskHandoff`
 * marker object — NOT on the marker itself. This means the framework
 * can extract the function (it has the WeakMap reference) but adopters
 * holding only a `TaskHandoff<T>` value cannot invoke or inspect it.
 * Closes round-6 CR-3 / Protocol-L2: `_taskFn` was previously a
 * type-visible field that adopters could forge with their own
 * `Symbol.for(...)` call.
 */
const taskHandoffFns = new WeakMap<object, (taskCtx: TaskHandoffContext) => Promise<unknown>>();

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
 * The opaque `_taskFn` field exists only at the type level — at runtime
 * the function is stored in a module-private WeakMap keyed by the
 * marker, so adopters who try to invoke `handoff._taskFn(ctx)` directly
 * get `undefined`. The only way to run the handoff body is to return
 * the marker from a specialism method and let the framework dispatch.
 *
 * Status: Preview / 6.0.
 *
 * @public
 */
export interface TaskHandoff<TResult> {
  readonly [TASK_HANDOFF_BRAND]: true;
  /**
   * Phantom field — exists only at the type level so `TResult` is
   * preserved for inference. At runtime the slot is `undefined`; the
   * actual function lives in the framework's private WeakMap.
   *
   * @internal
   */
  readonly _taskResult?: TResult;
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
 * The `fn` is stashed in a module-private WeakMap keyed by the marker
 * object. Adopters can hold the marker and pass it through return
 * values, but cannot extract or invoke `fn` themselves — only the
 * framework's `_extractTaskFn` can.
 *
 * @internal
 */
export function _createTaskHandoff<TResult>(
  fn: (taskCtx: TaskHandoffContext) => Promise<TResult>
): TaskHandoff<TResult> {
  // Frozen object so adopters can't mutate the brand field. Even if
  // they did, the dispatch seam keys on identity (WeakMap), not on
  // mutable structure.
  const marker = Object.freeze({ [TASK_HANDOFF_BRAND]: true as const });
  taskHandoffFns.set(marker, fn as (taskCtx: TaskHandoffContext) => Promise<unknown>);
  return marker as TaskHandoff<TResult>;
}

/**
 * Type guard — does the value the adopter returned mark a task handoff?
 *
 * Checks both the symbol brand AND WeakMap presence. An adopter who
 * forges `{ [TASK_HANDOFF_BRAND]: true }` without going through
 * `_createTaskHandoff` won't be in the WeakMap and the guard returns
 * false. Belt-and-suspenders against forgery.
 *
 * @internal
 */
export function isTaskHandoff<TResult>(value: unknown): value is TaskHandoff<TResult> {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<symbol, unknown>)[TASK_HANDOFF_BRAND] === true &&
    taskHandoffFns.has(value as object)
  );
}

/**
 * Extract the handoff function from a marker. Framework-only — the
 * dispatch seam in `from-platform.ts` calls this after `isTaskHandoff`.
 * Returns `undefined` if the marker wasn't created by `_createTaskHandoff`
 * (forgery).
 *
 * @internal
 */
export function _extractTaskFn<TResult>(
  handoff: TaskHandoff<TResult>
): ((taskCtx: TaskHandoffContext) => Promise<TResult>) | undefined {
  return taskHandoffFns.get(handoff as unknown as object) as
    | ((taskCtx: TaskHandoffContext) => Promise<TResult>)
    | undefined;
}
