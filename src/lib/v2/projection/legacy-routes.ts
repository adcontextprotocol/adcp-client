import type { FormatOptionReference } from '../../types/tools.generated';
import { legacyFormatRefsForDeclaration, sellerDeclaredFormatOption } from './legacy-metadata';
import type { CanonicalFormatLegacyResolutionContext, CanonicalFormatLegacyResolver } from './v2-to-v1';
import type { V1FormatId, V2ProductFormatDeclaration } from './types';

/**
 * Serializable canonical-to-legacy routing identity.
 *
 * Persist this sidecar next to a canonical product or selection when the
 * selected format may later need to cross a legacy creative wire. Unlike the
 * SDK's WeakMap metadata, every owner and dimensional discriminator survives
 * JSON serialization.
 */
export interface CanonicalFormatLegacyRoute {
  product_id: string;
  format_option_ref: FormatOptionReference;
  format_ids: V1FormatId[];
  /**
   * Whether the seller declared this option in its own `format_options[]`.
   * `false` means the SDK derived the option from the seller's legacy
   * `format_ids`, so the seller cannot resolve its `format_option_id` and a
   * canonical-wire write addresses it by `canonical_selector` instead. Absent
   * when the origin is unknown; such routes leave canonical writes unchanged.
   */
  seller_declared?: boolean;
  /**
   * The direct `format_kind` + `params` selector for an option the seller did
   * not declare. Absent when no direct selector keeps the option's identity,
   * such as a custom or schema-backed format, so a write selecting it fails
   * before dispatch.
   */
  canonical_selector?: { format_kind: string; params?: unknown };
}

/** The direct canonical selector for a format option the seller did not declare. */
export interface UndeclaredFormatOptionSelector {
  format_kind: string;
  params?: unknown;
  /** Custom/schema-backed formats cannot retain identity in a direct selector. */
  unrepresentable?: true;
}

/** Build the direct selector a canonical write sends for an option the seller did not declare. */
export function undeclaredFormatOptionSelector(
  declaration: Readonly<Record<string, unknown>>
): UndeclaredFormatOptionSelector {
  return {
    format_kind: typeof declaration.format_kind === 'string' ? declaration.format_kind : '',
    ...(declaration.params !== undefined && { params: structuredClone(declaration.params) }),
    ...((typeof declaration.format_kind !== 'string' ||
      declaration.format_kind === 'custom' ||
      declaration.format_shape !== undefined ||
      declaration.format_schema !== undefined) && { unrepresentable: true as const }),
  };
}

/**
 * What a route says about one option's origin: unknown (`undefined`), declared
 * by the seller, or derived from legacy `format_ids` with its direct selector.
 */
export type FormatOptionOrigin =
  | { seller_declared: true }
  | { seller_declared: false; selector: UndeclaredFormatOptionSelector };

function routeOrigin(route: CanonicalFormatLegacyRoute): FormatOptionOrigin | undefined {
  if (route.seller_declared === true) return { seller_declared: true };
  if (route.seller_declared !== false) return undefined;
  const selector = route.canonical_selector;
  return {
    seller_declared: false,
    selector:
      selector && typeof selector.format_kind === 'string' && selector.format_kind.length > 0
        ? undeclaredFormatOptionSelector(selector)
        : { format_kind: '', unrepresentable: true },
  };
}

function routeRef(value: unknown): FormatOptionReference | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.format_option_id !== 'string' || record.format_option_id.length === 0) return undefined;
  if (record.scope === 'publisher') {
    return typeof record.publisher_domain === 'string'
      ? {
          scope: 'publisher',
          publisher_domain: record.publisher_domain,
          format_option_id: record.format_option_id,
        }
      : undefined;
  }
  if (typeof record.publisher_domain === 'string') {
    return {
      scope: 'publisher',
      publisher_domain: record.publisher_domain,
      format_option_id: record.format_option_id,
    };
  }
  if (record.scope !== undefined && record.scope !== 'product') return undefined;
  return { scope: 'product', format_option_id: record.format_option_id };
}

/** Whether two option refs name the same format option. Publisher domains compare case-insensitively. */
export function sameFormatOptionRef(left: FormatOptionReference, right: FormatOptionReference): boolean {
  return (
    left.scope === right.scope &&
    left.format_option_id === right.format_option_id &&
    (left.scope !== 'publisher' ||
      (right.scope === 'publisher' && left.publisher_domain.toLowerCase() === right.publisher_domain.toLowerCase()))
  );
}

/**
 * Option refs a product declares in its own `format_options[]`, read from the
 * product exactly as the seller returned it. Options the SDK derives from the
 * seller's legacy `format_ids` never appear here.
 */
