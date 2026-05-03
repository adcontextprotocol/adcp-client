/**
 * Strict JSON parser for the brand_json_url discovery chain. Two hardening
 * passes the spec mandates that the platform `JSON.parse` does not provide:
 *
 *   1. **Duplicate-key rejection.** `JSON.parse('{"a":1,"a":2}')` silently
 *      keeps the last value. The brand_json_url verifier algorithm
 *      (security.mdx step 4) requires duplicate-key detection because the
 *      same trust-root document MUST NOT parse to two different shapes
 *      across verifiers — that is the parser-differential vector that
 *      step 14 of the verifier checklist closes on the request body, and
 *      the same closure applies on the brand.json bootstrap fetch.
 *
 *   2. **Prototype-pollution rejection.** Backed by `secure-json-parse` —
 *      `__proto__` and `constructor` keys raise rather than mutating the
 *      prototype chain.
 *
 * Body cap is enforced by the caller (the SSRF fetch wrapper). This module
 * works against an already-bounded UTF-8 string. Errors are typed so the
 * resolver can surface `request_signature_brand_json_malformed` directly.
 */

import sjp from 'secure-json-parse';

export type StrictJsonErrorCode = 'invalid_json' | 'duplicate_key' | 'forbidden_prototype_property';

export class StrictJsonError extends Error {
  readonly code: StrictJsonErrorCode;
  readonly detail: { offset?: number; key?: string };
  constructor(code: StrictJsonErrorCode, message: string, detail: { offset?: number; key?: string } = {}) {
    super(message);
    this.name = 'StrictJsonError';
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Parse JSON text under the strict rules above. Returns the parsed value on
 * success; throws `StrictJsonError` on any reject path.
 *
 * Implementation: first scan the source for duplicate keys at any object
 * scope, then hand the source to `secure-json-parse` for prototype-property
 * rejection and the actual structural parse. Two passes is fine for the
 * 256 KiB brand.json budget — both are linear, the constant factor is small,
 * and we never trust the tokenizer to produce the value (it's only a guard).
 */
export function parseStrictJson(text: string): unknown {
  rejectDuplicateKeys(text);
  try {
    return sjp.parse(text, null, { protoAction: 'error', constructorAction: 'error' });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('forbidden prototype property')) {
      throw new StrictJsonError('forbidden_prototype_property', message);
    }
    throw new StrictJsonError('invalid_json', message);
  }
}

/**
 * Walk the source character-by-character and reject when any object scope
 * declares the same key twice. Comments are not legal JSON, so a `//` or
 * `/*` inside a string is fine and outside a string would already be a
 * parse error (caught downstream). This routine only needs to track:
 *   - whether we are inside a string (with escape handling),
 *   - the stack of open object scopes (each owning a `Set<string>`),
 *   - whether the next quoted-string at object scope is the key half of
 *     a key-value pair.
 */
function rejectDuplicateKeys(text: string): void {
  type Scope = { kind: 'object'; keys: Set<string> } | { kind: 'array' };
  const stack: Scope[] = [];
  /** True when at an object scope and the next string token is a key. */
  let expectingKey = false;
  let i = 0;
  const len = text.length;

  while (i < len) {
    const ch = text[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }
    if (ch === '{') {
      stack.push({ kind: 'object', keys: new Set<string>() });
      expectingKey = true;
      i++;
      continue;
    }
    if (ch === '}') {
      stack.pop();
      expectingKey = false;
      i++;
      continue;
    }
    if (ch === '[') {
      stack.push({ kind: 'array' });
      expectingKey = false;
      i++;
      continue;
    }
    if (ch === ']') {
      stack.pop();
      expectingKey = false;
      i++;
      continue;
    }
    if (ch === ',') {
      const top = stack[stack.length - 1];
      expectingKey = top?.kind === 'object';
      i++;
      continue;
    }
    if (ch === ':') {
      expectingKey = false;
      i++;
      continue;
    }
    if (ch === '"') {
      const { value, end } = readString(text, i);
      if (expectingKey) {
        const top = stack[stack.length - 1];
        if (top?.kind === 'object') {
          if (top.keys.has(value)) {
            throw new StrictJsonError('duplicate_key', `Duplicate key "${value}" at offset ${i}`, {
              offset: i,
              key: value,
            });
          }
          top.keys.add(value);
        }
      }
      i = end;
      continue;
    }
    // Any other character is part of a primitive (number, true/false/null);
    // skip until we hit whitespace, structural punctuation, or end of input.
    while (i < len) {
      const c = text[i]!;
      if (c === ',' || c === '}' || c === ']' || c === ' ' || c === '\t' || c === '\n' || c === '\r') break;
      i++;
    }
  }
}

function readString(text: string, start: number): { value: string; end: number } {
  // text[start] is the opening quote.
  let i = start + 1;
  let out = '';
  const len = text.length;
  while (i < len) {
    const ch = text[i]!;
    if (ch === '"') {
      return { value: out, end: i + 1 };
    }
    // RFC 8259 §7: unescaped control characters (U+0000–U+001F) are forbidden
    // inside JSON strings. The platform `JSON.parse` would reject them; the
    // tokenizer must reject them too so its accepted dialect tracks JSON's
    // (otherwise an attacker who can inject a literal control char into a
    // brand.json key smuggles a key that the tokenizer dedupes but the
    // parser rejects, decoupling our two passes).
    if (ch.charCodeAt(0) < 0x20) {
      throw new StrictJsonError('invalid_json', `Unescaped control character at offset ${i} (RFC 8259 §7)`, {
        offset: i,
      });
    }
    if (ch === '\\') {
      const next = text[i + 1];
      if (next === undefined) {
        throw new StrictJsonError('invalid_json', `Unterminated escape at offset ${i}`, { offset: i });
      }
      if (next === '"' || next === '\\' || next === '/') {
        out += next;
        i += 2;
        continue;
      }
      if (next === 'b') {
        out += '\b';
        i += 2;
        continue;
      }
      if (next === 'f') {
        out += '\f';
        i += 2;
        continue;
      }
      if (next === 'n') {
        out += '\n';
        i += 2;
        continue;
      }
      if (next === 'r') {
        out += '\r';
        i += 2;
        continue;
      }
      if (next === 't') {
        out += '\t';
        i += 2;
        continue;
      }
      if (next === 'u') {
        const hex = text.slice(i + 2, i + 6);
        if (hex.length !== 4 || /[^0-9a-fA-F]/.test(hex)) {
          throw new StrictJsonError('invalid_json', `Invalid unicode escape at offset ${i}`, { offset: i });
        }
        out += String.fromCharCode(parseInt(hex, 16));
        i += 6;
        continue;
      }
      throw new StrictJsonError('invalid_json', `Invalid escape \\${next} at offset ${i}`, { offset: i });
    }
    out += ch;
    i++;
  }
  throw new StrictJsonError('invalid_json', `Unterminated string starting at offset ${start}`, { offset: start });
}
