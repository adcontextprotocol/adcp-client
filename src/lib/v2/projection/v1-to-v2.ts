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

import type {
  V1Product,
  V1ProductInput,
  V1FormatId,
  V2Product,
  V2ProductFormatDeclaration,
  ProjectionDiagnostic,
  CanonicalFormatKind,
} from './types';
import { forwardLookupByGlob, forwardLookupByStructural } from './registry';
import { lookupUniqueV1FormatById, lookupV1Format, type V1FormatDefinition } from './catalog';
import { AAO_CANONICAL_AGENT_URL } from './constants';
import { LIBRARY_VERSION } from '../../version';
import { ProductFormatDeclarationSchema } from '../../types/schemas.generated';
import { legacyFormatConverterFromCatalogSnapshots, type ProjectionCatalogSnapshot } from './catalog-snapshot';
import { canonicalizeAgentUrl } from '../../discovery/resolve-agent-properties';
import { isLikelyPrivateUrl } from '../../net/address-guards';
import { createHmac } from 'crypto';
import { legacyRoutesForProduct } from './legacy-routes';
import type { CanonicalFormatLegacyRoute } from './legacy-routes';

const SDK_ID = `@adcp/sdk@${LIBRARY_VERSION}`;

class CatalogRequirementConflict extends Error {}

/**
 * Stable identity disambiguator, not a password hash. The input is a public
 * creative-format tuple and the output is a product-local routing label. As
 * with the transport cache disambiguators, HMAC-SHA256 with an empty key gives
 * deterministic collision resistance without placing this non-secret value
 * in CodeQL's password-storage dataflow class.
 */
function formatIdentityDisambiguator(identity: string): string {
  return createHmac('sha256', '').update(identity).digest('hex').slice(0, 32);
}

/**
 * Give an unnamed projected option a stable, opaque identity derived from the
 * complete legacy tuple. Positional IDs are unsafe: a seller reordering its
 * `format_ids` array could otherwise make a persisted canonical selection
 * resolve to a different legacy format on the next discovery refresh.
 */
function migratedFormatOptionId(fid: V1FormatId): string {
  const identity = JSON.stringify([
    fid.agent_url,
    fid.id,
    fid.width ?? null,
    fid.height ?? null,
    fid.duration_ms ?? null,
  ]);
  return `migrated_${formatIdentityDisambiguator(identity)}`;
}

export interface V1ToV2Result {
  v2: V2Product;
  diagnostics: ProjectionDiagnostic[];
  /** Serializable exact routes that can be persisted for a later legacy write. */
  legacyRoutes: CanonicalFormatLegacyRoute[];
}

/** Context passed to an adopter's seller-specific legacy format converter. */
export interface LegacyFormatConversionContext {
  formatId: Readonly<V1FormatId>;
  productId: string;
  field: string;
}

/**
 * Escape hatch for legacy formats owned by a custom creative agent. The
 * converter returns the canonical product declaration that the legacy ref
 * represents. For bespoke shapes, return `format_kind: 'custom'` with both
 * `format_shape` and an immutable `format_schema` reference.
 *
 * The SDK adds the source `formatId` as `v1_format_ref`; converters must not
 * set `canonical_formats_only: true` because a legacy source is, by
 * definition, round-trippable to that ref.
 */
export type LegacyFormatConverter = (
  context: LegacyFormatConversionContext
) => V2ProductFormatDeclaration | null | undefined;

export interface V1ToV2ProjectionOptions {
  legacyFormatConverter?: LegacyFormatConverter;
  /** Pre-resolved exact-owner publisher/community catalogs, highest precedence first. */
  projectionCatalogs?: readonly ProjectionCatalogSnapshot[];
  /** @internal Filesystem-isolated catalog fixture used by projector tests. */
  _catalogPath?: string;
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

