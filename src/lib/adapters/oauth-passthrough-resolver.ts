/**
 * OAuth pass-through `accounts.resolve` factory. Standardizes the canonical
 * "Shape B" account-resolution pattern: an adapter wraps a vendor OAuth +
 * ad-account API (Snap, Meta, TikTok, LinkedIn, Reddit, Pinterest, etc.) and
 * resolves the buyer's `AccountReference` by hitting the upstream's
 * "list-my-accounts" endpoint with the buyer's bearer.
 *
 * Without this factory, every Shape B adapter rolls the same ~30 LOC:
 * extract bearer from `ctx.authInfo`, GET `/me/adaccounts`, match by id,
 * return tenant with `ctx_metadata` populated. This factory handles the
 * boilerplate; the adapter supplies the upstream specifics
 * (`listEndpoint`, `toAccount` mapper) and the auth shape via
 * {@link createUpstreamHttpClient}'s `dynamic_bearer.getToken`.
 *
 * Closes adcp-client#1363.
 *
 * **Picking an AccountStore?** Three reference shapes by *who creates the
 * account*:
 * - **Buyer self-onboards via `sync_accounts`** → `InMemoryImplicitAccountStore`
 *   (Shape A).
 * - **Upstream OAuth API owns the roster** → `createOAuthPassthroughResolver`
 *   (this file, Shape B, returns just `resolve`).
 * - **Publisher ops curates the roster** → `createRosterAccountStore`
 *   (Shape C, complete AccountStore).
 * - **Stateless single-tenant** → `createDerivedAccountStore`
 *   (Shape D, `resolution: 'derived'`). No roster, no `account_id`. Auth
 *   principal IS the account.
 *
 * @public
 */

import { createHash } from 'node:crypto';
import type { Account, ResolveContext } from '../server/decisioning/account';
import { refAccountId } from '../server/decisioning/account';
import type { AccountReference } from '../types/tools.generated';
import type { AuthContext, UpstreamHttpClient } from '../server/upstream-helpers';

/**
 * Options for {@link createOAuthPassthroughResolver}.
 *
 * @public
 */
export interface OAuthPassthroughResolverOptions<TUpstreamRow, TCtxMeta = Record<string, unknown>> {
  /**
   * Pre-configured upstream HTTP client (typically from
   * {@link createUpstreamHttpClient}). Should be configured with
   * `auth: { kind: 'dynamic_bearer', getToken: (ctx) => ... }` so the
   * factory's `getAuthContext` output flows through to bearer selection.
   */
  httpClient: UpstreamHttpClient;

  /**
   * Path on the upstream API that returns the buyer's accounts. Common
   * shapes: `/v1/adaccounts`, `/me/adaccounts`, `/customers`.
   */
  listEndpoint: string;

  /**
   * Property on each upstream row matching the wire `AccountReference.account_id`.
   * Defaults to `'id'`.
   *
   * **Footgun:** when the generic `TUpstreamRow` is inferred (no explicit
   * type argument), `keyof TUpstreamRow & string` collapses to `string` and
   * a typo in `idField` compiles fine but silently always returns `null`.
   * Pass an explicit `TUpstreamRow` (or a dummy interface with the upstream's
   * field names) to get compile-time field validation.
   */
  idField?: keyof TUpstreamRow & string;

  /**
   * Property on the upstream response body that contains the array of rows.
   * Defaults to `'data'` (Snap, Meta envelope shape). Set to `null` when the
   * response body itself is the array (some flat-list APIs).
   *
   * Single-segment only. APIs with deeper nesting (TikTok's `data.list`,
   * for example) need a custom response transform — wrap the upstream client
   * with a fetch override that flattens, or use this factory only for the
   * 70%-fit upstream shape and write a hand-rolled resolver for the rest.
   * Google Ads' `customers:listAccessibleCustomers` returns string resource
   * names (not row objects) and is not a fit for this factory.
   */
  rowsPath?: string | null;

  /**
   * Extract the auth context to forward to the upstream's
   * `dynamic_bearer.getToken(ctx)` resolver. The return value flows through
   * as the `authContext` per-call option on `httpClient.get`.
   *
   * Defaults to forwarding `ctx?.authInfo` verbatim — works when the http
   * client's `getToken` resolver reads `ctx.authInfo.token` /
   * `ctx.authInfo.credential.token`.
   */
  getAuthContext?: (ctx: ResolveContext | undefined) => AuthContext | undefined;

