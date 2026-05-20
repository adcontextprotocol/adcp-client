/**
 * Forward-compatibility overlay for AdCP error codes the SDK pre-emptively
 * recognizes ahead of its primary `ADCP_VERSION` pin.
 *
 * Rationale.
 * - `error.code` is wire-typed `string` (open enum) per the AdCP spec — the
 *   canonical `enums/error-code.json` is documentary, and receivers MUST
 *   handle unknown codes via the `recovery` fallback.
 * - The SDK's `StandardErrorCode` union is an _affordance_ for adopters:
 *   autocomplete in `switch` blocks, typed override keys on
 *   `BuyerRetryPolicy`, exhaustive `Record<ErrorCode, …>` tables. It is NOT
 *   a wire-validity claim.
 * - In a dual-mode line (primary pin at 3.0.x GA while 3.1 ships as opt-in
 *   types under `src/lib/types/v3-1-beta/`), buyer agents will receive
 *   3.1-introduced codes from forward-rolled sellers _before_ the SDK's GA
 *   pin moves. The overlay names those codes so the SDK has a defined
 *   retry policy and a typed-error class for each, regardless of which
 *   wire version the peer speaks.
 *
 * Each entry carries `sinceAdcpVersion` so hover-docs and migration tooling
 * can tell the version story without forking the type surface.
 *
 * When the SDK's primary `ADCP_VERSION` advances to a release that includes
 * a code in this overlay, the manifest-driven table picks it up
 * automatically and the entry below becomes redundant — delete the entry in
 * the same PR that bumps the pin, then re-run `npm run generate-manifest-derived`.
 * The drift-guard test (`test/lib/standard-error-codes-drift.test.js`) will
 * fail if both surfaces define the same code with divergent metadata.
 *
 * @public
 */

import type { ErrorRecovery, StandardErrorCodeInfo } from './manifest.generated';

/**
 * Overlay entry shape — extends the manifest entry with `sinceAdcpVersion`
 * so adopters and tooling can attribute the code to its introducing release.
 */
export interface ForwardCompatErrorCodeInfo extends StandardErrorCodeInfo {
  /** AdCP release-precision version where this code first appeared. */
  sinceAdcpVersion: string;
}

/**
 * Codes published in AdCP releases newer than the SDK's primary `ADCP_VERSION`
 * pin. Composed into `STANDARD_ERROR_CODES` and `StandardErrorCode` at the
 * consumer site so the rest of the SDK treats them as first-class.
 */
export const FORWARD_COMPAT_ERROR_CODES = {
  /**
   * Introduced by adcp#3730 (AdCP 3.1). Replaces the missing-credentials
   * branch of `AUTH_REQUIRED`. Recovery is `correctable` — the agent
   * provides credentials and retries.
   */
  AUTH_MISSING: {
    description:
      'No credentials were presented. Sellers MUST return this code when no `Authorization` header was included in the request. Recovery: correctable (provide credentials via the auth header and retry).',
    recovery: 'correctable' as ErrorRecovery,
    suggestion: 'provide credentials via the auth header and retry',
    sinceAdcpVersion: '3.1.0',
  },
  /**
   * Introduced by adcp#3730 (AdCP 3.1). Replaces the rejected-credentials
   * branch of `AUTH_REQUIRED`. Recovery is `terminal` — credentials were
   * revoked, expired, or carry an invalid signature. Auto-retry creates a
   * retry-storm against the seller's SSO endpoint indistinguishable from
   * brute-force probing. OAuth 2.1 refresh-token rotation is a permitted
   * one-shot exception (see spec note); otherwise escalate to a human.
   */
  AUTH_INVALID: {
    description:
      "Credentials were presented but rejected — revoked, malformed signature, or a key no longer in the seller's keystore. Sellers MUST return this code when an `Authorization` header was present but verification failed. Recovery: terminal. Exception: agents with a valid OAuth 2.1 refresh grant MAY treat this as correctable when the rejection reason is token expiry — silently refresh and retry once; if the refresh fails or the seller explicitly signals revocation, escalate to human.",
    recovery: 'terminal' as ErrorRecovery,
    suggestion:
      'do NOT auto-retry — credentials were rejected; rotate keys, refresh OAuth tokens once if applicable, otherwise escalate to a human',
    sinceAdcpVersion: '3.1.0',
  },
} as const satisfies Record<string, ForwardCompatErrorCodeInfo>;

/**
 * Union of overlay codes. Composed with the manifest-derived enum to form
 * `StandardErrorCode` in `error-codes.ts`.
 */
export type ForwardCompatErrorCode = keyof typeof FORWARD_COMPAT_ERROR_CODES;
