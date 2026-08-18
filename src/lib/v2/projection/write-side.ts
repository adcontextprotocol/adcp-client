/**
 * Write-side ergonomics for V2-mental-model buyers.
 *
 * New beta.5+ code should use `packageRefsForFormatOptions`. It emits only
 * canonical `format_option_refs`; module-private weak storage lets the SDK
 * downgrade at the wire boundary without exposing legacy identifiers. The old capability-named exports
 * keep the beta.3 `capability_ids` surface for callers pinned to that
 * protocol version.
 */

import type { CanonicalFormatKind, V1FormatId, V2ProductFormatDeclaration } from './types';
import { warnOnce } from '../../utils/deprecation';
import { concealLegacyFormatRefs, concealSelectedFormatOptions } from './legacy-metadata';
import type { CanonicalFormatDeclaration } from './legacy-metadata';
import { projectV1ProductToV2, type LegacyFormatConverter } from './v1-to-v2';
import type { ProjectionCatalogSnapshot } from './catalog-snapshot';

export type FormatOptionRef =
  | {
      scope: 'publisher';
      publisher_domain: string;
      format_option_id: string;
      canonical_formats_only?: true;
    }
  | { scope: 'product'; format_option_id: string; publisher_domain?: never; canonical_formats_only?: true };

export type FormatOptionSelector = string | { format_option_id: string; publisher_domain?: string };

/**
 * Result shape for {@link packageRefsForFormatOptions} - spread into a
 * `PackageRequest` to author a canonical format-option package. The helper
 * retains downgrade metadata in module-private weak storage.
 */
export interface PackageFormatRefs {
  /**
   * 3.1+ path. Structured references to product `format_options[]`
   * entries. Product-local options use `{ scope: 'product',
   * format_option_id }`; publisher-catalog-backed options use
   * `{ scope: 'publisher', publisher_domain, format_option_id }`.
   */
  format_option_refs: FormatOptionRef[];
  /** Legacy identifiers are deliberately unavailable on the canonical SDK surface. */
  format_ids?: never;
}

/**
 * Beta.3 compatibility shape emitted by {@link packageRefsForCapabilities}.
 * New beta.5 code should use {@link packageRefsForFormatOptions}; this keeps
 * callers pinned to the beta.3 capability_id/capability_ids protocol surface
 * working. Beta.5+ sellers reject `capability_ids` on PackageRequest.
 */
export interface PackageCapabilityRefs {
  capability_ids: string[];
  format_ids?: V1FormatId[];
}

export type FormatOptionRefsLookupErrorCode =
  | 'unknown_format_option_id'
  | 'format_option_refs_not_published'
  | 'empty_input'
  | 'invalid_product';

export type CapabilityIdsLookupErrorCode =
  | 'unknown_capability_id'
  | 'capability_ids_not_published'
  | 'empty_input'
  | 'invalid_product';

/** Package selector fields inspected by {@link lintPackageFormatSelectorDimensions}. */
export interface PackageFormatSelectorInput {
  format_kind?: CanonicalFormatKind;
  params?: Readonly<Record<string, unknown>>;
  format_ids?: readonly V1FormatId[];
}

/** Optional seller-specific catalogs and context used to resolve legacy format IDs. */
export interface PackageFormatSelectorDimensionOptions {
  legacyFormatConverter?: LegacyFormatConverter;
  projectionCatalogs?: readonly ProjectionCatalogSnapshot[];
  /**
   * Preserve the caller's real product/path identity for product-aware legacy
   * converters. Omit only when the converter is context-independent.
   */
  projectionContext?: {
    productId: string;
    /** Field path of the package selector; defaults to the selector root. */
    field?: string;
  };
}

export interface FixedSizeDimensions {
  width: number;
  height: number;
}

export type PackageFormatSelectorDimensionDiagnosticCode =
  | 'FORMAT_SELECTOR_DIMENSIONS_INCOMPLETE'
  | 'FORMAT_SELECTOR_DIMENSIONS_INVALID'
  | 'FORMAT_SELECTOR_DIMENSIONS_MISMATCH';

