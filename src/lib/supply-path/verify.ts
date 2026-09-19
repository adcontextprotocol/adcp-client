import { withAbortSignal } from '../protocols/abort';
import {
  parsePublisherPropertySelector,
  expandPublisherPropertySelector,
} from '../discovery/publisher-property-selector';
import { domain, records, strings } from './validation';
import { RegistryClient } from '../registry';
import { SupplyPathEvidenceSession } from './fetch-evidence';
import {
  isUnqualifiedPropertySelector,
  hasValidPropertySelectorPredicate,
  evaluateSupplyPath,
  evaluationLimitVerdict,
  supplyPathAdsTxtPolicy,
  parseInventoryPartnerDomains,
} from './evaluate';
import { assertRegistrySupplyPathResult, validateSupplyPathRequest } from './validation';
import type {
  SupplyPathRequest,
  VerifySupplyPathOptions,
  RegistrySupplyPathOptions,
  AuthoritativeSupplyPathOptions,
  RegistrySupplyPathResult,
  AuthoritativeSupplyPathResult,
} from './types';

const MAX_PROPERTY_SCOPE_VALUES = 32_768;
const MAX_PROPERTY_SELECTOR_EXPANSIONS = 4_096;

/**
 * Verify one owner/host/agent path. Authoritative mode (the default) fetches
 * live publisher evidence; registry mode validates a remote cached verdict.
 * Invalid evidence rejects or returns a fail-closed verdict—it is never
 * converted into synthetic authorization.
 *
 * @example
 * ```ts
 * const verdict = await verifySupplyPath({
 *   owner_domain: 'owner.example',
 *   host_domain: 'host.example',
 *   agent_url: 'https://sales.example',
 *   collection_id: 'news',
 * });
 * ```
 *
 * @see docs/guides/SUPPLY-PATH-VERIFICATION.md
 */
export function verifySupplyPath(
  request: SupplyPathRequest,
  options: RegistrySupplyPathOptions
): Promise<RegistrySupplyPathResult>;
export function verifySupplyPath(
  request: SupplyPathRequest,
  options?: AuthoritativeSupplyPathOptions
): Promise<AuthoritativeSupplyPathResult>;
export function verifySupplyPath(
  request: SupplyPathRequest,
  options: VerifySupplyPathOptions
): Promise<RegistrySupplyPathResult | AuthoritativeSupplyPathResult>;
export async function verifySupplyPath(
  request: SupplyPathRequest,
  options: VerifySupplyPathOptions = { source: 'authoritative' }
): Promise<RegistrySupplyPathResult | AuthoritativeSupplyPathResult> {
  const normalized = validateSupplyPathRequest(request);
  if (options.source === 'registry') {
    const result = await (options.registry ?? new RegistryClient()).verifySupplyPath(normalized);
    assertRegistrySupplyPathResult(result, normalized);
    return result;
  }
  if (options.source !== 'authoritative') throw new TypeError('source must be registry or authoritative');
  const session = new SupplyPathEvidenceSession(options);
  try {
    return await withAbortSignal([session.signal], undefined, () =>
      verifyAuthoritativeSupplyPath(normalized, options, session)
    );
  } finally {
    session.close();
  }
}

