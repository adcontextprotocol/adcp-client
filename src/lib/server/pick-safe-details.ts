/**
 * Security primitive for the `details` field on `AdcpError` and the
 * `Error` wire row. Adopters fronting upstream platforms (GAM, Snap,
 * retail-media APIs, internal billing systems) often want to surface
 * upstream error context to buyers — but raw upstream errors carry
 * credentials, PII, internal stack traces, request IDs that leak
 * tenant identity, and other liability surfaces that MUST NOT cross
 * the wire boundary.
 *
 * `pickSafeDetails(input, allowlist, opts?)` is an explicit-allowlist
 * sanitizer: only keys in the allowlist survive, with optional caps
 * on depth and serialized size. Returns `undefined` when the input is
 * not a plain object or the allowlist filter produces an empty
 * result, so callers can spread the return into an optional `details`
 * field without polluting it with `{}`.
 *
 * Adopters should call this BEFORE constructing the `AdcpError` /
 * wire `Error` row. The framework's `normalizeError` does NOT
 * sanitize details — it shallow-copies whatever was passed.
 *
 * @example
 * ```ts
 * import { pickSafeDetails } from '@adcp/client/server';
 *
 * try {
 *   await gamClient.createOrder(req);
 * } catch (upstreamErr) {
 *   throw new AdcpError('UPSTREAM_REJECTED', {
 *     recovery: 'transient',
 *     message: 'Ad server rejected the order',
 *     // Allowlist: only safe upstream fields cross the wire
 *     details: pickSafeDetails(upstreamErr, [
 *       'http_status',
 *       'request_id',
 *       'gam_error_code',
 *     ]),
 *   });
 * }
 * ```
 *
 * @public
 */

export interface PickSafeDetailsOptions {
  /**
   * Maximum nesting depth retained in the result. `undefined` keeps
   * the input unchanged at any depth; values like `2` keep top-level
   * + one nested level. Strings, numbers, booleans, and null are
   * leaves; arrays and plain objects count as a level.
   *
   * Default: `2` — top-level + one nested level. Caps cardinality
   * blast radius from accidentally-recursive upstream error objects.
   */
  maxDepth?: number;

  /**
   * Maximum serialized JSON byte size of the result (best-effort
   * UTF-8 estimate via `JSON.stringify().length`). When the projected
   * result exceeds this, returns `undefined` rather than truncating —
   * adopters should choose a tighter allowlist if they hit the cap.
   *
   * Default: `2048` bytes. Wire envelopes shouldn't carry kilobytes
   * of details; if you need that, ship via `publishStatusChange` or
   * `task_registry.progress`.
   */
  maxSizeBytes?: number;
}

const DEFAULT_OPTIONS: Required<PickSafeDetailsOptions> = {
  maxDepth: 2,
  maxSizeBytes: 2048,
};

/**
 * Filter `input` to keys named in `allowlist`, depth-capped and
 * size-capped. Returns `undefined` when the result is empty or
 * exceeds the size cap so callers can spread the value into an
 * optional `details` field without polluting it.
 *
 * Properties NOT in the allowlist are dropped silently (no warning;
 * the design assumes the allowlist is the contract). Nested objects
 * are recursively filtered with the SAME allowlist — there is no
 * per-key allowlist for nested fields. Adopters who need per-level
 * filtering should call `pickSafeDetails` recursively on each
 * nested value.
 *
 * Common-sense behaviors:
 *   - `null` / `undefined` / non-object input → `undefined`
 *   - Empty result after filtering → `undefined`
 *   - Arrays at the top level → `undefined` (use a wrapping object)
 *   - Functions and Symbols are dropped
 *   - Date / RegExp / Error / Map / Set are dropped (use a string
 *     allowlist of primitive fields, or pre-shape the input)
 *
 * @public
 */
export function pickSafeDetails(
  input: unknown,
  allowlist: readonly string[],
  opts?: PickSafeDetailsOptions
): Record<string, unknown> | undefined {
  if (!isPlainObject(input)) return undefined;
  if (allowlist.length === 0) return undefined;

  const maxDepth = opts?.maxDepth ?? DEFAULT_OPTIONS.maxDepth;
  const maxSize = opts?.maxSizeBytes ?? DEFAULT_OPTIONS.maxSizeBytes;
  const allowSet = new Set(allowlist);

  const result = filterByAllowlist(input, allowSet, maxDepth);
  if (result == null || Object.keys(result).length === 0) return undefined;

  // Size cap. Use JSON.stringify length as a UTF-8-ish proxy.
  // Adopters who need exact byte counting should sanitize ahead of
  // pickSafeDetails.
  let serialized: string;
  try {
    serialized = JSON.stringify(result);
  } catch {
    // Circular reference snuck through (shouldn't happen for plain
    // objects but defensive). Return undefined rather than half-data.
    return undefined;
  }
  if (serialized.length > maxSize) return undefined;

  return result;
}

function filterByAllowlist(
  obj: Record<string, unknown>,
  allow: ReadonlySet<string>,
  remainingDepth: number
): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    if (!allow.has(key)) continue;
    const value = obj[key];
    const safe = sanitizeValue(value, allow, remainingDepth - 1);
    // Drop undefined results so the caller sees only present keys.
    if (safe !== undefined) out[key] = safe;
  }
  return Object.keys(out).length === 0 ? null : out;
}

function sanitizeValue(
  value: unknown,
  allow: ReadonlySet<string>,
  remainingDepth: number
): unknown {
  // Primitives pass through.
  if (value === null) return null;
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') return value;
  if (t === 'function' || t === 'symbol' || t === 'undefined' || t === 'bigint') return undefined;

  if (Array.isArray(value)) {
    // Arrays don't count as a depth level — only plain objects do.
    // Pass items through with the SAME remainingDepth so an array-of-
    // objects gets the same nesting budget as a bare object would.
    const mapped = value.map(v => sanitizeValue(v, allow, remainingDepth));
    return mapped.filter(v => v !== undefined);
  }

  if (isPlainObject(value)) {
    if (remainingDepth <= 0) return undefined;
    const filtered = filterByAllowlist(value, allow, remainingDepth);
    return filtered ?? undefined;
  }

  // Date / RegExp / Map / Set / Error / class instances — drop.
  // Adopters who need these should pre-shape into primitives.
  return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  // Only plain objects (not Date, RegExp, Map, Set, class instances).
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
