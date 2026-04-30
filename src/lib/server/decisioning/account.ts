/**
 * Account model. Single-level (matches AdCP wire's AccountReference).
 * Platform-internal hierarchies (GAM Network → Advertiser → Order;
 * Spotify Brand → Campaign) are encoded in `metadata`, not in the typed
 * shape. Generic `TMeta` lets platforms type their metadata at the call site.
 *
 * Tenant isolation is enforced at `accounts.resolve()` returning null for
 * cross-scope references, not via a multi-level type.
 *
 * Status: Preview / 6.0.
 *
 * @public
 */

import type {
  BrandReference,
  AccountReference,
  ReportUsageRequest,
  ReportUsageResponse,
  GetAccountFinancialsRequest,
  GetAccountFinancialsSuccess,
} from '../../types/tools.generated';
import type { CursorPage, CursorRequest } from './pagination';

/**
 * Account — framework's rich representation. A strict superset of the wire
 * `Account` shape (from `list_accounts` / response envelopes):
 *
 *   - Adds `metadata: TMeta` (platform-internal fields the framework doesn't
 *     read but adopters use to thread platform-specific data)
 *   - Adds `authInfo: AuthPrincipal` (auth context for the request — MUST NOT
 *     leak to the wire)
 *   - All wire-required fields (`id`/`account_id`, `name`, `status`) are
 *     required here too.
 *
 * Framework projects to wire shape via `toWireAccount`: strips `metadata` +
 * `authInfo`, renames `id` → `account_id`. ~10 lines, no `as never` casts.
 */
export interface Account<TMeta = Record<string, unknown>> {
  /** Your platform's account_id. Maps to wire `Account.account_id`. */
  id: string;

  /** Human-readable account name (e.g., 'Acme', 'Acme c/o Pinnacle'). Required on the wire. */
  name: string;

  /** Account status. Maps to wire `Account.status`. */
  status: AdcpAccountStatus;

  /** Canonical brand reference. Either id OR (brand+operator) identifies the account. */
  brand?: BrandReference;

  /** Operator domain (agency / managed-services). Pairs with `brand`. */
  operator?: string;

  /**
   * The advertiser whose rates apply to this account. Maps to wire
   * `Account.advertiser`. Use when the account is operated by an agency on
   * behalf of an advertiser whose rates differ from the operator's.
   */
  advertiser?: string;

  /**
   * Settlement boundary for operator-billed retail-media platforms.
   * `'agent'` = pass-through (buyer's agent settles directly with the platform).
   * `'operator'` = retail-media model (operator pays publisher, bills brand).
   * `BrandReference` = invoice routes to a third party (Amazon DSP returning
   * a different invoice principal than the requester is the canonical case).
   *
   * Optional — most platforms don't need this; comply storyboards use it to
   * assert the right party is billed.
   */
  billing?: { invoicedTo: 'agent' | 'operator' | BrandReference };

  /**
   * Adapter-internal opaque state. Framework doesn't read this; **stripped
   * before emitting on the wire**. GAM puts `{ networkId, advertiserId }`;
   * Spotify puts `{ brandId, businessId }`; Criteo puts `{ customerId }`.
   * Each platform's choice.
   *
   * Same field name (`ctx_metadata`) used across every DecisioningPlatform
   * resource (Product, MediaBuy, Package, Creative, Audience, Signal,
   * Account) for naming consistency. Account is special operationally:
   * `accounts.resolve()` is called per-request, so the publisher is the
   * canonical source of truth and the SDK does NOT round-trip Account
   * `ctx_metadata` through the cache (unlike Product / MediaBuy / etc.,
   * where the SDK bridges between `getProducts` and `createMediaBuy`).
   * Put adapter state in `ctx_metadata`; treat it as fresh from your
   * `accounts.resolve()` on every request.
   */
  ctx_metadata: TMeta;

  /** Caller's authenticated principal. **Stripped before emitting on the wire.** */
  authInfo: AuthPrincipal;
}

