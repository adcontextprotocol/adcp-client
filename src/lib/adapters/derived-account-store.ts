/**
 * Derived `AccountStore` factory for `resolution: 'derived'` — agents that
 * front an **upstream-managed account namespace**. The upstream platform
 * (Meta / Snap business accounts, AudioStack workspaces, a retail-media
 * proxy, a flashtalking tenant) owns the roster; the buyer discovers ids with
 * `list_accounts` and passes `{ account_id }` on every account-scoped call.
 *
 * Roster size is an operational property of the upstream, not a different SDK
 * pattern: a credential that reaches exactly one account (AudioStack-shaped)
 * and a credential that reaches two hundred (Meta-shaped) speak the same wire
 * contract. Pick the option shape that matches — `toAccount` for the
 * credential-bound singleton, `listAccounts` for a real roster.
 *
 * Pairs with the other reference adapters. Pick by asking *who owns the
 * roster?*:
 * - **Buyer declares accounts via `sync_accounts`** → {@link InMemoryImplicitAccountStore}
 *   (Shape A, `resolution: 'implicit'`).
 * - **Upstream OAuth API owns the roster, you only need `resolve`** →
 *   {@link createOAuthPassthroughResolver} (Shape B, `resolution: 'explicit'`).
 * - **You own the roster (storefront table, admin UI)** → {@link createRosterAccountStore}
 *   (Shape C, `resolution: 'explicit'`).
 * - **An upstream platform owns the roster and you front it** →
 *   `createDerivedAccountStore` (this file, Shape D, `resolution: 'derived'`).
 *
 * **Changed in SDK 14 (breaking, adcp-client#1647 / upstream adcp#5062).**
 * Shape D used to be documented as "single-tenant; `account_id` is meaningless
 * on the wire" and the framework refused inline `account_id` for it. The wire
 * semantics were inverted: `account_id` is now the durable reference, the
 * brand+operator arm is refused, `list_accounts` is required, and this factory
 * verifies buyer-supplied ids instead of ignoring them.
 *
 * Closes adcp-client#1462, reworked by adcp-client#1647.
 *
 * @see docs/guides/account-resolution.md
 * @public
 */

import type { AccountReference, ListAccountsRequest } from '../types/tools.generated';
import type { Account, AccountStore, ListAccountsHandlerResult, ResolveContext } from '../server/decisioning/account';
import { refAccountId } from '../server/decisioning/account';
import { isSandboxOrMockAccount } from '../server/account-mode';
import { AdcpError } from '../server/decisioning/async-outcome';

