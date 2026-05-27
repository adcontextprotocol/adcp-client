/**
 * Shared JSON path utilities for storyboard context and validations.
 *
 * Parses dot-notation paths with array indexing (e.g., "accounts[0].account_id")
 * into segment arrays, and resolves/sets values at those paths.
 */

/**
 * Wildcard marker produced by `parsePathWithWildcards` for `[*]` segments.
 * The plain `parsePath` tokenizer does not emit it — callers that need
 * wildcard semantics (`resolvePathAll`) use the wildcard-aware parser.
 */
export const WILDCARD = Symbol('path.wildcard');

/**
 * Upper bound on the number of terminal values `resolvePathAll` will emit.
 * Guards the runner against OOM when a wildcard-heavy path (`a[*].b[*].c[*]…`)
 * is applied to a malicious agent response shaped to maximize fan-out.
 * The cap is well above any realistic storyboard use (a 1000-product
 * catalog × 10 formats = 10k terminal values).
 */
export const RESOLVE_PATH_ALL_MAX = 10_000;

/**
 * Upper bound on storyboard path-string length. The parser is linear in
 * input size, but a hostile storyboard can still spend CPU against a
 * megabyte-long path with no legitimate use case.
 */
const MAX_PATH_LENGTH = 1024;

/**
 * Parse a path string into segments.
 * "accounts[0].account_id" → ["accounts", 0, "account_id"]
 *
 * Returns an empty segment list for paths that exceed `MAX_PATH_LENGTH`
 * so downstream resolvers degrade to "nothing at this path" instead of
 * burning CPU on a pathological input.
 */
export function parsePath(path: string): Array<string | number> {
  if (path.length > MAX_PATH_LENGTH) return [];
  const segments: Array<string | number> = [];
  const re = /([^.\[\]]+)|\[(\d+)\]/g;
  let match: RegExpExecArray | null;

  while ((match = re.exec(path)) !== null) {
    if (match[2] !== undefined) {
      segments.push(parseInt(match[2], 10));
    } else if (match[1] !== undefined) {
      segments.push(match[1]);
    }
  }

  return segments;
}

/**
 * Parse a path string into segments, preserving `[*]` wildcards.
 * "products[*].format_ids[*]" → ["products", WILDCARD, "format_ids", WILDCARD]
 */
export function parsePathWithWildcards(path: string): Array<string | number | typeof WILDCARD> {
  if (path.length > MAX_PATH_LENGTH) return [];
  const segments: Array<string | number | typeof WILDCARD> = [];
  const re = /([^.\[\]]+)|\[(\d+)\]|\[(\*)\]/g;
  let match: RegExpExecArray | null;

  while ((match = re.exec(path)) !== null) {
    if (match[3] !== undefined) {
      segments.push(WILDCARD);
    } else if (match[2] !== undefined) {
      segments.push(parseInt(match[2], 10));
    } else if (match[1] !== undefined) {
      segments.push(match[1]);
    }
  }

  return segments;
}

/**
 * Resolve a dot-path with array indexing against an object.
 *
 * Examples:
 *   "accounts[0].account_id" → obj.accounts[0].account_id
 *   "formats[0].format_id.id" → obj.formats[0].format_id.id
 *   "status" → obj.status
 */
export function resolvePath(obj: unknown, path: string): unknown {
  if (obj === null || obj === undefined) return undefined;

  const segments = parsePath(path);
  let current: unknown = obj;

  for (const segment of segments) {
    if (current === null || current === undefined) return undefined;

    if (typeof segment === 'number') {
      if (!Array.isArray(current)) return undefined;
      current = current[segment];
    } else {
      if (FORBIDDEN_KEYS.has(segment)) return undefined;
      if (typeof current !== 'object') return undefined;
      // Own-property gate keeps `Object.prototype` accessors (`toString`,
      // `hasOwnProperty`, …) from surfacing into compliance reports as
      // "agent returned X." Matches `resolvePathAll` / `setPath`.
      if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
      current = (current as Record<string, unknown>)[segment];
    }
  }

  return current;
}