/**
 * SDK-local, non-wire diagnostic returned by
 * {@link lintPackageFormatSelectorDimensions}.
 */
export interface PackageFormatSelectorDimensionDiagnostic {
  code: PackageFormatSelectorDimensionDiagnosticCode;
  field: string;
  selector: 'canonical' | 'legacy' | 'cross_projection';
  message: string;
  format_id_index?: number;
  canonical_dimensions?: FixedSizeDimensions;
  legacy_dimensions?: FixedSizeDimensions;
}

type DimensionInspection =
  | { kind: 'absent' }
  | { kind: 'non_fixed' }
  | { kind: 'incomplete' }
  | { kind: 'invalid' }
  | { kind: 'complete'; dimensions: FixedSizeDimensions };

function inspectFixedDimensions(params: Readonly<Record<string, unknown>> | undefined): DimensionInspection {
  if (!params) return { kind: 'absent' };
  const widthPresent = params.width !== undefined;
  const heightPresent = params.height !== undefined;
  if (widthPresent || heightPresent) {
    if (widthPresent !== heightPresent) return { kind: 'incomplete' };
    if (
      !Number.isInteger(params.width) ||
      (params.width as number) <= 0 ||
      !Number.isInteger(params.height) ||
      (params.height as number) <= 0
    ) {
      return { kind: 'invalid' };
    }
    return { kind: 'complete', dimensions: { width: params.width as number, height: params.height as number } };
  }

  if (Array.isArray(params.sizes)) {
    if (params.sizes.length !== 1) return { kind: 'non_fixed' };
    const only = params.sizes[0];
    if (only === null || typeof only !== 'object' || Array.isArray(only)) return { kind: 'invalid' };
    return inspectFixedDimensions(only as Readonly<Record<string, unknown>>);
  }

  if (
    params.min_width !== undefined ||
    params.max_width !== undefined ||
    params.min_height !== undefined ||
    params.max_height !== undefined
  ) {
    return { kind: 'non_fixed' };
  }
  return { kind: 'absent' };
}

function addInspectionDiagnostic(
  diagnostics: PackageFormatSelectorDimensionDiagnostic[],
  inspection: DimensionInspection,
  selector: 'canonical' | 'legacy',
  field: string,
  formatIdIndex?: number
): boolean {
  if (inspection.kind !== 'incomplete' && inspection.kind !== 'invalid') return false;
  diagnostics.push({
    code:
      inspection.kind === 'incomplete' ? 'FORMAT_SELECTOR_DIMENSIONS_INCOMPLETE' : 'FORMAT_SELECTOR_DIMENSIONS_INVALID',
    field,
    selector,
    message:
      inspection.kind === 'incomplete'
        ? `${field} must provide width and height together for a fixed-size image selector`
        : `${field} width and height must be positive integers for a fixed-size image selector`,
    ...(formatIdIndex !== undefined ? { format_id_index: formatIdIndex } : {}),
  });
  return true;
}

function inspectSelectorDimensions(
  params: Readonly<Record<string, unknown>> | undefined,
  diagnostics: PackageFormatSelectorDimensionDiagnostic[],
  selector: 'canonical' | 'legacy',
  field: string,
  formatIdIndex?: number
): { inspection: DimensionInspection; diagnosed: boolean } {
  const inspection = inspectFixedDimensions(params);
  if (!Array.isArray(params?.sizes)) {
    return {
      inspection,
      diagnosed: addInspectionDiagnostic(diagnostics, inspection, selector, field, formatIdIndex),
    };
  }

  const hasDirectDimensions = params.width !== undefined || params.height !== undefined;
  let diagnosed = hasDirectDimensions
    ? addInspectionDiagnostic(diagnostics, inspection, selector, field, formatIdIndex)
    : false;
  if (params.sizes.length === 0) {
    addInspectionDiagnostic(diagnostics, { kind: 'invalid' }, selector, `${field}.sizes`, formatIdIndex);
    return { inspection, diagnosed: true };
  }
  for (const [index, size] of params.sizes.entries()) {
    const inspectedSize =
      size !== null && typeof size === 'object' && !Array.isArray(size)
        ? inspectFixedDimensions(size as Readonly<Record<string, unknown>>)
        : ({ kind: 'invalid' } as const);
    const sizeInspection =
      inspectedSize.kind === 'absent' || inspectedSize.kind === 'non_fixed'
        ? ({ kind: 'invalid' } as const)
        : inspectedSize;
    diagnosed =
      addInspectionDiagnostic(diagnostics, sizeInspection, selector, `${field}.sizes[${index}]`, formatIdIndex) ||
      diagnosed;
  }
  return { inspection, diagnosed };
}

