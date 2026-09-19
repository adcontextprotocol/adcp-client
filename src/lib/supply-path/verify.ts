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
  if (options.propertySelectors !== undefined) {
    const ids = new Set<string>();
    const properties = records(hostManifest?.properties).filter(
      p =>
        (p.publisher_domain === undefined && !input.requireExplicitHostPublisherDomain) ||
        domain(p.publisher_domain) === normalized.host_domain
    );
    let unresolved = false;
    for (const raw of options.propertySelectors) {
      const selector = parsePublisherPropertySelector(raw);
      for (const single of expandPublisherPropertySelector(selector)) {
        if (domain(single.publisher_domain) !== normalized.host_domain)
          throw new TypeError('propertySelectors must name host_domain');
        if (single.selection_type === 'by_id') {
          if (!strings(single.property_ids)) throw new TypeError('Invalid product property IDs');
          for (const id of single.property_ids) ids.add(id);
        } else {
          if (single.selection_type === 'by_tag' && !strings(single.property_tags))
            throw new TypeError('Invalid product property tags');
          let matched = false;
          for (const property of properties) {
            const selected =
              single.selection_type === 'all' ||
              (strings(property.tags) && property.tags.some(tag => single.property_tags.includes(tag)));
            if (!selected) continue;
            matched = true;
            if (typeof property.property_id !== 'string' || !property.property_id.length) unresolved = true;
            else ids.add(property.property_id);
          }
          if (!matched) unresolved = true;
        }
      }
    }
    scopedInput.requiredHostPropertyIds = unresolved ? [] : [...ids];
  }
  let verdict = evaluateSupplyPath(scopedInput);
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
    verdict = evaluateSupplyPath(scopedInput);
  } else if (verdict.legs.host_authorization.ok) {
    verdict = evaluateSupplyPath({ ...scopedInput, inventoryPartnerDomainEvaluated: false });
  }
  session.signal.throwIfAborted();
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
