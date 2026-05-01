/**
 * Typed `AdcpError` subclasses. Adopters pick from a closed set of class
 * imports rather than memorizing string codes + recovery semantics.
 *
 * Each class encodes the canonical `code` / `field` / `suggestion` shape
 * for its scenario. `recovery` is inherited from the spec via
 * `getErrorRecovery(code)` — these classes never hardcode it. That keeps
 * the typed-class hierarchy in lockstep with the canonical recovery
 * classifications in `STANDARD_ERROR_CODES` (which derives from the
 * generated `ErrorCodeValues`). When the spec rev changes a recovery
 * value, every typed class picks it up automatically.
 *
 * LLM-generated platforms get autocomplete on the import; humans skim
 * the list to find the right class for their case.
 *
 * Empirical baseline (Emma matrix v17, 2026-04-30): LLM-generated
 * sellers throw generic `Error` because the AdcpError code catalog
 * isn't visible at the throw site. Framework auto-maps generic throws
 * to `SERVICE_UNAVAILABLE`, which storyboards reject because (e.g.)
 * the right code for "package_id doesn't exist" is `PACKAGE_NOT_FOUND`.
 * Typed classes close the gap: the LLM imports `PackageNotFoundError`
 * and the right code is implicit.
 *
 * **Coverage**: the ~20 highest-traffic codes from the v3 spec. Adopters
 * needing a code not in this list still construct `AdcpError(code, ...)`
 * directly with the full code vocabulary; this module is a convenience
 * over the typed-class subset.
 *
 * @public
 */

import { AdcpError } from './async-outcome';

