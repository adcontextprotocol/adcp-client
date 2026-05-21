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
 *
 * **Currently empty.** The 8.0-beta cut advanced the primary `ADCP_VERSION`
 * pin to `3.1.0-beta.2`, which folded the prior overlay entries
 * (`AUTH_MISSING`, `AUTH_INVALID`, `AGENT_SUSPENDED`, `AGENT_BLOCKED`) into
 * the manifest-driven surface. The compile-time disjointness check in
 * `error-codes.ts` fails closed if a code returns to this map after the
 * manifest already declares it.
 *
 * Future codes that 3.1.0-beta.N+1 publishes go here ahead of the next
 * pin advance — same pattern as #1883 originally introduced.
 */
export const FORWARD_COMPAT_ERROR_CODES = {} as const satisfies Record<string, ForwardCompatErrorCodeInfo>;

/**
 * Union of overlay codes. Composed with the manifest-derived enum to form
 * `StandardErrorCode` in `error-codes.ts`.
 */
export type ForwardCompatErrorCode = keyof typeof FORWARD_COMPAT_ERROR_CODES;
