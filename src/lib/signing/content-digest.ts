import { createHash, timingSafeEqual } from 'crypto';
import { parseDictionary } from 'structured-headers';

const SHA256_MEMBER_RE = /(?:^|[,\s])sha-256=:([A-Za-z0-9+/_-]+={0,2}):/;

export type SfBinaryEncoding = 'rfc8941-base64' | 'legacy-base64url';

/** Select the request-signing binary profile from a trusted endpoint pin. */
export function requestSigningEncodingForVersion(adcpVersion: string): SfBinaryEncoding {
  const normalized = adcpVersion.trim().replace(/^v/, '');
  return /^(?:2(?:\.|$)|3\.(?:0|1)(?:\.|-|$)|3$)/.test(normalized) ? 'legacy-base64url' : 'rfc8941-base64';
}

export function computeContentDigest(body: string | Uint8Array, encoding: SfBinaryEncoding = 'rfc8941-base64'): string {
  const buf = toBuffer(body);
  const hash = createHash('sha256')
    .update(buf)
    .digest(encoding === 'legacy-base64url' ? 'base64url' : 'base64');
  return `sha-256=:${hash}:`;
}

/**
 * Extract the `sha-256` member from an RFC 9530 Content-Digest header. The
 * header is an RFC 8941 Dictionary and MAY list multiple algorithms; we look
 * up the `sha-256` member without requiring any particular position.
 */
export function parseContentDigest(header: string): Buffer | null {
  try {
    const dict = parseDictionary(header);
    const entry = dict.get('sha-256');
    if (entry && entry[0] instanceof ArrayBuffer) return Buffer.from(entry[0]);
  } catch {
    // Fall through: a malformed filler member (e.g. truncated sha-512) should
    // not mask the sha-256 entry we actually verify against.
  }
  const m = header.match(SHA256_MEMBER_RE);
  return m && m[1] ? Buffer.from(m[1], 'base64') : null;
}

export function contentDigestUsesEncoding(header: string, encoding: SfBinaryEncoding): boolean {
  const match = header.match(/(?:^|[,\s])sha-256=:([^:]+):/);
  if (!match?.[1]) return false;
  const encoded = match[1];
  if (encoding === 'legacy-base64url') return /^[A-Za-z0-9_-]+$/.test(encoded);
  return encoded.length % 4 === 0 && /^[A-Za-z0-9+/]+={1,2}$/.test(encoded);
}

export function contentDigestMatches(header: string, body: string | Uint8Array): boolean {
  const expected = parseContentDigest(header);
  if (!expected) return false;
  const buf = toBuffer(body);
  const actual = createHash('sha256').update(buf).digest();
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

function toBuffer(body: string | Uint8Array): Buffer {
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
}
