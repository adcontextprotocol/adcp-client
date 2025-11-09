// Creative Agent Client - First-class support for creative agents

import { SingleAgentClient } from './SingleAgentClient';
import type { SingleAgentClientConfig } from './SingleAgentClient';
import type { AgentConfig } from '../types';
import type { FormatID } from '../types/core.generated';
import type { ListCreativeFormatsRequest, ListCreativeFormatsResponse, Format } from '../types/tools.generated';

/**
 * Configuration for CreativeAgentClient
 */
export interface CreativeAgentClientConfig extends SingleAgentClientConfig {
  /** Creative agent URL */
  agentUrl: string;
  /** Protocol to use (defaults to 'mcp') */
  protocol?: 'mcp' | 'a2a';
  /** Authentication token if required */
  authToken?: string;
}

/**
 * Creative Agent Client - Specialized client for interacting with creative agents
 *
 * Creative agents provide creative format catalogs and creative assembly services.
 * This client provides a simplified interface for common creative agent operations.
 *
 * @example
 * ```typescript
 * // Standard creative agent
 * const creativeAgent = new CreativeAgentClient({
 *   agentUrl: 'https://creative.adcontextprotocol.org/mcp'
 * });
 *
 * // List available formats
 * const formats = await creativeAgent.listFormats();
 *
 * // Find specific format
 * const banner = formats.find(f => f.format_id.id === 'display_300x250_image');
 * ```
 */
export class CreativeAgentClient {
  private client: SingleAgentClient;
  private agentUrl: string;

  constructor(config: CreativeAgentClientConfig) {
    const agentConfig: AgentConfig = {
      id: config.agentUrl.replace(/https?:\/\//, '').replace(/\//g, '_'),
      name: 'Creative Agent',
      agent_uri: config.agentUrl,
      protocol: config.protocol || 'mcp',
      ...(config.authToken && { auth_token_env: config.authToken }),
    };

    this.client = new SingleAgentClient(agentConfig, config);
    this.agentUrl = config.agentUrl;
  }

  /**
   * List all available creative formats
   *
   * @param params - Optional filtering parameters
   * @returns Promise resolving to array of creative formats
   *
   * @example
   * ```typescript
   * const formats = await creativeAgent.listFormats();
   *
   * // Filter to display formats
   * const displayFormats = formats.filter(f => f.type === 'display');
   *
   * // Find by dimensions
   * const banners = formats.filter(f =>
   *   f.renders?.[0]?.dimensions?.width === 300 &&
   *   f.renders?.[0]?.dimensions?.height === 250
   * );
   * ```
   */
  async listFormats(params: ListCreativeFormatsRequest = {}): Promise<CreativeFormat[]> {
    const result = await this.client.listCreativeFormats(params);

    if (!result.success || !result.data) {
      throw new Error(`Failed to list creative formats: ${result.error || 'Unknown error'}`);
    }

    // Enrich formats with agent_url for convenience
    return (result.data.formats || []).map(format => ({
      ...format,
      agent_url: this.agentUrl,
    }));
  }

  /**
   * Find formats by type
   *
   * @param type - Format type to filter by
   * @returns Promise resolving to matching formats
   *
   * @example
   * ```typescript
   * const videoFormats = await creativeAgent.findByType('video');
   * const displayFormats = await creativeAgent.findByType('display');
   * ```
   */
  async findByType(type: CreativeFormatType): Promise<CreativeFormat[]> {
    const allFormats = await this.listFormats();
    return allFormats.filter(f => f.type === type);
  }

  /**
   * Find formats by dimensions
   *
   * @param width - Width in pixels
   * @param height - Height in pixels
   * @returns Promise resolving to matching formats
   *
   * @example
   * ```typescript
   * // Find all 300x250 formats
   * const mediumRectangles = await creativeAgent.findByDimensions(300, 250);
   * ```
   */
  async findByDimensions(width: number, height: number): Promise<CreativeFormat[]> {
    const allFormats = await this.listFormats();
    return allFormats.filter(f =>
      f.renders?.some(r => r.dimensions?.width === width && r.dimensions?.height === height)
    );
  }

  /**
   * Find format by ID
   *
   * @param formatId - Format ID to search for
   * @returns Promise resolving to matching format or undefined
   *
   * @example
   * ```typescript
   * const format = await creativeAgent.findById('display_300x250_image');
   * if (format) {
   *   console.log(`Found: ${format.name}`);
   * }
   * ```
   */
  async findById(formatId: string): Promise<CreativeFormat | undefined> {
    const allFormats = await this.listFormats();
    return allFormats.find(f => f.format_id.id === formatId);
  }

  /**
   * Get the agent URL
   */
  getAgentUrl(): string {
    return this.agentUrl;
  }

  /**
   * Get the underlying single-agent client for advanced operations
   */
  getClient(): SingleAgentClient {
    return this.client;
  }
}

/**
 * Creative format type
 */
export type CreativeFormatType = 'audio' | 'video' | 'display' | 'native' | 'dooh' | 'rich_media' | 'universal';

/**
 * Creative format definition (per AdCP v2.0.0 spec)
 *
 * Extends the official Format type from the schema with an additional
 * agent_url field for convenience when working with creative agents.
 */
export interface CreativeFormat extends Format {
  /** Base URL of the creative agent that provides this format */
  agent_url: string;
}

/**
 * Factory function to create a creative agent client
 *
 * @param config - Creative agent configuration
 * @returns Configured CreativeAgentClient instance
 *
 * @example
 * ```typescript
 * const creativeAgent = createCreativeAgentClient({
 *   agentUrl: 'https://creative.adcontextprotocol.org/mcp'
 * });
 * ```
 */
export function createCreativeAgentClient(config: CreativeAgentClientConfig): CreativeAgentClient {
  return new CreativeAgentClient(config);
}

/**
 * Standard creative agent URLs
 */
export const STANDARD_CREATIVE_AGENTS = {
  /** Official AdCP reference creative agent */
  ADCP_REFERENCE: 'https://creative.adcontextprotocol.org/mcp',
  /** Official AdCP reference creative agent (A2A) */
  ADCP_REFERENCE_A2A: 'https://creative.adcontextprotocol.org/a2a',
} as const;
