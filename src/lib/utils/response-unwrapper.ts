/**
 * Response Unwrapper
 *
 * Extracts raw AdCP responses from protocol wrappers (MCP/A2A).
 * Follows canonical A2A response format per AdCP specification.
 */

import { z } from 'zod';
import * as schemas from '../types/schemas.generated';
import type {
  GetProductsResponse,
  ListCreativeFormatsResponse,
  CreateMediaBuyResponse,
  SyncCreativesResponse,
  ListCreativesResponse,
  UpdateMediaBuyResponse,
  GetMediaBuyDeliveryResponse,
  ListAuthorizedPropertiesResponse,
  ProvidePerformanceFeedbackResponse,
  BuildCreativeResponse,
  PreviewCreativeResponse,
  GetSignalsResponse,
  ActivateSignalResponse,
} from '../types/tools.generated';

/**
 * Union type of all possible AdCP responses
 * Each response type is a discriminated union of success | error
 */
export type AdCPResponse =
  | GetProductsResponse
  | ListCreativeFormatsResponse
  | CreateMediaBuyResponse
  | SyncCreativesResponse
  | ListCreativesResponse
  | UpdateMediaBuyResponse
  | GetMediaBuyDeliveryResponse
  | ListAuthorizedPropertiesResponse
  | ProvidePerformanceFeedbackResponse
  | BuildCreativeResponse
  | PreviewCreativeResponse
  | GetSignalsResponse
  | ActivateSignalResponse;

/**
 * Map of AdCP tool names to their Zod response schemas
 */
const TOOL_RESPONSE_SCHEMAS: Record<string, z.ZodSchema<AdCPResponse>> = {
  get_products: schemas.GetProductsResponseSchema as z.ZodSchema<AdCPResponse>,
  list_creative_formats: schemas.ListCreativeFormatsResponseSchema as z.ZodSchema<AdCPResponse>,
  create_media_buy: schemas.CreateMediaBuyResponseSchema as z.ZodSchema<AdCPResponse>,
  update_media_buy: schemas.UpdateMediaBuyResponseSchema as z.ZodSchema<AdCPResponse>,
  sync_creatives: schemas.SyncCreativesResponseSchema as z.ZodSchema<AdCPResponse>,
  list_creatives: schemas.ListCreativesResponseSchema as z.ZodSchema<AdCPResponse>,
  get_media_buy_delivery: schemas.GetMediaBuyDeliveryResponseSchema as z.ZodSchema<AdCPResponse>,
  list_authorized_properties: schemas.ListAuthorizedPropertiesResponseSchema as z.ZodSchema<AdCPResponse>,
  provide_performance_feedback: schemas.ProvidePerformanceFeedbackResponseSchema as z.ZodSchema<AdCPResponse>,
  build_creative: schemas.BuildCreativeResponseSchema as z.ZodSchema<AdCPResponse>,
  preview_creative: schemas.PreviewCreativeResponseSchema as z.ZodSchema<AdCPResponse>,
  get_signals: schemas.GetSignalsResponseSchema as z.ZodSchema<AdCPResponse>,
  activate_signal: schemas.ActivateSignalResponseSchema as z.ZodSchema<AdCPResponse>,
};

/**
 * Extract raw AdCP response from protocol wrapper
 *
 * @param protocolResponse - Raw response from MCP or A2A protocol
 * @param toolName - Optional AdCP tool name for validation
 * @param protocol - Protocol type ('mcp' or 'a2a'), if known. If not provided, will auto-detect.
 * @returns Raw AdCP response data matching schema exactly
 * @throws {Error} If response doesn't match expected schema for the tool
 */
export function unwrapProtocolResponse(
  protocolResponse: any,
  toolName?: string,
  protocol?: 'mcp' | 'a2a'
): AdCPResponse & { _message?: string } {
  if (!protocolResponse) {
    throw new Error('Protocol response is null or undefined');
  }

  // Extract response from protocol wrapper
  let unwrapped: any;
  if (protocol === 'mcp') {
    unwrapped = unwrapMCPResponse(protocolResponse);
  } else if (protocol === 'a2a') {
    unwrapped = unwrapA2AResponse(protocolResponse);
  } else {
    // Auto-detect protocol if not specified
    if (isMCPResponse(protocolResponse)) {
      unwrapped = unwrapMCPResponse(protocolResponse);
    } else if (isA2AResponse(protocolResponse)) {
      unwrapped = unwrapA2AResponse(protocolResponse);
    } else {
      throw new Error('Unable to extract AdCP response from protocol wrapper');
    }
  }

  // Validate response against schema if tool name provided
  if (toolName) {
    const schema = TOOL_RESPONSE_SCHEMAS[toolName];
    if (schema) {
      // Extract protocol metadata before validation
      const protocolMetadata = {
        _message: unwrapped._message,
      };

      const result = schema.safeParse(unwrapped);
      if (!result.success) {
        throw new Error(
          `Response validation failed for ${toolName}: ${result.error.message}`
        );
      }

      // Re-attach protocol metadata after validation (Zod strips unknown fields)
      if (protocolMetadata._message) {
        return {
          ...result.data,
          _message: protocolMetadata._message,
        };
      }

      return result.data;
    }
  }

  // Return unwrapped response (no validation)
  return unwrapped;
}

/**
 * Check if response is MCP format
 */
function isMCPResponse(response: any): boolean {
  return 'structuredContent' in response || 'isError' in response || 'content' in response;
}

