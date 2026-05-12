/**
 * Property Crawler for AdCP v2.2.0
 *
 * Discovers properties by:
 * 1. Calling listAuthorizedProperties() on agents → get publisher_domains[]
 * 2. Fetching /.well-known/adagents.json from each publisher domain
 * 3. Extracting Property definitions from adagents.json
 * 4. Building property → agents mapping
 */

import { SingleAgentClient } from '../core/SingleAgentClient';
import { getPropertyIndex } from './property-index';
import { createLogger, type LogLevel } from '../utils/logger';
import { LIBRARY_VERSION } from '../version';
import { validateUserAgent } from '../utils/validate-user-agent';
import { ssrfSafeFetch, SsrfRefusedError, SSRF_TRANSIENT_CODES, decodeBodyAsJsonOrText } from '../net/ssrf-fetch';
import { isInternalProbesAllowed } from '../utils/probe-policy';
import type { Property, AdAgentsJson } from './types';
import { resolveAgentProperties } from './resolve-agent-properties';

/**
 * Cap on a single adagents.json response body. The published advertising
 * networks we've sampled (CNN, Hearst, etc.) all sit well under 64 KiB;
 * 256 KiB gives ~4× headroom against a misbehaving publisher serving an
 * exhaustive list. Lifted to a named constant so future tuning is one
 * edit, not a magic number scattered across call sites.
 */
const MAX_ADAGENTS_BODY_BYTES = 256 * 1024;

export interface AgentInfo {
  agent_url: string;
  protocol?: 'a2a' | 'mcp';
  auth_token?: string;
}

export interface CrawlResult {
  successfulAgents: number;
  failedAgents: number;
  totalPublisherDomains: number;
  totalProperties: number;
  errors: Array<{ agent_url: string; error: string }>;
  warnings: Array<{ domain: string; message: string }>;
}

export interface PropertyCrawlerConfig {
  logLevel?: LogLevel;
  /** Custom identifier for outbound requests. Used as User-Agent for protocol
   *  calls to agents and included in the From header for direct property fetches. */
  userAgent?: string;
}

export class PropertyCrawler {
  private logger: ReturnType<typeof createLogger>;
  private userAgent?: string;

  constructor(config?: PropertyCrawlerConfig) {
    this.logger = createLogger({
      level: config?.logLevel || 'warn',
    }).child('PropertyCrawler');
    if (config?.userAgent) {
      validateUserAgent(config.userAgent);
    }
    this.userAgent = config?.userAgent;
  }
  /**
   * Crawl multiple agents to discover their publisher domains and properties
   */
  async crawlAgents(agents: AgentInfo[]): Promise<CrawlResult> {
    const result: CrawlResult = {
      successfulAgents: 0,
      failedAgents: 0,
      totalPublisherDomains: 0,
      totalProperties: 0,
      errors: [],
      warnings: [],
    };

    const index = getPropertyIndex();
    const allPublisherDomains = new Set<string>();

    // Step 1: Call listAuthorizedProperties on each agent
    for (const agentInfo of agents) {
      try {
        const domains = await this.crawlAgent(agentInfo);
        if (domains.length > 0) {
          result.successfulAgents++;
          domains.forEach(d => allPublisherDomains.add(d));

          // Store agent → publisher_domains mapping
          index.addAgentAuthorization(agentInfo.agent_url, domains);
          this.logger.info(`Crawled agent ${agentInfo.agent_url}: found ${domains.length} domains`);
        } else {
          result.failedAgents++;
          this.logger.debug(`Agent ${agentInfo.agent_url} returned no domains`);
        }
      } catch (error) {
        result.failedAgents++;
        const errorMessage = error instanceof Error ? error.message : String(error);
        result.errors.push({
          agent_url: agentInfo.agent_url,
          error: errorMessage,
        });
        this.logger.error(`Failed to crawl agent ${agentInfo.agent_url}: ${errorMessage}`);
      }
    }

    result.totalPublisherDomains = allPublisherDomains.size;

    // Step 2: Fetch adagents.json from each unique publisher domain
    const {
      properties: domainProperties,
      adAgents: domainAdAgents,
      warnings,
    } = await this.fetchPublisherProperties(Array.from(allPublisherDomains));
    result.warnings = warnings;

    // Step 3: Build property → agents index. Per the AdCP schema
    // (`adagents.json` — `authorized_agents[].authorization_type` +
    // selector), which top-level properties an agent gets is a function
    // of its entry in the file, NOT the file's mere presence. We dispatch
    // through `resolveAgentProperties` to honor the per-agent selectors
    // (`property_ids`, `property_tags`, `inline_properties`).
    //
    // Fallback: if the crawler had to infer a default property because
    // the file declared `authorized_agents` but no `properties` array
    // (graceful-degradation branch in `fetchAdAgentsJsonFromUrl`), the
    // raw `AdAgentsJson` is intentionally NOT in `domainAdAgents` — we
    // attribute the inferred property to every claiming agent (pre-#1721
    // behavior). The file simply isn't strict-conformant enough to
    // dispatch on.
    for (const [domain, properties] of Object.entries(domainProperties)) {
      const claimingAgents = agents
        .map(a => a.agent_url)
        .filter(agentUrl => {
          const auth = index.getAgentAuthorizations(agentUrl);
          return auth?.publisher_domains.includes(domain);
        });

      const adAgentsFile = domainAdAgents[domain];

      for (const agentUrl of claimingAgents) {
        let attributable: Property[];
        if (adAgentsFile) {
          const scope = resolveAgentProperties(adAgentsFile, agentUrl);
          attributable = scope.properties;
        } else {
          attributable = properties;
        }
        for (const property of attributable) {
          index.addProperty(property, agentUrl, domain);
          result.totalProperties++;
        }
      }
    }

    return result;
  }

