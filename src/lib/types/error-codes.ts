/**
 * Standard AdCP error codes for programmatic handling.
 *
 * Sellers MAY use codes not in this vocabulary for platform-specific errors.
 * Agents MUST handle unknown codes by falling back to the recovery classification.
 */

export type ErrorRecovery = 'transient' | 'correctable' | 'terminal';

/**
 * The 26 standard error codes defined in the AdCP specification.
 * Use these for type-safe error handling in agent recovery logic.
 */
export type StandardErrorCode =
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
  | 'BUDGET_EXHAUSTED'
  | 'BUDGET_EXCEEDED'
  | 'CONFLICT'
  | 'INVALID_STATE'
  | 'MEDIA_BUY_NOT_FOUND'
  | 'NOT_CANCELLABLE'
  | 'PACKAGE_NOT_FOUND'
  | 'VALIDATION_ERROR';

interface ErrorCodeInfo {
  description: string;
  recovery: ErrorRecovery;
}

/**
 * Runtime lookup table for the 26 standard AdCP error codes.
 * Each entry includes a description and the recommended recovery strategy.
 */
export const STANDARD_ERROR_CODES: Record<StandardErrorCode, ErrorCodeInfo> = {
  INVALID_REQUEST: {
    description: 'The request is malformed or contains invalid parameters',
    recovery: 'correctable',
  },
  AUTH_REQUIRED: {
    description: 'Authentication is required or the provided credentials are invalid',
    recovery: 'correctable',
  },
  RATE_LIMITED: {
    description: 'Too many requests; retry after the specified delay',
    recovery: 'transient',
  },
  SERVICE_UNAVAILABLE: {
    description: 'The service is temporarily unavailable',
    recovery: 'transient',
  },
  POLICY_VIOLATION: {
    description: 'The request violates a platform or advertiser policy',
    recovery: 'correctable',
  },
  PRODUCT_NOT_FOUND: {
    description: 'The requested product does not exist',
    recovery: 'correctable',
  },
  PRODUCT_UNAVAILABLE: {
    description: 'The product exists but is not currently available',
    recovery: 'transient',
  },
  PROPOSAL_EXPIRED: {
    description: 'The proposal has expired and is no longer valid',
    recovery: 'correctable',
  },
  BUDGET_TOO_LOW: {
    description: 'The specified budget is below the minimum threshold',
    recovery: 'correctable',
  },
  CREATIVE_REJECTED: {
    description: 'One or more creatives failed review or validation',
    recovery: 'correctable',
  },
  UNSUPPORTED_FEATURE: {
    description: 'The requested feature is not supported by this seller',
    recovery: 'terminal',
  },
  AUDIENCE_TOO_SMALL: {
    description: 'The target audience is too small to deliver against',
    recovery: 'correctable',
  },
  ACCOUNT_NOT_FOUND: {
    description: 'The specified account does not exist',
    recovery: 'terminal',
  },
  ACCOUNT_SETUP_REQUIRED: {
    description: 'The account requires additional setup before use',
    recovery: 'terminal',
  },
  ACCOUNT_AMBIGUOUS: {
    description: 'Multiple accounts match; provide a more specific identifier',
    recovery: 'correctable',
  },
  ACCOUNT_PAYMENT_REQUIRED: {
    description: 'The account has an outstanding payment issue',
    recovery: 'terminal',
  },
  ACCOUNT_SUSPENDED: {
    description: 'The account has been suspended',
    recovery: 'terminal',
  },
  COMPLIANCE_UNSATISFIED: {
    description: 'Compliance requirements have not been met',
    recovery: 'correctable',
  },
  BUDGET_EXHAUSTED: {
    description: 'The budget has been fully spent',
    recovery: 'terminal',
  },
  BUDGET_EXCEEDED: {
    description: 'Operation would exceed the allocated budget for the media buy or package',
    recovery: 'correctable',
  },
  CONFLICT: {
    description: 'The request conflicts with the current state of the resource',
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
  VALIDATION_ERROR: {
    description: 'Request contains invalid field values or violates business rules beyond schema validation',
    recovery: 'correctable',
  },
} as const;

/**
 * Check whether an error code is one of the 26 standard AdCP codes.
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