  // Catalog-authored fixed requirements are normative projection inputs.
  // Prefer the primary render dimensions when there is exactly one fixed
  // size; otherwise accept one unambiguous width/height pair from the asset
  // requirements. A fixed duration is equally safe only when min === max.
  // Never guess from a name, a range, or conflicting requirements.
  const fixedSizes = new Map<string, { width: number; height: number }>();
  let hasUnsupportedSizeRequirement = false;
  for (const render of catalogEntry?.renders ?? []) {
    const width = render.dimensions?.width;
    const height = render.dimensions?.height;
    if (width === undefined && height === undefined) continue;
    if (
      typeof width === 'number' &&
      Number.isInteger(width) &&
      width > 0 &&
      typeof height === 'number' &&
      Number.isInteger(height) &&
      height > 0
    ) {
      fixedSizes.set(`${width}x${height}`, { width, height });
    } else hasUnsupportedSizeRequirement = true;
  }
  for (const asset of catalogEntry?.assets ?? []) {
    const width = asset.requirements?.width;
    const height = asset.requirements?.height;
    const minWidth = asset.requirements?.min_width;
    const maxWidth = asset.requirements?.max_width;
    const minHeight = asset.requirements?.min_height;
    const maxHeight = asset.requirements?.max_height;
    if (minWidth !== undefined || maxWidth !== undefined || minHeight !== undefined || maxHeight !== undefined) {
      if (
        typeof minWidth === 'number' &&
        Number.isInteger(minWidth) &&
        minWidth > 0 &&
        minWidth === maxWidth &&
        typeof minHeight === 'number' &&
        Number.isInteger(minHeight) &&
        minHeight > 0 &&
        minHeight === maxHeight
      ) {
        fixedSizes.set(`${minWidth}x${minHeight}`, { width: minWidth, height: minHeight });
      } else {
        hasUnsupportedSizeRequirement = true;
      }
    }
    if (width === undefined && height === undefined) continue;
    if (
      typeof width === 'number' &&
      Number.isInteger(width) &&
      width > 0 &&
      typeof height === 'number' &&
      Number.isInteger(height) &&
      height > 0
    ) {
      fixedSizes.set(`${width}x${height}`, { width, height });
    } else hasUnsupportedSizeRequirement = true;
  }
  if (fixedSizes.size > 1 || hasUnsupportedSizeRequirement) {
    throw new CatalogRequirementConflict('catalog contains conflicting fixed dimensions');
  }
  if (fixedSizes.size === 1) {
    const fixedSize = fixedSizes.values().next().value;
    if (fixedSize) {
      if (
        (typeof fid.width === 'number' && fid.width !== fixedSize.width) ||
        (typeof fid.height === 'number' && fid.height !== fixedSize.height)
      ) {
        throw new CatalogRequirementConflict('format id conflicts with catalog dimensions');
      }
      params.width = fixedSize.width;
      params.height = fixedSize.height;
    }
  }

  const fixedDurations = new Set<number>();
  let hasRangedDuration = false;
  for (const asset of catalogEntry?.assets ?? []) {
    const min = asset.requirements?.min_duration_ms;
    const max = asset.requirements?.max_duration_ms;
    if (min === undefined && max === undefined) continue;
    if (
      (min !== undefined && (typeof min !== 'number' || !Number.isInteger(min) || min <= 0)) ||
      (max !== undefined && (typeof max !== 'number' || !Number.isInteger(max) || max <= 0)) ||
      (typeof min === 'number' && typeof max === 'number' && min > max)
    ) {
      throw new CatalogRequirementConflict('catalog contains invalid duration requirements');
    }
    if (typeof min === 'number' && min === max) fixedDurations.add(min);
    else hasRangedDuration = true;
  }
  if (fixedDurations.size > 1 || hasRangedDuration) {
    throw new CatalogRequirementConflict('catalog contains conflicting fixed durations');
  }
  if (fixedDurations.size === 1) {
    const fixedDuration = fixedDurations.values().next().value;
    if (fixedDuration !== undefined) {
      if (typeof fid.duration_ms === 'number' && fid.duration_ms !== fixedDuration) {
        throw new CatalogRequirementConflict('format id conflicts with catalog duration');
      }
      params.duration_ms_exact = fixedDuration;
    }
  }

