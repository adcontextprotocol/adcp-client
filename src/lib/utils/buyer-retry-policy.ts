import type { AdcpErrorInfo } from '../core/ConversationTypes';
import { STANDARD_ERROR_CODES, isStandardErrorCode, type StandardErrorCode } from '../types/error-codes';

/**
 * Action classification returned by BuyerRetryPolicy.decide().
 *
 * - `retry` — resubmit the unchanged request after `delayMs`. Reuse the same
 *   `idempotency_key` (the server returns the cached response on replay).
 * - `mutate-and-retry` — fix the request before resubmitting. Use a fresh
 *   `idempotency_key` for the corrected request. Consult `suggestion` and
 *   `field` for patching hints.
 * - `escalate` — automated recovery is not possible. Surface `reason` to the
 *   operator; do not retry autonomously.
 *
 * `maxAttempts` is always present: 0 for `escalate` (do not attempt),
 * otherwise the total number of allowed attempts for this operation.
 * `decide()` returns `escalate` automatically when `attempt > maxAttempts`.
 */
export type RetryDecision =
  | { action: 'retry'; delayMs: number; maxAttempts: number }
  | { action: 'mutate-and-retry'; suggestion?: string; field?: string; maxAttempts: number }
  | { action: 'escalate'; reason: string; maxAttempts: 0 };

/**
 * Context passed to BuyerRetryPolicy.decide().
 */
export interface RetryContext {
  /**
   * 1-indexed attempt number. First call = 1. Pass the current attempt count
   * so the policy can escalate automatically when the ceiling is reached.
   */
  attempt: number;
  /** Prior errors on this logical operation, if any. */
  history?: AdcpErrorInfo[];
}

/** Per-code override shape accepted by the BuyerRetryPolicy constructor. */
export interface RetryCodeOverride {
  action: RetryDecision['action'];
  maxAttempts?: number;
  /** Fixed delay in ms (retry action only; ignores exponential backoff). */
  delayMs?: number;
  /** Reason string (escalate action only). */
  reason?: string;
  /** Suggestion string (mutate-and-retry action only). */
  suggestion?: string;
}

export interface BuyerRetryPolicyOptions {
  /**
   * Per-code overrides for vertical-specific behavior.
   *
   * Example — allow programmatic POLICY_VIOLATION correction for a geo-fenced
   * vertical that can deterministically drop a blocked region:
   * ```ts
   * new BuyerRetryPolicy({ overrides: { POLICY_VIOLATION: { action: 'mutate-and-retry' } } })
   * ```
   */
  overrides?: Partial<Record<string, RetryCodeOverride>>;
}

// Internal per-code entry shape (pre-computed, no user-facing fields).
type CodeEntry =
  | { action: 'retry'; maxAttempts: number; baseDelayMs: number }
  | { action: 'mutate-and-retry'; maxAttempts: number; suggestion?: string }
  | { action: 'escalate'; reason: string };