export function sellerDeclaredFormatOptionRefs(sellerProduct: unknown): FormatOptionReference[] {
  if (!sellerProduct || typeof sellerProduct !== 'object' || Array.isArray(sellerProduct)) return [];
  const options = (sellerProduct as Record<string, unknown>).format_options;
  const refs: FormatOptionReference[] = [];
  for (const optionValue of Array.isArray(options) ? options : []) {
    if (!optionValue || typeof optionValue !== 'object' || Array.isArray(optionValue)) continue;
    const option = optionValue as Record<string, unknown>;
    if (typeof option.format_option_id !== 'string') continue;
    refs.push(
      typeof option.publisher_domain === 'string'
        ? {
            scope: 'publisher',
            publisher_domain: option.publisher_domain,
            format_option_id: option.format_option_id,
          }
        : { scope: 'product', format_option_id: option.format_option_id }
    );
  }
  return refs;
}

function routeKey(productId: string, ref: FormatOptionReference): string {
  return JSON.stringify([
    productId,
    ref.scope,
    ref.scope === 'publisher' ? ref.publisher_domain : null,
    ref.format_option_id,
  ]);
}

function cloneFormatId(ref: V1FormatId): V1FormatId {
  return {
    agent_url: ref.agent_url,
    id: ref.id,
    ...(ref.width !== undefined ? { width: ref.width } : {}),
    ...(ref.height !== undefined ? { height: ref.height } : {}),
    ...(ref.duration_ms !== undefined ? { duration_ms: ref.duration_ms } : {}),
  };
}

function uniqueFormatIds(refs: readonly V1FormatId[]): V1FormatId[] {
  return [
    ...new Map(
      refs.map(ref => [
        JSON.stringify([ref.agent_url, ref.id, ref.width ?? null, ref.height ?? null, ref.duration_ms ?? null]),
        cloneFormatId(ref),
      ])
    ).values(),
  ];
}

export interface LegacyRoutesForProductOptions {
  /**
   * The product exactly as the seller returned it from `get_products`. When
   * given, an option is seller-declared exactly when this product's own
   * `format_options[]` names it. Use it when the declarations were projected
   * from a stored seller response in a process that never ran discovery, so
   * the SDK holds no origin metadata for them.
   */
  sellerProduct?: unknown;
}

/**
 * Extract persistable routes from canonical declarations, including concealed
 * migration metadata. Pass `sellerProduct` to record each option's origin from
 * the seller's own response instead of that metadata.
 */
export function legacyRoutesForProduct(
  productId: string,
  declarations: readonly V2ProductFormatDeclaration[],
  options: LegacyRoutesForProductOptions = {}
): CanonicalFormatLegacyRoute[] {
  const declaredRefs =
    options.sellerProduct === undefined ? undefined : sellerDeclaredFormatOptionRefs(options.sellerProduct);
  return declarations.flatMap(declaration => {
    const formatOptionRef = routeRef(declaration);
    const formatIds = uniqueFormatIds(legacyFormatRefsForDeclaration(declaration));
    if (!formatOptionRef || formatIds.length === 0) return [];
    const declared = declaredRefs
      ? declaredRefs.some(ref => sameFormatOptionRef(ref, formatOptionRef))
      : sellerDeclaredFormatOption(declaration);
    const selector =
      declared === false
        ? undeclaredFormatOptionSelector(declaration as unknown as Readonly<Record<string, unknown>>)
        : undefined;
    return [
      {
        product_id: productId,
        format_option_ref: formatOptionRef,
        format_ids: formatIds,
        ...(declared !== undefined && { seller_declared: declared }),
        ...(selector &&
          !selector.unrepresentable && {
            canonical_selector: {
              format_kind: selector.format_kind,
              ...(selector.params !== undefined && { params: selector.params }),
            },
          }),
      },
    ];
  });
}

function refsFromSelector(selector: Readonly<Record<string, unknown>>): FormatOptionReference[] {
  const direct = routeRef(selector.format_option_ref);
  if (direct) return [direct];
  if (!Array.isArray(selector.format_option_refs)) return [];
  return selector.format_option_refs.flatMap(value => {
    const ref = routeRef(value);
    return ref ? [ref] : [];
  });
}

interface RouteLookup {
  productId: string;
  refs: FormatOptionReference[];
}