  // Inline discriminators narrow parameterized catalog templates. Concrete
  // catalog defaults were checked for contradictions above.
  if (typeof fid.width === 'number') params.width = fid.width;
  if (typeof fid.height === 'number') params.height = fid.height;
  if (typeof fid.duration_ms === 'number') params.duration_ms_exact = fid.duration_ms;
  return params;
}

function findLegacyCreativeIdentity(value: unknown, seen = new WeakSet<object>()): string | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = findLegacyCreativeIdentity(item, seen);
      if (nested) return nested;
    }
    return undefined;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/(^|_)(?:format_ids?|v1_format_ref|agent_url)($|_)/.test(key)) {
      return key;
    }
    const nested = findLegacyCreativeIdentity(child, seen);
    if (nested) return nested;
  }
  return undefined;
}

function projectWithLegacyConverter(
  fid: V1FormatId,
  productId: string,
  field: string,
  converter: LegacyFormatConverter | undefined
): { decl?: V2ProductFormatDeclaration; diagnostic?: ProjectionDiagnostic } | undefined {
  if (!converter) return undefined;
  try {
    const converted = converter({ formatId: { ...fid }, productId, field });
    if (!converted) return undefined;
    const forbidden = findLegacyCreativeIdentity(converted);
    if (forbidden) {
      throw new Error(`canonical conversion must not return ${forbidden}`);
    }
    const completed = { ...converted, v1_format_ref: [fid] };
    if (completed.canonical_formats_only === true) {
      throw new Error('a conversion from a legacy format cannot set canonical_formats_only: true');
    }
    if (
      completed.format_kind === 'custom' &&
      (typeof completed.format_shape !== 'string' ||
        completed.format_shape.trim().length === 0 ||
        !completed.format_schema)
    ) {
      throw new Error('custom conversions require format_shape and format_schema');
    }
    if (
      completed.format_kind === 'custom' &&
      (typeof completed.format_option_id !== 'string' || completed.format_option_id.trim().length === 0)
    ) {
      throw new Error('custom conversions require format_option_id');
    }
    const parsed = ProductFormatDeclarationSchema.safeParse(completed);
    if (!parsed.success) {
      throw new Error('converter returned an invalid canonical format declaration');
    }
    return { decl: parsed.data as V2ProductFormatDeclaration };
  } catch {
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
            resolution_failure: 'custom_converter_failed',
          },
        },
      },
    };
  }
}

/**
 * Project a single v1 `format_id` to a v2 `ProductFormatDeclaration`,
 * or to a diagnostic when no projection is possible.
 */
