/**
 * Roster-backed `AccountStore` factory for `resolution: 'explicit'` platforms
 * where the publisher curates accounts out-of-band (admin UI, config file,
 * publisher-managed DB row) and buyers pass `account_id` on every request.
 *
 * Pairs with the existing reference adapters. Pick by asking *who creates the
 * account?*:
 * - **Buyer self-onboards via `sync_accounts`** → {@link InMemoryImplicitAccountStore}
 *   (Shape A, `resolution: 'implicit'`). Framework owns persistence; the
 *   buyer's first request to a tenant-scoped tool resolves from a prior
 *   sync. LinkedIn, some retail-media operators.
 * - **Upstream OAuth API owns the roster** → {@link createOAuthPassthroughResolver}
 *   (Shape B, `resolution: 'explicit'`). Returns just the `resolve` function;
 *   adopter composes into an AccountStore. Snap, Meta, TikTok — anywhere
 *   the buyer's bearer is the lookup key for an upstream `/me/adaccounts`.
 * - **Publisher ops curates the roster out-of-band** → `createRosterAccountStore`
 *   (this file, Shape C, `resolution: 'explicit'`). Adopter keeps the
 *   persistence layer (storefront table, admin-UI-managed JSON column,
 *   in-memory map); the SDK provides the AccountStore plumbing. Most
 *   SSPs, broadcasters, and retail-media networks where AE/CSM provisions
 *   the account in an internal admin tool before the buyer ever calls.
 * - **Stateless single-tenant** → {@link createDerivedAccountStore}
 *   (Shape D, `resolution: 'derived'`). No roster, no sync step. Auth
 *   principal IS the account. Creative adapters, single-namespace retail-media
 *   proxies, self-hosted broadcasters where the buyer's API key maps 1:1 to
 *   the platform configuration.
 *
 * Design notes:
 * - Lookup is a point function, not a roster getter. An adopter with
 *   thousands of accounts per tenant in Postgres can issue a SELECT WHERE
 *   id = $1 instead of materializing the full array on every request.
 * - `list` is opt-in. Omit it and the framework emits UNSUPPORTED_FEATURE
 *   for `list_accounts` calls (matches `AccountStore.list?` semantics).
 *   Provide it and the adopter pushes filter+page down to whatever index
 *   they have.
 * - No `upsert`, `reportUsage`, `getAccountFinancials`, or `refreshToken`.
 *   Adopters who need those compose the helper output:
 *   `{ ...createRosterAccountStore(...), refreshToken: async (a) => { ... } }`.
 *
 * @see docs/guides/account-resolution.md
 * @public
 */

import type { AccountReference } from '../types/tools.generated';
import type { Account, AccountFilter, AccountStore, ResolveContext } from '../server/decisioning/account';
import { refAccountId } from '../server/decisioning/account';
import type { CursorPage, CursorRequest } from '../server/decisioning/pagination';

/**
 * Options for {@link createRosterAccountStore}.
 *
 * @public
 */
export interface RosterAccountStoreOptions<TRosterEntry, TCtxMeta = Record<string, unknown>> {
  /**
   * Point-lookup against the adopter's roster source. Return the entry for
   * a given `account_id`, or `undefined` when no row matches.
   *
   * Called once per `resolve()` with an `account_id`-shaped reference. Wire
   * shape `{ brand, operator }` and missing refs do NOT call `lookup`; see
   * the resolve behavior below.
   *
   * Throw to signal a transient upstream failure (DB outage, network blip).
   * The framework projects to `SERVICE_UNAVAILABLE`. Returning `undefined`
   * is the canonical not-found path and projects to `ACCOUNT_NOT_FOUND`.
   */
  lookup: (
    accountId: string,
    ctx: ResolveContext | undefined
  ) => TRosterEntry | undefined | Promise<TRosterEntry | undefined>;

