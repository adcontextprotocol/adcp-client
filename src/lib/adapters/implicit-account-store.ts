/**
 * InMemoryImplicitAccountStore
 *
 * Reference implementation of `AccountStore` for `resolution: 'implicit'`
 * platforms. Platforms using this resolution mode require buyers to call
 * `sync_accounts` before any tool that needs tenant context; subsequent
 * requests resolve the account from the caller's auth principal rather
 * than from an inline `ext.account_ref`.
 *
 * Use this in tests and as a copy-and-adapt starting point for durable
 * implementations. See `docs/guides/account-resolution.md` for key
 * derivation guidance, error contracts, and TTL recommendations.
 *
 * @see docs/guides/account-resolution.md
 * @public
 */

import type { AccountReference, BrandReference } from '../types/tools.generated';
import type {
  Account,
  AccountStore,
  AdcpAccountStatus,
  ResolvedAuthInfo,
  ResolveContext,
  SyncAccountsResultRow,
} from '../server/decisioning';

// ---------------------------------------------------------------------------
// Key extraction
// ---------------------------------------------------------------------------

/**
 * Default key-extraction function for the auth-principal→account mapping.
 *
 * Canonical choices by credential kind:
 * - `'oauth'`   → `oauth:<client_id>`   (OAuth 2.0 client identity; stable across token rotations)
 * - `'api_key'` → `api_key:<key_id>`   (API-key identity; stable until key is revoked)
 * - `'http_sig'`→ `http_sig:<agent_url>` (verified caller URL; the most durable identity)
 *
 * Adopters who key on `authInfo.sub` or `authInfo.extra` instead MUST
 * document that choice — those fields are grant-specific and may not be
 * stable across credential rotations.
 */
export function defaultImplicitKeyFn(authInfo: ResolvedAuthInfo): string | undefined {
  const cred = authInfo.credential;
  if (!cred) return undefined;
  switch (cred.kind) {
    case 'oauth':
      return `oauth:${cred.client_id}`;
    case 'api_key':
      return `api_key:${cred.key_id}`;
    case 'http_sig':
      return `http_sig:${cred.agent_url}`;
  }
}

// ---------------------------------------------------------------------------
// Store interface
// ---------------------------------------------------------------------------

/**
 * Constructor options for `InMemoryImplicitAccountStore`.
 * @public
 */
export interface ImplicitAccountStoreOptions<TCtxMeta = Record<string, unknown>> {
  /**
   * Convert a buyer-supplied `AccountReference` (from `sync_accounts`) to the
   * seller's `Account<TCtxMeta>`. Called once per ref in `upsert()`.
   *
   * **Default:** builds a synthetic account from the ref fields. Suitable
   * for tests; replace for production (call your platform's account-lookup
   * or account-creation API here).
   */
  buildAccount?: (ref: AccountReference, ctx?: ResolveContext) => Account<TCtxMeta> | Promise<Account<TCtxMeta>>;

  /**
   * Extract the principal key from `ResolvedAuthInfo`. The returned string
   * is the lookup key for the `authInfo → accounts` mapping.
   *
   * **Default:** `defaultImplicitKeyFn` — uses `credential.client_id`
   * (oauth), `credential.key_id` (api_key), or `credential.agent_url`
   * (http_sig). Stable across token rotations within the same credential
   * kind.
   *
   * Override when your platform keys on a custom claim (e.g., a
   * `sub`-derived tenant ID in `authInfo.extra`).
   */
  keyFn?: (authInfo: ResolvedAuthInfo) => string | undefined;

  /**
   * Sync-linkage TTL in milliseconds. Entries stored by `upsert()` expire
   * after this duration; `resolve()` returns `null` (→ `ACCOUNT_NOT_FOUND`)
   * for expired entries, prompting the buyer to call `sync_accounts` again.
   *
   * **Default:** `86_400_000` (24 hours). Align with your platform's session
   * or token lifetime; longer TTLs risk serving stale account state.
   *
   * Distinct from `AccountStore.refreshToken` — that refreshes the upstream
   * OAuth token mid-request. This TTL governs how long the sync-linkage
   * itself is valid before a fresh `sync_accounts` is required.
   */
  ttlMs?: number;
}

// ---------------------------------------------------------------------------
// Default buildAccount
// ---------------------------------------------------------------------------

function defaultBuildAccount<TCtxMeta>(
  ref: AccountReference,
  _ctx?: ResolveContext
): Account<TCtxMeta & Record<string, unknown>> {
  const r = ref as Record<string, unknown>;
  const brand = r['brand'] as BrandReference | undefined;
  const operator = (r['operator'] as string | undefined) ?? '';
  const account_id =
    (r['account_id'] as string | undefined) ??
    (brand && 'domain' in brand ? `${(brand as { domain: string }).domain}:${operator}` : `ref:${operator}`);
  return {
    id: account_id,
    name: account_id,
    status: 'active' as AdcpAccountStatus,
    ...(brand !== undefined && { brand }),
    ...(operator !== '' && { operator }),
    ctx_metadata: {} as TCtxMeta & Record<string, unknown>,
  };
}

// ---------------------------------------------------------------------------
// InMemoryImplicitAccountStore
// ---------------------------------------------------------------------------

interface StoredEntry<TCtxMeta> {
  accounts: Account<TCtxMeta>[];
  storedAt: number;
}

