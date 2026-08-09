import type { FormatOptionReference } from '../../types/tools.generated';
import { legacyFormatRefsForDeclaration } from './legacy-metadata';
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

/** Extract persistable routes from canonical declarations, including concealed migration metadata. */
export function legacyRoutesForProduct(
  productId: string,
  declarations: readonly V2ProductFormatDeclaration[]
): CanonicalFormatLegacyRoute[] {
  return declarations.flatMap(declaration => {
    const formatOptionRef = routeRef(declaration);
    const formatIds = uniqueFormatIds(legacyFormatRefsForDeclaration(declaration));
    return formatOptionRef && formatIds.length > 0
      ? [{ product_id: productId, format_option_ref: formatOptionRef, format_ids: formatIds }]
      : [];
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
export function canonicalFormatLegacyResolverFromRoutes(
  routes: readonly CanonicalFormatLegacyRoute[]
): CanonicalFormatLegacyResolver {
  const index = new Map<string, V1FormatId[]>();
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
  }
  return context => {
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
}
