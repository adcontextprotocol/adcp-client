import { PropertyIdentifierTypesValues } from '../types/enums.generated';

export function isSupportedPropertyIdentifierType(type: string): boolean {
  return (PropertyIdentifierTypesValues as readonly string[]).includes(type);
}

export type ProductPropertyPolicyMode = 'audit' | 'filter' | 'reject_response';

export type ProductPropertyPolicySelectorBehavior = 'allow' | 'flag' | 'reject';

export interface BuyerPropertyPolicy {
  /** Domains the buyer will accept in returned products. */
  allowedDomains?: readonly string[];
  /**
   * Resolved property-list identifiers the buyer will accept in returned
   * products. Domain identifiers are matched with AdCP property-list domain
   * semantics (`example.com` matches `www.example.com` and `m.example.com`;
   * `*.example.com` matches subdomains only).
   */
  allowedPropertyIdentifiers?: readonly ProductPropertyPolicyIdentifier[];
  /**
   * Complete publisher catalogs, keyed by canonical publisher domain. Enables
   * app/CTV identifier matching for all/by_id/by_tag selectors. Omitted keys
   * mean unresolved metadata; an empty array means a known empty catalog.
   * Property IDs remain publisher-scoped and are never treated as app IDs.
   */
  publisherProperties?: Readonly<Record<string, readonly ProductPolicyResolvedProperty[] | undefined>>;
  /**
   * Require products to match the allowed domain/identifier set even when that
   * set is empty. Used when a request property_list resolves successfully to
   * zero identifiers; the safe interpretation is that no properties are
   * eligible.
   */
  requireAllowedPropertyMatch?: boolean;
  /** Domains the buyer will not accept in returned products. */
  excludedDomains?: readonly string[];
  /** Publisher-scoped property IDs the buyer will not accept in returned products. */
  excludedPropertyIds?: readonly string[];
  /**
   * Shorthand for strict brand-safety evaluation. Defaults unresolved tag
   * selectors and missing `publisher_properties` to rejection unless the more
   * specific behavior fields override it.
   */
  strict?: boolean;
  /**
   * How to handle selectors the SDK cannot confidently evaluate, such as
   * `selection_type: "by_tag"` without resolved property metadata.
   *
   * Default: `reject` when `strict` is true, otherwise `flag`.
   */
  unknownSelectorBehavior?: ProductPropertyPolicySelectorBehavior;
  /**
   * How to handle products that omit `publisher_properties`.
   *
   * Default: `reject` when `strict` is true, otherwise `allow`.
   */
  missingPublisherPropertiesBehavior?: ProductPropertyPolicySelectorBehavior;
}

export interface ValidateProductsAgainstPropertyPolicyOptions<TProduct extends ProductPolicyProductLike> {
  products: readonly TProduct[];
  policy: BuyerPropertyPolicy;
  mode?: ProductPropertyPolicyMode;
}

export interface ProductPolicyProductLike {
  product_id?: unknown;
  id?: unknown;
  publisher_properties?: unknown;
  property_targeting_allowed?: unknown;
}

export interface ProductPropertyPolicyIdentifier {
  type: string;
  value: string;
}

export interface ProductPolicyResolvedProperty {
  property_id?: string;
  identifiers: readonly ProductPropertyPolicyIdentifier[];
  tags?: readonly string[];
}

export type ProductPropertyPolicyDiagnosticCode =
  | 'outside_property_list'
  | 'excluded_domain'
  | 'excluded_property_id'
  | 'missing_publisher_properties'
  | 'unresolved_tag_selector'
  | 'unknown_selector'
  | 'malformed_publisher_domain'
  | 'unresolved_property_identifiers'
  | 'excluded_resolved_property';

export type ProductPropertyPolicyDiagnosticSeverity = 'rejected' | 'flagged';

