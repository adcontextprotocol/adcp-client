/**
 * Write-side ergonomics for V2-mental-model buyers.
 *
 * Three layers:
 *
 *   1. **`packageRefsForCapabilities` (native v2 — preferred at 3.1-beta.2+).**
 *      Returns `{ capability_ids, format_ids }` ready to spread into a
 *      `PackageRequest`. Implements the spec's dual-emission recommendation
 *      from `media-buy/package-request.json#capability_ids`: V2 buyers
 *      emit BOTH so v2-capable sellers route by `capability_ids` and
 *      v1-only sellers (which ignore unknown fields via
 *      `additionalProperties: true`) fall back to `format_ids` rather
 *      than silently defaulting to all formats supported by the product.
 *
 *   2. **`formatIdsFromOptions` / `tryFormatIdsFromOptions`** — v1-only
 *      bridges kept for adopters writing strictly to v1 sellers, or for
 *      backward compatibility on existing call sites. Throw on
 *      no-v1-form (fail-closed). `@deprecated` in JSDoc because the
 *      dual-emission helper covers the buyer-flow case better; helpers
 *      remain exported indefinitely.
 *
 *   3. **`formatIdsForCapability`** — single-capability v1 lookup,
 *      preserved for the same reason as #2.
 *
 * adcontextprotocol/adcp#4842 (landed in 3.1.0-beta.2 as #4844) was the
 * upstream gap that forced the v1 bridge. Now that `capability_ids[]`
 * is on `PackageRequest`, V2 buyers should prefer the native path.
 */

import type { V1FormatId, V2ProductFormatDeclaration } from './types';

/**
 * Result shape for {@link packageRefsForCapabilities} — spread into a
 * `PackageRequest` to author a V2-native package while keeping v1
 * sellers working via the spec's dual-emission convention.
 */
export interface PackageFormatRefs {
  /**
   * V2 path. The `capability_id` values the buyer is activating on this
   * package. Sellers routing by `capability_ids` MUST resolve each entry
   * against the target product's `format_options[]`; absent or missing
   * entries surface as `UNSUPPORTED_FEATURE` (see spec resolution rules
   * on `media-buy/package-request.json#capability_ids`).
   */
  capability_ids: string[];
  /**
   * V1 path (dual-emission). The resolved `format_ids[]` for each chosen
   * declaration's `v1_format_ref`, concatenated and de-duplicated. v2
   * sellers ignore this when `capability_ids` is present; v1-only sellers
   * (which don't understand `capability_ids` per `additionalProperties:
   * true`) read it as their normal `format_ids[]` selector.
   *
   * Empty when none of the chosen declarations have a v1 form (e.g., the
   * buyer is buying an inherently-v2 canonical from a v2-only seller).
   * That's load-bearing for v2-only flows; v1-only sellers asked to buy a
   * v2-only declaration will reject downstream regardless.
   */
  format_ids: V1FormatId[];
}

/**
 * Resolve a list of `capability_id` values against a product's
 * `format_options[]` and produce the `{capability_ids, format_ids}`
 * pair to spread into a `PackageRequest`. **Preferred V2 write path
 * at 3.1.0-beta.2+** (adcontextprotocol/adcp#4844).
 *
 * Throws when any requested `capability_id` is missing on the product
 * (matches the seller-side `UNSUPPORTED_FEATURE` rejection rule —
 * we fail at compose-time rather than waiting for the seller to
 * reject the request).
 *
 * @example
 * ```ts
 * import { packageRefsForCapabilities } from '@adcp/sdk/v2/projection';
 *
 * const { data: { products } } = await agent.getProducts({ brief: '...' });
 * const product = products[0];
 * const refs = packageRefsForCapabilities(product, ['nytimes_mrec', 'nytimes_video_30s']);
 *
 * await agent.createMediaBuy({
 *   packages: [{
 *     package_id: 'pkg-1',
 *     product_id: product.product_id,
 *     pricing_option_id: product.pricing_options[0].pricing_option_id,
 *     ...refs,  // capability_ids + format_ids (dual emission)
 *     budget: { currency: 'USD', total: 5000 },
 *   }],
 *   // ...
 * });
 * ```
 *
 * @throws Error when any capability_id is missing from the product's
 *   format_options[]. Message lists the available capability_ids.
 */
export function packageRefsForCapabilities(
  product: { format_options?: V2ProductFormatDeclaration[] },
  capabilityIds: string[]
): PackageFormatRefs {
  const opts = product.format_options ?? [];
  const known = new Map<string, V2ProductFormatDeclaration>();
  for (const o of opts) {
    if (o.capability_id) known.set(o.capability_id, o);
  }
  const missing = capabilityIds.filter(id => !known.has(id));
  if (missing.length > 0) {
    const available = [...known.keys()].sort();
    throw new Error(
      `packageRefsForCapabilities: capability_ids [${missing.join(', ')}] ` +
        `not found in product.format_options[]. Available capability_ids: ` +
        `${available.join(', ') || '<none published>'}.`
    );
  }
  // De-dupe v1 refs across multiple chosen declarations — a buyer picking
  // two declarations that both reference the same v1 format_id (rare but
  // possible during catalog transitions) shouldn't emit duplicates on the
  // wire.
  const seen = new Set<string>();
  const format_ids: V1FormatId[] = [];
  for (const id of capabilityIds) {
    const decl = known.get(id)!;
    for (const ref of decl.v1_format_ref ?? []) {
      const key = `${ref.agent_url}::${ref.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      format_ids.push({ ...ref });
    }
  }
  return { capability_ids: [...capabilityIds], format_ids };
}

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
 * @deprecated Use {@link packageRefsForCapabilities} instead at
 *   3.1.0-beta.2+ — it emits both `capability_ids` (the V2-native path)
 *   AND `format_ids` (v1-compat) so a single PackageRequest works
 *   against both v2-capable and v1-only sellers. This v1-only helper
 *   remains supported indefinitely for callers writing strictly to v1
 *   sellers or maintaining existing code; do not remove without an SDK
 *   major bump.
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
 *
 * @deprecated Same deprecation reasoning as {@link formatIdsFromOptions} —
 *   prefer {@link packageRefsForCapabilities} for V2 write paths.
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
 *
 * @deprecated Same deprecation reasoning as {@link formatIdsFromOptions} —
 *   {@link packageRefsForCapabilities} handles the same single-capability
 *   case by passing `[capabilityId]` and produces a dual-emission
 *   `{capability_ids, format_ids}` pair instead of a v1-only result.
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
