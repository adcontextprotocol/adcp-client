/**
 * Shared JSON path utilities for storyboard context and validations.
 *
 * Parses dot-notation paths with array indexing (e.g., "accounts[0].account_id")
 * into segment arrays, and resolves/sets values at those paths.
 */

/**
 * Convert a dot-path with array indexing to an RFC 6901 JSON Pointer.
 *
 *   "adcp.idempotency"        → "/adcp/idempotency"
 *   "accounts[0].account_id"  → "/accounts/0/account_id"
 *   "a/b~c"                   → "/a~1b~0c"  (escaped per RFC 6901)
 */
export function toJsonPointer(path: string): string {
  const segments = parsePath(path);
  if (segments.length === 0) return '';
  return '/' + segments.map(s => String(s).replace(/~/g, '~0').replace(/\//g, '~1')).join('/');
}

/**
 * Parse a path string into segments.
 * "accounts[0].account_id" → ["accounts", 0, "account_id"]
 */
export function parsePath(path: string): Array<string | number> {
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
      if (typeof current !== 'object') return undefined;
      current = (current as Record<string, unknown>)[segment];
    }
  }

  return current;
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
