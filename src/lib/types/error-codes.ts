/**
 * Standard AdCP error codes for programmatic handling.
 *
 * Sellers MAY use codes not in this vocabulary for platform-specific errors.
 * Agents MUST handle unknown codes by falling back to the recovery classification.
 *
 * The `StandardErrorCode` union is derived from `ErrorCodeValues` in
 * `enums.generated.ts` (auto-generated from `schemas/cache/{version}/enums/error-code.json`).
 * The runtime lookup table `STANDARD_ERROR_CODES` is sourced from
 * `manifest.generated.ts` (auto-generated from `schemas/cache/{version}/manifest.json`,
 * adcp#3738) — adding a code to the spec without filling in a description and
 * recovery upstream will fail the `satisfies Record<StandardErrorCode, ErrorCodeInfo>`
 * assertion below.
 *
 * Adopting `manifest.json` collapses the previous hand-curated table into a
 * generated one. See adcp-client#1192 for context.
 */

import { ErrorCodeValues } from './enums.generated';
import {
  DEFAULT_UNKNOWN_RECOVERY,
  STANDARD_ERROR_CODES_FROM_MANIFEST,
  type ErrorRecovery as ManifestErrorRecovery,
  type StandardErrorCodeInfo as ManifestStandardErrorCodeInfo,
} from './manifest.generated';

export type ErrorRecovery = ManifestErrorRecovery;

/**
 * Standard error codes defined in the AdCP specification.
 * Use these for type-safe error handling in agent recovery logic.
 */
export type StandardErrorCode = (typeof ErrorCodeValues)[number];

export type ErrorCodeInfo = ManifestStandardErrorCodeInfo;

/**
 * Runtime lookup table for the standard AdCP error codes.
 * Each entry includes a description, the recommended recovery strategy, and
 * (where the spec provides one) a `suggestion` hint.
 *
 * Sourced from the manifest's `error_codes` block. The `satisfies Record<…>`
 * assertion guarantees every value in `ErrorCodeValues` has a corresponding
 * entry — adding a code to the spec without populating it manifest-side will
 * fail typecheck here.
 */
export const STANDARD_ERROR_CODES = STANDARD_ERROR_CODES_FROM_MANIFEST satisfies Record<
  StandardErrorCode,
  ErrorCodeInfo
>;

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
