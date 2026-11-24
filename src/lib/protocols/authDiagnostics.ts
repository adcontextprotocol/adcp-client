import type { AuthFailureDiagnostics, RequestSignatureDiagnostics, WwwAuthenticateDiagnostics } from '../errors';
import { parseWWWAuthenticate } from '../auth/oauth/diagnostics';
import { parseSignatureInput } from '../signing/parser';
import { RequestSigningErrorCodeMetadata } from '../types/enums.generated';

const BEARER_ERROR_CODES = new Set(['invalid_request', 'invalid_token', 'insufficient_scope']);
// Public protocol metadata. Every other request header value is treated as a
// possible credential when deciding whether seller text reflects one.
const PUBLIC_REQUEST_HEADERS = new Set([
  'accept',
  'accept-encoding',
  'content-type',
  'content-length',
  'user-agent',
  'host',
  'a2a-version',
  'a2a-extensions',
  'adcp-version',
  'mcp-protocol-version',
  'traceparent',
  'tracestate',
  'signature-input',
  'content-digest',
]);
// Real signatures are 86+ Base64 characters. A floor keeps short fixture
// values from masking ordinary seller words.
const MIN_SIGNATURE_BYTES_LENGTH = 16;
const MAX_COMPONENTS = 32;
const MAX_PARAM_LENGTH = 256;
const MAX_SCHEME_LENGTH = 64;
const MAX_REALM_LENGTH = 128;
const MAX_CONTENT_DIGEST_LENGTH = 512;
const REALM_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/;
// RFC 9530 dictionary of byte sequences. Both Base64 alphabets appear on the
// wire, depending on the request-signing profile.
const CONTENT_DIGEST_RE = /^[a-z0-9-]+=:[A-Za-z0-9+/_-]+={0,2}:(?:, ?[a-z0-9-]+=:[A-Za-z0-9+/_-]+={0,2}:)*$/;
const ADCP_VERSION_RE = /^[0-9A-Za-z.+-]{1,32}$/;

/**
 * Build allowlisted diagnostics for a 401/403 response. Only parsed fields
 * leave this function: never the raw challenge, the `Signature` bytes, the
 * nonce value, or any credential header. Returns undefined for other statuses
 * and never throws, so diagnostics cannot change protocol behavior.
 */
export function buildAuthFailureDiagnostics(
  status: number,
  requestHeaders: Headers,
  responseHeaders: Headers,
  adcpVersion?: string
): AuthFailureDiagnostics | undefined {
  if (status !== 401 && status !== 403) return undefined;
  try {
    const requestSignature = signatureDiagnostics(requestHeaders.get('signature-input'));
    const contentDigest = contentDigestDiagnostic(requestHeaders.get('content-digest'));
    const wwwAuthenticate = challengeDiagnostics(responseHeaders.get('www-authenticate'), requestHeaders);
    return {
      status,
      ...(requestSignature && { requestSignature }),
      ...(contentDigest && { contentDigest }),
      ...(wwwAuthenticate && { wwwAuthenticate }),
      ...(adcpVersion && ADCP_VERSION_RE.test(adcpVersion) && { adcpVersion }),
    };
  } catch {
    return undefined;
  }
}

function signatureDiagnostics(header: string | null): RequestSignatureDiagnostics | undefined {
  if (!header) return undefined;
  let parsed: ReturnType<typeof parseSignatureInput>;
  try {
    parsed = parseSignatureInput(header);
  } catch {
    return undefined;
  }
  const { keyid, alg, created, expires, nonce, tag } = parsed.params;
  return {
    label: bound(parsed.label),
    ...(typeof keyid === 'string' && { keyid: bound(keyid) }),
    ...(typeof alg === 'string' && { alg: bound(alg) }),
    ...(typeof created === 'number' && { created }),
    ...(typeof expires === 'number' && { expires }),
    noncePresent: typeof nonce === 'string',
    ...(typeof tag === 'string' && { tag: bound(tag) }),
    components: parsed.components.slice(0, MAX_COMPONENTS).map(bound),
  };
}

