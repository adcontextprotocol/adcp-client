// Creative Agent Client - First-class support for creative agents

import { ADCPClient } from './ADCPClient';
import type { ADCPClientConfig } from './ADCPClient';
import type { AgentConfig } from '../types';
import type { FormatID } from '../types/core.generated';
import type {
  ListCreativeFormatsRequest,
  ListCreativeFormatsResponse
} from '../types/tools.generated';

/**
 * Configuration for CreativeAgentClient
 */
export interface CreativeAgentClientConfig extends ADCPClientConfig {
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
  private client: ADCPClient;
  private agentUrl: string;

  constructor(config: CreativeAgentClientConfig) {
    const agentConfig: AgentConfig = {
      id: config.agentUrl.replace(/https?:\/\//, '').replace(/\//g, '_'),
      name: 'Creative Agent',
      agent_uri: config.agentUrl,
      protocol: config.protocol || 'mcp',
      ...(config.authToken && { auth_token_env: config.authToken })
    };

    this.client = new ADCPClient(agentConfig, config);
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
  async listFormats(
    params: ListCreativeFormatsRequest = {}
  ): Promise<CreativeFormat[]> {
    const result = await this.client.listCreativeFormats(params);

    if (!result.success || !result.data) {
      throw new Error(`Failed to list creative formats: ${result.error || 'Unknown error'}`);
    }

    // Parse stringified result if needed (MCP servers may return stringified JSON)
    let formats = result.data.formats;

    if (!formats && (result.data as any).result) {
      const parsed = typeof (result.data as any).result === 'string'
        ? JSON.parse((result.data as any).result)
        : (result.data as any).result;
      formats = parsed.formats;
    }

    return (formats || []) as any as CreativeFormat[];
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
      f.renders?.some(r =>
        r.dimensions?.width === width && r.dimensions?.height === height
      )
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
   * Get the underlying ADCP client for advanced operations
   */
  getClient(): ADCPClient {
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
 * Uses structured FormatID from official schemas. Creative agents return
 * format catalogs with this structure for format discovery and selection.
 */
export interface CreativeFormat {
  /** Structured format identifier per AdCP v2.0.0 */
  format_id: FormatID;
  /** Base URL of the creative agent */
  agent_url: string;
  /** Human-readable format name */
  name: string;
  /** Description of the format */
  description?: string;
  /** Preview image URL */
  preview_image?: string;
  /** Example URL */
  example_url?: string;
  /** Media type */
  type: CreativeFormatType;
  /** Render specifications */
  renders?: Array<{
    role: string;
    dimensions?: {
      width: number;
      height: number;
      min_width?: number;
      min_height?: number;
      max_width?: number;
      max_height?: number;
      responsive?: {
        width: boolean;
        height: boolean;
      };
      aspect_ratio?: string;
      unit?: string;
    };
  }>;
  /** Required assets for this format */
  assets_required?: Array<{
    asset_id: string;
    asset_type: string;
    asset_role: string;
    required: boolean;
    requirements?: any;
  }>;
  /** Supported macros */
  supported_macros?: string[];
  /** Output format IDs (for generative formats) */
  output_format_ids?: Array<{
    agent_url: string;
    id: string;
  }>;
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
export function createCreativeAgentClient(
  config: CreativeAgentClientConfig
): CreativeAgentClient {
  return new CreativeAgentClient(config);
}

/**
 * Standard creative agent URLs
 */
export const STANDARD_CREATIVE_AGENTS = {
  /** Official AdCP reference creative agent */
  ADCP_REFERENCE: 'https://creative.adcontextprotocol.org/mcp',
  /** Official AdCP reference creative agent (A2A) */
  ADCP_REFERENCE_A2A: 'https://creative.adcontextprotocol.org/a2a'
} as const;
