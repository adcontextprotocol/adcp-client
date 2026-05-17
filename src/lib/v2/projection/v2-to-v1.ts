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
 * Project a single V2 declaration. Returns either a v1 format_id to
 * emit, or a diagnostic to surface — never both, never neither (the
 * structural invariant the test suite asserts).
 */
function projectDeclaration(
  decl: V2ProductFormatDeclaration,
  productId: string,
  field: string
): { v1?: V1FormatId; diagnostic?: ProjectionDiagnostic } {
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
            capability_id: decl.capability_id,
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
            capability_id: decl.capability_id,
          },
        },
      },
    };
  }

  // Step 3: seller-asserted v1 link — the only normative path to a
  // specific v1 format_id. When the v2 params declare a multi-size
  // (`sizes: [...]`) or responsive range (`min_*`/`max_*`) shape,
  // the single v1 format_id can't represent the full coverage —
  // emit both the v1 ref AND a lossy-multi-size diagnostic so the
  // buyer knows N-1 sizes are missing on the v1 wire.
  if (decl.v1_format_ref) {
    const lossy = detectLossyMultiSize(decl);
    if (lossy) {
      return {
        v1: decl.v1_format_ref,
        diagnostic: {
          source: 'sdk',
          sdk_id: SDK_ID,
          field,
          code: 'FORMAT_DECLARATION_V1_LOSSY_MULTI_SIZE',
          error: {
            details: {
              format_kind: decl.format_kind,
              product_id: productId,
              capability_id: decl.capability_id,
              size_mode: lossy.mode,
              declared_sizes_count: lossy.count,
              v1_emit_represents_size: {
                width: decl.v1_format_ref.width,
                height: decl.v1_format_ref.height,
              },
            },
          },
        },
      };
    }
    return { v1: decl.v1_format_ref };
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
            capability_id: decl.capability_id,
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
          capability_id: decl.capability_id,
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
    if (v1) format_ids.push(v1);
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
