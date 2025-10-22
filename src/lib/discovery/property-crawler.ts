/**
 * Property Crawler - Discovers properties from agents
 *
 * Crawls the ecosystem by:
 * 1. Fetching adagents.json from publishers
 * 2. Calling list_authorized_properties on each agent
 * 3. Building the property index
 */

import { getPropertyIndex } from './property-index';
import { ADCPClient } from '../core/ADCPClient';
import type { Property } from '../types/adcp';
import type { ListAuthorizedPropertiesResponse } from '../types/tools.generated';

export interface AgentInfo {
  agent_url: string;
  protocol?: string;
  publisher_domain: string;
}

export interface CrawlResult {
  agents_crawled: number;
  properties_discovered: number;
  errors: Array<{ agent_url: string; error: string }>;
  duration_ms: number;
}

export class PropertyCrawler {
  /**
   * Crawl a list of agents and discover their properties
   */
  async crawlAgents(agents: AgentInfo[]): Promise<CrawlResult> {
    const startTime = Date.now();
    const result: CrawlResult = {
      agents_crawled: 0,
      properties_discovered: 0,
      errors: [],
      duration_ms: 0
    };

    console.log(`📋 Crawling ${agents.length} agents for properties...`);

    const propertyIndex = getPropertyIndex();

    // Crawl each agent
    for (const agent of agents) {
      try {
        console.log(`  🔍 Crawling ${agent.agent_url}...`);
        const properties = await this.crawlAgent(agent.agent_url, agent.protocol);

        if (properties.length > 0) {
          // Add to property index
          for (const property of properties) {
            propertyIndex.addAuthorization(
              agent.agent_url,
              property,
              agent.publisher_domain
            );
          }

          result.properties_discovered += properties.length;
          console.log(`    ✓ Found ${properties.length} properties`);
        } else {
          console.log(`    ⊘ No properties returned`);
        }

        result.agents_crawled++;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        result.errors.push({
          agent_url: agent.agent_url,
          error: errorMessage
        });
        console.error(`    ✗ Error: ${errorMessage}`);
      }
    }

    result.duration_ms = Date.now() - startTime;

    console.log(`\n✓ Crawl complete:`);
    console.log(`  Agents crawled: ${result.agents_crawled}`);
    console.log(`  Properties discovered: ${result.properties_discovered}`);
    console.log(`  Errors: ${result.errors.length}`);
    console.log(`  Duration: ${(result.duration_ms / 1000).toFixed(2)}s`);

    return result;
  }

  /**
   * Crawl a single agent's properties
   */
  async crawlAgent(agentUrl: string, protocol?: string): Promise<Property[]> {
    try {
      // Determine which protocol to use (prefer A2A, fallback to MCP)
      const useProtocol = this.selectProtocol(protocol);

      // Create ADCP client for this agent
      const client = new ADCPClient({
        id: 'crawler',
        name: 'Property Crawler',
        agent_uri: agentUrl,
        protocol: useProtocol
      });

      // Call list_authorized_properties
      const result = await client.listAuthorizedProperties({});

      // Check if task completed successfully
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to fetch properties');
      }

      // Validate response
      if (!result.data.properties || !Array.isArray(result.data.properties)) {
        throw new Error('Invalid response: missing properties array');
      }

      return result.data.properties;
    } catch (error) {
      // If agent doesn't support list_authorized_properties, that's ok
      if (error instanceof Error && error.message.includes('tool not found')) {
        return [];
      }
      throw error;
    }
  }

  /**
   * Crawl a specific agent by URL
   */
  async crawlAgentByUrl(agentUrl: string): Promise<{
    properties: Property[];
    error?: string;
  }> {
    try {
      const properties = await this.crawlAgent(agentUrl);
      return { properties };
    } catch (error) {
      return {
        properties: [],
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * Select protocol to use for crawling
   */
  private selectProtocol(protocol?: string): 'a2a' | 'mcp' {
    if (!protocol) return 'a2a';

    // If agent supports both, prefer A2A
    if (protocol.includes('a2a')) return 'a2a';
    if (protocol.includes('mcp')) return 'mcp';

    return 'a2a';
  }
}