  /**
   * Convert a roster entry to the framework's `Account<TCtxMeta>` shape.
   *
   * The adopter's roster row typically lacks `ctx_metadata` (which is a
   * framework-internal field). This mapper is where the adopter populates
   * it — upstream IDs, per-account caches, anything specialism methods will
   * read off `ctx.account.ctx_metadata` later.
   *
   * **DO NOT put credentials in `ctx_metadata`.** See
   * `docs/guides/CTX-METADATA-SAFETY.md` for the rationale and the
   * recommended re-derive-per-request pattern (read tokens off
   * `ctx.authInfo` instead).
   *
   * Adopters MAY omit `authInfo` from the returned `Account` — the
   * framework auto-attaches the principal from `ctx.authInfo` when absent.
   */
  toAccount: (entry: TRosterEntry, ctx: ResolveContext | undefined) => Account<TCtxMeta>;

  /**
   * Optional `list_accounts` implementation. The adopter receives the wire
   * filter + cursor request and returns a page of roster entries; the
   * helper threads each entry through `toAccount` before returning.
   *
   * Omit to leave `list_accounts` unimplemented (framework returns
   * `UNSUPPORTED_FEATURE`).
   *
   * **Push filter + pagination down.** The naive shape — fetch the full
   * roster, filter+slice in memory — works for tens of accounts per tenant
   * but does not scale. Adopters with a Postgres-backed roster should map
   * `filter.brand_domain` / `filter.operator` / `filter.status[]` /
   * `cursor` / `limit` to a SQL query. The helper does NOT post-filter;
   * the adopter is the source of truth.
   *
   * **No default status filter.** `filter.status` is `undefined` unless the
   * buyer passed it. If you want production callers to see only `active` +
   * `pending_approval` by default, apply that fallback inside your query —
   * the helper passes `filter` through verbatim.
   */
  list?: (
    filter: AccountFilter & CursorRequest,
    ctx: ResolveContext | undefined
  ) => CursorPage<TRosterEntry> | Promise<CursorPage<TRosterEntry>>;

  /**
   * Handle ref-less `accounts.resolve(undefined, ctx)` calls — invoked by
   * `list_creative_formats`, `provide_performance_feedback`, `preview_creative`,
   * and any discovery-phase tool that does not require a buyer-selected account.
   *
   * Return a synthetic publisher-wide roster entry; `toAccount` is applied to
   * it before the result is returned to the framework. Return `undefined` to
   * fall back to `null` (same as omitting this option — `ctx.account` is
   * `undefined` in the handler).
   *
   * The `ref` parameter is always `undefined` here — it is present for
   * signature parity with the framework's `resolve(ref, ctx)` shape so
   * code-generation tools produce consistent two-arg handler signatures.
   * Ignore it (use `(_ref, ctx) => ...`).
   *
   * Throw to signal a transient upstream failure (DB outage, network blip).
   * The framework projects to `SERVICE_UNAVAILABLE`. Returning `undefined`
   * is the canonical not-found path and returns `null` to the framework.
   *
   * **Brand+operator refs are not routed here.** A `{ brand, operator }` ref
   * without an `account_id` still falls through to `null`. Adopters who need
   * to handle brand-arm refs must override `resolve` on the returned store via
   * a spread.
   *
   * **`toAccount` is called on your return value** with the same `ctx`,
   * identical to the `lookup` path. Ensure your synthesized entry satisfies
   * all required fields of `TRosterEntry`.
   *
   * **Auth-derived lookup.** If your singleton should be derived from
   * `ctx.authInfo` (e.g. a per-tenant publisher account keyed on the OAuth
   * client), and that derivation needs to re-invoke `lookup`, use the
   * spread-override pattern on the returned store instead — a `resolveWithoutRef`
   * that calls back into `lookup` is more naturally expressed as a `resolve`
   * override so the call graph stays flat.
   *
   * **If you also override `resolve` on the spread**, `resolveWithoutRef` is
   * not called — the spread override takes precedence.
   *
   * Omit when `ctx.account === undefined` is acceptable for ref-less tools
   * (handlers can narrow on it and fall back to platform-level config from
   * their closure).
   */
  resolveWithoutRef?: (
    ref: undefined,
    ctx: ResolveContext | undefined
  ) => TRosterEntry | undefined | Promise<TRosterEntry | undefined>;
}

