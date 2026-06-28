/**
 * Per-agent property resolution for `adagents.json` (adcp-client#1721).
 *
 * The schema (`schemas/cache/3.0.11/adagents.json`) requires every
 * `authorized_agents[]` entry to carry `authorization_type` + the matching
 * selector field. Which top-level `properties[]` an agent is authorized
 * for is a function of that discriminator + selector — NOT a property of
 * presence-in-the-list (the pre-#1721 SDK bug).
 *
 * This resolver dispatches on `authorization_type`:
 *
 *   - `property_ids`   → filter top-level `properties[]` by `property_id`
 *   - `property_tags`  → filter top-level `properties[]` by tag intersection
 *   - `inline_properties` → return the agent entry's own `properties[]`
 *   - legacy bare inline (`properties[]` without `authorization_type`) →
 *     return the agent entry's own `properties[]`
 *   - `publisher_properties` → cross-publisher; returned as `cross_publisher`
 *     for the caller to resolve against other publishers' adagents.json
 *   - `signal_ids` / `signal_tags` → signals agents; no property output
 *
 * Mirrors the Python SDK's `_resolve_agent_properties` for schema-less
 * legacy bare-inline entries while keeping schema-declared files strict.
 * Missing selectors and bare entries without their own inline `properties[]`
 * return zero properties. The pre-fix TS behavior of attributing every
 * top-level property to every listed agent is gone.
 */
import type {
  AdAgentsJson,
  AuthorizedAgent,
  AuthorizationType,
  Property,
  PublisherPropertySelector,
  SinglePublisherPropertySelector,
} from './types';
import { resolveInlinePublisherProperties } from './inline-publisher-properties';

/**
 * Result of resolving a single agent's authorization scope against an
 * `adagents.json` file. `properties` are the locally-resolved entries
 * (in-file). `cross_publisher` selectors point at other publishers'
 * files; resolving them to concrete `Property` objects requires
 * fetching those publishers' adagents.json separately. `unresolvable`
 * communicates why the agent's scope is empty when it is.
 */
export interface ResolvedAgentScope {
  /** Locally-resolved properties (subset of top-level `properties[]`, or inline). */
  properties: Property[];
  /**
   * Cross-publisher selectors the caller must resolve against other files.
   * Preserved verbatim from the source file — compact `publisher_domains[]`
   * entries are NOT expanded here. Use {@link ResolvedAgentScope.cross_publisher_expanded}
   * when iterating by publisher domain.
   */
  cross_publisher: PublisherPropertySelector[];
  /**
   * Same selectors as {@link ResolvedAgentScope.cross_publisher} with every
   * compact-form entry fanned out to its singular equivalents. A selector
   * with `publisher_domains: [a,b,c]` contributes three entries here, one
   * per domain, each carrying the same predicate (`'all'` or `'by_tag'` +
   * `property_tags`). Callers that index by `publisher_domain` should
   * iterate this array, not `cross_publisher` — see adcp#4504.
   */
  cross_publisher_expanded: SinglePublisherPropertySelector[];
  /** The matched agent entry, or `undefined` if no entry matched the agent URL. */
  matched_entry?: AuthorizedAgent;
  /** Why the resolution returned an empty result, when it did. */
  unresolvable?: ResolveUnresolvableReason;
}

export type ResolveUnresolvableReason =
  /** The agent URL is not listed in `authorized_agents[]` at all. */
  | 'agent_not_listed'
  /** More than one entry matches the same canonical agent URL. */
  | 'ambiguous_agent_url'
  /** Entry exists but has no `authorization_type` discriminator. */
  | 'missing_authorization_type'
  /** Entry has an `authorization_type` we do not recognize. */
  | 'unknown_authorization_type'
  /** Entry has a known `authorization_type` but the matching selector is missing/empty. */
  | 'missing_selector'
  /** Selector resolved to no properties (e.g., `property_ids` matched no top-level entry). */
  | 'no_match'
  /** Entry uses a signals authorization type — no property output is appropriate. */
  | 'signals_only';

/**
 * Canonicalize an agent URL for `authorized_agents[].url` comparison per
 * the AdCP URL canonicalization rules
 * (https://adcontextprotocol.org/docs/reference/url-canonicalization).
 * Returns the canonical string or `null` if the input is unparseable.
 *
 * The full 8-step canonicalization (Punycode, percent-encoding decode,
 * `remove_dot_segments`, etc.) is delegated to Node's WHATWG URL parser
 * for most rules; this helper layers on the SDK-specific bits the parser
 * doesn't do automatically: default-port stripping (already done by
 * `URL.host`), unreserved-char percent-decoding, and fragment strip.
 *
 * Exported for callers building their own per-agent matching outside the
 * resolver — e.g., TMP `seller_agent_url` validation.
 */
