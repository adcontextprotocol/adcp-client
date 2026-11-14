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
import { ADCP_VERSION } from '../version';
import { isAdcpVersionAtLeast } from '../utils/adcp-version-config';

/**
 * First release whose `authorized_agents[].url` matching is origin-only
 * aware (adcp#8862, documented by adcp#8939 under DR-0023). Every 3.3
 * prerelease counts, the same threshold the SDK's other 3.3 gates use.
 */
const ORIGIN_ONLY_AGENT_MATCHING_SINCE = '3.3.0-beta.0';

/** Options shared by the `authorized_agents[].url` matching helpers. */
export interface AgentUrlMatchOptions {
  /**
   * AdCP release the caller negotiated or targets. Defaults to the SDK's
   * pinned `ADCP_VERSION`.
   *
   * At 3.3 or later an origin-only entry (`https://agent.example.com`)
   * authorizes the agent at that origin whatever its path. Below 3.3, or
   * when the value is not a parseable AdCP version, every entry matches by
   * exact canonical URL.
   */
  adcpVersion?: string;
}

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
  /**
   * The matched agent entry, or `undefined` if no entry matched the agent URL.
   * When several entries match (AdCP 3.3+), the first in document order; see
   * {@link ResolvedAgentScope.matched_entries}.
   */
  matched_entry?: AuthorizedAgent;
  /**
   * Every entry that matched the agent URL, in document order. At AdCP 3.3 or
   * later more than one entry can match (an exact entry and an origin-only
   * entry, say); the scope above is the union of theirs. Set at AdCP 3.3 or
   * later whenever an entry matched; omitted below 3.3, where at most one
   * entry can resolve.
   *
   * Per-entry fields the resolver does not combine are read from here.
   * `signing_keys` combines by the rule in adcontextprotocol/adcp#9016, over
   * the entries that match the agent AND authorize the signed message's scope
   * (they resolve, are in their effective window, cover the country and the
   * property). Use {@link resolvePublisherSigningKeyPin}, which takes that
   * scope; this list alone is not scope-filtered.
   *
   * - **Pinned only if every such entry pins.** If any of them has no
   *   `signing_keys` (absent or empty), the publisher does not pin the agent
   *   for that message. An entry that authorizes nothing for the message
   *   never pins or unpins it.
   * - **The allowed keys are the union.** When every such entry pins, the
   *   agent may sign with a key pinned by any of them.
   * - **Per property.** A message about several properties must satisfy each
   *   property's pin, as it must satisfy each publisher's.
   *
   * The AAO directory's `signing_keys_pinned` is a scope-agnostic summary of
   * the same rule.
   */
  matched_entries?: AuthorizedAgent[];
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
  const fragmentlessHref = parsed.href.split('#', 1)[0] ?? parsed.href;
  const query = parsed.search
    ? decodeUnreservedPercentEncoding(parsed.search)
    : fragmentlessHref.endsWith('?')
      ? '?'
      : '';
  return `${parsed.protocol}//${parsed.host}${path}${query}`;
}

interface CanonicalAgentUrl {
  /** Full canonical URL, as {@link canonicalizeAgentUrl} returns it. The 3.2 comparison key. */
  url: string;
  /** Root path `/` and no query, empty query marker included. */
  originOnly: boolean;
  /**
   * The 3.3 comparison keys: `url` and its canonical origin with one trailing
   * root-label dot removed from a DNS host (URL canonicalization step 2,
   * `https://agent.example./mcp` → `https://agent.example/mcp`). `null` when
   * the host ends in more than one dot (an empty label, which step 2 rejects),
   * so at 3.3 such a URL matches nothing.
   */
  rootDotless: { url: string; origin: string } | null;
}

function canonicalAgentUrlParts(raw: string): CanonicalAgentUrl | null {
  const url = canonicalizeAgentUrl(raw);
  if (url === null) return null;
  // Re-parse the canonical form: its path has already been through dot-segment
  // removal and unreserved percent-decoding, so `/./` and `/%2E/` read as `/`.
  const parsed = new URL(url);
  const origin = `${parsed.protocol}//${parsed.host}`;
  return { url, originOnly: url === `${origin}/`, rootDotless: stripRootDot(parsed, url, origin) };
}

