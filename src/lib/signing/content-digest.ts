import { createHash, timingSafeEqual } from 'crypto';
import { parseDictionary } from 'structured-headers';

const SHA256_MEMBER_RE = /(?:^|[,\s])sha-256=:([A-Za-z0-9+/_-]+={0,2}):/;

export function computeContentDigest(body: string | Uint8Array): string {
  const buf = toBuffer(body);
  const hash = createHash('sha256').update(buf).digest('base64');
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
