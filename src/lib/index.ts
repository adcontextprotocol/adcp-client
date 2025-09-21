// AdCP Client Library - Main Exports
// A comprehensive type-safe client library for the AdContext Protocol

// Core Types
export * from './types';

// Tool Types (with explicit imports to avoid conflicts)
export type {
  GetProductsRequest, GetProductsResponse,
  ListCreativeFormatsRequest, ListCreativeFormatsResponse,
  CreateMediaBuyRequest, CreateMediaBuyResponse,
  SyncCreativesRequest, SyncCreativesResponse,
  ListCreativesRequest, ListCreativesResponse
} from './types/tools.generated';

// Protocol Clients  
export * from './protocols';

// Authentication
export * from './auth';

// Validation
export * from './validation';

// Utilities
export * from './utils';
export { getStandardFormats } from './utils';

// Agent Classes
export { Agent, AgentCollection } from './agents/index.generated';

// Main Client Class
import type { AgentConfig, CreativeFormat } from './types';
import { Agent, AgentCollection } from './agents/index.generated';
import { getStandardFormats } from './utils';

/**
 * Main AdCP Client - Type-safe fluent interface for AdCP agents
 * 
 * Provides a beautiful, discoverable API for communicating with advertising agents
 * that implement the AdCP (Ad Context Protocol) over MCP or A2A transport protocols.
 * 
 * Features:
 * - 🔒 Full type safety with compile-time validation
 * - 🎯 Fluent agent-first API design
 * - 🛡️ Built-in authentication and circuit breakers
 * - ⚡ Automatic protocol detection (MCP/A2A)
 * - 📖 Self-documenting with IntelliSense support
 * - 🧪 Generated from official AdCP schemas
 * 
 * @example Single agent operations
 * ```typescript
 * const adcp = new AdCPClient([
 *   {
 *     id: 'premium-agent',
 *     name: 'Premium Ad Agent',
 *     agent_uri: 'https://agent.example.com/mcp/',
 *     protocol: 'mcp',
 *     requiresAuth: true,
 *     auth_token_env: 'AGENT_TOKEN'
 *   }
 * ]);
 * 
 * // Type-safe single agent operations
 * const agent = adcp.agent('premium-agent');
 * const products = await agent.getProducts({
 *   brief: 'Premium coffee brands for millennials',
 *   promoted_offering: 'Artisan coffee blends'
 * });
 * 
 * if (products.success) {
 *   console.log(`Found ${products.data.products.length} products`);
 *   console.log(`Response time: ${products.responseTimeMs}ms`);
 * } else {
 *   console.error(`Error: ${products.error}`);
 * }
 * ```
 * 
 * @example Multi-agent operations
 * ```typescript
 * // Run on specific agents
 * const agents = adcp.agents(['agent1', 'agent2']);
 * const results = await agents.getProducts({
 *   brief: 'Tech gadgets for remote work'
 * });
 * 
 * // Run on all configured agents
 * const allResults = await adcp.allAgents().listCreativeFormats({
 *   type: 'video'
 * });
 * 
 * // Process results with type safety
 * allResults.forEach(result => {
 *   if (result.success) {
 *     console.log(`${result.agent.name}: ${result.data.formats.length} formats`);
 *   } else {
 *     console.error(`${result.agent.name} failed: ${result.error}`);
 *   }
 * });
 * ```
 */
export class AdCPClient {
  private agentConfigs: AgentConfig[] = [];

  /**
   * Create a new AdCP client with optional initial agents
   * 
   * @param agents - Initial agent configurations
   */
  constructor(agents?: AgentConfig[]) {
    if (agents) {
      this.agentConfigs = [...agents];
    }
  }

  /**
   * Get a single agent for type-safe operations
   * 
   * @param id - Agent ID
   * @returns Agent instance for chained operations
   * @throws Error if agent not found
   * 
   * @example
   * ```typescript
   * const agent = client.agent('my-agent');
   * const products = await agent.getProducts({ brief: 'Coffee brands' });
   * ```
   */
  agent(id: string): Agent {
    const config = this.agentConfigs.find(a => a.id === id);
    if (!config) {
      throw new Error(`Agent '${id}' not found. Available agents: ${this.agentConfigs.map(a => a.id).join(', ')}`);
    }
    return new Agent(config, this);
  }