/**
 * Build an `AccountStore<TCtxMeta>` from an adopter-supplied roster source.
 *
 * The adopter brings persistence (DB row, admin-UI-managed JSON column,
 * in-memory Map, file). The helper provides:
 * - `resolution: 'explicit'` declaration
 * - `account_id`-arm dispatch from the wire reference
 * - Mapping from roster entry → `Account<TCtxMeta>` via `toAccount`
 * - Optional `list_accounts` plumbing with cursor envelope passthrough
 * - `null` return for `{ brand, operator }`-shaped refs and ref-less
 *   calls (publisher-curated platforms expect explicit ids)
 *
 * Adopters who need `upsert` (buyer-driven write paths via `sync_accounts`),
 * `refreshToken`, `reportUsage`, or `getAccountFinancials` compose on top
 * of the returned store with a spread:
 *
 * ```ts
 * const accounts: AccountStore<MyMeta> = {
 *   ...createRosterAccountStore({ lookup, toAccount }),
 *   refreshToken: async (account) => myUpstream.refresh(account),
 * };
 * ```
 *
 * **Ref-less calls (singleton fallback).** `list_creative_formats`,
 * `preview_creative`, and `provide_performance_feedback` call
 * `accounts.resolve(undefined, ctx)`. Use `resolveWithoutRef` when your
 * platform needs a synthetic publisher-wide account for these tools:
 *
 * ```ts
 * const accounts = createRosterAccountStore({
 *   lookup,
 *   toAccount,
 *   resolveWithoutRef: () => ({ id: '__publisher__', label: 'Publisher', tenantId: myPlatformId }),
 * });
 * ```
 *
 * The returned entry flows through `toAccount` just like a `lookup` hit.
 * When omitted the helper returns `null` for ref-less calls — handlers can
 * narrow on `ctx.account === undefined` and fall back to platform-level
 * config from their closure.
 *
 * **Ref-less calls (singleton from options):**
 * ```ts
 * const accounts = createRosterAccountStore({
 *   lookup,
 *   toAccount,
 *   resolveWithoutRef: (_ref, ctx) => ({
 *     id: '__publisher__',
 *     name: 'Publisher',
 *     tenant_id: deriveTenant(ctx?.authInfo),
 *   }),
 * });
 * ```
 *
 * **Ref-less calls (auth-derived lookup).** When the singleton should be
 * derived from the caller's principal and needs to call back into `lookup`,
 * use the spread-override pattern instead:
 *
 * ```ts
 * const base = createRosterAccountStore({ lookup, toAccount });
 * const accounts: AccountStore<MyMeta> = {
 *   ...base,
 *   resolve: async (ref, ctx) => {
 *     if (ref === undefined) {
 *       const id = deriveAccountIdFromAuth(ctx?.authInfo);
 *       return id ? base.resolve({ account_id: id }, ctx) : null;
 *     }
 *     return base.resolve(ref, ctx);
 *   },
 * };
 * ```
 *
 * **Hybrid roster + buyer-updatable fields.** Some publisher-curated
 * platforms (GAM, FreeWheel, several retail-media networks) let the buyer
 * PATCH a narrow set of fields — billing contact, AP email, agency-of-record
 * cert — on a publisher-provisioned account, while keeping creation and
 * commercial terms (credit limit, rate card) read-only to the buyer. Compose
 * a partial `upsert` over the roster store and gate it on a field allowlist:
 *
 * ```ts
 * const BUYER_WRITABLE = new Set(['billing_entity', 'setup']);
 * const accounts: AccountStore<MyMeta> = {
 *   ...createRosterAccountStore({ lookup, toAccount }),
 *   upsert: async (refs, ctx) => refs.map(r => applyBuyerPatch(r, BUYER_WRITABLE, ctx)),
 * };
 * ```
 *
 * **Brand-arm refs return `null`.** Buyers who pass `{ brand, operator }`
 * (no `account_id`) hit the framework's `ACCOUNT_NOT_FOUND` envelope. The
 * helper cannot synthesize `INVALID_REQUEST` from inside `resolve` — if your
 * platform needs to reject brand-arm refs as a wire-shape error rather than
 * a not-found, wrap `resolve` and throw `AdcpError('INVALID_REQUEST', { field:
 * 'account.brand' })` before delegating to the helper.
 *
 * @example In-memory roster (tests, small fixed configs):
 * ```ts
 * const accounts = createRosterAccountStore({
 *   lookup: (id) => roster.get(id),
 *   toAccount: (row) => ({
 *     id: row.id,
 *     name: row.name,
 *     status: 'active',
 *     ctx_metadata: { upstreamId: row.upstream_id },
 *   }),
 * });
 * ```
 *
 * @example Postgres-backed roster (publisher with admin UI):
 * ```ts
 * const accounts = createRosterAccountStore({
 *   lookup: async (id, ctx) => {
 *     const tenantId = deriveTenant(ctx?.authInfo);
 *     return await db.oneOrNone(
 *       'SELECT * FROM storefront_accounts WHERE id = $1 AND tenant = $2',
 *       [id, tenantId],
 *     );
 *   },
 *   toAccount: (row) => ({
 *     id: row.id,
 *     name: row.name,
 *     status: row.status,
 *     brand: row.brand,
 *     operator: row.operator,
 *     ctx_metadata: { tenant: row.tenant, upstreamRef: row.upstream_ref },
 *   }),
 *   list: async (filter, ctx) => {
 *     const tenantId = deriveTenant(ctx?.authInfo);
 *     const rows = await db.any(buildListQuery(filter, tenantId));
 *     return { items: rows, nextCursor: nextCursorFor(rows, filter) };
 *   },
 * });
 * ```
 *
 * @public
 */
