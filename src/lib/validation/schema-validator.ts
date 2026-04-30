/**
 * Schema-driven validation for AdCP tool requests and responses.
 *
 * The client uses this pre-send and post-receive; the opt-in server
 * middleware uses the same core to reject drift at the dispatcher.
 */

import type { ErrorObject } from 'ajv';
import { getValidator, type Direction, type ResponseVariant } from './schema-loader';

/**
 * One variant of a `oneOf` / `anyOf` that the caller's payload could have
 * matched, summarized down to what a client (human or LLM) needs to know
 * to pick one. Attached to `ValidationIssue` when `keyword` is `oneOf`
 * or `anyOf`. Omitted otherwise.
 */
export interface ValidationIssueVariant {
  /** Zero-based index of the variant in the schema's `oneOf`/`anyOf` array. */
  index: number;
  /** Required property names on this variant (per its `required` array). */
  required: string[];
  /**
   * Keys declared in the variant's `properties`. Useful for clients that
   * want to show "this variant accepts X, Y, Z" without fetching the
   * full schema. Empty if the variant doesn't declare properties.
   */
  properties: string[];
}

/**
 * A single validation failure with a JSON Pointer to the offending field,
 * the AJV message, and the schema path that rejected it. Mirrors the
 * format a `VALIDATION_ERROR` carries at `adcp_error.issues` (top level)
 * and `adcp_error.details.issues` (spec-convention mirror).
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
  /**
   * Variants a caller can pick from when `keyword === 'oneOf'` or
   * `'anyOf'`. Each entry carries the variant's required fields + known
   * properties so a naive LLM client can recover without fetching the
   * full schema. Absent on non-union keywords.
   *
   * Unlike {@link ValidationIssue.schemaPath} (which is gated behind
   * `exposeSchemaPath` because it encodes which branch the seller's
   * handler rejected first — an implementation detail), `variants[]`
   * ships on the wire by default. Rationale: it reflects the PUBLIC
   * spec's union shape, which the bundled AdCP schemas under
   * `schemas/cache/<version>/` already make available to anyone with
   * `@adcp/sdk` installed. Gating would hurt naive LLM clients in
   * production — exactly the audience this field was built to help
   * (adcp-client#919).
   */
  variants?: ValidationIssueVariant[];
  /**
   * Closed enum values the payload MUST match for `keyword: 'enum'`
   * issues. AdCP wire schemas use enum heavily for status fields,
   * channels, pricing models, delivery types, etc. Without this list
   * on the wire envelope, both LLM-generated platforms and humans
   * have to fetch the schema just to discover the allowed values —
   * the most common self-correction failure surfaced by the Emma matrix.
   *
   * Absent on non-enum keywords. Always projected (not gated behind
   * `exposeSchemaPath`) — these are PUBLIC spec values, not internal
   * branch detail.
   */
  allowedValues?: readonly unknown[];
}

export interface ValidationOutcome {
  valid: boolean;
  issues: ValidationIssue[];
  /** Which schema variant was selected — useful for logging/debugging. */
  variant: Direction | 'skipped';
  /**
   * True when the response's `status` field named an async variant
   * (`submitted` / `working` / `input-required`) but no compiled schema
   * existed for that variant, so validation fell back to the sync
   * response schema. The agent is using an async shape that this tool
   * doesn't explicitly schema — a conformance signal the sync-fallback
   * validation can't render by itself. Absent on normal sync or
   * fully-schema-covered async flows.
   */
  variant_fallback_applied?: boolean;
  /** Variant requested by payload shape before fallback. Set iff `variant_fallback_applied`. */
  requested_variant?: ResponseVariant;
}

const OK: ValidationOutcome = Object.freeze({ valid: true, issues: [], variant: 'skipped' });

/**
 * Drop sub-branch errors emitted by Ajv's `allErrors:true` mode when a
 * `oneOf` keyword fails. Ajv validates ALL branches and collects every
 * sub-error; when no branch matches the `oneOf` node error itself is the
 * actionable signal — per-branch `required`/`type` errors from non-matching
 * variants are noise that masks the real failure message.
 *
 * Filter rule: an error is a sub-branch error when its `schemaPath` is a
 * strict descendant of a failing `oneOf` node's `schemaPath` (i.e., the
 * `oneOf` node error exists in the same error list at a shorter path). The
 * `oneOf` node errors themselves are always kept; `anyOf` sub-errors are
 * intentionally NOT filtered because `anyOf` allows partial matches and
 * its sub-errors carry useful disambiguation signal.
 */
function filterOneOfSubErrors(errors: ErrorObject[]): ErrorObject[] {
  const oneOfPaths = new Set<string>();
  for (const err of errors) {
    if (err.keyword === 'oneOf') oneOfPaths.add(err.schemaPath);
  }
  if (oneOfPaths.size === 0) return errors;
  return errors.filter(err => {
    if (err.keyword === 'oneOf') return true; // always keep oneOf node errors, including nested ones
    for (const p of oneOfPaths) {
      if (err.schemaPath.startsWith(p + '/')) return false;
    }
    return true;
  });
}

