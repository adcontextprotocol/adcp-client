import type { AuthFailureDiagnostics, RequestSignatureDiagnostics, WwwAuthenticateDiagnostics } from '../errors';
import { parseWWWAuthenticate } from '../auth/oauth/diagnostics';
import { parseDictionary } from 'structured-headers';
import { parseSignatureInput, rejectDuplicateDictionaryKeys } from '../signing/parser';
import { RequestSigningErrorCodeMetadata } from '../types/enums.generated';

const BEARER_ERROR_CODES = new Set(['invalid_request', 'invalid_token', 'insufficient_scope']);
// IANA HTTP Authentication Scheme Registry, plus AdCP's `Signature` and
// common vendor schemes.
const KNOWN_SCHEMES = new Set([
  'basic',
  'bearer',
  'concealed',
  'digest',
  'dpop',
  'gnap',
  'hoba',
  'mutual',
  'negotiate',
  'ntlm',
  'oauth',
  'privatetoken',
  'scram-sha-1',
  'scram-sha-256',
  'vapid',
  'signature',
  'aws4-hmac-sha256',
]);
const OTHER_SCHEME = 'other';
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
  'last-event-id',
  'x-adcp-agent-id',
  'x-adcp-request-id',
  'x-correlation-id',
  'x-request-id',
  'x-scope3-debug-id',
  'signature-input',
  'content-digest',
]);
// Header names that carry a credential. Their values, the nonce, and the
// signature bytes are protected at any length; other header values are
// metadata matched exactly or when long enough to be a credential.
const CREDENTIAL_HEADER_RE =
  /(^|[_-])(authorization|auth|cookie|credentials?|secret|token|api[_-]?key|key|password|session|signature)([_-]|$)/i;
// Real signatures are 86+ Base64 characters. A floor keeps short fixture
// values from masking ordinary seller words.
const MIN_SIGNATURE_BYTES_LENGTH = 16;
// Shorter metadata values are matched exactly, so an incidental short header
// value such as `X-Api-Version: 1` cannot blank out a legitimate key id.
const MIN_CONTAINED_METADATA_LENGTH = 8;
const REDACTED = '[redacted]';
const MAX_COMPONENTS = 32;
const MAX_PARAM_LENGTH = 256;
const MAX_SCHEME_LENGTH = 32;
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
 * nonce value, or any credential header. Every emitted string is screened
 * against those protected values. `requestHeaders` must be the headers fetch
 * actually sends. Returns undefined for other statuses and never throws, so
 * diagnostics cannot change protocol behavior.
 */
