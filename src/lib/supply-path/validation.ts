import { isIP } from 'node:net';
import { canonicalizeAgentUrl } from '../discovery/resolve-agent-properties';
import type { SupplyPathRequest } from './types';

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(record) : [];
}
export function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(v => typeof v === 'string' && v.trim().length > 0);
}
/** Domain identity never strips www or conflates sibling publisher namespaces. */
export function domain(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.toLowerCase().replace(/\.$/, '');
  if (normalized.length > 253 || isIP(normalized) || !normalized.includes('.')) return null;
  return normalized.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ? normalized : null;
}
export function agentIdentity(value: unknown): string | null {
  if (typeof value !== 'string' || /[\s\x00-\x1f\x7f]/.test(value)) return null;
  const canonical = canonicalizeAgentUrl(value);
  return canonical?.startsWith('https://') ? canonical : null;
}
export function validateSupplyPathRequest(input: SupplyPathRequest): SupplyPathRequest {
  if (!record(input)) throw new TypeError('Supply-path request must be an object');
  const owner = domain(input.owner_domain);
  const host = domain(input.host_domain);
  if (!owner || !host) throw new TypeError('owner_domain and host_domain must be DNS publisher domains');
  if (!agentIdentity(input.agent_url)) throw new TypeError('agent_url must be an HTTPS URL without credentials');
  if (
    input.collection_id !== undefined &&
    (typeof input.collection_id !== 'string' || !input.collection_id.trim() || input.collection_id.length > 256)
  ) {
    throw new TypeError('collection_id must be a non-empty string of at most 256 characters');
  }
  return {
    owner_domain: owner,
    host_domain: host,
    agent_url: input.agent_url,
    ...(input.collection_id !== undefined ? { collection_id: input.collection_id } : {}),
  };
}

/** Runtime boundary for cached remote verdicts. Unknown extensions are preserved. */
export function assertRegistrySupplyPathResult(
  value: unknown,
  request: SupplyPathRequest
): asserts value is import('./types').RegistrySupplyPathResult {
  const fail = (): never => {
    throw new TypeError('Invalid registry supply-path response');
  };
  if (!record(value) || value.semantics_version !== '1' || !record(value.legs) || !record(value.sources)) return fail();
  if (!['verified_owner_sold', 'host_delegated', 'owner_attested', 'unverified'].includes(String(value.state)))
    return fail();
  if (
    domain(value.owner_domain) !== request.owner_domain ||
    domain(value.host_domain) !== request.host_domain ||
    agentIdentity(value.agent_url) !== agentIdentity(request.agent_url) ||
    value.collection_id !== request.collection_id
  )
    return fail();
  if (
    typeof value.checked_at !== 'string' ||
    !Number.isFinite(Date.parse(value.checked_at)) ||
    typeof value.sources.cached !== 'boolean'
  )
    return fail();
  for (const key of ['owner_adagents_url', 'host_adagents_url']) {
    if (typeof value.sources[key] !== 'string') return fail();
    try {
      const url = new URL(value.sources[key]);
      if (url.protocol !== 'https:' || url.username || url.password) return fail();
    } catch {
      return fail();
    }
  }
  const failures: Record<string, string[]> = {
    owner_collection_declared: ['manifest_not_found', 'no_collections_declared', 'collection_not_declared'],
    owner_distribution_carriage: [
      'collection_leg_failed',
      'no_distribution_for_host',
      'property_ids_unresolved',
      'host_manifest_not_found',
    ],
    owner_agent_declared: ['manifest_not_found', 'agent_not_declared_by_owner'],
    host_authorization: [
      'manifest_not_found',
      'no_agent_entry',
      'collection_scope_mismatch',
      'property_scope_mismatch',
    ],
    inventory_partner_domain: ['not_declared', 'ads_txt_unavailable'],
  };
  for (const key of Object.keys(failures)) {
    const leg = value.legs[key];
    if (!record(leg) || typeof leg.ok !== 'boolean' || (leg.detail !== undefined && typeof leg.detail !== 'string'))
      return fail();
    if (leg.ok ? leg.failure !== undefined : typeof leg.failure !== 'string' || !leg.failure.length) return fail();
    for (const ids of ['property_ids_matched', 'property_ids_unmatched']) {
      if (leg[ids] !== undefined && (!Array.isArray(leg[ids]) || !leg[ids].every(id => typeof id === 'string')))
        return fail();
    }
  }
  const ok = (key: string) => (value.legs as Record<string, Record<string, unknown>>)[key]?.ok === true;
  // Check the registry's documented ladder; do not silently recompute a remote
  // verdict using assumptions about evidence that was not returned.
  if (
    value.state === 'verified_owner_sold' &&
    !(ok('owner_collection_declared') && ok('owner_distribution_carriage') && ok('host_authorization'))
  )
    return fail();
  if (
    value.state === 'host_delegated' &&
    !(ok('owner_collection_declared') && ok('owner_agent_declared') && ok('inventory_partner_domain'))
  )
    return fail();
  if (value.state === 'owner_attested' && !ok('owner_collection_declared')) return fail();
}