export function canonicalizeAgentUrl(raw: string): string | null {
  const parsed = parseAgentUrl(raw);
  if (!parsed) return null;
  // `URL.host` already strips default ports and lowercases the hostname.
  // Use `protocol + host` (NOT `origin`) so the assembled string keeps
  // the IDN-A-label form Node produces.
  const path = decodeUnreservedPercentEncoding(parsed.pathname);
  const query = parsed.search ? decodeUnreservedPercentEncoding(parsed.search) : '';
  return `${parsed.protocol}//${parsed.host}${path}${query}`;
}

function parseAgentUrl(raw: string): URL | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  // Reject userinfo per the spec's step 3.
  if (parsed.username || parsed.password) return null;
  // Reject non-http(s) schemes — `adagents.json` agent URLs are HTTPS-only
  // in production, but we accept `http://` here so loopback fixtures parse.
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  return parsed;
}

/**
 * Resolve `agentUrl`'s authorization scope against an `adagents.json`
 * file. The lookup uses canonicalized URL comparison — two URLs
 * differing only in host case, default port, percent-encoding of
 * unreserved chars, or fragment are the same agent. Scheme and trailing
 * slash differences remain distinct.
 *
 * Returns `{ properties: [], cross_publisher: [], cross_publisher_expanded: [], unresolvable: '...' }`
 * (never throws) when the agent isn't listed, when its entry is
 * malformed, or when the agent uses a signals authorization type.
 */
export function resolveAgentProperties(adAgents: AdAgentsJson, agentUrl: string): ResolvedAgentScope {
  const wanted = canonicalizeAgentUrl(agentUrl);
  if (!wanted) {
    return { properties: [], cross_publisher: [], cross_publisher_expanded: [], unresolvable: 'agent_not_listed' };
  }

  const entries = Array.isArray(adAgents.authorized_agents) ? adAgents.authorized_agents : [];
  const matches = entries.filter(e => {
    if (!e || typeof e.url !== 'string') return false;
    const canon = canonicalizeAgentUrl(e.url);
    return canon !== null && canon === wanted;
  });
  if (matches.length > 1) {
    return { properties: [], cross_publisher: [], cross_publisher_expanded: [], unresolvable: 'ambiguous_agent_url' };
  }

  const entry = matches[0];
  if (!entry) {
    return { properties: [], cross_publisher: [], cross_publisher_expanded: [], unresolvable: 'agent_not_listed' };
  }

  return resolveMatchedAgentProperties(adAgents, entry);
}

