/**
 * Buyer-side retry policy for AdCP errors.
 *
 * Translates an `AdcpStructuredError` into an actionable `RetryDecision`,
 * baked with operator-grade defaults so naive buyer agent loops don't:
 *
 * - Retry-storm on revoked credentials (`AUTH_REQUIRED`).
 * - Auto-mutate-and-resubmit on policy/governance/compliance signals
 *   (which looks like evasion to seller-side reviewers).
 * - Spin on `*_NOT_FOUND` errors with a stale id instead of re-discovering.
 * - Hold the same `idempotency_key` after a `correctable` correction
 *   (which lets the seller's replay-window dedupe ignore the new payload).
 *
 * The spec's `recovery` field is a 3-class enum (`transient` / `correctable`
 * / `terminal`); the operator semantic varies WITHIN `correctable`. This
 * module hardcodes the operator-grade interpretation per code.
 *
 * @public
 */

import type { AdcpStructuredError, ErrorCode } from '../server/decisioning/async-outcome';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * What the buyer agent should do next. Discriminated by `action`.
 *
 * - `retry`: replay with the SAME `idempotency_key` after `delayMs`. Use for
 *   server-side transients (`RATE_LIMITED`, `SERVICE_UNAVAILABLE`, `CONFLICT`).
 * - `mutate-and-retry`: apply the seller's correction hint (read
 *   `error.field` / `error.suggestion`), then call again with a FRESH
 *   `idempotency_key` because the payload is now semantically different.
 * - `escalate`: stop the agent loop and surface to a human. Includes
 *   commercial-relationship signals, auth failures, terminal errors,
 *   attempt-cap exhaustion, and unknown vendor codes.
 */
export type RetryDecision =
  | {
      action: 'retry';
      /** Delay before the retry, in milliseconds. Honors `error.retry_after` when present. */
      delayMs: number;
      /** Maximum attempts (including the original) before escalating. */
      attemptCap: number;
      /** Caller MUST replay with the same `idempotency_key`. */
      sameIdempotencyKey: true;
      reason: string;
    }
  | {
      action: 'mutate-and-retry';
      /**
       * Suggested pre-retry delay in milliseconds. Lightweight jitter so fleet
       * operators don't all hit the seller in the same instant after a
       * correlated storm (e.g., `PROPOSAL_EXPIRED` across thousands of
       * campaigns at once).
       */
      delayMs: number;
      /** Maximum attempts (including the original) before escalating. */
      attemptCap: number;
      /** Caller MUST mint a fresh `idempotency_key` because the payload changes. */
      sameIdempotencyKey: false;
      reason: 'redirect' | 'budget' | 'requote' | 'validation' | 'capability' | 'state';
      /** The field the seller flagged. Mirrors `error.field`. */
      field?: string;
      /** The seller's correction hint. Mirrors `error.suggestion`. */
      suggestion?: string;
    }
  | {
      action: 'escalate';
      reason:
        | 'commercial' // POLICY_VIOLATION / COMPLIANCE_UNSATISFIED / GOVERNANCE_DENIED — human review
        | 'auth' // AUTH_REQUIRED / PERMISSION_DENIED — operator must rotate creds / grant access
        | 'governance_unreachable' // GOVERNANCE_UNAVAILABLE / CAMPAIGN_SUSPENDED — out-of-band
        | 'idempotency_check_required' // IDEMPOTENCY_EXPIRED — buyer MUST do a natural-key check before minting a new key (spec safety constraint to prevent double-creation)
        | 'terminal' // spec recovery 'terminal' (account suspended, budget exhausted, …)
        | 'attempts_exhausted' // hit attemptCap — caller already retried as many times as the policy allows
        | 'unknown'; // non-standard code, no policy override — buyer surfaces to user
      /** Human-facing message. Mirrors `error.message`. */
      message: string;
    };

/**
 * Context the caller passes about the current state of the operation.
 */
export interface RetryContext {
  /** Current attempt number, 1-indexed. The original call is attempt 1. */
  attempt?: number;
  /** Prior errors on this logical operation. Used for repeat-failure escalation. */
  history?: AdcpStructuredError[];
}

