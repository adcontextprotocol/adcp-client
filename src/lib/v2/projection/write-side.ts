/**
 * Write-side ergonomics for V2-mental-model buyers.
 *
 * Two axes (not three):
 *
 *   1. **V2 native path — `packageRefsForCapabilities`.** Returns
 *      `{ capability_ids, format_ids? }` ready to spread into a
 *      `PackageRequest`. Implements the spec's dual-emission convention
 *      from `media-buy/package-request.json#capability_ids` (3.1.0-beta.2,
 *      adcontextprotocol/adcp#4844): V2 buyers emit BOTH so v2-capable
 *      sellers route by `capability_ids` and v1-only sellers (which ignore
 *      unknown fields via `additionalProperties: true`) fall back to
 *      `format_ids`. When every chosen declaration is v2-only,
 *      `format_ids` is omitted from the result entirely — emitting it as
 *      `[]` would violate the wire schema's `minItems: 1` constraint at
 *      strict validators on either side. Use this for new code.
 *
 *   2. **v1-only path — `legacyFormatIdsFromOptions` /
 *      `tryLegacyFormatIdsFromOptions` / `legacyFormatIdsForCapability`.**
 *      Helpers scoped to adopters writing strictly to v1 sellers (no v2
 *      capability path). The `legacy*` prefix is *semantic narrowing*,
 *      not deprecation — these are supported indefinitely. We avoided
 *      `@deprecated` because (a) it strips through to adopter ESLint
 *      rules and creates noise for legitimate v1-only callers, and
 *      (b) the helpers solve a different problem (single-target v1
 *      payload) than the dual-emission helper does.
 */

import type { V1FormatId, V2ProductFormatDeclaration } from './types';

/**
 * Result shape for {@link packageRefsForCapabilities} — spread into a
 * `PackageRequest` to author a V2-native package while keeping v1
 * sellers working via the spec's dual-emission convention.
 *
 * **Spread order matters.** If you are setting an explicit `format_ids`
 * elsewhere in the package (e.g., to override the dual-emission
 * fallback for a specific seller), place `...refs` FIRST and your
 * override AFTER:
 *
 * ```ts
 * // ✅ Override wins
 * { ...refs, format_ids: myOverride }
 *
 * // ❌ Spread clobbers your override
 * { format_ids: myOverride, ...refs }
 * ```
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
   * V1 path (dual emission). The resolved `format_ids[]` for each chosen
   * declaration's `v1_format_ref`, with dimensional discriminators
   * (`width`/`height`/`duration_ms`) preserved in the de-dup key.
   * Omitted entirely when none of the chosen declarations have a v1
   * form — emitting `[]` would violate the wire schema's `minItems: 1`
   * constraint. v2 sellers route by `capability_ids` and ignore this
   * field; v1-only sellers reading a payload with no `format_ids` fall
   * back to the spec's "neither present" default (all formats supported
   * by the product) which is the correct v2-only-buyer-meets-v1-seller
   * fallback.
   */
  format_ids?: V1FormatId[];
}

/**
 * Reason codes for {@link CapabilityIdsLookupError}. Extends the spec's
 * single normative `UNSUPPORTED_FEATURE` reason
 * (`capability_ids_not_published`) with three client-side branch points
 * so adopters can fall-back at compose time rather than waiting for the
 * seller to reject. Of the four, only `capability_ids_not_published` is
 * spec-defined; the other three are SDK enrichments.
 *
 * - `unknown_capability_id` — the product publishes `capability_id`s on
 *   its `format_options[]`, but at least one requested id isn't among
 *   them. The buyer asked for something the seller doesn't offer.
 *   (SDK enrichment — pre-empts a seller-side `UNSUPPORTED_FEATURE`
 *   with no `reason` set.)
 * - `capability_ids_not_published` — **spec-normative** reason
 *   (`media-buy/package-request.json#capability_ids`). The product's
 *   `format_options[]` entries don't carry `capability_id` at all. The
 *   V2 path is not authorable against this product; fall back to the
 *   `legacy*` helpers (which select by declaration, not capability).
 * - `empty_input` — caller passed `capabilityIds: []`. SDK enrichment;
 *   the spec is silent. Dual-emission with `capability_ids: []` would
 *   produce a confusing payload, so fail-closed.
 * - `invalid_product` — `product` is not an object, or appears to be an
 *   array (likely caller passed `products` instead of `products[0]`).
 *   SDK enrichment — protects against the "off-by-one access pattern"
 *   mistake before the empty-format_options path mis-diagnoses it.
 */
