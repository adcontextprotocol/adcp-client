/**
 * v2 → v1 Product projection (the downgrade direction).
 *
 * Used when the SDK negotiated to a v1 seller for a buyer that wrote V2
 * code. The 8.0 design at `docs/development/v3.1-sdk-design.md` makes V2
 * the public mental model — adopters never see v1 vocabulary on
 * `Product` — so this is the symmetric counterpart to v1→v2 projection
 * on the read side.
 *
 * Resolution order per declaration (aligns with the normative rules in
 * `core/registries/v1-canonical-mapping.json` and the canonical schemas'
 * `v1_translatable` field):
 *
 *   1. `format_kind: "custom"` + `canonical_formats_only: true` → no v1
 *      emit. Seller has explicitly opted out. SDK-local diagnostic
 *      `FORMAT_DECLARATION_V1_NOT_APPLICABLE` surfaces the opt-out so
 *      v1-only buyers see why a product disappeared.
 *   2. Canonical declares `v1_translatable: false` (the 4 inherently-v2
 *      canonicals at 3.1 GA: image_carousel, sponsored_placement,
 *      responsive_creative, agent_placement) → no v1 emit. SDK-local
 *      `CANONICAL_NOT_V1_TRANSLATABLE` diagnostic. **Spec is explicit:
 *      MUST NOT emit FORMAT_PROJECTION_FAILED** — these aren't
 *      registry-coverage gaps, they're structural unreachability.
 *   3. `v1_format_ref` present → use verbatim. Seller-asserted v1↔v2
 *      pairing is the only normative path to a specific v1 `format_id`.
 *   4. Registry has invertible literal match (`format_id_glob` with no
 *      `*`, params narrow compatibly) → MAY synthesize a v1 `format_id`,
 *      but the projection is **non-normative** per the registry's
 *      direction-of-truth statement. Downstream consumers MUST NOT
 *      depend on this — and the spec explicitly notes that a synthesized
 *      `agent_url` is implementation-defined inter-SDK divergence. We
 *      do synthesize (best-effort, surfaces the registry's invertible
 *      entries) but flag the result as non-normative via the registry
 *      lookup return type.
 *   5. Registry has family-level matches (structural or wildcarded
 *      globs) but none invertible → `FORMAT_DECLARATION_V1_AMBIGUOUS`.
 *      Spec code. Seller's path: add `v1_format_ref` to disambiguate.
 *   6. Registry has no entries for this canonical (and v1_translatable
 *      is true) → `FORMAT_PROJECTION_FAILED`. Spec code. Registry-
 *      coverage gap; correctable by filing a registry PR.
 *
 * SDK identity for `sdk_id` is read from package.json at module-load
 * time so multi-hop deduplication can pin diagnostics to the SDK that
 * emitted them.
 */

import type { V2Product, V2ProductFormatDeclaration, V1Product, V1FormatId, ProjectionDiagnostic } from './types';
import { reverseLookup } from './registry';
import { isCanonicalV1Translatable } from './canonical-properties';
import { findCatalogEntryByCanonicalAndSize, parseSizedIdTemplate } from './catalog';
import { LIBRARY_VERSION } from '../../version';

const SDK_ID = `@adcp/sdk@${LIBRARY_VERSION}`;

export interface V2ToV1Result {
  v1: V1Product;
  diagnostics: ProjectionDiagnostic[];
}

/**
 * Inspect a v2 declaration's params for multi-size or responsive-range
 * shapes that a single v1 `format_id` can't represent. Returns the
 * detected mode + count so the caller emits the diagnostic with full
 * context. Returns null when params declare a single fixed (width,
 * height) — the case that round-trips through v1 cleanly.
 */
function detectLossyMultiSize(
  decl: V2ProductFormatDeclaration
): { mode: 'sizes' | 'responsive_range'; count?: number } | null {
  // Only image/html5/display_tag canonicals carry these new size modes
  // at 3.1 GA. Other canonicals (video_*, audio_*) use their own param
  // shapes that the v1 format_id can carry inline.
  if (decl.format_kind !== 'image' && decl.format_kind !== 'html5' && decl.format_kind !== 'display_tag') {
    return null;
  }
  const params = decl.params ?? {};
  if (Array.isArray(params.sizes) && params.sizes.length > 1) {
    return { mode: 'sizes', count: params.sizes.length };
  }
  // Responsive range mode: any of min_*/max_* present means the v1
  // format_id (which carries exactly one width+height pair) is lossy.
  if (
    typeof params.min_width === 'number' ||
    typeof params.max_width === 'number' ||
    typeof params.min_height === 'number' ||
    typeof params.max_height === 'number'
  ) {
    return { mode: 'responsive_range' };
  }
  return null;
}

