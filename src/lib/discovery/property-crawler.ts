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
import type { Property, AdAgentsJson } from './types';

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
}

export class PropertyCrawler {
  private logger: ReturnType<typeof createLogger>;

  constructor(config?: PropertyCrawlerConfig) {
    this.logger = createLogger({
      level: config?.logLevel || 'warn',
    }).child('PropertyCrawler');
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
    const { properties: domainProperties, warnings } = await this.fetchPublisherProperties(
      Array.from(allPublisherDomains)
    );
    result.warnings = warnings;

    // Step 3: Build property → agents index
    for (const [domain, properties] of Object.entries(domainProperties)) {
      for (const property of properties) {
        // Find which agents are authorized for this publisher domain
        const authorizedAgents = agents
          .map(a => a.agent_url)
          .filter(agentUrl => {
            const auth = index.getAgentAuthorizations(agentUrl);
            return auth?.publisher_domains.includes(domain);
          });

        // Add property to index for each authorized agent
        for (const agentUrl of authorizedAgents) {
          index.addProperty(property, agentUrl, domain);
          result.totalProperties++;
        }
      }
    }

    return result;
  }

  /**
   * Crawl a single agent to get its authorized publisher domains
   */
  async crawlAgent(agentInfo: AgentInfo): Promise<string[]> {
    const client = new SingleAgentClient({
      id: 'crawler',
      name: 'Property Crawler',
      agent_uri: agentInfo.agent_url,
      protocol: agentInfo.protocol || 'mcp',
      ...(agentInfo.auth_token && { auth_token: agentInfo.auth_token }),
    });

    try {
      const result = await client.listAuthorizedProperties({});

      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to fetch publisher domains');
      }

      return result.data.publisher_domains || [];
    } catch (error) {
      throw new Error(`Failed to crawl agent: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Fetch adagents.json from multiple publisher domains
   */
  async fetchPublisherProperties(domains: string[]): Promise<{
    properties: Record<string, Property[]>;
    warnings: Array<{ domain: string; message: string }>;
  }> {
    const result: Record<string, Property[]> = {};
    const warnings: Array<{ domain: string; message: string }> = [];

    await Promise.all(
      domains.map(async domain => {
        try {
          const { properties, warning } = await this.fetchAdAgentsJson(domain);
          if (properties.length > 0) {
            result[domain] = properties;
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

    return { properties: result, warnings };
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
      const response = await fetch(url, {
        headers: {
          // Use standard browser headers to pass CDN bot detection (e.g., Akamai)
          // Some CDNs reject modified User-Agents, so we use a standard Chrome string
          // Note: PropertyCrawler identifies itself via From header (RFC 9110)
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: 'application/json, text/plain, */*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
          From: `adcp-property-crawler@adcontextprotocol.org (v${LIBRARY_VERSION})`,
        },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = (await response.json()) as AdAgentsJson;

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

      // Add publisher_domain to each property if not present
      return {
        properties: data.properties.map(prop => ({
          ...prop,
          publisher_domain: prop.publisher_domain || originalDomain,
        })),
      };
    } catch (error) {
      throw new Error(`Failed to fetch adagents.json: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