export type CapabilityIdsLookupErrorCode =
  | 'unknown_capability_id'
  | 'capability_ids_not_published'
  | 'empty_input'
  | 'invalid_product';

/**
 * Structured error from {@link packageRefsForCapabilities}. Carries
 * a normalized `code` so adopters can branch fallback logic without
 * regex-matching the message.
 */
export class CapabilityIdsLookupError extends Error {
  readonly code: CapabilityIdsLookupErrorCode;
  /** Capability IDs the caller requested. */
  readonly requested: readonly string[];
  /** Capability IDs the product actually publishes (sorted). Empty for `capability_ids_not_published` / `invalid_product`. */
  readonly available: readonly string[];
  /** Capability IDs from `requested` that weren't matched (relevant for `unknown_capability_id`). */
  readonly missing: readonly string[];

  constructor(
    code: CapabilityIdsLookupErrorCode,
    message: string,
    meta: { requested: readonly string[]; available: readonly string[]; missing: readonly string[] }
  ) {
    super(message);
    this.name = 'CapabilityIdsLookupError';
    this.code = code;
    this.requested = meta.requested;
    this.available = meta.available;
    this.missing = meta.missing;
  }
}

/**
 * Resolve a list of `capability_id` values against a product's
 * `format_options[]` and produce the `{capability_ids, format_ids?}`
 * pair to spread into a `PackageRequest`. **Preferred V2 write path
 * at 3.1.0-beta.2+** (adcontextprotocol/adcp#4844).
 *
 * **Spread order matters.** The returned `{capability_ids, format_ids?}`
 * is designed to be spread into a `PackageRequest`. If you set an
 * explicit `format_ids` on the package, place `...refs` FIRST and the
 * override AFTER — otherwise the helper's empty `format_ids` (when the
 * V2-only case omits it) won't be there to override and your value
 * lands as expected, BUT if `format_ids` IS present, your override will
 * collide. See {@link PackageFormatRefs} for the precise rule.
 *
 * Throws {@link CapabilityIdsLookupError} (fail-closed at compose time)
 * when:
 *   - `capabilityIds` is empty (`empty_input`).
 *   - `product.format_options[]` entries publish no `capability_id` at
 *     all (`capability_ids_not_published`) — fall back to
 *     {@link legacyFormatIdsFromOptions} for this product.
 *   - Any requested id isn't present on the product
 *     (`unknown_capability_id`).
 *   - `product` looks invalid (`invalid_product`) — typically a caller
 *     passing the `products[]` array instead of a single product.
 *
 * @example
 * ```ts
 * import { packageRefsForCapabilities, CapabilityIdsLookupError } from '@adcp/sdk/v2/projection';
 *
 * const { data: { products } } = await agent.getProducts({ brief: '...' });
 * const product = products[0];
 *
 * try {
 *   const refs = packageRefsForCapabilities(product, ['nytimes_mrec', 'nytimes_video_30s']);
 *
 *   await agent.createMediaBuy({
 *     packages: [{
 *       package_id: 'pkg-1',
 *       product_id: product.product_id,
 *       pricing_option_id: product.pricing_options[0].pricing_option_id,
 *       ...refs,  // capability_ids + (format_ids if any v1 form exists)
 *       budget: { currency: 'USD', total: 5000 },
 *     }],
 *   });
 * } catch (e) {
 *   if (e instanceof CapabilityIdsLookupError && e.code === 'capability_ids_not_published') {
 *     // Product is V1-shape only. Use legacyFormatIdsFromOptions instead.
 *   } else throw e;
 * }
 * ```
 */