/**
 * Override hook for adopters with vertical-specific policy needs.
 * Receives the error + context; returns a `RetryDecision` or `null` to fall
 * through to the default policy.
 */
export type RetryDecisionOverride = (error: AdcpStructuredError, ctx: RetryContext) => RetryDecision | null;

// ---------------------------------------------------------------------------
// Default per-code policy table
// ---------------------------------------------------------------------------

type CodePolicy =
  | {
      action: 'retry';
      attemptCap: number;
      baseDelayMs: number;
      /** When true, scales `baseDelayMs` by 2^(attempt-1), clamped to 3600s. */
      expBackoff?: boolean;
    }
  | {
      action: 'mutate-and-retry';
      attemptCap: number;
      reason: Extract<RetryDecision, { action: 'mutate-and-retry' }>['reason'];
      /** Pre-retry delay (jitter window). Helps fleet operators avoid a thundering herd. */
      baseDelayMs?: number;
    }
  | {
      action: 'escalate';
      escalateReason: Extract<RetryDecision, { action: 'escalate' }>['reason'];
    };

/**
 * Defaults per standard error code. Each entry is operator-grade — what the
 * buyer SHOULD do, not just what the spec's `recovery` field says.
 *
 * Where this diverges from the spec's `recovery`:
 * - `POLICY_VIOLATION`, `COMPLIANCE_UNSATISFIED`, `GOVERNANCE_DENIED` are
 *   spec-`correctable` but escalate here (commercial-relationship signals;
 *   auto-tweak looks like evasion).
 * - `AUTH_REQUIRED` is spec-`correctable` but escalate here (conflates
 *   missing-creds with revoked-creds; tracked upstream at adcp#3730).
 * - `GOVERNANCE_UNAVAILABLE`, `CAMPAIGN_SUSPENDED` are spec-`transient` but
 *   escalate here (out-of-band — agent can't unblock).
 */
