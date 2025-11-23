/**
 * Sales Agents Handlers using @adcp/client library
 * This replaces the manual protocol implementation with proper library usage
 */

import {
  ADCPMultiAgentClient,
  type AgentConfig,
  type GetProductsRequest,
  type ListCreativeFormatsRequest,
  type CreateMediaBuyRequest,
  type TaskResult,
  type BrandManifest,
} from '../lib';
import { ADCP_VERSION } from '../lib/version';

/**
 * Debug log entry for protocol requests/responses
 */
interface DebugLogEntry {
  type: 'request' | 'response';
  method?: string;
  protocol?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: any;
  status?: number;
  statusText?: string;
  timestamp: string;
}

/**
 * Agent query result with debug information
 */
interface AgentQueryResult {
  success: boolean;
  agent_id: string;
  agent_name: string;
  protocol: string;
  response?: any;
  error?: string;
  debugLogs: DebugLogEntry[];
  duration_ms: number;
  adcp_version: string;
}

/**
 * Handler for sales agent operations using the @adcp/client library
 */
export class SalesAgentsHandlers {
  private client?: ADCPMultiAgentClient;
  private env: Record<string, string>;

  constructor(env: Record<string, string> = {}) {
    this.env = env;
    this.initializeClient();
  }

  /**
   * Initialize the ADCP client with configured agents
   */
  private initializeClient(): void {
    const agents = this.getConfiguredAgents();
    if (agents.length > 0) {
      this.client = new ADCPMultiAgentClient(agents);
      console.log(`✅ Initialized ADCP client with ${agents.length} agent(s)`);
    } else {
      console.warn('⚠️ No agents configured');
    }
  }

  /**
   * Get configured agents from environment
   */
  getConfiguredAgents(): AgentConfig[] {
    const agents: AgentConfig[] = [];

    // Try to load from SALES_AGENTS_CONFIG environment variable
    const configJson = this.env.SALES_AGENTS_CONFIG || process.env.SALES_AGENTS_CONFIG;
    if (configJson) {
      try {
        const config = JSON.parse(configJson);
        if (config.agents && Array.isArray(config.agents)) {
          agents.push(...config.agents);
          console.log(`📡 Loaded ${agents.length} agent(s) from SALES_AGENTS_CONFIG`);
        }
      } catch (error) {
        console.error('❌ Failed to parse SALES_AGENTS_CONFIG:', error);
      }
    }

    // Log agent configuration
    if (agents.length > 0) {
      console.log('📡 Configured agents:');
      agents.forEach(agent => {
        console.log(`  - ${agent.name} (${agent.protocol.toUpperCase()}) at ${agent.agent_uri}`);
      });
      console.log(`🔧 AdCP version: ${ADCP_VERSION}`);
    }

    return agents;
  }