export interface ProductPropertyPolicyDiagnostic {
  code: ProductPropertyPolicyDiagnosticCode;
  severity: ProductPropertyPolicyDiagnosticSeverity;
  message: string;
  product_index: number;
  product_id?: string;
  path: string;
  publisher_property_index?: number;
  selection_type?: string;
  publisher_domain?: string;
  publisher_domains?: string[];
  normalized_domain?: string;
  normalized_domains?: string[];
  matched_allowed_domain?: string;
  matched_excluded_domain?: string;
  property_ids?: string[];
  matched_property_ids?: string[];
  identifier_types?: string[];
}

export interface ProductPropertyPolicyValidationResult<TProduct extends ProductPolicyProductLike> {
  mode: ProductPropertyPolicyMode;
  ok: boolean;
  /**
   * Mode-adjusted output. `audit` returns the original product list, `filter`
   * returns only policy-eligible products, and `reject_response` returns the
   * original list when no rejection occurs.
   */
  products: TProduct[];
  acceptedProducts: TProduct[];
  rejectedProducts: TProduct[];
  flaggedProducts: TProduct[];
  diagnostics: ProductPropertyPolicyDiagnostic[];
}

export interface NormalizedPolicyDomain {
  input: string;
  host: string;
  comparable: string;
}

export class ProductPropertyPolicyError<TProduct extends ProductPolicyProductLike> extends Error {
  readonly name = 'ProductPropertyPolicyError';

  constructor(public readonly result: ProductPropertyPolicyValidationResult<TProduct>) {
    super(
      `Product property policy rejected ${result.rejectedProducts.length} product${
        result.rejectedProducts.length === 1 ? '' : 's'
      }`
    );
  }
}

interface CompiledPropertyPolicy {
  publisherCatalogsConfigured: boolean;
  allowedDomains: NormalizedPolicyDomain[];
  allowedPropertyIdentifiers: ProductPropertyPolicyIdentifier[];
  requireAllowedPropertyMatch: boolean;
  excludedDomainsByComparable: Map<string, NormalizedPolicyDomain>;
  excludedPropertyIds: Set<string>;
  unknownSelectorBehavior: ProductPropertyPolicySelectorBehavior;
  missingPublisherPropertiesBehavior: ProductPropertyPolicySelectorBehavior;
  publisherProperties: NonNullable<BuyerPropertyPolicy['publisherProperties']>;
}

interface ProductPublisherPropertySelectorLike {
  selection_type?: unknown;
  publisher_domain?: unknown;
  publisher_domains?: unknown;
  property_ids?: unknown;
  property_tags?: unknown;
}

interface PublisherDomainCandidate {
  raw: string;
  path: string;
}

export function validateProductsAgainstPropertyPolicy<TProduct extends ProductPolicyProductLike>(
  options: ValidateProductsAgainstPropertyPolicyOptions<TProduct>
): ProductPropertyPolicyValidationResult<TProduct> {
  const mode = options.mode ?? 'audit';
  const compiled = compilePolicy(options.policy);
  const diagnostics: ProductPropertyPolicyDiagnostic[] = [];

  options.products.forEach((product, productIndex) => {
    diagnostics.push(...diagnosticsForProduct(product, productIndex, compiled));
  });

  const rejectedIndexes = new Set(diagnostics.filter(d => d.severity === 'rejected').map(d => d.product_index));
  const flaggedIndexes = new Set(diagnostics.filter(d => d.severity === 'flagged').map(d => d.product_index));

  const acceptedProducts = options.products.filter((_, index) => !rejectedIndexes.has(index));
  const rejectedProducts = options.products.filter((_, index) => rejectedIndexes.has(index));
  const flaggedProducts = options.products.filter(
    (_, index) => flaggedIndexes.has(index) && !rejectedIndexes.has(index)
  );

  const result: ProductPropertyPolicyValidationResult<TProduct> = {
    mode,
    ok: rejectedProducts.length === 0,
    products: mode === 'filter' ? acceptedProducts : [...options.products],
    acceptedProducts,
    rejectedProducts,
    flaggedProducts,
    diagnostics,
  };

  if (mode === 'reject_response' && !result.ok) {
    throw new ProductPropertyPolicyError(result);
  }

  return result;
}

