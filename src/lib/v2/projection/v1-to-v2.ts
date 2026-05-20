/**
 * v1 → v2 Product projection (the upgrade direction).
 *
 * Used when the SDK is talking to a v1 seller but the buyer wrote V2
 * code. The 8.0 design at `docs/development/v3.1-sdk-design.md` makes
 * V2 the public mental model — the buyer never sees `Product.format_ids`
 * directly, only `Product.format_options`. This module is the wire-
 * boundary translator that makes that promise hold for v1 sellers.
 *
 * Resolution order per format_id, mirroring `v1-canonical-mapping.json`
 * step 1-4 in the forward direction:
 *
 *   1. **v1 catalog explicit `canonical` annotation**. If the v1 format
 *      definition (from `reference-formats.json` or a seller's
 *      `list_creative_formats`) carries `canonical: <kind>`, that's the
 *      authoritative pairing. Seller-asserted, normative.
 *   2. **Registry glob match**. Look up `format_id.id` against the
 *      registry's `format_id_glob` entries (including wildcards). First
 *      match wins per the spec's ordering.
 *   3. **Structural match**. Match against the v1 format's declared
 *      assets + version constraints. Family-level identification
 *      yields a canonical (e.g., "vast 4.x → video_vast"). Less
 *      precise on params; caller may need to fetch additional context.
 *   4. **Fail closed** → `FORMAT_PROJECTION_FAILED`. v1 product with
 *      no catalog entry, no registry coverage, and no structural match
 *      is invisible on the v2 side. SDK surfaces the diagnostic so
 *      buyers know what got dropped.
 *
 * **Asymmetry vs the v2 → v1 direction**: every v1 format_id is a
 * specific thing, so there's no "ambiguous family" bucket here — if
 * the structural match identifies a family, the projection is
 * deterministic for that single format_id.
 *
 * **Scope (prototype)**:
 *   - AAO catalog only — seller-specific catalogs (publisher's own
 *     `list_creative_formats`) require an AgentClient hook the auto-
 *     negotiation surface will provide in the full 8.0 enablement.
 *   - Param extraction is dimensions-only (`width`, `height`,
 *     `duration_ms`). Full canonical-specific params (slots, codecs,
 *     char limits, platform_extensions) are not constructed. A v2
 *     buyer reading the projected declaration's `params` sees the
 *     minimum needed to identify the variant.
 *   - Asset slot translation (v1 `assets[]` → v2 `slots[]` via the
 *     asset_group_vocabulary aliases) is deliberately deferred. This
 *     is the most adopter-relevant piece for actual creative
 *     submission flows and lands in a follow-up.
 */

import type { V1Product, V1FormatId, V2Product, V2ProductFormatDeclaration, ProjectionDiagnostic } from './types';
import { forwardLookupByGlob, forwardLookupByStructural } from './registry';
import { lookupV1Format, type V1FormatDefinition } from './catalog';
import { LIBRARY_VERSION } from '../../version';

const SDK_ID = `@adcp/sdk@${LIBRARY_VERSION}`;

export interface V1ToV2Result {
  v2: V2Product;
  diagnostics: ProjectionDiagnostic[];
}

/**
 * Build the v2 declaration's `params` block from the v1 format_id's
 * dimensional overrides + the catalog/registry entry's recorded params.
 *
 * Prototype scope: dimensions + duration only. A full implementation
 * would walk the canonical's parameter schema and populate every field
 * the catalog entry hints at (codecs, char limits, platform_extensions).
 */
function buildParams(
  fid: V1FormatId,
  registryParams: Record<string, unknown>,
  catalogEntry?: V1FormatDefinition
): Record<string, unknown> {
  const params: Record<string, unknown> = { ...registryParams };
  if (typeof fid.width === 'number') params.width = fid.width;
  if (typeof fid.height === 'number') params.height = fid.height;
  if (typeof fid.duration_ms === 'number') params.duration_ms_exact = fid.duration_ms;
  // Catalog entries occasionally pin codec/format requirements at the
  // asset level. Surface them when present and unambiguous, but don't
  // try to compose the full v2 param shape — that's caller territory.
  if (catalogEntry?.accepts_parameters) {
    params.accepts_parameters = catalogEntry.accepts_parameters;
  }
  return params;
}

/**
 * Project a single v1 `format_id` to a v2 `ProductFormatDeclaration`,
 * or to a diagnostic when no projection is possible.
 */
