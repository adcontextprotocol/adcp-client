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

import type { BrandReference, AccountReference } from '../../types/tools.generated';
import type { CursorPage, CursorRequest } from './pagination';
import type { AsyncOutcome } from './async-outcome';

export interface Account<TMeta = Record<string, unknown>> {
  /** Your platform's account_id. Matches AdCP's `AccountReference.account_id`. */
  id: string;

  /** Canonical brand reference. Either id OR (brand+operator) identifies the account. */
  brand?: BrandReference;

  /** Operator domain (agency / managed-services). Pairs with `brand`. */
  operator?: string;

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
   * Platform-specific extension. Framework doesn't read this. GAM puts
   * `{ networkId, advertiserId }`; Spotify puts `{ brandId, businessId }`;
   * Criteo puts `{ customerId }`. Each platform's choice.
   */
  metadata: TMeta;

  /** Caller's authenticated principal. */
  authInfo: AuthPrincipal;
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
  resolve(ref: AccountReference): Promise<Account<TMeta> | null>;

  /**
   * sync_accounts API surface. Framework normalizes the wire request; platform
   * upserts and returns per-account result rows. Async-eligible: account
   * provisioning may require human approval workflows.
   */
  upsert(refs: AccountReference[]): Promise<AsyncOutcome<SyncAccountsResultRow[]>>;

  /**
   * list_accounts API surface. Framework wraps with cursor envelope.
   */
  list(filter: AccountFilter & CursorRequest): Promise<CursorPage<Account<TMeta>>>;
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