const DEFAULT_CODE_POLICY: Record<ErrorCode, CodePolicy> = {
  // Transients — server-side, retry-safe with same idempotency_key.
  RATE_LIMITED: { action: 'retry', attemptCap: 5, baseDelayMs: 1000, expBackoff: true },
  SERVICE_UNAVAILABLE: { action: 'retry', attemptCap: 3, baseDelayMs: 1000, expBackoff: true },
  CONFLICT: { action: 'retry', attemptCap: 2, baseDelayMs: 0 },

  // Out-of-band transients — agent can't unblock; surface to operator.
  GOVERNANCE_UNAVAILABLE: { action: 'escalate', escalateReason: 'governance_unreachable' },
  CAMPAIGN_SUSPENDED: { action: 'escalate', escalateReason: 'governance_unreachable' },

  // Resource-not-found — re-discover and retry. attemptCap: 3 so a buyer with
  // a stale cache can list, mutate, list-again-on-second-staleness, and still
  // succeed before escalation.
  ACCOUNT_NOT_FOUND: { action: 'mutate-and-retry', attemptCap: 3, reason: 'redirect', baseDelayMs: 250 },
  MEDIA_BUY_NOT_FOUND: { action: 'mutate-and-retry', attemptCap: 3, reason: 'redirect', baseDelayMs: 250 },
  PACKAGE_NOT_FOUND: { action: 'mutate-and-retry', attemptCap: 3, reason: 'redirect', baseDelayMs: 250 },
  PRODUCT_NOT_FOUND: { action: 'mutate-and-retry', attemptCap: 3, reason: 'redirect', baseDelayMs: 250 },
  CREATIVE_NOT_FOUND: { action: 'mutate-and-retry', attemptCap: 3, reason: 'redirect', baseDelayMs: 250 },
  SIGNAL_NOT_FOUND: { action: 'mutate-and-retry', attemptCap: 3, reason: 'redirect', baseDelayMs: 250 },
  SESSION_NOT_FOUND: { action: 'mutate-and-retry', attemptCap: 3, reason: 'redirect', baseDelayMs: 250 },
  PLAN_NOT_FOUND: { action: 'mutate-and-retry', attemptCap: 3, reason: 'redirect', baseDelayMs: 250 },
  REFERENCE_NOT_FOUND: { action: 'mutate-and-retry', attemptCap: 3, reason: 'redirect', baseDelayMs: 250 },

  // Stale-resource — re-discover. Same as not-found family.
  PRODUCT_EXPIRED: { action: 'mutate-and-retry', attemptCap: 3, reason: 'redirect', baseDelayMs: 250 },
  PROPOSAL_EXPIRED: { action: 'mutate-and-retry', attemptCap: 3, reason: 'redirect', baseDelayMs: 250 },
  PRODUCT_UNAVAILABLE: { action: 'mutate-and-retry', attemptCap: 3, reason: 'redirect', baseDelayMs: 250 },

  // Capability mismatch — drop the unsupported field and retry.
  UNSUPPORTED_FEATURE: { action: 'mutate-and-retry', attemptCap: 2, reason: 'capability', baseDelayMs: 250 },
  VERSION_UNSUPPORTED: { action: 'mutate-and-retry', attemptCap: 2, reason: 'capability', baseDelayMs: 250 },

  // Re-quote — go back to get_products in 'refine' mode against the proposal.
  TERMS_REJECTED: { action: 'mutate-and-retry', attemptCap: 3, reason: 'requote', baseDelayMs: 250 },
  REQUOTE_REQUIRED: { action: 'mutate-and-retry', attemptCap: 3, reason: 'requote', baseDelayMs: 250 },
  PROPOSAL_NOT_COMMITTED: { action: 'mutate-and-retry', attemptCap: 2, reason: 'requote', baseDelayMs: 250 },
  IO_REQUIRED: { action: 'mutate-and-retry', attemptCap: 2, reason: 'requote', baseDelayMs: 250 },

  // Budget — adjust and retry.
  BUDGET_TOO_LOW: { action: 'mutate-and-retry', attemptCap: 2, reason: 'budget', baseDelayMs: 250 },
  BUDGET_EXCEEDED: { action: 'mutate-and-retry', attemptCap: 2, reason: 'budget', baseDelayMs: 250 },
  AUDIENCE_TOO_SMALL: { action: 'mutate-and-retry', attemptCap: 2, reason: 'budget', baseDelayMs: 250 },

  // Validation / state — read issues[] and patch.
  INVALID_REQUEST: { action: 'mutate-and-retry', attemptCap: 2, reason: 'validation', baseDelayMs: 250 },
  VALIDATION_ERROR: { action: 'mutate-and-retry', attemptCap: 2, reason: 'validation', baseDelayMs: 250 },
  INVALID_STATE: { action: 'mutate-and-retry', attemptCap: 2, reason: 'state', baseDelayMs: 250 },
  NOT_CANCELLABLE: { action: 'mutate-and-retry', attemptCap: 2, reason: 'state', baseDelayMs: 250 },

  // Idempotency:
  // - CONFLICT (different payload, same key in window) — fresh key + retry is safe;
  //   the seller already rejected the new payload before doing any work.
  // - EXPIRED (cached response evicted past replay_ttl) — DO NOT auto-retry. The
  //   spec explicitly warns: if the prior call may have succeeded, the buyer
  //   MUST do a natural-key check (e.g., get_media_buys by buyer_ref) BEFORE
  //   minting a new key. Otherwise this is exactly how double-creation happens.
  IDEMPOTENCY_CONFLICT: { action: 'mutate-and-retry', attemptCap: 2, reason: 'validation', baseDelayMs: 250 },
  IDEMPOTENCY_EXPIRED: { action: 'escalate', escalateReason: 'idempotency_check_required' },

  // Creative deadline — buyer can re-negotiate or surface to user.
  CREATIVE_DEADLINE_EXCEEDED: { action: 'mutate-and-retry', attemptCap: 2, reason: 'state', baseDelayMs: 250 },

  // Account state — operator must resolve.
  // ACCOUNT_AMBIGUOUS: spec says "pass explicit account_id" but the agent
  // typically doesn't have the right id cached without going back to
  // list_accounts — escalating with the seller's hint is more honest than
  // burning a retry on a guaranteed-wrong replay.
  ACCOUNT_AMBIGUOUS: { action: 'escalate', escalateReason: 'auth' },
  ACCOUNT_SETUP_REQUIRED: { action: 'escalate', escalateReason: 'auth' },
  ACCOUNT_PAYMENT_REQUIRED: { action: 'escalate', escalateReason: 'auth' },
  ACCOUNT_SUSPENDED: { action: 'escalate', escalateReason: 'terminal' },
  BUDGET_EXHAUSTED: { action: 'escalate', escalateReason: 'terminal' },

  // SI session — recreate.
  SESSION_TERMINATED: { action: 'mutate-and-retry', attemptCap: 2, reason: 'redirect', baseDelayMs: 250 },

  // Creative rejection — surface to user; agent shouldn't auto-modify creative.
  // (Format-mismatch rejections are technically buyer-fixable, but the spec
  // doesn't structurally distinguish them from brand-safety rejections; pessimistic
  // default. Adopters with creative-template platforms can override per-code.)
  CREATIVE_REJECTED: { action: 'escalate', escalateReason: 'commercial' },

  // Commercial-relationship signals — DO NOT auto-tweak. Human in loop.
  POLICY_VIOLATION: { action: 'escalate', escalateReason: 'commercial' },
  COMPLIANCE_UNSATISFIED: { action: 'escalate', escalateReason: 'commercial' },
  GOVERNANCE_DENIED: { action: 'escalate', escalateReason: 'commercial' },

  // Auth — until adcp#3730 splits missing-vs-revoked, escalate. Otherwise
  // naive loops hammer SSO endpoints on revoked tokens.
  AUTH_REQUIRED: { action: 'escalate', escalateReason: 'auth' },
  PERMISSION_DENIED: { action: 'escalate', escalateReason: 'auth' },
};

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/** Cap on any computed retry delay. Mirrors the spec's `retry_after` range [1, 3600]. */
const MAX_DELAY_MS = 3_600_000;

