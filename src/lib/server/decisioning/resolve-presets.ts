/**
 * `composeMethod` presets for `accounts.resolve`. Standardize the security
 * pattern multi-tenant adopters reach for: "the inner resolver found the
 * account, but is the calling principal authorized for it?"
 *
 * Hooks here run as `after` on a `composeMethod`-wrapped `accounts.resolve`.
 * When `inner` returns `null` they propagate `null` (no predicate runs);
 * otherwise they call the predicate, and on deny return `null` (default —
 * indistinguishable from "not found", guards against principal enumeration)
 * or throw {@link PermissionDeniedError} (typed wire error; use only when
 * the principal already knows the account exists).
 *
 * Closes adcp-client#1339.
 *
 * @public
 */

import type { AccountReference } from '../../types/tools.generated';
import type { Account, ResolveContext } from './account';
import type { ComposeHooks } from './compose';
import { PermissionDeniedError } from './errors-typed';

/**
 * Hook shape for `composeMethod` over `accounts.resolve`. Exported for
 * adopters writing their own helpers atop these presets.
 *
 * @public
 */
export type ResolveAccountHooks<TCtxMeta = Record<string, unknown>> = ComposeHooks<
  AccountReference | undefined,
  ResolveContext | undefined,
  Account<TCtxMeta> | null
>;

/**
 * Common options for resolve-time guards.
 *
 * @public
 */
export interface ResolveGuardOptions {
  /**
   * Behavior when the predicate denies.
   *  - `'null'` (default) — return `null`. Buyer sees `ACCOUNT_NOT_FOUND`,
   *    same as a genuinely-unknown account. Avoids principal enumeration.
   *  - `'throw'` — throw {@link PermissionDeniedError}. Surfaces a typed
   *    error to the buyer; use only when the principal is already known
   *    to be allowed to know the account exists.
   */
  onDeny?: 'null' | 'throw';

  /**
   * Action label attached to {@link PermissionDeniedError} when
   * `onDeny: 'throw'`. Defaults to `'accounts.resolve'`.
   */
  action?: string;
}

/**
 * General-purpose post-resolve guard. After the wrapped `accounts.resolve`
 * runs, calls `predicate(account, ctx)`; on `false` denies per `onDeny`.
 *
 * Building block for the specialized presets below; reach for it directly
 * when your authorization rule needs custom logic.
 *
 * @example
 * ```ts
 * import { composeMethod, requireAccountMatch } from '@adcp/sdk/server';
 *
 * accounts: {
 *   resolve: composeMethod(
 *     baseResolve,
 *     requireAccountMatch((account, ctx) =>
 *       account.account_scope === 'brand' && ctx?.agent?.id === account.brand?.id
 *     )
 *   ),
 * }
 * ```
 *
 * @public
 */
export function requireAccountMatch<TCtxMeta = Record<string, unknown>>(
  predicate: (account: Account<TCtxMeta>, ctx: ResolveContext | undefined) => boolean | Promise<boolean>,
  options: ResolveGuardOptions = {}
): ResolveAccountHooks<TCtxMeta> {
  const onDeny = options.onDeny ?? 'null';
  const action = options.action ?? 'accounts.resolve';
  return {
    after: async (result, _params, ctx) => {
      if (result === null) return null;
      const ok = await predicate(result, ctx);
      if (ok) return result;
      if (onDeny === 'throw') {
        throw new PermissionDeniedError(action);
      }
      return null;
    },
  };
}

/**
 * Gate resolved accounts on `account.advertiser` ∈ roster. Canonical
 * multi-tenant pattern: each calling principal is configured with a list
 * of advertisers it may transact for; the inner resolver finds the
 * account by reference, this preset rejects when the resolved
 * advertiser isn't in the roster.
 *
 * `getRoster` receives the `ResolveContext` and returns the principal's
 * allowed advertisers (any iterable of strings — array, Set, async lookup).
 * Accounts whose `advertiser` is undefined are denied.
 *
 * Equivalent to {@link requireAccountMatch} with an advertiser-extraction
 * predicate; sugar for the canonical shape.
 *
 * @example
 * ```ts
 * import { composeMethod, requireAdvertiserMatch } from '@adcp/sdk/server';
 *
 * accounts: {
 *   resolve: composeMethod(
 *     baseResolve,
 *     requireAdvertiserMatch(async (ctx) => tenantRoster.for(ctx?.agent))
 *   ),
 * }
 * ```
 *
 * @public
 */
export function requireAdvertiserMatch<TCtxMeta = Record<string, unknown>>(
  getRoster: (ctx: ResolveContext | undefined) => Iterable<string> | Promise<Iterable<string>>,
  options: ResolveGuardOptions = {}
): ResolveAccountHooks<TCtxMeta> {
  return requireAccountMatch<TCtxMeta>(async (account, ctx) => {
    const advertiser = account.advertiser;
    if (advertiser === undefined) return false;
    const roster = await getRoster(ctx);
    for (const allowed of roster) {
      if (allowed === advertiser) return true;
    }
    return false;
  }, options);
}

/**
 * Gate resolved accounts on org scope: account-side org extractor + ctx-side
 * org extractor + equality. Use when "is this principal in the same org as
 * this account?" is the authorization rule.
 *
 * Both extractors must return a defined string for the check to pass; either
 * returning `undefined` denies. Caller is responsible for whatever
 * normalization (case-folding, trim, alias resolution) is appropriate for
 * the org identifier shape — the preset compares with strict equality.
 *
 * @example
 * ```ts
 * import { composeMethod, requireOrgScope } from '@adcp/sdk/server';
 *
 * accounts: {
 *   resolve: composeMethod(
 *     baseResolve,
 *     requireOrgScope(
 *       (account) => account.ctx_metadata.orgId,
 *       (ctx) => ctx?.authInfo?.extra?.orgId as string | undefined
 *     )
 *   ),
 * }
 * ```
 *
 * @public
 */
export function requireOrgScope<TCtxMeta = Record<string, unknown>>(
  getAccountOrg: (account: Account<TCtxMeta>) => string | undefined,
  getCtxOrg: (ctx: ResolveContext | undefined) => string | undefined,
  options: ResolveGuardOptions = {}
): ResolveAccountHooks<TCtxMeta> {
  return requireAccountMatch<TCtxMeta>((account, ctx) => {
    const accountOrg = getAccountOrg(account);
    if (accountOrg === undefined) return false;
    const ctxOrg = getCtxOrg(ctx);
    if (ctxOrg === undefined) return false;
    return accountOrg === ctxOrg;
  }, options);
}
