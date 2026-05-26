/**
 * Write-side ergonomics for V2-mental-model buyers.
 *
 * New beta.5+ code should use `packageRefsForFormatOptions`. It emits
 * `format_option_refs` for beta.5+ sellers plus optional legacy
 * `format_ids` for heterogeneous paths. The old capability-named exports
 * keep the beta.3 `capability_ids` surface for callers pinned to that
 * protocol version.
 */

import type { V1FormatId, V2ProductFormatDeclaration } from './types';

export type FormatOptionRef =
  | { scope: 'publisher'; publisher_domain: string; format_option_id: string }
  | { scope: 'product'; format_option_id: string; publisher_domain?: never };

export type FormatOptionSelector = string | { format_option_id: string; publisher_domain?: string };

/**
 * Result shape for {@link packageRefsForFormatOptions} - spread into a
 * `PackageRequest` to author a 3.1+ format-option package while keeping
 * legacy sellers working via dual emission.
 */
export interface PackageFormatRefs {
  /**
   * 3.1+ path. Structured references to product `format_options[]`
   * entries. Product-local options use `{ scope: 'product',
   * format_option_id }`; publisher-catalog-backed options use
   * `{ scope: 'publisher', publisher_domain, format_option_id }`.
   */
  format_option_refs: FormatOptionRef[];
  /**
   * Legacy named-format path. Omitted entirely when no chosen declaration
   * has a v1 form; emitting `[]` would violate the wire schema's
   * `minItems: 1` constraint.
   */
  format_ids?: V1FormatId[];
}

/**
 * Beta.3 compatibility shape emitted by {@link packageRefsForCapabilities}.
 * New beta.5 code should use {@link packageRefsForFormatOptions}; this keeps
 * callers pinned to the capability_id/capability_ids protocol surface working.
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

function declarationLabel(decl: V2ProductFormatDeclaration): string | undefined {
  if (!decl.format_option_id) return undefined;
  return decl.publisher_domain ? `${decl.publisher_domain}/${decl.format_option_id}` : decl.format_option_id;
}

function declarationToRef(decl: V2ProductFormatDeclaration): FormatOptionRef {
  if (!decl.format_option_id) {
    throw new Error('declarationToRef requires a declaration with format_option_id');
  }
  return decl.publisher_domain
    ? { scope: 'publisher', publisher_domain: decl.publisher_domain, format_option_id: decl.format_option_id }
    : { scope: 'product', format_option_id: decl.format_option_id };
}

function findDeclaration(
  opts: V2ProductFormatDeclaration[],
  selector: FormatOptionSelector
): V2ProductFormatDeclaration | undefined {
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
 * and produce `{ format_option_refs, format_ids? }` for `PackageRequest`.
 *
 * Selectors may be plain product-local IDs (`'nytimes_mrec'`) or
 * structured `{ format_option_id, publisher_domain }` selectors. Returned
 * refs are always structured per the beta.5 schema.
 */
export function packageRefsForFormatOptions(
  product: { format_options?: V2ProductFormatDeclaration[] },
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

  const selected: V2ProductFormatDeclaration[] = [];
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

  // De-dupe v1 refs across multiple chosen declarations. Include
  // dimensional discriminators in the key so multi-size declarations with
  // the same `{ agent_url, id }` but different sizes survive.
  const seen = new Set<string>();
  const format_ids: V1FormatId[] = [];
  for (const decl of selected) {
    for (const ref of decl.v1_format_ref ?? []) {
      const key = `${ref.agent_url}::${ref.id}::${ref.width ?? ''}x${ref.height ?? ''}::${ref.duration_ms ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      format_ids.push({ ...ref });
    }
  }

  return format_ids.length > 0 ? { format_option_refs, format_ids } : { format_option_refs };
}

export function packageRefsForCapabilities(
  product: { format_options?: V2ProductFormatDeclaration[] },
  capabilityIds: string[]
): PackageCapabilityRefs {
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
 * Compatibility alias for callers using the pre-GA helper name.
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
  return decl.capability_id ?? decl.format_option_id;
}
