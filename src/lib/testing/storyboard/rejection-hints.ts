/**
 * Context-value-rejected hint detection.
 *
 * When a seller rejects a request field with a response that carries an
 * `available:` / `allowed:` / `accepted_values:` list (per AdCP core/error
 * with `details` being `additionalProperties: true`, sellers commonly put
 * the set of values they would have accepted there), and the rejected
 * value traces back to a prior-step `$context.*` write (either via
 * substitution or via a request-builder field populated from the same
 * context key), emit a non-fatal `context_value_rejected` hint.
 *
 * Diagnostic only — does not flip the step's pass/fail. See issue #870 for
 * the rationale: without this, the rejection in logs is indistinguishable
 * from an SDK bug.
 */
import type { TaskResult } from '../types';
import type {
  ContextProvenanceEntry,
  ContextValueRejectedHint,
  StoryboardContext,
  StoryboardStepHint,
} from './types';
import { resolvePath } from './path';

/**
 * Response-body error keys the runner recognizes as carrying the seller's
 * "here's what I would have accepted" list. Matched in order; the first
 * array found is used.
 */
const ACCEPTED_VALUE_KEYS = ['available', 'allowed', 'accepted_values'] as const;

/**
 * Fields on an error object (or `error.details`) the runner recognizes as
 * pointing at the rejected request field. Matches AdCP core/error's `field`
 * (spec-canonical) plus `details.field` (common vendor extension).
 */
const FIELD_POINTER_KEYS = ['field', 'path', 'pointer'] as const;

/**
 * Extract `context_value_rejected` hints from a task result.
 *
 * The function is pure — safe to call regardless of pass/fail. Returns an
 * empty array when the response doesn't carry a recognizable rejection
 * shape or no context value matches.
 *
 * @param taskResult Raw task result from the runner.
 * @param request The exact request the runner sent (post-injection).
 * @param context The storyboard context as of the step being evaluated
 *                (pre-write — the hints trace which PRIOR step's context
 *                write the rejected value came from).
 * @param provenance Context-key → write-provenance map.
 */
export function detectContextRejectionHints(
  taskResult: TaskResult | undefined,
  request: Record<string, unknown>,
  context: StoryboardContext,
  provenance: ReadonlyMap<string, ContextProvenanceEntry>
): StoryboardStepHint[] {
  if (!taskResult) return [];
  const data = taskResult.data as Record<string, unknown> | undefined;
  if (!data) return [];
  const errors = data.errors;
  if (!Array.isArray(errors)) return [];

  const hints: StoryboardStepHint[] = [];
  // De-dupe: the same (context_key, rejected_value) shouldn't produce
  // two hints from two errors in the same response.
  const emitted = new Set<string>();

  for (const err of errors) {
    if (!err || typeof err !== 'object') continue;
    const errObj = err as Record<string, unknown>;
    const details =
      errObj.details && typeof errObj.details === 'object' && !Array.isArray(errObj.details)
        ? (errObj.details as Record<string, unknown>)
        : undefined;

    const acceptedValues = findAcceptedValues(errObj, details);
    if (!acceptedValues) continue;

    const fieldPath = findFieldPointer(errObj, details);
    const errorCode = typeof errObj.code === 'string' ? errObj.code : undefined;

    // Case A: seller told us the field — look at exactly that field.
    if (fieldPath !== undefined) {
      const rejectedValue = resolvePath(request, fieldPath);
      const hint = buildHintForValue({
        rejectedValue,
        fieldPath,
        acceptedValues,
        errorCode,
        context,
        provenance,
        emitted,
      });
      if (hint) hints.push(hint);
      continue;
    }

    // Case B: no field pointer — scan the request for values that (a) came
    // from context and (b) are absent from the accepted list. Narrow to
    // context-sourced values so we don't chatter on every string leaf.
    for (const [key, entry] of provenance) {
      const contextValue = context[key];
      if (contextValue === undefined || contextValue === null) continue;
      if (!requestContainsValue(request, contextValue)) continue;
      if (acceptedListIncludes(acceptedValues, contextValue)) continue;
      const dedupeKey = `${key}::${stringify(contextValue)}`;
      if (emitted.has(dedupeKey)) continue;
      emitted.add(dedupeKey);
      hints.push(
        buildHint({
          contextKey: key,
          entry,
          rejectedValue: contextValue,
          acceptedValues,
          ...(errorCode !== undefined && { errorCode }),
        })
      );
    }
  }

  return hints;
}