function nestedSelectorRecords(selector: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>>[] {
  if (!Array.isArray(selector.selector_containers)) return [];
  return selector.selector_containers.flatMap(value =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? [value as Readonly<Record<string, unknown>>]
      : []
  );
}

function selectorRouteLookups(selector: Readonly<Record<string, unknown>>): RouteLookup[] | undefined {
  const productId = typeof selector.product_id === 'string' ? selector.product_id : undefined;
  const refs = refsFromSelector(selector);
  const nested = nestedSelectorRecords(selector);
  if (nested.length === 0) return productId && refs.length > 0 ? [{ productId, refs }] : undefined;
  const nestedLookups = nested.map(selectorRouteLookups);
  if (nestedLookups.some(lookups => lookups === undefined)) return undefined;
  if ((productId && refs.length === 0) || (!productId && refs.length > 0)) return undefined;
  return [
    ...(productId && refs.length > 0 ? [{ productId, refs }] : []),
    ...nestedLookups.flatMap(lookups => lookups ?? []),
  ];
}

function selectorProductIds(selector: Readonly<Record<string, unknown>>): string[] | undefined {
  const productId = typeof selector.product_id === 'string' ? selector.product_id : undefined;
  const nested = nestedSelectorRecords(selector);
  if (nested.length === 0) return productId ? [productId] : undefined;
  const nestedIds = nested.map(selectorProductIds);
  if (nestedIds.some(ids => ids === undefined)) return undefined;
  return [...new Set([...(productId ? [productId] : []), ...nestedIds.flatMap(ids => ids ?? [])])];
}

function routeLookupContext(context: CanonicalFormatLegacyResolutionContext): RouteLookup[] | undefined {
  if (context.source === 'product') {
    const ref = routeRef(context.declaration);
    return ref ? [{ productId: context.productId, refs: [ref] }] : undefined;
  }
  const selector = context.selector;
  if (context.source === 'creative') {
    const creativeRef = routeRef(context.creative.format_option_ref);
    if (creativeRef) {
      const productIds = selectorProductIds(selector);
      return productIds && productIds.length > 0
        ? productIds.map(productId => ({ productId, refs: [creativeRef] }))
        : undefined;
    }
  }
  const lookups = selectorRouteLookups(selector);
  return lookups && lookups.length > 0 ? lookups : undefined;
}

/**
 * Build the existing resolver callback from routes restored from durable
 * storage. Inputs are snapshotted so later caller mutation cannot redirect a
 * creative delivery operation.
 */
const originsByResolver = new WeakMap<
  CanonicalFormatLegacyResolver,
  ReadonlyArray<{ productId: string; ref: FormatOptionReference; origin: FormatOptionOrigin | undefined }>
>();

function sameRouteRef(left: FormatOptionReference, right: FormatOptionReference): boolean {
  return routeKey('', left) === routeKey('', right);
}

/**
 * The origin a resolver built by {@link canonicalFormatLegacyResolverFromRoutes}
 * recorded for one option. Without a product id, every route for the option
 * must agree that the seller did not declare it.
 */
export function formatOptionOriginFromRoutes(
  resolver: CanonicalFormatLegacyResolver | undefined,
  ref: FormatOptionReference,
  productId: string | undefined
): FormatOptionOrigin | undefined {
  const origins = resolver ? originsByResolver.get(resolver) : undefined;
  if (!origins) return undefined;
  const matching = origins.filter(
    entry => sameRouteRef(entry.ref, ref) && (productId === undefined || entry.productId === productId)
  );
  if (matching.length === 0) return undefined;
  const declared = matching.find(entry => entry.origin?.seller_declared);
  if (declared) return declared.origin;
  // Old persisted routes do not prove that their seller omitted this option.
  // They must participate in the agreement check for an unscoped reference.
  if (matching.some(entry => entry.origin === undefined)) return undefined;
  return matching[0]!.origin;
}

export function canonicalFormatLegacyResolverFromRoutes(
  routes: readonly CanonicalFormatLegacyRoute[]
): CanonicalFormatLegacyResolver {
  const index = new Map<string, V1FormatId[]>();
  const origins: Array<{ productId: string; ref: FormatOptionReference; origin: FormatOptionOrigin | undefined }> = [];
  for (const route of routes) {
    const ref = routeRef(route.format_option_ref);
    if (
      typeof route.product_id !== 'string' ||
      route.product_id.length === 0 ||
      !ref ||
      !Array.isArray(route.format_ids)
    ) {
      continue;
    }
    const key = routeKey(route.product_id, ref);
    index.set(key, uniqueFormatIds([...(index.get(key) ?? []), ...route.format_ids]));
    const origin = routeOrigin(route);
    origins.push({ productId: route.product_id, ref, origin });
  }
  const resolver: CanonicalFormatLegacyResolver = context => {
    const lookups = routeLookupContext(context);
    if (!lookups) return undefined;
    const resolved: V1FormatId[] = [];
    for (const lookup of lookups) {
      for (const ref of lookup.refs) {
        const formatIds = index.get(routeKey(lookup.productId, ref));
        // A partial package mapping would silently narrow a multi-option
        // selection on the legacy wire. Fail closed unless every requested
        // canonical reference has a durable route.
        if (!formatIds || formatIds.length === 0) return undefined;
        resolved.push(...formatIds);
      }
    }
    const formatIds = uniqueFormatIds(resolved);
    return formatIds.length > 0 ? formatIds : undefined;
  };
  originsByResolver.set(resolver, Object.freeze(origins));
  return resolver;
}