export function normalizeDomainForPropertyPolicy(value: string): NormalizedPolicyDomain | undefined {
  const input = value;
  let host = extractHostname(value);
  if (!host) return undefined;
  host = host.toLowerCase().replace(/\.$/, '');
  if (!isUsableHostname(host)) return undefined;
  return { input, host, comparable: comparableDomain(host) };
}

function compilePolicy(policy: BuyerPropertyPolicy): CompiledPropertyPolicy {
  const allowedDomains: NormalizedPolicyDomain[] = [];
  for (const domain of policy.allowedDomains ?? []) {
    const normalized = normalizeDomainForPropertyPolicy(domain);
    if (normalized) allowedDomains.push(normalized);
  }

  const excludedDomainsByComparable = new Map<string, NormalizedPolicyDomain>();
  for (const domain of policy.excludedDomains ?? []) {
    const normalized = normalizeDomainForPropertyPolicy(domain);
    if (normalized) excludedDomainsByComparable.set(normalized.comparable, normalized);
  }

  return {
    allowedDomains,
    publisherCatalogsConfigured: policy.publisherProperties !== undefined,
    publisherProperties: policy.publisherProperties ?? {},
    allowedPropertyIdentifiers: [...(policy.allowedPropertyIdentifiers ?? [])],
    requireAllowedPropertyMatch:
      policy.requireAllowedPropertyMatch ??
      Boolean(policy.allowedDomains?.length || policy.allowedPropertyIdentifiers?.length),
    excludedDomainsByComparable,
    excludedPropertyIds: new Set(policy.excludedPropertyIds ?? []),
    unknownSelectorBehavior: policy.unknownSelectorBehavior ?? (policy.strict ? 'reject' : 'flag'),
    missingPublisherPropertiesBehavior:
      policy.missingPublisherPropertiesBehavior ?? (policy.strict ? 'reject' : 'allow'),
  };
}

function diagnosticsForProduct(
  product: ProductPolicyProductLike,
  productIndex: number,
  policy: CompiledPropertyPolicy
): ProductPropertyPolicyDiagnostic[] {
  const publisherProperties = product.publisher_properties;
  const productId = productIdForDiagnostics(product);

  if (!Array.isArray(publisherProperties) || publisherProperties.length === 0) {
    return diagnosticForBehavior(policy.missingPublisherPropertiesBehavior, {
      code: 'missing_publisher_properties',
      message: 'Product is missing publisher_properties, so buyer property exclusions cannot be evaluated.',
      product_index: productIndex,
      product_id: productId,
      path: `products[${productIndex}].publisher_properties`,
    });
  }

  const diagnostics: ProductPropertyPolicyDiagnostic[] = [];
  let hasEligibleSubsetSelector = false;
  const requiresSubsetMatch = hasAllowedPropertyScope(policy) && product.property_targeting_allowed === true;
  publisherProperties.forEach((rawSelector, selectorIndex) => {
    diagnostics.push(
      ...diagnosticsForSelector(rawSelector, productIndex, selectorIndex, productId, policy, {
        enforceEveryDomainInAllowedScope: !requiresSubsetMatch,
        enforceExclusions: !requiresSubsetMatch,
      })
    );
    if (requiresSubsetMatch && selectorIsEligibleForSubsetTargeting(rawSelector, productIndex, selectorIndex, policy)) {
      hasEligibleSubsetSelector = true;
    }
  });
  if (requiresSubsetMatch) {
    const scopes = publisherProperties.flatMap(selector =>
      selector && typeof selector === 'object' && !Array.isArray(selector)
        ? [identifierScopeForSelector(selector, policy)]
        : []
    );
    if (scopes.some(scope => scope?.hasNonMatch) && !scopes.some(scope => scope?.hasMatch))
      hasEligibleSubsetSelector = false;
  }
  if (requiresSubsetMatch && hasEligibleSubsetSelector) {
    for (const diagnostic of diagnostics) {
      if (diagnostic.code === 'unresolved_property_identifiers') diagnostic.severity = 'flagged';
    }
  }
  if (requiresSubsetMatch && !hasEligibleSubsetSelector) {
    diagnostics.push({
      code: 'outside_property_list',
      severity: 'rejected',
      message: 'Product has no buyer-eligible publisher properties inside the requested property list.',
      product_index: productIndex,
      product_id: productId,
      path: `products[${productIndex}].publisher_properties`,
    });
  }
  return diagnostics;
}

