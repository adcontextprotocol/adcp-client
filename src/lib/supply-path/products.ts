import { createHash } from 'node:crypto';
import type { SinglePublisherPropertySelector } from '../discovery/types';
import type { ListProductsResponse } from '../types';
import { verifySupplyPath, verifyAuthoritativeSupplyPath } from './verify';
import { SUPPLY_PATH_STATES, hasValidPropertySelectorPredicate } from './evaluate';
import { boundedOption, SupplyPathEvidenceSession } from './fetch-evidence';
import { agentIdentity, domain, record, strings, validateSupplyPathRequest } from './validation';
import { parsePublisherPropertySelector } from '../discovery/publisher-property-selector';
import type {
  SupplyPathRequest,
  SupplyPathState,
  RegistrySupplyPathResult,
  AuthoritativeSupplyPathResult,
  RegistrySupplyPathOptions,
  AuthoritativeSupplyPathOptions,
} from './types';

export interface ProductSupplyPathAnnotation {
  /** Weakest external owner/host/collection path. Not a whole-product authorization decision. */
  supply_path_state?: SupplyPathState;
  supply_path_verification?: (
    | { source: 'registry'; scope: 'owner_host_collection'; paths: RegistrySupplyPathResult[] }
    | { source: 'authoritative'; scope: 'product_properties'; paths: AuthoritativeSupplyPathResult[] }
  ) & { errors: string[] };
}
export type AnnotatedSupplyPathProduct<T extends object> = Omit<T, keyof ProductSupplyPathAnnotation> &
  ProductSupplyPathAnnotation;
type AnnotatedListProductsResponse<T> = T extends unknown
  ? Omit<T, 'products'> & {
      products: Array<AnnotatedSupplyPathProduct<NonNullable<ListProductsResponse['products']>[number]>>;
    }
  : never;
export type ListProductsResponseWithSupplyPath = AnnotatedListProductsResponse<ListProductsResponse>;
type ProductSupplyPathVerificationOptions =
  | RegistrySupplyPathOptions
  | Omit<AuthoritativeSupplyPathOptions, 'propertySelectors'>;
export type ProductSupplyPathOptions = ProductSupplyPathVerificationOptions & {
  /** Maximum distinct paths in one discovery response. Default 64, max 256. */
  maxPaths?: number;
  /** Overall batch deadline, including all paths. Default 15 seconds, max 60 seconds. */
  timeoutMs?: number;
  signal?: AbortSignal;
};

const MAX_SELECTOR_PREPROCESS_VALUES = 32_768;
const MAX_SELECTOR_PREPROCESS_BYTES = 4 * 1024 * 1024;

function selectorPredicateFingerprint(selector: SinglePublisherPropertySelector): {
  key: string;
  values: number;
  bytes: number;
} {
  const predicate =
    selector.selection_type === 'by_id'
      ? selector.property_ids
      : selector.selection_type === 'by_tag'
        ? selector.property_tags
        : [];
  const hash = createHash('sha256').update(selector.selection_type);
  let bytes = selector.selection_type.length;
  for (const value of predicate) {
    if (value.length > 8192) throw new Error('selector_work_limit_exceeded');
    hash.update('\0').update(value);
    bytes += value.length;
  }
  return { key: hash.digest('hex'), values: predicate.length, bytes };
}

/**
 * Annotate products with external-domain collection paths. Preserves actual
 * seller products, order, and all unrelated fields. Seller-authored verification
 * fields are replaced. No result means no evidence, never a synthetic product.
 *
 * Authoritative mode also proves the selected host property scope. The registry
 * endpoint accepts only path identity. Neither mode supplies placement, country,
 * or time context or replaces the caller's buying policy.
 */