/**
 * Diagnose fixed-size image dimension loss across direct canonical and
 * deprecated legacy package selectors.
 *
 * This helper is deliberately advisory: it does not choose selector
 * precedence, mutate the package, or reject valid canonical-only,
 * legacy-only, multi-size, responsive, or inherently canonical-only shapes.
 * Legacy IDs are normalized through the same catalog/converter path as the
 * rest of the projection layer. An empty result means no dimensional issue
 * was found among selectors the SDK's built-in mappings and any configured
 * catalogs/converter could resolve; it is not proof that every seller-owned
 * legacy ID was resolvable.
 *
 * @example
 * ```ts
 * import { lintPackageFormatSelectorDimensions } from '@adcp/sdk/v2/projection';
 *
 * const diagnostics = lintPackageFormatSelectorDimensions(packageSelector, {
 *   projectionCatalogs: sellerCatalogs,
 *   legacyFormatConverter: convertSellerFormat,
 *   projectionContext: { productId: product.product_id, field: 'packages[0]' },
 * });
 * if (diagnostics.length > 0) report(diagnostics);
 * ```
 */
export function lintPackageFormatSelectorDimensions(
  selector: PackageFormatSelectorInput,
  options?: PackageFormatSelectorDimensionOptions
): PackageFormatSelectorDimensionDiagnostic[] {
  const diagnostics: PackageFormatSelectorDimensionDiagnostic[] = [];
  const paramsField = options?.projectionContext?.field ? `${options.projectionContext.field}.params` : 'params';
  const formatIdField = (index: number): string =>
    `${options?.projectionContext?.field ? `${options.projectionContext.field}.` : ''}format_ids[${index}]`;
  const canonicalImage = selector.format_kind === 'image';
  const canonicalResult = canonicalImage
    ? inspectSelectorDimensions(selector.params, diagnostics, 'canonical', paramsField)
    : { inspection: { kind: 'non_fixed' as const }, diagnosed: false };
  const canonicalInspection = canonicalResult.inspection;

  const legacyImages: Array<{ index: number; inspection: DimensionInspection }> = [];
  for (const [index, ref] of (selector.format_ids ?? []).entries()) {
    const field = formatIdField(index);
    const inlineResult = inspectSelectorDimensions(
      ref as unknown as Readonly<Record<string, unknown>>,
      diagnostics,
      'legacy',
      field,
      index
    );
    if (inlineResult.diagnosed) continue;

    const productId = options?.projectionContext?.productId ?? '<package-selector>';
    let converterDiagnosed = false;
    const legacyFormatConverter = options?.legacyFormatConverter
      ? (context: Parameters<LegacyFormatConverter>[0]) => {
          const converted = options.legacyFormatConverter?.({ ...context, productId, field });
          if (converted?.format_kind === 'image') {
            converterDiagnosed =
              inspectSelectorDimensions(converted.params, diagnostics, 'legacy', field, index).diagnosed ||
              converterDiagnosed;
          }
          return converted;
        }
      : undefined;

    const projection = projectV1ProductToV2(
      {
        product_id: productId,
        name: 'Package selector',
        description: 'Package selector dimensional lint',
        format_ids: [{ ...ref }],
      },
      { legacyFormatConverter, projectionCatalogs: options?.projectionCatalogs }
    );
    if (converterDiagnosed) continue;
    const dimensionalCatalogConflict =
      inlineResult.inspection.kind === 'complete' &&
      ref.duration_ms === undefined &&
      projection.diagnostics.some(
        diagnostic =>
          diagnostic.code === 'FORMAT_PROJECTION_FAILED' &&
          diagnostic.error.details.resolution_failure === 'catalog_requirement_conflict'
      );
    if (dimensionalCatalogConflict) {
      diagnostics.push({
        code: 'FORMAT_SELECTOR_DIMENSIONS_MISMATCH',
        field,
        selector: 'legacy',
        message: `${field} dimensions conflict with the resolved legacy format catalog`,
        format_id_index: index,
      });
      continue;
    }

    const projected = projection.v2.format_options[0];
    if (projected?.format_kind !== 'image') continue;
    const projectedResult = inspectSelectorDimensions(projected.params, diagnostics, 'legacy', field, index);
    if (!projectedResult.diagnosed) legacyImages.push({ index, inspection: projectedResult.inspection });
  }

  if (!canonicalImage || canonicalInspection.kind === 'non_fixed' || legacyImages.length === 0) {
    return diagnostics;
  }

  if (canonicalInspection.kind === 'absent' && !canonicalResult.diagnosed) {
    diagnostics.push({
      code: 'FORMAT_SELECTOR_DIMENSIONS_INCOMPLETE',
      field: paramsField,
      selector: 'canonical',
      message: `${paramsField} must provide width and height when a direct image selector is combined with legacy image selectors`,
    });
  }

  for (const legacy of legacyImages) {
    if (legacy.inspection.kind === 'absent') {
      diagnostics.push({
        code: 'FORMAT_SELECTOR_DIMENSIONS_INCOMPLETE',
        field: formatIdField(legacy.index),
        selector: 'legacy',
        message: `${formatIdField(legacy.index)} does not resolve to width and height for comparison with the direct image selector`,
        format_id_index: legacy.index,
      });
      continue;
    }
    if (
      canonicalInspection.kind === 'complete' &&
      legacy.inspection.kind === 'complete' &&
      (canonicalInspection.dimensions.width !== legacy.inspection.dimensions.width ||
        canonicalInspection.dimensions.height !== legacy.inspection.dimensions.height)
    ) {
      diagnostics.push({
        code: 'FORMAT_SELECTOR_DIMENSIONS_MISMATCH',
        field: formatIdField(legacy.index),
        selector: 'cross_projection',
        message:
          `${formatIdField(legacy.index)} resolves to ${legacy.inspection.dimensions.width}x${legacy.inspection.dimensions.height}, ` +
          `but the direct image selector declares ${canonicalInspection.dimensions.width}x${canonicalInspection.dimensions.height}`,
        format_id_index: legacy.index,
        canonical_dimensions: canonicalInspection.dimensions,
        legacy_dimensions: legacy.inspection.dimensions,
      });
    }
  }
  return diagnostics;
}

