import type { RequireCacheScopeWhenProducts } from '../types/server-payload';

export type GetProductsCacheScope = 'public' | 'account';

export interface EnsureGetProductsCacheScopeOptions {
  /**
   * Scope to stamp when a populated or unchanged get_products response omits
   * cache_scope. Defaults to 'account', the fail-closed choice for composed
   * storefronts and upstream inventory adapters.
   */
  defaultCacheScope?: GetProductsCacheScope;
  /** Optional observability hook for callers that want to track SDK injection. */
  onInject?: (event: {
    cache_scope: GetProductsCacheScope;
    reason: 'products_present' | 'unchanged';
    product_count?: number;
  }) => void;
}

export interface GetProductsCacheScopeValidation {
  ok: boolean;
  reason?: 'missing_cache_scope' | 'invalid_cache_scope';
}

type NormalizedCacheScopeInput<T extends Record<string, unknown>> = Omit<T, 'cache_scope'> & {
  cache_scope?: GetProductsCacheScope;
};

export type GetProductsResponseWithCacheScope<T extends Record<string, unknown>> = T extends {
  products: infer TProducts;
}
  ? Omit<T, 'cache_scope'> & { products: TProducts; cache_scope: GetProductsCacheScope }
  : T extends { unchanged: true }
    ? Omit<T, 'cache_scope'> & { unchanged: true; cache_scope: GetProductsCacheScope }
    : RequireCacheScopeWhenProducts<NormalizedCacheScopeInput<T>>;

function getScopeRequirement(response: unknown): 'products_present' | 'unchanged' | undefined {
  if (response == null || typeof response !== 'object' || Array.isArray(response)) return undefined;
  const value = response as { products?: unknown; unchanged?: unknown };
  if (Array.isArray(value.products)) return 'products_present';
  if (value.unchanged === true) return 'unchanged';
  return undefined;
}

function isCacheScope(value: unknown): value is GetProductsCacheScope {
  return value === 'public' || value === 'account';
}

/**
 * Validate the get_products cache-scope invariant without mutating the
 * response: if `products` is present, or `unchanged: true` is present, then
 * `cache_scope` must be either 'public' or 'account'.
 */
export function validateGetProductsCacheScope(response: unknown): GetProductsCacheScopeValidation {
  const requirement = getScopeRequirement(response);
  if (!requirement) return { ok: true };
  const scope = (response as { cache_scope?: unknown }).cache_scope;
  if (scope === undefined) return { ok: false, reason: 'missing_cache_scope' };
  if (!isCacheScope(scope)) return { ok: false, reason: 'invalid_cache_scope' };
  return { ok: true };
}

/**
 * Return a get_products response whose populated/unchanged branches always
 * carry cache_scope. Existing valid values are preserved. Missing values are
 * stamped with `defaultCacheScope` (default 'account'); invalid values throw.
 *
 * Use this at storefront/composition boundaries when upstream inventory
 * sources have not yet adopted the 3.1 cache-scope field. Defaulting to
 * 'account' avoids accidentally keying account overlays under a public cache.
 */
export function ensureGetProductsCacheScope<T extends Record<string, unknown>>(
  response: T,
  options: EnsureGetProductsCacheScopeOptions = {}
): GetProductsResponseWithCacheScope<T> {
  const requirement = getScopeRequirement(response);
  if (!requirement) return response as unknown as GetProductsResponseWithCacheScope<T>;

  const current = response.cache_scope;
  if (isCacheScope(current)) return response as unknown as GetProductsResponseWithCacheScope<T>;
  if (current !== undefined) {
    throw new Error(
      `get_products cache_scope must be 'public' or 'account' when products are present or unchanged: true; got ${JSON.stringify(current)}.`
    );
  }

  const cacheScope = options.defaultCacheScope ?? 'account';
  const normalized = { ...response, cache_scope: cacheScope };
  options.onInject?.({
    cache_scope: cacheScope,
    reason: requirement,
    product_count: Array.isArray(response.products) ? response.products.length : undefined,
  });
  return normalized as unknown as GetProductsResponseWithCacheScope<T>;
}
