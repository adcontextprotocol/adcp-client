/**
 * Format-mismatch hint detection.
 *
 * When a response_schema validation passes the lenient Zod check but fails
 * strict AJV validation on a `format` keyword (`date-time`, `uuid`, `uri`,
 * `email`, etc.), emit a non-fatal `format_mismatch` hint. This is the
 * strict/lenient delta the runner already computes inside
 * `StrictValidationVerdict` — today the delta shows up as a `warning` string
 * on `ValidationResult`; this module surfaces it as machine-readable fields
 * a renderer can quote back at the developer with an exact fix suggestion.
 *
 * Fires only on `strict_only_failure` steps: lenient Zod accepted the
 * response (`ValidationResult.passed === true`) but strict AJV rejected it
 * (`strict.valid === false`). Firing on already-failing lenient steps would
 * add noise on top of more fundamental failures. See issue #947.
 */

import type { FormatMismatchHint, ValidationResult } from './types';
import { resolvePath } from './path';

const FORMAT_KEYWORD_RE = /must match format "([^"]+)"/i;
const OBSERVED_VALUE_MAX_LEN = 200;

/**
 * Extract `format_mismatch` hints from a step's validation results.
 *
 * Pure — safe to call regardless of step pass/fail. Returns an empty array
 * when no strict_only_failure response_schema validations have format issues.
 *
 * @param validations - The step's computed validation results.
 * @param tool - AdCP task name (snake_case) the step dispatched.
 * @param data - Raw parsed response payload (`taskResult.data`). Used to
 *   extract `observed_value` at the RFC 6901 pointer AJV reported.
 */
export function detectFormatMismatchHints(
  validations: ValidationResult[],
  tool: string,
  data?: unknown
): FormatMismatchHint[] {
  const hints: FormatMismatchHint[] = [];
  for (const v of validations) {
    if (v.check !== 'response_schema') continue;
    if (!v.passed) continue; // strict_only_failure only — lenient must have passed
    if (!v.strict || v.strict.valid) continue; // no AJV failure to report
    for (const issue of v.strict.issues ?? []) {
      if (issue.keyword !== 'format') continue;
      const instance_path = issue.instance_path;
      // Fallback to '(unknown)' rather than issue.keyword ('format') — the keyword
      // filter already guarantees keyword === 'format', so using it as a fallback
      // produces the confusing message `must match format "format"`.
      const expected_format = extractFormatName(issue.message) ?? '(unknown)';
      const observed_value = extractObservedValue(data, instance_path);
      hints.push({
        kind: 'format_mismatch',
        message: buildMessage(tool, instance_path, expected_format, observed_value),
        tool,
        instance_path,
        expected_format,
        ...(observed_value !== undefined && { observed_value }),
      });
    }
  }
  return hints;
}

/**
 * Parse the format name from an AJV format-keyword message.
 * AJV's stable template: `must match format "<name>"`.
 * Falls back to undefined when the message doesn't match (AJV version skew
 * or a custom format validator with non-standard message).
 */
function extractFormatName(message: string): string | undefined {
  return FORMAT_KEYWORD_RE.exec(message)?.[1];
}

/**
 * Convert an RFC 6901 JSON Pointer to the dot-bracket notation `resolvePath`
 * speaks. `/packages/0/start_date` → `packages[0].start_date`.
 * Applies RFC 6901 escape decoding (`~1` → `/`, `~0` → `~`).
 */
function pointerToDotPath(pointer: string): string {
  if (!pointer.startsWith('/')) return pointer;
  return pointer
    .slice(1)
    .split('/')
    .map(seg => seg.replace(/~1/g, '/').replace(/~0/g, '~')) // RFC 6901 §3: decode ~1 before ~0
    .map(seg => (/^\d+$/.test(seg) ? `[${seg}]` : seg))
    .join('.')
    .replace(/\.\[/g, '[');
}

/**
 * Resolve the value at `pointer` inside `data` and return it if it is a
 * string within the length cap. Non-string values (objects, arrays, numbers)
 * are not echoed — binary blobs and structured payloads would inflate the hint
 * and risk leaking sensitive nested data. Truncates long strings at 200 chars
 * using code-point slicing so surrogate pairs aren't cleaved.
 */
function extractObservedValue(data: unknown, pointer: string): string | undefined {
  if (data === undefined || data === null) return undefined;
  const dotPath = pointerToDotPath(pointer);
  const value = resolvePath(data, dotPath);
  if (typeof value !== 'string') return undefined;
  if (value.length <= OBSERVED_VALUE_MAX_LEN) return value;
  return (
    Array.from(value)
      .slice(0, OBSERVED_VALUE_MAX_LEN - 1)
      .join('') + '…'
  );
}

function buildMessage(tool: string, instance_path: string, expected_format: string, observed_value?: string): string {
  const fieldRepr = instance_path || '/';
  const valueClause = observed_value !== undefined ? ` (observed: "${observed_value}")` : '';
  return (
    `\`${tool}\` response: \`${fieldRepr}\` must match format "${expected_format}"${valueClause}. ` +
    `Strict JSON-schema (AJV) rejected this value; lenient Zod validation accepted it.`
  );
}
