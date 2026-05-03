/**
 * Derived `AccountStore` factory for `resolution: 'derived'` platforms —
 * Shape D of the four-shape account-resolution family.
 *
 * Use when every request authenticates with the same per-request credential
 * and there is no `account_id` concept on the wire: the auth principal alone
 * identifies the tenant. Common for self-hosted broadcasters, single-namespace
 * creative adapters (Audiostack, Flashtalking), and retail-media proxies where
 * the buyer's API key IS the account.
 *
 * **Picking an AccountStore?** Four reference shapes by *who creates the
 * account*:
 * - **Buyer self-onboards via `sync_accounts`** → `InMemoryImplicitAccountStore`
 *   (Shape A, `resolution: 'implicit'`). Buyer calls `sync_accounts` first;
 *   subsequent tool calls resolve from the auth principal's pre-synced linkage.
 * - **Upstream OAuth API owns the roster** → `createOAuthPassthroughResolver`
 *   (Shape B, `resolution: 'explicit'`). Returns just `resolve`; adopter
 *   composes into an AccountStore. Snap, Meta, TikTok — anywhere the buyer's
 *   bearer is the lookup key for an upstream `/me/adaccounts`.
 * - **Publisher ops curates the roster out-of-band** → `createRosterAccountStore`
 *   (Shape C, `resolution: 'explicit'`). Adopter brings their own persistence
 *   (DB row, admin-UI-managed config); SDK provides AccountStore plumbing.
 * - **Stateless single-tenant** → `createDerivedAccountStore`
 *   (this file, Shape D, `resolution: 'derived'`). No roster, no sync step.
 *   Auth principal IS the account. Use when the buyer's API key or OAuth
 *   credential maps 1:1 to the seller's platform configuration.
 *
 * **Why Shape D over writing the class by hand?**
 * Without this factory, every Shape D adapter writes the same ~25–30 LOC:
 * extract token from `ctx.authInfo`, build an Account literal, return it.
 * Five+ adapters in scope3data/agentic-adapters wrote identical boilerplate,
 * all with the same latent bug: `resolution: 'explicit'` (wrong) instead of
 * `resolution: 'derived'` (correct). The factory standardizes the right
 * declaration and eliminates the boilerplate centrally.
 *
 * **`authenticate` hook is required.** Shape D derives the account from
 * `ctx.authInfo`. Configure `serve({ authenticate })` so the framework
 * rejects unauthenticated requests with `AUTH_REQUIRED` before `resolve()`
 * is ever called. When `ctx.authInfo` is absent (no `authenticate` configured
 * or the hook passed an unauthenticated request), `resolve()` returns `null`,
 * projecting to `ACCOUNT_NOT_FOUND` — a misleading signal. Wire up
 * `authenticate` to avoid this.
 *
 * **`authInfo` is auto-attached.** The framework automatically attaches the
 * principal from `ctx.authInfo` to the resolved `Account` when the adopter
 * omits `account.authInfo`. Adopters only need to set `authInfo` explicitly
 * when transforming the principal (e.g., deriving a scoped sub-principal).
 *
 * @see docs/guides/account-resolution.md
 * @public
 */

import type { AccountReference } from '../types/tools.generated';
import type { Account, AccountStore, ResolveContext, ResolvedAuthInfo } from '../server/decisioning/account';

/**
 * Options for {@link createDerivedAccountStore}.
 *
 * @public
 */