  /**
   * Crawl a single agent to get its authorized publisher domains via capabilities
   */
  async crawlAgent(agentInfo: AgentInfo): Promise<string[]> {
    const client = new SingleAgentClient(
      {
        id: 'crawler',
        name: 'Property Crawler',
        agent_uri: agentInfo.agent_url,
        protocol: agentInfo.protocol || 'mcp',
        ...(agentInfo.auth_token && { auth_token: agentInfo.auth_token }),
      },
      { userAgent: this.userAgent }
    );

    try {
      // Use capabilities API which replaced list_authorized_properties
      const capabilities = await client.getCapabilities();

      if (!capabilities.publisherDomains) {
        // Agent may not report publisher domains in capabilities
        return [];
      }

      return capabilities.publisherDomains;
    } catch (error) {
      throw new Error(`Failed to crawl agent: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Fetch adagents.json from multiple publisher domains
   */
  async fetchPublisherProperties(domains: string[]): Promise<{
    properties: Record<string, Property[]>;
    /**
     * Raw `AdAgentsJson` per fetched domain. `PropertyCrawler.crawlAgents`
     * needs `authorized_agents[]` (with their per-entry selectors) to do
     * spec-correct per-agent attribution — the `properties` array alone
     * doesn't carry the discriminator. Kept on a side map (instead of
     * widening `properties`) so external callers that only consume
     * `properties` keep the same shape.
     */
    adAgents: Record<string, AdAgentsJson>;
    warnings: Array<{ domain: string; message: string }>;
  }> {
    const result: Record<string, Property[]> = {};
    const adAgents: Record<string, AdAgentsJson> = {};
    const warnings: Array<{ domain: string; message: string }> = [];

    await Promise.all(
      domains.map(async domain => {
        try {
          const { properties, warning, adAgents: raw } = await this.fetchAdAgentsJson(domain);
          if (properties.length > 0) {
            result[domain] = properties;
          }
          if (raw) {
            adAgents[domain] = raw;
          }
          if (warning) {
            warnings.push({ domain, message: warning });
          }
        } catch (error) {
          // Expected failures (404, HTML responses) are logged at debug level
          // Unexpected failures (network errors, timeouts) are logged at error level
          const errorMessage = error instanceof Error ? error.message : String(error);

          if (this.isExpectedFailure(errorMessage)) {
            this.logger.debug(`Skipping ${domain}: ${errorMessage}`);
          } else {
            this.logger.error(`Failed to fetch adagents.json from ${domain}: ${errorMessage}`);
          }
        }
      })
    );

    return { properties: result, adAgents, warnings };
  }

  /**
   * Expected failure patterns for .well-known/adagents.json fetches.
   * These are common scenarios where domains don't have adagents.json files.
   */
  private static readonly EXPECTED_FAILURE_PATTERNS = [
    /HTTP 404/i, // Not Found
    /HTTP 410/i, // Gone
    /\.well-known\/adagents\.json.*not found/i, // Specific file not found
    /is not valid JSON/i, // JSON parse errors
    /Unexpected token.*<[^>]+>/i, // HTML tags in JSON response
    /<!doctype/i, // HTML document instead of JSON
  ];

  /**
   * Determine if a fetch failure is expected (404, missing file, HTML response).
   * Expected failures are logged at debug level; unexpected failures at error level.
   *
   * @param errorMessage - The error message to check
   * @returns true if the error is expected and can be safely ignored
   */
  private isExpectedFailure(errorMessage: string): boolean {
    return PropertyCrawler.EXPECTED_FAILURE_PATTERNS.some(pattern => pattern.test(errorMessage));
  }

  /** Maximum number of authoritative_location redirects to follow */
  private static readonly MAX_REDIRECT_DEPTH = 5;

  /**
   * Fetch and parse adagents.json from a publisher domain.
   * Handles authoritative_location redirects per AdCP spec.
   */
  async fetchAdAgentsJson(domain: string): Promise<{
    properties: Property[];
    /** Raw parsed adagents.json — needed for per-agent property resolution
     *  (#1721). Omitted when the response wasn't a parseable adagents.json. */
    adAgents?: AdAgentsJson;
    warning?: string;
  }> {
    const initialUrl = `https://${domain}/.well-known/adagents.json`;
    return this.fetchAdAgentsJsonFromUrl(initialUrl, domain, new Set(), 0);
  }

  /**
   * Internal method to fetch adagents.json with redirect handling.
   * @param url - URL to fetch from
   * @param originalDomain - The original publisher domain (for property defaults)
   * @param visitedUrls - Set of URLs already visited (loop detection)
   * @param depth - Current redirect depth
   */
  private async fetchAdAgentsJsonFromUrl(
    url: string,
    originalDomain: string,
    visitedUrls: Set<string>,
    depth: number
  ): Promise<{
    properties: Property[];
    /** Raw parsed adagents.json — needed for per-agent property resolution
     *  (#1721). Omitted on inferred / empty responses. */
    adAgents?: AdAgentsJson;
    warning?: string;
  }> {
    // Loop detection
    if (visitedUrls.has(url)) {
      throw new Error(`Redirect loop detected: ${url} was already visited`);
    }
    visitedUrls.add(url);

    // Max depth check
    if (depth > PropertyCrawler.MAX_REDIRECT_DEPTH) {
      throw new Error(`Maximum redirect depth (${PropertyCrawler.MAX_REDIRECT_DEPTH}) exceeded`);
    }

    try {
      // adcp-client#1633: route through ssrfSafeFetch for DNS-pin / TOCTOU
      // defense. Each fetchAdAgentsJsonFromUrl call validates its URL via
      // ssrfSafeFetch's address guards; the recursive `authoritative_location`
      // follow path below re-validates each redirect target by re-entering
      // this same function (so DNS-pin defense applies at each hop).
      const result = await ssrfSafeFetch(url, {
        maxBodyBytes: MAX_ADAGENTS_BODY_BYTES,
        allowPrivateIp: isInternalProbesAllowed(),
        headers: {
          // Use standard browser headers to pass CDN bot detection (e.g., Akamai)
          // Some CDNs reject modified User-Agents, so we use a standard Chrome string
          // Note: PropertyCrawler identifies itself via From header (RFC 9110)
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: 'application/json, text/plain, */*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
          From: this.userAgent
            ? `adcp-property-crawler@adcontextprotocol.org (${this.userAgent}; v${LIBRARY_VERSION})`
            : `adcp-property-crawler@adcontextprotocol.org (v${LIBRARY_VERSION})`,
        },
      });
      if (result.status < 200 || result.status >= 300) {
        throw new Error(`HTTP ${result.status}`);
      }

      const decoded = decodeBodyAsJsonOrText(result.body, result.headers['content-type']);
      // decodeBodyAsJsonOrText falls back to text on non-JSON content-type or
      // parse failure; adagents.json is required to be JSON, so re-attempt
      // parse + surface a clean error if not.
      const data: AdAgentsJson =
        typeof decoded === 'string' ? (JSON.parse(decoded) as AdAgentsJson) : (decoded as AdAgentsJson);

      // Handle authoritative_location redirect (per AdCP spec)
      // If authorized_agents is present, use it; otherwise follow the redirect
      if (data.authoritative_location && !data.authorized_agents) {
        const redirectUrl = data.authoritative_location;

        // Validate HTTPS
        if (!redirectUrl.startsWith('https://')) {
          throw new Error(`authoritative_location must use HTTPS: ${redirectUrl}`);
        }

        this.logger.debug(`Following authoritative_location redirect: ${url} -> ${redirectUrl}`);
        return this.fetchAdAgentsJsonFromUrl(redirectUrl, originalDomain, visitedUrls, depth + 1);
      }

      // Graceful degradation: if properties array is missing but file is otherwise valid
      if (!data.properties || !Array.isArray(data.properties) || data.properties.length === 0) {
        const hasAuthorizedAgents =
          data.authorized_agents && Array.isArray(data.authorized_agents) && data.authorized_agents.length > 0;

        if (hasAuthorizedAgents) {
          // Valid adagents.json but missing properties - infer default property
          this.logger.warn(
            `Domain ${originalDomain} has adagents.json but no properties array - inferring default property`,
            {
              domain: originalDomain,
              has_authorized_agents: true,
            }
          );

          return {
            properties: [
              {
                property_type: 'website',
                name: originalDomain,
                identifiers: [{ type: 'domain', value: originalDomain }],
                publisher_domain: originalDomain,
              },
            ],
            warning: 'Inferred from domain - publisher should add explicit properties array',
          };
        }

        // No properties and no authorized_agents - return empty
        return { properties: [] };
      }

      // Filter out malformed properties (missing/empty identifiers, or
      // identifier items missing string type/value). The schema requires
      // a non-empty identifiers array of well-shaped items, but real
      // adagents.json files in the wild sometimes omit pieces. Skipping
      // is preferable to crashing the whole crawl on one bad publisher.
      const normalized: Property[] = [];
      let skipped = 0;
      for (const prop of data.properties) {
        const validIdentifiers = Array.isArray(prop.identifiers)
          ? prop.identifiers.filter(id => !!id && typeof id.type === 'string' && typeof id.value === 'string')
          : [];
        if (validIdentifiers.length === 0) {
          skipped++;
          // Cap publisher-supplied name to bound log volume.
          const name = typeof prop.name === 'string' ? prop.name.slice(0, 200) : undefined;
          this.logger.warn(`Skipping property in ${originalDomain} adagents.json: missing or empty identifiers`, {
            domain: originalDomain,
            name,
          });
          continue;
        }
        normalized.push({
          ...prop,
          identifiers: validIdentifiers,
          publisher_domain: prop.publisher_domain || originalDomain,
        });
      }

      return {
        properties: normalized,
        adAgents: data,
        ...(skipped > 0 && {
          warning: `Skipped ${skipped} ${skipped === 1 ? 'property' : 'properties'} with missing or empty identifiers`,
        }),
      };
    } catch (error) {
      // adcp-client#1633 review: tag SSRF policy refusals distinctly so a
      // policy refusal (private/IMDS/etc.) doesn't masquerade as a generic
      // "fetch failed". The transient codes (DNS / body-cap) keep their
      // plain wording so the existing `EXPECTED_FAILURE_PATTERNS` matcher
      // continues to suppress them at debug level.
      if (error instanceof SsrfRefusedError && !SSRF_TRANSIENT_CODES.has(error.code)) {
        throw new Error(`Failed to fetch adagents.json: [SSRF refused] ${error.message}`);
      }
      throw new Error(`Failed to fetch adagents.json: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