function diagnosticsForSelector(
  rawSelector: unknown,
  productIndex: number,
  selectorIndex: number,
  productId: string | undefined,
  policy: CompiledPropertyPolicy,
  options: { enforceEveryDomainInAllowedScope: boolean; enforceExclusions: boolean }
): ProductPropertyPolicyDiagnostic[] {
  const path = `products[${productIndex}].publisher_properties[${selectorIndex}]`;
  if (!rawSelector || typeof rawSelector !== 'object' || Array.isArray(rawSelector)) {
    return diagnosticForBehavior(policy.unknownSelectorBehavior, {
      code: 'unknown_selector',
      message: 'Publisher property selector is not an object and cannot be evaluated.',
      product_index: productIndex,
      product_id: productId,
      path,
      publisher_property_index: selectorIndex,
    });
  }

  const selector = rawSelector as ProductPublisherPropertySelectorLike;
  const identifierScope = identifierScopeForSelector(selector, policy);
  const selectionType = typeof selector.selection_type === 'string' ? selector.selection_type : undefined;
  const domainCandidates = publisherDomainCandidates(selector, path);
  const normalizedDomains = domainCandidates
    .map(candidate => ({ candidate, normalized: normalizeDomainForPropertyPolicy(candidate.raw) }))
    .filter((entry): entry is { candidate: PublisherDomainCandidate; normalized: NormalizedPolicyDomain } =>
      Boolean(entry.normalized)
    );
  const diagnostics: ProductPropertyPolicyDiagnostic[] = [];

  if (selector.publisher_domains !== undefined) {
    diagnostics.push({
      code: 'unknown_selector',
      severity: 'rejected',
      message:
        'Product publisher property selector uses publisher_domains, which is not valid on product publisher_properties.',
      product_index: productIndex,
      product_id: productId,
      path,
      publisher_property_index: selectorIndex,
      selection_type: selectionType,
      ...(typeof selector.publisher_domain === 'string' ? { publisher_domain: selector.publisher_domain } : {}),
      publisher_domains: stringArray(selector.publisher_domains),
    });
  }

  if (domainCandidates.length === 0) {
    diagnostics.push(
      ...diagnosticForBehavior(policy.unknownSelectorBehavior, {
        code: 'unknown_selector',
        message:
          'Product publisher property selector is missing publisher_domain/publisher_domains and cannot be evaluated confidently.',
        product_index: productIndex,
        product_id: productId,
        path: `${path}.publisher_domain`,
        publisher_property_index: selectorIndex,
        selection_type: selectionType,
      })
    );
  }

  for (const candidate of domainCandidates) {
    const normalizedDomain = normalizeDomainForPropertyPolicy(candidate.raw);
    if (normalizedDomain) continue;
    diagnostics.push(
      ...diagnosticForBehavior(policy.unknownSelectorBehavior, {
        code: 'malformed_publisher_domain',
        message: 'Publisher property selector has a malformed publisher domain and cannot be evaluated.',
        product_index: productIndex,
        product_id: productId,
        path: candidate.path,
        publisher_property_index: selectorIndex,
        selection_type: selectionType,
        publisher_domain: candidate.raw,
      })
    );
  }

  for (const { candidate, normalized: normalizedDomain } of normalizedDomains) {
    const matchedAllowedDomain = matchedAllowedDomainForCandidate(normalizedDomain, policy);
    if ((hasAllowedPropertyScope(policy) || selectionType === 'by_tag') && identifierScope?.unknown) {
      diagnostics.push(
        ...diagnosticForBehavior(policy.unknownSelectorBehavior, {
          code: 'unresolved_property_identifiers',
          identifier_types: [
            ...new Set(
              policy.allowedPropertyIdentifiers
                .filter(identifier => identifier.type !== 'domain' && identifier.type !== 'subdomain')
                .map(identifier => identifier.type)
            ),
          ],
          message: 'Publisher property identifiers could not be resolved; property-list membership is unknown.',
          product_index: productIndex,
          product_id: productId,
          path,
          publisher_property_index: selectorIndex,
          selection_type: selectionType,
          publisher_domain: candidate.raw,
        })
      );
    }
    if (
      options.enforceEveryDomainInAllowedScope &&
      hasAllowedPropertyScope(policy) &&
      (identifierScope ? identifierScope.hasNonMatch : !matchedAllowedDomain)
    ) {
      diagnostics.push({
        code: 'outside_property_list',
        severity: 'rejected',
        message: `Product includes publisher domain ${normalizedDomain.host} outside the requested property list.`,
        product_index: productIndex,
        product_id: productId,
        path: candidate.path,
        publisher_property_index: selectorIndex,
        selection_type: selectionType,
        publisher_domain: candidate.raw,
        publisher_domains: domainCandidates.map(candidate => candidate.raw),
        normalized_domain: normalizedDomain.host,
        normalized_domains: normalizedDomains.map(entry => entry.normalized.host),
      });
    }

    const excludedDomain = policy.excludedDomainsByComparable.get(normalizedDomain.comparable);
    if (options.enforceExclusions && excludedDomain) {
      diagnostics.push({
        code: 'excluded_domain',
        severity: 'rejected',
        message: `Product includes excluded publisher domain ${normalizedDomain.host}.`,
        product_index: productIndex,
        product_id: productId,
        path: candidate.path,
        publisher_property_index: selectorIndex,
        selection_type: selectionType,
        publisher_domain: candidate.raw,
        publisher_domains: domainCandidates.map(candidate => candidate.raw),
        normalized_domain: normalizedDomain.host,
        normalized_domains: normalizedDomains.map(entry => entry.normalized.host),
        matched_excluded_domain: excludedDomain.host,
      });
    }
  }

  if (options.enforceExclusions && identifierScope?.hasExcludedProperty) {
    diagnostics.push({
      code: 'excluded_resolved_property',
      severity: 'rejected',
      message: 'Resolved publisher properties include a buyer-excluded property.',
      product_index: productIndex,
      product_id: productId,
      path,
      publisher_property_index: selectorIndex,
      selection_type: selectionType,
      publisher_domain: domainCandidates[0]?.raw,
    });
  }

  if (selectionType === 'by_id') {
    const propertyIds = stringArray(selector.property_ids);
    const matchedPropertyIds = propertyIds.filter(id => policy.excludedPropertyIds.has(id));
    if (options.enforceExclusions && matchedPropertyIds.length > 0) {
      diagnostics.push({
        code: 'excluded_property_id',
        severity: 'rejected',
        message: `Product includes excluded publisher property ID${matchedPropertyIds.length === 1 ? '' : 's'}.`,
        product_index: productIndex,
        product_id: productId,
        path: `${path}.property_ids`,
        publisher_property_index: selectorIndex,
        selection_type: selectionType,
        publisher_domain: domainCandidates[0]?.raw,
        publisher_domains: domainCandidates.map(candidate => candidate.raw),
        normalized_domain: normalizedDomains[0]?.normalized.host,
        normalized_domains: normalizedDomains.map(entry => entry.normalized.host),
        property_ids: propertyIds,
        matched_property_ids: matchedPropertyIds,
      });
    }
  } else if (selectionType === 'by_tag' && !identifierScope) {
    diagnostics.push(
      ...diagnosticForBehavior(policy.unknownSelectorBehavior, {
        code: 'unresolved_tag_selector',
        message:
          'Product uses selection_type by_tag; without resolved property metadata it cannot be evaluated confidently.',
        product_index: productIndex,
        product_id: productId,
        path,
        publisher_property_index: selectorIndex,
        selection_type: selectionType,
        publisher_domain: domainCandidates[0]?.raw,
        publisher_domains: domainCandidates.map(candidate => candidate.raw),
        normalized_domain: normalizedDomains[0]?.normalized.host,
        normalized_domains: normalizedDomains.map(entry => entry.normalized.host),
      })
    );
  } else if (selectionType !== 'all' && selectionType !== 'by_tag') {
    diagnostics.push(
      ...diagnosticForBehavior(policy.unknownSelectorBehavior, {
        code: 'unknown_selector',
        message: 'Product uses an unknown publisher_properties selection_type and cannot be evaluated.',
        product_index: productIndex,
        product_id: productId,
        path: `${path}.selection_type`,
        publisher_property_index: selectorIndex,
        selection_type: selectionType,
        publisher_domain: domainCandidates[0]?.raw,
        publisher_domains: domainCandidates.map(candidate => candidate.raw),
        normalized_domain: normalizedDomains[0]?.normalized.host,
        normalized_domains: normalizedDomains.map(entry => entry.normalized.host),
      })
    );
  }

  return diagnostics;
}