export interface DerivedAccountStoreOptions<TCtxMeta = Record<string, unknown>> {
  /**
   * Convert the request's verified auth context to the framework's `Account`
   * shape. Called once per request with `authInfo` guaranteed non-null — the
   * factory guards before calling this callback.
   *
   * `authInfo` is the raw transport-level principal extracted by
   * `serve({ authenticate })`. For API-key platforms, `authInfo.token` is the
   * raw key; for OAuth platforms, `authInfo.token` is the bearer. The
   * discriminated `authInfo.credential` carries a stable identity across token
   * rotations (`credential.key_id` for API keys, `credential.client_id` for
   * OAuth).
   *
   * **DO NOT put credentials in `ctx_metadata`.** The wire-strip protects
   * buyer responses, but server-side log lines, error envelopes, heap dumps,
   * and adopter-generated strings (e.g. `JSON.stringify(account)`) can still
   * leak them. Re-derive the bearer per request from `authInfo.token` inside
   * specialism methods rather than caching it in `ctx_metadata`. See
   * `docs/guides/CTX-METADATA-SAFETY.md` for the recommended pattern.
   *
   * Set `id` to a stable per-tenant identifier (not the bearer itself — it
   * rotates). For API-key platforms, prefer `authInfo.credential?.key_id`
   * (when available) or a hash of `authInfo.token`. For OAuth, prefer
   * `authInfo.credential?.client_id`.
   *
   * Adopters MAY omit `authInfo` from the returned `Account`. The framework
   * auto-attaches the principal from `ctx.authInfo` so downstream specialism
   * methods can read it off `ctx.account.authInfo` without you wiring it
   * manually. Set `account.authInfo` only when you need to transform the
   * principal (e.g. derive a scoped sub-principal for multi-tenant proxies).
   *
   * @example API-key creative adapter:
   * ```ts
   * const accounts = createDerivedAccountStore({
   *   toAccount: (authInfo) => ({
   *     id: authInfo.credential?.kind === 'api_key'
   *       ? `key:${authInfo.credential.key_id}`
   *       : 'default',
   *     name: 'My Platform',
   *     status: 'active',
   *     ctx_metadata: {
   *       // Non-credential upstream IDs are safe in ctx_metadata.
   *       // The bearer itself belongs on authInfo.token — re-derive it
   *       // from ctx.account.authInfo.token inside specialism methods.
   *       upstreamPublisherId: 'pub_001',
   *     },
   *   }),
   * });
   * ```
   */
  toAccount: (authInfo: ResolvedAuthInfo, ctx: ResolveContext) => Account<TCtxMeta> | Promise<Account<TCtxMeta>>;
}

/**
 * Build a stateless single-tenant `AccountStore<TCtxMeta>` where the auth
 * principal alone identifies the tenant — no account roster, no `sync_accounts`
 * step, no buyer-supplied `account_id`.
 *
 * The returned store:
 * - Sets `resolution: 'derived'`
 * - Ignores buyer-supplied `AccountReference` (single-tenant by definition)
 * - Returns `null` (→ `ACCOUNT_NOT_FOUND`) when `ctx.authInfo` is absent —
 *   wire the `serve({ authenticate })` hook to ensure auth is always present
 * - Calls `toAccount(authInfo, ctx)` for every request where `ctx.authInfo`
 *   is set; the framework auto-attaches `authInfo` to the returned `Account`
 *   when the adopter omits it
 * - Omits `list` and `upsert` — single-tenant adapters have nothing to
 *   enumerate or write. Compose via spread to add either:
 *   `{ ...createDerivedAccountStore(...), list: async () => { ... } }`
 *
 * **`INVALID_REQUEST` for buyer-supplied `account_id`** is enforced at the
 * framework layer (analogous to `'implicit'` mode refusing inline `account_id`
 * references), not inside `resolve()` — see adcp-client#1365 for the
 * `'implicit'` precedent. The framework will wire the same guard for
 * `'derived'` mode in a follow-up.
 *
 * @example Minimal API-key adapter:
 * ```ts
 * import { createDerivedAccountStore } from '@adcp/sdk/server';
 *
 * const accounts = createDerivedAccountStore({
 *   toAccount: (authInfo) => ({
 *     id: 'audiostack',
 *     name: 'AudioStack',
 *     status: 'active',
 *     ctx_metadata: {},
 *   }),
 * });
 *
 * // Wire into createAdcpServer / defineSalesPlatform:
 * createAdcpServer({ accounts, ... });
 * ```
 *
 * @example Stable per-key id (recommended for multi-key setups):
 * ```ts
 * const accounts = createDerivedAccountStore({
 *   toAccount: (authInfo) => ({
 *     id: authInfo.credential?.kind === 'api_key'
 *       ? `key:${authInfo.credential.key_id}`
 *       : 'default',
 *     name: 'Flashtalking',
 *     status: 'active',
 *     ctx_metadata: {},
 *   }),
 * });
 * ```
 *
 * @public
 */
export function createDerivedAccountStore<TCtxMeta = Record<string, unknown>>(
  options: DerivedAccountStoreOptions<TCtxMeta>
): AccountStore<TCtxMeta> {
  return {
    resolution: 'derived',

    async resolve(_ref: AccountReference | undefined, ctx?: ResolveContext): Promise<Account<TCtxMeta> | null> {
      const authInfo = ctx?.authInfo;
      // Return null when authInfo is absent so the framework projects
      // ACCOUNT_NOT_FOUND. AUTH_REQUIRED is the authenticate hook's
      // responsibility — by the time resolve() runs, auth should be verified.
      if (authInfo === undefined) return null;
      return options.toAccount(authInfo, ctx as ResolveContext);
    },
  };
}