export function packageRefsForCapabilities(
  product: { format_options?: V2ProductFormatDeclaration[] },
  capabilityIds: string[]
): PackageFormatRefs {
  // Guard against the common mistake of passing the products[] array.
  if (product === null || typeof product !== 'object' || Array.isArray(product)) {
    throw new CapabilityIdsLookupError(
      'invalid_product',
      `packageRefsForCapabilities: expected a Product object with a format_options[] field, got ${Array.isArray(product) ? 'an array (did you pass `products` instead of `products[0]`?)' : typeof product}.`,
      { requested: capabilityIds, available: [], missing: capabilityIds }
    );
  }
  if (capabilityIds.length === 0) {
    throw new CapabilityIdsLookupError(
      'empty_input',
      `packageRefsForCapabilities requires at least one capability_id. ` +
        `To accept seller defaults, omit capability_ids from the package entirely.`,
      { requested: capabilityIds, available: [], missing: [] }
    );
  }
  const opts = product.format_options ?? [];
  const known = new Map<string, V2ProductFormatDeclaration>();
  let entriesWithoutCapabilityId = 0;
  for (const o of opts) {
    if (o.capability_id) {
      known.set(o.capability_id, o);
    } else {
      entriesWithoutCapabilityId += 1;
    }
  }
  const available = [...known.keys()].sort();
  // Distinguish "product publishes no capability_ids" from "this specific
  // capability_id isn't known" — the spec's UNSUPPORTED_FEATURE response
  // carries the same distinction (`reason: 'capability_ids_not_published'`).
  if (known.size === 0) {
    // Branch the message on whether format_options exists at all —
    // "0 declarations, 0 unaddressable" is true but misleading for a
    // bare {} product; adopters chase the wrong cause if we lump both
    // shapes under the same diagnostic.
    const detail =
      opts.length === 0
        ? `product has no format_options[] (V1-only product shape, or product wasn't passed through getProducts auto-augmentation)`
        : `${opts.length} declarations on the product, ${entriesWithoutCapabilityId} unaddressable via capability_id (no entry publishes one)`;
    throw new CapabilityIdsLookupError(
      'capability_ids_not_published',
      `packageRefsForCapabilities: product publishes no capability_ids — ${detail}. ` +
        `The V2 path is not authorable against this product. Fall back to legacyFormatIdsFromOptions ` +
        `or skip the product for V2 sellers.`,
      { requested: capabilityIds, available: [], missing: capabilityIds.slice() }
    );
  }
  const missing = capabilityIds.filter(id => !known.has(id));
  if (missing.length > 0) {
    const trailingNote =
      entriesWithoutCapabilityId > 0
        ? ` (${entriesWithoutCapabilityId} format_options[] entries publish no capability_id and aren't addressable via this helper — use legacyFormatIdsFromOptions for those.)`
        : '';
    // JSON-stringify the seller-controlled strings before they enter
    // the error message. Adopters piping SDK errors into LLM diagnostic
    // agents (per docs/guides/CTX-METADATA-SAFETY.md) need the
    // seller-asserted `capability_id` values fenced; raw interpolation
    // would be an unfenced injection surface.
    throw new CapabilityIdsLookupError(
      'unknown_capability_id',
      `packageRefsForCapabilities: capability_ids ${JSON.stringify(missing)} ` +
        `not found in product.format_options[]. Available capability_ids: ` +
        `${JSON.stringify(available)}.${trailingNote}`,
      { requested: capabilityIds, available, missing }
    );
  }
  // De-dupe v1 refs AND capability_ids. The reviewer (PR #1896
  // post-merge follow-up) flagged that `format_ids` collapsed duplicates
  // but `capability_ids` passed `['x', 'x']` through to the wire. Sellers
  // would resolve either side without issue, but the inconsistency makes
  // the dual-emission contract harder to reason about — collapse both.
  const seenCapability = new Set<string>();
  const dedupedCapabilityIds: string[] = [];
  for (const id of capabilityIds) {
    if (seenCapability.has(id)) continue;
    seenCapability.add(id);
    dedupedCapabilityIds.push(id);
  }
  // De-dupe v1 refs across multiple chosen declarations. Include
  // dimensional discriminators in the key — `V1FormatId` carries
  // `width`/`height`/`duration_ms` and a multi-size catalog publishes
  // the SAME `{agent_url, id}` at different dimensions. A key without
  // those fields would silently collapse multi-size declarations.
  const seen = new Set<string>();
  const format_ids: V1FormatId[] = [];
  for (const id of dedupedCapabilityIds) {
    const decl = known.get(id)!;
    for (const ref of decl.v1_format_ref ?? []) {
      // `?? ''` is load-bearing: with `||` a `width: 0` collides with
      // `width: undefined` and the de-dup silently drops a legitimate
      // ref. Don't simplify to `||` without verifying the V1FormatId
      // shape no longer admits 0-valued dimensions.
      const key = `${ref.agent_url}::${ref.id}::${ref.width ?? ''}x${ref.height ?? ''}::${ref.duration_ms ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // V1FormatId is flat (all primitives today). Shallow copy is
      // sufficient. Defensive copy is load-bearing — without it, callers
      // mutating the returned array mutate the source decl.
      format_ids.push({ ...ref });
    }
  }
  // Omit `format_ids` entirely when empty. The wire schema requires
  // `minItems: 1` on `format_ids` when present; emitting `[]` fails
  // strict validation. Spec's "neither present" rule is the correct
  // fallback for v2-only-buyer-meets-v1-seller.
  const result: PackageFormatRefs =
    format_ids.length > 0
      ? { capability_ids: dedupedCapabilityIds, format_ids }
      : { capability_ids: dedupedCapabilityIds };
  return result;
}

/**
 * Extract the v1 `format_ids[]` to send on a `create_media_buy` package
 * from a V2-shaped product format declaration the buyer chose from a
 * product's `format_options[]`. **V1-only write path** — for adopters
 * writing strictly to v1 sellers, or for products whose
 * `format_options[]` entries don't publish `capability_id` (the V2 path
 * is unauthorable; this is the bridge).
 *
 * The `legacy*` prefix is semantic narrowing, not deprecation — these
 * helpers are supported indefinitely. New V2-target code should prefer
 * {@link packageRefsForCapabilities}, which emits both `capability_ids`
 * (V2 path) and `format_ids` (v1 dual-emission fallback) in one call.
 *
 * **Fail-closed**: throws when the declaration has no v1 form. Cases
 * that throw:
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
 * the first choice has no v1 form — use {@link tryLegacyFormatIdsFromOptions}.
 *
 * @throws Error when the declaration has no v1 form (see cases above).
 */
export function legacyFormatIdsFromOptions(decl: V2ProductFormatDeclaration): V1FormatId[] {
  const ids = tryLegacyFormatIdsFromOptions(decl);
  if (ids.length === 0) {
    const label = decl.capability_id ?? decl.format_kind ?? '<unnamed>';
    const reason = decl.canonical_formats_only
      ? 'declaration is canonical_formats_only (seller opted out of v1 emission)'
      : `declaration carries no v1_format_ref[] (likely an inherently-v2 canonical like sponsored_placement / agent_placement / image_carousel / responsive_creative, or a custom shape without v1)`;
    throw new Error(
      `legacyFormatIdsFromOptions: '${label}' has no v1 representation — ${reason}. ` +
        `Pick a different format_options[] entry or skip this product for v1 sellers. ` +
        `Use tryLegacyFormatIdsFromOptions() if you want a non-throwing variant.`
    );
  }
  return ids;
}

/**
 * Non-throwing variant of {@link legacyFormatIdsFromOptions}. Returns
 * `[]` when the declaration has no v1 form, leaving the empty-array
 * interpretation up to the caller. Useful when iterating over a
 * product's `format_options[]` and picking the first declaration that
 * has a v1 path.
 *
 * **V1-only write path** — see {@link legacyFormatIdsFromOptions} for
 * scope. Use {@link packageRefsForCapabilities} for new V2 code.
 *
 * @example
 * ```ts
 * for (const opt of product.format_options) {
 *   const ids = tryLegacyFormatIdsFromOptions(opt);
 *   if (ids.length > 0) return ids; // first v1-purchasable option wins
 * }
 * throw new Error('no v1-purchasable option on this product');
 * ```
 */
export function tryLegacyFormatIdsFromOptions(decl: V2ProductFormatDeclaration): V1FormatId[] {
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
 * `format_options[]`. Convenience wrapper around
 * {@link legacyFormatIdsFromOptions} for buyers who carry a
 * capability_id rather than the full declaration — e.g., a buyer that
 * cached `capability_id` selections per product and needs to round-trip
 * them on a later `create_media_buy` against a v1 seller.
 *
 * **V1-only write path** — see {@link legacyFormatIdsFromOptions} for
 * scope. Use {@link packageRefsForCapabilities} for new V2 code; it
 * handles the same single-capability case by passing `[capabilityId]`
 * and produces a dual-emission `{capability_ids, format_ids?}` pair.
 *
 * Throws when the capability_id doesn't match any declaration on the
 * product (mirroring the spec's rejection rule: a missing capability_id
 * reference is a structural error, not silent).
 *
 * @example
 * ```ts
 * // Earlier: buyer stored 'iab_mrec_homepage' as their pick.
 * const formatIds = legacyFormatIdsForCapability(product, 'iab_mrec_homepage');
 * ```
 */
export function legacyFormatIdsForCapability(
  product: { format_options?: V2ProductFormatDeclaration[] },
  capabilityId: string
): V1FormatId[] {
  const opts = product.format_options ?? [];
  const match = opts.find(o => o.capability_id === capabilityId);
  if (!match) {
    // Fence seller-supplied strings via JSON.stringify — adopters
    // piping SDK errors into LLM diagnostic agents read the message
    // without re-escaping. Same posture as packageRefsForCapabilities.
    const declared = opts.map(o => o.capability_id).filter((s): s is string => Boolean(s));
    throw new Error(
      `capability_id ${JSON.stringify(capabilityId)} not found in product.format_options[] ` +
        `(declared capability_ids: ${declared.length > 0 ? JSON.stringify(declared) : '<none>'})`
    );
  }
  return legacyFormatIdsFromOptions(match);
}