/**
 * Check if response is A2A format
 */
function isA2AResponse(response: any): boolean {
  return 'result' in response || 'error' in response;
}

/**
 * Unwrap MCP response - all MCP logic in one place
 */
function unwrapMCPResponse(response: any): AdCPResponse {
  // MCP error response
  if (response.isError === true) {
    const errorContent = Array.isArray(response.content)
      ? response.content.find((c: any) => c.type === 'text')?.text
      : response.content?.text || 'Unknown error';

    return {
      errors: [
        {
          code: 'mcp_error',
          message: errorContent || 'MCP tool call failed',
        },
      ],
    };
  }

  // MCP success response with structuredContent
  if (response.structuredContent !== undefined && response.structuredContent !== null) {
    const data = response.structuredContent;

    // Extract text messages from content field (parallel to A2A TextParts)
    const textMessages: string[] = [];
    if (response.content && Array.isArray(response.content)) {
      for (const item of response.content) {
        if (item.type === 'text' && item.text) {
          textMessages.push(item.text);
        }
      }
    }

    // Include text messages if present (same pattern as A2A)
    if (textMessages.length > 0) {
      return {
        ...data,
        _message: textMessages.join('\n'),
      };
    }

    return data;
  }

  // MCP text content fallback (try parsing as JSON)
  if (response.content && Array.isArray(response.content)) {
    const textContent = response.content.find((c: any) => c.type === 'text');
    if (textContent?.text) {
      try {
        return JSON.parse(textContent.text);
      } catch {
        return {
          errors: [
            {
              code: 'invalid_response',
              message: 'Response does not contain structured AdCP data',
            },
          ],
        };
      }
    }
  }

  throw new Error('Invalid MCP response format');
}

/**
 * Unwrap A2A response
 *
 * NOTE: This function should only be called when status is "completed".
 * Intermediate statuses ("working", "submitted", "input-required") are handled
 * at the response level (not in artifacts) and should not reach this function.
 *
 * A2A response flow:
 * - Intermediate: { status: "working", message: "..." } - NO artifacts yet
 * - Completed: { status: "completed", result: { artifacts: [...] } } - Parse artifacts here
 */
function unwrapA2AResponse(response: any): AdCPResponse {
  // A2A error response (JSON-RPC error)
  if (response.error) {
    return {
      errors: [
        {
          code: response.error.code?.toString() || 'unknown',
          message: response.error.message || 'Unknown error',
          ...(response.error.data && { data: response.error.data }),
        },
      ],
    };
  }

  // A2A completed response - simple requirements per AdCP spec:
  // - MUST have result.artifacts array with at least one completed artifact
  // - Completed artifact MUST have at least one DataPart (kind: 'data') with the AdCP response
  // - MAY have TextParts (kind: 'text') with optional messages

  const artifacts = response.result?.artifacts;
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    throw new Error('A2A completed response must have at least one artifact');
  }

  // Take last artifact (conversational protocols append artifacts over time)
  // Note: A2A artifacts don't have a status field - only Tasks have status.
  // If the Task status is "completed", all artifacts in result.artifacts are completed.
  const artifact = artifacts[artifacts.length - 1];
  if (!artifact) {
    throw new Error('A2A completed response must have at least one artifact');
  }

  if (!artifact.parts || !Array.isArray(artifact.parts)) {
    throw new Error('A2A artifact missing parts array');
  }

  // Extract DataPart (required) and TextParts (optional)
  const dataPart = artifact.parts.find((p: any) => p.kind === 'data');
  if (!dataPart?.data) {
    throw new Error('A2A completed response must have a DataPart with AdCP data');
  }

  const textParts = artifact.parts
    .filter((p: any) => p.kind === 'text' && p.text)
    .map((p: any) => p.text);

  // Return data with optional message
  if (textParts.length > 0) {
    return {
      ...dataPart.data,
      _message: textParts.join('\n'),
    };
  }

  return dataPart.data;
}

/**
 * Check if a response is an AdCP error response
 */
export function isAdcpError(response: any): boolean {
  return Array.isArray(response?.errors) && response.errors.length > 0;
}

/**
 * Check if a response is an AdCP success response for a specific task
 *
 * Note: This is a temporary helper. TODO: Use Zod schemas for validation instead.
 */
export function isAdcpSuccess(response: any, taskName: string): boolean {
  if (isAdcpError(response)) {
    return false;
  }

  // Task-specific validation based on AdCP schemas
  // TODO: Replace with Zod schema validation
  switch (taskName) {
    case 'create_media_buy':
      return !!(response.media_buy_id && response.buyer_ref && response.packages);

    case 'update_media_buy':
      return !!response.affected_packages;

    case 'get_products':
      return Array.isArray(response.products);

    case 'list_creative_formats':
      return Array.isArray(response.formats);

    case 'sync_creatives':
      return Array.isArray(response.creatives);

    case 'list_creatives':
      return Array.isArray(response.creatives);

    case 'build_creative':
      return !!response.creative;

    case 'preview_creative':
      return !!response.preview;

    case 'get_media_buy_delivery':
      return !!response.delivery;

    case 'list_authorized_properties':
      return Array.isArray(response.properties);

    case 'provide_performance_feedback':
      return response.success === true;

    case 'get_signals':
      return Array.isArray(response.signals);

    case 'activate_signal':
      return !!response.signal_id;

    default:
      // Unknown task, can't validate
      return true;
  }
}