/**
 * Request context passed to `AccountStore.resolve()` so adopters fronting
 * an upstream platform API can translate the auth principal into their
 * tenant model on resolution. Mirrors `ResolveAccountContext` on the
 * underlying `AdcpServerConfig`.
 *
 * `authInfo` is the OAuth-style token shape the framework extracts from
 * `serve({ authenticate })` — it's the FRAMEWORK auth shape, not the v6
 * `AuthPrincipal` (which is what the platform sets on the RESOLVED
 * `Account.authInfo`). The transition is intentional: the framework hands
 * the resolver the raw transport-level auth, and the resolver decides
 * what to persist on the Account as `AuthPrincipal`.
 *
 * @public
 */
/**
 * The OAuth-style auth shape extracted by `serve({ authenticate })`. Threaded
 * to `accounts.resolve(ref, ctx)` and to the `tasks_get` custom-tool handler
 * so adopters can authorize the resolution against the principal.
 *
 * Distinct from {@link AuthPrincipal} — `ResolvedAuthInfo` is the RAW
 * transport-level auth the framework hands to the resolver; `AuthPrincipal`
 * is what the resolver chooses to persist on the resolved `Account`. The
 * resolver decides what to keep / drop / re-shape.
 *
 * @public
 */
export interface ResolvedAuthInfo {
  token: string;
  clientId: string;
  scopes: string[];
  expiresAt?: number;
  extra?: Record<string, unknown>;
}

export interface ResolveContext {
  /** Authenticated principal extracted by `serve({ authenticate })`. Undefined when no `authenticate` is configured. */
  authInfo?: ResolvedAuthInfo;
  /** Tool the buyer is calling — useful for tool-aware tenant routing. */
  toolName?: string;
}

export interface AuthPrincipal {
  /** Stable identifier for the calling agent (e.g., `https://buyer.example.com/mcp`). */
  agent_url?: string;
  /** Token kind: API key, OAuth bearer, signed-request claim. */
  kind: 'api_key' | 'oauth' | 'signature' | 'public';
  /** Bearer token / API key value. Platform-side don't log this. */
  token?: string;
  /** OAuth scopes / API-key principal name. */
  principal?: string;
  /** Additional claims (jwt sub, kid, etc.). */
  claims?: Record<string, unknown>;
}

export interface AccountStore<TMeta = Record<string, unknown>> {
  /**
   * How buyers reference accounts on this platform.
   * - `'explicit'` — buyer passes `account_id` inline on every request (Snap,
   *   Meta, GAM via Network/Company id). The default.
   * - `'implicit'` — buyer must `sync_accounts` first; subsequent requests are
   *   resolved from the auth principal's pre-synced linkage (LinkedIn, some
   *   retail-media operators). Framework refuses inline `account_id` references
   *   for these platforms.
   * - `'derived'` — single-tenant agents where there is no account_id on the
   *   wire at all and the auth principal alone identifies the tenant. Most
   *   self-hosted broadcasters and retail-media operators in proxy mode.
   *
   * Defaults to `'explicit'` when omitted.
   */
  readonly resolution?: 'explicit' | 'implicit' | 'derived';

