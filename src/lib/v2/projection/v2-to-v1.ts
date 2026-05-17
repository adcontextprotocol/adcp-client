/**
 * v2 → v1 Product projection (the downgrade direction).
 *
 * Used when the SDK negotiated to a v1 seller for a buyer that wrote V2
 * code. The 8.0 design at `docs/development/v3.1-sdk-design.md` makes
 * V2 the public mental model — adopters never see v1 vocabulary on
 * `Product` — so this is the symmetric counterpart to v1→v2 projection
 * on the read side.
 *
 * Resolution order per declaration (mirrors `v1-canonical-mapping.json`'s
 * forward order, inverted):
 *
 *   1. `format_kind: "custom"` + `canonical_formats_only: true` → no v1
 *      emit. Diagnostic surfaces explicit opt-out. The buyer's catalog
 *      simply loses this product when downgraded to a v1-only seller —
 *      consistent with the spec's "no synthetic aao-synth/ namespace"
 *      rule.
 *   2. `v1_format_ref` present → use it verbatim. Highest-confidence path
 *      — seller has explicitly asserted the v1/v2 equivalence.
 *   3. Registry reverse-lookup → invertible match (canonical + params
 *      narrows compatibly to a literal v1 named format).
 *   4. Registry says "ambiguous" → no v1 emit; diagnostic surfaces that
 *      a mapping family exists but isn't deterministic.
 *   5. Registry says "none" → no v1 emit; diagnostic surfaces that no
 *      registry entry covers this canonical at all.
 *
 * In all non-(1,2,3) paths, the resulting v1 Product is **product-shape-
 * valid but missing this declaration**. Two adopter consequences:
 *
 *   - If a product has multiple format_options[] and SOME project: the
 *     v1 buyer sees the product but with fewer format_ids than the v2
 *     buyer would see options.
 *   - If a product has ONLY non-projectable format_options[]: the v1
 *     buyer doesn't see the product at all (it'd violate the spec's
 *     "format_ids minItems: 1" if we emitted it empty). Caller should
 *     filter out v1 Products with empty format_ids before sending.
 */

import type { V2Product, V2ProductFormatDeclaration, V1Product, V1FormatId, ProjectionDiagnostic } from './types';
import { reverseLookup } from './registry';

export interface V2ToV1Result {
  v1: V1Product;
  diagnostics: ProjectionDiagnostic[];
}

/**
 * Project a single V2 declaration to a v1 format_id when possible.
 * Returns null when the declaration has no clean v1 form (caller drops
 * it and emits a diagnostic from the outer function).
 */
function projectDeclaration(
  decl: V2ProductFormatDeclaration,
  field: string
): { v1?: V1FormatId; diagnostic?: ProjectionDiagnostic } {
  // Step 1: explicit fail-closed.
  if (decl.format_kind === 'custom' && decl.canonical_formats_only === true) {
    return {
      diagnostic: {
        code: 'FORMAT_DECLARATION_V1_UNREACHABLE',
        field,
        details: {
          format_kind: decl.format_kind,
          capability_id: decl.capability_id,
          reason: 'canonical_formats_only',
          hint: "This declaration explicitly opts out of v1 emission. v1-only buyers won't see this product.",
        },
      },
    };
  }

  // Step 2: seller-asserted v1 link.
  if (decl.v1_format_ref) {
    return { v1: decl.v1_format_ref };
  }

  // Steps 3-5: registry reverse-lookup.
  const result = reverseLookup(decl.format_kind, decl.params);
  if (result.kind === 'match') {
    return { v1: result.v1 };
  }
  if (result.kind === 'ambiguous') {
    return {
      diagnostic: {
        code: 'FORMAT_DECLARATION_V1_AMBIGUOUS',
        field,
        details: {
          format_kind: decl.format_kind,
          capability_id: decl.capability_id,
          matched_registry_entries: result.matchedEntries,
          hint: result.hint,
        },
      },
    };
  }
  // result.kind === 'none'
  return {
    diagnostic: {
      code: 'FORMAT_DECLARATION_V1_UNREACHABLE',
      field,
      details: {
        format_kind: decl.format_kind,
        capability_id: decl.capability_id,
        reason: 'no_v1_format_ref_or_registry_match',
        hint:
          `No registry entry exists for canonical "${decl.format_kind}". ` +
          `Add v1_format_ref to the declaration if a v1 named format exists.`,
      },
    },
  };
}

/**
 * Project a V2 Product to a v1 Product. Drops format_options from the
 * output and rebuilds format_ids per the resolution order.
 *
 * Caller decides what to do with the result when format_ids is empty —
 * typically filter the product out of the response payload to a v1-only
 * seller. The function always returns a Product shape so adopters can
 * inspect what got dropped via diagnostics without parallel
 * happy/sad-path branches.
 */
export function projectV2ProductToV1(v2: V2Product): V2ToV1Result {
  const format_ids: V1FormatId[] = [];
  const diagnostics: ProjectionDiagnostic[] = [];

  for (let i = 0; i < v2.format_options.length; i++) {
    const decl = v2.format_options[i]!;
    const field = `products[${v2.product_id}].format_options[${i}]`;
    const { v1, diagnostic } = projectDeclaration(decl, field);
    if (v1) format_ids.push(v1);
    if (diagnostic) diagnostics.push(diagnostic);
  }

  // Strip format_options from the v1 output. Cast through unknown
  // because TypeScript can't widen V2Product → V1Product at a value
  // level (they differ in their required fields).
  const { format_options: _drop, ...rest } = v2;
  void _drop;
  const v1Product: V1Product = {
    ...(rest as Omit<V2Product, 'format_options'>),
    format_ids,
  } as V1Product;

  return { v1: v1Product, diagnostics };
}
