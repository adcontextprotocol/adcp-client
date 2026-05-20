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
 * **Fail-closed**: throws when the declaration has no v1 form. This
 * matches the codebase's witness-not-translator posture — silently
 * returning `[]` would land downstream as a `minItems: 1` schema
 * violation on the wire (the v1 `PackageRequest.format_ids[]` requires
 * at least one entry), two layers removed from the real cause. The
 * buyer should either pick a different declaration from
 * `product.format_options[]` or skip the product for v1 sellers.
 *
 * Cases that throw:
 *
 *   - `decl.canonical_formats_only: true` — seller explicitly opted out
 *     of v1 emission for this declaration.
 *   - Inherently-v2 canonicals (the 4 at 3.1 GA: `image_carousel`,
 *     `sponsored_placement`, `responsive_creative`, `agent_placement`)
 *     when `v1_format_ref[]` is absent.
 *   - `format_kind: 'custom'` shapes without `v1_format_ref[]`.
 *
 * Cases that succeed:
 *
 *   - `decl.v1_format_ref[]` present (the normative path; seller-asserted
 *     on `getProducts`). Returned verbatim — single-size declarations
 *     yield `[{agent_url, id}]`, multi-size declarations yield one entry
 *     per size.
 *
 * For callers who want to inspect the resolution result without
 * throwing — e.g., to pick a different `format_options[]` entry when
 * the first choice has no v1 form — use {@link tryFormatIdsFromOptions}.
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
 *
 * @throws Error when the declaration has no v1 form (see cases above).
 */
export function formatIdsFromOptions(decl: V2ProductFormatDeclaration): V1FormatId[] {
  const ids = tryFormatIdsFromOptions(decl);
  if (ids.length === 0) {
    const label = decl.capability_id ?? decl.format_kind ?? '<unnamed>';
    const reason = decl.canonical_formats_only
      ? 'declaration is canonical_formats_only (seller opted out of v1 emission)'
      : `declaration carries no v1_format_ref[] (likely an inherently-v2 canonical like sponsored_placement / agent_placement / image_carousel / responsive_creative, or a custom shape without v1)`;
    throw new Error(
      `formatIdsFromOptions: '${label}' has no v1 representation — ${reason}. ` +
        `Pick a different format_options[] entry or skip this product for v1 sellers. ` +
        `Use tryFormatIdsFromOptions() if you want a non-throwing variant.`
    );
  }
  return ids;
}

/**
 * Non-throwing variant of {@link formatIdsFromOptions}. Returns `[]`
 * when the declaration has no v1 form, leaving the empty-array
 * interpretation up to the caller. Useful when iterating over a
 * product's `format_options[]` and picking the first declaration that
 * has a v1 path.
 *
 * @example
 * ```ts
 * for (const opt of product.format_options) {
 *   const ids = tryFormatIdsFromOptions(opt);
 *   if (ids.length > 0) return ids; // first v1-purchasable option wins
 * }
 * throw new Error('no v1-purchasable option on this product');
 * ```
 */
export function tryFormatIdsFromOptions(decl: V2ProductFormatDeclaration): V1FormatId[] {
  if (decl.v1_format_ref && decl.v1_format_ref.length > 0) {
    // Defensive shallow copy: V1FormatId fields are all primitives today
    // (agent_url, id, width, height, duration_ms). If a nested field
    // lands later, switch to `structuredClone`.
    return decl.v1_format_ref.map(ref => ({ ...ref }));
  }
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