  /**
   * Resolve buyer's AccountReference into the platform's tenant model.
   *
   * `ref` is `undefined` when the wire request didn't carry an account
   * field — `provide_performance_feedback` and `list_creative_formats` are
   * the canonical examples. Per `resolution` mode:
   * - `'derived'` (single-tenant): return the singleton account regardless.
   * - `'implicit'`: look up the account from the auth principal.
   * - `'explicit'` (default): no account is available; either throw
   *   `AccountNotFoundError` to signal "tool requires account" OR return
   *   a synthetic singleton if the tool legitimately doesn't need
   *   tenant scoping (e.g., publisher-wide format catalog from
   *   `list_creative_formats`).
   *
   * `ctx.authInfo` is the caller's authenticated principal (when
   * `serve({ authenticate })` is wired). Adapters fronting an upstream
   * platform API (Snap, Meta, retail-media) translate auth to tenant ID:
   *
   * ```ts
   * resolve: async (ref, ctx) => {
   *   if (ref?.account_id) return await this.db.findById(ref.account_id);
   *   const platformAcct = await myUpstream.findByOAuthClient(ctx?.authInfo?.clientId);
   *   return platformAcct ? this.toAccount(platformAcct) : null;
   * }
   * ```
   *
   * Two failure shapes:
   * - **Unknown / cross-tenant reference**: return `null` (canonical) — OR
   *   throw `AccountNotFoundError` if your codebase already throws a
   *   not-found exception class. Framework emits the spec's fixed
   *   `ACCOUNT_NOT_FOUND` envelope either way. The buyer learns no detail
   *   beyond "not found" — guarding against principal-enumeration.
   * - **Transient upstream failure** (DB outage, identity-provider 5xx):
   *   throw a generic exception. Framework maps to `SERVICE_UNAVAILABLE`
   *   so the buyer can retry.
   */
  resolve(ref: AccountReference | undefined, ctx?: ResolveContext): Promise<Account<TMeta> | null>;

  /**
   * sync_accounts API surface. Framework normalizes the wire request; platform
   * upserts and returns per-account result rows. `throw new AdcpError(...)`
   * for buyer-facing rejection.
   *
   * **Optional.** Stateless platforms (creative-template, signal-marketplace
   * proxies) that don't manage account lifecycle can omit this; framework
   * surfaces `UNSUPPORTED_FEATURE` to buyers calling `sync_accounts`.
   */
  upsert?(refs: AccountReference[]): Promise<SyncAccountsResultRow[]>;

  /**
   * list_accounts API surface. Framework wraps with cursor envelope.
   *
   * **Optional.** Same rationale as `upsert` — stateless platforms can omit.
   */
  list?(filter: AccountFilter & CursorRequest): Promise<CursorPage<Account<TMeta>>>;

  /**
   * report_usage API surface. Operator-billed platforms accept usage rows
   * (often impressions / spend by media_buy + period) for billing
   * reconciliation. Optional — adopters that don't run billing through the
   * agent leave this unimplemented and the framework returns
   * UNSUPPORTED_FEATURE.
   *
   * Idempotent on `(account, period_start, period_end, line_item_id)` —
   * platform must dedupe replays under the framework's idempotency key.
   *
   * `ctx.authInfo` carries the caller's OAuth principal (when
   * `serve({ authenticate })` is wired). Platforms fronting an upstream
   * billing API (Snap, Meta, retail-media) use it to authorize the usage
   * post against the principal's tenant — same pattern as `accounts.resolve`.
   */
  reportUsage?(req: ReportUsageRequest, ctx?: ResolveContext): Promise<ReportUsageResponse>;

  /**
   * get_account_financials API surface. Operator-billed platforms expose
   * spend / credit / payment status per the wire shape. Optional — agent-
   * billed platforms (where the buyer settles directly with the publisher)
   * leave this unimplemented.
   *
   * Read tool — no idempotency requirement. Throw `AdcpError` for buyer-
   * fixable rejection (`'PERMISSION_DENIED'` if the principal can't see
   * financials for the requested account).
   *
   * `ctx.authInfo` carries the caller's OAuth principal (when
   * `serve({ authenticate })` is wired). Platforms that guard financials
   * per-principal use it to authorize the read — same pattern as
   * `accounts.resolve`.
   */
  getAccountFinancials?(req: GetAccountFinancialsRequest, ctx?: ResolveContext): Promise<GetAccountFinancialsSuccess>;
}