/**
 * Remove one trailing root-label dot from a DNS host, keeping the port, path
 * and query. Returns `null` for a host of more than one trailing dot, or of
 * only a dot. IPv6 literals are left alone; WHATWG parsing already drops the
 * dot from an IPv4 host. Kept out of `canonicalizeAgentUrl` so that its other
 * callers (format ids, supply-path identity, projections) and the 3.2 exact
 * comparison are unchanged.
 */
function stripRootDot(parsed: URL, url: string, origin: string): { url: string; origin: string } | null {
  const host = parsed.hostname;
  if (host.startsWith('[') || !host.endsWith('.')) return { url, origin };
  if (host.endsWith('..') || host === '.') return null;
  const dotless = `${parsed.protocol}//${host.slice(0, -1)}${parsed.port ? `:${parsed.port}` : ''}`;
  return { url: dotless + url.slice(origin.length), origin: dotless };
}

/**
 * Whether `adcpVersion` (default: the SDK's pinned `ADCP_VERSION`) applies
 * the 3.3 origin-only rule to `authorized_agents[].url` (adcp#8862).
 */
export function usesOriginOnlyAgentMatching(adcpVersion: string = ADCP_VERSION): boolean {
  return isAdcpVersionAtLeast(adcpVersion, ORIGIN_ONLY_AGENT_MATCHING_SINCE);
}

/**
 * Whether `agentUrl` matches an `authorized_agents[].url` entry under
 * [Agent URL matching](https://adcontextprotocol.org/docs/governance/property/adagents#agent-url-matching).
 *
 * Both sides are canonicalized with {@link canonicalizeAgentUrl}, so scheme
 * and host case, default ports, unreserved percent-encoding and fragments
 * never matter, and the scheme, host and port always do. A URL with userinfo
 * never canonicalizes, so it matches nothing. Then:
 *
 * - **AdCP 3.3 or later** (DR-0023, adcp#8862): an origin-only entry, one
 *   whose canonical form has the root path and no query
 *   (`https://agent.example.com` or `https://agent.example.com/`),
 *   matches any agent URL with the same canonical origin, including
 *   `https://agent.example.com/mcp`. An entry with a path, or with a query
 *   (even an empty `?`), matches only the same canonical URL, so path case
 *   and a trailing slash (`/mcp` vs `/mcp/`) stay significant. Both sides
 *   also drop one trailing root-label dot from a DNS host
 *   (`https://agent.example.` matches `https://agent.example/mcp`), and a
 *   host ending in more than one dot matches nothing.
 * - **AdCP 3.2 and earlier**: every entry matches only the same canonical
 *   URL, so an origin-only entry matches only an agent served at the root.
 *
 * Returns `false` when either URL fails to canonicalize.
 */
export function agentUrlMatchesAuthorizedEntry(
  entryUrl: string,
  agentUrl: string,
  options: AgentUrlMatchOptions = {}
): boolean {
  const entry = canonicalAgentUrlParts(entryUrl);
  const agent = canonicalAgentUrlParts(agentUrl);
  if (!entry || !agent) return false;
  return matchCanonicalAgentUrl(entry, agent, usesOriginOnlyAgentMatching(options.adcpVersion)) !== 'none';
}

type AgentUrlMatchKind = 'exact' | 'origin' | 'none';