function clampDelayMs(
  retryAfterSeconds: number | undefined,
  fallbackMs: number,
  attempt: number,
  exp: boolean
): number {
  if (typeof retryAfterSeconds === 'number' && retryAfterSeconds > 0) {
    return Math.max(1, Math.min(3600, Math.floor(retryAfterSeconds))) * 1000;
  }
  if (exp) {
    return Math.min(MAX_DELAY_MS, fallbackMs * Math.pow(2, Math.max(0, attempt - 1)));
  }
  return Math.min(MAX_DELAY_MS, fallbackMs);
}

function applyPolicy(
  policy: CodePolicy | undefined,
  error: AdcpStructuredError,
  attempt: number,
  fallbackByRecovery: 'mutate' | 'escalate-unknown'
): RetryDecision {
  if (!policy) {
    // No per-code policy entry — fall back by recovery class.
    if (error.recovery === 'transient') {
      const delayMs = clampDelayMs(error.retry_after, 1000, attempt, true);
      return {
        action: 'retry',
        delayMs,
        attemptCap: 3,
        sameIdempotencyKey: true,
        reason: `transient (${error.code})`,
      };
    }
    if (error.recovery === 'terminal') {
      return { action: 'escalate', reason: 'terminal', message: error.message };
    }
    if (fallbackByRecovery === 'mutate') {
      const jitterMs = Math.floor(250 * (0.5 + Math.random() * 0.5));
      return {
        action: 'mutate-and-retry',
        delayMs: jitterMs,
        attemptCap: 2,
        sameIdempotencyKey: false,
        reason: 'validation',
        ...(error.field !== undefined && { field: error.field }),
        ...(error.suggestion !== undefined && { suggestion: error.suggestion }),
      };
    }
    return { action: 'escalate', reason: 'unknown', message: error.message };
  }

  if (policy.action === 'escalate') {
    return { action: 'escalate', reason: policy.escalateReason, message: error.message };
  }

  if (attempt >= policy.attemptCap) {
    return { action: 'escalate', reason: 'attempts_exhausted', message: error.message };
  }

  if (policy.action === 'retry') {
    const delayMs = clampDelayMs(error.retry_after, policy.baseDelayMs, attempt, policy.expBackoff ?? false);
    return {
      action: 'retry',
      delayMs,
      attemptCap: policy.attemptCap,
      sameIdempotencyKey: true,
      reason: `transient (${error.code})`,
    };
  }

  // mutate-and-retry. Add small jitter (50-100% of baseDelayMs, default
  // 250ms) so fleet operators don't all hit the seller at once after a
  // correlated storm (e.g., PROPOSAL_EXPIRED across thousands of campaigns).
  const base = policy.baseDelayMs ?? 250;
  const jitterMs = Math.floor(base * (0.5 + Math.random() * 0.5));
  return {
    action: 'mutate-and-retry',
    delayMs: Math.min(MAX_DELAY_MS, jitterMs),
    attemptCap: policy.attemptCap,
    sameIdempotencyKey: false,
    reason: policy.reason,
    ...(error.field !== undefined && { field: error.field }),
    ...(error.suggestion !== undefined && { suggestion: error.suggestion }),
  };
}