/**
 * Optional throw-class for `AccountStore.resolve` not-found signaling. Returning
 * `null` from `resolve` is canonical and equivalent; throw this only if your
 * codebase already throws a typed not-found exception elsewhere.
 *
 * **Throwable only from `AccountStore.resolve()`.** Throwing it from a
 * specialism method (`createMediaBuy`, `getProducts`, etc.) bypasses the
 * framework's not-found mapping and surfaces as `SERVICE_UNAVAILABLE`.
 *
 * The constructor's `message` is for server-side operator diagnostics only.
 * The framework emits a fixed `ACCOUNT_NOT_FOUND` envelope regardless; the
 * message never reaches the buyer. Operator-side log pipelines may aggregate
 * this string, so MUST NOT include caller-supplied identifiers (echoed account
 * refs, request args) — those leak across operator / buyer trust boundaries.
 *
 * Use ONLY for the narrow not-found case. Upstream-API outages, misconfigured
 * env vars, and schema-validation failures should propagate as generic
 * exceptions and surface to the buyer as `SERVICE_UNAVAILABLE`.
 */
export class AccountNotFoundError extends Error {
  readonly name = 'AccountNotFoundError' as const;
  constructor(message = 'Account not found') {
    super(message);
  }
}

export interface AccountFilter {
  /** Filter by brand domain across all operators. */
  brand_domain?: string;
  /** Filter by operator across all brands. */
  operator?: string;
  /** Filter by status. */
  status?: AdcpAccountStatus[];
}

export interface SyncAccountsResultRow {
  account_id?: string;
  brand: BrandReference;
  operator: string;
  action: 'created' | 'updated' | 'unchanged' | 'failed';
  status: AdcpAccountStatus;
  errors?: { code: string; message: string }[];
}

export type AdcpAccountStatus =
  | 'active'
  | 'pending_approval'
  | 'rejected'
  | 'payment_required'
  | 'suspended'
  | 'closed';

// ---------------------------------------------------------------------------
// Wire projection — strip framework-internal fields before emit
// ---------------------------------------------------------------------------

import type { Account as WireAccount } from '../../types/tools.generated';

/**
 * Project a framework `Account<TMeta>` to the wire `Account` shape.
 *
 * Strips `metadata` and `authInfo` (framework-internal); renames `id` →
 * `account_id`; passes through `name`, `status`, `brand`, `operator`,
 * `advertiser`, and `billing.invoicedTo` mappings.
 *
 * Used by the framework when emitting `list_accounts` and other wire
 * responses that include account data. Adopters never call this directly —
 * they return `Account<TMeta>` from `accounts.resolve` / `accounts.list`
 * and the framework projects.
 */
export function toWireAccount<TMeta>(account: Account<TMeta>): WireAccount {
  const wire: WireAccount = {
    account_id: account.id,
    name: account.name,
    status: account.status,
  };
  if (account.brand !== undefined) wire.brand = account.brand;
  if (account.operator !== undefined) wire.operator = account.operator;
  if (account.advertiser !== undefined) wire.advertiser = account.advertiser;
  if (account.billing !== undefined) {
    // Wire `Account.billing: 'operator' | 'agent' | 'advertiser'` is the
    // invoiced-to party. Internal `billing.invoicedTo` collapses string +
    // BrandReference; a BrandReference indicates a third-party advertiser
    // (Amazon DSP-shaped flow), which projects to `'advertiser'`.
    const t = account.billing.invoicedTo;
    wire.billing = typeof t === 'string' ? t : 'advertiser';
  }
  return wire;
}

// ---------------------------------------------------------------------------
// AccountReference helpers
// ---------------------------------------------------------------------------

/**
 * Extract `account_id` from an `AccountReference` discriminated union without
 * casting. Returns `undefined` when `ref` is absent or the union arm doesn't
 * carry an `account_id` (e.g., `{ brand, operator }` or sandbox variants).
 *
 * Typical use in `accounts.resolve` implementations:
 *
 * ```ts
 * resolve: async (ref, ctx) => {
 *   const id = refAccountId(ref);
 *   if (id) return this.db.findById(id);
 *   return this.db.findByOAuthClient(ctx?.authInfo?.clientId ?? '');
 * }
 * ```
 *
 * @public
 */
export function refAccountId(ref?: AccountReference): string | undefined {
  return ref && 'account_id' in ref ? (ref as { account_id?: string }).account_id : undefined;
}