export function buildAuthFailureDiagnostics(
  status: number,
  requestHeaders: Headers,
  responseHeaders: Headers,
  adcpVersion?: string
): AuthFailureDiagnostics | undefined {
  if (status !== 401 && status !== 403) return undefined;
  try {
    const secrets = protectedValues(requestHeaders);
    // A caller can set these headers on an unsigned request, and its values are
    // not the SDK's. Report them only for a signed request, and the digest only
    // when the signature covered it.
    const requestSignature = requestHeaders.has('signature')
      ? signatureDiagnostics(requestHeaders.get('signature-input'), secrets)
      : undefined;
    const contentDigest = requestSignature?.components.includes('content-digest')
      ? contentDigestDiagnostic(requestHeaders.get('content-digest'), secrets)
      : undefined;
    const wwwAuthenticate = challengeDiagnostics(responseHeaders.get('www-authenticate'), secrets);
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

function signatureDiagnostics(
  header: string | null,
  secrets: ProtectedValues
): RequestSignatureDiagnostics | undefined {
  if (!header) return undefined;
  let parsed: ReturnType<typeof parseSignatureInput>;
  try {
    parsed = parseSignatureInput(header);
  } catch {
    return undefined;
  }
  const screen = (value: string) => (containsSecret(value, secrets) ? REDACTED : bound(value));
  const clean = (value: number) => !containsSecret(String(value), secrets);
  const { keyid, alg, created, expires, nonce, tag } = parsed.params;
  return {
    label: screen(parsed.label),
    ...(typeof keyid === 'string' && { keyid: screen(keyid) }),
    ...(typeof alg === 'string' && { alg: screen(alg) }),
    ...(typeof created === 'number' && clean(created) && { created }),
    ...(typeof expires === 'number' && clean(expires) && { expires }),
    noncePresent: typeof nonce === 'string',
    ...(typeof tag === 'string' && { tag: screen(tag) }),
    components: parsed.components.slice(0, MAX_COMPONENTS).map(screen),
  };
}

function contentDigestDiagnostic(header: string | null, secrets: ProtectedValues): string | undefined {
  if (!header || header.length > MAX_CONTENT_DIGEST_LENGTH) return undefined;
  const value = header.trim();
  return CONTENT_DIGEST_RE.test(value) && !containsSecret(value, secrets) ? value : undefined;
}

function challengeDiagnostics(header: string | null, secrets: ProtectedValues): WwwAuthenticateDiagnostics | undefined {
  const parsed = parseWWWAuthenticate(header);
  if (!parsed) return undefined;
  const error = parsed.error && isRecognizedChallengeError(parsed.error) ? parsed.error : undefined;
  const realm = safeRealm(parsed.realm, secrets);
  return {
    scheme: safeScheme(parsed.scheme, secrets),
    ...(error && { error }),
    ...(realm && { realm }),
  };
}

function isRecognizedChallengeError(error: string): boolean {
  return BEARER_ERROR_CODES.has(error) || Object.prototype.hasOwnProperty.call(RequestSigningErrorCodeMetadata, error);
}

/**
 * The scheme is seller-controlled too, and a seller can put any token there.
 * A registered scheme is a fixed word. Any other scheme survives only when it
 * overlaps no protected value; otherwise it is reported as `other`.
 */
function safeScheme(scheme: string, secrets: ProtectedValues): string {
  if (KNOWN_SCHEMES.has(scheme)) return scheme;
  return scheme.length <= MAX_SCHEME_LENGTH && !overlapsSecret(scheme, secrets) ? scheme : OTHER_SCHEME;
}

/**
 * Seller-controlled realm text survives only as a short token that shares no
 * substring relationship with any protected value. The whitespace-free
 * charset also rules out free-text prose.
 */
function safeRealm(realm: string | undefined, secrets: ProtectedValues): string | undefined {
  if (!realm || realm.length > MAX_REALM_LENGTH || !REALM_RE.test(realm)) return undefined;
  return overlapsSecret(realm, secrets) ? undefined : realm;
}

interface ProtectedValues {
  /** Credential header values, the nonce, and the signature bytes. */
  strong: string[];
  /** Other non-public request header values. */
  metadata: string[];
}

/**
 * For seller-controlled text: any substring relationship in either direction
 * with any protected value. Case-insensitive, because the challenge parser
 * lowercases the scheme.
 */
function overlapsSecret(text: string, secrets: ProtectedValues): boolean {
  const lower = text.toLowerCase();
  return [...secrets.strong, ...secrets.metadata].some(secret => {
    const candidate = secret.toLowerCase();
    return lower.includes(candidate) || candidate.includes(lower);
  });
}

/**
 * For the SDK's own outbound values. A credential, the nonce, or signature
 * bytes match anywhere at any length. Metadata matches exactly, or anywhere
 * once it is long enough to be a credential.
 */
function containsSecret(text: string, secrets: ProtectedValues): boolean {
  const lower = text.toLowerCase();
  return (
    secrets.strong.some(secret => lower.includes(secret.toLowerCase())) ||
    secrets.metadata.some(secret => {
      const candidate = secret.toLowerCase();
      return lower === candidate || (candidate.length >= MIN_CONTAINED_METADATA_LENGTH && lower.includes(candidate));
    })
  );
}

/**
 * Values no diagnostic may carry: every non-public request header value, the
 * credential part of `Authorization`-style values, structured-field byte
 * sequences, the nonce, and every form of the `Signature` bytes.
 */
function protectedValues(headers: Headers): ProtectedValues {
  const strong: string[] = [];
  const metadata: string[] = [];
  headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (!value || PUBLIC_REQUEST_HEADERS.has(lower)) return;
    const into = CREDENTIAL_HEADER_RE.test(lower) ? strong : metadata;
    into.push(value);
    // `Bearer <token>`, `Basic <credentials>`.
    const credential = value.replace(/^\S+\s+/, '');
    if (credential && credential !== value) into.push(credential);
    // Structured-field byte sequences.
    for (const match of value.matchAll(/:([^:\s]+):/g)) into.push(match[1]!);
  });
  // `Signature-Input` is public, but the diagnostics expose only whether a
  // nonce was sent, never its value.
  strong.push(...signatureNonces(headers.get('signature-input')), ...signatureSecrets(headers));
  return { strong, metadata };
}

/**
 * Every `nonce` parameter in `Signature-Input`, read with the Structured
 * Fields parser so a `;nonce=` inside another quoted value cannot hide the
 * real one. When the field does not parse cleanly, every quoted string in it
 * is treated as a possible nonce.
 */
function signatureNonces(header: string | null): string[] {
  if (!header) return [];
  try {
    rejectDuplicateDictionaryKeys(header, 'Signature-Input');
    const nonces: string[] = [];
    for (const [, member] of parseDictionary(header)) {
      for (const [key, value] of member[1]) {
        if (key === 'nonce' && typeof value === 'string' && value) nonces.push(value);
      }
    }
    return nonces;
  } catch {
    // Quoted strings consumed left to right, so each is whole.
    return [...header.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(match => match[1]!.replace(/\\(.)/g, '$1')).filter(Boolean);
  }
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
