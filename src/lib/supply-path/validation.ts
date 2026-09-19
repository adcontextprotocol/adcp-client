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
  const fail = (invariant: string): never => {
    throw new TypeError(
      `Invalid registry supply-path response: ${invariant}; verification cannot be accepted, check the registry response contract`
    );
  };
  if (!record(value)) return fail('response must be an object');
  if (value.semantics_version !== '1')
    throw new TypeError('Invalid registry supply-path response: semantics_version 1 required; upgrade the registry');
  if (!record(value.legs) || !record(value.sources)) return fail('legs and sources must be objects');
  if (!['verified_owner_sold', 'host_delegated', 'owner_attested', 'unverified'].includes(String(value.state)))
    return fail('state is not recognized');
  if (
    domain(value.owner_domain) !== request.owner_domain ||
    domain(value.host_domain) !== request.host_domain ||
    agentIdentity(value.agent_url) !== agentIdentity(request.agent_url) ||
    value.collection_id !== request.collection_id
  )
    return fail('request identity does not match the submitted owner, host, agent, and collection');
  if (
    typeof value.checked_at !== 'string' ||
    !Number.isFinite(Date.parse(value.checked_at)) ||
    typeof value.sources.cached !== 'boolean'
  )
    return fail('checked_at or sources.cached provenance is malformed');
  for (const key of ['owner_adagents_url', 'host_adagents_url']) {
    if (typeof value.sources[key] !== 'string') return fail(`sources.${key} must be an HTTPS URL`);
    try {
      const url = new URL(value.sources[key]);
      if (url.protocol !== 'https:' || url.username || url.password)
        return fail(`sources.${key} must be an HTTPS URL without credentials`);
    } catch {
      return fail(`sources.${key} must be a valid URL`);
    }
  }
  for (const key of ['owner_fetched_at', 'host_fetched_at']) {
    const timestamp = value.sources[key];
    if (timestamp !== null && (typeof timestamp !== 'string' || !Number.isFinite(Date.parse(timestamp))))
      return fail(`sources.${key} must be null or a valid timestamp`);
  }
  for (const key of ['owner_resolved_url', 'host_resolved_url']) {
    const location = value.sources[key];
    if (location === null) continue;
    if (typeof location !== 'string' || location.length > 8192)
      return fail(`sources.${key} must be null or a bounded HTTPS URL`);
    try {
      const parsed = new URL(location);
      if (
        parsed.protocol !== 'https:' ||
        parsed.username ||
        parsed.password ||
        parsed.hash ||
        (parsed.port && parsed.port !== '443')
      )
        return fail(`sources.${key} must be an HTTPS URL without credentials, fragments, or nonstandard ports`);
    } catch {
      return fail(`sources.${key} must be a valid URL`);
    }
  }
  const legNames = [
    'owner_collection_declared',
    'owner_distribution_carriage',
    'owner_agent_declared',
    'host_authorization',
    'inventory_partner_domain',
  ];
  for (const key of legNames) {
    const leg = value.legs[key];
    if (!record(leg) || typeof leg.ok !== 'boolean' || (leg.detail !== undefined && typeof leg.detail !== 'string'))
      return fail(`legs.${key} is malformed`);
    if (leg.ok ? leg.failure !== undefined : typeof leg.failure !== 'string' || !leg.failure.length)
      return fail(`legs.${key} has an inconsistent ok/failure pair`);
    for (const ids of ['property_ids_matched', 'property_ids_unmatched']) {
      if (leg[ids] !== undefined && (!Array.isArray(leg[ids]) || !leg[ids].every(id => typeof id === 'string')))
        return fail(`legs.${key}.${ids} must contain only string property IDs`);
    }
  }
  const ok = (key: string) => (value.legs as Record<string, Record<string, unknown>>)[key]?.ok === true;
  if (ok('owner_collection_declared')) {
    if (
      typeof value.resolved_collection_id !== 'string' ||
      !value.resolved_collection_id.trim() ||
      value.resolved_collection_id.length > 256 ||
      (request.collection_id !== undefined && value.resolved_collection_id !== request.collection_id)
    )
      return fail('resolved_collection_id is missing, malformed, or inconsistent with the request');
  } else if (value.resolved_collection_id !== undefined)
    return fail('resolved_collection_id requires a successful owner collection leg');
  // Check the registry's documented ladder; do not silently recompute a remote
  // verdict using assumptions about evidence that was not returned.
  if (
    value.state === 'verified_owner_sold' &&
    !(ok('owner_collection_declared') && ok('owner_distribution_carriage') && ok('host_authorization'))
  )
    return fail('verified_owner_sold is inconsistent with its required successful legs');
  if (
    value.state === 'host_delegated' &&
    !(ok('owner_collection_declared') && ok('owner_agent_declared') && ok('inventory_partner_domain'))
  )
    return fail('host_delegated is inconsistent with its required successful legs');
  if (value.state === 'owner_attested' && !ok('owner_collection_declared'))
    return fail('owner_attested requires a successful owner collection leg');
}