function contentDigestDiagnostic(header: string | null): string | undefined {
  if (!header || header.length > MAX_CONTENT_DIGEST_LENGTH) return undefined;
  const value = header.trim();
  return CONTENT_DIGEST_RE.test(value) ? value : undefined;
}

function challengeDiagnostics(header: string | null, requestHeaders: Headers): WwwAuthenticateDiagnostics | undefined {
  const parsed = parseWWWAuthenticate(header);
  if (!parsed) return undefined;
  const error = parsed.error && isRecognizedChallengeError(parsed.error) ? parsed.error : undefined;
  const realm = safeRealm(parsed.realm, requestHeaders);
  return {
    scheme: parsed.scheme.slice(0, MAX_SCHEME_LENGTH),
    ...(error && { error }),
    ...(realm && { realm }),
  };
}

function isRecognizedChallengeError(error: string): boolean {
  return BEARER_ERROR_CODES.has(error) || Object.prototype.hasOwnProperty.call(RequestSigningErrorCodeMetadata, error);
}

/**
 * Seller-controlled realm text survives only as a short token that shares no
 * substring relationship with any credential-bearing request header. The
 * whitespace-free charset also rules out free-text prose.
 */
function safeRealm(realm: string | undefined, requestHeaders: Headers): string | undefined {
  if (!realm || realm.length > MAX_REALM_LENGTH || !REALM_RE.test(realm)) return undefined;
  for (const secret of requestSecrets(requestHeaders)) {
    if (realm.includes(secret) || secret.includes(realm)) return undefined;
  }
  return realm;
}

function requestSecrets(headers: Headers): string[] {
  const secrets: string[] = [];
  headers.forEach((value, name) => {
    if (!value || PUBLIC_REQUEST_HEADERS.has(name.toLowerCase())) return;
    secrets.push(value);
    // `Bearer <token>`, `Basic <credentials>`.
    const credential = value.replace(/^\S+\s+/, '');
    if (credential && credential !== value) secrets.push(credential);
    // Structured-field byte sequences.
    for (const match of value.matchAll(/:([^:\s]+):/g)) secrets.push(match[1]!);
  });
  return [...secrets, ...signatureSecrets(headers)];
}

/**
 * Every form in which a seller could echo the `Signature` the SDK sent: the
 * header value, and each byte sequence in both Base64 alphabets, padded and
 * unpadded. `Signature-Input` is public diagnosis and is not included.
 */
export function signatureSecrets(headers: Headers): string[] {
  const value = headers.get('signature');
  if (!value) return [];
  const secrets = new Set([value]);
  for (const match of value.matchAll(/:([A-Za-z0-9+/_=-]+):/g)) {
    const bare = match[1]!.replace(/=+$/, '');
    if (bare.length < MIN_SIGNATURE_BYTES_LENGTH) continue;
    const padding = '='.repeat((4 - (bare.length % 4)) % 4);
    for (const form of [bare.replace(/-/g, '+').replace(/_/g, '/'), bare.replace(/\+/g, '-').replace(/\//g, '_')]) {
      secrets.add(form);
      secrets.add(form + padding);
    }
  }
  return [...secrets];
}

/** Mask the union of matches in the original text, including overlaps. */
export function redactReflected(value: string, secrets: string[]): string {
  const mask = new Uint8Array(value.length);
  for (const secret of secrets) {
    if (!secret) continue;
    for (let from = 0; from < value.length; ) {
      const at = value.indexOf(secret, from);
      if (at < 0) break;
      mask.fill(1, at, at + secret.length);
      from = at + 1;
    }
  }
  let out = '';
  let cursor = 0;
  for (let at = 0; at < value.length; ) {
    if (!mask[at]) {
      at++;
      continue;
    }
    out += value.slice(cursor, at) + '[redacted]';
    while (at < value.length && mask[at]) at++;
    cursor = at;
  }
  return out + value.slice(cursor);
}

function bound(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, MAX_PARAM_LENGTH);
}
