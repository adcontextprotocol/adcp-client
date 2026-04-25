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
   * Resolve buyer's AccountReference into the platform's tenant model.
   * Returns null for unknown / cross-tenant references — framework responds
   * `ACCOUNT_NOT_FOUND`. Platform-side enforce tenant isolation here.
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
