/**
 * A2A Agent Card Discovery Utilities
 *
 * Supports both /.well-known/agent.json (current A2A spec)
 * and /.well-known/agent-card.json (legacy) for agent card discovery.
 */

/** A2A agent card well-known paths, preferred first */
export const A2A_CARD_PATHS = ['/.well-known/agent.json', '/.well-known/agent-card.json'] as const;

/** Matches either well-known agent card path at end of string (case-insensitive) */
const AGENT_CARD_PATH_REGEX = /\/\.well-known\/agent(-card)?\.json$/i;

/**
 * AdCP protocol transport suffixes that the runner appends to reach a
 * protocol endpoint. Kept here as the single source of truth — both
 * `SingleAgentClient.computeBaseUrl` and the storyboard scope canonicalizer
 * import this so new transports (e.g., future websocket) only need to be
 * added in one place.
 */
export const TRANSPORT_SUFFIX_REGEX = /\/(?:mcp|a2a|sse)\/?$/i;

/** Strip a protocol transport suffix (`/mcp`, `/a2a`, `/sse`) from a URL path. */
export function stripTransportSuffix(url: string): string {
  return url.replace(TRANSPORT_SUFFIX_REGEX, '');
}

/** Matches a root-level well-known agent card URL (scheme://host/.well-known/agent[-card].json) */
const AGENT_CARD_URL_REGEX = /^https?:\/\/[^/]+\/\.well-known\/agent(-card)?\.json$/i;

/**
 * Check if a URL string ends with an agent card well-known path
 */
export function isAgentCardPath(url: string): boolean {
  return AGENT_CARD_PATH_REGEX.test(url);
}

/**
 * Check if a URL is a root-level well-known agent card URL.
 *
 * Matches: https://example.com/.well-known/agent.json
 * Matches: https://example.com/.well-known/agent-card.json
 * Rejects: https://example.com/api/.well-known/agent.json
 */
export function isWellKnownAgentCardUrl(url: string): boolean {
  return AGENT_CARD_URL_REGEX.test(url);
}

/**
 * Build the list of agent card URLs to try for a given agent URL.
 *
 * If the URL already points to a well-known agent card path, returns it as-is.
 * Otherwise returns both paths (preferred first) appended to the base URL.
 */
export function buildCardUrls(agentUrl: string): string[] {
  if (isAgentCardPath(agentUrl)) {
    return [agentUrl];
  }
  const base = agentUrl.replace(/\/$/, '');
  return A2A_CARD_PATHS.map(path => `${base}${path}`);
}

/**
 * Strip a well-known agent card path from a URL, returning the base URL.
 */
export function stripAgentCardPath(url: string): string {
  return url.replace(AGENT_CARD_PATH_REGEX, '');
}
