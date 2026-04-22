/**
 * Server-side helpers for producing L3-compliant AdCP error responses.
 *
 * Use `adcpError()` in MCP tool handlers to return structured errors
 * that clients can automatically detect, classify, and act on.
 */

import {
  STANDARD_ERROR_CODES,
  isStandardErrorCode,
  type StandardErrorCode,
  type ErrorRecovery,
} from '../types/error-codes';

export interface AdcpErrorOptions {
  message: string;
  recovery?: ErrorRecovery;
  field?: string;
  suggestion?: string;
  retry_after?: number;
  details?: Record<string, unknown>;
}

export interface AdcpErrorPayload {
  code: string;
  message: string;
  recovery: ErrorRecovery;
  field?: string;
  suggestion?: string;
  retry_after?: number;
  details?: Record<string, unknown>;
}

export interface AdcpErrorResponse {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
  structuredContent: {
    adcp_error: AdcpErrorPayload;
  };
}

/**
 * Build an L3-compliant MCP tool error response with all three transport layers:
 *
 * 1. `structuredContent.adcp_error` — programmatic extraction (L3)
 * 2. `content[0].text` — JSON text fallback (L2)
 * 3. `isError: true` — MCP error signal
 *
 * Recovery is auto-populated from the standard error code table when not provided.
 *
 * @example
 * ```typescript
 * import { adcpError } from '@adcp/client';
 *
 * server.registerTool("get_products", { inputSchema: schema }, async ({ query }) => {
 *   if (!products.length) {
 *     return adcpError('PRODUCT_NOT_FOUND', {
 *       message: 'No products match query',
 *       field: 'query',
 *       suggestion: 'Try a broader search term',
 *     });
 *   }
 *   return { content: [...], structuredContent: { products } };
 * });
 * ```
 */
export function adcpError(code: StandardErrorCode | (string & {}), options: AdcpErrorOptions): AdcpErrorResponse {
  const recovery: ErrorRecovery =
    options.recovery ??
    (isStandardErrorCode(code) ? STANDARD_ERROR_CODES[code as StandardErrorCode].recovery : 'terminal');

  const adcp_error: AdcpErrorPayload = {
    code,
    message: options.message,
    recovery,
    ...(options.field != null && { field: options.field }),
    ...(options.suggestion != null && { suggestion: options.suggestion }),
    ...(options.retry_after != null && { retry_after: options.retry_after }),
    ...(options.details != null && { details: options.details }),
  };

  return {
    content: [{ type: 'text', text: JSON.stringify({ adcp_error }) }],
    isError: true,
    structuredContent: { adcp_error },
  };
}
