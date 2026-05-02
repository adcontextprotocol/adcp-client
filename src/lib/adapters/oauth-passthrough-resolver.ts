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
 * @public
 */

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
   */
  idField?: keyof TUpstreamRow & string;

  /**
   * Property on the upstream response body that contains the array of rows.
   * Defaults to `'data'` (Snap, Meta envelope shape). Set to `null` when the
   * response body itself is the array (some flat-list APIs).
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
   */
  toAccount: (row: TUpstreamRow, ctx: ResolveContext | undefined) => Account<TCtxMeta>;

  /**
   * Optional in-memory result cache. Keyed on
   * `(getCacheKey(authContext), account_id)`; invalidated by TTL only.
   *
   * Set `ttlMs` to enable. Most adopters want 30s–5min — long enough to
   * absorb a burst of tool calls from one buyer, short enough that a
   * revoked upstream token surfaces quickly.
   *
   * `getCacheKey` defaults to JSON-serializing the auth context. Provide
   * a narrower key when the auth context contains noise (timestamps,
   * request ids) that would defeat caching.
   */
  cache?: {
    ttlMs: number;
    getCacheKey?: (authContext: AuthContext | undefined) => string;
  };
}

interface CacheEntry<TCtxMeta> {
  account: Account<TCtxMeta>;
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
 * - Cache is opt-in. When enabled, hits skip the upstream call entirely.
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
  const getCacheKey =
    options.cache?.getCacheKey ??
    ((authContext: AuthContext | undefined) => (authContext === undefined ? '<none>' : JSON.stringify(authContext)));
  const cache = cacheTtlMs !== undefined ? new Map<string, CacheEntry<TCtxMeta>>() : undefined;

  return async (ref, ctx) => {
    const accountId = refAccountId(ref);
    if (accountId === undefined) return null;

    const authContext = getAuthContext(ctx);
    let cacheKey: string | undefined;
    if (cache !== undefined) {
      cacheKey = `${getCacheKey(authContext)}::${accountId}`;
      const hit = cache.get(cacheKey);
      if (hit !== undefined && hit.expiresAt > Date.now()) {
        return hit.account;
      }
      if (hit !== undefined) cache.delete(cacheKey);
    }

    const result = await options.httpClient.get<unknown>(
      options.listEndpoint,
      undefined,
      undefined,
      authContext !== undefined ? { authContext } : undefined
    );
    if (result.body == null) return null;

    const rows = extractRows<TUpstreamRow>(result.body, rowsPath);
    if (rows === null) return null;

    const match = rows.find(row => row[idField] === accountId);
    if (match === undefined) return null;

    const account = options.toAccount(match, ctx);

    if (cache !== undefined && cacheKey !== undefined) {
      cache.set(cacheKey, { account, expiresAt: Date.now() + cacheTtlMs! });
    }

    return account;
  };
}

function extractRows<TUpstreamRow>(body: unknown, rowsPath: string | null): TUpstreamRow[] | null {
  if (rowsPath === null) {
    return Array.isArray(body) ? (body as TUpstreamRow[]) : null;
  }
  if (body === null || typeof body !== 'object') return null;
  const rows = (body as Record<string, unknown>)[rowsPath];
  return Array.isArray(rows) ? (rows as TUpstreamRow[]) : null;
}