/**
 * Try to fan out a multi-size v2 declaration to N v1 format_ids by
 * looking up each declared size in the AAO catalog. When successful,
 * v1 buyers see ALL the sizes the v2 declaration covers — not just
 * the seller-asserted rep. The spec doesn't require this (the rep +
 * lossy advisory is the minimum-bar projection) but the catalog
 * already publishes the per-size entries, so the SDK can use them
 * without inter-SDK divergence.
 *
 * Returns the fanned-out v1 ids when at least 2 sizes resolved
 * (otherwise the rep alone is fine; no value in fan-out). The lossy
 * advisory is still emitted — its details now reflect how many
 * sizes were actually covered vs declared.
 */
function tryFanOutMultiSize(decl: V2ProductFormatDeclaration, v1Refs: V1FormatId[]): V1FormatId[] | null {
  const sizes = decl.params?.sizes;
  if (!Array.isArray(sizes) || sizes.length <= 1) return null;
  // Parse the first seller-asserted ref's id to extract its
  // `<prefix>_<W>x<H>_<suffix>` template, then constrain the fan-out
  // to siblings sharing the same prefix + suffix. Otherwise multiple
  // entries with the same `canonical:` annotation but different
  // families (e.g., image's `display_*_image` and `display_*_generative`
  // both annotated `canonical: image`) would collide and the SDK could
  // emit ids from the wrong family.
  const rep = v1Refs[0];
  if (!rep?.id) return null;
  const template = parseSizedIdTemplate(rep.id);
  const lookupOpts = template ? { prefix: template.prefix, suffix: template.suffix } : undefined;

  const found: V1FormatId[] = [];
  for (const size of sizes) {
    if (!size || typeof size !== 'object') continue;
    const sz = size as { width?: unknown; height?: unknown };
    if (typeof sz.width !== 'number' || typeof sz.height !== 'number') continue;
    const entry = findCatalogEntryByCanonicalAndSize(decl.format_kind, sz.width, sz.height, rep.agent_url, lookupOpts);
    if (entry) {
      found.push({
        agent_url: entry.format_id.agent_url,
        id: entry.format_id.id,
        width: sz.width,
        height: sz.height,
      });
    }
  }
  return found.length >= 2 ? found : null;
}

/**
 * Project a single V2 declaration. Returns one v1 format_id (the
 * common case) OR a fanned-out list of v1 format_ids (multi-size
 * fan-out) OR a diagnostic, plus an optional advisory diagnostic
 * (multi-size loses some sizes). The structural invariant: every
 * declaration produces AT LEAST ONE of (v1 emit, diagnostic) — may
 * produce both.
 */
