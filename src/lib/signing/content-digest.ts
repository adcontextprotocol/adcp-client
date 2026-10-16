import { createHash, timingSafeEqual } from 'crypto';
import { parseDictionary, serializeDictionary } from 'structured-headers';

const SHA256_MEMBER_RE = /(?:^|[,\s])sha-256=:([A-Za-z0-9+/_-]+={0,2}):/;

export type SfBinaryEncoding = 'rfc8941-base64' | 'legacy-base64url';

/** Select the request-signing binary profile from a trusted endpoint pin. */
export function requestSigningEncodingForVersion(adcpVersion: string): SfBinaryEncoding {
  const normalized = adcpVersion.trim().replace(/^v/, '');
  return /^(?:2(?:\.|$)|3\.(?:0|1)(?:\.|-|$)|3$)/.test(normalized) ? 'legacy-base64url' : 'rfc8941-base64';
}

export function computeContentDigest(body: string | Uint8Array, encoding: SfBinaryEncoding = 'rfc8941-base64'): string {
  return serializeByteSequenceMember('sha-256', createHash('sha256').update(toBuffer(body)).digest(), encoding);
}

/**
 * Serialize a one-member Dictionary whose value is a byte sequence, e.g.
 * `sig1=:...:` in `Signature` or `sha-256=:...:` in `Content-Digest`. The
 * RFC 8941 form comes from the structured-field serializer. The AdCP 3.0/3.1
 * profile wrote byte sequences in unpadded Base64URL, which is not an RFC 8941
 * `sf-binary` and no serializer emits, so that legacy form stays hand-written.
 */
export function serializeByteSequenceMember(
  key: string,
  bytes: Uint8Array | ArrayBuffer,
  encoding: SfBinaryEncoding
): string {
  // Buffer.from accepts the ArrayBuffer a WebCrypto-backed provider may return
  // as well as views at any offset; the serializer needs an exact ArrayBuffer.
  const buf = Buffer.from(bytes as Uint8Array);
  if (encoding === 'legacy-base64url') return `${key}=:${buf.toString('base64url')}:`;
  const exact = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  return serializeDictionary(new Map([[key, [exact, new Map()]]]));
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

/** Raw text of the `sha-256` byte-sequence token in a Content-Digest header, if present. */
export function contentDigestSha256Token(header: string): string | undefined {
  return header.match(/(?:^|[,\s])sha-256=:([^:]+):/)?.[1];
}

/**
 * True when `encoded` is canonical padded standard Base64 (RFC 4648 §4), the
 * RFC 8941 `sf-binary` form AdCP 3.2 requires: `+`/`/` alphabet, length a
 * multiple of four, and only the `=` padding the byte length requires.
 */
export function isPaddedStandardBase64(encoded: string): boolean {
  return encoded.length > 0 && encoded.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(encoded);
}

export function contentDigestUsesEncoding(header: string, encoding: SfBinaryEncoding): boolean {
  const encoded = contentDigestSha256Token(header);
  if (!encoded) return false;
  if (encoding === 'legacy-base64url') return /^[A-Za-z0-9_-]+$/.test(encoded);
  return isPaddedStandardBase64(encoded);
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
