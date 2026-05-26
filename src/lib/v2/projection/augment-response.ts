/**
 * Buyer-side helpers that augment a v1-shaped agent response with v2
 * `format_options[]` derived from the existing `format_ids[]` on each
 * Product.
 *
 * Buyers who want the canonical creative-format model call
 * `withFormatOptions(response)` and read `format_options` instead of
 * relying only on legacy `format_ids`.
 *
 * The SDK also auto-projects compatible `AgentClient.getProducts()`
 * responses; this helper remains useful for cached responses, fixtures,
 * upstream seller/storefront composition, and explicit migration code.
 *
 * Pure functions — no IO, no caching. Each Product is projected
 * independently; diagnostics aggregate so a multi-product response
 * surfaces every projection issue at once. The helpers preserve the
 * input shape verbatim and add `format_options[]` (additive). They do
 * NOT drop `format_ids[]` — that's the 8.0 narrowing.
 */

import type { V1Product, V2ProductFormatDeclaration, ProjectionDiagnostic } from './types';
import { projectV1ProductToV2 } from './v1-to-v2';

/**
 * A Product that has been augmented with `format_options[]` while
 * preserving the original `format_ids[]`. Carries the projection
 * diagnostics that were generated mapping each `format_id` so the
 * buyer can see what (if anything) didn't project cleanly.
 *
 * **Write-side bridge.** After picking a `format_options[i]` entry,
 * use {@link formatIdsFromOptions} (from `@adcp/sdk/v2/projection`)
 * to extract the `format_ids[]` value for a `create_media_buy`
 * package. Inlining `decl.v1_format_ref` works but bypasses the
 * fail-closed semantics (canonical_formats_only / inherently-v2
 * canonical → throw). The spec gap that forces this bridge is tracked
 * at adcontextprotocol/adcp#4842.
 *
 * @see formatIdsFromOptions
 * @see formatIdsForCapability
 */
export type V2AugmentedProduct<P> = P & {
  format_options: V2ProductFormatDeclaration[];
};

/**
 * Augment a single Product. Idempotent — when `format_options[]` is
 * already present (the seller is v2-native), passes the Product
 * through unchanged. Otherwise projects from `format_ids[]`.
 *
 * Returns `{ product, diagnostics }`. `diagnostics` is empty for a
 * clean projection; populated when individual format_ids don't have
 * a v2 mapping (catalog gap, structural unreachability, etc.).
 */
export function augmentProductWithFormatOptions<P extends V1Product>(
  product: P
): { product: V2AugmentedProduct<P>; diagnostics: ProjectionDiagnostic[] } {
  // Already v2-shaped (seller sent format_options directly) — pass through.
  const existing = (product as unknown as { format_options?: unknown }).format_options;
  if (Array.isArray(existing)) {
    return {
      product: product as V2AugmentedProduct<P>,
      diagnostics: [],
    };
  }
  // v1 shape — project to add format_options[].
  if (!Array.isArray(product.format_ids)) {
    // Neither shape — nothing to project. Return as-is with an empty
    // format_options so the buyer doesn't have to special-case.
    return {
      product: { ...product, format_options: [] },
      diagnostics: [],
    };
  }
  const { v2, diagnostics } = projectV1ProductToV2(product);
  // Preserve the original product shape (especially format_ids); just
  // add format_options.
  return {
    product: {
      ...product,
      format_options: v2.format_options,
    },
    diagnostics,
  };
}

/**
 * Augment every Product in a `get_products` response with
 * `format_options[]`. Returns `{ response, diagnostics }` so callers
 * can surface projection diagnostics alongside the response's existing
 * `errors[]` array (or filter by `source: 'sdk'` to distinguish SDK
 * diagnostics from seller-emitted errors).
 *
 * Idempotent: if the seller is v2-native and every Product already
 * carries `format_options[]`, returns the response verbatim with no
 * diagnostics.
 */
export function withFormatOptions<R extends { products?: V1Product[] }>(
  response: R
): { response: R & { products: V2AugmentedProduct<V1Product>[] }; diagnostics: ProjectionDiagnostic[] } {
  if (!Array.isArray(response?.products)) {
    return {
      response: { ...response, products: [] } as R & { products: V2AugmentedProduct<V1Product>[] },
      diagnostics: [],
    };
  }
  const out: V2AugmentedProduct<V1Product>[] = [];
  const diagnostics: ProjectionDiagnostic[] = [];
  for (const p of response.products) {
    const { product, diagnostics: d } = augmentProductWithFormatOptions(p);
    out.push(product);
    diagnostics.push(...d);
  }
  return {
    response: { ...response, products: out } as R & { products: V2AugmentedProduct<V1Product>[] },
    diagnostics,
  };
}
