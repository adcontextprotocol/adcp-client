/**
 * Derived `AccountStore` factory for `resolution: 'derived'` agents — there is
 * no `account_id` on the wire and the auth principal alone routes each request.
 * Covers self-hosted broadcasters, retail-media operators in proxy mode, and
 * creative-only adapters (audiostack, flashtalking) where every API call is
 * scoped by the buyer's per-request credential.
 *
 * Pairs with the existing reference adapters. Pick by asking *who creates the
 * account?*:
 * - **Buyer self-onboards via `sync_accounts`** → {@link InMemoryImplicitAccountStore}
 *   (Shape A, `resolution: 'implicit'`).
 * - **Upstream OAuth API owns the roster** → {@link createOAuthPassthroughResolver}
 *   (Shape B, `resolution: 'explicit'`).
 * - **Publisher ops curates the roster** → {@link createRosterAccountStore}
 *   (Shape C, `resolution: 'explicit'`).
 * - **No account concept — auth principal IS the tenant** → `createDerivedAccountStore`
 *   (this file, Shape D, `resolution: 'derived'`).
 *
 * Closes adcp-client#1462. Replaces the ~25–30 LOC of `if (!authInfo.token) throw
 * AUTH_REQUIRED; return { id: ..., ctx_metadata: { accessToken } }` boilerplate
 * Shape D adopters write today.
 *
 * @see docs/guides/account-resolution.md
 * @public
 */

import type { AccountReference } from '../types/tools.generated';
import type { Account, AccountFilter, AccountStore, ResolveContext } from '../server/decisioning/account';
import type { CursorPage, CursorRequest } from '../server/decisioning/pagination';
import { AdcpError } from '../server/decisioning/async-outcome';

/**
 * Options for {@link createDerivedAccountStore}.
 *
 * @public
 */
export interface DerivedAccountStoreOptions<TCtxMeta = Record<string, unknown>> {
  /**
   * Build the singleton account from the request context. Called on every
   * `resolve()` (no caching — the tenant is per-request because the auth
   * principal varies). The returned account's `id` is typically a stable
   * literal (e.g. `'audiostack'`, `'__publisher_wide__'`); single-tenant
   * adapters have no buyer-supplied account_id to reflect back.
   *
   * **DO NOT put credentials in `ctx_metadata`.** See
   * `docs/guides/CTX-METADATA-SAFETY.md` for the rationale. The wire-strip
   * protects buyer responses but does NOT protect server-side log lines,
   * error envelopes, or adopter-generated strings (e.g. `JSON.stringify(account)`
   * in an error message). Re-derive the bearer from `ctx.authInfo` per
   * request inside specialism methods instead.
   *
   * Adopters MAY omit `authInfo` from the returned `Account` — the framework
   * auto-attaches the principal from `ctx.authInfo` when absent (matches
   * Shape A/B/C semantics).
   */
  toAccount: (ctx: ResolveContext | undefined) => Account<TCtxMeta>;

  /**
   * Skip the `AUTH_REQUIRED` precheck. Defaults to `false` — the factory
   * throws `AdcpError('AUTH_REQUIRED')` when `ctx.authInfo` is absent or
   * carries no credential, matching the canonical Shape D pattern (every
   * call must authenticate).
   *
   * Set to `true` for genuinely unauthenticated single-tenant agents (rare —
   * public format catalogs, signed-request-only agents that authenticate
   * out-of-band). When `true`, `toAccount` runs unconditionally.
   *
   * If you're tempted to set this because tests don't carry `authInfo`,
   * fix the tests instead — `serve({ authenticate })` should populate
   * `ctx.authInfo` from your test harness (or use `dispatchTestRequest`
   * which threads a synthetic principal). The escape hatch is for
   * production agents that legitimately accept unauthenticated traffic,
   * not for working around fixture gaps.
   *
   * @default false
   */
  skipAuthCheck?: boolean;

  /**
   * Optional `list_accounts` implementation. When provided, the factory
   * includes it on the returned `AccountStore`; the framework auto-wires
   * `list_accounts` via the existing `if (accounts.list)` gate.
   *
   * **Use case — spec compliance for derived-mode sellers.** AdCP requires
   * every seller to expose at least one of `list_accounts` / `sync_accounts`.
   * `'derived'` agents that claim neither fail conformance under the
   * storyboard runner (see adcp-client#1624). Providing this callback
   * satisfies that requirement without changing the resolution mode.
   *
   * **Semantics — discovery, not addressing.** `'derived'` mode still refuses
   * inline `account_id` references on subsequent requests (the framework
   * emits `INVALID_REQUEST` before reaching `accounts.resolve`). The
   * `account_id` values returned by this callback are informational — buyers
   * use them to discover what accounts are accessible to their auth
   * principal, but all per-request routing continues to flow through
   * `toAccount(ctx)` via the auth credential alone. Do NOT expose this
   * option if buyers are expected to pass the listed `account_id`s back on
   * mutating calls — use `resolution: 'explicit'` or `createTenantStore`
   * for that pattern.
   *
   * **Auth gate.** `skipAuthCheck` guards `resolve` only. Auth checking for
   * `list` is the adopter's responsibility — check `ctx.authInfo` inside
   * the callback and throw `AdcpError('AUTH_REQUIRED', ...)` when the
   * principal is absent, if your platform requires authentication to
   * enumerate accounts.
   *
   * @example Auth-scoped upstream roster:
   * ```ts
   * const accounts = createDerivedAccountStore({
   *   toAccount: ctx => deriveAccount(ctx),
   *   list: async (filter, ctx) => {
   *     const cred = ctx?.authInfo?.credential;
   *     if (!cred) throw new AdcpError('AUTH_REQUIRED', { recovery: 'correctable' });
   *     const page = await upstreamPlatform.listAccounts(cred, filter);
   *     return { items: page.rows.map(toAccount), nextCursor: page.cursor };
   *   },
   * });
   * ```
   */
  list?: (filter: AccountFilter & CursorRequest, ctx?: ResolveContext) => Promise<CursorPage<Account<TCtxMeta>>>;
}

