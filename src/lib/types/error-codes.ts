/**
 * Standard AdCP error codes for programmatic handling.
 *
 * Sellers MAY use codes not in this vocabulary for platform-specific errors.
 * Agents MUST handle unknown codes by falling back to the recovery classification.
 *
 * The `StandardErrorCode` union is derived from `ErrorCodeValues` in
 * `enums.generated.ts` (auto-generated from `schemas/cache/{version}/enums/error-code.json`).
 * The runtime lookup table `STANDARD_ERROR_CODES` is asserted complete via
 * `satisfies Record<StandardErrorCode, ErrorCodeInfo>` — adding a code to the
 * spec without filling in a description and recovery will fail typecheck.
 */

import { ErrorCodeValues } from './enums.generated';

export type ErrorRecovery = 'transient' | 'correctable' | 'terminal';

/**
 * Standard error codes defined in the AdCP specification.
 * Use these for type-safe error handling in agent recovery logic.
 */
export type StandardErrorCode = (typeof ErrorCodeValues)[number];

interface ErrorCodeInfo {
  description: string;
  recovery: ErrorRecovery;
}

/**
 * Runtime lookup table for the standard AdCP error codes.
 * Each entry includes a description and the recommended recovery strategy.
 *
 * Recovery classifications mirror the spec's `enumDescriptions` block in
 * `error-code.json`. Descriptions are condensed to the first-sentence summary;
 * agents needing the full prescriptive text should consult the schema directly.
 */