/**
 * In-memory `AccountStore` for `resolution: 'implicit'` platforms.
 *
 * Wire contract:
 * 1. Buyer calls `sync_accounts` → framework calls `upsert()` → store records
 *    `authKey → accounts[]`.
 * 2. Buyer calls any tool (e.g. `create_media_buy`) without `ext.account_ref`
 *    → framework calls `resolve(undefined, ctx)` → store looks up by `authKey`.
 * 3. If no prior sync: `resolve()` returns `null` → framework emits
 *    `ACCOUNT_NOT_FOUND`. Do NOT return `AUTH_REQUIRED` — that signals
 *    missing credentials, not a missing pre-sync.
 *
 * This class is intentionally minimal. Copy-and-adapt for durable stores
 * (Postgres, Redis); see `docs/guides/account-resolution.md` for the DDL
 * reference and the key-derivation rationale.
 *
 * @example
 * ```ts
 * import { InMemoryImplicitAccountStore } from '@adcp/sdk/server';
 *
 * const accountStore = new InMemoryImplicitAccountStore({
 *   buildAccount: async (ref, ctx) => {
 *     const upstream = await myPlatform.findOrCreate(ref, ctx?.authInfo);
 *     return {
 *       id: upstream.id,
 *       name: upstream.name,
 *       status: 'active',
 *       ctx_metadata: { upstreamId: upstream.id },
 *     };
 *   },
 * });
 *
 * // Wire into createAdcpServer:
 * createAdcpServer({ accounts: accountStore, ... });
 * ```
 *
 * @public
 */
export class InMemoryImplicitAccountStore<TCtxMeta = Record<string, unknown>> implements AccountStore<TCtxMeta> {
  readonly resolution = 'implicit' as const;

  private _store = new Map<string, StoredEntry<TCtxMeta>>();
  private _keyFn: (authInfo: ResolvedAuthInfo) => string | undefined;
  private _ttlMs: number;
  private _buildAccount: (
    ref: AccountReference,
    ctx?: ResolveContext
  ) => Account<TCtxMeta> | Promise<Account<TCtxMeta>>;

  constructor(options?: ImplicitAccountStoreOptions<TCtxMeta>) {
    this._buildAccount =
      options?.buildAccount ??
      (defaultBuildAccount as unknown as (ref: AccountReference, ctx?: ResolveContext) => Account<TCtxMeta>);
    this._keyFn = options?.keyFn ?? defaultImplicitKeyFn;
    this._ttlMs = options?.ttlMs ?? 86_400_000;
  }

  /**
   * Resolve the caller's account from the auth-principal→account mapping
   * populated by a prior `sync_accounts` call.
   *
   * Returns `null` (→ `ACCOUNT_NOT_FOUND`) when:
   * - No prior `sync_accounts` was called for this principal
   * - The stored entry has exceeded `ttlMs`
   * - `ctx.authInfo` is absent or carries no extractable key
   */
  async resolve(_ref: AccountReference | undefined, ctx?: ResolveContext): Promise<Account<TCtxMeta> | null> {
    const authInfo = ctx?.authInfo;
    if (!authInfo) return null;
    const key = this._keyFn(authInfo);
    if (key === undefined) return null;
    const entry = this._store.get(key);
    if (!entry) return null;
    if (Date.now() - entry.storedAt > this._ttlMs) {
      this._store.delete(key);
      return null;
    }
    return entry.accounts[0] ?? null;
  }

  /**
   * Process a `sync_accounts` payload: build accounts from refs and store
   * them under the caller's auth key.
   *
   * The auth key is extracted from `ctx.authInfo` via `keyFn`. When
   * `ctx.authInfo` is absent (e.g., unauthenticated call), accounts are
   * built but NOT stored — the buyer cannot retrieve them via `resolve()`.
   * Your `authenticate` callback in `serve({ authenticate })` should reject
   * unauthenticated `sync_accounts` calls before reaching this method.
   */
  async upsert(refs: AccountReference[], ctx?: ResolveContext): Promise<SyncAccountsResultRow[]> {
    const authInfo = ctx?.authInfo;
    const key = authInfo !== undefined ? this._keyFn(authInfo) : undefined;
    const accounts: Account<TCtxMeta>[] = [];
    const rows: SyncAccountsResultRow[] = [];

    for (const ref of refs) {
      try {
        const account = await this._buildAccount(ref, ctx);
        accounts.push(account);
        const r = ref as Record<string, unknown>;
        const brand: BrandReference =
          account.brand ?? (r['brand'] as BrandReference | undefined) ?? ({ domain: account.id } as BrandReference);
        const operator = account.operator ?? (r['operator'] as string | undefined) ?? '';
        rows.push({
          account_id: account.id,
          brand,
          operator,
          name: account.name,
          action: 'created',
          status: account.status,
        });
      } catch (err) {
        const r = ref as Record<string, unknown>;
        rows.push({
          brand: (r['brand'] as BrandReference | undefined) ?? ({ domain: 'unknown' } as BrandReference),
          operator: (r['operator'] as string | undefined) ?? '',
          action: 'failed',
          status: 'rejected' as AdcpAccountStatus,
          errors: [
            {
              code: 'SYNC_FAILED',
              message: err instanceof Error ? err.message : String(err),
            },
          ],
        });
      }
    }

    if (key !== undefined) {
      this._store.set(key, { accounts, storedAt: Date.now() });
    }

    return rows;
  }

  // ---------------------------------------------------------------------------
  // Test helpers
  // ---------------------------------------------------------------------------

  /** Remove all stored sync linkages. */
  clear(): void {
    this._store.clear();
  }

  /**
   * Return the auth key that would be derived from `authInfo`.
   * Useful in tests to assert that a specific principal's linkage was stored.
   */
  authKey(authInfo: ResolvedAuthInfo): string | undefined {
    return this._keyFn(authInfo);
  }

  /** Return the number of principal → accounts linkages currently stored. */
  get size(): number {
    return this._store.size;
  }
}