  /**
   * Map an upstream row to a framework `Account<TCtxMeta>`. Adapters
   * typically embed the raw row (or distilled fields) in `ctx_metadata` so
   * downstream specialism methods can read upstream IDs, tokens, etc.
   * without re-resolving.
   *
   * **Treat `ctx_metadata.accessToken` (or any embedded credential) as a
   * secret.** The framework strips `ctx_metadata` from the wire response,
   * but adopter code that throws an error containing `JSON.stringify(account)`
   * or logs `ctx.account` at info level WILL leak the token. Either don't
   * embed the bearer (re-derive from `ctx.authInfo` on each downstream
   * method), or audit your error projections.
   */
  toAccount: (row: TUpstreamRow, ctx: ResolveContext | undefined) => Account<TCtxMeta>;

  /**
   * Optional in-memory listing cache. Caches the full row array per buyer
   * (keyed on the auth context); resolves `account_id` matches in-memory
   * within the TTL window. One upstream hit per buyer per TTL period
   * regardless of how many account_ids that buyer queries.
   *
   * Set `ttlMs` to enable (default: no cache, every resolve hits upstream).
   *
   * **TTL guidance:**
   * - **Read tools** (`get_products`, `list_creative_formats`): 60–300s.
   *   Buyer-side latency dominates; longer TTL absorbs bursts.
   * - **Mutating tools** (`create_media_buy`, `update_media_buy`,
   *   `sync_creatives`): 0–30s, or compose `composeMethod` to skip cache
   *   on these paths. A revoked-but-not-yet-expired bearer would otherwise
   *   continue authorizing mutations for the full TTL window.
   *
   * `getCacheKey` defaults to a SHA-256 hash of the JSON-serialized auth
   * context. Hashing (vs raw stringification) keeps the bearer token out
   * of Map keys — heap dumps and `util.inspect(cache)` no longer surface
   * plaintext credentials. Provide a custom key when the auth context
   * contains noise (timestamps, request ids) that would defeat caching.
   *
   * Cache size is naturally bounded by the number of distinct buyers
   * times one entry each. Adopters with token-rotation churn can cap with
   * `maxEntries` (LRU eviction).
   */
  cache?: {
    ttlMs: number;
    getCacheKey?: (authContext: AuthContext | undefined) => string;
    /** LRU eviction cap. Defaults to 1024 — enough for most multi-tenant deployments. */
    maxEntries?: number;
  };
}

interface ListingCacheEntry<TUpstreamRow> {
  rows: TUpstreamRow[];
  expiresAt: number;
}

/**
 * Create an `accounts.resolve` implementation that resolves buyer-supplied
 * `AccountReference` against an upstream OAuth-protected listing endpoint.
 * Returns just the resolve function — adapters compose it into their own
 * `AccountStore` (typically alongside a no-op `upsert` since Shape B
 * adapters don't manage account lifecycle).
 *
 * @example
 * ```ts
 * import {
 *   createUpstreamHttpClient,
 *   createOAuthPassthroughResolver,
 *   defineSalesPlatform,
 * } from '@adcp/sdk/server';
 *
 * const snap = createUpstreamHttpClient({
 *   baseUrl: 'https://adsapi.snapchat.com',
 *   auth: {
 *     kind: 'dynamic_bearer',
 *     getToken: async (ctx) => (ctx as any)?.authInfo?.credential?.token,
 *   },
 * });
 *
 * const resolve = createOAuthPassthroughResolver({
 *   httpClient: snap,
 *   listEndpoint: '/v1/me/adaccounts',
 *   idField: 'id',
 *   rowsPath: 'adaccounts',
 *   toAccount: (row, ctx) => ({
 *     id: row.id,
 *     name: row.name,
 *     status: 'active',
 *     advertiser: row.advertiser_url,
 *     ctx_metadata: {
 *       upstreamId: row.id,
 *       // Treat as secret — see `toAccount` JSDoc above.
 *       accessToken: (ctx as any)?.authInfo?.credential?.token,
 *     },
 *   }),
 *   cache: { ttlMs: 60_000 },
 * });
 *
 * defineSalesPlatform({
 *   accounts: { resolve },
 *   ...
 * });
 * ```
 *
 * Behavior:
 * - The factory only handles the `{ account_id }` discriminated-union arm.
 *   Other arms (`{ brand, operator }`) and `undefined` ref return `null`
 *   without calling upstream.
 * - Upstream throws (4xx/5xx other than 404) propagate verbatim — adopters
 *   compose `composeMethod` over the result if they want to catch and map
 *   to a typed envelope (e.g. throw `AdcpError('AUTH_REQUIRED')` on 401).
 * - Cache is opt-in and listing-keyed: one upstream hit per buyer per TTL
 *   window regardless of how many `account_id`s that buyer queries.
 *
 * @public
 */