function projectFormatId(
  fid: V1FormatId,
  productId: string,
  field: string
): { decl?: V2ProductFormatDeclaration; diagnostic?: ProjectionDiagnostic } {
  const catalogEntry = lookupV1Format(fid);

  // Step 1: v1 catalog has an explicit `canonical` annotation. Always
  // object-shaped per `canonical-projection-ref.json`: required `kind`,
  // optional `asset_source` + `slots_override`. Carry the refinement
  // fields onto the v2 declaration so the projection preserves the
  // spec-authored intent (generative AI projects with text-prompt slot;
  // native projects with extended slot set; etc.).
  if (catalogEntry?.canonical) {
    const projection = catalogEntry.canonical;
    const params = buildParams(fid, {}, catalogEntry);
    if (projection.asset_source) params.asset_source = projection.asset_source;
    if (projection.slots_override) params.slots = projection.slots_override;
    return {
      decl: {
        format_kind: projection.kind,
        params,
        v1_format_ref: [fid],
      },
    };
  }

  // Step 1b: catalog HAS the entry but no `canonical:` annotation. This
  // is the AAO saying "no v2 mapping yet for this category" — at 3.1
  // GA, native/DOOH/broadcast/card-scaffolding sit in this bucket.
  // Falling through to structural match would shoehorn the format to
  // a coarse `display_tag` based on a `url` asset (or similar) — which
  // contradicts the AAO's deliberate absence of annotation. Fail-closed
  // honestly so the buyer sees "category not yet v2-mapped" rather than
  // a semantically wrong projection. Symmetric counterpart to
  // CANONICAL_NOT_V1_TRANSLATABLE on the v2→v1 side.
  if (catalogEntry && !catalogEntry.canonical) {
    return {
      diagnostic: {
        source: 'sdk',
        sdk_id: SDK_ID,
        field,
        code: 'FORMAT_PROJECTION_FAILED',
        error: {
          details: {
            format_kind: 'custom',
            product_id: productId,
            resolution_failure: 'catalog_lacks_canonical_annotation',
          },
        },
      },
    };
  }

  // Step 2: format not in the AAO catalog. Try registry glob match
  // against format_id.id. Catches publisher-bespoke ids that share the
  // AAO catalog's naming convention.
  const globMatch = forwardLookupByGlob(fid.id);
  if (globMatch) {
    return {
      decl: {
        format_kind: globMatch.canonical,
        params: buildParams(fid, globMatch.parameters),
        v1_format_ref: [fid],
      },
    };
  }

  // Step 3: structural match — only fires when the format is NOT in the
  // catalog (Step 1b ate the catalog-known-but-unannotated case). For
  // truly bespoke publisher formats this is the best signal we have:
  // a VAST tag is a VAST tag regardless of seller naming.
  if (catalogEntry?.assets) {
    const assetTypes = catalogEntry.assets.map(a => a.asset_type).filter((t): t is string => typeof t === 'string');
    const structMatch = forwardLookupByStructural({ asset_types: assetTypes });
    if (structMatch) {
      return {
        decl: {
          format_kind: structMatch.canonical,
          params: buildParams(fid, structMatch.parameters, catalogEntry),
          v1_format_ref: [fid],
        },
      };
    }
  }

  // Step 4: fail-closed. v1 product is invisible on the v2 side.
  return {
    diagnostic: {
      source: 'sdk',
      sdk_id: SDK_ID,
      field,
      code: 'FORMAT_PROJECTION_FAILED',
      error: {
        details: {
          format_kind: 'custom',
          product_id: productId,
          resolution_failure: 'no_match',
        },
      },
    },
  };
}

/**
 * Project a v1 Product to a v2 Product. Drops `format_ids` from the
 * public output and rebuilds `format_options` per the resolution order.
 *
 * Caller decides what to do with the result when `format_options` is
 * empty — typically filter the product out of the response payload to
 * a v2-only buyer (the spec requires `format_options` to have
 * `minItems: 1` when present). The function always returns a Product
 * shape so adopters can inspect what got dropped via diagnostics.
 */
export function projectV1ProductToV2(v1: V1Product): V1ToV2Result {
  const format_options: V2ProductFormatDeclaration[] = [];
  const diagnostics: ProjectionDiagnostic[] = [];

  for (let i = 0; i < v1.format_ids.length; i++) {
    const fid = v1.format_ids[i]!;
    const field = `products[${v1.product_id}].format_ids[${i}]`;
    const { decl, diagnostic } = projectFormatId(fid, v1.product_id, field);
    if (decl) format_options.push(decl);
    if (diagnostic) diagnostics.push(diagnostic);
  }

  const { format_ids: _drop, ...rest } = v1;
  void _drop;
  const v2Product: V2Product = {
    ...(rest as Omit<V1Product, 'format_ids'>),
    format_options,
  } as V2Product;

  return { v2: v2Product, diagnostics };
}