function hasAllowedPropertyScope(policy: CompiledPropertyPolicy): boolean {
  return policy.requireAllowedPropertyMatch;
}

function selectorIsEligibleForSubsetTargeting(
  rawSelector: unknown,
  productIndex: number,
  selectorIndex: number,
  policy: CompiledPropertyPolicy
): boolean {
  const path = `products[${productIndex}].publisher_properties[${selectorIndex}]`;
  if (!rawSelector || typeof rawSelector !== 'object' || Array.isArray(rawSelector)) return false;
  const selector = rawSelector as ProductPublisherPropertySelectorLike;
  if (selector.publisher_domains !== undefined) return false;
  const identifierScope = identifierScopeForSelector(selector, policy);
  if (identifierScope) {
    const domain =
      typeof selector.publisher_domain === 'string'
        ? normalizeDomainForPropertyPolicy(selector.publisher_domain)
        : undefined;
    if (!domain || policy.excludedDomainsByComparable.has(domain.comparable)) return false;
    if (
      selector.selection_type !== 'all' &&
      selector.selection_type !== 'by_id' &&
      selector.selection_type !== 'by_tag'
    )
      return false;
    return (
      identifierScope.hasMatch ||
      (identifierScope.unknown && !identifierScope.hasNonMatch && policy.unknownSelectorBehavior !== 'reject')
    );
  }
  if (selector.selection_type === 'by_tag') return false;
  if (selector.selection_type !== 'all' && selector.selection_type !== 'by_id') return false;

  const hasEligibleDomain = publisherDomainCandidates(selector, path).some(candidate => {
    const normalized = normalizeDomainForPropertyPolicy(candidate.raw);
    if (!normalized) return false;
    if (hasAllowedPropertyScope(policy) && !matchedAllowedDomainForCandidate(normalized, policy)) return false;
    return !policy.excludedDomainsByComparable.has(normalized.comparable);
  });
  if (!hasEligibleDomain) return false;

  if (selector.selection_type !== 'by_id') return true;
  const propertyIds = stringArray(selector.property_ids);
  return propertyIds.length === 0 || propertyIds.some(id => !policy.excludedPropertyIds.has(id));
}