export function createOAuthPassthroughResolver<
  TUpstreamRow extends Record<string, unknown>,
  TCtxMeta = Record<string, unknown>,
>(
  options: OAuthPassthroughResolverOptions<TUpstreamRow, TCtxMeta>
): (ref: AccountReference | undefined, ctx?: ResolveContext) => Promise<Account<TCtxMeta> | null> {
  const idField = (options.idField ?? 'id') as keyof TUpstreamRow & string;
  const rowsPath = options.rowsPath === undefined ? 'data' : options.rowsPath;
  const getAuthContext =
    options.getAuthContext ??
    ((ctx: ResolveContext | undefined) => ctx?.authInfo as unknown as AuthContext | undefined);

  const cacheTtlMs = options.cache?.ttlMs;
  const getCacheKey = options.cache?.getCacheKey ?? defaultGetCacheKey;
  const maxEntries = options.cache?.maxEntries ?? 1024;
  const cache = cacheTtlMs !== undefined ? new Map<string, ListingCacheEntry<TUpstreamRow>>() : undefined;

  return async (ref, ctx) => {
    const accountId = refAccountId(ref);
    if (accountId === undefined) return null;

    const authContext = getAuthContext(ctx);
    let cacheKey: string | undefined;
    let rows: TUpstreamRow[] | null = null;

    if (cache !== undefined) {
      cacheKey = getCacheKey(authContext);
      const hit = cache.get(cacheKey);
      if (hit !== undefined && hit.expiresAt > Date.now()) {
        // Refresh LRU position on hit.
        cache.delete(cacheKey);
        cache.set(cacheKey, hit);
        rows = hit.rows;
      } else if (hit !== undefined) {
        cache.delete(cacheKey);
      }
    }

    if (rows === null) {
      const result = await options.httpClient.get<unknown>(
        options.listEndpoint,
        undefined,
        undefined,
        authContext !== undefined ? { authContext } : undefined
      );
      if (result.body == null) return null;
      rows = extractRows<TUpstreamRow>(result.body, rowsPath);
      if (rows === null) return null;
      if (cache !== undefined && cacheKey !== undefined) {
        // Evict oldest entry first when at capacity. Map iteration order is
        // insertion order, so the first key is the LRU-coldest after the
        // hit-side refresh above.
        if (cache.size >= maxEntries) {
          const oldest = cache.keys().next().value;
          if (oldest !== undefined) cache.delete(oldest);
        }
        cache.set(cacheKey, { rows, expiresAt: Date.now() + cacheTtlMs! });
      }
    }

    const match = rows.find(row => row[idField] === accountId);
    if (match === undefined) return null;
    return options.toAccount(match, ctx);
  };
}

/**
 * Default cache-key derivation: SHA-256 of the JSON-serialized auth context.
 * Hashing keeps the bearer token out of Map keys (no plaintext credential
 * surfaces in heap dumps or `util.inspect(cache)` output).
 *
 * Falls back to a literal `<none>` key when the auth context is undefined,
 * and to the truncated stringified value when JSON serialization throws
 * (circular refs, BigInt, etc.) — adopters with non-serializable auth
 * contexts should provide their own `getCacheKey`.
 */
function defaultGetCacheKey(authContext: AuthContext | undefined): string {
  if (authContext === undefined) return '<none>';
  let serialized: string;
  try {
    serialized = JSON.stringify(authContext);
  } catch {
    return `<unserializable:${String(authContext).slice(0, 64)}>`;
  }
  return createHash('sha256').update(serialized).digest('hex');
}

function extractRows<TUpstreamRow>(body: unknown, rowsPath: string | null): TUpstreamRow[] | null {
  if (rowsPath === null) {
    return Array.isArray(body) ? (body as TUpstreamRow[]) : null;
  }
  if (body === null || typeof body !== 'object') return null;
  const rows = (body as Record<string, unknown>)[rowsPath];
  return Array.isArray(rows) ? (rows as TUpstreamRow[]) : null;
}
