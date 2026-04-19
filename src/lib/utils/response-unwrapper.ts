/**
 * Response Unwrapper
 *
 * Extracts raw AdCP responses from protocol wrappers (MCP/A2A).
 * Follows canonical A2A response format per AdCP specification.
 */

import { z } from 'zod';
import { getBestUnionErrors } from './union-errors';

/**
 * Standard error codes for response unwrapping
 */
const ERROR_CODES = {
  MCP_ERROR: 'mcp_error',
  INVALID_RESPONSE: 'invalid_response',
  UNKNOWN: 'unknown',
} as const;
import type {
  GetProductsResponse,
  ListCreativeFormatsResponse,
  CreateMediaBuyResponse,
  SyncCreativesResponse,
  ListCreativesResponse,
  UpdateMediaBuyResponse,
  GetMediaBuysResponse,
  GetMediaBuyDeliveryResponse,
  ProvidePerformanceFeedbackResponse,
  BuildCreativeResponse,
  PreviewCreativeResponse,
  GetSignalsResponse,
  ActivateSignalResponse,
} from '../types/tools.generated';
import { TOOL_RESPONSE_SCHEMAS } from './response-schemas';

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
  | GetMediaBuysResponse
  | GetMediaBuyDeliveryResponse
  | ProvidePerformanceFeedbackResponse
  | BuildCreativeResponse
  | PreviewCreativeResponse
  | GetSignalsResponse
  | ActivateSignalResponse;

/**
 * Extract raw AdCP response from protocol wrapper
 *
 * @param protocolResponse - Raw response from MCP or A2A protocol
 * @param toolName - Optional AdCP tool name for validation
 * @param protocol - Protocol type ('mcp' or 'a2a'), if known. If not provided, will auto-detect.
 * @param options - Optional validation behavior overrides
 * @returns Raw AdCP response data matching schema exactly
 * @throws {Error} If response doesn't match expected schema for the tool
 */
export function unwrapProtocolResponse(
  protocolResponse: any,
  toolName?: string,
  protocol?: 'mcp' | 'a2a',
  options?: { filterInvalidProducts?: boolean }
): AdCPResponse & { _message?: string } {
  if (!protocolResponse) {
    throw new Error('Protocol response is null or undefined');
  }

  // Extract response from protocol wrapper
  let unwrapped: any;
  let mcpExtractionPath: McpExtractionPath | undefined;
  if (protocol === 'mcp') {
    const outcome = unwrapMCPResponse(protocolResponse);
    unwrapped = outcome.result;
    mcpExtractionPath = outcome.extractionPath;
  } else if (protocol === 'a2a') {
    unwrapped = unwrapA2AResponse(protocolResponse);
  } else {
    // Auto-detect protocol if not specified
    if (isMCPResponse(protocolResponse)) {
      const outcome = unwrapMCPResponse(protocolResponse);
      unwrapped = outcome.result;
      mcpExtractionPath = outcome.extractionPath;
    } else if (isA2AResponse(protocolResponse)) {
      unwrapped = unwrapA2AResponse(protocolResponse);
    } else {
      throw new Error('Unable to extract AdCP response from protocol wrapper');
    }
  }
  // Preserve the extraction path across Zod's `safeParse` (which returns a
  // fresh object). `retag` re-attaches the provenance to whichever object we
  // return so the tag survives validation, filtering, and _message merging.
  const retag = <T extends AdCPResponse & { _message?: string }>(value: T): T => {
    if (mcpExtractionPath !== undefined) tagExtractionPath(value, mcpExtractionPath);
    return value;
  };

  if (mcpExtractionPath !== undefined) {
    tagExtractionPath(unwrapped, mcpExtractionPath);
  }

  // Skip schema validation for error responses — they don't include
  // tool-specific fields like `products`. Handles both AdCP-standard
  // { errors: [...] } and legacy singular { error: "..." } patterns.
  if (isAdcpError(unwrapped) || (unwrapped?.error && typeof unwrapped.error === 'string')) {
    return retag(unwrapped);
  }

  // Validate success responses against tool schema if tool name provided
  if (toolName) {
    const schema = TOOL_RESPONSE_SCHEMAS[toolName];
    if (schema) {
      // Strip _message before validation — it's a text summary added by the unwrapper,
      // not part of the AdCP response schema. Intersection with union schemas fails in Zod v4.
      const { _message: _msg, ...dataToValidate } = unwrapped as Record<string, unknown>;
      const result = schema.safeParse(dataToValidate);
      if (!result.success) {
        // When filterInvalidArrayItems is enabled and this is a get_products response,
        // try filtering invalid products individually rather than rejecting the entire response.
        if (options?.filterInvalidProducts && toolName === 'get_products') {
          const filtered = filterInvalidProducts(schema, dataToValidate);
          if (filtered) {
            const validated = filtered as unknown as AdCPResponse & { _message?: string };
            if (_msg) validated._message = _msg as string;
            return retag(validated);
          }
        }

        // Union schemas produce a generic "Invalid input" at (root).
        // Try each variant to surface the actual missing/invalid fields.
        const firstIssue = result.error.issues[0];
        const isUnionError = result.error.issues.length === 1 && firstIssue?.code === 'invalid_union';

        if (isUnionError) {
          const betterErrors = getBestUnionErrors(schema, dataToValidate);
          if (betterErrors && betterErrors.length > 0) {
            const bestMessage = betterErrors.map(e => `${e.path}: ${e.message}`).join('; ');
            throw new Error(`Response validation failed for ${toolName}: ${bestMessage}`);
          }
        }

        throw new Error(`Response validation failed for ${toolName}: ${result.error.message}`);
      }

      // Re-attach _message after validation so it's available for text summaries
      const validated = result.data as AdCPResponse & { _message?: string };
      if (_msg) validated._message = _msg as string;
      return retag(validated);
    }
  }

  // Return unwrapped response (no validation) — already tagged above.
  return unwrapped as AdCPResponse;
}