function resolveMatchedAgentProperties(adAgents: AdAgentsJson, entry: AuthorizedAgent): ResolvedAgentScope {
  const allProperties = filterRevokedProperties(adAgents.properties, adAgents.revoked_publisher_domains);
  const authType = entry.authorization_type as AuthorizationType | undefined;
  if (!authType) {
    // Python SDK compatibility: legacy files sometimes omit the discriminator
    // while carrying inline `properties[]` on the agent entry.
    if (allowsLegacyBareInline(adAgents) && Array.isArray(entry.properties) && entry.properties.length > 0) {
      const inline = filterRevokedProperties(entry.properties, adAgents.revoked_publisher_domains);
      return {
        properties: inline,
        cross_publisher: [],
        cross_publisher_expanded: [],
        matched_entry: entry,
        ...(inline.length === 0 ? { unresolvable: 'no_match' as const } : {}),
      };
    }
    return {
      properties: [],
      cross_publisher: [],
      cross_publisher_expanded: [],
      matched_entry: entry,
      unresolvable: 'missing_authorization_type',
    };
  }

  switch (authType) {
    case 'property_ids': {
      const ids = entry.property_ids;
      if (!Array.isArray(ids) || ids.length === 0) {
        return {
          properties: [],
          cross_publisher: [],
          cross_publisher_expanded: [],
          matched_entry: entry,
          unresolvable: 'missing_selector',
        };
      }
      const idSet = new Set(ids);
      const matched = allProperties.filter(p => p.property_id !== undefined && idSet.has(p.property_id));
      return {
        properties: matched,
        cross_publisher: [],
        cross_publisher_expanded: [],
        matched_entry: entry,
        ...(matched.length === 0 ? { unresolvable: 'no_match' as const } : {}),
      };
    }

    case 'property_tags': {
      const tags = entry.property_tags;
      if (!Array.isArray(tags) || tags.length === 0) {
        return {
          properties: [],
          cross_publisher: [],
          cross_publisher_expanded: [],
          matched_entry: entry,
          unresolvable: 'missing_selector',
        };
      }
      const tagSet = new Set(tags);
      const matched = allProperties.filter(p => Array.isArray(p.tags) && p.tags.some(t => tagSet.has(t)));
      return {
        properties: matched,
        cross_publisher: [],
        cross_publisher_expanded: [],
        matched_entry: entry,
        ...(matched.length === 0 ? { unresolvable: 'no_match' as const } : {}),
      };
    }

    case 'inline_properties': {
      const inline = entry.properties;
      if (!Array.isArray(inline) || inline.length === 0) {
        return {
          properties: [],
          cross_publisher: [],
          cross_publisher_expanded: [],
          matched_entry: entry,
          unresolvable: 'missing_selector',
        };
      }
      const matched = filterRevokedProperties(inline, adAgents.revoked_publisher_domains);
      return {
        properties: matched,
        cross_publisher: [],
        cross_publisher_expanded: [],
        matched_entry: entry,
        ...(matched.length === 0 ? { unresolvable: 'no_match' as const } : {}),
      };
    }

    case 'publisher_properties': {
      const selectors = entry.publisher_properties;
      if (!Array.isArray(selectors) || selectors.length === 0) {
        return {
          properties: [],
          cross_publisher: [],
          cross_publisher_expanded: [],
          matched_entry: entry,
          unresolvable: 'missing_selector',
        };
      }
      // adcp#4825: consult the parent file's inline `properties[]` first.
      // Selectors that match inline produce `properties` directly; selectors
      // that don't (and aren't revoked) flow through `cross_publisher_expanded`
      // for the caller's federated fetch. Revoked selectors are dropped from
      // both paths — federated fallback MUST NOT fire for them.
      const { inline_properties, unresolved_selectors } = resolveInlinePublisherProperties(adAgents, selectors);
      return {
        properties: inline_properties,
        cross_publisher: selectors,
        cross_publisher_expanded: unresolved_selectors,
        matched_entry: entry,
      };
    }

    case 'signal_ids':
    case 'signal_tags':
      return {
        properties: [],
        cross_publisher: [],
        cross_publisher_expanded: [],
        matched_entry: entry,
        unresolvable: 'signals_only',
      };

    default:
      // Exhaustiveness guard — if a new authorization_type lands on
      // `AuthorizationType` without a branch here, TS won't compile.
      // For runtime files carrying a string we don't recognize, return
      // `unknown_authorization_type`.
      return {
        properties: [],
        cross_publisher: [],
        cross_publisher_expanded: [],
        matched_entry: entry,
        unresolvable: 'unknown_authorization_type',
      };
  }
}

/**
 * Convenience: list every locally-resolvable (`agent_url` →
 * `Property[]`) pair from an `adagents.json` file. Agents listed with
 * `signal_ids` / `signal_tags` or with no resolvable property selector are
 * absent from the result. Legacy bare-inline entries with `properties[]`
 * are included. `publisher_properties` cross-references are reported
 * separately so the caller can resolve them against other publishers' files.
 *
 * The returned map is keyed by public canonical URL; if a file contains
 * canonical-equivalent entries, the later entry wins in this non-authoritative
 * inventory view. Use `resolveAgentProperties` for an authorization decision
 * for a specific agent URL because it fails closed on ambiguous matches.
 */
export function listAgentPropertyMap(adAgents: AdAgentsJson): {
  byAgent: Map<string, Property[]>;
  unresolved: Array<{ agent_url: string; reason: ResolveUnresolvableReason }>;
  /**
   * Cross-publisher selectors per agent. `selectors` preserves the wire
   * shape (compact `publisher_domains[]` entries kept as-is); `expanded`
   * fans every compact entry out to singular form for callers that index
   * by `publisher_domain`. See adcp#4504.
   */
  cross_publisher: Array<{
    agent_url: string;
    selectors: PublisherPropertySelector[];
    expanded: SinglePublisherPropertySelector[];
  }>;
} {
  const byAgent = new Map<string, Property[]>();
  const unresolved: Array<{ agent_url: string; reason: ResolveUnresolvableReason }> = [];
  const cross_publisher: Array<{
    agent_url: string;
    selectors: PublisherPropertySelector[];
    expanded: SinglePublisherPropertySelector[];
  }> = [];

  const entries = Array.isArray(adAgents.authorized_agents) ? adAgents.authorized_agents : [];
  for (const entry of entries) {
    if (!entry || typeof entry.url !== 'string') continue;
    const scope = resolveMatchedAgentProperties(adAgents, entry);
    const canon = canonicalizeAgentUrl(entry.url);
    const key = canon ?? entry.url;
    if (scope.properties.length > 0) {
      byAgent.set(key, scope.properties);
    }
    if (scope.cross_publisher.length > 0) {
      cross_publisher.push({
        agent_url: key,
        selectors: scope.cross_publisher,
        expanded: scope.cross_publisher_expanded,
      });
    }
    if (scope.unresolvable && scope.properties.length === 0 && scope.cross_publisher.length === 0) {
      unresolved.push({ agent_url: key, reason: scope.unresolvable });
    }
  }

  return { byAgent, unresolved, cross_publisher };
}

