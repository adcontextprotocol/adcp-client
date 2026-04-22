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
 * instead of parsing the free-text message. `schemaPath` is optional
 * per-issue — the builder drops it by default in production so
 * `oneOf` branch selection doesn't leak to buyers.
 */
export interface AdcpValidationErrorDetails {
  tool: string;
  side: 'request' | 'response';
  issues: Array<Omit<ValidationIssue, 'schemaPath'> & { schemaPath?: string }>;
}

/**
 * Serialize issues for the server-side `adcpError('VALIDATION_ERROR', ...)` call.
 *
 * `exposeSchemaPath` controls whether each issue's AJV `schemaPath`
 * (e.g. `#/oneOf/2/properties/status/enum`) crosses the wire. When
 * false, schemaPath is stripped from the emitted details.issues[] —
 * buyers still get `pointer`, `message`, and `keyword`, which is
 * enough to fix their payload, but the internal branch shape of the
 * seller's handler isn't leaked. Defaults to the same policy as
 * `exposeErrorDetails`: on in dev/test, off in production.
 */
export function buildAdcpValidationErrorPayload(
  tool: string,
  side: 'request' | 'response',
  issues: ValidationIssue[],
  options: { exposeSchemaPath?: boolean } = {}
): { message: string; field?: string; details: Record<string, unknown> } {
  const first = issues[0];
  const message =
    first != null
      ? `${tool} ${side} failed schema validation at ${first.pointer}: ${first.message}`
      : `${tool} ${side} failed schema validation`;
  const emittedIssues = options.exposeSchemaPath ? issues : issues.map(({ schemaPath: _schemaPath, ...rest }) => rest);
  const payload: { message: string; field?: string; details: Record<string, unknown> } = {
    message,
    details: { tool, side, issues: emittedIssues } satisfies AdcpValidationErrorDetails as unknown as Record<
      string,
      unknown
    >,
  };
  if (first?.pointer) payload.field = first.pointer;
  return payload;
}
