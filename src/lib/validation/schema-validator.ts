/**
 * Schema-driven validation for AdCP tool requests and responses.
 *
 * The client uses this pre-send and post-receive; the opt-in server
 * middleware uses the same core to reject drift at the dispatcher.
 */

import type { ErrorObject } from 'ajv';
import { getValidator, type Direction, type ResponseVariant } from './schema-loader';

/**
 * A single validation failure with a JSON Pointer to the offending field,
 * the AJV message, and the schema path that rejected it. Mirrors the
 * format a `VALIDATION_ERROR` carries in its `details.issues`.
 */
export interface ValidationIssue {
  /** RFC 6901 JSON Pointer to the offending field in the payload. */
  pointer: string;
  /** Human-readable message from the schema. */
  message: string;
  /** AJV keyword that rejected the payload (e.g., `required`, `type`). */
  keyword: string;
  /** Path inside the schema that rejected the payload. */
  schemaPath: string;
}

export interface ValidationOutcome {
  valid: boolean;
  issues: ValidationIssue[];
  /** Which schema variant was selected — useful for logging/debugging. */
  variant: Direction | 'skipped';
}

const OK: ValidationOutcome = Object.freeze({ valid: true, issues: [], variant: 'skipped' });

function formatIssue(err: ErrorObject): ValidationIssue {
  const instancePath = err.instancePath || '';
  const missingProperty =
    err.keyword === 'required' &&
    err.params &&
    typeof (err.params as { missingProperty?: string }).missingProperty === 'string'
      ? `/${(err.params as { missingProperty: string }).missingProperty}`
      : '';
  return {
    pointer: `${instancePath}${missingProperty}` || '/',
    message: err.message ?? 'validation failed',
    keyword: err.keyword,
    schemaPath: err.schemaPath,
  };
}

/** Validate an outgoing request against `{tool}-request.json`. */
export function validateRequest(toolName: string, payload: unknown): ValidationOutcome {
  const validator = getValidator(toolName, 'request');
  if (!validator) return OK;
  const valid = validator(payload) as boolean;
  if (valid) return { valid: true, issues: [], variant: 'request' };
  return {
    valid: false,
    issues: (validator.errors ?? []).map(formatIssue),
    variant: 'request',
  };
}

/**
 * Select the response variant by payload shape (per issue #688: choose by
 * `status` field, not just the tool name). Matches the AdCP 3.0 async
 * contract: `submitted`, `working`, `input-required`, and the sync
 * terminal states (`completed` / no status).
 */
function selectResponseVariant(payload: unknown): ResponseVariant {
  if (payload && typeof payload === 'object' && 'status' in (payload as Record<string, unknown>)) {
    const status = (payload as Record<string, unknown>).status;
    if (status === 'submitted') return 'submitted';
    if (status === 'working') return 'working';
    if (status === 'input-required') return 'input-required';
  }
  return 'sync';
}

/** Validate an incoming response; picks the async variant by payload shape. */
export function validateResponse(toolName: string, payload: unknown): ValidationOutcome {
  const variant = selectResponseVariant(payload);
  const validator = getValidator(toolName, variant);
  // If an async variant schema is missing, fall back to the sync one —
  // some tools declare `-response.json` only and use `status` as an
  // in-band marker without a dedicated variant schema.
  const effective = validator ?? (variant !== 'sync' ? getValidator(toolName, 'sync') : undefined);
  if (!effective) return OK;
  const valid = effective(payload) as boolean;
  const usedVariant: Direction = validator ? variant : 'sync';
  if (valid) return { valid: true, issues: [], variant: usedVariant };
  return {
    valid: false,
    issues: (effective.errors ?? []).map(formatIssue),
    variant: usedVariant,
  };
}

/** Render a compact one-line summary of the failures — useful for logs. */
export function formatIssues(issues: ValidationIssue[], limit = 3): string {
  const head = issues
    .slice(0, limit)
    .map(i => `${i.pointer} ${i.message}`)
    .join('; ');
  const rest = issues.length - limit;
  return rest > 0 ? `${head} (+${rest} more)` : head;
}