/** Options shared by both Shape D variants. @public */
export interface DerivedAccountStoreBaseOptions {
  /**
   * Skip the `AUTH_REQUIRED` precheck. Defaults to `false` — the factory
   * throws `AdcpError('AUTH_REQUIRED')` when `ctx.authInfo` is absent or
   * carries no credential, matching the canonical Shape D pattern (every
   * call must authenticate, because the credential is what scopes the
   * reachable roster).
   *
   * Set to `true` for genuinely unauthenticated agents (rare — public format
   * catalogs, signed-request-only agents that authenticate out-of-band).
   * When `true`, the account callbacks run unconditionally.
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
}

/**
 * Shape D options for a credential-bound singleton — one upstream account per
 * credential (AudioStack, flashtalking, a single-namespace retail-media
 * proxy).
 *
 * @public
 */
export interface DerivedSingletonAccountStoreOptions<
  TCtxMeta = Record<string, unknown>,
> extends DerivedAccountStoreBaseOptions {
  /**
   * Build the one account this credential can reach. Called on every
   * `resolve()` and `list()` (no caching — the tenant is per-request because
   * the auth principal varies).
   *
   * The factory verifies buyer-supplied references against the returned
   * `id`: a request carrying a different `account_id` resolves to `null`
   * (framework → `ACCOUNT_NOT_FOUND`) rather than being silently serviced
   * against this account. You do not implement that check yourself.
   *
   * `id` must be the id the upstream namespace actually uses — it is what
   * `list_accounts` publishes and what buyers will send back. A placeholder
   * like `'__singleton__'` is fine only if that is genuinely the id you want
   * on the wire.
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
  toAccount: (ctx: ResolveContext | undefined) => Account<TCtxMeta> | Promise<Account<TCtxMeta>>;
  /** Mutually exclusive with `toAccount` — supply the roster options instead. */
  listAccounts?: never;
  /** Applies to `listAccounts` rosters only. */
  lookupAccount?: never;
}

/**
 * Shape D options for a credential-scoped roster — the upstream exposes many
 * accounts to one credential (Meta / Snap business managers, an agency seat).
 *
 * @public
 */
export interface DerivedRosterAccountStoreOptions<
  TCtxMeta = Record<string, unknown>,
> extends DerivedAccountStoreBaseOptions {
  /**
   * Enumerate every account the **caller's credential** can reach. Backs
   * `list_accounts` and, unless `lookupAccount` is supplied, the verification
   * of buyer-supplied `account_id` references.
   *
   * This is the tenant-isolation boundary for the whole namespace: scope the
   * query by `ctx.authInfo` (OAuth `client_id`, API-key `key_id`, the
   * upstream token you exchange for it). Returning the full upstream roster
   * regardless of caller is a cross-tenant enumeration *and* authorization
   * bug — every id returned here becomes an id that caller can transact on.
   */
  listAccounts: (
    ctx: ResolveContext | undefined
  ) => readonly Account<TCtxMeta>[] | Promise<readonly Account<TCtxMeta>[]>;

  /**
   * Optional point-lookup for large rosters — avoids materializing the full
   * list on every `resolve()`. Return the account for `accountId`, or `null`
   * when the caller's credential cannot reach it.
   *
   * **Must be credential-scoped.** The `accountId` is a buyer-supplied claim;
   * an unscoped `SELECT ... WHERE id = $1` here is a tenant-isolation bypass.
   * The factory defends what it can — a returned account whose `id` differs
   * from the requested one is discarded — but it cannot tell whether your
   * query filtered on the caller.
   *
   * Omit it and the factory verifies against `listAccounts(ctx)` instead,
   * which is safe by construction.
   */
  lookupAccount?: (
    accountId: string,
    ctx: ResolveContext | undefined
  ) => Account<TCtxMeta> | null | undefined | Promise<Account<TCtxMeta> | null | undefined>;
  /** Mutually exclusive with `listAccounts` — supply the singleton option instead. */
  toAccount?: never;
}

/**
 * Options for {@link createDerivedAccountStore}. Supply `toAccount` (one
 * account per credential) or `listAccounts` (a credential-scoped roster) —
 * never both.
 *
 * @public
 */
export type DerivedAccountStoreOptions<TCtxMeta = Record<string, unknown>> =
  | DerivedSingletonAccountStoreOptions<TCtxMeta>
  | DerivedRosterAccountStoreOptions<TCtxMeta>;

/**
 * Build an `AccountStore<TCtxMeta>` for an agent fronting an upstream-managed
 * account namespace.
 *
 * The factory:
 * 1. Sets `resolution: 'derived'`.
 * 2. Throws `AdcpError('AUTH_REQUIRED')` when `ctx.authInfo` carries no
 *    credential (skip with `skipAuthCheck: true`). The check accepts the
 *    discriminated `credential` shape (preferred) AND the deprecated
 *    `token` / `clientId` fields populated by pre-#1269 authenticators —
 *    fail-closed only when none of the three are present.
 * 3. **Verifies buyer-supplied `account_id` against what the credential can
 *    reach**, and returns `null` on any miss so the framework emits the
 *    spec's fixed `ACCOUNT_NOT_FOUND` envelope. Verification is performed by
 *    the factory, not delegated to adopter code — an adopter cannot forget
 *    it and silently serve cross-tenant requests.
 * 4. Auto-selects the singleton for ref-less calls
 *    (`list_creative_formats`, `provide_performance_feedback`, …) when the
 *    credential reaches exactly one account; returns `null` when it reaches
 *    several, because "whichever one" is not a defensible default.
 * 5. Wires `list` (`list_accounts`) — required for `'derived'` platforms, and
 *    the only way buyers learn ids. Honors the wire filters the framework
 *    passes through (`account`, `status`, `sandbox`) and pages the result
 *    (`pagination.max_results`, capped at 100, with an opaque cursor).
 * 6. Omits `upsert`. Natural-key provisioning is out of scope for this mode
 *    (the framework fails those `sync_accounts` entries per-row with
 *    `UNSUPPORTED_PROVISIONING`); adopters whose upstream supports
 *    settings-update writes compose `upsert` on top via spread.
 *
 * **Refuses the brand+operator arm.** The framework rejects `{ brand,
 * operator }` references for `'derived'` platforms with
 * `AdcpError('INVALID_REQUEST', { field: 'account.brand' })` before reaching
 * this resolver, pointing the buyer at `list_accounts`. The factory also
 * returns `null` for such refs defensively.
 *
 * @example AudioStack-shaped adapter (one workspace per credential):
 * ```ts
 * import { createDerivedAccountStore } from '@adcp/sdk/server';
 *
 * const accounts = createDerivedAccountStore<AudioStackAccountMeta>({
 *   toAccount: async (ctx) => {
 *     const workspace = await audiostack.currentWorkspace(ctx?.authInfo);
 *     return {
 *       id: workspace.id,            // the id buyers will send back
 *       name: workspace.name,
 *       status: 'active',
 *       ctx_metadata: {},            // tokens stay on ctx.authInfo, not here
 *     };
 *   },
 * });
 * ```
 *
 * @example Meta-shaped adapter (many ad accounts per credential):
 * ```ts
 * const accounts = createDerivedAccountStore<{ upstreamId: string }>({
 *   listAccounts: async (ctx) => {
 *     const rows = await meta.adAccountsFor(ctx?.authInfo);  // credential-scoped
 *     return rows.map(r => ({
 *       id: r.account_id,
 *       name: r.name,
 *       status: r.disabled ? 'suspended' : 'active',
 *       ctx_metadata: { upstreamId: r.id },
 *     }));
 *   },
 * });
 * ```
 *
 * @example Large roster with a point lookup:
 * ```ts
 * const accounts = createDerivedAccountStore({
 *   listAccounts: (ctx) => upstream.page(ctx?.authInfo),
 *   // MUST filter by the caller, not just by id:
 *   lookupAccount: (id, ctx) => upstream.accountForCaller(id, ctx?.authInfo),
 * });
 * ```
 *
 * @example Compose `upsert` for an upstream that supports settings updates:
 * ```ts
 * const accounts: AccountStore<MyMeta> = {
 *   ...createDerivedAccountStore({ listAccounts }),
 *   // Entries reaching this are `account: { account_id }`-keyed AND already
 *   // resolved against the caller's reachable set — the framework refuses
 *   // natural-key provisioning and unreachable ids for 'derived'. Returned
 *   // rows must still carry `brand` + `operator` (schema-required); echo
 *   // them from your own account record.
 *   upsert: async (refs, ctx) => myUpstream.updateSettings(refs, ctx),
 * };
 * ```
 *
 * @public
 */
export function createDerivedAccountStore<TCtxMeta = Record<string, unknown>>(
  options: DerivedAccountStoreOptions<TCtxMeta>
): AccountStore<TCtxMeta> {
  // Strict `true` — an untyped `skipAuthCheck: 'false'` must not disable
  // the credential gate.
  const skipAuthCheck = options.skipAuthCheck === true;
  const singleton = (options as DerivedSingletonAccountStoreOptions<TCtxMeta>).toAccount;
  const roster = (options as DerivedRosterAccountStoreOptions<TCtxMeta>).listAccounts;
  const lookup = (options as DerivedRosterAccountStoreOptions<TCtxMeta>).lookupAccount;

  if (singleton === undefined && roster === undefined) {
    throw new TypeError(
      'createDerivedAccountStore: supply toAccount (one account per credential) or listAccounts (a ' +
        'credential-scoped roster). Neither was provided.'
    );
  }
  if (singleton !== undefined && roster !== undefined) {
    throw new TypeError(
      'createDerivedAccountStore: supply toAccount or listAccounts, not both — two sources of truth for ' +
        'the same namespace cannot be verified against each other.'
    );
  }
  if (singleton !== undefined && lookup !== undefined) {
    throw new TypeError('createDerivedAccountStore: lookupAccount applies to listAccounts rosters, not to toAccount.');
  }

  /** Every account the caller's credential can reach. */
  const reachable = async (ctx: ResolveContext | undefined): Promise<readonly Account<TCtxMeta>[]> =>
    singleton !== undefined ? [await singleton(ctx)] : [...(await roster!(ctx))];

  const requireAuth = (ctx: ResolveContext | undefined): void => {
    if (skipAuthCheck || hasAuthSignal(ctx)) return;
    throw new AdcpError('AUTH_REQUIRED', {
      message:
        'This agent fronts an upstream-managed account namespace and requires an authenticated principal; ' +
        'no credential on ctx.authInfo.',
      recovery: 'correctable',
    });
  };

  return {
    resolution: 'derived',

    async resolve(ref: AccountReference | undefined, ctx?: ResolveContext): Promise<Account<TCtxMeta> | null> {
      requireAuth(ctx);

      const accountId = refAccountId(ref);
      if (accountId !== undefined) {
        if (lookup !== undefined) {
          const hit = await lookup(accountId, ctx);
          // Defense in depth: an adopter lookup that ignores the id (or
          // returns a neighbouring row) must not become a silent
          // cross-account substitution.
          return hit != null && hit.id === accountId ? hit : null;
        }
        return (await reachable(ctx)).find(account => account.id === accountId) ?? null;
      }

      // Brand+operator refs are refused at the framework boundary for this
      // mode; `null` here is the defensive path for direct resolver calls.
      if (ref !== undefined) return null;

      // Ref-less call (including tools with no `account` field on the wire).
      // Auto-select only when the credential reaches exactly one account —
      // an account-required operation projects any other roster size as
      // ACCOUNT_REQUIRED, never as an arbitrary pick.
      const accounts = await reachable(ctx);
      return accounts.length === 1 ? accounts[0]! : null;
    },

    async list(request: ListAccountsRequest, ctx?: ResolveContext): Promise<ListAccountsHandlerResult<TCtxMeta>> {
      requireAuth(ctx);
      const filterId = refAccountId(request?.account);
      const filterKey = naturalKeyFilter(request?.account);
      const items = (await reachable(ctx)).filter(account => {
        if (filterId !== undefined && account.id !== filterId) return false;
        // A natural-key filter is a narrowing request, not a no-op: match it
        // against the row's own brand/operator, and drop rows that can't
        // satisfy it. (Ignoring the filter would answer "which account is
        // brand X's?" with the entire roster.)
        if (filterKey !== undefined) {
          if (filterKey.brandDomain !== undefined && account.brand?.domain !== filterKey.brandDomain) return false;
          if (filterKey.brandId !== undefined && account.brand?.brand_id !== filterKey.brandId) return false;
          if (filterKey.operator !== undefined && account.operator !== filterKey.operator) return false;
        }
        if (request?.status !== undefined && account.status !== request.status) return false;
        // Wire `sandbox` filter maps to the resolved account's operational
        // mode through the shared predicate (which honors the deprecated
        // `sandbox` flag and treats `mode: 'mock'` as non-live), so
        // "sandbox" means one thing across the SDK.
        if (request?.sandbox !== undefined && isSandboxOrMockAccount(account) !== request.sandbox) return false;
        return true;
      });
      // Bounded pages: the roster shape is explicitly for credentials that
      // reach many accounts, so an unbounded page is both a wire-contract
      // miss (`pagination.has_more` would always be false) and an
      // allocation amplifier. Offset cursors are correct here because the
      // page is materialized from one snapshot per request.
      const offset = decodePageCursor(request?.pagination?.cursor);
      const limit = pageLimit(request?.pagination?.max_results);
      const page = items.slice(offset, offset + limit);
      const nextOffset = offset + page.length;
      return {
        items: page,
        ...(nextOffset < items.length && { nextCursor: encodePageCursor(nextOffset) }),
        totalCount: items.length,
      };
    },
  };
}

/** Spec cap on `pagination.max_results` (`core/pagination-request.json`). */
const MAX_PAGE_SIZE = 100;

/** Clamp a buyer-supplied `max_results` into `[1, MAX_PAGE_SIZE]`. */
function pageLimit(maxResults: number | undefined): number {
  if (typeof maxResults !== 'number' || !Number.isFinite(maxResults)) return MAX_PAGE_SIZE;
  return Math.min(Math.max(Math.trunc(maxResults), 1), MAX_PAGE_SIZE);
}

/**
 * Opaque continuation cursor. Offset-encoded and prefixed so a cursor
 * minted elsewhere (or a hand-crafted one) doesn't silently read as a
 * position — unparseable cursors restart at 0 rather than throwing, which
 * keeps a stale cursor from turning into a dispatch error.
 */
function encodePageCursor(offset: number): string {
  return Buffer.from(`derived:${offset}`, 'utf8').toString('base64url');
}

function decodePageCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^derived:(\d+)$/.exec(decoded);
    if (match === null) return 0;
    const offset = Number.parseInt(match[1]!, 10);
    return Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
  } catch {
    return 0;
  }
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

/**
 * Extract the `{ brand, operator }` narrowing terms from a `list_accounts`
 * filter. Returns `undefined` when the filter carries no natural key.
 */
function naturalKeyFilter(
  ref: AccountReference | undefined
): { brandDomain?: string; brandId?: string; operator?: string } | undefined {
  if (ref === undefined) return undefined;
  const brand = (ref as { brand?: { domain?: unknown; brand_id?: unknown } }).brand;
  const operator = (ref as { operator?: unknown }).operator;
  const brandDomain = typeof brand?.domain === 'string' ? brand.domain : undefined;
  const brandId = typeof brand?.brand_id === 'string' ? brand.brand_id : undefined;
  if (brandDomain === undefined && brandId === undefined && typeof operator !== 'string') return undefined;
  return {
    ...(brandDomain !== undefined && { brandDomain }),
    ...(brandId !== undefined && { brandId }),
    ...(typeof operator === 'string' && { operator }),
  };
}