/**
 * Filter invalid products from a get_products response.
 *
 * Validates each product individually against the ProductSchema,
 * keeps only valid ones, and re-validates the full response.
 * Returns the filtered response, or null if filtering can't help.
 */
function filterInvalidProducts(schema: z.ZodType, data: Record<string, unknown>): Record<string, unknown> | null {
  const products = data.products;
  if (!Array.isArray(products)) return null;

  const ProductSchema = (schema as z.ZodObject<any>).shape?.products;
  if (!(ProductSchema instanceof z.ZodArray)) return null;

  const elementSchema = (ProductSchema as z.ZodArray<any>).element;
  const validProducts: unknown[] = [];
  for (const product of products) {
    if (elementSchema.safeParse(product).success) {
      validProducts.push(product);
    }
  }

  // Nothing was filtered — all products are individually valid, so the validation
  // error is at the response level (not caused by invalid products). Fall through
  // to the normal error path.
  if (validProducts.length === products.length) return null;

  const filtered = { ...data, products: validProducts };
  const revalidated = schema.safeParse(filtered);
  if (revalidated.success) {
    const droppedCount = products.length - validProducts.length;
    console.warn(
      `[adcp-client] Filtered ${droppedCount} invalid product(s) from get_products response (${validProducts.length} valid, ${products.length} total)`
    );
    return revalidated.data as Record<string, unknown>;
  }

  return null;
}

/**
 * Check if response is MCP format
 */
function isMCPResponse(response: any): boolean {
  return 'structuredContent' in response || 'isError' in response || 'content' in response;
}

/**
 * Check if response is A2A format.
 * A2A errors are JSON-RPC objects ({ code, message }), not strings.
 */
function isA2AResponse(response: any): boolean {
  return 'result' in response || ('error' in response && typeof response.error === 'object' && response.error !== null);
}

/**
 * MCP response extraction provenance. Set as a non-enumerable `_extraction_path`
 * property on the unwrapped object so the storyboard runner can surface it in
 * its runner-output contract without leaking into JSON-serialized or spread
 * responses. See `src/lib/testing/storyboard/types.ts` → `RunnerExtractionPath`.
 */
export type McpExtractionPath = 'structured_content' | 'text_fallback' | 'error' | 'none';

export const EXTRACTION_PATH_KEY = '_extraction_path' as const;

interface McpUnwrapOutcome {
  result: AdCPResponse;
  extractionPath: McpExtractionPath;
}

/**
 * Unwrap MCP response - all MCP logic in one place.
 *
 * Also records which branch produced the parsed response (structuredContent
 * vs text content) so downstream tooling can tell a runner extraction bug
 * apart from an agent bug.
 */
