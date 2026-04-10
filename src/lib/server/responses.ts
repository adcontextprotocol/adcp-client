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
import type {
  ListCreativeFormatsResponse,
  UpdateMediaBuySuccess,
  GetMediaBuysResponse,
  ProvidePerformanceFeedbackSuccess,
  BuildCreativeSuccess,
  BuildCreativeMultiSuccess,
  PreviewCreativeSingleResponse,
  PreviewCreativeBatchResponse,
  PreviewCreativeVariantResponse,
  GetCreativeDeliveryResponse,
  ListCreativesResponse,
  SyncCreativesSuccess,
  GetSignalsResponse,
  ActivateSignalSuccess,
  ListAccountsResponse,
} from '../types/tools.generated';

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

/**
 * Build a list_accounts response.
 */
export function listAccountsResponse(data: ListAccountsResponse, summary?: string): McpToolResponse {
  return {
    content: [{ type: 'text', text: summary ?? `Found ${data.accounts.length} accounts` }],
    structuredContent: toStructuredContent(data),
  };
}

/**
 * Build a list_creative_formats response.
 */
export function listCreativeFormatsResponse(data: ListCreativeFormatsResponse, summary?: string): McpToolResponse {
  return {
    content: [{ type: 'text', text: summary ?? `Found ${data.formats.length} creative formats` }],
    structuredContent: toStructuredContent(data),
  };
}

/**
 * Build a successful update_media_buy response.
 */
export function updateMediaBuyResponse(data: UpdateMediaBuySuccess, summary?: string): McpToolResponse {
  return {
    content: [{ type: 'text', text: summary ?? `Media buy ${data.media_buy_id} updated` }],
    structuredContent: toStructuredContent(data),
  };
}

/**
 * Build a get_media_buys response.
 */
export function getMediaBuysResponse(data: GetMediaBuysResponse, summary?: string): McpToolResponse {
  return {
    content: [
      {
        type: 'text',
        text: summary ?? `Found ${data.media_buys.length} media buy${data.media_buys.length === 1 ? '' : 's'}`,
      },
    ],
    structuredContent: toStructuredContent(data),
  };
}

/**
 * Build a successful provide_performance_feedback response.
 */
export function performanceFeedbackResponse(
  data: ProvidePerformanceFeedbackSuccess,
  summary?: string
): McpToolResponse {
  return {
    content: [{ type: 'text', text: summary ?? 'Performance feedback accepted' }],
    structuredContent: toStructuredContent(data),
  };
}

/**
 * Build a successful build_creative response (single format).
 */
export function buildCreativeResponse(data: BuildCreativeSuccess, summary?: string): McpToolResponse {
  return {
    content: [{ type: 'text', text: summary ?? `Creative built: ${data.creative_manifest.format_id.id}` }],
    structuredContent: toStructuredContent(data),
  };
}

/**
 * Build a successful build_creative response (multi-format).
 */
export function buildCreativeMultiResponse(data: BuildCreativeMultiSuccess, summary?: string): McpToolResponse {
  return {
    content: [{ type: 'text', text: summary ?? `Built ${data.creative_manifests.length} creative formats` }],
    structuredContent: toStructuredContent(data),
  };
}

/**
 * Build a preview_creative response.
 */
export function previewCreativeResponse(
  data: PreviewCreativeSingleResponse | PreviewCreativeBatchResponse | PreviewCreativeVariantResponse,
  summary?: string
): McpToolResponse {
  const defaultSummary =
    data.response_type === 'single'
      ? (() => {
          const n = (data as PreviewCreativeSingleResponse).previews.length;
          return `Preview generated: ${n} variant${n === 1 ? '' : 's'}`;
        })()
      : data.response_type === 'batch'
        ? (() => {
            const n = (data as PreviewCreativeBatchResponse).results.length;
            return `Batch preview: ${n} result${n === 1 ? '' : 's'}`;
          })()
        : `Variant preview generated`;
  return {
    content: [{ type: 'text', text: summary ?? defaultSummary }],
    structuredContent: toStructuredContent(data),
  };
}

/**
 * Build a get_creative_delivery response.
 */
export function creativeDeliveryResponse(data: GetCreativeDeliveryResponse, summary?: string): McpToolResponse {
  return {
    content: [{ type: 'text', text: summary ?? `Creative delivery data for ${data.currency} report` }],
    structuredContent: toStructuredContent(data),
  };
}

/**
 * Build a list_creatives response.
 */
export function listCreativesResponse(data: ListCreativesResponse, summary?: string): McpToolResponse {
  return {
    content: [
      {
        type: 'text',
        text:
          summary ?? `Found ${data.query_summary.total_matching} creatives (${data.query_summary.returned} returned)`,
      },
    ],
    structuredContent: toStructuredContent(data),
  };
}

/**
 * Build a successful sync_creatives response.
 */
export function syncCreativesResponse(data: SyncCreativesSuccess, summary?: string): McpToolResponse {
  return {
    content: [
      {
        type: 'text',
        text: summary ?? `Synced ${data.creatives.length} creative${data.creatives.length === 1 ? '' : 's'}`,
      },
    ],
    structuredContent: toStructuredContent(data),
  };
}

/**
 * Build a get_signals response.
 */
export function getSignalsResponse(data: GetSignalsResponse, summary?: string): McpToolResponse {
  return {
    content: [
      { type: 'text', text: summary ?? `Found ${data.signals.length} signal${data.signals.length === 1 ? '' : 's'}` },
    ],
    structuredContent: toStructuredContent(data),
  };
}

/**
 * Build a successful activate_signal response.
 */
export function activateSignalResponse(data: ActivateSignalSuccess, summary?: string): McpToolResponse {
  return {
    content: [
      {
        type: 'text',
        text:
          summary ??
          `Signal activated across ${data.deployments.length} deployment${data.deployments.length === 1 ? '' : 's'}`,
      },
    ],
    structuredContent: toStructuredContent(data),
  };
}
