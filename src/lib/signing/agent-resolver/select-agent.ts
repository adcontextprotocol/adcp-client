/**
 * Step 5 of the brand_json_url discovery algorithm: locate the brand.json
 * `agents[]` entry whose canonical URL matches the agent being resolved.
 *
 * Both flat (`agents[]` at top level) and house-portfolio
 * (`house.agents[]` + `brands[].agents[]`) brand.json shapes are supported,
 * because either may carry the entry that matches the agent URL.
 */
import { canonicalTargetUri, rejectNonAsciiHost } from '../canonicalize';

/** Shared identifier rules, including query escapes (unlike the signing profile's raw query). */
export function canonicalAgentUrl(raw: string): string {
  const authority = /^[a-z][a-z0-9+.\-]*:\/\/([^/?#]*)/i.exec(raw)?.[1];
  if (authority) rejectNonAsciiHost(`https://${authority.slice(authority.lastIndexOf('@') + 1)}`);
  const canonical = canonicalTargetUri(raw, '3.2');
  if (!/^https?:\/\//.test(canonical)) throw new TypeError('Agent identifier must be an HTTP(S) URL');
  return canonical.replace(/%([0-9a-f]{2})/gi, (_escape, hex: string) => {
    const character = String.fromCharCode(parseInt(hex, 16));
    return /^[a-z0-9._~-]$/i.test(character) ? character : `%${hex.toUpperCase()}`;
  });
}

export type AgentSelectorErrorCode = 'agent_not_in_brand_json' | 'brand_json_ambiguous';

export interface AgentEntry {
  url: string;
  jwks_uri?: string;
  /** Other fields preserved verbatim — the resolver passes the entry to the caller. */
  [key: string]: unknown;
}

export interface AgentSelector {
  agentType?: string;
  agentId?: string;
}

/** The key source always belongs to the matched entry, never to the artifact. */
export function agentJwksUri(entry: AgentEntry): string {
  if (entry.jwks_uri !== undefined) {
    if (typeof entry.jwks_uri !== 'string' || !entry.jwks_uri) throw new TypeError('Invalid jwks_uri');
    const source = new URL(entry.jwks_uri);
    if (source.username || source.password) throw new TypeError('JWKS URI must not contain userinfo');
    canonicalAgentUrl(entry.jwks_uri);
    return entry.jwks_uri;
  }
  return `${new URL(canonicalAgentUrl(entry.url)).origin}/.well-known/jwks.json`;
}

export class AgentSelectorError extends Error {
  readonly code: AgentSelectorErrorCode;
  readonly detail: { agent_url: string; matched_count?: number; matched_entries?: AgentEntry[] };
  constructor(
    code: AgentSelectorErrorCode,
    message: string,
    detail: { agent_url: string; matched_count?: number; matched_entries?: AgentEntry[] }
  ) {
    super(message);
    this.name = 'AgentSelectorError';
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Walk every `agents[]` array reachable from the brand.json document and
 * collect entries with a string `url`. Entries without a string `url` are
 * silently skipped — they cannot match an agent URL, and rejecting the
 * whole document here would let a single malformed entry deny verification
 * for every agent the document declares.
 */
export function collectAgentEntries(brandJson: unknown): AgentEntry[] {
  return agentCollections(brandJson).flat();
}

function agentCollections(brandJson: unknown): AgentEntry[][] {
  if (!brandJson || typeof brandJson !== 'object') return [];
  const collections: AgentEntry[][] = [];
  const obj = brandJson as Record<string, unknown>;
  const add = (value: unknown) => {
    const entries: AgentEntry[] = [];
    pushAgentArray(value, entries);
    collections.push(entries);
  };
  if (obj.agents !== undefined) {
    add(obj.agents);
    return collections;
  }
  const house = obj.house;
  if (house && typeof house === 'object') {
    add((house as Record<string, unknown>).agents);
    if (Array.isArray(obj.brands)) {
      for (const brand of obj.brands) {
        if (brand && typeof brand === 'object') add((brand as Record<string, unknown>).agents);
      }
    }
  }
  return collections;
}

function pushAgentArray(value: unknown, out: AgentEntry[]): void {
  if (!Array.isArray(value)) return;
  for (const entry of value) {
    if (entry && typeof entry === 'object') {
      const e = entry as Record<string, unknown>;
      if (typeof e.url === 'string') {
        out.push(e as AgentEntry);
      }
    }
  }
}

/**
 * Find the unique canonical match. Portfolio repetitions across collections
 * count once when their type and canonical JWKS source agree. Duplicates
 * within one collection remain ambiguous. Type/id only narrow URL matches.
 *
 * - Returns the matched entry on a unique hit.
 * - Throws `AgentSelectorError('agent_not_in_brand_json')` on zero matches.
 * - Throws `AgentSelectorError('brand_json_ambiguous')` on multiple matches.
 *   `matched_count` and `matched_entries` are populated on the error so the
 *   caller can map them onto `request_signature_brand_json_ambiguous` detail
 *   fields. `matched_entries` reflects counterparty-controlled state and is
 *   marked attacker-influenceable in the resolver's error mapping.
 */
export function selectAgentByUrl(brandJson: unknown, agentUrl: string, selector: AgentSelector = {}): AgentEntry {
  const canonicalUrl = canonicalAgentUrl(agentUrl);
  const matches: AgentEntry[] = [];
  const seen = new Set<string>();
  for (const collection of agentCollections(brandJson)) {
    const local = collection.filter(e => {
      try {
        return (
          canonicalAgentUrl(e.url) === canonicalUrl &&
          (selector.agentType === undefined || e.type === selector.agentType) &&
          (selector.agentId === undefined || e.id === selector.agentId)
        );
      } catch {
        return false;
      }
    });
    // Repetitions in a single array are not shared portfolio declarations.
    if (local.length > 1) {
      throw new AgentSelectorError('brand_json_ambiguous', `Multiple brand.json agent entries match ${agentUrl}`, {
        agent_url: agentUrl,
        matched_count: local.length,
        matched_entries: local,
      });
    }
    for (const entry of local) {
      const source = JSON.stringify([entry.type, canonicalAgentUrl(agentJwksUri(entry))]);
      if (!seen.has(source)) {
        seen.add(source);
        matches.push(entry);
      }
    }
  }
  if (matches.length === 0) {
    throw new AgentSelectorError(
      'agent_not_in_brand_json',
      `No brand.json agent entry has canonical URL ${canonicalUrl}`,
      { agent_url: agentUrl }
    );
  }
  if (matches.length > 1) {
    throw new AgentSelectorError('brand_json_ambiguous', `Multiple brand.json agent entries match ${agentUrl}`, {
      agent_url: agentUrl,
      matched_count: matches.length,
      matched_entries: matches,
    });
  }
  return matches[0]!;
}

/** Select a relying party's collection without incorporating sibling brands. */
export function relyingPartyAgentRecord(brandJson: unknown, brandDomain: string): unknown {
  if (!brandJson || typeof brandJson !== 'object') throw new TypeError('Invalid brand.json');
  const obj = brandJson as Record<string, unknown>;
  if (!obj.house || typeof obj.house !== 'object') return obj;
  const domainHost = (domain: unknown): string => {
    if (
      typeof domain !== 'string' ||
      !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.?$/i.test(domain)
    )
      throw new TypeError('Invalid brand domain');
    return new URL(canonicalAgentUrl(`https://${domain}`)).hostname;
  };
  const host = domainHost(brandDomain);
  const house = obj.house as Record<string, unknown>;
  if (house.domain !== undefined && domainHost(house.domain) === host) {
    return { agents: house.agents };
  }
  const brands = Array.isArray(obj.brands) ? obj.brands : [];
  const matches = brands.filter(b => {
    try {
      return (
        b && typeof b === 'object' && typeof b.url === 'string' && new URL(canonicalAgentUrl(b.url)).hostname === host
      );
    } catch {
      return false;
    }
  });
  if (matches.length !== 1) throw new TypeError('Brand domain is absent or ambiguous in portfolio');
  return { agents: matches[0].agents === undefined ? house.agents : matches[0].agents };
}
