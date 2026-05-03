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
   * Optional handler for ref-less calls — `provide_performance_feedback`,
   * `list_creative_formats`, `preview_creative`. These tools call
   * `accounts.resolve(undefined, ctx)`; with no ref to look up, the
   * default behavior is to return `null` and let the handler narrow on
   * `ctx.account === undefined`.
   *
   * Provide this to return a framework `Account<TCtxMeta>` directly —
   * typically a singleton "publisher tenant" used for format-catalog
   * reads, or an auth-principal-derived account looked up off
   * `ctx.authInfo.credential`. Return `undefined` to fall back to the
   * default null behavior.
   *
   * **Returns `Account<TCtxMeta>`, not `TRosterEntry`.** The synth case
   * is structurally different from a roster row (often no advertiser, no
   * upstream IDs, no rate card) so the helper does NOT thread the result
   * through `toAccount`. If your synth case happens to be a real roster
   * row, call `toAccount(entry, ctx)` yourself in this callback.
   */
  resolveWithoutRef?: (
    ctx: ResolveContext | undefined
  ) => Account<TCtxMeta> | undefined | Promise<Account<TCtxMeta> | undefined>;
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
 * - Sensible defaults for ref-less calls (return null) and brand-only
 *   refs (return null — publisher-curated platforms expect explicit ids)
 *
 * Adopters who need `upsert` (buyer-driven write paths via `sync_accounts`),
 * `refreshToken`, `reportUsage`, or `getAccountFinancials` compose them on
 * top of the returned store with a spread:
 *
 * ```ts
 * const accounts: AccountStore<MyMeta> = {
 *   ...createRosterAccountStore({ lookup, toAccount }),
 *   refreshToken: async (account) => myUpstream.refresh(account),
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

      if (ref === undefined && options.resolveWithoutRef !== undefined) {
        const account = await options.resolveWithoutRef(ctx);
        return account ?? null;
      }

      // Brand+operator-shaped refs (no account_id) and unhandled ref-less
      // calls fall through to null. Publisher-curated platforms expect
      // explicit ids; adopters who want brand-shape resolution add a
      // wrapper around `resolve` that handles that arm before delegating.
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
