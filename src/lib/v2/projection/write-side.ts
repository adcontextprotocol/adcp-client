/**
 * Write-side ergonomics for V2-mental-model buyers.
 *
 * After `getProducts` returns a `format_options[]`-augmented response
 * (auto-wired in `AgentClient.getProducts`), buyers pick a
 * `ProductFormatDeclaration` and need to construct the v1 `format_ids[]`
 * for the `create_media_buy` package — the spec at 3.1-beta still
 * carries only `format_ids[]` on `PackageRequest`. See
 * adcontextprotocol/adcp#4842 for the upstream proposal to add
 * `capability_id` on the create side; until that lands, V2 buyers bridge
 * via the read-projection layer's `v1_format_ref[]` annotation.
 *
 * This module is the canonical place that bridge lives so adopters
 * write the V2 flow exactly once instead of inlining `decl.v1_format_ref`
 * pluckers everywhere.
 *
 * When adcontextprotocol/adcp#4842 lands and the SDK ships V2-native
 * write paths, these helpers are deprecated rather than load-bearing.
 */

import type { V1FormatId, V2ProductFormatDeclaration } from './types';

/**
 * Extract the v1 `format_ids[]` to send on a `create_media_buy` package
 * from a V2-shaped product format declaration the buyer chose from a
 * product's `format_options[]`.
 *
 * Resolution rules:
 *
 *   - `decl.v1_format_ref[]` present (the normative path; seller-asserted
 *     on `getProducts`). Returned verbatim — single-size declarations
 *     yield `[{agent_url, id}]`, multi-size declarations yield one entry
 *     per size.
 *   - `decl.v1_format_ref` absent + `decl.canonical_formats_only: true`.
 *     The seller has explicitly opted out of v1 emission for this
 *     declaration; no v1 representation exists. Returns `[]`.
 *   - Neither present. Same as the canonical_formats_only case — the
 *     declaration is V2-only (the 4 inherently-v2 canonicals at 3.1 GA:
 *     `image_carousel`, `sponsored_placement`, `responsive_creative`,
 *     `agent_placement`, plus any future `custom` shape without a v1
 *     translation). Returns `[]`.
 *
 * Callers should treat an empty return as "this declaration cannot be
 * purchased from a v1 seller via `create_media_buy`." The buyer either
 * picks a different declaration (when the product has more than one
 * `format_options[]` entry) or skips the product for this seller.
 *
 * @example
 * ```ts
 * const { data } = await agent.getProducts({ brief: '...' });
 * const product = data.products[0];
 * // Buyer picks the image format option:
 * const chosen = product.format_options.find(o => o.format_kind === 'image');
 * if (!chosen) throw new Error('no image format on this product');
 *
 * await agent.createMediaBuy({
 *   packages: [{
 *     package_id: 'pkg-1',
 *     product_id: product.product_id,
 *     pricing_option_id: product.pricing_options[0].pricing_option_id,
 *     format_ids: formatIdsFromOptions(chosen),
 *     budget: { currency: 'USD', total: 5000 },
 *   }],
 *   ...
 * });
 * ```
 */
export function formatIdsFromOptions(decl: V2ProductFormatDeclaration): V1FormatId[] {
  if (decl.v1_format_ref && decl.v1_format_ref.length > 0) {
    // Defensive copy: callers may mutate the result without affecting
    // the source declaration. Same shape; size-fan-out semantics are
    // already baked into the array by the projection layer / seller.
    return decl.v1_format_ref.map(ref => ({ ...ref }));
  }
  // No v1 form possible (canonical_formats_only or inherently-v2 canonical).
  return [];
}

/**
 * Resolve a `capability_id` to its `format_ids[]` against a product's
 * `format_options[]`. Convenience wrapper around `formatIdsFromOptions`
 * for buyers who carry a capability_id rather than the full declaration —
 * e.g., a buyer that cached `capability_id` selections per product and
 * needs to round-trip them on a later `create_media_buy`.
 *
 * Throws when the capability_id doesn't match any declaration on the
 * product (mirroring the spec's rejection rule: a missing capability_id
 * reference is a structural error, not silent).
 *
 * @example
 * ```ts
 * // Earlier: buyer stored 'iab_mrec_homepage' as their pick.
 * const formatIds = formatIdsForCapability(product, 'iab_mrec_homepage');
 * ```
 */
export function formatIdsForCapability(
  product: { format_options?: V2ProductFormatDeclaration[] },
  capabilityId: string
): V1FormatId[] {
  const opts = product.format_options ?? [];
  const match = opts.find(o => o.capability_id === capabilityId);
  if (!match) {
    throw new Error(
      `capability_id '${capabilityId}' not found in product.format_options[] ` +
        `(declared capability_ids: ${
          opts
            .map(o => o.capability_id)
            .filter(Boolean)
            .join(', ') || '<none>'
        })`
    );
  }
  return formatIdsFromOptions(match);
}
