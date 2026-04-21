/**
 * Convert schema validation failures into the AdCP L3 `VALIDATION_ERROR`
 * envelope and the `ValidationError` thrown type.
 */

import { ValidationError } from '../errors';
import type { ValidationIssue } from './schema-validator';

export interface ValidationErrorDetails {
  /** Tool that was being validated. */
  tool: string;
  /** Which side of the exchange — request (outgoing) or response (incoming). */
  side: 'request' | 'response';
  /** All failures, each with a JSON Pointer to the bad field. */
  issues: ValidationIssue[];
}

/**
 * Build a `ValidationError` thrown by strict-mode client hooks. Keeps the
 * existing constructor signature (`field, value, constraint`) but threads
 * the full issue list through `details` so callers can inspect every
 * pointer, not just the first.
 */
export function buildValidationError(
  tool: string,
  side: 'request' | 'response',
  issues: ValidationIssue[]
): ValidationError {
  const first = issues[0];
  const field = first?.pointer ?? '/';
  const constraint = first ? `${first.keyword}: ${first.message}` : 'schema validation failed';
  const err = new ValidationError(field, undefined, `${tool} ${side}: ${constraint}`);
  err.details = { tool, side, issues } satisfies ValidationErrorDetails;
  return err;
}

/**
 * Shape of `adcp_error.details` inside a server-side `VALIDATION_ERROR`
 * envelope. Shipped so buyers can index every pointer programmatically
 * instead of parsing the free-text message.
 */
export interface AdcpValidationErrorDetails {
  tool: string;
  side: 'request' | 'response';
  issues: ValidationIssue[];
}

/** Serialize issues for the server-side `adcpError('VALIDATION_ERROR', ...)` call. */
export function buildAdcpValidationErrorPayload(
  tool: string,
  side: 'request' | 'response',
  issues: ValidationIssue[]
): { message: string; field?: string; details: Record<string, unknown> } {
  const first = issues[0];
  const message =
    first != null
      ? `${tool} ${side} failed schema validation at ${first.pointer}: ${first.message}`
      : `${tool} ${side} failed schema validation`;
  const payload: { message: string; field?: string; details: Record<string, unknown> } = {
    message,
    details: { tool, side, issues } satisfies AdcpValidationErrorDetails as unknown as Record<string, unknown>,
  };
  if (first?.pointer) payload.field = first.pointer;
  return payload;
}