function matchedAllowedDomainForCandidate(
  candidate: NormalizedPolicyDomain,
  policy: CompiledPropertyPolicy
): string | undefined {
  const explicitDomain = policy.allowedDomains.find(allowed =>
    propertyListDomainMatches(candidate.host, allowed.input)
  );
  if (explicitDomain) return explicitDomain.host;

  for (const identifier of policy.allowedPropertyIdentifiers) {
    if (identifier.type !== 'domain' && identifier.type !== 'subdomain') continue;
    if (propertyListDomainMatches(candidate.host, identifier.value, identifier.type)) {
      return identifier.value;
    }
  }
  return undefined;
}

/** Use supplied catalogs for identifiers and exclusions; policies without catalogs retain domain shortcuts. */
function identifierScopeForSelector(
  selector: ProductPublisherPropertySelectorLike,
  policy: CompiledPropertyPolicy
):
  | { allMatch: boolean; hasMatch: boolean; hasNonMatch: boolean; unknown: boolean; hasExcludedProperty?: boolean }
  | undefined {
  if (
    !policy.allowedPropertyIdentifiers.some(id => id.type !== 'domain' && id.type !== 'subdomain') &&
    !policy.publisherCatalogsConfigured
  )
    return undefined;
  const propertyIds = selector.selection_type === 'by_id' ? stringArray(selector.property_ids) : [];
  const hasExcludedId = propertyIds.some(id => policy.excludedPropertyIds.has(id));
  const allIdsExcluded = propertyIds.length > 0 && propertyIds.every(id => policy.excludedPropertyIds.has(id));
  if (allIdsExcluded) return { allMatch: false, hasMatch: false, hasNonMatch: true, unknown: false };
  const domain =
    typeof selector.publisher_domain === 'string'
      ? normalizeDomainForPropertyPolicy(selector.publisher_domain)
      : undefined;
  if (!domain) return { allMatch: false, hasMatch: false, hasNonMatch: hasExcludedId, unknown: true };
  if (policy.excludedDomainsByComparable.has(domain.comparable))
    return { allMatch: false, hasMatch: false, hasNonMatch: true, unknown: false };
  const properties = Object.hasOwn(policy.publisherProperties, domain.host)
    ? policy.publisherProperties[domain.host]
    : undefined;
  if (!properties && policy.publisherCatalogsConfigured)
    return { allMatch: false, hasMatch: false, hasNonMatch: hasExcludedId, unknown: true };
  if (!properties) {
    // Existing domain rules can still positively judge a selector in a mixed list.
    const matchedDomain = !allIdsExcluded && Boolean(matchedAllowedDomainForCandidate(domain, policy));
    const unknown = (!matchedDomain && !allIdsExcluded) || selector.selection_type === 'by_tag';
    return {
      allMatch: matchedDomain && !unknown && !hasExcludedId,
      hasMatch: matchedDomain && !unknown,
      hasNonMatch: hasExcludedId,
      unknown,
    };
  }
  if (
    !Array.isArray(properties) ||
    (properties as readonly ProductPolicyResolvedProperty[]).some(
      property =>
        !property ||
        typeof property !== 'object' ||
        !Array.isArray(property.identifiers) ||
        property.identifiers.some(
          (identifier: ProductPropertyPolicyIdentifier) =>
            !identifier || typeof identifier.type !== 'string' || typeof identifier.value !== 'string'
        ) ||
        (property.tags !== undefined &&
          (!Array.isArray(property.tags) || property.tags.some((tag: unknown) => typeof tag !== 'string')))
    )
  ) {
    return { allMatch: false, hasMatch: false, hasNonMatch: hasExcludedId, unknown: true };
  }
  let selected: ProductPolicyResolvedProperty[] = [...properties];
  let missingIds = false;
  if (selector.selection_type === 'by_id') {
    const ids = stringArray(selector.property_ids);
    missingIds = !ids.length || ids.some(id => !properties.some(property => property.property_id === id));
    selected = selected.filter(property => property.property_id && ids.includes(property.property_id));
  } else if (selector.selection_type === 'by_tag') {
    const tags = stringArray(selector.property_tags);
    if (!tags.length) return { allMatch: false, hasMatch: false, hasNonMatch: false, unknown: true };
    selected = selected.filter(property => property.tags?.some(tag => tags.includes(tag)));
  } else if (selector.selection_type !== 'all') {
    return { allMatch: false, hasMatch: false, hasNonMatch: false, unknown: true };
  }
  const excluded = selected.map(
    property =>
      policy.excludedPropertyIds.has(property.property_id ?? '') ||
      property.identifiers.some(
        identifier =>
          (identifier.type === 'domain' || identifier.type === 'subdomain') &&
          policy.excludedDomainsByComparable.has(normalizeDomainForPropertyPolicy(identifier.value)?.comparable ?? '')
      )
  );
  const matches = selected.map(
    (property, index) =>
      !excluded[index] &&
      (!hasAllowedPropertyScope(policy) ||
        property.identifiers.some(
          candidate =>
            policy.allowedPropertyIdentifiers.some(allowed =>
              allowed.type === 'domain' || allowed.type === 'subdomain'
                ? (candidate.type === 'domain' || candidate.type === 'subdomain') &&
                  propertyListDomainMatches(candidate.value, allowed.value, allowed.type)
                : isSupportedPropertyIdentifierType(allowed.type) &&
                  candidate.type === allowed.type &&
                  candidate.value === allowed.value
            ) ||
            ((candidate.type === 'domain' || candidate.type === 'subdomain') &&
              policy.allowedDomains.some(allowed => propertyListDomainMatches(candidate.value, allowed.input)))
        ))
  );
  const undecidable = selected.map(
    (property, index) =>
      !excluded[index] &&
      (property.identifiers.length === 0 ||
        property.identifiers.some(
          candidate =>
            !isSupportedPropertyIdentifierType(candidate.type) &&
            policy.allowedPropertyIdentifiers.some(allowed => allowed.type === candidate.type)
        ))
  );
  const unknown = matches.some((match, index) => !match && undecidable[index]);
  return {
    allMatch: matches.length > 0 && matches.every(Boolean) && !unknown,
    hasMatch: matches.some(Boolean),
    hasNonMatch: missingIds || !selected.length || matches.some((match, index) => !match && !undecidable[index]),
    hasExcludedProperty: excluded.some(Boolean),
    unknown,
  };
}