function projectDeclaration(
  decl: V2ProductFormatDeclaration,
  productId: string,
  field: string
): { v1?: V1FormatId | V1FormatId[]; diagnostic?: ProjectionDiagnostic } {
  // Step 1: seller-asserted product-level opt-out. canonical_formats_only
  // is REQUIRED on `custom` declarations without v1_format_ref, but it's
  // ALSO valid on any non-custom canonical when the seller wants to opt
  // out of v1 emission for this product (e.g. the catalog has no v1 entry
  // for the format yet — `audio_daast` is the 3.1 example).
  if (decl.canonical_formats_only === true) {
    return {
      diagnostic: {
        source: 'sdk',
        sdk_id: SDK_ID,
        field,
        code: 'FORMAT_DECLARATION_V1_NOT_APPLICABLE',
        error: {
          details: {
            format_kind: decl.format_kind,
            product_id: productId,
            format_option_id: decl.format_option_id,
            reason: 'canonical_formats_only',
          },
        },
      },
    };
  }

  // Step 2: canonical-level structural unreachability.
  if (!isCanonicalV1Translatable(decl.format_kind)) {
    return {
      diagnostic: {
        source: 'sdk',
        sdk_id: SDK_ID,
        field,
        code: 'CANONICAL_NOT_V1_TRANSLATABLE',
        error: {
          details: {
            format_kind: decl.format_kind,
            product_id: productId,
            format_option_id: decl.format_option_id,
          },
        },
      },
    };
  }

  // Step 3: seller-asserted v1 link — the only normative path to a
  // specific v1 format_id. The spec normatively requires `v1_format_ref`
  // to be an array (single-ref is `[{...}]`); multi-size SHOULD carry
  // one entry per size.
  //
  // When the seller-asserted refs cover every declared size, emit all
  // refs verbatim — no advisory needed. When refs < sizes, emit what
  // the seller asserted (+ catalog-driven fan-out for missing sizes when
  // available) and surface the lossy advisory so the buyer knows the
  // v1 wire is partial-coverage. Responsive ranges (min_*/max_*) are
  // always advisory — the v1 wire can't carry a range.
  if (decl.v1_format_ref && decl.v1_format_ref.length > 0) {
    const refs = decl.v1_format_ref;
    const lossy = detectLossyMultiSize(decl);
    if (lossy) {
      // Sizes mode: seller asserted ≥1 ref; try to widen via catalog
      // lookup when refs < sizes; otherwise emit seller's refs verbatim.
      // Responsive range: refs are the seller's representative anchors;
      // can't be widened.
      const declaredCount = lossy.count ?? 0;
      const sellerCoversAllSizes = lossy.mode === 'sizes' && refs.length >= declaredCount;
      if (sellerCoversAllSizes) {
        return { v1: refs };
      }
      const fanned = lossy.mode === 'sizes' && refs.length < declaredCount ? tryFanOutMultiSize(decl, refs) : null;
      // Merge: prefer the fanned-out catalog entries when they cover more sizes
      // than the seller's refs; otherwise emit seller's refs.
      const emit = fanned && fanned.length > refs.length ? fanned : refs;
      return {
        v1: emit,
        diagnostic: {
          source: 'sdk',
          sdk_id: SDK_ID,
          field,
          code: 'FORMAT_DECLARATION_V1_LOSSY_MULTI_SIZE',
          error: {
            details: {
              format_kind: decl.format_kind,
              product_id: productId,
              format_option_id: decl.format_option_id,
              size_mode: lossy.mode,
              declared_sizes_count: lossy.count,
              emitted_sizes_count: emit.length,
              v1_emit_represents_size: refs[0] ? { width: refs[0].width, height: refs[0].height } : undefined,
            },
          },
        },
      };
    }
    return { v1: refs };
  }

  // Steps 4-6: registry lookup.
  const result = reverseLookup(decl.format_kind, decl.params);
  if (result.kind === 'match') {
    // Step 4: non-normative best-effort. Documented limitation: the
    // synthesized agent_url is implementation-defined; downstream
    // consumers MUST NOT depend on this projection.
    return { v1: result.v1 };
  }
  if (result.kind === 'ambiguous') {
    // Step 5: family known, specific format not pickable.
    return {
      diagnostic: {
        source: 'sdk',
        sdk_id: SDK_ID,
        field,
        code: 'FORMAT_DECLARATION_V1_AMBIGUOUS',
        error: {
          details: {
            format_kind: decl.format_kind,
            product_id: productId,
            format_option_id: decl.format_option_id,
            registry_matches: result.matchedEntries,
          },
        },
      },
    };
  }
  // Step 6: registry-coverage gap.
  return {
    diagnostic: {
      source: 'sdk',
      sdk_id: SDK_ID,
      field,
      code: 'FORMAT_PROJECTION_FAILED',
      error: {
        details: {
          format_kind: decl.format_kind,
          product_id: productId,
          format_option_id: decl.format_option_id,
          resolution_failure: 'no_registry_match',
        },
      },
    },
  };
}

/**
 * Project a V2 Product to a v1 Product. Drops format_options from the
 * output and rebuilds format_ids per the resolution order.
 *
 * The function always returns a Product shape so adopters can inspect
 * what got dropped via diagnostics without parallel happy/sad-path
 * branches. Caller filters out v1 Products with empty format_ids before
 * sending to a v1-only seller (the spec requires `format_ids` to have
 * minItems: 1).
 */
export function projectV2ProductToV1(v2: V2Product): V2ToV1Result {
  const format_ids: V1FormatId[] = [];
  const diagnostics: ProjectionDiagnostic[] = [];

  for (let i = 0; i < v2.format_options.length; i++) {
    const decl = v2.format_options[i]!;
    const field = `products[${v2.product_id}].format_options[${i}]`;
    const { v1, diagnostic } = projectDeclaration(decl, v2.product_id, field);
    if (v1) {
      if (Array.isArray(v1)) {
        for (const id of v1) format_ids.push(id);
      } else {
        format_ids.push(v1);
      }
    }
    if (diagnostic) diagnostics.push(diagnostic);
  }

  const { format_options: _drop, ...rest } = v2;
  void _drop;
  const v1Product: V1Product = {
    ...(rest as Omit<V2Product, 'format_options'>),
    format_ids,
  } as V1Product;

  return { v1: v1Product, diagnostics };
}
