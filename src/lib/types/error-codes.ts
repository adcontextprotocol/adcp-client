/**
 * Standard AdCP error codes for programmatic handling.
 *
 * Sellers MAY use codes not in this vocabulary for platform-specific errors.
 * Agents MUST handle unknown codes by falling back to the recovery classification.
 *
 * The `StandardErrorCode` union composes two sources:
 *
 * 1. The manifest-driven set in `manifest.generated.ts` (auto-generated from
 *    `schemas/cache/{version}/manifest.json`, adcp#3738) — every code in the
 *    SDK's primary `ADCP_VERSION` pin.
 * 2. The forward-compat overlay in `forward-compat-error-codes.ts` — codes
 *    published in newer AdCP releases that the SDK pre-emptively understands
 *    so buyer agents can talk about them when forward-rolled sellers emit
 *    them on the wire. Each overlay entry carries `sinceAdcpVersion` for
 *    version attribution.
 *
 * Both sources flow into the same `STANDARD_ERROR_CODES` runtime table and
 * the same `StandardErrorCode` union. Adopters get one canonical surface;
 * version storytelling lives in JSDoc (`@since`) and the overlay entry's
 * `sinceAdcpVersion`. `error.code` remains wire-typed as open `string` per
 * the spec; this union is an SDK affordance for typed override keys and
 * exhaustive `Record<ErrorCode, …>` tables, not a wire-validity claim.
 *
 * See `forward-compat-error-codes.ts` for the overlay rationale and the
 * deletion contract (overlay entries are removed when the primary pin
 * advances to include them).
 */

import { ErrorCodeValues } from './enums.generated';
import {
  DEFAULT_UNKNOWN_RECOVERY,
  STANDARD_ERROR_CODES_FROM_MANIFEST,
  type ErrorRecovery as ManifestErrorRecovery,
  type StandardErrorCodeInfo as ManifestStandardErrorCodeInfo,
} from './manifest.generated';
import {
  FORWARD_COMPAT_ERROR_CODES,
  type ForwardCompatErrorCode,
  type ForwardCompatErrorCodeInfo,
} from './forward-compat-error-codes';

export type ErrorRecovery = ManifestErrorRecovery;

/**
 * Standard error codes defined by the AdCP specification (manifest-driven)
 * plus any codes the SDK pre-emptively recognizes ahead of its primary
 * `ADCP_VERSION` pin (forward-compat overlay).
 *
 * Use this for type-safe error handling in agent recovery logic — typed
 * override keys on `BuyerRetryPolicy`, exhaustive switch blocks, etc.
 */
export type StandardErrorCode = (typeof ErrorCodeValues)[number] | ForwardCompatErrorCode;

/**
 * Composed shape: manifest entries lack `sinceAdcpVersion`; overlay entries
 * carry it. Adopters reading `STANDARD_ERROR_CODES[code]` get back either
 * shape — both expose `description`, `recovery`, and optional `suggestion`.
 */
export type ErrorCodeInfo = ManifestStandardErrorCodeInfo | ForwardCompatErrorCodeInfo;

/**
 * Runtime lookup table for the standard AdCP error codes.
 * Each entry includes a description, the recommended recovery strategy, and
 * (where the spec provides one) a `suggestion` hint. Overlay entries
 * additionally carry `sinceAdcpVersion`.
 *
 * The `satisfies` assertion guarantees every value in `StandardErrorCode`
 * has a corresponding entry — adding a code to the spec without populating
 * it manifest-side (or adding it to the overlay) will fail typecheck here.
 */
export const STANDARD_ERROR_CODES = {
  ...STANDARD_ERROR_CODES_FROM_MANIFEST,
  ...FORWARD_COMPAT_ERROR_CODES,
} satisfies Record<StandardErrorCode, ErrorCodeInfo>;

/**
 * Default recovery to fall back on for non-standard / unknown error codes.
 * Sourced from `error_code_policy.default_unknown_recovery` in the manifest
 * (`transient` per the published spec — agents SHOULD retry with backoff).
 */
export const DEFAULT_UNKNOWN_ERROR_RECOVERY: ErrorRecovery = DEFAULT_UNKNOWN_RECOVERY;

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
