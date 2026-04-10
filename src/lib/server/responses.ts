/**
 * Typed response builders for AdCP MCP servers.
 *
 * Each function takes typed data (compile-time checked against AdCP schemas)
 * and returns an MCP-compatible tool response with `content` (text summary)
 * + `structuredContent` (typed payload).
 *
 * The input parameter enforces the AdCP schema shape at compile time.
 * The return type is compatible with MCP SDK's CallToolResult.
 *
 * @example
 * ```typescript
 * import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
 * import { capabilitiesResponse, productsResponse, adcpError } from '@adcp/client/server';
 * import { GetProductsRequestSchema } from '@adcp/client';
 *
 * const server = new McpServer({ name: 'My Agent', version: '1.0.0' });
 *
 * server.tool('get_adcp_capabilities', {}, async () =>
 *   capabilitiesResponse({ supported_protocols: ['media_buy'] })
 * );
 *
 * server.tool('get_products', GetProductsRequestSchema.shape, async (params) =>
 *   productsResponse({ products: myProducts })
 * );
 * ```
 */

import type { GetAdCPCapabilitiesResponse } from '../types/tools.generated';
import type { GetProductsResponse } from '../types/core.generated';
import type { CreateMediaBuySuccess } from '../types/core.generated';
import type { GetMediaBuyDeliveryResponse } from '../types/tools.generated';

/**
 * MCP-compatible tool response shape.
 * Uses Record<string, unknown> for structuredContent to satisfy
 * MCP SDK's CallToolResult index signature requirement.
 */
export interface McpToolResponse {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: Record<string, unknown>;
}

// MCP SDK requires structuredContent to have an index signature ({ [x: string]: unknown }).
// Generated AdCP types are TypeScript interfaces without index signatures. At runtime,
// JSON objects are always Records — this bridge is safe.
export function toStructuredContent(data: object): Record<string, unknown> {
  return data as unknown as Record<string, unknown>;
}

/**
 * Build a get_adcp_capabilities response.
 *
 * `supported_protocols` lists AdCP domain protocols (media_buy, signals, governance, etc.),
 * NOT transport protocols (mcp, a2a).
 */
export function capabilitiesResponse(data: GetAdCPCapabilitiesResponse, summary?: string): McpToolResponse {
  return {
    content: [{ type: 'text', text: summary ?? 'Agent capabilities retrieved' }],
    structuredContent: toStructuredContent(data),
  };
}

/**
 * Build a get_products response.
 */
export function productsResponse(data: GetProductsResponse, summary?: string): McpToolResponse {
  return {
    content: [{ type: 'text', text: summary ?? `Found ${data.products.length} products` }],
    structuredContent: toStructuredContent(data),
  };
}

/**
 * Build a successful create_media_buy response.
 */
export function mediaBuyResponse(data: CreateMediaBuySuccess, summary?: string): McpToolResponse {
  return {
    content: [{ type: 'text', text: summary ?? `Media buy ${data.media_buy_id} created` }],
    structuredContent: toStructuredContent(data),
  };
}

/**
 * Build a get_media_buy_delivery response.
 */
export function deliveryResponse(data: GetMediaBuyDeliveryResponse, summary?: string): McpToolResponse {
  return {
    content: [
      {
        type: 'text',
        text:
          summary ??
          `Delivery data for ${data.media_buy_deliveries.length} media buy${data.media_buy_deliveries.length === 1 ? '' : 's'}`,
      },
    ],
    structuredContent: toStructuredContent(data),
  };
}