interface BuildForValueInput {
  rejectedValue: unknown;
  fieldPath: string;
  acceptedValues: unknown[];
  errorCode?: string;
  context: StoryboardContext;
  provenance: ReadonlyMap<string, ContextProvenanceEntry>;
  emitted: Set<string>;
}

/**
 * Returns the first provenance match for `rejectedValue`. When two context
 * keys happen to hold the same value, iteration order on the provenance
 * `Map` (Map iteration is insertion-ordered per ES spec, and the runner
 * inserts writes in step order) makes the earliest-written key win. This
 * is deterministic across runs but is a heuristic — the caller may need
 * to author distinct context keys to disambiguate.
 */
function buildHintForValue(input: BuildForValueInput): StoryboardStepHint | undefined {
  const { rejectedValue, fieldPath, acceptedValues, errorCode, context, provenance, emitted } = input;
  if (rejectedValue === undefined || rejectedValue === null) return undefined;
  // If the seller claims to accept the value they rejected, the error
  // shape is inconsistent — skip rather than emit a confusing hint.
  if (acceptedListIncludes(acceptedValues, rejectedValue)) return undefined;
  for (const [key, entry] of provenance) {
    const contextValue = context[key];
    if (contextValue === undefined || contextValue === null) continue;
    if (!valueEquals(contextValue, rejectedValue)) continue;
    const dedupeKey = `${key}::${stringify(rejectedValue)}`;
    if (emitted.has(dedupeKey)) return undefined;
    emitted.add(dedupeKey);
    return buildHint({
      contextKey: key,
      entry,
      rejectedValue,
      acceptedValues,
      requestField: fieldPath,
      ...(errorCode !== undefined && { errorCode }),
    });
  }
  return undefined;
}

interface BuildHintInput {
  contextKey: string;
  entry: ContextProvenanceEntry;
  rejectedValue: unknown;
  acceptedValues: unknown[];
  requestField?: string;
  errorCode?: string;
}

function buildHint(input: BuildHintInput): ContextValueRejectedHint {
  const { contextKey, entry, rejectedValue, acceptedValues, requestField, errorCode } = input;
  const message = formatMessage({
    contextKey,
    entry,
    rejectedValue,
    acceptedValues,
    ...(requestField !== undefined && { requestField }),
  });
  return {
    kind: 'context_value_rejected',
    message,
    context_key: contextKey,
    source_step_id: entry.source_step_id,
    source_kind: entry.source_kind,
    ...(entry.response_path !== undefined && { response_path: entry.response_path }),
    ...(entry.source_task !== undefined && { source_task: entry.source_task }),
    rejected_value: rejectedValue,
    ...(requestField !== undefined && { request_field: requestField }),
    accepted_values: acceptedValues,
    ...(errorCode !== undefined && { error_code: errorCode }),
  };
}

interface FormatMessageInput {
  contextKey: string;
  entry: ContextProvenanceEntry;
  rejectedValue: unknown;
  acceptedValues: unknown[];
  requestField?: string;
}

function formatMessage(input: FormatMessageInput): string {
  const { contextKey, entry, rejectedValue, acceptedValues, requestField } = input;
  const valueRepr = formatScalar(rejectedValue);
  const fieldRepr = requestField ? `\`${requestField}: ${valueRepr}\`` : `\`${valueRepr}\``;
  const sourceDetail =
    entry.source_kind === 'context_outputs' && entry.response_path
      ? `set by step \`${entry.source_step_id}\` from response path \`${entry.response_path}\``
      : entry.source_task
        ? `set by step \`${entry.source_step_id}\` (convention extractor for \`${entry.source_task}\`)`
        : `set by step \`${entry.source_step_id}\``;
  const acceptedRepr = `[${acceptedValues.map(formatScalar).join(', ')}]`;
  return (
    `Rejected ${fieldRepr} was extracted from \`$context.${contextKey}\` ` +
    `(${sourceDetail}). ` +
    `Seller's accepted values: ${acceptedRepr}. ` +
    `Check that the seller's catalogs agree on the id for this ` +
    `${contextKey.replace(/_id$/, '')} across steps.`
  );
}

