/**
 * Helpers for deriving seller-level capability summaries from the
 * product catalog. Some `get_adcp_capabilities.media_buy.*` fields are
 * rollups of facts that already live at the product level — hand-
 * maintaining the rollup is a drift surface (out of sync the moment a
 * product changes). These helpers compute the rollup so the declaration
 * stays mechanically derived.
 *
 * Adopters call the helpers at startup (or whenever their catalog
 * mutates) and pass the result to `platform.capabilities.*`:
 *
 * ```ts
 * import { rollupOptimizationMetricsFromProducts } from '@adcp/sdk';
 *
 * const products = await loadProductCatalog();
 * const platform: DecisioningPlatform = {
 *   capabilities: {
 *     supported_optimization_metrics: rollupOptimizationMetricsFromProducts(products),
 *     // ...
 *   },
 * };
 * ```
 *
 * @public
 */

import type { Product } from '../types/tools.generated';

/** Minimum shape needed to derive the rollup — accepts any object that
 *  carries the spec's `metric_optimization.supported_metrics` array. */
interface ProductLike {
  metric_optimization?: {
    supported_metrics?: ReadonlyArray<string>;
  };
}

/**
 * Compute `media_buy.supported_optimization_metrics` from a product
 * catalog. Per AdCP 3.1 (adcp#4669), this field is the array union of
 * every product's `metric_optimization.supported_metrics`.
 *
 * Returns a sorted, de-duplicated array. Empty union → empty array;
 * callers SHOULD treat an empty result as "omit the field" (the wire
 * description says an absent field means "seller declares no specific
 * guarantees").
 *
 * Stable ordering (alphabetical) so the declaration doesn't churn on
 * insertion order. Pure function; safe to call repeatedly.
 *
 * @example
 * ```ts
 * const products: Product[] = [
 *   { metric_optimization: { supported_metrics: ['clicks', 'views'] } },
 *   { metric_optimization: { supported_metrics: ['views', 'completed_views'] } },
 * ];
 * rollupOptimizationMetricsFromProducts(products);
 * // → ['clicks', 'completed_views', 'views']
 * ```
 */
export function rollupOptimizationMetricsFromProducts<T extends ProductLike = Product>(
  products: ReadonlyArray<T>
): string[] {
  const seen = new Set<string>();
  for (const p of products) {
    const metrics = p.metric_optimization?.supported_metrics;
    if (!Array.isArray(metrics)) continue;
    for (const m of metrics) {
      if (typeof m === 'string' && m.length > 0) seen.add(m);
    }
  }
  return Array.from(seen).sort();
}