  /**
   * Query a sales agent for inventory/products
   */
  async querySalesAgent(
    agentId: string,
    brandStory?: string,
    userProvidedOffering: string | null = null,
    customAgentConfig: Partial<AgentConfig> | null = null,
    toolName: string = 'get_products',
    additionalParams: Record<string, any> = {}
  ): Promise<AgentQueryResult> {
    const startTime = Date.now();
    const debugLogs: DebugLogEntry[] = [];

    try {
      // Get or create client with custom agent if provided
      let client = this.client;
      let targetAgentId = agentId;

      if (customAgentConfig && customAgentConfig.id === agentId) {
        // Create temporary client for custom agent
        const customAgent: AgentConfig = {
          id: customAgentConfig.id,
          name: customAgentConfig.name || customAgentConfig.id,
          agent_uri: customAgentConfig.agent_uri || (customAgentConfig as any).server_url,
          protocol: customAgentConfig.protocol || 'mcp',
          auth_token_env: customAgentConfig.auth_token_env,
          requiresAuth: customAgentConfig.requiresAuth !== false,
        };
        client = new ADCPMultiAgentClient([customAgent]);
        console.log(`🔧 Created temporary client for custom agent: ${customAgent.name}`);
      }

      if (!client) {
        throw new Error('No ADCP client initialized');
      }

      // Get agent wrapper
      const agent = client.agent(targetAgentId);
      if (!agent) {
        throw new Error(`Agent ${targetAgentId} not found`);
      }

      const agentConfig = client.getAgentConfigs().find(a => a.id === targetAgentId);
      if (!agentConfig) {
        throw new Error(`Agent config for ${targetAgentId} not found`);
      }

      // Execute task based on tool name
      let result: TaskResult<any>;
      let actualParams: any; // Store actual params for debug logging

      if (toolName === 'get_products') {
        // Build GetProductsRequest with proper types
        // brand_manifest must be either a valid URL or a BrandManifest object
        let brandManifest: string | BrandManifest;

        const manifestInput = brandStory || userProvidedOffering || 'Test brand';

        // Check if it's a valid URL
        try {
          new URL(manifestInput);
          brandManifest = manifestInput; // It's a valid URL
        } catch {
          // Not a URL, create a BrandManifest object
          console.warn(
            `[Sales Agents] Non-URL string provided for brand_manifest: "${manifestInput}". Coercing to {name: ...}`
          );
          brandManifest = {
            name: manifestInput,
          } as BrandManifest;
        }

        const params: GetProductsRequest = {
          brand_manifest: brandManifest,
          ...(brandStory && { brief: brandStory }),
        };

        // Add filters if provided
        if (
          additionalParams.filters ||
          additionalParams.delivery_type ||
          additionalParams.format_types ||
          additionalParams.is_fixed_price ||
          additionalParams.min_exposures ||
          additionalParams.format_ids ||
          additionalParams.standard_formats_only
        ) {
          params.filters = {};

          if (additionalParams.filters) {
            Object.assign(params.filters, additionalParams.filters);
          }
          if (additionalParams.delivery_type) {
            params.filters.delivery_type = additionalParams.delivery_type;
          }
          if (additionalParams.format_types) {
            params.filters.format_types = additionalParams.format_types;
          }
          if (additionalParams.is_fixed_price !== undefined) {
            params.filters.is_fixed_price = additionalParams.is_fixed_price;
          }
          if (additionalParams.format_ids) {
            params.filters.format_ids = additionalParams.format_ids;
          }
          if (additionalParams.standard_formats_only !== undefined) {
            params.filters.standard_formats_only = additionalParams.standard_formats_only;
          }
          if (additionalParams.min_exposures !== undefined) {
            params.filters.min_exposures = additionalParams.min_exposures;
          }
        }

        actualParams = params;
        result = await agent.getProducts(params);
      } else if (toolName === 'list_creative_formats') {
        const params: ListCreativeFormatsRequest = {};

        if (additionalParams.type) {
          params.type = additionalParams.type;
        }
        if (additionalParams.format_ids) {
          params.format_ids = additionalParams.format_ids;
        }
        if (additionalParams.asset_types) {
          params.asset_types = additionalParams.asset_types;
        }
        if (additionalParams.max_width !== undefined) {
          params.max_width = additionalParams.max_width;
        }
        if (additionalParams.max_height !== undefined) {
          params.max_height = additionalParams.max_height;
        }

        actualParams = params;
        result = await agent.listCreativeFormats(params);
      } else if (toolName === 'create_media_buy') {
        // brand_manifest must be either a valid URL or a BrandManifest object
        let brandManifestForBuy: string | BrandManifest;

        const manifestInputForBuy = brandStory || userProvidedOffering || 'Test brand';

        // Check if it's a valid URL
        try {
          new URL(manifestInputForBuy);
          brandManifestForBuy = manifestInputForBuy; // It's a valid URL
        } catch {
          // Not a URL, create a BrandManifest object
          console.warn(
            `[Sales Agents] Non-URL string provided for brand_manifest: "${manifestInputForBuy}". Coercing to {name: ...}`
          );
          brandManifestForBuy = {
            name: manifestInputForBuy,
          } as BrandManifest;
        }

        const params: CreateMediaBuyRequest = {
          buyer_ref: additionalParams.buyer_ref || `test-${Date.now()}`,
          brand_manifest: brandManifestForBuy,
          packages: additionalParams.packages || [],
          start_time: additionalParams.start_time || 'asap',
          end_time: additionalParams.end_time || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        };

        // Add optional fields
        if (additionalParams.po_number) {
          params.po_number = additionalParams.po_number;
        }

        actualParams = params;
        result = await agent.createMediaBuy(params);
      } else {
        throw new Error(`Unsupported tool: ${toolName}`);
      }

      // Create debug logs from request/response
      // Show actual parameters sent to agent for debugging

      debugLogs.push({
        type: 'request',
        method: toolName,
        protocol: agentConfig.protocol,
        url: agentConfig.agent_uri,
        headers: agentConfig.requiresAuth ? { 'x-adcp-auth': '[REDACTED]' } : {},
        body: actualParams || additionalParams,
        timestamp: new Date().toISOString(),
      });

      if (result.success && result.data) {
        debugLogs.push({
          type: 'response',
          status: 200,
          statusText: 'OK',
          body: result.data,
          timestamp: new Date().toISOString(),
        });
      } else if (result.error) {
        debugLogs.push({
          type: 'response',
          status: 500,
          statusText: 'Error',
          body: { error: result.error },
          timestamp: new Date().toISOString(),
        });
      }

      const duration = Date.now() - startTime;

      if (result.success) {
        return {
          success: true,
          agent_id: targetAgentId,
          agent_name: agentConfig.name,
          protocol: agentConfig.protocol,
          response: result.data,
          debugLogs,
          duration_ms: duration,
          adcp_version: ADCP_VERSION,
        };
      } else {
        return {
          success: false,
          agent_id: targetAgentId,
          agent_name: agentConfig.name,
          protocol: agentConfig.protocol,
          error: result.error || 'Unknown error',
          debugLogs,
          duration_ms: duration,
          adcp_version: ADCP_VERSION,
        };
      }
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      return {
        success: false,
        agent_id: agentId,
        agent_name: 'Unknown',
        protocol: 'unknown',
        error: errorMessage,
        debugLogs,
        duration_ms: duration,
        adcp_version: ADCP_VERSION,
      };
    }
  }