function matchCanonicalAgentUrl(
  entry: CanonicalAgentUrl,
  agent: CanonicalAgentUrl,
  originOnlyMatching: boolean
): AgentUrlMatchKind {
  // 3.2 and earlier: the exact canonical URL, byte-identical to the pre-3.3 rule.
  if (!originOnlyMatching) return entry.url === agent.url ? 'exact' : 'none';
  // 3.3 and later: compare with one DNS root dot removed; a malformed dotted host matches nothing.
  const e = entry.rootDotless;
  const a = agent.rootDotless;
  if (!e || !a) return 'none';
  if (e.url === a.url) return 'exact';
  if (entry.originOnly && e.origin === a.origin) return 'origin';
  return 'none';
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
 * file. Entries are matched with {@link agentUrlMatchesAuthorizedEntry}:
 * two URLs differing only in host case, default port, percent-encoding
 * of unreserved chars, or fragment are the same agent, and scheme
 * differences remain distinct. At AdCP 3.3 or later (`options.adcpVersion`,
 * default the SDK's pinned `ADCP_VERSION`) an origin-only entry also
 * matches an agent at any path on that origin; below 3.3 it matches only
 * an agent served at the root. An entry with a path always matches only
 * its canonical URL, trailing slash included.
 *
 * At 3.3 or later every matching entry authorizes the agent, and the scope
 * is the union of theirs: `properties`, `cross_publisher` and
 * `cross_publisher_expanded` combine (duplicates removed), so a narrower
 * entry never removes scope another matching entry grants
 * (adcontextprotocol/adcp#9011). `unresolvable` is set only when the union
 * is empty, and then carries the first matching entry's reason.
 *
 * Below 3.3 the behaviour is unchanged: only exact canonical matches count,
 * and more than one fails closed as `ambiguous_agent_url`.
 *
 * Returns `{ properties: [], cross_publisher: [], cross_publisher_expanded: [], unresolvable: '...' }`
 * (never throws) when the agent isn't listed, when its entry is
 * malformed, or when the agent uses a signals authorization type.
 */
export function resolveAgentProperties(
  adAgents: AdAgentsJson,
  agentUrl: string,
  options: AgentUrlMatchOptions = {}
): ResolvedAgentScope {
  const wanted = canonicalAgentUrlParts(agentUrl);
  if (!wanted) {
    return { properties: [], cross_publisher: [], cross_publisher_expanded: [], unresolvable: 'agent_not_listed' };
  }

  const originOnlyMatching = usesOriginOnlyAgentMatching(options.adcpVersion);
  const entries = Array.isArray(adAgents.authorized_agents) ? adAgents.authorized_agents : [];
  const matches: AuthorizedAgent[] = [];
  for (const e of entries) {
    if (!e || typeof e.url !== 'string') continue;
    const canon = canonicalAgentUrlParts(e.url);
    if (!canon) continue;
    if (matchCanonicalAgentUrl(canon, wanted, originOnlyMatching) !== 'none') matches.push(e);
  }

  const first = matches[0];
  if (!first) {
    return { properties: [], cross_publisher: [], cross_publisher_expanded: [], unresolvable: 'agent_not_listed' };
  }
  // 3.2 and earlier: unchanged. One exact match resolves; more than one is ambiguous.
  if (!originOnlyMatching) {
    if (matches.length > 1) {
      return { properties: [], cross_publisher: [], cross_publisher_expanded: [], unresolvable: 'ambiguous_agent_url' };
    }
    return resolveMatchedAgentProperties(adAgents, first);
  }
  if (matches.length === 1) {
    return { ...resolveMatchedAgentProperties(adAgents, first), matched_entries: [first] };
  }
  return unionAgentScopes(
    matches.map(entry => resolveMatchedAgentProperties(adAgents, entry)),
    matches
  );
}

/**
 * The message a publisher pin is computed for (adcontextprotocol/adcp#9016).
 * Pass the scope of the signed message: the pin comes only from entries that
 * authorize it.
 */
export interface PublisherSigningKeyPinOptions extends AgentUrlMatchOptions {
  /**
   * When the message applies, for `effective_from` / `effective_until`.
   * Defaults to now. An entry outside its window authorizes nothing.
   */
  at?: Date | string | number;
  /**
   * ISO 3166-1 alpha-2 country the message concerns. An entry with
   * `countries` authorizes the message only when this is one of them; with no
   * country given, such an entry authorizes nothing.
   */
  country?: string;
  /**
   * The publisher's `property_id`s the message concerns. Each gets its own
   * pin, and the result is the keys every one of them allows (a key must
   * satisfy each property's pin). Omit to combine across every entry that
   * authorizes the agent for anything.
   */
  propertyIds?: readonly string[];
}

/**
 * The publisher's `signing_keys` pin for a message from `agentUrl`, read from
 * the publisher's `adagents.json` (adcontextprotocol/adcp#9016). Use it as
 * `PublisherSigningKeyPin.signingKeys`.
 *
 * Only entries that BOTH match `agentUrl` (with
 * {@link agentUrlMatchesAuthorizedEntry}, so origin-only entries count at
 * 3.3+) AND authorize the message's scope count. Such an entry:
 * - resolves to something, so an unresolvable or signals-only entry does not count;
 * - is inside its effective window at `at`;
 * - covers `country`, and each property in `propertyIds`.
 *
 * An entry that authorizes nothing for the message never pins or unpins it,
 * so callers MUST pass the message's scope.
 *
 * Among the entries that count:
 * - The publisher pins the agent only if every one carries `signing_keys`. If
 *   any has none (absent or empty), the result is `undefined`: no pin, so use
 *   the agent's JWKS alone.
 * - Otherwise the result is the union of their keys. Identical keys appear
 *   once. Copies that differ in `revoked_at` are all kept, so the earliest
 *   revocation applies whatever the entry order.
 * - With `propertyIds`, each property gets its own pin, and the result keeps
 *   only the keys every pinned property allows.
 *
 * Returns `[]`, which `PublisherSigningKeyPin` reads as "accept no key", when
 * the agent is NOT authorized for the message:
 * - it is not listed;
 * - below 3.3 it matches more than one exact entry (`ambiguous_agent_url`);
 * - no entry authorizes the scope;
 * - no entry authorizes one of `propertyIds`;
 * - the pinned properties share no key.
 *
 * Not being authorized is never reported as "no pin".
 *
 * ```ts
 * const pinFor = (adagents: AdAgentsJson) =>
 *   resolvePublisherSigningKeyPin(adagents, sellerAgentUrl, { adcpVersion, country, propertyIds });
 * const pin: PublisherSigningKeyPin = {
 *   publisher: 'publisher.example',
 *   signingKeys: pinFor(adagents),
 *   // Your own uncached adagents.json fetch; null means the publisher no longer pins.
 *   refresh: async () => pinFor(await fetchAdagentsUncached()) ?? null,
 * };
 * ```
 */
export function resolvePublisherSigningKeyPin(
  adAgents: AdAgentsJson,
  agentUrl: string,
  options: PublisherSigningKeyPinOptions = {}
): Record<string, unknown>[] | undefined {
  const NOT_AUTHORIZED: Record<string, unknown>[] = [];
  const wanted = canonicalAgentUrlParts(agentUrl);
  if (!wanted) return NOT_AUTHORIZED;
  const originOnlyMatching = usesOriginOnlyAgentMatching(options.adcpVersion);
  const entries = Array.isArray(adAgents.authorized_agents) ? adAgents.authorized_agents : [];
  const matching = entries.filter(entry => {
    if (!entry || typeof entry !== 'object' || typeof entry.url !== 'string') return false;
    const canon = canonicalAgentUrlParts(entry.url);
    return canon !== null && matchCanonicalAgentUrl(canon, wanted, originOnlyMatching) !== 'none';
  });
  // Below 3.3 more than one exact match is ambiguous and fails closed.
  if (!originOnlyMatching && matching.length > 1) return NOT_AUTHORIZED;

  const at = options.at === undefined ? Date.now() : new Date(options.at).getTime();
  const country = options.country?.toUpperCase();
  const authorizing = matching
    .filter(entry => withinEffectiveWindow(entry, at) && coversCountry(entry, country))
    .map(entry => ({ entry, scope: resolveMatchedAgentProperties(adAgents, entry) }))
    .filter(({ scope }) => scope.properties.length > 0 || scope.cross_publisher.length > 0);
  if (authorizing.length === 0) return NOT_AUTHORIZED;

  if (!options.propertyIds?.length) {
    return combineEntryPins(authorizing.map(({ entry }) => entry));
  }
  const perProperty: Array<Record<string, unknown>[] | undefined> = [];
  for (const propertyId of new Set(options.propertyIds)) {
    const covering = authorizing.filter(({ scope }) => scope.properties.some(p => p.property_id === propertyId));
    if (covering.length === 0) return NOT_AUTHORIZED;
    perProperty.push(combineEntryPins(covering.map(({ entry }) => entry)));
  }
  return intersectPins(perProperty);
}

/** Pinned only if every entry pins; then the union of their keys. */
function combineEntryPins(entries: readonly AuthorizedAgent[]): Record<string, unknown>[] | undefined {
  if (!entries.every(entry => Array.isArray(entry.signing_keys) && entry.signing_keys.length > 0)) return undefined;
  return uniqueByValue(entries.flatMap(entry => entry.signing_keys!));
}

/**
 * Keys every pinned property allows, matched by public material (every member
 * but `revoked_at`); every copy of a surviving key is kept. `undefined` when
 * no property is pinned, `[]` when the pinned properties share no key.
 */
function intersectPins(
  pins: ReadonlyArray<Record<string, unknown>[] | undefined>
): Record<string, unknown>[] | undefined {
  const pinned = pins.filter((pin): pin is Record<string, unknown>[] => pin !== undefined);
  if (pinned.length === 0) return undefined;
  const identity = (key: Record<string, unknown>) => {
    const { revoked_at: _revokedAt, ...rest } = key ?? {};
    return JSON.stringify(
      Object.keys(rest)
        .sort()
        .map(name => [name, rest[name]])
    );
  };
  const shared = pinned
    .map(pin => new Set(pin.map(identity)))
    .reduce((acc, ids) => new Set([...acc].filter(id => ids.has(id))));
  return uniqueByValue(pinned.flatMap(pin => pin.filter(key => shared.has(identity(key)))));
}

function withinEffectiveWindow(entry: AuthorizedAgent, at: number): boolean {
  if (Number.isNaN(at)) return false;
  if (entry.effective_from !== undefined) {
    const from = Date.parse(entry.effective_from);
    if (Number.isNaN(from) || at < from) return false;
  }
  if (entry.effective_until !== undefined) {
    const until = Date.parse(entry.effective_until);
    if (Number.isNaN(until) || at > until) return false;
  }
  return true;
}

function coversCountry(entry: AuthorizedAgent, country: string | undefined): boolean {
  if (!Array.isArray(entry.countries) || entry.countries.length === 0) return true;
  return country !== undefined && entry.countries.some(c => typeof c === 'string' && c.toUpperCase() === country);
}

/**
 * Combine the scopes of every entry that authorizes one agent (AdCP 3.3+).
 * Properties dedupe by identity, then by value, so a top-level property two
 * selectors both pick appears once; selectors dedupe by value.
 */
function unionAgentScopes(scopes: ResolvedAgentScope[], entries: AuthorizedAgent[]): ResolvedAgentScope {
  const properties = uniqueByValue(scopes.flatMap(s => s.properties));
  const cross_publisher = uniqueByValue(scopes.flatMap(s => s.cross_publisher));
  const cross_publisher_expanded = uniqueByValue(scopes.flatMap(s => s.cross_publisher_expanded));
  const empty = properties.length === 0 && cross_publisher.length === 0;
  const reason = scopes.find(s => s.unresolvable !== undefined)?.unresolvable;
  return {
    properties,
    cross_publisher,
    cross_publisher_expanded,
    matched_entry: entries[0],
    matched_entries: entries,
    ...(empty && reason !== undefined ? { unresolvable: reason } : {}),
  };
}

function uniqueByValue<T>(items: T[]): T[] {
  const seenRefs = new Set<T>();
  const seenValues = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    if (seenRefs.has(item)) continue;
    seenRefs.add(item);
    const value = JSON.stringify(item);
    if (seenValues.has(value)) continue;
    seenValues.add(value);
    out.push(item);
  }
  return out;
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
 * inventory view, and an origin-only entry is not applied to path-mounted
 * agents. Use `resolveAgentProperties` for an authorization decision for a
 * specific agent URL: it unions every matching entry at AdCP 3.3+ and fails
 * closed on ambiguous matches below 3.3.
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