interface CommonOpts {
  /** Override the default message. Most callers use the default. */
  message?: string;
  /** Suggested fix surfaced to the buyer. */
  suggestion?: string;
  /** Additional structured context. */
  details?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Resource-not-found family.
// ---------------------------------------------------------------------------

export class PackageNotFoundError extends AdcpError {
  constructor(packageId: string, opts: CommonOpts = {}) {
    super('PACKAGE_NOT_FOUND', {
      message: opts.message ?? `Package not found: ${packageId}`,
      field: 'package_id',
      ...(opts.suggestion !== undefined && { suggestion: opts.suggestion }),
      ...(opts.details !== undefined && { details: opts.details }),
    });
  }
}

export class MediaBuyNotFoundError extends AdcpError {
  constructor(mediaBuyId: string, opts: CommonOpts = {}) {
    super('MEDIA_BUY_NOT_FOUND', {
      message: opts.message ?? `Media buy not found: ${mediaBuyId}`,
      field: 'media_buy_id',
      ...(opts.suggestion !== undefined && { suggestion: opts.suggestion }),
      ...(opts.details !== undefined && { details: opts.details }),
    });
  }
}

export class ProductNotFoundError extends AdcpError {
  constructor(productId: string, opts: CommonOpts = {}) {
    super('PRODUCT_NOT_FOUND', {
      message: opts.message ?? `Product not found: ${productId}`,
      field: 'product_id',
      ...(opts.suggestion !== undefined && { suggestion: opts.suggestion }),
      ...(opts.details !== undefined && { details: opts.details }),
    });
  }
}

export class CreativeNotFoundError extends AdcpError {
  constructor(creativeId: string, opts: CommonOpts = {}) {
    super('CREATIVE_NOT_FOUND', {
      message: opts.message ?? `Creative not found: ${creativeId}`,
      field: 'creative_id',
      ...(opts.suggestion !== undefined && { suggestion: opts.suggestion }),
      ...(opts.details !== undefined && { details: opts.details }),
    });
  }
}

// Note: an `AccountNotFoundError` already exists in `./account` as a plain
// `Error` subclass for the framework's `accounts.resolve()` path (caught
// and translated internally). Adopters who need the wire-facing
// `ACCOUNT_NOT_FOUND` error code throw `new AdcpError('ACCOUNT_NOT_FOUND',
// { message: '...', field: 'account.id' })` directly — recovery defaults
// to the spec value (`terminal`) via `getErrorRecovery`.

// ---------------------------------------------------------------------------
// Resource-unavailable family — id is right but state precludes use.
// ---------------------------------------------------------------------------

export class ProductUnavailableError extends AdcpError {
  constructor(productId: string, opts: CommonOpts = {}) {
    super('PRODUCT_UNAVAILABLE', {
      message: opts.message ?? `Product unavailable (sold out / no inventory): ${productId}`,
      field: 'product_id',
      ...(opts.suggestion !== undefined && { suggestion: opts.suggestion }),
      ...(opts.details !== undefined && { details: opts.details }),
    });
  }
}

export class CreativeRejectedError extends AdcpError {
  constructor(creativeId: string, reason: string, opts: CommonOpts = {}) {
    super('CREATIVE_REJECTED', {
      message: opts.message ?? `Creative ${creativeId} rejected: ${reason}`,
      field: 'creative_id',
      ...(opts.suggestion !== undefined && { suggestion: opts.suggestion }),
      details: { ...(opts.details ?? {}), reason },
    });
  }
}

// ---------------------------------------------------------------------------
// Budget family
// ---------------------------------------------------------------------------

export class BudgetTooLowError extends AdcpError {
  constructor(opts: CommonOpts & { floor?: number; currency?: string } = {}) {
    const floorStr =
      opts.floor != null && opts.currency != null
        ? `Floor is ${opts.floor} ${opts.currency}.`
        : opts.floor != null
          ? `Floor is ${opts.floor}.`
          : 'Budget below required floor.';
    super('BUDGET_TOO_LOW', {
      message: opts.message ?? floorStr,
      field: 'total_budget',
      ...(opts.suggestion !== undefined && { suggestion: opts.suggestion }),
      ...(opts.floor != null && { details: { ...(opts.details ?? {}), floor: opts.floor, currency: opts.currency } }),
    });
  }
}

export class BudgetExhaustedError extends AdcpError {
  constructor(opts: CommonOpts = {}) {
    super('BUDGET_EXHAUSTED', {
      message: opts.message ?? 'Budget exhausted.',
      field: 'total_budget',
      ...(opts.suggestion !== undefined && { suggestion: opts.suggestion }),
      ...(opts.details !== undefined && { details: opts.details }),
    });
  }
}

// ---------------------------------------------------------------------------
// Idempotency family
// ---------------------------------------------------------------------------

export class IdempotencyConflictError extends AdcpError {
  constructor(opts: CommonOpts = {}) {
    super('IDEMPOTENCY_CONFLICT', {
      message: opts.message ?? 'Same idempotency_key with different payload.',
      field: 'idempotency_key',
      suggestion: opts.suggestion ?? 'Use a fresh idempotency_key for the new payload.',
      ...(opts.details !== undefined && { details: opts.details }),
    });
  }
}

// ---------------------------------------------------------------------------
// Validation / state family
// ---------------------------------------------------------------------------

export class InvalidRequestError extends AdcpError {
  constructor(field: string, message: string, opts: CommonOpts = {}) {
    super('INVALID_REQUEST', {
      message,
      field,
      ...(opts.suggestion !== undefined && { suggestion: opts.suggestion }),
      ...(opts.details !== undefined && { details: opts.details }),
    });
  }
}

export class InvalidStateError extends AdcpError {
  constructor(field: string, message: string, opts: CommonOpts = {}) {
    super('INVALID_STATE', {
      message,
      field,
      ...(opts.suggestion !== undefined && { suggestion: opts.suggestion }),
      ...(opts.details !== undefined && { details: opts.details }),
    });
  }
}

/**
 * Convenience for the common `start_time >= end_time` case. Use
 * `InvalidRequestError` for arbitrary field-level validation.
 */
export class BackwardsTimeRangeError extends AdcpError {
  constructor(opts: CommonOpts = {}) {
    super('INVALID_REQUEST', {
      message: opts.message ?? 'start_time must be before end_time.',
      field: 'start_time',
      suggestion: opts.suggestion ?? 'Verify the buyer-provided campaign window.',
      ...(opts.details !== undefined && { details: opts.details }),
    });
  }
}

// ---------------------------------------------------------------------------
// Auth / permission family
// ---------------------------------------------------------------------------

export class AuthRequiredError extends AdcpError {
  constructor(opts: CommonOpts = {}) {
    super('AUTH_REQUIRED', {
      message: opts.message ?? 'Authentication required.',
      ...(opts.suggestion !== undefined && { suggestion: opts.suggestion }),
      ...(opts.details !== undefined && { details: opts.details }),
    });
  }
}

export class PermissionDeniedError extends AdcpError {
  constructor(action: string, opts: CommonOpts = {}) {
    super('PERMISSION_DENIED', {
      message: opts.message ?? `Permission denied for ${action}.`,
      ...(opts.suggestion !== undefined && { suggestion: opts.suggestion }),
      details: { ...(opts.details ?? {}), action },
    });
  }
}

// ---------------------------------------------------------------------------
// Throttling / availability family
// ---------------------------------------------------------------------------

export class RateLimitedError extends AdcpError {
  constructor(retryAfterSeconds: number, opts: CommonOpts = {}) {
    super('RATE_LIMITED', {
      message: opts.message ?? `Rate limited. Retry after ${retryAfterSeconds}s.`,
      retry_after: Math.max(1, Math.min(3600, Math.floor(retryAfterSeconds))),
      ...(opts.suggestion !== undefined && { suggestion: opts.suggestion }),
      ...(opts.details !== undefined && { details: opts.details }),
    });
  }
}

export class ServiceUnavailableError extends AdcpError {
  constructor(opts: CommonOpts & { retryAfterSeconds?: number } = {}) {
    super('SERVICE_UNAVAILABLE', {
      message: opts.message ?? 'Service temporarily unavailable.',
      retry_after:
        opts.retryAfterSeconds != null ? Math.max(1, Math.min(3600, Math.floor(opts.retryAfterSeconds))) : 60,
      ...(opts.suggestion !== undefined && { suggestion: opts.suggestion }),
      ...(opts.details !== undefined && { details: opts.details }),
    });
  }
}

export class UnsupportedFeatureError extends AdcpError {
  constructor(feature: string, opts: CommonOpts = {}) {
    super('UNSUPPORTED_FEATURE', {
      message: opts.message ?? `Feature not supported: ${feature}.`,
      ...(opts.suggestion !== undefined && { suggestion: opts.suggestion }),
      details: { ...(opts.details ?? {}), feature },
    });
  }
}

// ---------------------------------------------------------------------------
// Compliance / governance family
// ---------------------------------------------------------------------------

export class ComplianceUnsatisfiedError extends AdcpError {
  constructor(reason: string, opts: CommonOpts = {}) {
    super('COMPLIANCE_UNSATISFIED', {
      message: opts.message ?? `Compliance not satisfied: ${reason}`,
      ...(opts.suggestion !== undefined && { suggestion: opts.suggestion }),
      details: { ...(opts.details ?? {}), reason },
    });
  }
}

export class GovernanceDeniedError extends AdcpError {
  constructor(reason: string, opts: CommonOpts = {}) {
    super('GOVERNANCE_DENIED', {
      message: opts.message ?? `Governance denied: ${reason}`,
      ...(opts.suggestion !== undefined && { suggestion: opts.suggestion }),
      details: { ...(opts.details ?? {}), reason },
    });
  }
}

export class PolicyViolationError extends AdcpError {
  constructor(policy: string, opts: CommonOpts = {}) {
    super('POLICY_VIOLATION', {
      message: opts.message ?? `Policy violation: ${policy}`,
      ...(opts.suggestion !== undefined && { suggestion: opts.suggestion }),
      details: { ...(opts.details ?? {}), policy },
    });
  }
}