  /**
   * Get agent capabilities (tools, formats, etc.)
   */
  async getAgentCapabilities(agentId: string): Promise<any> {
    try {
      if (!this.client) {
        throw new Error('No ADCP client initialized');
      }

      const agent = this.client.agent(agentId);
      if (!agent) {
        throw new Error(`Agent ${agentId} not found`);
      }

      const agentConfig = this.client.getAgentConfigs().find(a => a.id === agentId);
      if (!agentConfig) {
        throw new Error(`Agent config for ${agentId} not found`);
      }

      // For now, return basic capabilities
      // TODO: Enhance library to expose tool discovery
      return {
        agent_id: agentId,
        agent_name: agentConfig.name,
        protocol: agentConfig.protocol,
        supported_tasks: [
          'get_products',
          'list_creative_formats',
          'create_media_buy',
          'update_media_buy',
          'sync_creatives',
          'list_creatives',
        ],
        adcp_version: ADCP_VERSION,
      };
    } catch (error) {
      return {
        agent_id: agentId,
        error: error instanceof Error ? error.message : 'Unknown error',
        adcp_version: ADCP_VERSION,
      };
    }
  }

  /**
   * List all configured agents
   */
  listAgents(): { id: string; name: string; protocol: string; agent_uri: string }[] {
    return this.getConfiguredAgents().map(agent => ({
      id: agent.id,
      name: agent.name,
      protocol: agent.protocol,
      agent_uri: agent.agent_uri,
    }));
  }

  /**
   * Cleanup resources
   */
  async cleanup(): Promise<void> {
    // Library handles cleanup automatically
    console.log('✅ Sales agents handlers cleanup complete');
  }
}

// Export singleton instance for backward compatibility
let globalInstance: SalesAgentsHandlers | null = null;

export function getSalesAgentsHandlers(env?: Record<string, string>): SalesAgentsHandlers {
  if (!globalInstance) {
    globalInstance = new SalesAgentsHandlers(env);
  }
  return globalInstance;
}

export function resetSalesAgentsHandlers(): void {
  globalInstance = null;
}