function formatScalar(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function findAcceptedValues(
  err: Record<string, unknown>,
  details: Record<string, unknown> | undefined
): unknown[] | undefined {
  for (const key of ACCEPTED_VALUE_KEYS) {
    if (details && Array.isArray(details[key])) return details[key] as unknown[];
  }
  for (const key of ACCEPTED_VALUE_KEYS) {
    if (Array.isArray(err[key])) return err[key] as unknown[];
  }
  return undefined;
}

function findFieldPointer(
  err: Record<string, unknown>,
  details: Record<string, unknown> | undefined
): string | undefined {
  for (const key of FIELD_POINTER_KEYS) {
    const v = err[key];
    if (typeof v === 'string' && v.length > 0) return normalizeFieldPath(v);
  }
  if (details) {
    for (const key of FIELD_POINTER_KEYS) {
      const v = details[key];
      if (typeof v === 'string' && v.length > 0) return normalizeFieldPath(v);
    }
  }
  return undefined;
}

/**
 * Accept RFC 6901 JSON pointers (`/packages/0/pricing_option_id`) and the
 * AdCP spec's dotted form (`packages[0].pricing_option_id`). Normalize to
 * the dotted form because that's what `resolvePath` speaks.
 */
function normalizeFieldPath(path: string): string {
  if (!path.startsWith('/')) return path;
  return path
    .slice(1)
    .split('/')
    .map(seg => seg.replace(/~1/g, '/').replace(/~0/g, '~'))
    .map(seg => (/^\d+$/.test(seg) ? `[${seg}]` : seg))
    .join('.')
    .replace(/\.\[/g, '[');
}

function acceptedListIncludes(accepted: unknown[], value: unknown): boolean {
  return accepted.some(a => valueEquals(a, value));
}

/**
 * Equality for rejection matching. IDs across the ecosystem get serialized
 * as either numbers or strings ("42" vs 42), so the scalar case does
 * number↔string coercion via `String(n)` — that's safe for integer ids
 * (the AdCP ID corpus) but not guaranteed for float round-trips, which
 * aren't a concern here. Object values fall through to a canonical
 * `JSON.stringify` compare — order-sensitive by design (`{a:1,b:2}` !=
 * `{b:2,a:1}`); request/response builders produce stable key order, so
 * this is fine in practice.
 */
function valueEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'string') return String(a) === b;
  if (typeof a === 'string' && typeof b === 'number') return a === String(b);
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    return stringify(a) === stringify(b);
  }
  return false;
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Walk the request object looking for a leaf that equals `value`. Used in
 * the no-field-pointer fallback to confirm the context-sourced value is
 * actually present in the request we sent (avoids false hints when the
 * runner has a stale context key that happens to match some unrelated
 * error's rejection list).
 *
 * Carries a `seen` WeakSet to guard against self-referential request
 * objects. The runner's own injection pipeline produces fresh trees so
 * cycles shouldn't occur in practice; the guard is defensive for
 * user-supplied request overrides.
 */
function requestContainsValue(request: unknown, value: unknown, seen: WeakSet<object> = new WeakSet()): boolean {
  if (valueEquals(request, value)) return true;
  if (request === null || typeof request !== 'object') return false;
  if (seen.has(request as object)) return false;
  seen.add(request as object);
  if (Array.isArray(request)) return request.some(item => requestContainsValue(item, value, seen));
  return Object.values(request as Record<string, unknown>).some(v => requestContainsValue(v, value, seen));
}
