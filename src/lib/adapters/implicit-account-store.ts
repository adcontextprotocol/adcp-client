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
 * **Picking an AccountStore?** Three reference shapes by *who creates the
 * account*:
 * - **Buyer self-onboards via `sync_accounts`** → `InMemoryImplicitAccountStore`
 *   (this file, Shape A).
 * - **Upstream OAuth API owns the roster** → `createOAuthPassthroughResolver`
 *   (Shape B, returns just `resolve`).
 * - **Publisher ops curates the roster** → `createRosterAccountStore`
 *   (Shape C, complete AccountStore).
 * - **Stateless single-tenant** → `createDerivedAccountStore`
 *   (Shape D, `resolution: 'derived'`). No roster, no `account_id`. Auth
 *   principal IS the account.
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

// Natural key for a ref — used to detect re-syncs of the same
// (brand, operator, sandbox) tuple so upsert() can return 'unchanged'
// without calling buildAccount again (which may be non-deterministic).
function refNaturalKey(ref: AccountReference): string {
  const r = ref as Record<string, unknown>;
  const domain = (r['brand'] as Record<string, unknown> | undefined)?.['domain'] as string | undefined;
  const operator = r['operator'] as string | undefined;
  const sandbox = Boolean(r['sandbox'] as boolean | undefined);
  return `${domain ?? ''}|${operator ?? ''}|${sandbox ? '1' : '0'}`;
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
  const sandbox = r['sandbox'] === true;
  const sandboxSuffix = sandbox ? ':sandbox' : '';
  const account_id =
    (r['account_id'] as string | undefined) ??
    (brand && 'domain' in brand
      ? `${(brand as { domain: string }).domain}:${operator}${sandboxSuffix}`
      : `ref:${operator}${sandboxSuffix}`);
  return {
    id: account_id,
    name: account_id,
    status: 'active' as AdcpAccountStatus,
    ...(brand !== undefined && { brand }),
    ...(operator !== '' && { operator }),
    ...(sandbox && { sandbox: true }),
    ctx_metadata: {} as TCtxMeta & Record<string, unknown>,
  };
}

// ---------------------------------------------------------------------------
// InMemoryImplicitAccountStore
// ---------------------------------------------------------------------------

interface StoredEntry<TCtxMeta> {
  accounts: Account<TCtxMeta>[];
  refs: AccountReference[];
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
   *
   * **Multi-account note.** When a buyer synced multiple refs in one
   * `sync_accounts` call, this implementation returns the _first_ stored
   * account. If your platform requires per-request account disambiguation
   * (e.g., different brands on the same buyer), switch to `'explicit'` mode
   * so buyers pass `ext.account_ref` on each request, or override `keyFn`
   * to encode the brand into the key.
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
   * The auth key is extracted from `ctx.authInfo` via `keyFn`. When the
   * key cannot be derived (no credential or unrecognized credential kind),
   * all refs are returned as `SYNC_FAILED` rows — a silent-success-then-
   * mystery-failure sequence is worse than an explicit error. Check your
   * `authenticate` callback and `keyFn` if you see this error.
   *
   * When `ctx.authInfo` is absent (unauthenticated call), all refs fail
   * with `UNAUTHENTICATED`. Your `authenticate` callback in
   * `serve({ authenticate })` should reject unauthenticated requests before
   * reaching this method.
   */
  async upsert(refs: AccountReference[], ctx?: ResolveContext): Promise<SyncAccountsResultRow[]> {
    const authInfo = ctx?.authInfo;

    // Derive the key before building any accounts. If the key cannot be
    // extracted, fail all rows explicitly — returning success rows here
    // would cause a mysterious ACCOUNT_NOT_FOUND on the next tool call.
    const key = authInfo !== undefined ? this._keyFn(authInfo) : undefined;
    if (key === undefined) {
      return refs.map(ref => {
        const r = ref as Record<string, unknown>;
        return {
          brand: (r['brand'] as BrandReference | undefined) ?? ({ domain: 'unknown' } as BrandReference),
          operator: (r['operator'] as string | undefined) ?? '',
          action: 'failed' as const,
          status: 'rejected' as AdcpAccountStatus,
          errors: [
            {
              code: 'SYNC_FAILED',
              message:
                authInfo === undefined
                  ? 'Unauthenticated: no authInfo on ctx — check authenticate configuration'
                  : 'Could not derive principal key from auth credential — check keyFn or credential kind',
            },
          ],
        };
      });
    }

    // Build a natural-key index from any existing stored entry so we can
    // detect re-syncs of the same (brand, operator, sandbox) tuple.
    const existing = this._store.get(key);
    const existingByNk = new Map<string, { account: Account<TCtxMeta>; ref: AccountReference }>();
    if (existing) {
      for (let i = 0; i < existing.refs.length; i++) {
        existingByNk.set(refNaturalKey(existing.refs[i]!), {
          account: existing.accounts[i]!,
          ref: existing.refs[i]!,
        });
      }
    }

    const newAccounts: Account<TCtxMeta>[] = [];
    const newRefs: AccountReference[] = [];
    const rows: SyncAccountsResultRow[] = [];

    for (const ref of refs) {
      const nk = refNaturalKey(ref);
      const hit = existingByNk.get(nk);
      if (hit) {
        // Re-sync of the same (brand, operator, sandbox) — preserve the
        // original account_id without calling buildAccount again so adopters
        // with non-deterministic resolvers (upstream API calls, DB writes)
        // don't accumulate duplicate ids on replay.
        newAccounts.push(hit.account);
        newRefs.push(hit.ref);
        const r = ref as Record<string, unknown>;
        const brand: BrandReference =
          hit.account.brand ??
          (r['brand'] as BrandReference | undefined) ??
          ({ domain: hit.account.id } as BrandReference);
        const operator = hit.account.operator ?? (r['operator'] as string | undefined) ?? '';
        rows.push({
          account_id: hit.account.id,
          brand,
          operator,
          name: hit.account.name,
          action: 'unchanged',
          status: hit.account.status,
        });
        continue;
      }

      try {
        const account = await this._buildAccount(ref, ctx);
        newAccounts.push(account);
        newRefs.push(ref);
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
        // Suppress adopter-originated error details from the wire response —
        // buildAccount exceptions may include upstream credentials, SQL text,
        // or internal identifiers. Log server-side; emit a fixed string.
        console.error('[InMemoryImplicitAccountStore] buildAccount threw:', err);
        const r = ref as Record<string, unknown>;
        rows.push({
          brand: (r['brand'] as BrandReference | undefined) ?? ({ domain: 'unknown' } as BrandReference),
          operator: (r['operator'] as string | undefined) ?? '',
          action: 'failed',
          status: 'rejected' as AdcpAccountStatus,
          errors: [{ code: 'SYNC_FAILED', message: 'Account sync failed — check server logs' }],
        });
      }
    }

    // Only update the stored entry when at least one ref resolved successfully
    // (either 'unchanged' or 'created'). An all-fail batch leaves the prior
    // sync linkage intact so the buyer can retry without losing their mapping.
    if (newAccounts.length > 0) {
      this._store.set(key, { accounts: newAccounts, refs: newRefs, storedAt: Date.now() });
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