export async function annotateProductsSupplyPaths<T extends object>(
  products: readonly T[],
  agentUrl: string,
  options: ProductSupplyPathOptions = { source: 'authoritative' }
): Promise<Array<AnnotatedSupplyPathProduct<T>>> {
  if (!agentIdentity(agentUrl)) throw new TypeError('agentUrl must be an HTTPS URL without credentials');
  const maxPaths = boundedOption(options.maxPaths, 64, 256, 'maxPaths');
  const timeoutMs = boundedOption(options.timeoutMs, 15_000, 60_000, 'timeoutMs');
  if (options.source === 'authoritative')
    boundedOption(options.maxBodyBytes, 256 * 1024, 20 * 1024 * 1024, 'maxBodyBytes');
  const deadlineAt = Date.now() + timeoutMs;
  const checkPreprocessingBudget = (): void => {
    options.signal?.throwIfAborted();
    if (Date.now() >= deadlineAt) throw new Error('Supply-path discovery deadline exceeded');
  };
  const requests = new Map<string, { request: SupplyPathRequest; selectors: SinglePublisherPropertySelector[] }>();
  const selections = products.map(product => {
    checkPreprocessingBudget();
    const value = product as Record<string, unknown>;
    const keys: string[] = [];
    const errors: string[] = [];
    if (value.collections === undefined) return { keys, errors };
    if (
      !Array.isArray(value.collections) ||
      !value.collections.length ||
      !Array.isArray(value.publisher_properties) ||
      !value.publisher_properties.length ||
      value.collections.length > 1024 ||
      value.publisher_properties.length > 1024 ||
      value.collections.some(s => record(s) && Array.isArray(s.collection_ids) && s.collection_ids.length > 1024) ||
      value.publisher_properties.some(
        s =>
          record(s) &&
          [s.publisher_domains, s.property_ids, s.property_tags].some(v => Array.isArray(v) && v.length > 1024)
      )
    ) {
      return { keys, errors: ['invalid_product_selectors'] };
    }
    try {
      if (!value.publisher_properties.every(hasValidPropertySelectorPredicate))
        throw new Error('invalid_product_selector_predicate');
      const selectorsByHost = new Map<string, Map<string, SinglePublisherPropertySelector>>();
      let selectorExpansions = 0;
      let selectorValues = 0;
      let selectorBytes = 0;
      for (const raw of value.publisher_properties) {
        checkPreprocessingBudget();
        const parsed = parsePublisherPropertySelector(raw);
        const domains = 'publisher_domains' in parsed ? parsed.publisher_domains : [parsed.publisher_domain];
        const single: SinglePublisherPropertySelector =
          parsed.selection_type === 'all'
            ? { selection_type: 'all', publisher_domain: domains[0]! }
            : parsed.selection_type === 'by_id'
              ? {
                  selection_type: 'by_id',
                  publisher_domain: domains[0]!,
                  property_ids: parsed.property_ids,
                }
              : {
                  selection_type: 'by_tag',
                  publisher_domain: domains[0]!,
                  property_tags: parsed.property_tags,
                };
        const predicate = selectorPredicateFingerprint(single);
        selectorExpansions += domains.length;
        selectorValues += domains.length + predicate.values * Math.min(domains.length, maxPaths);
        selectorBytes +=
          domains.reduce((total, publisher) => total + publisher.length, 0) +
          predicate.bytes * Math.min(domains.length, maxPaths);
        if (selectorExpansions > 4096) throw new Error('selector_work_limit_exceeded');
        if (selectorValues > MAX_SELECTOR_PREPROCESS_VALUES || selectorBytes > MAX_SELECTOR_PREPROCESS_BYTES)
          throw new Error('selector_work_limit_exceeded');
        for (const publisher_domain of domains) {
          checkPreprocessingBudget();
          let selectors = selectorsByHost.get(publisher_domain);
          if (!selectors) {
            selectors = new Map();
            selectorsByHost.set(publisher_domain, selectors);
          }
          selectors.set(predicate.key, { ...single, publisher_domain });
        }
      }
      const collectionIdsByOwner = new Map<string, Set<string>>();
      for (const selector of value.collections) {
        checkPreprocessingBudget();
        if (
          !record(selector) ||
          !Object.keys(selector).every(key => ['publisher_domain', 'collection_ids'].includes(key)) ||
          !domain(selector.publisher_domain) ||
          !strings(selector.collection_ids)
        )
          throw new Error('invalid_collection_selector');
        const owner = domain(selector.publisher_domain)!;
        let ids = collectionIdsByOwner.get(owner);
        if (!ids) {
          ids = new Set();
          collectionIdsByOwner.set(owner, ids);
        }
        for (const id of selector.collection_ids) ids.add(id);
      }
      for (const [owner, collectionIds] of collectionIdsByOwner) {
        for (const [host, selectorsByKey] of selectorsByHost) {
          if (domain(host) === owner) continue;
          const selectorEntries = [...selectorsByKey.entries()].sort(([left], [right]) => left.localeCompare(right));
          const selectors = selectorEntries.map(([, selector]) => selector);
          const selectorKey = selectorEntries.map(([key]) => key).join(':');
          for (const id of collectionIds) {
            checkPreprocessingBudget();
            const request = validateSupplyPathRequest({
              owner_domain: owner,
              host_domain: host,
              agent_url: agentUrl,
              collection_id: id,
            });
            const key = `${JSON.stringify(request)}\0${selectorKey}`;
            if (!requests.has(key) && requests.size >= maxPaths) {
              if (!errors.includes('path_limit_exceeded')) errors.push('path_limit_exceeded');
              return { keys, errors };
            }
            requests.set(key, { request, selectors });
            if (!keys.includes(key)) keys.push(key);
          }
        }
      }
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : '';
      errors.push(
        ['invalid_product_selector_predicate', 'selector_work_limit_exceeded', 'invalid_collection_selector'].includes(
          code
        )
          ? code
          : 'invalid_product_selectors'
      );
    }
    return { keys, errors };
  });
  const outcomes = new Map<string, RegistrySupplyPathResult | AuthoritativeSupplyPathResult>();
  // Bound fan-out without allocating one network operation per product.
  const pending = [...requests.entries()];
  let position = 0;
  checkPreprocessingBudget();
  const controller = new AbortController();
  const onAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  const timer = setTimeout(
    () => controller.abort(new Error('Supply-path discovery deadline exceeded')),
    Math.max(1, deadlineAt - Date.now())
  );
  let session: SupplyPathEvidenceSession | undefined;
  let onDeadline: () => void = () => {};
  try {
    session =
      options.source === 'authoritative'
        ? new SupplyPathEvidenceSession({
            ...options,
            signal: controller.signal,
            timeoutMs: Math.max(1, deadlineAt - Date.now()),
          })
        : undefined;
    controller.signal.throwIfAborted();
    const aborted = new Promise<never>((_, reject) => {
      onDeadline = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', onDeadline, { once: true });
    });
    await Promise.race([
      aborted,
      Promise.all(
        Array.from({ length: Math.min(4, pending.length) }, async () => {
          while (position < pending.length) {
            controller.signal.throwIfAborted();
            const [key, { request, selectors }] = pending[position++]!;
            outcomes.set(
              key,
              options.source === 'authoritative'
                ? await verifyAuthoritativeSupplyPath(request, { ...options, propertySelectors: selectors }, session!)
                : await verifySupplyPath(request, options)
            );
          }
        })
      ),
    ]);
  } finally {
    session?.close();
    controller.abort(new Error('Supply-path annotation batch closed'));
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
    controller.signal.removeEventListener('abort', onDeadline);
  }
  return products.map((product, index) => {
    const {
      supply_path_state: _state,
      supply_path_verification: _verification,
      ...rest
    } = product as T & ProductSupplyPathAnnotation;
    void _state;
    void _verification;
    const { keys, errors } = selections[index]!;
    if (!keys.length && !errors.length) return rest as AnnotatedSupplyPathProduct<T>;
    const paths = keys.map(key => outcomes.get(key)!);
    const state = errors.length
      ? 'unverified'
      : paths.reduce<SupplyPathState>(
          (least, result) =>
            SUPPLY_PATH_STATES.indexOf(result.state) < SUPPLY_PATH_STATES.indexOf(least) ? result.state : least,
          'verified_owner_sold'
        );
    return {
      ...rest,
      supply_path_state: state,
      supply_path_verification: {
        source: options.source,
        scope: options.source === 'authoritative' ? 'product_properties' : 'owner_host_collection',
        paths,
        errors,
      },
    } as AnnotatedSupplyPathProduct<T>;
  });
}