/**
 * Build an `AccountStore<TCtxMeta>` for single-tenant agents whose tenant is
 * derived from the auth principal alone (no `account_id` on the wire).
 *
 * The factory:
 * 1. Sets `resolution: 'derived'`.
 * 2. Throws `AdcpError('AUTH_REQUIRED')` when `ctx.authInfo` carries no
 *    credential (skip with `skipAuthCheck: true`). The check accepts the
 *    discriminated `credential` shape (preferred) AND the deprecated
 *    `token` / `clientId` fields populated by pre-#1269 authenticators —
 *    fail-closed only when none of the three are present.
 * 3. Calls `toAccount(ctx)` and returns the result. Buyer-supplied
 *    `AccountReference` is ignored — single-tenant by definition.
 * 4. Omits `upsert` — single-tenant adapters have no buyer-managed roster.
 *    Adopters who need `upsert` compose via spread.
 * 5. Wires `list` when `options.list` is provided (see `DerivedAccountStoreOptions.list`
 *    for semantics and the spec-compliance motivation).
 *
 * **When NOT to use this.** If buyers need to pass `account_id` on mutating
 * requests (i.e., different auth principals reference different accounts by
 * id), use Shape B ({@link createOAuthPassthroughResolver}) or
 * `createTenantStore` with `resolution: 'explicit'`. The `'derived'`
 * resolution mode refuses inline `account_id` references unconditionally —
 * even if you provide `list?` and the listing returns multiple accounts,
 * buyers cannot address those accounts by id on subsequent calls. The
 * `list?` option is for discovery / spec-compliance only (see
 * `DerivedAccountStoreOptions.list`). If you need buyers to address specific
 * accounts by id after listing them, use `'explicit'` mode.
 *
 * @example AudioStack-shaped creative adapter:
 * ```ts
 * import { createDerivedAccountStore } from '@adcp/sdk/server';
 *
 * const accounts = createDerivedAccountStore<AudioStackAccountMeta>({
 *   toAccount: (ctx) => ({
 *     id: 'audiostack',
 *     name: 'AudioStack',
 *     status: 'active',
 *     ctx_metadata: {},                     // tokens stay on ctx.authInfo, not here
 *   }),
 * });
 * ```
 *
 * @example Single-tenant retail-media proxy with derived display name:
 * ```ts
 * const accounts = createDerivedAccountStore<{ tenantId: string }>({
 *   toAccount: (ctx) => {
 *     const cred = ctx?.authInfo?.credential;
 *     const tenantId = cred?.kind === 'oauth' ? cred.client_id
 *                    : cred?.kind === 'api_key' ? cred.key_id
 *                    : 'public';
 *     return {
 *       id: 'criteo',
 *       name: `Criteo (${tenantId})`,
 *       status: 'active',
 *       ctx_metadata: { tenantId },
 *     };
 *   },
 * });
 * ```
 *
 * @example Compose `upsert` for adapters that ALSO want a buyer-driven
 * write path (rare for Shape D, but possible):
 * ```ts
 * const accounts: AccountStore<MyMeta> = {
 *   ...createDerivedAccountStore({ toAccount }),
 *   upsert: async (refs, ctx) => mySync(refs, ctx),
 * };
 * ```
 *
 * **Buyer-supplied `account_id` is refused at the framework boundary.**
 * Since adcp-client#1468, the framework throws `AdcpError('INVALID_REQUEST',
 * { field: 'account.account_id' })` BEFORE reaching this resolver when a
 * `'derived'`-mode platform receives an inline `account_id` — same shape
 * as `'implicit'`'s long-standing refusal (#1364), with a single-tenant
 * message instead of the `sync_accounts`-first guidance. The factory
 * itself ignores any `account_id` that does reach it (defensive belt +
 * braces), but adopters can rely on the framework refusal as the
 * canonical surface. Hand-rolled `'derived'` stores get the same
 * enforcement automatically.
 *
 * @public
 */
export function createDerivedAccountStore<TCtxMeta = Record<string, unknown>>(
  options: DerivedAccountStoreOptions<TCtxMeta>
): AccountStore<TCtxMeta> {
  const skipAuthCheck = options.skipAuthCheck ?? false;

  return {
    resolution: 'derived',

    async resolve(_ref: AccountReference | undefined, ctx?: ResolveContext): Promise<Account<TCtxMeta> | null> {
      if (!skipAuthCheck && !hasAuthSignal(ctx)) {
        throw new AdcpError('AUTH_REQUIRED', {
          message: 'Single-tenant agent requires an authenticated principal; no credential on ctx.authInfo.',
          recovery: 'correctable',
        });
      }
      return options.toAccount(ctx);
    },

    ...(options.list ? { list: options.list } : {}),
  };
}

/**
 * True when `ctx.authInfo` carries any usable credential signal — the
 * discriminated `credential` shape (preferred, post-#1269) OR the deprecated
 * `token` / `clientId` fields still populated by pre-Stage-3 authenticators
 * during the N+1 deprecation window. Fail-closed only when none are present.
 */
function hasAuthSignal(ctx: ResolveContext | undefined): boolean {
  const authInfo = ctx?.authInfo;
  if (!authInfo) return false;
  return authInfo.credential !== undefined || authInfo.token !== undefined || authInfo.clientId !== undefined;
}