function unwrapMCPResponse(response: any): McpUnwrapOutcome {
  // MCP error response — preserve full structured data (context, ext, adcp_error)
  if (response.isError === true) {
    // L3: structuredContent has the full error payload.
    // Trust boundary: this is untrusted agent content passed through as-is.
    // Consumers must sanitize fields like suggestion/details before rendering.
    if (response.structuredContent && typeof response.structuredContent === 'object') {
      return { result: response.structuredContent as AdCPResponse, extractionPath: 'error' };
    }

    // L2: JSON in text content
    if (Array.isArray(response.content)) {
      for (const item of response.content) {
        if (item?.type === 'text' && item.text) {
          try {
            const parsed = JSON.parse(item.text);
            if (parsed?.adcp_error && typeof parsed.adcp_error.code === 'string') {
              return { result: parsed as AdCPResponse, extractionPath: 'error' };
            }
          } catch {
            // not JSON, continue to raw text fallback
          }
        }
      }
    }

    // L1: Raw text fallback — no structured data available
    const errorContent = Array.isArray(response.content)
      ? response.content.find((c: any) => c.type === 'text')?.text
      : response.content?.text || 'Unknown error';

    return {
      result: {
        adcp_error: {
          code: ERROR_CODES.MCP_ERROR,
          message: errorContent || 'MCP tool call failed',
          synthetic: true,
        },
      } as unknown as AdCPResponse,
      extractionPath: 'error',
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
        result: {
          ...data,
          _message: textMessages.join('\n'),
        },
        extractionPath: 'structured_content',
      };
    }

    return { result: data, extractionPath: 'structured_content' };
  }

  // MCP text content fallback (try parsing as JSON)
  if (response.content && Array.isArray(response.content)) {
    const textContent = response.content.find((c: any) => c.type === 'text');
    if (textContent?.text) {
      try {
        return { result: JSON.parse(textContent.text), extractionPath: 'text_fallback' };
      } catch {
        // Include snippet of text for debugging (max 100 chars)
        const snippet = textContent.text.length > 100 ? textContent.text.substring(0, 100) + '...' : textContent.text;

        return {
          result: {
            errors: [
              {
                code: ERROR_CODES.INVALID_RESPONSE,
                message: `Response does not contain structured AdCP data. Text content: "${snippet}"`,
              },
            ],
          },
          extractionPath: 'text_fallback',
        };
      }
    }
  }

  throw new Error('Invalid MCP response format');
}

/**
 * Attach the extraction path to an unwrapped object as a non-enumerable
 * property. Non-enumerable so `JSON.stringify`, `Object.keys`, and spread
 * ignore it — the storyboard runner reads it via a direct property access
 * but the rest of the system sees the unwrapped data unchanged.
 */
function tagExtractionPath(result: AdCPResponse, path: McpExtractionPath): AdCPResponse {
  if (result === null || typeof result !== 'object') return result;
  try {
    Object.defineProperty(result, EXTRACTION_PATH_KEY, {
      value: path,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  } catch {
    // Frozen / sealed objects reject defineProperty; drop the tag silently —
    // the runner's fallback inference in extractionFromTaskResult still works.
  }
  return result;
}

/**
 * Read the extraction path from an unwrapped AdCP response, or `undefined`
 * if the response did not originate from an MCP unwrap path.
 */
export function readExtractionPath(data: unknown): McpExtractionPath | undefined {
  if (data === null || typeof data !== 'object') return undefined;
  const path = (data as Record<string, unknown>)[EXTRACTION_PATH_KEY];
  return typeof path === 'string' ? (path as McpExtractionPath) : undefined;
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

  // Unwrap nested response field if present (some agents wrap AdCP responses)
  let data = dataPart.data;
  if (data?.response && typeof data.response === 'object' && !Array.isArray(data.response)) {
    data = data.response;
  }

  // Return data with optional message
  if (textParts.length > 0) {
    return {
      ...data,
      _message: textParts.join('\n'),
    };
  }

  return data;
}

/**
 * Check if a response is an AdCP error response.
 * Recognizes both `{ adcp_error: { code: string } }` (MCP structured errors)
 * and `{ errors: [{ code, message }] }` (legacy/A2A format).
 */
export function isAdcpError(response: any): boolean {
  if (Array.isArray(response?.errors) && response.errors.length > 0) return true;
  if (response?.adcp_error && typeof response.adcp_error.code === 'string') return true;
  return false;
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
    const { _message: _, ...dataToValidate } = (response ?? {}) as Record<string, unknown>;
    const result = schema.safeParse(dataToValidate);
    return result.success;
  }

  // Unknown task - can't validate, assume success if no errors
  return true;
}