export const STANDARD_ERROR_CODES = {
  INVALID_REQUEST: {
    description: 'Request is malformed, missing required fields, or violates schema constraints',
    recovery: 'correctable',
  },
  AUTH_REQUIRED: {
    description: 'Authentication is required to access this resource',
    recovery: 'correctable',
  },
  RATE_LIMITED: {
    description: 'Request rate exceeded; retry after the retry_after interval',
    recovery: 'transient',
  },
  SERVICE_UNAVAILABLE: {
    description: 'Seller service is temporarily unavailable',
    recovery: 'transient',
  },
  POLICY_VIOLATION: {
    description: "Request violates the seller's content or advertising policies",
    recovery: 'correctable',
  },
  PRODUCT_NOT_FOUND: {
    description: 'One or more referenced product IDs are unknown or expired',
    recovery: 'correctable',
  },
  PRODUCT_UNAVAILABLE: {
    description: 'The requested product is sold out or no longer available',
    recovery: 'correctable',
  },
  PROPOSAL_EXPIRED: {
    description: 'A referenced proposal ID has passed its expires_at timestamp',
    recovery: 'correctable',
  },
  BUDGET_TOO_LOW: {
    description: "Budget is below the seller's minimum",
    recovery: 'correctable',
  },
  CREATIVE_REJECTED: {
    description: 'Creative failed content policy review',
    recovery: 'correctable',
  },
  UNSUPPORTED_FEATURE: {
    description: 'A requested feature or field is not supported by this seller',
    recovery: 'correctable',
  },
  AUDIENCE_TOO_SMALL: {
    description: 'Audience segment is below the minimum required size for targeting',
    recovery: 'correctable',
  },
  ACCOUNT_NOT_FOUND: {
    description: 'The account reference could not be resolved',
    recovery: 'terminal',
  },
  ACCOUNT_SETUP_REQUIRED: {
    description: 'Natural key resolved but the account needs setup before use',
    recovery: 'correctable',
  },
  ACCOUNT_AMBIGUOUS: {
    description: 'Natural key resolves to multiple accounts',
    recovery: 'correctable',
  },
  ACCOUNT_PAYMENT_REQUIRED: {
    description: 'Account has an outstanding balance requiring payment before new buys',
    recovery: 'terminal',
  },
  ACCOUNT_SUSPENDED: {
    description: 'Account has been suspended',
    recovery: 'terminal',
  },
  COMPLIANCE_UNSATISFIED: {
    description: "A required disclosure from the brief's compliance section cannot be satisfied by the target format",
    recovery: 'correctable',
  },
  GOVERNANCE_DENIED: {
    description: 'A registered governance agent denied the transaction',
    recovery: 'correctable',
  },
  BUDGET_EXHAUSTED: {
    description: 'Account or campaign budget has been fully spent',
    recovery: 'terminal',
  },
  BUDGET_EXCEEDED: {
    description: 'Operation would exceed the allocated budget for the media buy or package',
    recovery: 'correctable',
  },
  CONFLICT: {
    description: 'Concurrent modification detected; the resource was modified between read and write',
    recovery: 'transient',
  },
  IDEMPOTENCY_CONFLICT: {
    description:
      'An earlier request with the same idempotency_key was processed with a different canonical payload. Use a fresh UUID v4 for the new request, or resend the exact original payload to get the cached response.',
    recovery: 'correctable',
  },
  IDEMPOTENCY_EXPIRED: {
    description:
      "The idempotency_key is past the seller's replay window. If the prior call succeeded, look up the resource by natural key before retrying; otherwise mint a fresh UUID v4.",
    recovery: 'correctable',
  },
  CREATIVE_DEADLINE_EXCEEDED: {
    description: "Creative change submitted after the package's creative_deadline",
    recovery: 'correctable',
  },
  INVALID_STATE: {
    description: "Operation is not permitted for the resource's current status",
    recovery: 'correctable',
  },
  MEDIA_BUY_NOT_FOUND: {
    description: 'Referenced media buy does not exist or is not accessible',
    recovery: 'correctable',
  },
  NOT_CANCELLABLE: {
    description: 'The media buy or package cannot be canceled in its current state',
    recovery: 'correctable',
  },
  PACKAGE_NOT_FOUND: {
    description: 'Referenced package does not exist within the specified media buy',
    recovery: 'correctable',
  },
  CREATIVE_NOT_FOUND: {
    description: "Referenced creative does not exist in the agent's creative library",
    recovery: 'correctable',
  },
  SIGNAL_NOT_FOUND: {
    description: "Referenced signal does not exist in the agent's catalog",
    recovery: 'correctable',
  },
  SESSION_NOT_FOUND: {
    description: 'SI session ID is invalid, expired, or does not exist',
    recovery: 'correctable',
  },
  PLAN_NOT_FOUND: {
    description: 'Referenced governance plan does not exist or is not accessible',
    recovery: 'correctable',
  },
  REFERENCE_NOT_FOUND: {
    description:
      'Generic fallback for a referenced identifier, grant, session, or other resource that does not exist or is not accessible by the caller',
    recovery: 'correctable',
  },
  SESSION_TERMINATED: {
    description: 'SI session has already been terminated and cannot accept further messages',
    recovery: 'correctable',
  },
  VALIDATION_ERROR: {
    description: 'Request contains invalid field values or violates business rules beyond schema validation',
    recovery: 'correctable',
  },
  PRODUCT_EXPIRED: {
    description: 'One or more referenced products have passed their expires_at timestamp',
    recovery: 'correctable',
  },
  PROPOSAL_NOT_COMMITTED: {
    description: "The referenced proposal has proposal_status 'draft' and cannot be used to create a media buy",
    recovery: 'correctable',
  },
  IO_REQUIRED: {
    description: 'The committed proposal requires a signed insertion order but no io_acceptance was provided',
    recovery: 'correctable',
  },
  TERMS_REJECTED: {
    description: 'Buyer-proposed measurement_terms were rejected by the seller',
    recovery: 'correctable',
  },
  REQUOTE_REQUIRED: {
    description:
      'An update_media_buy request changes the parameter envelope (budget, flight dates, volume, targeting) the original quote was priced against',
    recovery: 'correctable',
  },
  VERSION_UNSUPPORTED: {
    description: 'The declared adcp_major_version is not supported by this seller',
    recovery: 'correctable',
  },
  CAMPAIGN_SUSPENDED: {
    description: 'Campaign governance has been suspended pending human review',
    recovery: 'transient',
  },
  GOVERNANCE_UNAVAILABLE: {
    description: 'A registered governance agent is unreachable and the seller cannot obtain a governance decision',
    recovery: 'transient',
  },
  PERMISSION_DENIED: {
    description:
      "The authenticated caller is not authorized for the requested action under the seller's policies, or a required signed credential is missing or invalid",
    recovery: 'correctable',
  },
} as const satisfies Record<StandardErrorCode, ErrorCodeInfo>;

/**
 * Check whether an error code is one of the standard AdCP codes.
 */
export function isStandardErrorCode(code: string): code is StandardErrorCode {
  return code in STANDARD_ERROR_CODES;
}

/**
 * Get the recommended recovery strategy for an error code.
 * Returns the standard recovery for known codes, or undefined for custom codes.
 */
export function getErrorRecovery(code: string): ErrorRecovery | undefined {
  if (isStandardErrorCode(code)) {
    return STANDARD_ERROR_CODES[code].recovery;
  }
  return undefined;
}