export function createRosterAccountStore<TRosterEntry, TCtxMeta = Record<string, unknown>>(
  options: RosterAccountStoreOptions<TRosterEntry, TCtxMeta>
): AccountStore<TCtxMeta> {
  const store: AccountStore<TCtxMeta> = {
    resolution: 'explicit',

    async resolve(ref: AccountReference | undefined, ctx?: ResolveContext): Promise<Account<TCtxMeta> | null> {
      const accountId = refAccountId(ref);
      if (accountId !== undefined) {
        const entry = await options.lookup(accountId, ctx);
        return entry === undefined ? null : options.toAccount(entry, ctx);
      }

      // ref is undefined (no account field on wire) — delegate to resolveWithoutRef if provided.
      // Brand+operator refs (ref !== undefined but no account_id) fall through to null below;
      // resolveWithoutRef is intentionally not called for them.
      if (ref === undefined && options.resolveWithoutRef !== undefined) {
        const entry = await options.resolveWithoutRef(undefined, ctx);
        return entry === undefined ? null : options.toAccount(entry, ctx);
      }

      // brand+operator-shaped refs (no account_id) and unhandled ref-less calls → null.
      // Adopters who need brand-arm resolution or auth-derived ref-less lookup wrap
      // `resolve` via spread — see the JSDoc on `createRosterAccountStore`.
      return null;
    },
  };

  if (options.list !== undefined) {
    const adopterList = options.list;
    store.list = async (filter, ctx) => {
      const page = await adopterList(filter, ctx);
      return {
        items: page.items.map(entry => options.toAccount(entry, ctx)),
        ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor }),
      };
    };
  }

  return store;
}