/**
 * Buyer-side retry policy with operator-grade defaults per AdCP error code.
 *
 * @example
 * ```ts
 * import { decideRetry, type RetryDecision } from '@adcp/sdk';
 *
 * try {
 *   return await callAgent({ idempotency_key: key, ... });
 * } catch (e) {
 *   const error = extractAdcpError(e);
 *   const decision = decideRetry(error, { attempt });
 *
 *   if (decision.action === 'retry') {
 *     await sleep(decision.delayMs);
 *     return callAgent({ idempotency_key: key, ... }); // SAME key
 *   }
 *   if (decision.action === 'mutate-and-retry') {
 *     // Apply correction (decision.field, decision.suggestion), fresh key.
 *     return callAgent({ idempotency_key: crypto.randomUUID(), ... });
 *   }
 *   throw new Error(`Escalate: ${decision.reason} — ${decision.message}`);
 * }
 * ```
 */
export class BuyerRetryPolicy {
  private readonly overrides: ReadonlyMap<string, RetryDecisionOverride>;
  private readonly unknownCode: 'mutate' | 'escalate';

  constructor(
    opts: {
      /**
       * Per-code override functions. Keyed by error code (typed as
       * `Partial<Record<ErrorCode, RetryDecisionOverride>>` so typos like
       * `POLICY_VIOLATIN` fail compile). Returns `null` to fall through to
       * the default policy.
       */
      overrides?: Partial<Record<ErrorCode, RetryDecisionOverride>> & Record<string, RetryDecisionOverride>;
      /**
       * What to do when the error code is not in the standard vocabulary
       * AND has no per-code override. `'escalate'` (default) is the safer
       * choice for unknown vendor codes — buyer surfaces to user.
       * `'mutate'` lets the buyer attempt a generic correction-and-retry.
       */
      unknownCode?: 'mutate' | 'escalate';
    } = {}
  ) {
    this.overrides = new Map(Object.entries(opts.overrides ?? {}));
    this.unknownCode = opts.unknownCode ?? 'escalate';
  }

  decide(error: AdcpStructuredError, ctx: RetryContext = {}): RetryDecision {
    const attempt = Math.max(1, ctx.attempt ?? 1);
    const override = this.overrides.get(error.code);
    if (override) {
      const result = override(error, { ...ctx, attempt });
      if (result) return result;
    }
    const policy = DEFAULT_CODE_POLICY[error.code as ErrorCode];
    return applyPolicy(policy, error, attempt, this.unknownCode === 'mutate' ? 'mutate' : 'escalate-unknown');
  }
}

const defaultPolicy = new BuyerRetryPolicy();

/**
 * Decide what a buyer should do next given an AdCP error.
 *
 * Convenience wrapper for `new BuyerRetryPolicy().decide(error, ctx)`.
 * Use the class directly when you need per-code overrides.
 *
 * @public
 */
export function decideRetry(error: AdcpStructuredError, ctx: RetryContext = {}): RetryDecision {
  return defaultPolicy.decide(error, ctx);
}
