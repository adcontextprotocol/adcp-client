/**
 * RFC 3986 percent-encoding primitives shared by the observer (verifier)
 * and encoder (producer) modules. One implementation, one bug-fix path.
 *
 * - `encodeUnreserved` implements the §2.1/§2.3 unreserved-whitelist rule
 *   used by catalog-item macro substitution (#2620): only ALPHA / DIGIT
 *   / "-" / "." / "_" / "~" remain unescaped, non-ASCII is percent-encoded
 *   after UTF-8 (§2.5), hex digits are uppercase (§2.1).
 *
 * - `equalUnderHexCasePolicy` implements the verifier-side comparison:
 *   byte-for-byte equality, but the two hex digits inside a `%NN` triplet
 *   compare case-insensitively so a producer emitting `%c3%a9` is not
 *   falsely flagged when the fixture says `%C3%A9`. Bytes outside triplets
 *   compare case-sensitively.
 *
 * - `isUnreservedOnly` is the stricter check behind
 *   `rfc3986_unreserved_only_at_macro_position`: every byte in the input
 *   is either an unreserved character or a valid `%NN` triplet.
 */

const UPPER_HEX = '0123456789ABCDEF';

/**
 * True iff the byte is RFC 3986 §2.3 `unreserved`:
 * `ALPHA / DIGIT / "-" / "." / "_" / "~"`.
 */
function isUnreservedByte(b: number): boolean {
  return (
    (b >= 0x41 && b <= 0x5a) || // A-Z
    (b >= 0x61 && b <= 0x7a) || // a-z
    (b >= 0x30 && b <= 0x39) || // 0-9
    b === 0x2d || // -
    b === 0x2e || // .
    b === 0x5f || // _
    b === 0x7e //   ~
  );
}

/**
 * Percent-encode `raw` for a URL-value context per the catalog-item macro
 * substitution rule. Only unreserved characters pass through; everything
 * else (including sub-delims `(`, `)`, `&`, `=`, reserved chars, CRLF,
 * AdCP macro braces, bidi overrides, non-ASCII) is UTF-8 encoded then
 * percent-encoded with uppercase hex digits.
 */
export function encodeUnreserved(raw: string): string {
  const bytes = new TextEncoder().encode(raw);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] as number;
    if (isUnreservedByte(b)) {
      out += String.fromCharCode(b);
    } else {
      out += '%' + UPPER_HEX[(b >> 4) & 0xf] + UPPER_HEX[b & 0xf];
    }
  }
  return out;
}

/**
 * Compare two encoded strings under the contract's hex-case policy:
 * producers SHOULD emit uppercase hex (§2.1), but verifiers MUST accept
 * either case within a `%NN` triplet. Bytes outside triplets compare
 * case-sensitively — an attacker-controlled value differing by a letter
 * case outside a triplet is a real divergence, not a hex-case variant.
 */
export function equalUnderHexCasePolicy(observed: string, expected: string): boolean {
  if (observed.length !== expected.length) return false;
  for (let i = 0; i < observed.length; i++) {
    const o = observed[i];
    const e = expected[i];
    if (o === '%' && e === '%' && i + 2 < observed.length) {
      const oh = observed.slice(i + 1, i + 3);
      const eh = expected.slice(i + 1, i + 3);
      if (!isHex(oh) || !isHex(eh)) return false;
      if (oh.toUpperCase() !== eh.toUpperCase()) return false;
      i += 2;
      continue;
    }
    if (o !== e) return false;
  }
  return true;
}

/**
 * True iff every byte in `encoded` is either an unreserved character
 * (passes through unchanged) or a well-formed `%NN` triplet. Stricter
 * than `equalUnderHexCasePolicy` — catches producers that use a
 * reserved-char allowlist (e.g., `encodeURI`) rather than the
 * unreserved-whitelist the #2620 rule requires.
 */
export function isUnreservedOnly(encoded: string): boolean {
  for (let i = 0; i < encoded.length; i++) {
    const c = encoded.charCodeAt(i);
    if (c > 0x7f) return false; // non-ASCII byte => not encoded
    if (isUnreservedByte(c)) continue;
    if (encoded[i] === '%' && i + 2 < encoded.length && isHex(encoded.slice(i + 1, i + 3))) {
      i += 2;
      continue;
    }
    return false;
  }
  return true;
}

/**
 * Find the first byte offset where `observed` and `expected` diverge
 * under the hex-case policy, or `-1` if they match. Offsets are in
 * characters of the encoded string (not decoded bytes), suitable for
 * error reports that need to point at the offending percent-triplet.
 */
export function divergenceOffset(observed: string, expected: string): number {
  const min = Math.min(observed.length, expected.length);
  for (let i = 0; i < min; i++) {
    const o = observed[i];
    const e = expected[i];
    if (o === '%' && e === '%' && i + 2 < observed.length && i + 2 < expected.length) {
      const oh = observed.slice(i + 1, i + 3);
      const eh = expected.slice(i + 1, i + 3);
      if (!isHex(oh) || !isHex(eh) || oh.toUpperCase() !== eh.toUpperCase()) return i;
      i += 2;
      continue;
    }
    if (o !== e) return i;
  }
  return observed.length === expected.length ? -1 : min;
}

function isHex(s: string): boolean {
  return /^[0-9A-Fa-f]{2}$/.test(s);
}
