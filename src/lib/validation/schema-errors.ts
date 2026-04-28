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
 * envelope. The issue list is ALSO promoted to the top level
 * (`adcp_error.issues`) so operators see JSON Pointers on the first
 * render; `details.issues` is kept as a spec-convention mirror for
 * buyers that index into `details`. `schemaPath` is optional per-issue
 * — the builder drops it by default in production so `oneOf` branch
 * selection doesn't leak to buyers.
 */
export interface AdcpValidationErrorDetails {
  tool: string;
  side: 'request' | 'response';
  issues: Array<Omit<ValidationIssue, 'schemaPath'> & { schemaPath?: string }>;
}

/**
 * Serialize issues for the server-side `adcpError('VALIDATION_ERROR', ...)` call.
 *
 * Issues appear at BOTH `adcp_error.issues` (top level, so operators
 * and debuggers see them on first render) AND `adcp_error.details.issues`
 * (the spec-convention location, so buyers that already index into
 * `details` continue to work). Future buyers should prefer
 * `adcp_error.issues`; the `details.issues` mirror is maintained for
 * compatibility across the AdCP ecosystem until a spec decision settles
 * where issues should canonically live.
 *
 * `exposeSchemaPath` controls whether each issue's AJV `schemaPath`
 * (e.g. `#/oneOf/2/properties/status/enum`) crosses the wire. When
 * false, schemaPath is stripped from the emitted `issues` (both
 * copies) — buyers still get `pointer`, `message`, and `keyword`,
 * which is enough to fix their payload, but the internal branch
 * shape of the seller's handler isn't leaked. Defaults to the same
 * policy as `exposeErrorDetails`: on in dev/test, off in production.
 */
export function buildAdcpValidationErrorPayload(
  tool: string,
  side: 'request' | 'response',
  issues: ValidationIssue[],
  options: { exposeSchemaPath?: boolean } = {}
): {
  message: string;
  field?: string;
  issues: Array<Omit<ValidationIssue, 'schemaPath'> & { schemaPath?: string }>;
  details: Record<string, unknown>;
} {
  const first = issues[0];
  const message =
    first != null
      ? `${tool} ${side} failed schema validation at ${first.pointer}: ${first.message}`
      : `${tool} ${side} failed schema validation`;
  // `exposeSchemaPath` gates `schemaPath` only. Not `variants`.
  // Different sensitivity classes justify different defaults:
  //   - `schemaPath` (e.g. `#/properties/account/oneOf/2`) encodes which
  //     branch of the validator rejected first — an implementation
  //     detail that can fingerprint the seller's handler ordering.
  //   - `variants[]` summarizes the PUBLIC spec's union shape (each
  //     variant's required / properties keys). The bundled AdCP
  //     schemas are already npm-shipped with `@adcp/sdk` and
  //     published at adcontextprotocol.org — a motivated buyer has
  //     them offline anyway. Gating would only hurt naive LLM clients
  //     in production, which is exactly the audience `variants[]` was
  //     built for (#919).
  // If a future AdCP version ever admits per-seller schema extensions
  // into the validator (today's validator only loads canonical spec
  // from `schemas/cache/<version>/`), revisit this — at that point
  // `variants[]` could start to reflect seller-internal shapes and the
  // gating argument would apply.
  const emittedIssues = options.exposeSchemaPath ? issues : issues.map(({ schemaPath: _schemaPath, ...rest }) => rest);
  const payload: {
    message: string;
    field?: string;
    issues: Array<Omit<ValidationIssue, 'schemaPath'> & { schemaPath?: string }>;
    details: Record<string, unknown>;
  } = {
    message,
    issues: emittedIssues,
    details: { tool, side, issues: emittedIssues } satisfies AdcpValidationErrorDetails as unknown as Record<
      string,
      unknown
    >,
  };
  if (first?.pointer) payload.field = first.pointer;
  return payload;
}