function publisherDomainCandidates(
  selector: ProductPublisherPropertySelectorLike,
  path: string
): PublisherDomainCandidate[] {
  const candidates: PublisherDomainCandidate[] = [];
  if (typeof selector.publisher_domain === 'string') {
    candidates.push({ raw: selector.publisher_domain, path: `${path}.publisher_domain` });
  }
  return candidates;
}

function diagnosticForBehavior(
  behavior: ProductPropertyPolicySelectorBehavior,
  diagnostic: Omit<ProductPropertyPolicyDiagnostic, 'severity'>
): ProductPropertyPolicyDiagnostic[] {
  if (behavior === 'allow') return [];
  return [{ ...diagnostic, severity: behavior === 'reject' ? 'rejected' : 'flagged' }];
}

function productIdForDiagnostics(product: ProductPolicyProductLike): string | undefined {
  if (typeof product.product_id === 'string') return product.product_id;
  if (typeof product.id === 'string') return product.id;
  return undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function extractHostname(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;

  try {
    const url = new URL(hasScheme(trimmed) || trimmed.startsWith('//') ? trimmed : `https://${trimmed}`);
    return url.hostname;
  } catch {
    let host = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^\/\//, '');
    const firstPathChar = host.search(/[/?#]/);
    if (firstPathChar >= 0) host = host.slice(0, firstPathChar);
    const at = host.lastIndexOf('@');
    if (at >= 0) host = host.slice(at + 1);
    if (host.startsWith('[')) {
      const close = host.indexOf(']');
      if (close >= 0) host = host.slice(1, close);
    } else {
      host = host.replace(/:\d+$/, '');
    }
    return host;
  }
}

function hasScheme(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
}

function comparableDomain(host: string): string {
  return host.startsWith('www.') ? host.slice(4) : host;
}

function propertyListDomainMatches(candidateValue: string, patternValue: string, type: string = 'domain'): boolean {
  const candidate = normalizeDomainForPropertyPolicy(candidateValue)?.host;
  const pattern = normalizeDomainForPropertyPolicy(patternValue)?.host;
  if (!candidate || !pattern) return false;
  if (candidate === pattern) return true;
  if (type === 'subdomain') return false;
  if (pattern.startsWith('*.')) {
    const base = pattern.slice(2);
    return candidate.endsWith(`.${base}`) && candidate !== base;
  }
  return candidate === `www.${pattern}` || candidate === `m.${pattern}`;
}

function isUsableHostname(host: string): boolean {
  if (host.length === 0 || host.length > 253) return false;
  // eslint-disable-next-line no-control-regex
  return !/[\x00-\x1f\x7f\s/\\]/.test(host);
}
