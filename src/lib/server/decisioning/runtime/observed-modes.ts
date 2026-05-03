/**
 * Process-scoped tracker of explicit `Account.mode` values returned from
 * `platform.accounts.resolve` during framework-side comply-controller
 * dispatch. Used by the sandbox gate's deprecated env-fallback path
 * (`ADCP_SANDBOX === '1'`) to fail closed when a process has resolved
 * any live-mode account.
 *
 * Rationale: the env-fallback exists for back-compat with adopters that
 * have not yet adopted the per-account `mode` field. If those adopters
 * have ALSO begun returning explicit `mode: 'live'` from their resolver,
 * the env var is a misconfiguration — leaving it set would re-open the
 * gate for live principals after the resolver was meant to close it.
 *
 * Implicit-default `live` (resolver returns no mode field) is NOT
 * observed here — those adopters are exactly who the env-fallback bridge
 * exists for. Only the own-property `mode === 'live'` shape, set
 * deliberately by the resolver, trips the guard.
 *
 * @internal
 */

const observed = new Set<string>();

/**
 * Record an account returned from `platform.accounts.resolve`. Reads
 * via `Object.hasOwn` so the same prototype-pollution defense as
 * `getAccountMode` applies — an attacker who reaches a `__proto__`-via-
 * merge sink can't stamp `Object.prototype.mode = 'sandbox'` to evade
 * the live observation.
 *
 * No-op when `account` is null / not an object / lacks an own `mode`
 * property / `mode` is not a known string. The set only collects
 * explicit, deliberate mode values.
 */
export function recordResolvedAccountMode(account: unknown): void {
  if (account == null || typeof account !== 'object') return;
  if (!Object.hasOwn(account, 'mode')) return;
  const mode = (account as { mode?: unknown }).mode;
  if (mode === 'live' || mode === 'sandbox' || mode === 'mock') {
    observed.add(mode);
  }
}

/**
 * `true` when this process has observed at least one explicit
 * `mode: 'live'` account from `platform.accounts.resolve`. The
 * sandbox-gate env-fallback consults this to decide whether
 * `ADCP_SANDBOX=1` is a safe legacy bridge or a misconfiguration.
 */
export function hasObservedLiveMode(): boolean {
  return observed.has('live');
}

/**
 * Test seam — reset the observed-modes set between describe blocks
 * so a test that intentionally resolves a live account doesn't leak
 * the observation into subsequent tests in the same process.
 *
 * Refuses to clear when `NODE_ENV` is anything other than `test` or
 * `development`. The observed-modes set is intentionally process-scoped
 * — clearing it in production would re-arm the env-fallback admit path
 * for live principals already seen, defeating the whole point of the
 * fail-closed guard. The allowlist (rather than `!= 'production'`)
 * matches the project's broader `feedback_node_env_allowlist.md` policy.
 *
 * Not part of the public API. Adopter code MUST NOT call this.
 *
 * @internal
 */
export function __resetObservedAccountModes(): void {
  const env = process.env.NODE_ENV;
  if (env !== 'test' && env !== 'development') {
    throw new Error(
      `__resetObservedAccountModes is a test seam; refusing to clear observed account modes ` +
        `in NODE_ENV=${env ?? '<unset>'}. The set is process-scoped to keep the comply ` +
        `controller's env-fallback fail-closed guard armed once a live account has been seen.`
    );
  }
  observed.clear();
}