// Default per-code policy table.
// Codes absent from this table fall through to the recovery-class fallback below.
const DEFAULT_TABLE: Partial<Record<StandardErrorCode, CodeEntry>> = {
  // Transient — retry with exponential backoff
  RATE_LIMITED: { action: 'retry', maxAttempts: 5, baseDelayMs: 1_000 },
  SERVICE_UNAVAILABLE: { action: 'retry', maxAttempts: 3, baseDelayMs: 2_000 },

  // Transient — re-read then re-submit
  CONFLICT: {
    action: 'mutate-and-retry',
    maxAttempts: 2,
    suggestion: 'Re-read the resource to get the latest revision before retrying the write',
  },

  // Transient but operator-only resolution — buyer cannot self-unblock
  GOVERNANCE_UNAVAILABLE: {
    action: 'escalate',
    reason: 'Governance agent is unavailable; operator must restore the governance endpoint out-of-band',
  },
  CAMPAIGN_SUSPENDED: {
    action: 'escalate',
    reason: 'Campaign governance suspended pending human review; operator action required',
  },

  // Correctable but governance/evasion risk — always escalate
  POLICY_VIOLATION: {
    action: 'escalate',
    reason:
      'Content or targeting violates seller policy; automated mutation looks like evasion — human review required',
  },
  COMPLIANCE_UNSATISFIED: {
    action: 'escalate',
    reason: 'Compliance requirement cannot be satisfied automatically; human review required',
  },
  GOVERNANCE_DENIED: {
    action: 'escalate',
    reason: 'Governance agent denied the transaction; escalate to plan operator',
  },
  CREATIVE_REJECTED: {
    action: 'escalate',
    reason: 'Creative failed seller content policy review; automated creative substitution looks like evasion',
  },

  // Correctable but requires out-of-band operator action
  AUTH_REQUIRED: {
    action: 'escalate',
    // Until adcontextprotocol/adcp#3727 splits auth_missing vs auth_invalid,
    // treat all cases as escalate: revoked credentials need operator rotation.
    reason: 'Authentication required; operator credential rotation may be needed (see adcp#3727)',
  },
  PERMISSION_DENIED: {
    action: 'escalate',
    reason: 'Caller not authorized for this action; operator permission grant required',
  },
  UNSUPPORTED_FEATURE: {
    action: 'escalate',
    reason: 'Feature not supported by this seller; capability discovery required before retrying',
  },
  VERSION_UNSUPPORTED: {
    action: 'escalate',
    reason: 'AdCP major version not supported; check supported_versions in error details and re-negotiate',
  },
  ACCOUNT_SETUP_REQUIRED: {
    action: 'escalate',
    reason: 'Account onboarding incomplete; operator must complete setup before buys are accepted',
  },
  ACCOUNT_AMBIGUOUS: {
    action: 'escalate',
    reason: 'Natural key matches multiple accounts; operator disambiguation required',
  },
  SESSION_TERMINATED: {
    action: 'mutate-and-retry',
    maxAttempts: 1,
    suggestion:
      'The SI session has been terminated. Re-initiate a new session via si_initiate_session with a fresh idempotency_key.',
  },

  // Idempotency — correctable but with key-specific mutation guidance
  IDEMPOTENCY_CONFLICT: {
    action: 'mutate-and-retry',
    maxAttempts: 1,
    suggestion: 'The idempotency_key was reused with a different payload. Mint a fresh UUID v4 for the new request.',
  },
  IDEMPOTENCY_EXPIRED: {
    action: 'mutate-and-retry',
    maxAttempts: 1,
    suggestion:
      'The idempotency_key is past the replay window. Look up the resource by natural key first to check if the original request succeeded; then mint a fresh UUID v4.',
  },

  // Correctable — mutate-and-retry with terms re-quote
  TERMS_REJECTED: {
    action: 'mutate-and-retry',
    maxAttempts: 1,
    suggestion: 'Buyer-proposed measurement terms were rejected; re-negotiate terms before resubmitting',
  },
  REQUOTE_REQUIRED: {
    action: 'mutate-and-retry',
    maxAttempts: 1,
    suggestion:
      'Parameter envelope changed since original quote; re-run get_products and use the new pricing_option_id',
  },
};

/** Compute exponential backoff in ms, capped at 60s. */
function exponentialBackoff(attempt: number, baseMs: number): number {
  return Math.min(baseMs * Math.pow(2, attempt - 1), 60_000);
}

/**
 * Buyer-side retry policy helper.
 *
 * Translates an `AdcpErrorInfo` into a concrete `RetryDecision` with
 * per-code defaults that reflect operator semantics — not just the spec's
 * three-class `recovery` enum. Specifically:
 *
 * - `POLICY_VIOLATION`, `COMPLIANCE_UNSATISFIED`, `GOVERNANCE_DENIED`, and
 *   `CREATIVE_REJECTED` are spec-`correctable` but always escalate: automated
 *   mutation looks like policy evasion to seller governance.
 * - `AUTH_REQUIRED` and `PERMISSION_DENIED` escalate: credential issues need
 *   operator rotation, not retry.
 * - `IDEMPOTENCY_CONFLICT` / `IDEMPOTENCY_EXPIRED` carry targeted `suggestion`
 *   strings to prevent duplicate financial transactions.
 *
 * @example Static usage (default policy):
 * ```ts
 * import { BuyerRetryPolicy } from '@adcp/sdk';
 *
 * const decision = BuyerRetryPolicy.decide(result.adcpError, { attempt });
 * if (decision.action === 'retry') {
 *   await sleep(decision.delayMs);
 *   return retry(idempotencyKey); // same key — idempotent replay
 * }
 * if (decision.action === 'mutate-and-retry') {
 *   // Patch the request using decision.field / decision.suggestion,
 *   // then resubmit with a FRESH idempotency_key.
 *   return retryWithCorrection(decision);
 * }
 * throw new EscalationRequired(error, decision.reason);
 * ```
 *
 * @example Override for a vertical that can programmatically handle policy violations:
 * ```ts
 * const policy = new BuyerRetryPolicy({
 *   overrides: { POLICY_VIOLATION: { action: 'mutate-and-retry' } },
 * });
 * ```
 */
export class BuyerRetryPolicy {
  private static readonly _default = new BuyerRetryPolicy();

  private readonly overrides: Partial<Record<string, RetryCodeOverride>>;

