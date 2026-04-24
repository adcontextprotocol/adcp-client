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
import type { ValidationIssue } from '../validation/schema-validator';
import { ADCP_ERROR_FIELD_ALLOWLIST } from './envelope-allowlist';

export interface AdcpErrorOptions {
  message: string;
  /**
   * Override the recovery classification. Defaults to
   * `STANDARD_ERROR_CODES[code].recovery` for known codes, `'terminal'`
   * otherwise. Dropped from the wire shape for codes whose entry in
   * `ADCP_ERROR_FIELD_ALLOWLIST` excludes it (`IDEMPOTENCY_CONFLICT`
   * excludes `recovery` — the classifier is derivable from the code).
   */
  recovery?: ErrorRecovery;
  /**
   * Name of the request field the error applies to (validation /
   * constraint errors). Dropped from the wire shape for codes whose
   * `ADCP_ERROR_FIELD_ALLOWLIST` entry excludes it (e.g. `IDEMPOTENCY_CONFLICT`
   * — a conflict response MUST NOT echo prior payload state).
   */
  field?: string;
  /**
   * Human-readable remediation hint. Dropped from the wire shape for
   * codes whose `ADCP_ERROR_FIELD_ALLOWLIST` entry excludes it (e.g.
   * `IDEMPOTENCY_CONFLICT`).
   */
  suggestion?: string;
  /**
   * Seconds to wait before retrying a transient error. Only meaningful
   * on retryable codes (`RATE_LIMITED`, `SERVICE_UNAVAILABLE`); dropped
   * on terminal codes whose allowlist excludes it (`IDEMPOTENCY_CONFLICT`
   * — a computed `retry_after` on conflict would leak cached-entry age).
   */
  retry_after?: number;
  /**
   * Code-specific diagnostic payload. Dropped from the wire shape for
   * codes whose `ADCP_ERROR_FIELD_ALLOWLIST` entry excludes it
   * (`IDEMPOTENCY_CONFLICT` — a conflict response MUST NOT echo the
   * prior request payload or cached response body).
   */
  details?: Record<string, unknown>;
  /**
   * Schema validation issues surfaced at the top level of `adcp_error`
   * so operators see JSON Pointers on the first render. Primary use is
   * `VALIDATION_ERROR`; framework validation hooks populate this
   * automatically and also mirror the same array to `details.issues`
   * for buyers that already index into `details` per AdCP spec
   * convention.
   */
  issues?: Array<Omit<ValidationIssue, 'schemaPath'> & { schemaPath?: string }>;
}

export interface AdcpErrorPayload {
  code: string;
  message: string;
  /**
   * Closed-enum classifier. Populated by `adcpError()` from
   * `STANDARD_ERROR_CODES[code].recovery` unless the caller provides an
   * override. Marked optional because per-code inside-`adcp_error`
   * allowlists (e.g. `IDEMPOTENCY_CONFLICT`) deliberately drop it from the
   * wire shape — consumers reading a payload parsed off the wire MUST
   * tolerate `undefined`.
   */
  recovery?: ErrorRecovery;
  field?: string;
  suggestion?: string;
  retry_after?: number;
  details?: Record<string, unknown>;
  /**
   * Schema validation issues (`VALIDATION_ERROR`) exposed at the top
   * level so the list is the first thing a reader sees when inspecting
   * the envelope. Also mirrored at `details.issues` for spec-convention
   * compatibility.
   */
  issues?: Array<Omit<ValidationIssue, 'schemaPath'> & { schemaPath?: string }>;
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
 * Before returning, any field NOT allowlisted for the given code in
 * {@link ADCP_ERROR_FIELD_ALLOWLIST} is dropped — sellers get the builder's
 * ergonomics for every code AND the strict wire shape for codes that have
 * a registered allowlist. `IDEMPOTENCY_CONFLICT` is the canonical case:
 * `recovery`, `field`, `suggestion`, and `details` all silently drop so
 * the envelope can't become a stolen-key read oracle. Codes without a
 * registered allowlist pass through unchanged.
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
    ...(options.issues != null && { issues: options.issues }),
    ...(options.details != null && { details: options.details }),
  };

  const filtered = applyAdcpErrorAllowlist(code, adcp_error);

  return {
    content: [{ type: 'text', text: JSON.stringify({ adcp_error: filtered }) }],
    isError: true,
    structuredContent: { adcp_error: filtered },
  };
}

/**
 * Drop every field not in {@link ADCP_ERROR_FIELD_ALLOWLIST} for `code`.
 * Codes without an entry pass through unchanged — the allowlist is
 * opt-in per code, not a global filter. The returned object is re-typed
 * as `AdcpErrorPayload` on the assumption that `code` and `message`
 * (the only required fields) are in every registered allowlist; that
 * invariant is re-asserted at runtime by the module-load check in
 * `envelope-allowlist.ts`.
 */
function applyAdcpErrorAllowlist(code: string, payload: AdcpErrorPayload): AdcpErrorPayload {
  const allowlist = ADCP_ERROR_FIELD_ALLOWLIST[code];
  if (!allowlist) return payload;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (allowlist.has(key)) out[key] = value;
  }
  return out as unknown as AdcpErrorPayload;
}