/**
 * Resolve a wildcard-aware path and return every terminal value as a flat
 * array. `[*]` segments fan out over arrays; undefined intermediates
 * short-circuit the current branch without throwing. `null`, `false`, `0`,
 * and `""` terminals are preserved — only `undefined` means "no value at
 * this path." This matches `resolvePath`'s scalar contract.
 *
 * Output is capped at `RESOLVE_PATH_ALL_MAX` terminal values. When the cap
 * is hit the walker stops and returns what it has; callers that need to
 * know whether truncation happened should compare the length to the cap.
 *
 * Examples:
 *   "products[*].format_ids[*]" on `{products:[{format_ids:[a,b]},{format_ids:[c]}]}` → [a, b, c]
 *   "formats[*].format_id" on `{formats:[{format_id:x},{format_id:y}]}` → [x, y]
 *   "status" (no wildcard) → [obj.status] if defined, else []
 */
export function resolvePathAll(obj: unknown, path: string): unknown[] {
  if (obj === undefined) return [];
  const segments = parsePathWithWildcards(path);
  const results: unknown[] = [];
  walk(obj, segments, 0, results);
  return results;
}

const PORTABLE_IDENTIFIER_SEGMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\[\*\])?$/;
const RESERVED_IDENTIFIER_ROOTS = new Set(['request', 'response', 'context']);

export interface PortableIdentifierPathIssue {
  path: string;
  reason: string;
}

/**
 * Validate the portable `upstream_traffic.identifier_paths` grammar.
 *
 * These paths are intentionally narrower than the general storyboard path
 * helpers: request-payload-relative dotted keys, with at most one `[*]`
 * wildcard suffix per segment. They are exchanged across independent
 * storyboard runners, so permissive JSONPath conveniences would create
 * non-portable grading.
 */
export function validatePortableIdentifierPath(path: string): string | null {
  if (typeof path !== 'string' || path.length === 0) return 'must be a non-empty string';
  if (path.length > MAX_PATH_LENGTH) return `must be ${MAX_PATH_LENGTH} characters or fewer`;
  if (path.startsWith('$')) return 'must be request-payload-relative; explicit roots like "$.foo" are not allowed';
  if (path.startsWith('.') || path.endsWith('.') || path.includes('..')) {
    return 'must not contain empty segments or recursive descent';
  }

  const segments = path.split('.');
  const first = segments[0]!;
  const firstKey = first.endsWith('[*]') ? first.slice(0, -3) : first;
  if (RESERVED_IDENTIFIER_ROOTS.has(firstKey)) {
    return `must not use reserved root "${firstKey}"`;
  }

  for (const segment of segments) {
    if (segment.includes('["') || segment.includes("['")) return 'must not use bracket-quoted keys';
    if (/\[\d+\]/.test(segment)) return 'must not use numeric array indexes';
    if (!PORTABLE_IDENTIFIER_SEGMENT_RE.test(segment)) {
      return `segment "${segment}" must be an identifier key optionally followed by [*]`;
    }
    const key = segment.endsWith('[*]') ? segment.slice(0, -3) : segment;
    if (FORBIDDEN_KEYS.has(key)) return `must not use forbidden key "${key}"`;
  }

  return null;
}

/**
 * Resolve a path that has already been restricted to the portable
 * `identifier_paths` grammar. Invalid paths return no values; callers that
 * need author-facing diagnostics should call `validatePortableIdentifierPath`
 * first and surface the reason.
 */
