/**
 * Step 5 of the brand_json_url discovery algorithm: locate the brand.json
 * `agents[]` entry whose `url` byte-equals the agent URL the verifier is
 * resolving. The byte-equal rule is deliberate (security.mdx §"Discovering
 * an agent's signing keys via `brand_json_url`" step 5) — no canonicalization,
 * because the most common operator misconfiguration is a trailing-slash or
 * scheme mismatch (`https://x.com/mcp` vs `https://x.com/mcp/`), and silently
 * canonicalizing past that hides the bug. The match must be exact.
 *
 * Both flat (`agents[]` at top level) and house-portfolio
 * (`house.agents[]` + `brands[].agents[]`) brand.json shapes are supported,
 * because either may carry the entry that matches the agent URL.
 */

export type AgentSelectorErrorCode = 'agent_not_in_brand_json' | 'brand_json_ambiguous';

export interface AgentEntry {
  url: string;
  jwks_uri?: string;
  /** Other fields preserved verbatim — the resolver passes the entry to the caller. */
  [key: string]: unknown;
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
  if (!brandJson || typeof brandJson !== 'object') return [];
  const entries: AgentEntry[] = [];
  const obj = brandJson as Record<string, unknown>;
  pushAgentArray(obj.agents, entries);
  const house = obj.house;
  if (house && typeof house === 'object') {
    pushAgentArray((house as Record<string, unknown>).agents, entries);
  }
  if (Array.isArray(obj.brands)) {
    for (const brand of obj.brands) {
      if (brand && typeof brand === 'object') {
        pushAgentArray((brand as Record<string, unknown>).agents, entries);
      }
    }
  }
  return entries;
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
 * Find the unique `agents[]` entry whose `url` byte-equals `agentUrl`.
 *
 * - Returns the matched entry on a unique hit.
 * - Throws `AgentSelectorError('agent_not_in_brand_json')` on zero matches.
 * - Throws `AgentSelectorError('brand_json_ambiguous')` on multiple matches.
 *   `matched_count` and `matched_entries` are populated on the error so the
 *   caller can map them onto `request_signature_brand_json_ambiguous` detail
 *   fields. `matched_entries` reflects counterparty-controlled state and is
 *   marked attacker-influenceable in the resolver's error mapping.
 */
export function selectAgentByUrl(brandJson: unknown, agentUrl: string): AgentEntry {
  const entries = collectAgentEntries(brandJson);
  const matches = entries.filter(e => e.url === agentUrl);
  if (matches.length === 0) {
    throw new AgentSelectorError(
      'agent_not_in_brand_json',
      `No brand.json agent entry has url byte-equal to ${agentUrl}`,
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
