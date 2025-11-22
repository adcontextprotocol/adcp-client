/**
 * Response Unwrapper
 *
 * Extracts raw AdCP responses from protocol wrappers (MCP/A2A).
 * Follows canonical A2A response format per AdCP specification.
 */

import { z } from 'zod';

/**
 * Standard error codes for response unwrapping
 */
const ERROR_CODES = {
  MCP_ERROR: 'mcp_error',
  INVALID_RESPONSE: 'invalid_response',
  UNKNOWN: 'unknown',
} as const;
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
 *
 * TYPE SAFETY TRADE-OFF ANALYSIS:
 *
 * Current approach: All schemas cast to `z.ZodSchema<AdCPResponse>` (union type)
 *
 * Why we keep this approach:
 * 1. Simplicity - Single map type is easy to maintain and extend
 * 2. Runtime validation - Zod schemas provide full validation regardless of type
 * 3. Return type accuracy - unwrapProtocolResponse returns `AdCPResponse` union anyway
 * 4. Minimal type loss - The specific schema validates correctly at runtime
 *
 * Alternative considered (function overloads):
 * ```typescript
 * function unwrapProtocolResponse(response: any, toolName: 'get_products'): GetProductsResponse;
 * function unwrapProtocolResponse(response: any, toolName: 'create_media_buy'): CreateMediaBuyResponse;
 * // ... 13 overloads total
 * ```
 *
 * Why we don't use overloads:
 * 1. High maintenance burden - 13+ overload signatures to maintain
 * 2. Fragile - Easy to forget updating overloads when adding tools
 * 3. Limited benefit - Caller still needs type guards to narrow union
 * 4. Optional toolName - toolName parameter is optional, overloads don't help
 *
 * Alternative considered (mapped types):
 * ```typescript
 * type ToolSchemaMap = {
 *   [K in keyof typeof TOOL_RESPONSE_SCHEMAS]: z.ZodSchema<Extract<AdCPResponse, { ... }>>
 * }
 * ```
 *
 * Why we don't use mapped types:
 * 1. Complexity - Requires discriminated union detection logic
 * 2. Fragile - AdCP responses don't all have discriminator fields
 * 3. Minimal benefit - Still returns union type, needs type guards at call site
 *
 * Conclusion: Current approach provides best balance of simplicity, maintainability,
 * and runtime safety. TypeScript types are validated by Zod at runtime anyway.
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
      // Create wrapper schema that preserves protocol metadata
      // We use z.intersection to combine the validated response with optional _message field
      const wrapperSchema = z.intersection(schema, z.object({ _message: z.string().optional() }));

      const result = wrapperSchema.safeParse(unwrapped);
      if (!result.success) {
        throw new Error(`Response validation failed for ${toolName}: ${result.error.message}`);
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
          code: ERROR_CODES.MCP_ERROR,
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
        // Include snippet of text for debugging (max 100 chars)
        const snippet = textContent.text.length > 100 ? textContent.text.substring(0, 100) + '...' : textContent.text;

        return {
          errors: [
            {
              code: ERROR_CODES.INVALID_RESPONSE,
              message: `Response does not contain structured AdCP data. Text content: "${snippet}"`,
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
  // Validate that we're not processing intermediate statuses
  // Task status check: only completed tasks should reach artifact extraction
  if (response.result?.status?.state && response.result.status.state !== 'completed') {
    throw new Error(
      `Cannot unwrap A2A response with intermediate status: ${response.result.status.state}. ` +
        'Only completed responses should be unwrapped.'
    );
  }
  // A2A error response (JSON-RPC error)
  if (response.error) {
    return {
      errors: [
        {
          code: response.error.code?.toString() || ERROR_CODES.UNKNOWN,
          message: response.error.message || 'A2A JSON-RPC error occurred',
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
  // Get last data part to be consistent with taking last artifact in conversational protocol
  const dataParts = artifact.parts.filter((p: any) => p.kind === 'data');
  const dataPart = dataParts[dataParts.length - 1];
  if (!dataPart?.data) {
    throw new Error('A2A completed response must have a DataPart with AdCP data');
  }

  const textParts = artifact.parts.filter((p: any) => p.kind === 'text' && p.text).map((p: any) => p.text);

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
 * Uses Zod schemas to validate the response structure matches the expected
 * success response format for the given task.
 */
export function isAdcpSuccess(response: any, taskName: string): boolean {
  // First check if it's an error response
  if (isAdcpError(response)) {
    return false;
  }

  // Try to validate with Zod schema if available
  const schema = TOOL_RESPONSE_SCHEMAS[taskName];
  if (schema) {
    const result = schema.safeParse(response);
    return result.success;
  }

  // Unknown task - can't validate, assume success if no errors
  return true;
}
