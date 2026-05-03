/**
 * Account-mode primitives for sandbox-authority enforcement of
 * `comply_test_controller` and other test-only surfaces.
 *
 * The hard rule: under no circumstances should the comply test
 * controller (or any test-only surface) operate on a `live`-mode
 * account. The flag must live on the resolved account, not on a
 * process-level env var — env vars are operator-error-prone proxies
 * for what is fundamentally an authority decision per principal.
 *
 * This module ships the type + helpers; auto-wiring into
 * `createAdcpServerFromPlatform`'s `complyTest` path lands in a
 * follow-up alongside mock-mode routing (#1435 Phase 2).
 *
 * @public
 */

import { AdcpError } from './decisioning/async-outcome';

/**
 * Three operationally distinct account modes:
 *
 *   - `live`: production traffic. Adopter's upstream is truth. Test-only
 *     surfaces (comply controller, force_*, simulate_*) are denied.
 *   - `sandbox`: adopter's own test account. Their code path runs against
 *     their test infrastructure. Test-only surfaces are allowed.
 *   - `mock`: SDK-routed-to-mock-server. Adopter's code is bypassed; the
 *     SDK forwards to the mock upstream backend. Test-only surfaces are
 *     allowed.
 *
 * Default when unspecified: `live`. A missing or unknown `mode` reads
 * as production, fail-closed for any test-only dispatch.
 *
 * See `docs/proposals/lifecycle-state-and-sandbox-authority.md` for the
 * full three-mode design and Phase 1/2/3 rollout.
 */
export type AccountMode = 'live' | 'sandbox' | 'mock';

/**
 * Reads `mode` off any account-shaped value, with back-compat for
 * the legacy `sandbox: boolean` field. Returns the explicit mode if
 * present; otherwise infers `'sandbox'` from `sandbox === true`;
 * otherwise `'live'`.
 *
 * Adopters that have not yet migrated to the `mode` field continue to
 * work — `account.sandbox === true` reads as sandbox mode through this
 * helper. New code should prefer `mode` directly.
 *
 * Prototype-pollution defense: both `mode` and `sandbox` are read via
 * `Object.hasOwn` rather than bare property access. Bare access traverses
 * the prototype chain, so an attacker who reaches a `__proto__`-via-merge
 * sink upstream (reachable in MCP envelope handling and similar deep-merge
 * sites) could stamp `Object.prototype.mode = 'sandbox'` and silently
 * downgrade every account's gate to a no-op. The own-property check makes
 * the gate immune to that class of attack regardless of upstream hardening.
 */
export function getAccountMode(account: unknown): AccountMode {
  if (account == null || typeof account !== 'object') return 'live';
  if (Object.hasOwn(account, 'mode')) {
    const mode = (account as { mode?: unknown }).mode;
    if (mode === 'live' || mode === 'sandbox' || mode === 'mock') return mode;
  }
  // Back-compat: legacy `sandbox: true` flag reads as `sandbox` mode.
  if (Object.hasOwn(account, 'sandbox') && (account as { sandbox?: unknown }).sandbox === true) {
    return 'sandbox';
  }
  return 'live';
}

/**
 * Predicate: is the account in a non-production mode that admits
 * test-only surfaces (comply controller, force_*, simulate_*)?
 *
 * Returns `true` for `mode === 'sandbox' | 'mock'` (or legacy
 * `sandbox: true`); `false` for `mode === 'live'` or any account
 * shape that doesn't carry the field.
 */
export function isSandboxOrMockAccount(account: unknown): boolean {
  const mode = getAccountMode(account);
  return mode === 'sandbox' || mode === 'mock';
}

/**
 * Throws an `AdcpError('PERMISSION_DENIED')` if the account is not in
 * a non-production mode. Use to gate dispatch of test-only surfaces.
 *
 * Fail-closed semantics:
 *   - `account === undefined` (no resolved account): throws.
 *   - `account.mode === 'live'` or unspecified + no `sandbox: true`:
 *     throws.
 *   - `account.mode === 'sandbox' | 'mock'` (or legacy `sandbox: true`):
 *     no-op, dispatch proceeds.
 *
 * The `details` payload carries `{ scope: 'sandbox-gate', tool? }` so
 * dashboards can distinguish gate-rejections from other permission
 * denials.
 *
 * **Resolver discipline.** The strength of this gate depends entirely on
 * how the adopter's `AccountStore.resolve` constructs its return value.
 * Resolvers MUST NOT spread untrusted input (request body, headers,
 * `ctx_metadata`, query params) into the resolved account — doing so lets
 * a buyer self-promote to `mode: 'sandbox'` and unlock test-only surfaces
 * on a live principal. Source `mode` (and `sandbox`) from a trusted store
 * keyed by the authenticated principal; never from request data.
 *
 * **opts.message must be a static string literal.** The message is echoed
 * on the wire inside the error envelope. Interpolating user-controlled
 * values into it creates a reflection sink (PII leakage, log injection,
 * downstream HTML rendering). Pick from a fixed set of messages keyed by
 * `tool` if you need variants.
 *
 * @param account The resolved account (typically `ctx.account` inside
 *   a tool dispatch). Pass `undefined` if no account resolved — the
 *   helper fails closed.
 * @param opts.tool Optional tool name to surface in the error details
 *   (e.g., `'comply_test_controller'`).
 * @param opts.message Optional override for the user-facing message.
 *   MUST be a static string literal — see "opts.message" note above.
 *
 * @example
 *   import { assertSandboxAccount } from '@adcp/sdk/server';
 *
 *   sandboxGate: input => {
 *     const account = await resolveAccount(input);
 *     assertSandboxAccount(account, { tool: 'comply_test_controller' });
 *     return true;
 *   }
 */
export function assertSandboxAccount(account: unknown, opts: { tool?: string; message?: string } = {}): void {
  if (isSandboxOrMockAccount(account)) return;
  throw new AdcpError('PERMISSION_DENIED', {
    message: opts.message ?? 'Test-only surface requires a sandbox or mock account; resolved account is in live mode.',
    details: {
      scope: 'sandbox-gate',
      reason: 'sandbox-or-mock-required',
      ...(opts.tool && { tool: opts.tool }),
    },
  });
}
