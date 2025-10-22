/**
 * Property Crawler for AdCP v2.2.0
 *
 * Discovers properties by:
 * 1. Calling listAuthorizedProperties() on agents → get publisher_domains[]
 * 2. Fetching /.well-known/adagents.json from each publisher domain
 * 3. Extracting Property definitions from adagents.json
 * 4. Building property → agents mapping
 */

import { ADCPClient } from '../core/ADCPClient';
import { getPropertyIndex } from './property-index';
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
}

export class PropertyCrawler {
  /**
   * Crawl multiple agents to discover their publisher domains and properties
   */
  async crawlAgents(agents: AgentInfo[]): Promise<CrawlResult> {
    const result: CrawlResult = {
      successfulAgents: 0,
      failedAgents: 0,
      totalPublisherDomains: 0,
      totalProperties: 0,
      errors: []
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
        } else {
          result.failedAgents++;
        }
      } catch (error) {
        result.failedAgents++;
        result.errors.push({
          agent_url: agentInfo.agent_url,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    result.totalPublisherDomains = allPublisherDomains.size;

    // Step 2: Fetch adagents.json from each unique publisher domain
    const domainProperties = await this.fetchPublisherProperties(Array.from(allPublisherDomains));

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
    const client = new ADCPClient({
      id: 'crawler',
      name: 'Property Crawler',
      agent_uri: agentInfo.agent_url,
      protocol: agentInfo.protocol || 'mcp',
      ...(agentInfo.auth_token && { auth_token_env: agentInfo.auth_token })
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
  async fetchPublisherProperties(domains: string[]): Promise<Record<string, Property[]>> {
    const result: Record<string, Property[]> = {};

    await Promise.all(
      domains.map(async (domain) => {
        try {
          const properties = await this.fetchAdAgentsJson(domain);
          if (properties.length > 0) {
            result[domain] = properties;
          }
        } catch (error) {
          // Silently skip domains that don't have adagents.json
          console.warn(`Failed to fetch adagents.json from ${domain}:`, error);
        }
      })
    );

    return result;
  }

  /**
   * Fetch and parse adagents.json from a publisher domain
   */
  async fetchAdAgentsJson(domain: string): Promise<Property[]> {
    const url = `https://${domain}/.well-known/adagents.json`;

    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json() as AdAgentsJson;

      if (!data.properties || !Array.isArray(data.properties)) {
        return [];
      }

      // Add publisher_domain to each property if not present
      return data.properties.map(prop => ({
        ...prop,
        publisher_domain: prop.publisher_domain || domain
      }));
    } catch (error) {
      throw new Error(`Failed to fetch adagents.json: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