export function resolvePortableIdentifierPathAll(obj: unknown, path: string): unknown[] {
  if (obj === undefined || validatePortableIdentifierPath(path) !== null) return [];
  const segments = path.split('.').map(segment => ({
    key: segment.endsWith('[*]') ? segment.slice(0, -3) : segment,
    wildcard: segment.endsWith('[*]'),
  }));

  let frontier: unknown[] = [obj];
  for (const segment of segments) {
    const next: unknown[] = [];
    for (const current of frontier) {
      if (next.length >= RESOLVE_PATH_ALL_MAX) break;
      if (current === undefined || current === null || typeof current !== 'object') continue;
      if (FORBIDDEN_KEYS.has(segment.key)) continue;
      if (!Object.prototype.hasOwnProperty.call(current, segment.key)) continue;
      const value = (current as Record<string, unknown>)[segment.key];
      if (segment.wildcard) {
        if (Array.isArray(value)) {
          for (const item of value) {
            if (next.length >= RESOLVE_PATH_ALL_MAX) break;
            next.push(item);
          }
        }
      } else {
        next.push(value);
      }
    }
    frontier = next.slice(0, RESOLVE_PATH_ALL_MAX).filter(value => value !== undefined);
  }

  return frontier;
}

function walk(current: unknown, segments: Array<string | number | typeof WILDCARD>, i: number, out: unknown[]): void {
  if (out.length >= RESOLVE_PATH_ALL_MAX) return;
  if (i === segments.length) {
    if (current !== undefined) out.push(current);
    return;
  }
  if (current === undefined || current === null) return;
  const segment = segments[i]!;
  if (segment === WILDCARD) {
    if (!Array.isArray(current)) return;
    for (const item of current) {
      if (out.length >= RESOLVE_PATH_ALL_MAX) return;
      walk(item, segments, i + 1, out);
    }
    return;
  }
  if (typeof segment === 'number') {
    if (!Array.isArray(current)) return;
    walk(current[segment], segments, i + 1, out);
    return;
  }
  if (FORBIDDEN_KEYS.has(segment)) return;
  if (typeof current !== 'object') return;
  // Gate on own properties so attackers can't surface Object.prototype state
  // even when a key slips past FORBIDDEN_KEYS (defense-in-depth; FORBIDDEN_KEYS
  // already catches `__proto__`/`constructor`/`prototype` by name).
  if (!Object.prototype.hasOwnProperty.call(current, segment)) return;
  walk((current as Record<string, unknown>)[segment], segments, i + 1, out);
}

/**
 * Convert a dot/bracket path (`accounts[0].account_id`) into an RFC 6901
 * JSON Pointer (`/accounts/0/account_id`). Returns `""` for the empty path
 * (the root per RFC 6901). Per RFC 6901 §3, `~` is escaped as `~0` and `/`
 * as `~1`.
 */
export function toJsonPointer(path: string): string {
  const segments = parsePath(path);
  if (segments.length === 0) return '';
  return (
    '/' +
    segments
      .map(seg => (typeof seg === 'number' ? String(seg) : String(seg).replace(/~/g, '~0').replace(/\//g, '~1')))
      .join('/')
  );
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Set a value at a dot-path with array indexing.
 * Creates intermediate objects/arrays as needed.
 * Guards against prototype pollution.
 *
 * "media_buy_ids[0]" → obj.media_buy_ids[0] = value
 */
export function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const segments = parsePath(path);
  let current: unknown = obj;

  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i]!;
    const nextSegment = segments[i + 1];

    if (typeof segment === 'number') {
      if (!Array.isArray(current)) return;
      if (current[segment] === undefined || current[segment] === null) {
        current[segment] = typeof nextSegment === 'number' ? [] : {};
      }
      current = current[segment];
    } else {
      if (FORBIDDEN_KEYS.has(segment)) return;
      if (!isPlainObject(current)) return;
      if (!Object.prototype.hasOwnProperty.call(current, segment) || current[segment] == null) {
        Object.defineProperty(current, segment, {
          value: typeof nextSegment === 'number' ? [] : {},
          writable: true,
          enumerable: true,
          configurable: true,
        });
      }
      current = current[segment];
    }
  }

  const lastSegment = segments[segments.length - 1];
  if (lastSegment === undefined) return;

  if (typeof lastSegment === 'number') {
    if (Array.isArray(current)) {
      current[lastSegment] = value;
    }
  } else {
    if (FORBIDDEN_KEYS.has(lastSegment)) return;
    if (!isPlainObject(current)) return;
    Object.defineProperty(current, lastSegment, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
}