/**
 * Non-authoritative total local property helper for `adagents.json`.
 *
 * This concatenates each authorized agent's locally resolved property scope
 * (`property_ids`, `property_tags`, `inline_properties`, legacy bare inline,
 * and inline-resolved `publisher_properties`). It intentionally preserves
 * duplicate property objects across multiple agents because it is a sum of
 * per-agent scopes, not a unique publisher catalog.
 *
 * If no agent scope resolves to local properties, it falls back to the file's
 * top-level `properties[]`. In both paths, properties whose
 * `publisher_domain` is listed in `revoked_publisher_domains[]` are filtered
 * out.
 *
 * Do not use this helper for authorization. It resolves each entry independently
 * for inventory aggregation and does not fail closed on canonical URL ambiguity.
 */
export function getAllProperties(adAgents: AdAgentsJson): Property[] {
  const out: Property[] = [];
  const entries = Array.isArray(adAgents.authorized_agents) ? adAgents.authorized_agents : [];
  for (const entry of entries) {
    if (!entry || typeof entry.url !== 'string') continue;
    const scope = resolveMatchedAgentProperties(adAgents, entry);
    if (scope.properties.length > 0) out.push(...scope.properties);
  }
  return out.length > 0 ? out : filterRevokedProperties(adAgents.properties, adAgents.revoked_publisher_domains);
}

/**
 * RFC 3986 §6.2.2.2: decode percent-encoded triplets that map to
 * unreserved characters (`ALPHA / DIGIT / "-" / "." / "_" / "~"`).
 * Leaves reserved characters and non-unreserved encodings byte-for-byte.
 *
 * Vendored from `src/lib/signing/canonicalize.ts` to keep this file
 * dependency-free of the signing module (which is the source for
 * request-signing canonicalization, not authorization).
 */
function decodeUnreservedPercentEncoding(input: string): string {
  return input.replace(/%([0-9a-fA-F]{2})/g, (match, hex: string) => {
    const code = parseInt(hex, 16);
    const isUnreserved =
      (code >= 0x41 && code <= 0x5a) || // A–Z
      (code >= 0x61 && code <= 0x7a) || // a–z
      (code >= 0x30 && code <= 0x39) || // 0–9
      code === 0x2d || // '-'
      code === 0x2e || // '.'
      code === 0x5f || // '_'
      code === 0x7e; // '~'
    return isUnreserved ? String.fromCharCode(code) : match.toUpperCase();
  });
}

function filterRevokedProperties(properties: unknown, revokedDomainsInput: unknown): Property[] {
  if (!Array.isArray(properties)) return [];
  const revokedDomains = revokedDomainSet(revokedDomainsInput);
  if (revokedDomains.size === 0) return properties as Property[];
  return (properties as Property[]).filter(p => {
    const domains = propertyPublisherDomains(p);
    if (domains.length === 0) return true;
    return domains.every(domain => !revokedDomains.has(domain.toLowerCase()));
  });
}

function revokedDomainSet(input: unknown): Set<string> {
  if (!Array.isArray(input)) return new Set();
  const out = new Set<string>();
  for (const item of input) {
    // `revoked_at` and `reason` are metadata; presence in this list is the
    // revocation signal.
    const domain =
      typeof item === 'string'
        ? item
        : item &&
            typeof item === 'object' &&
            typeof (item as { publisher_domain?: unknown }).publisher_domain === 'string'
          ? (item as { publisher_domain: string }).publisher_domain
          : undefined;
    if (domain && domain.length > 0) out.add(domain.toLowerCase());
  }
  return out;
}

function propertyPublisherDomains(property: Property): string[] {
  const out: string[] = [];
  if (typeof property.publisher_domain === 'string' && property.publisher_domain.length > 0) {
    out.push(property.publisher_domain);
  }
  if (Array.isArray(property.identifiers)) {
    for (const id of property.identifiers) {
      if (
        id &&
        (id.type === 'domain' || id.type === 'subdomain') &&
        typeof id.value === 'string' &&
        id.value.length > 0
      ) {
        out.push(id.value);
      }
    }
  }
  return out;
}

function allowsLegacyBareInline(adAgents: AdAgentsJson): boolean {
  return typeof adAgents.$schema !== 'string' || adAgents.$schema.length === 0;
}