function formatIssue(err: ErrorObject): ValidationIssue {
  const instancePath = err.instancePath || '';
  const missingProperty =
    err.keyword === 'required' &&
    err.params &&
    typeof (err.params as { missingProperty?: string }).missingProperty === 'string'
      ? `/${(err.params as { missingProperty: string }).missingProperty}`
      : '';

  // Enrich enum errors with the allowed values from AJV's params + replace
  // the opaque "must be equal to one of the allowed values" message with
  // the actual list. Without this, LLM-generated platforms can't self-
  // correct (Emma matrix v17, 2026-04-30): the validation cascade from
  // a single bad enum value swallows ~30 storyboard steps because no
  // self-correction signal is available without fetching the schema.
  const isEnum =
    err.keyword === 'enum' &&
    err.params != null &&
    Array.isArray((err.params as { allowedValues?: unknown[] }).allowedValues);
  const allowedValues = isEnum ? (err.params as { allowedValues: readonly unknown[] }).allowedValues : undefined;
  const message = isEnum
    ? `must be one of: ${allowedValues!.map(v => JSON.stringify(v)).join(', ')}`
    : (err.message ?? 'validation failed');

  return {
    pointer: `${instancePath}${missingProperty}` || '/',
    message,
    keyword: err.keyword,
    schemaPath: err.schemaPath,
    ...(allowedValues !== undefined && { allowedValues }),
  };
}

/**
 * Resolve an AJV `schemaPath` like `"#/properties/account/oneOf"` against
 * the compiled validator's root schema. Returns `undefined` if the path
 * doesn't land on an object. Handles URI-encoded path segments (AJV
 * escapes `~` as `~0` and `/` as `~1` per RFC 6901).
 */
function resolveSchemaPath(rootSchema: unknown, schemaPath: string): unknown {
  if (rootSchema == null) return undefined;
  const clean = schemaPath.replace(/^#\/?/, '');
  if (clean.length === 0) return rootSchema;
  let cursor: unknown = rootSchema;
  for (const raw of clean.split('/')) {
    if (cursor == null || (typeof cursor !== 'object' && !Array.isArray(cursor))) return undefined;
    const decoded = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    cursor = (cursor as Record<string, unknown>)[decoded];
  }
  return cursor;
}

/**
 * When an AJV error has `keyword: 'oneOf' | 'anyOf'`, resolve the
 * schema's variant array and summarize each variant so a client can
 * pick one without fetching the full schema. See {@link ValidationIssueVariant}.
 * Returns the issue unchanged when the keyword doesn't match or the
 * resolution fails (e.g. the variant list is inlined in an unexpected
 * way).
 */
function enrichWithVariants(issue: ValidationIssue, rootSchema: unknown): ValidationIssue {
  if (issue.keyword !== 'oneOf' && issue.keyword !== 'anyOf') return issue;
  const resolved = resolveSchemaPath(rootSchema, issue.schemaPath);
  if (!Array.isArray(resolved)) return issue;
  const variants: ValidationIssueVariant[] = resolved.map((variant: unknown, index: number) => {
    if (variant == null || typeof variant !== 'object') {
      return { index, required: [], properties: [] };
    }
    const v = variant as Record<string, unknown>;
    const required = Array.isArray(v.required) ? (v.required.filter(r => typeof r === 'string') as string[]) : [];
    const properties =
      v.properties != null && typeof v.properties === 'object' ? Object.keys(v.properties as object) : [];
    return { index, required, properties };
  });
  return { ...issue, variants };
}

/**
 * Validate an outgoing request against `{tool}-request.json`.
 *
 * `version` selects which AdCP version's schema bundle to validate against;
 * defaults to the SDK-pinned `ADCP_VERSION`. Pass the per-instance value
 * from `getAdcpVersion()` to validate against a pinned-version client/server's
 * schema.
 */
export function validateRequest(toolName: string, payload: unknown, version?: string): ValidationOutcome {
  const validator = getValidator(toolName, 'request', version);
  if (!validator) return OK;
  const valid = validator(payload) as boolean;
  if (valid) return { valid: true, issues: [], variant: 'request' };
  const rootSchema = (validator as { schema?: unknown }).schema;
  return {
    valid: false,
    issues: filterOneOfSubErrors(validator.errors ?? [])
      .map(formatIssue)
      .map(i => enrichWithVariants(i, rootSchema)),
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

/**
 * Validate an incoming response; picks the async variant by payload shape.
 *
 * `version` selects which AdCP version's schema bundle to validate against;
 * defaults to the SDK-pinned `ADCP_VERSION`. See {@link validateRequest} for
 * the per-instance use case.
 */
export function validateResponse(toolName: string, payload: unknown, version?: string): ValidationOutcome {
  const variant = selectResponseVariant(payload);
  const validator = getValidator(toolName, variant, version);
  // If an async variant schema is missing, fall back to the sync one —
  // some tools declare `-response.json` only and use `status` as an
  // in-band marker without a dedicated variant schema.
  const effective = validator ?? (variant !== 'sync' ? getValidator(toolName, 'sync', version) : undefined);
  if (!effective) return OK;
  const valid = effective(payload) as boolean;
  const usedVariant: Direction = validator ? variant : 'sync';
  const variantFallback = !validator && variant !== 'sync';
  const fallbackFields: Pick<ValidationOutcome, 'variant_fallback_applied' | 'requested_variant'> = variantFallback
    ? { variant_fallback_applied: true, requested_variant: variant }
    : {};
  if (valid) return { valid: true, issues: [], variant: usedVariant, ...fallbackFields };
  const rootSchema = (effective as { schema?: unknown }).schema;
  return {
    valid: false,
    issues: filterOneOfSubErrors(effective.errors ?? [])
      .map(formatIssue)
      .map(i => enrichWithVariants(i, rootSchema)),
    variant: usedVariant,
    ...fallbackFields,
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