function projectFormatId(
  fid: V1FormatId,
  productId: string,
  field: string,
  options?: V1ToV2ProjectionOptions
): { decl?: V2ProductFormatDeclaration; diagnostic?: ProjectionDiagnostic } {
  const hasWidth = fid.width !== undefined;
  const hasHeight = fid.height !== undefined;
  const invalidDimensions =
    hasWidth !== hasHeight ||
    (hasWidth && (!Number.isInteger(fid.width) || fid.width! <= 0)) ||
    (hasHeight && (!Number.isInteger(fid.height) || fid.height! <= 0));
  const invalidDuration = fid.duration_ms !== undefined && (!Number.isInteger(fid.duration_ms) || fid.duration_ms <= 0);
  if (invalidDimensions || invalidDuration) {
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
            resolution_failure: 'invalid_format_id_parameters',
          },
        },
      },
    };
  }

  // A publisher/community catalog carrying an explicit v1_format_ref is the
  // most specific authoritative pairing. Public availability or a matching
  // format_option_id alone is not enough: canonical_formats_only declarations
  // and declarations without an alias do not participate here.
  const catalogSnapshot = projectWithLegacyConverter(
    fid,
    productId,
    field,
    legacyFormatConverterFromCatalogSnapshots(options?.projectionCatalogs)
  );
  if (catalogSnapshot) return catalogSnapshot;

  // Prefer the protocol-correct composite identity. During the legacy
  // migration, deployed sellers have also copied AAO standard IDs while
  // putting their own creative-agent URL in the tuple. Treat that as an
  // inbound alias only when the AAO catalog publishes exactly one entry for
  // the bare ID. `buildParams` below still rejects contradictory inline
  // dimensions/duration, and the emitted v1_format_ref preserves `fid` so a
  // legacy write routes back to the seller rather than the AAO host.
  const exactCatalogEntry = lookupV1Format(fid, options?._catalogPath);
  const canonicalAgentUrl = canonicalizeAgentUrl(fid.agent_url);
  const mayUseUniqueAlias =
    canonicalAgentUrl !== null &&
    new URL(canonicalAgentUrl).protocol === 'https:' &&
    !isLikelyPrivateUrl(canonicalAgentUrl);
  const uniqueAliasEntry =
    exactCatalogEntry === undefined && mayUseUniqueAlias
      ? lookupUniqueV1FormatById(fid.id, options?._catalogPath)
      : undefined;
  if (uniqueAliasEntry) {
    // A caller-authored converter is more specific than this compatibility
    // heuristic. Returning undefined opts into the AAO bare-ID fallback;
    // invalid/throwing converter output fails closed and is never bypassed.
    const explicit = projectWithLegacyConverter(fid, productId, field, options?.legacyFormatConverter);
    if (explicit) return explicit;
  }
  const catalogEntry = exactCatalogEntry ?? uniqueAliasEntry;

  // Step 1: v1 catalog has an explicit `canonical` annotation. Always
  // object-shaped per `canonical-projection-ref.json`: required `kind`,
  // optional `asset_source` + `slots_override`. Carry the refinement
  // fields onto the v2 declaration so the projection preserves the
  // spec-authored intent (generative AI projects with text-prompt slot;
  // native projects with extended slot set; etc.).
  if (catalogEntry?.canonical) {
    const projection = catalogEntry.canonical;
    let params: Record<string, unknown>;
    try {
      params = buildParams(fid, {}, catalogEntry);
    } catch (error) {
      if (!(error instanceof CatalogRequirementConflict)) throw error;
      return {
        diagnostic: {
          source: 'sdk',
          sdk_id: SDK_ID,
          field,
          code: 'FORMAT_PROJECTION_FAILED',
          error: {
            details: {
              format_kind: projection.kind,
              product_id: productId,
              resolution_failure: 'catalog_requirement_conflict',
            },
          },
        },
      };
    }
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
    const custom = projectWithLegacyConverter(fid, productId, field, options?.legacyFormatConverter);
    if (custom) return custom;
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

  // Step 4: give the adopter one explicit, typed escape hatch for a
  // seller/creative-agent-owned legacy format. This runs only after all
  // protocol-owned mappings fail, so a callback cannot override a canonical
  // AAO mapping accidentally.
  const custom = projectWithLegacyConverter(fid, productId, field, options?.legacyFormatConverter);
  if (custom) return custom;

  // Step 5: fail-closed. v1 product is invisible on the canonical side.
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
 *
 * @see canonicalDeclarationFromBareId — resolve a single bare format-id
 * string (no surrounding Product) to a declaration or `format_kind`.
 */
export function projectV1ProductToV2(v1: V1ProductInput, options?: V1ToV2ProjectionOptions): V1ToV2Result {
  const format_options: V2ProductFormatDeclaration[] = [];
  const diagnostics: ProjectionDiagnostic[] = [];

  const inputFormatIds = v1.format_ids ?? [];
  for (let i = 0; i < inputFormatIds.length; i++) {
    const fid = inputFormatIds[i]! as V1FormatId;
    const field = `products[${v1.product_id}].format_ids[${i}]`;
    const { decl, diagnostic } = projectFormatId(fid, v1.product_id, field, options);
    if (decl) {
      format_options.push(
        typeof decl.format_option_id === 'string' && decl.format_option_id.length > 0
          ? decl
          : { ...decl, format_option_id: migratedFormatOptionId(fid) }
      );
    }
    if (diagnostic) diagnostics.push(diagnostic);
  }

  const { format_ids: _drop, ...rest } = v1;
  void _drop;
  const v2Product: V2Product = {
    ...(rest as Omit<V1ProductInput, 'format_ids'>),
    format_options,
  } as V2Product;

  return { v2: v2Product, diagnostics, legacyRoutes: legacyRoutesForProduct(v1.product_id, format_options) };
}

export interface BareFormatIdResolveOptions {
  /**
   * `agent_url` to attach when lifting the bare `id` to a structured
   * {@link V1FormatId} for resolution. Defaults to the canonical AAO host
   * (`https://creative.adcontextprotocol.org/`) — the publisher of every
   * AAO catalog id, and the source of essentially all bare ids persisted
   * before the `{ agent_url, id }` convention. When an exact ID has one
   * unique AAO-published meaning, a valid non-AAO `agentUrl` is accepted as
   * a legacy owner alias and is preserved in `v1_format_ref`. Unknown or
   * colliding IDs still resolve to `null`.
   */
  agentUrl?: string;

  /**
   * Asset-type disambiguator for an under-specified bare id. The AAO
   * catalog names per-asset-type variants `<base>_<suffix>` (e.g.
   * `display_300x250` → `display_300x250_image` / `_html` / `_generative`).
   * A size-only bare id like `display_300x250` is genuinely ambiguous and
   * resolves to `null` on its own; pass the asset type you already hold
   * (an adopter's `format_type`) and the resolver retries the disambiguated
   * catalog variant `<id>_<suffix>`.
   *
   * The vocabulary is the catalog asset type where it differs from the
   * variant suffix (`javascript` → `_js`), otherwise the suffix itself
   * (`image`, `html`, `generative`, `js`). Canonical-kind aliases are also
   * accepted (`html5` → `html`, `display_tag` → `js`) for callers already
   * holding a kind-like local value.
   *
   * Only consulted when the bare id does NOT resolve on its own (a real
   * catalog id is authoritative). Still fails closed: if `<id>_<suffix>`
   * is not a catalog entry, returns `null` — the hint narrows, it never
   * fabricates.
   */
  assetType?: string;

  /**
   * @deprecated Use `assetType`. Kept as a backwards-compatible alias for
   * callers who adopted the initial helper surface before issue #2289.
   */
  assetTypeHint?: string;
}

/**
 * Resolve a bare v1 format-id string to its full v2
 * `ProductFormatDeclaration`, or `null` when the id has no canonical
 * mapping.
 *
 * Adopters migrating off legacy format storage routinely hold a bare id
 * (`display_300x250_image`, `video_standard_30s`) persisted before the
 * `{ agent_url, id }` structured-ref convention. This lifts that bare id
 * to a structured ref (via `agentUrl`, default the AAO host) and runs the
 * exact resolution the v1 → v2 product projection uses — in the registry
 * spec's `v1-canonical-mapping.json` resolution order:
 *
 *   - AAO catalog `canonical:` annotation — the authoritative
 *     seller-asserted mapping (registry resolution-order step 2).
 *   - Registry `format_id_glob` literal match (registry resolution-order
 *     step 3) — future-proof; 3.1 ships zero literal globs, so this fires
 *     only when a future registry adds platform-specific literals.
 *
 * Fails closed: returns `null` — never a guess — when neither path
 * resolves the id. That covers an unknown id, an under-specified id
 * (`display_300x250`, which the catalog only carries as `_image` /
 * `_html` / `_generative` variants), and a catalog entry the AAO has not
 * yet annotated with a `canonical:`. Structural matching never
 * contributes a kind: a bare id absent from the catalog carries no asset
 * shape to match on, and a catalog entry lacking a `canonical:` fails
 * closed before the structural step is reached.
 *
 * For an under-specified bare id, pass `assetType` (the asset type you
 * already hold, such as an adopter's `format_type`) and the resolver retries
 * the disambiguated catalog variant
 * `<id>_<suffix>` — so the SDK owns the `_image` / `_html` suffix
 * convention instead of every adopter re-deriving it. The hint is
 * consulted only when the bare id doesn't resolve on its own, and still
 * fails closed when the disambiguated id isn't a catalog entry.
 *
 * The returned declaration carries `v1_format_ref: [{ agent_url, id }]`
 * (the resolved id — the disambiguated `<id>_<suffix>` when a hint
 * applied), so adopters lift a bare id to a structured ref in one step
 * (the pre-projection step the migration docs encourage).
 *
 * Like the rest of the projection layer, this requires the bundled AAO
 * catalog + canonical-mapping registry; it throws (rather than returning
 * `null`) only when those are missing from the install — a corrupted
 * `@adcp/sdk` package, not a normal unresolved-id outcome.
 *
 * For just the `format_kind`, use {@link resolveCanonicalFormatKind}. For
 * the structured diagnostic explaining *why* an id did not resolve, run
 * it through {@link projectV1ProductToV2} inside a one-format product.
 */
export function canonicalDeclarationFromBareId(
  id: string,
  options?: BareFormatIdResolveOptions
): V2ProductFormatDeclaration | null {
  if (!id) return null;
  const agentUrl = options?.agentUrl ?? AAO_CANONICAL_AGENT_URL;

  // A real catalog id is authoritative — resolve it directly first.
  const direct = projectFormatId({ agent_url: agentUrl, id }, `<bare:${id}>`, `bareFormatId(${id})`).decl;
  if (direct) return direct;

  // Under-specified bare id + an asset-type hint: retry the disambiguated
  // catalog variant `<id>_<suffix>`. Fails closed if that isn't a catalog
  // entry either — the hint narrows, it never fabricates.
  const assetType = options?.assetType ?? options?.assetTypeHint;
  const suffix = assetType ? normalizeAssetTypeSuffix(assetType) : '';
  if (suffix) {
    const disambiguated = `${id}_${suffix}`;
    const hinted = projectFormatId(
      { agent_url: agentUrl, id: disambiguated },
      `<bare:${disambiguated}>`,
      `bareFormatId(${disambiguated})`
    ).decl;
    if (hinted) return hinted;
  }

  return null;
}

/**
 * Map an `assetType` to the AAO catalog's `<base>_<suffix>` suffix.
 * Catalog asset type `javascript` and canonical-kind names that differ from
 * their suffix (`html5`, `display_tag`) are aliased. Any other value is passed
 * through lowercased so a future asset type or suffix resolves without a code
 * change — an unknown value simply misses the catalog and the caller fails
 * closed.
 */
function normalizeAssetTypeSuffix(hint: string): string {
  const h = hint.trim().toLowerCase();
  if (h === 'html5') return 'html';
  if (h === 'javascript') return 'js';
  if (h === 'display_tag') return 'js';
  return h;
}

/**
 * Resolve a bare v1 format-id string to its canonical `format_kind`, or
 * `null` when the id has no canonical mapping. Registry- and
 * catalog-backed: the single source of truth that replaces hand-rolled
 * `inferFormatKindFromFormatId` heuristics adopters maintain locally.
 *
 * Thin projection of {@link canonicalDeclarationFromBareId} down to the
 * `format_kind`; see it for the resolution order, fail-closed semantics,
 * the `agentUrl` default, and the `assetType` disambiguator.
 */
export function resolveCanonicalFormatKind(
  id: string,
  options?: BareFormatIdResolveOptions
): CanonicalFormatKind | null {
  return canonicalDeclarationFromBareId(id, options)?.format_kind ?? null;
}