/** Internal batch entrypoint; callers cannot supply evidence through the public API. */
export async function verifyAuthoritativeSupplyPath(
  normalized: SupplyPathRequest,
  options: AuthoritativeSupplyPathOptions,
  session: SupplyPathEvidenceSession
): Promise<AuthoritativeSupplyPathResult> {
  if (options.propertySelectors !== undefined) {
    if (!Array.isArray(options.propertySelectors) || !options.propertySelectors.length)
      throw new TypeError('propertySelectors must be non-empty');
    if (options.propertySelectors.length > 1024)
      throw new TypeError('propertySelectors exceed the evaluation work limit');
    for (const raw of options.propertySelectors) {
      if (!isUnqualifiedPropertySelector(raw)) throw new TypeError('Unsupported product property selector fields');
      if (!hasValidPropertySelectorPredicate(raw))
        throw new TypeError('Product property selector predicate conflicts with selection_type');
    }
  }
  const [ownerManifest, hostManifest] = await Promise.all([
    session.adagents(normalized.owner_domain),
    session.adagents(normalized.host_domain),
  ]);
  const input = {
    ownerDomain: normalized.owner_domain,
    hostDomain: normalized.host_domain,
    agentUrl: normalized.agent_url,
    collectionId: normalized.collection_id,
    ownerManifest,
    hostManifest,
    requireExplicitOwnerPublisherDomain: session.crossOriginAuthorities.has(normalized.owner_domain),
    requireExplicitHostPublisherDomain: session.crossOriginAuthorities.has(normalized.host_domain),
    hostInventoryPartnerDomains: null as string[] | null,
    hostInventoryPartnerDomainsByFile:
      undefined as import('./types').SupplyPathInput['hostInventoryPartnerDomainsByFile'],
    heldRevocations: {
      owner: session.revocations.get(normalized.owner_domain)?.map(r => r.publisher_domain),
      host: session.revocations.get(normalized.host_domain)?.map(r => r.publisher_domain),
    },
  };
  const scopedInput: typeof input & { requiredHostPropertyIds?: string[] } = input;
  let selectorLimitExceeded = false;
  if (options.propertySelectors !== undefined) {
    const ids = new Set<string>();
    const rawProperties = hostManifest?.properties;
    if (Array.isArray(rawProperties) && rawProperties.length > 1024) selectorLimitExceeded = true;
    const properties = selectorLimitExceeded
      ? []
      : records(rawProperties).filter(
          p =>
            (p.publisher_domain === undefined && !input.requireExplicitHostPublisherDomain) ||
            domain(p.publisher_domain) === normalized.host_domain
        );
    let unresolved = false;
    let scopeValues = properties.length;
    const availableTags = new Set<string>();
    for (const property of properties) {
      session.assertActive();
      if (property.tags === undefined) continue;
      if (!strings(property.tags) || property.tags.length > 1024) {
        selectorLimitExceeded = true;
        continue;
      }
      scopeValues += property.tags.length;
      if (scopeValues > MAX_PROPERTY_SCOPE_VALUES) {
        selectorLimitExceeded = true;
        break;
      }
      for (const tag of property.tags) {
        if (tag.length > 8192) selectorLimitExceeded = true;
        availableTags.add(tag);
      }
    }
    const selectors = [] as ReturnType<typeof expandPublisherPropertySelector>;
    for (const raw of options.propertySelectors) {
      session.assertActive();
      if (selectorLimitExceeded) continue;
      const selector = parsePublisherPropertySelector(raw);
      const expansionCount = 'publisher_domains' in selector ? selector.publisher_domains.length : 1;
      if (selectors.length + expansionCount > MAX_PROPERTY_SELECTOR_EXPANSIONS) {
        selectorLimitExceeded = true;
        continue;
      }
      const expanded = expandPublisherPropertySelector(selector);
      selectors.push(...expanded);
    }
    const selectedTags = new Set<string>();
    let selectAll = false;
    for (const single of selectors) {
      session.assertActive();
      scopeValues += 1;
      if (scopeValues > MAX_PROPERTY_SCOPE_VALUES) selectorLimitExceeded = true;
      if (!selectorLimitExceeded) {
        if (domain(single.publisher_domain) !== normalized.host_domain)
          throw new TypeError('propertySelectors must name host_domain');
        if (single.selection_type === 'by_id') {
          if (!strings(single.property_ids)) throw new TypeError('Invalid product property IDs');
          scopeValues += single.property_ids.length;
          if (single.property_ids.length > 1024 || single.property_ids.some(id => id.length > 8192))
            selectorLimitExceeded = true;
          for (const id of single.property_ids) ids.add(id);
        } else {
          if (single.selection_type === 'by_tag' && !strings(single.property_tags))
            throw new TypeError('Invalid product property tags');
          if (single.selection_type === 'all') {
            selectAll = true;
            if (!properties.length) unresolved = true;
          } else {
            scopeValues += single.property_tags.length;
            if (single.property_tags.length > 1024 || single.property_tags.some(tag => tag.length > 8192))
              selectorLimitExceeded = true;
            let matched = false;
            for (const tag of single.property_tags) {
              if (!availableTags.has(tag)) continue;
              matched = true;
              selectedTags.add(tag);
            }
            if (!matched) unresolved = true;
          }
        }
      }
    }
    if (scopeValues > MAX_PROPERTY_SCOPE_VALUES) selectorLimitExceeded = true;
    if (!selectorLimitExceeded && (selectAll || selectedTags.size)) {
      for (const property of properties) {
        session.assertActive();
        const selected = selectAll || (strings(property.tags) && property.tags.some(tag => selectedTags.has(tag)));
        if (!selected) continue;
        if (typeof property.property_id !== 'string' || !property.property_id.length) unresolved = true;
        else ids.add(property.property_id);
      }
    }
    scopedInput.requiredHostPropertyIds = selectorLimitExceeded || unresolved ? [] : [...ids];
  }
  session.assertActive();
  let verdict = selectorLimitExceeded ? evaluationLimitVerdict() : evaluateSupplyPath(scopedInput);
  session.assertActive();
  if (!verdict.legs.host_authorization.ok && verdict.legs.host_authorization.failure !== 'evaluation_limit_exceeded') {
    const policy = supplyPathAdsTxtPolicy(scopedInput);
    const responses = await Promise.all(
      policy.files.map(kind => session.read(normalized.host_domain, kind, `https://${normalized.host_domain}/${kind}`))
    );
    input.hostInventoryPartnerDomainsByFile = Object.fromEntries(
      policy.files.map((file, index) => [
        file,
        responses[index] ? parseInventoryPartnerDomains(new TextDecoder().decode(responses[index]!.body)) : null,
      ])
    );
    session.assertActive();
    verdict = evaluateSupplyPath(scopedInput);
    session.assertActive();
  } else if (verdict.legs.host_authorization.ok) {
    verdict = evaluateSupplyPath({ ...scopedInput, inventoryPartnerDomainEvaluated: false });
    session.assertActive();
  }
  session.assertActive();
  return {
    ...verdict,
    ...normalized,
    source: 'authoritative',
    ...(options.propertySelectors ? { property_selectors: options.propertySelectors } : {}),
    sources: {
      owner_adagents_url: `https://${normalized.owner_domain}/.well-known/adagents.json`,
      host_adagents_url: `https://${normalized.host_domain}/.well-known/adagents.json`,
      cached: false,
      held_revocations: [...session.revocations]
        .filter(([authority]) => authority === normalized.owner_domain || authority === normalized.host_domain)
        .map(([authority, entries]) => ({ authority, entries })),
      evidence: session.evidence.filter(
        e => e.publisher_domain === normalized.owner_domain || e.publisher_domain === normalized.host_domain
      ),
    },
    checked_at: new Date().toISOString(),
  };
}