/**
 * Structured error from {@link packageRefsForFormatOptions}. Carries a
 * normalized `code` so adopters can branch fallback logic without
 * regex-matching the message.
 */
export class FormatOptionRefsLookupError extends Error {
  readonly code: FormatOptionRefsLookupErrorCode;
  /** Format option IDs or refs the caller requested. */
  readonly requested: readonly string[];
  /** Format option IDs/refs the product actually publishes (sorted). */
  readonly available: readonly string[];
  /** Requested entries that were not matched. */
  readonly missing: readonly string[];

  constructor(
    code: FormatOptionRefsLookupErrorCode,
    message: string,
    meta: { requested: readonly string[]; available: readonly string[]; missing: readonly string[] }
  ) {
    super(message);
    this.name = 'FormatOptionRefsLookupError';
    this.code = code;
    this.requested = meta.requested;
    this.available = meta.available;
    this.missing = meta.missing;
  }
}

export class CapabilityIdsLookupError extends Error {
  readonly code: CapabilityIdsLookupErrorCode;
  /** Capability IDs the caller requested. */
  readonly requested: readonly string[];
  /** Capability IDs the product actually publishes (sorted). */
  readonly available: readonly string[];
  /** Requested entries that were not matched. */
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

function selectorLabel(selector: FormatOptionSelector): string {
  if (typeof selector === 'string') return selector;
  return selector.publisher_domain
    ? `${selector.publisher_domain}/${selector.format_option_id}`
    : selector.format_option_id;
}

type SelectableFormatDeclaration = {
  format_option_id?: string;
  publisher_domain?: string;
};

function declarationLabel(decl: SelectableFormatDeclaration): string | undefined {
  if (!decl.format_option_id) return undefined;
  return decl.publisher_domain ? `${decl.publisher_domain}/${decl.format_option_id}` : decl.format_option_id;
}

function declarationToRef(decl: SelectableFormatDeclaration & { canonical_formats_only?: boolean }): FormatOptionRef {
  if (!decl.format_option_id) {
    throw new Error('declarationToRef requires a declaration with format_option_id');
  }
  return decl.publisher_domain
    ? {
        scope: 'publisher',
        publisher_domain: decl.publisher_domain,
        format_option_id: decl.format_option_id,
        ...(decl.canonical_formats_only === true && { canonical_formats_only: true as const }),
      }
    : {
        scope: 'product',
        format_option_id: decl.format_option_id,
        ...(decl.canonical_formats_only === true && { canonical_formats_only: true as const }),
      };
}

function findDeclaration<T extends SelectableFormatDeclaration>(
  opts: T[],
  selector: FormatOptionSelector
): T | undefined {
  if (typeof selector === 'string') {
    return opts.find(o => o.format_option_id === selector && !o.publisher_domain);
  }
  return opts.find(
    o =>
      o.format_option_id === selector.format_option_id &&
      (selector.publisher_domain ?? '') === (o.publisher_domain ?? '')
  );
}

function dedupeRefKey(ref: FormatOptionRef): string {
  return ref.scope === 'publisher'
    ? `publisher:${ref.publisher_domain}:${ref.format_option_id}`
    : `product:${ref.format_option_id}`;
}

/**
 * Resolve format option selectors against a product's `format_options[]`
 * and produce canonical `{ format_option_refs }` for `PackageRequest`.
 *
 * Selectors may be plain product-local IDs (`'nytimes_mrec'`) or
 * structured `{ format_option_id, publisher_domain }` selectors. Returned
 * refs are always structured per the beta.5 schema.
 */
export function packageRefsForFormatOptions(
  product: { format_options?: CanonicalFormatDeclaration[] },
  formatOptions: FormatOptionSelector[]
): PackageFormatRefs {
  const requested = formatOptions.map(selectorLabel);

  // Guard against the common mistake of passing the products[] array.
  if (product === null || typeof product !== 'object' || Array.isArray(product)) {
    throw new FormatOptionRefsLookupError(
      'invalid_product',
      `packageRefsForFormatOptions: expected a Product object with a format_options[] field, got ${Array.isArray(product) ? 'an array (did you pass `products` instead of `products[0]`?)' : typeof product}.`,
      { requested, available: [], missing: requested }
    );
  }
  if (formatOptions.length === 0) {
    throw new FormatOptionRefsLookupError(
      'empty_input',
      `packageRefsForFormatOptions requires at least one format_option_id. ` +
        `To accept seller defaults, omit format_option_refs from the package entirely.`,
      { requested, available: [], missing: [] }
    );
  }

  const opts = product.format_options ?? [];
  const addressable = opts.filter(o => Boolean(o.format_option_id));
  const available = addressable
    .map(declarationLabel)
    .filter((s): s is string => Boolean(s))
    .sort();
  const entriesWithoutFormatOptionId = opts.length - addressable.length;

  if (addressable.length === 0) {
    const detail =
      opts.length === 0
        ? `product has no format_options[] (legacy-format-only product shape, or product wasn't passed through getProducts auto-augmentation)`
        : `${opts.length} declarations on the product, ${entriesWithoutFormatOptionId} unaddressable via format_option_id (no entry publishes one)`;
    throw new FormatOptionRefsLookupError(
      'format_option_refs_not_published',
      `packageRefsForFormatOptions: product publishes no format_option_id values - ${detail}. ` +
        `The 3.1+ path is not authorable against this product. Fall back to legacyFormatIdsFromOptions ` +
        `or skip the product for format-option sellers.`,
      { requested, available: [], missing: requested.slice() }
    );
  }

  const selected: CanonicalFormatDeclaration[] = [];
  const missing: string[] = [];
  for (const selector of formatOptions) {
    const match = findDeclaration(addressable, selector);
    if (match) selected.push(match);
    else missing.push(selectorLabel(selector));
  }

  if (missing.length > 0) {
    const trailingNote =
      entriesWithoutFormatOptionId > 0
        ? ` (${entriesWithoutFormatOptionId} format_options[] entries publish no format_option_id and aren't addressable via this helper - use legacyFormatIdsFromOptions for those.)`
        : '';
    throw new FormatOptionRefsLookupError(
      'unknown_format_option_id',
      `packageRefsForFormatOptions: format option selectors ${JSON.stringify(missing)} ` +
        `not found in product.format_options[]. Available format options: ${JSON.stringify(available)}.${trailingNote}`,
      { requested, available, missing }
    );
  }

  const seenRefs = new Set<string>();
  const format_option_refs: FormatOptionRef[] = [];
  for (const decl of selected) {
    const ref = declarationToRef(decl);
    const key = dedupeRefKey(ref);
    if (seenRefs.has(key)) continue;
    seenRefs.add(key);
    format_option_refs.push(ref);
  }

  concealSelectedFormatOptions(
    format_option_refs,
    selected.map(declaration => concealLegacyFormatRefs(declaration))
  );
  return { format_option_refs };
}

/**
 * Resolve beta.3 `capability_id` selectors and emit beta.3
 * `{ capability_ids, format_ids? }` PackageRequest fields.
 *
 * @deprecated Beta.5+ sellers reject `capability_ids` on PackageRequest. Use
 * {@link packageRefsForFormatOptions} for beta.5+ sellers.
 */
export function packageRefsForCapabilities(
  product: { format_options?: V2ProductFormatDeclaration[] },
  capabilityIds: string[]
): PackageCapabilityRefs {
  warnOnce(
    'packageRefsForCapabilities.beta3-only',
    'packageRefsForCapabilities() emits beta.3-only capability_ids. Beta.5+ sellers reject capability_ids; use packageRefsForFormatOptions() for beta.5+ package requests.'
  );

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
  for (const opt of opts) {
    const id = capabilityIdForLookup(opt);
    if (id) {
      known.set(id, opt);
    } else {
      entriesWithoutCapabilityId += 1;
    }
  }
  const available = [...known.keys()].sort();
  if (known.size === 0) {
    const detail =
      opts.length === 0
        ? `product has no format_options[] (legacy-format-only product shape, or product wasn't passed through getProducts auto-augmentation)`
        : `${opts.length} declarations on the product, ${entriesWithoutCapabilityId} unaddressable via capability_id (no entry publishes one)`;
    throw new CapabilityIdsLookupError(
      'capability_ids_not_published',
      `packageRefsForCapabilities: product publishes no capability_ids - ${detail}. ` +
        `The beta.3 path is not authorable against this product. Fall back to legacyFormatIdsFromOptions ` +
        `or skip the product for capability_id sellers.`,
      { requested: capabilityIds, available: [], missing: capabilityIds.slice() }
    );
  }

  const missing = capabilityIds.filter(id => !known.has(id));
  if (missing.length > 0) {
    const trailingNote =
      entriesWithoutCapabilityId > 0
        ? ` (${entriesWithoutCapabilityId} format_options[] entries publish no capability_id and aren't addressable via this helper - use legacyFormatIdsFromOptions for those.)`
        : '';
    throw new CapabilityIdsLookupError(
      'unknown_capability_id',
      `packageRefsForCapabilities: capability_ids ${JSON.stringify(missing)} ` +
        `not found in product.format_options[]. Available capability_ids: ${JSON.stringify(available)}.${trailingNote}`,
      { requested: capabilityIds, available, missing }
    );
  }

  const seenCapabilities = new Set<string>();
  const dedupedCapabilityIds: string[] = [];
  for (const id of capabilityIds) {
    if (seenCapabilities.has(id)) continue;
    seenCapabilities.add(id);
    dedupedCapabilityIds.push(id);
  }

  const seen = new Set<string>();
  const format_ids: V1FormatId[] = [];
  for (const id of dedupedCapabilityIds) {
    const decl = known.get(id)!;
    for (const ref of decl.v1_format_ref ?? []) {
      const key = `${ref.agent_url}::${ref.id}::${ref.width ?? ''}x${ref.height ?? ''}::${ref.duration_ms ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      format_ids.push({ ...ref });
    }
  }

  return format_ids.length > 0
    ? { capability_ids: dedupedCapabilityIds, format_ids }
    : { capability_ids: dedupedCapabilityIds };
}

/**
 * Extract the legacy `format_ids[]` for a chosen V2 declaration.
 * Throws when the declaration has no v1 form.
 */
export function legacyFormatIdsFromOptions(decl: V2ProductFormatDeclaration): V1FormatId[] {
  const ids = tryLegacyFormatIdsFromOptions(decl);
  if (ids.length === 0) {
    const label = decl.format_option_id ?? decl.capability_id ?? decl.format_kind ?? '<unnamed>';
    const reason = decl.canonical_formats_only
      ? 'declaration is canonical_formats_only (seller opted out of v1 emission)'
      : `declaration carries no v1_format_ref[] (likely an inherently-v2 canonical like sponsored_placement / agent_placement / image_carousel / responsive_creative, or a custom shape without v1)`;
    throw new Error(
      `legacyFormatIdsFromOptions: '${label}' has no v1 representation - ${reason}. ` +
        `Pick a different format_options[] entry or skip this product for v1 sellers. ` +
        `Use tryLegacyFormatIdsFromOptions() if you want a non-throwing variant.`
    );
  }
  return ids;
}

/**
 * Non-throwing variant of {@link legacyFormatIdsFromOptions}. Returns
 * `[]` when the declaration has no v1 form.
 */
export function tryLegacyFormatIdsFromOptions(decl: V2ProductFormatDeclaration): V1FormatId[] {
  if (decl.v1_format_ref && decl.v1_format_ref.length > 0) {
    return decl.v1_format_ref.map(ref => ({ ...ref }));
  }
  return [];
}

/**
 * Resolve a `format_option_id` to its legacy `format_ids[]` against a
 * product's `format_options[]`.
 */
export function legacyFormatIdsForFormatOption(
  product: { format_options?: V2ProductFormatDeclaration[] },
  formatOption: FormatOptionSelector
): V1FormatId[] {
  const opts = product.format_options ?? [];
  const match = findDeclaration(opts, formatOption);
  if (!match) {
    const declared = opts.map(declarationLabel).filter((s): s is string => Boolean(s));
    throw new Error(
      `format option selector ${JSON.stringify(selectorLabel(formatOption))} not found in product.format_options[] ` +
        `(declared format options: ${declared.length > 0 ? JSON.stringify(declared) : '<none>'})`
    );
  }
  return legacyFormatIdsFromOptions(match);
}

/**
 * Compatibility alias for callers using the beta.3 helper name.
 *
 * @deprecated Emits beta.3-only `capability_ids`. Beta.5+ sellers reject that
 * field. Use {@link packageRefsForFormatOptions} for beta.5+ package requests.
 */
export function legacyFormatIdsForCapability(
  product: { format_options?: V2ProductFormatDeclaration[] },
  capabilityId: string
): V1FormatId[] {
  const opts = product.format_options ?? [];
  const match = opts.find(o => capabilityId === capabilityIdForLookup(o));
  if (!match) {
    const declared = opts.map(capabilityIdForLookup).filter((s): s is string => Boolean(s));
    throw new Error(
      `capability_id ${JSON.stringify(capabilityId)} not found in product.format_options[] ` +
        `(declared capability_ids: ${declared.length > 0 ? JSON.stringify(declared) : '<none>'})`
    );
  }
  return legacyFormatIdsFromOptions(match);
}

function capabilityIdForLookup(decl: V2ProductFormatDeclaration): string | undefined {
  // Migration alias: beta.3 catalogs used capability_id, beta.5 catalogs use
  // format_option_id. This beta.3 read path accepts either field so pinned
  // callers can bridge mixed catalog fixtures while they migrate.
  return decl.capability_id ?? decl.format_option_id;
}
