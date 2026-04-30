/**
 * Wire-shape normalizer for the AdCP `Error` row used in tool responses
 * carrying per-row failures (`sync_creatives`, `sync_audiences`,
 * `sync_accounts`, `report_usage`, `acquire_rights` error arm).
 *
 * Adopters return errors in whichever shape their codebase already
 * speaks: bare strings, native `Error` instances, plain
 * `{ code, message }` objects, `AdcpError` instances thrown internally,
 * upstream-platform error objects with vendor-specific fields. This
 * helper coerces all of those into the canonical wire `Error` shape
 * (`code`, `message`, optional `field` / `suggestion` / `retry_after`
 * / `details` / `recovery`) so the framework's response validator
 * accepts the projected response without forcing every adopter to
 * hand-shape the wire envelope.
 *
 * @see AdCP wire spec: `core/error.json`
 *
 * @public
 */

import type { ErrorCode } from './decisioning/async-outcome';

/**
 * Canonical wire `Error` row. Mirrors `core/error.json` —
 * `code` + `message` are required; everything else optional.
 *
 * Differs from the SDK's `AdcpStructuredError` in only one detail —
 * `recovery` is optional here (per the wire spec) but required on
 * `AdcpStructuredError` (the SDK's stricter shape for thrown errors).
 *
 * @public
 */
export interface NormalizedError {
  code: string;
  message: string;
  field?: string;
  suggestion?: string;
  retry_after?: number;
  details?: Record<string, unknown>;
  recovery?: 'transient' | 'correctable' | 'terminal';
}

/**
 * Coerce a single adopter-returned error value into the canonical
 * wire `Error` shape. Handles:
 *
 *   - `string` → `{ code: 'GENERIC_ERROR', message: <input>, recovery: 'terminal' }`
 *   - `Error` instance → `{ code: 'GENERIC_ERROR', message: err.message, recovery: 'terminal' }`
 *   - `AdcpError` instance → projected to wire shape using its `code` /
 *     `recovery` / `field` / `suggestion` / `retry_after` / `details`
 *   - Plain object with `code` + `message` → fields whitelisted to the
 *     wire shape; vendor-specific fields dropped (use `details` for
 *     vendor extensions)
 *   - Any other object → `{ code: 'GENERIC_ERROR', message: <safeStringify>, recovery: 'terminal' }`
 *   - `null` / `undefined` → `{ code: 'GENERIC_ERROR', message: 'Unknown error', recovery: 'terminal' }`
 *
 * The `details` field, when present on the input, is shallow-copied
 * and SHOULD be passed through {@link pickSafeDetails} on the
 * adopter side before reaching this helper. `normalizeError` does NOT
 * sanitize `details` — it's the adopter's job to ensure no
 * credentials / PII / stack traces land there.
 *
 * @public
 */
export function normalizeError(input: unknown): NormalizedError {
  if (input == null) {
    return { code: 'GENERIC_ERROR', message: 'Unknown error', recovery: 'terminal' };
  }
  if (typeof input === 'string') {
    return { code: 'GENERIC_ERROR', message: input, recovery: 'terminal' };
  }
  // AdcpError-shaped (has `code`, optional structured fields). Detected
  // structurally rather than via instanceof so framework code in different
  // module realms (test fixtures, server-side renderers) still gets the
  // typed projection.
  if (typeof input === 'object' && 'code' in input) {
    const obj = input as Record<string, unknown>;
    const code = typeof obj.code === 'string' && obj.code.length > 0 ? obj.code : 'GENERIC_ERROR';
    const message = typeof obj.message === 'string' && obj.message.length > 0 ? obj.message : code; // fall back to code when message missing — never empty-string
    const out: NormalizedError = { code, message };
    if (typeof obj.field === 'string') out.field = obj.field;
    if (typeof obj.suggestion === 'string') out.suggestion = obj.suggestion;
    if (typeof obj.retry_after === 'number' && Number.isFinite(obj.retry_after)) {
      // Wire spec clamps retry_after to [1, 3600]
      out.retry_after = Math.max(1, Math.min(3600, Math.floor(obj.retry_after)));
    }
    if (obj.recovery === 'transient' || obj.recovery === 'correctable' || obj.recovery === 'terminal') {
      out.recovery = obj.recovery;
    }
    if (typeof obj.details === 'object' && obj.details !== null) {
      // Shallow copy to break aliasing; adopter is responsible for sanitizing
      // via pickSafeDetails before reaching here.
      out.details = { ...(obj.details as Record<string, unknown>) };
    }
    return out;
  }
  // Native Error (no `code` field, has `message`).
  if (input instanceof Error) {
    return { code: 'GENERIC_ERROR', message: input.message || 'Unknown error', recovery: 'terminal' };
  }
  // Last-resort: stringify whatever was passed.
  return {
    code: 'GENERIC_ERROR',
    message: safeStringify(input),
    recovery: 'terminal',
  };
}

/**
 * Coerce an adopter-returned errors collection into a wire-shaped
 * `Error[]`. Accepts `undefined` / `null` (returns `undefined`),
 * a single error value (wraps in array), or an array of error values
 * (each normalized via {@link normalizeError}).
 *
 * Empty arrays and arrays where every entry normalizes to the same
 * sentinel "Unknown error" are still emitted — the framework lets the
 * wire validator decide whether `errors: []` is acceptable for the
 * specific tool response (sync_creatives accepts empty;
 * sync_creatives_error requires non-empty).
 *
 * Use at the v6 wire-projection seam:
 *
 * ```ts
 * import { normalizeErrors } from '@adcp/client/server';
 *
 * const projected = adopterRows.map(row => ({
 *   ...row,
 *   errors: normalizeErrors(row.errors),
 * }));
 * ```
 *
 * @public
 */
export function normalizeErrors(input: unknown): NormalizedError[] | undefined {
  if (input == null) return undefined;
  if (Array.isArray(input)) {
    return input.map(normalizeError);
  }
  return [normalizeError(input)];
}

/**
 * Coerce an `ErrorCode`-typed input back to the underlying string —
 * useful when adopters pass an enum-narrowed code into a place that
 * expects the wire string. Pure-function alias for clarity at call
 * sites; the runtime is identity.
 *
 * @internal
 */
export function _coerceErrorCode(code: ErrorCode | string): string {
  return code;
}

/** Best-effort `JSON.stringify` that swallows circular-reference errors. */
function safeStringify(input: unknown): string {
  try {
    const s = JSON.stringify(input);
    return typeof s === 'string' ? s : String(input);
  } catch {
    return '[unserializable error]';
  }
}