  constructor(options?: BuyerRetryPolicyOptions) {
    this.overrides = options?.overrides ?? {};
  }

  /**
   * Decide the retry action for a failed request.
   *
   * @param error - The `AdcpErrorInfo` from a failed `TaskResult`.
   * @param ctx - `attempt` is 1-indexed (first call = 1).
   *   When `attempt` exceeds the policy's `maxAttempts` for the code, the
   *   method returns `{ action: 'escalate' }` automatically.
   */
  decide(error: AdcpErrorInfo, ctx: RetryContext): RetryDecision {
    const { code, retryAfterMs, field, suggestion } = error;
    const { attempt } = ctx;

    // User overrides take precedence over the default table.
    const override = this.overrides[code];
    if (override) {
      return this._applyOverride(override, error, attempt);
    }

    // Per-code default table checked before recovery-class fallback — critical
    // for codes whose operator semantics differ from their spec recovery class
    // (e.g. GOVERNANCE_UNAVAILABLE is `transient` but buyer cannot self-resolve).
    const entry = DEFAULT_TABLE[code as StandardErrorCode];
    if (entry) {
      return this._applyEntry(entry, error, attempt);
    }

    // Recovery-class fallback for codes not in the per-code table.
    const recovery =
      error.recovery ??
      (isStandardErrorCode(code) ? STANDARD_ERROR_CODES[code as StandardErrorCode].recovery : 'terminal');

    if (recovery === 'transient') {
      const maxAttempts = 3;
      if (attempt > maxAttempts) {
        return {
          action: 'escalate',
          reason: `Max attempts (${maxAttempts}) reached for transient error ${code}`,
          maxAttempts: 0,
        };
      }
      return {
        action: 'retry',
        delayMs: retryAfterMs ?? exponentialBackoff(attempt, 2_000),
        maxAttempts,
      };
    }

    if (recovery === 'correctable') {
      const maxAttempts = 1;
      if (attempt > maxAttempts) {
        return {
          action: 'escalate',
          reason: `Max attempts (${maxAttempts}) reached for correctable error ${code}`,
          maxAttempts: 0,
        };
      }
      return {
        action: 'mutate-and-retry',
        suggestion,
        field,
        maxAttempts,
      };
    }

    // terminal (or unknown recovery)
    return {
      action: 'escalate',
      reason: `Terminal error: ${code}${error.message ? ` — ${error.message}` : ''}`,
      maxAttempts: 0,
    };
  }

  private _applyEntry(entry: CodeEntry, error: AdcpErrorInfo, attempt: number): RetryDecision {
    if (entry.action === 'escalate') {
      return { action: 'escalate', reason: entry.reason, maxAttempts: 0 };
    }

    if (attempt > entry.maxAttempts) {
      return {
        action: 'escalate',
        reason: `Max attempts (${entry.maxAttempts}) reached for ${error.code}`,
        maxAttempts: 0,
      };
    }

    if (entry.action === 'retry') {
      return {
        action: 'retry',
        delayMs: error.retryAfterMs ?? exponentialBackoff(attempt, entry.baseDelayMs),
        maxAttempts: entry.maxAttempts,
      };
    }

    // mutate-and-retry
    return {
      action: 'mutate-and-retry',
      suggestion: entry.suggestion ?? error.suggestion,
      field: error.field,
      maxAttempts: entry.maxAttempts,
    };
  }

  private _applyOverride(override: RetryCodeOverride, error: AdcpErrorInfo, attempt: number): RetryDecision {
    if (override.action === 'escalate') {
      return {
        action: 'escalate',
        reason: override.reason ?? `Escalated by policy override for ${error.code}`,
        maxAttempts: 0,
      };
    }

    const maxAttempts = override.maxAttempts ?? 1;
    if (attempt > maxAttempts) {
      return {
        action: 'escalate',
        reason: `Max attempts (${maxAttempts}) reached for ${error.code}`,
        maxAttempts: 0,
      };
    }

    if (override.action === 'retry') {
      return {
        action: 'retry',
        delayMs: override.delayMs ?? error.retryAfterMs ?? exponentialBackoff(attempt, 1_000),
        maxAttempts,
      };
    }

    return {
      action: 'mutate-and-retry',
      suggestion: override.suggestion ?? error.suggestion,
      field: error.field,
      maxAttempts,
    };
  }

  /**
   * Decide using the default policy (no overrides).
   * Equivalent to `new BuyerRetryPolicy().decide(error, ctx)`.
   */
  static decide(error: AdcpErrorInfo, ctx: RetryContext): RetryDecision {
    return BuyerRetryPolicy._default.decide(error, ctx);
  }
}
