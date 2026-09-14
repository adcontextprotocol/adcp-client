import type { SinglePublisherPropertySelector } from '../discovery/types';
import { verifySupplyPath, verifyAuthoritativeSupplyPath } from './verify';
import { SUPPLY_PATH_STATES, isUnqualifiedPropertySelector } from './evaluate';
import { boundedOption, SupplyPathEvidenceSession } from './fetch-evidence';
import { domain, record, strings, validateSupplyPathRequest } from './validation';
import {
  parsePublisherPropertySelector,
  expandPublisherPropertySelector,
} from '../discovery/publisher-property-selector';
import type {
  SupplyPathRequest,
  SupplyPathState,
  RegistrySupplyPathResult,
  AuthoritativeSupplyPathResult,
  VerifySupplyPathOptions,
} from './types';

export interface ProductSupplyPathAnnotation {
  /** Weakest external owner/host/collection path. Not a whole-product authorization decision. */
  supply_path_state?: SupplyPathState;
  supply_path_verification?: (
    | { source: 'registry'; scope: 'owner_host_collection'; paths: RegistrySupplyPathResult[] }
    | { source: 'authoritative'; scope: 'product_properties'; paths: AuthoritativeSupplyPathResult[] }
  ) & { errors: string[] };
}
export type ProductSupplyPathOptions = VerifySupplyPathOptions & {
  /** Maximum distinct paths in one discovery response. Default 64, max 256. */
  maxPaths?: number;
  /** Overall batch deadline, including all paths. Default 15 seconds, max 60 seconds. */
  timeoutMs?: number;
  signal?: AbortSignal;
};

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
): Promise<Array<T & ProductSupplyPathAnnotation>> {
  const maxPaths = boundedOption(options.maxPaths, 64, 256, 'maxPaths');
  const requests = new Map<string, { request: SupplyPathRequest; selectors: SinglePublisherPropertySelector[] }>();
  const selections = products.map(product => {
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
      if (!value.publisher_properties.every(isUnqualifiedPropertySelector))
        throw new Error('unsupported_product_selector_fields');
      const propertySelectors = value.publisher_properties.flatMap(raw =>
        expandPublisherPropertySelector(parsePublisherPropertySelector(raw))
      );
      const hosts = [...new Set(propertySelectors.map(s => s.publisher_domain))];
      for (const selector of value.collections) {
        if (
          !record(selector) ||
          !Object.keys(selector).every(key => ['publisher_domain', 'collection_ids'].includes(key)) ||
          !domain(selector.publisher_domain) ||
          !strings(selector.collection_ids)
        )
          throw new Error('invalid_collection_selector');
        const owner = domain(selector.publisher_domain)!;
        for (const host of hosts) {
          if (domain(host) === owner) continue;
          for (const id of selector.collection_ids) {
            const request = validateSupplyPathRequest({
              owner_domain: owner,
              host_domain: host,
              agent_url: agentUrl,
              collection_id: id,
            });
            const selectors = propertySelectors.filter(s => s.publisher_domain === host);
            const key = JSON.stringify({ request, selectors });
            if (!requests.has(key) && requests.size >= maxPaths) {
              if (!errors.includes('path_limit_exceeded')) errors.push('path_limit_exceeded');
              return { keys, errors };
            }
            requests.set(key, { request, selectors });
            if (!keys.includes(key)) keys.push(key);
          }
        }
      }
    } catch {
      errors.push('invalid_product_selectors');
    }
    return { keys, errors };
  });
  const outcomes = new Map<string, RegistrySupplyPathResult | AuthoritativeSupplyPathResult>();
  // Bound fan-out without allocating one network operation per product.
  const pending = [...requests.entries()];
  let position = 0;
  const timeoutMs = boundedOption(options.timeoutMs, 15_000, 60_000, 'timeoutMs');
  const controller = new AbortController();
  const onAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  const timer = setTimeout(() => controller.abort(new Error('Supply-path discovery deadline exceeded')), timeoutMs);
  const session =
    options.source === 'authoritative'
      ? new SupplyPathEvidenceSession({ ...options, signal: controller.signal })
      : undefined;
  let onDeadline: () => void = () => {};
  try {
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
    if (!keys.length && !errors.length) return rest as T & ProductSupplyPathAnnotation;
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
    } as T & ProductSupplyPathAnnotation;
  });
}