  /**
   * Get multiple agents for parallel operations
   * 
   * @param ids - Array of agent IDs
   * @returns AgentCollection for parallel operations
   * @throws Error if any agent not found
   * 
   * @example
   * ```typescript
   * const agents = client.agents(['agent1', 'agent2']);
   * const results = await agents.getProducts({ brief: 'Coffee brands' });
   * ```
   */
  agents(ids: string[]): AgentCollection {
    const configs = ids.map(id => {
      const config = this.agentConfigs.find(a => a.id === id);
      if (!config) {
        throw new Error(`Agent '${id}' not found. Available agents: ${this.agentConfigs.map(a => a.id).join(', ')}`);
      }
      return config;
    });
    return new AgentCollection(configs, this);
  }

  /**
   * Get all configured agents for broadcast operations
   * 
   * @returns AgentCollection for operations on all agents
   * 
   * @example
   * ```typescript
   * const allResults = await client.allAgents().getProducts({
   *   brief: 'Premium coffee brands'
   * });
   * ```
   */
  allAgents(): AgentCollection {
    if (this.agentConfigs.length === 0) {
      throw new Error('No agents configured. Use addAgent() to add agents first.');
    }
    return new AgentCollection(this.agentConfigs, this);
  }

  /**
   * Add an agent to the client
   * 
   * @param agent - Agent configuration to add
   * 
   * @example
   * ```typescript
   * client.addAgent({
   *   id: 'new-agent',
   *   name: 'New Agent',
   *   agent_uri: 'https://new-agent.example.com',
   *   protocol: 'a2a'
   * });
   * ```
   */
  addAgent(agent: AgentConfig): void {
    // Check for duplicate IDs
    if (this.agentConfigs.find(a => a.id === agent.id)) {
      throw new Error(`Agent with ID '${agent.id}' already exists`);
    }
    this.agentConfigs.push({ ...agent });
  }

  /**
   * Get list of all configured agents
   * 
   * @returns Defensive copy of agent configurations
   */
  getAgents(): AgentConfig[] {
    return this.agentConfigs.map(agent => ({ ...agent }));
  }

  /**
   * Get standard creative formats
   * 
   * @returns Array of standard creative format definitions
   */
  getStandardFormats(): CreativeFormat[] {
    return getStandardFormats();
  }

  /**
   * Get count of configured agents
   */
  get agentCount(): number {
    return this.agentConfigs.length;
  }

  /**
   * Get list of agent IDs
   */
  get agentIds(): string[] {
    return this.agentConfigs.map(a => a.id);
  }
}

/**
 * Configuration manager for loading agents from environment variables
 */
export class ConfigurationManager {
  /**
   * Load agent configurations from environment variables
   * 
   * Reads from SALES_AGENTS_CONFIG environment variable (JSON format)
   * 
   * @returns Array of agent configurations
   * 
   * @example Environment setup
   * ```bash
   * export SALES_AGENTS_CONFIG='{"agents":[{"id":"test","name":"Test Agent","agent_uri":"https://agent.example.com","protocol":"mcp"}]}'
   * ```
   */
  static loadAgentsFromEnv(): AgentConfig[] {
    const configEnv = process.env.SALES_AGENTS_CONFIG;
    
    if (!configEnv) {
      console.warn('⚠️  No SALES_AGENTS_CONFIG found - no agents will be loaded');
      console.log('💡 To enable agents, set SALES_AGENTS_CONFIG in your .env file');
      return [];
    }

    try {
      const config = JSON.parse(configEnv);
      const agents = config.agents || [];
      
      console.log(`📡 Configured agents: ${agents.length}`);
      agents.forEach((agent: AgentConfig) => {
        const protocolIcon = agent.protocol === 'mcp' ? '🔗' : '⚡';
        console.log(`  ${protocolIcon} ${agent.name} (${agent.protocol.toUpperCase()}) at ${agent.agent_uri}`);
      });
      
      const useRealAgents = process.env.USE_REAL_AGENTS === 'true';
      console.log(`🔧 Real agents mode: ${useRealAgents ? 'ENABLED' : 'DISABLED'}`);
      
      return agents;
    } catch (error) {
      console.error('Failed to parse SALES_AGENTS_CONFIG:', error);
      return [];
    }
  }
}

/**
 * Convenience function to create an AdCPClient instance
 * 
 * @param agents - Optional initial agent configurations
 * @returns New AdCPClient instance
 */
export function createAdCPClient(agents?: AgentConfig[]): AdCPClient {
  return new AdCPClient(agents);
}

/**
 * Load agents from environment and create client
 * 
 * @returns AdCPClient instance with environment-loaded agents
 */
export function createAdCPClientFromEnv(): AdCPClient {
  const agents = ConfigurationManager.loadAgentsFromEnv();
  return new AdCPClient(agents);
}