/**
 * RFC 8785 JSON Canonicalization Scheme (JCS).
 *
 * Produces a byte-for-byte stable serialization of JSON values so two
 * semantically equivalent payloads hash to the same value across serializers,
 * languages, and whitespace choices. Used by the idempotency layer to compare
 * request payloads for equivalence without being fooled by key ordering,
 * whitespace, or number formatting.
 *
 * Spec: https://www.rfc-editor.org/rfc/rfc8785
 */

import { createHash } from 'crypto';

/**
 * Canonicalize a JSON-serializable value per RFC 8785.
 *
 * - Object keys sorted by UTF-16 code units
 * - Numbers serialized per ECMAScript 7.1.12.1 (Number::toString)
 * - Strings escaped per RFC 8785 §3.2.2.2
 * - No insignificant whitespace
 *
 * Throws if the value contains unsupported types (functions, undefined, symbols).
 */
export function canonicalize(value: unknown): string {
  return serialize(value);
}

/**
 * SHA-256 hash of the JCS-canonicalized form, as lowercase hex.
 *
 * This is the canonical "did these two requests mean the same thing" comparison
 * for idempotency.
 */
export function canonicalJsonSha256(value: unknown): string {
  return createHash('sha256').update(canonicalize(value)).digest('hex');
}

function serialize(value: unknown): string {
  if (value === null) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';

  const t = typeof value;

  if (t === 'number') return serializeNumber(value as number);
  if (t === 'string') return serializeString(value as string);
  if (t === 'bigint') {
    throw new TypeError('JCS does not support BigInt values');
  }
  if (t === 'undefined') {
    throw new TypeError('JCS does not support undefined values');
  }
  if (t === 'function' || t === 'symbol') {
    throw new TypeError(`JCS does not support ${t} values`);
  }

  if (Array.isArray(value)) return serializeArray(value);
  if (t === 'object') {
    // JSON canonicalization is defined over plain objects. Exotic
    // objects (Map, Set, Date, Buffer, class instances) silently
    // serialize as `{}` via Object.keys, which is a nasty data-loss
    // footgun — throw loudly instead.
    const proto = Object.getPrototypeOf(value);
    if (proto !== null && proto !== Object.prototype) {
      const ctorName = (value as { constructor?: { name?: string } })?.constructor?.name ?? 'object';
      throw new TypeError(
        `JCS: only plain objects are supported; got ${ctorName}. Convert to a plain object (e.g., Object.fromEntries for Map, toISOString for Date) before hashing.`
      );
    }
    return serializeObject(value as Record<string, unknown>);
  }

  throw new TypeError(`JCS: unsupported value type ${t}`);
}

function serializeArray(arr: unknown[]): string {
  const parts: string[] = [];
  for (const item of arr) {
    parts.push(serialize(item === undefined ? null : item));
  }
  return '[' + parts.join(',') + ']';
}

function serializeObject(obj: Record<string, unknown>): string {
  const keys = Object.keys(obj).filter(k => obj[k] !== undefined);
  keys.sort(compareUtf16);

  const parts: string[] = [];
  for (const key of keys) {
    parts.push(serializeString(key) + ':' + serialize(obj[key]));
  }
  return '{' + parts.join(',') + '}';
}

/**
 * Compare two strings by UTF-16 code unit (per RFC 8785 §3.2.3).
 * V8's default Array.sort() already compares by code unit, but making this
 * explicit guards against future locale-sensitive comparators.
 */
function compareUtf16(a: string, b: string): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ca = a.charCodeAt(i);
    const cb = b.charCodeAt(i);
    if (ca !== cb) return ca - cb;
  }
  return a.length - b.length;
}

/**
 * Serialize a number per ECMAScript Number::toString (RFC 8785 §3.2.2.3).
 *
 * JavaScript's native String(num) matches Number::toString exactly for all
 * finite numbers, which is what RFC 8785 requires. Non-finite numbers are
 * not valid JSON and throw.
 */
function serializeNumber(n: number): string {
  if (!Number.isFinite(n)) {
    throw new TypeError(`JCS: non-finite number ${n} is not valid JSON`);
  }
  // JSON.stringify matches Number::toString for finite numbers but also handles
  // the -0 case (renders as "0", which JCS requires).
  return JSON.stringify(n);
}

/**
 * Serialize a string per RFC 8785 §3.2.2.2.
 *
 * Rules:
 * - Wrapped in double quotes
 * - Escape " \ and control chars U+0000..U+001F
 * - Use shortest escape form: \b \t \n \f \r for the common ones, \u00XX for others
 * - Do NOT escape forward slash, non-ASCII chars pass through verbatim
 * - Lone surrogates are preserved (JSON allows them)
 */
function serializeString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code === 0x22) {
      out += '\\"';
    } else if (code === 0x5c) {
      out += '\\\\';
    } else if (code === 0x08) {
      out += '\\b';
    } else if (code === 0x09) {
      out += '\\t';
    } else if (code === 0x0a) {
      out += '\\n';
    } else if (code === 0x0c) {
      out += '\\f';
    } else if (code === 0x0d) {
      out += '\\r';
    } else if (code < 0x20) {
      out += '\\u' + code.toString(16).padStart(4, '0');
    } else {
      out += s[i];
    }
  }
  out += '"';
  return out;
}
