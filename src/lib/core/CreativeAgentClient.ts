// Creative Agent Client - First-class support for creative agents

import { SingleAgentClient } from './SingleAgentClient';
import type { SingleAgentClientConfig } from './SingleAgentClient';
import type { InputHandler, TaskOptions } from './ConversationTypes';
import type { AgentConfig } from '../types';
import type {
  ListCreativeFormatsRequest,
  ListCreativesRequest,
  ListCreativesResponse,
  Format,
} from '../types/tools.generated';
import type { CanonicalListCreativesRequest, CanonicalListCreativesResponse } from '../v2/projection/creative-delivery';
import type { LegacyFormatConverter } from '../v2/projection/v1-to-v2';

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
  /** Migration converter for seller-specific legacy creative references. */
  legacyFormatConverter?: LegacyFormatConverter;
}

export type CreativeAgentListTaskOptions = TaskOptions & {
  /** Convert a seller-specific legacy creative reference that the bundled registry cannot map. */
  legacyFormatConverter?: LegacyFormatConverter;
};

/**
 * Creative Agent Client - Specialized client for interacting with creative agents
 *
 * Creative agents provide creative assembly and reusable creative-library services.
 * Creative-library reads are canonical by default: each creative is identified by
 * `format_kind` and, when applicable, `format_option_ref`.
 *
 * @example
 * ```typescript
 * // Standard creative agent
 * const creativeAgent = new CreativeAgentClient({
 *   agentUrl: 'https://creative.adcontextprotocol.org/mcp'
 * });
 *
 * const { creatives } = await creativeAgent.listCreatives({
 *   filters: { statuses: ['approved'] }
 * });
 * const images = creatives.filter(creative => creative.format_kind === 'image');
 * ```
 */
export class CreativeAgentClient {
  private client: SingleAgentClient;
  private agentUrl: string;
  private legacyFormatConverter?: LegacyFormatConverter;

  constructor(config: CreativeAgentClientConfig) {
    const agentConfig: AgentConfig = {
      id: config.agentUrl.replace(/https?:\/\//, '').replace(/\//g, '_'),
      name: 'Creative Agent',
      agent_uri: config.agentUrl,
      protocol: config.protocol || 'mcp',
      ...(config.authToken && { auth_token: config.authToken }),
    };

    this.client = new SingleAgentClient(agentConfig, config);
    this.agentUrl = config.agentUrl;
    this.legacyFormatConverter = config.legacyFormatConverter;
  }

  /**
   * List a creative agent's legacy named-format catalog.
   *
   * Canonical applications should discover seller-supported declarations through
   * `AgentClient.getProducts()` and use `format_options[]`. This method exists for
   * migration tooling that must inspect the old creative-agent catalog.
   *
   * @param params - Optional filtering parameters
   * @returns Promise resolving to array of creative formats
   *
   * @example
   * ```typescript
   * const formats = await creativeAgent.listFormatsLegacy();
   *
   * // Find by dimensions
   * const banners = formats.filter(f =>
   *   f.renders?.[0]?.dimensions?.width === 300 &&
   *   f.renders?.[0]?.dimensions?.height === 250
   * );
   * ```
   *
   * @deprecated Canonical applications discover `format_options[]` through seller products.
   */
  async listFormatsLegacy(params: ListCreativeFormatsRequest = {}): Promise<LegacyCreativeFormat[]> {
    const result = await this.client.listCreativeFormatsLegacy(params);

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
   * Find formats by dimensions
   *
   * @param width - Width in pixels
   * @param height - Height in pixels
   * @returns Promise resolving to matching formats
   *
   * @example
   * ```typescript
   * // Find all 300x250 formats
   * const mediumRectangles = await creativeAgent.findLegacyByDimensions(300, 250);
   * ```
   */
  async findLegacyByDimensions(width: number, height: number): Promise<LegacyCreativeFormat[]> {
    const allFormats = await this.listFormatsLegacy();
    return allFormats.filter(f =>
      f.renders?.some(r => {
        if (!('dimensions' in r) || !r.dimensions) return false;
        const dims = r.dimensions as { width?: number; height?: number };
        return dims.width === width && dims.height === height;
      })
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
   * const format = await creativeAgent.findLegacyById('display_300x250_image');
   * if (format) {
   *   console.log(`Found: ${format.name}`);
   * }
   * ```
   */
  async findLegacyById(formatId: string): Promise<LegacyCreativeFormat | undefined> {
    const allFormats = await this.listFormatsLegacy();
    return allFormats.find(f => f.format_id.id === formatId);
  }

  /**
   * List creatives in the agent's library
   *
   * @param params - Optional filtering, sorting, and pagination parameters
   * @returns Promise resolving to canonical creatives (`format_kind`, never `format_id`)
   *
   * @example
   * ```typescript
   * const result = await creativeAgent.listCreatives({
   *   filters: { statuses: ['approved'], has_variables: true },
   *   include_variables: true
   * });
   * const imageCreatives = result.creatives.filter(
   *   creative => creative.format_kind === 'image'
   * );
   * ```
   */
  async listCreatives(
    params: CanonicalListCreativesRequest = {},
    inputHandler?: InputHandler,
    options?: CreativeAgentListTaskOptions
  ): Promise<CanonicalListCreativesResponse> {
    const { legacyFormatConverter, ...taskOptions } = options ?? {};
    const result = await this.client.listCreatives(params, inputHandler, {
      ...taskOptions,
      legacyFormatConverter: legacyFormatConverter ?? this.legacyFormatConverter,
    });

    if (!result.success || !result.data) {
      throw new Error(`Failed to list creatives: ${result.error || 'Unknown error'}`);
    }

    return result.data;
  }

  /**
   * Return the unprojected creative-library wire response.
   *
   * @deprecated Compatibility-only escape hatch for migration and protocol tooling.
   */
  async listCreativesLegacy(
    params: ListCreativesRequest = {},
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<ListCreativesResponse> {
    const result = await this.client.listCreativesLegacy(params, inputHandler, options);

    if (!result.success || !result.data) {
      throw new Error(`Failed to list creatives: ${result.error || 'Unknown error'}`);
    }

    return result.data;
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
 * Creative format definition.
 *
 * Extends the official Format type from the schema with an additional
 * agent_url field for convenience when working with creative agents.
 */
export interface LegacyCreativeFormat extends Format {
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
