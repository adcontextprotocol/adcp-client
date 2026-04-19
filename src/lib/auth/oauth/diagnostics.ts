/**
 * OAuth diagnostics utilities.
 *
 * Small, pure helpers used by `adcp diagnose-auth` and by consumers who want
 * to introspect OAuth wire-level state without rolling their own parsers.
 *
 * None of these helpers perform cryptographic validation. `decodeAccessTokenClaims`
 * reads a JWT without checking its signature, and `validateTokenAudience` only
 * compares the `aud` claim — it does not verify the token is authentic.
 */

/**
 * Parsed WWW-Authenticate challenge (RFC 9110 §11.6.1, RFC 6750, RFC 9728).
 *
 * Only the fields most relevant to OAuth diagnostics are surfaced; unknown
 * auth-params are preserved under `params` so callers can inspect them.
 */
export interface WWWAuthenticateChallenge {
  /** Auth-scheme token, e.g. "Bearer" or "DPoP". Always lowercased. */
  scheme: string;
  /** `realm` auth-param, if present. */
  realm?: string;
  /** `error` auth-param (RFC 6750 §3), e.g. "invalid_token". */
  error?: string;
  /** `error_description` auth-param (RFC 6750 §3). */
  error_description?: string;
  /** `scope` auth-param (RFC 6750 §3). */
  scope?: string;
  /** `resource_metadata` auth-param (RFC 9728 §5.3) — URL of the protected-resource metadata document. */
  resource_metadata?: string;
  /** All auth-params (lowercased keys), including unknown ones. */
  params: Record<string, string>;
}

/**
 * Parse a `WWW-Authenticate` header into its auth-scheme and parameters.
 *
 * Handles the single-challenge case used by MCP servers in practice: one scheme
 * (typically `Bearer`) followed by comma-separated `key=value` or `key="value"`
 * auth-params. Returns `null` for an empty or malformed header.
 *
 * Quoted-string values may contain escaped quotes (`\"`) and backslashes (`\\`),
 * per RFC 9110 §5.6.4; these are unescaped on the way out.
 *
 * @example
 * ```ts
 * const c = parseWWWAuthenticate(
 *   'Bearer realm="api", error="invalid_token", resource_metadata="https://api.example.com/.well-known/oauth-protected-resource"'
 * );
 * // c.scheme === 'bearer'
 * // c.error === 'invalid_token'
 * // c.resource_metadata === 'https://api.example.com/.well-known/oauth-protected-resource'
 * ```
 */
export function parseWWWAuthenticate(header: string | null | undefined): WWWAuthenticateChallenge | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (!trimmed) return null;

  // Scheme is the leading token, up to the first whitespace (or end of string for bare schemes).
  const schemeMatch = /^([!#$%&'*+\-.^_`|~0-9A-Za-z]+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!schemeMatch) return null;

  const scheme = schemeMatch[1]!.toLowerCase();
  const rest = schemeMatch[2] ?? '';
  const params: Record<string, string> = {};

  // Walk the param list, handling quoted values with backslash escapes.
  let i = 0;
  while (i < rest.length) {
    // skip leading whitespace and commas
    while (i < rest.length && (rest[i] === ' ' || rest[i] === '\t' || rest[i] === ',')) i++;
    if (i >= rest.length) break;

    // read key
    const keyStart = i;
    while (i < rest.length && /[!#$%&'*+\-.^_`|~0-9A-Za-z]/.test(rest[i]!)) i++;
    const key = rest.slice(keyStart, i).toLowerCase();
    if (!key) break;

    // expect '='
    while (i < rest.length && (rest[i] === ' ' || rest[i] === '\t')) i++;
    if (rest[i] !== '=') {
      // Not a key=value pair — could be a token68. Ignore and move on.
      while (i < rest.length && rest[i] !== ',') i++;
      continue;
    }
    i++; // skip '='
    while (i < rest.length && (rest[i] === ' ' || rest[i] === '\t')) i++;

    // read value: either quoted-string or token
    let value = '';
    if (rest[i] === '"') {
      i++;
      while (i < rest.length && rest[i] !== '"') {
        if (rest[i] === '\\' && i + 1 < rest.length) {
          value += rest[i + 1];
          i += 2;
        } else {
          value += rest[i];
          i++;
        }
      }
      if (rest[i] === '"') i++;
    } else {
      const valStart = i;
      while (i < rest.length && rest[i] !== ',' && rest[i] !== ' ' && rest[i] !== '\t') i++;
      value = rest.slice(valStart, i);
    }

    params[key] = value;
  }

  return {
    scheme,
    realm: params.realm,
    error: params.error,
    error_description: params.error_description,
    scope: params.scope,
    resource_metadata: params.resource_metadata,
    params,
  };
}

/**
 * JWT header section (first segment), decoded but unverified.
 */
export interface DecodedJWTHeader {
  alg?: string;
  typ?: string;
  kid?: string;
  [key: string]: unknown;
}

/**
 * JWT claims section (second segment), decoded but unverified.
 *
 * Standard registered claims (RFC 7519 §4.1) are typed; everything else
 * flows through as `unknown`.
 */
export interface DecodedJWTClaims {
  iss?: string;
  sub?: string;
  /** Audience — string or array of strings per RFC 7519. */
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  iat?: number;
  jti?: string;
  scope?: string;
  [key: string]: unknown;
}

/**
 * Result of decoding an access token.
 */
export interface DecodedAccessToken {
  header: DecodedJWTHeader;
  claims: DecodedJWTClaims;
  /** Raw signature segment (base64url, unverified). */
  signature: string;
}

/**
 * Decode a JWT access token without verifying its signature.
 *
 * For diagnostics only — the returned claims MUST NOT be trusted for
 * authorization decisions. Returns `null` if the token is not a well-formed
 * three-part JWT, or if the header/claims segments are not valid JSON.
 *
 * Opaque (non-JWT) tokens always return `null`, which is the expected outcome
 * for servers that issue reference tokens rather than JWTs.
 */
export function decodeAccessTokenClaims(token: string | null | undefined): DecodedAccessToken | null {
  if (!token || typeof token !== 'string') return null;

  const parts = token.split('.');
  if (parts.length !== 3) return null;

  try {
    const header = JSON.parse(base64UrlDecode(parts[0]!)) as DecodedJWTHeader;
    const claims = JSON.parse(base64UrlDecode(parts[1]!)) as DecodedJWTClaims;
    if (typeof header !== 'object' || header === null) return null;
    if (typeof claims !== 'object' || claims === null) return null;
    return { header, claims, signature: parts[2]! };
  } catch {
    return null;
  }
}

/**
 * Result of audience validation.
 */
export interface TokenAudienceResult {
  ok: boolean;
  /** Human-readable reason when `ok` is false. */
  reason?: string;
  /** The `aud` claim value actually found in the token (undefined if missing or token unparseable). */
  actualAudience?: string | string[];
}

/**
 * Check whether an access token's `aud` claim matches an expected resource URL.
 *
 * Returns `{ ok: true }` when the `aud` claim is a string equal to
 * `expectedResource` (after URL normalization), or is an array containing
 * such a string. Returns `{ ok: false, reason }` otherwise, including when
 * the token is opaque (not a JWT) or has no `aud` claim.
 *
 * URL normalization: lowercased scheme and host, default ports (80 for http,
 * 443 for https) stripped, trailing slash on the path stripped. Query and
 * fragment are preserved verbatim. Non-URL audience strings are compared
 * byte-for-byte.
 *
 * Defense-in-depth helper. A server that mis-issues a token with the wrong
 * `aud` would still be accepted by the resource server; this helper flags
 * the mismatch on the client side for diagnostics.
 */
export function validateTokenAudience(token: string | null | undefined, expectedResource: string): TokenAudienceResult {
  const decoded = decodeAccessTokenClaims(token ?? undefined);
  if (!decoded) {
    return { ok: false, reason: 'Token is opaque or not a valid JWT; audience cannot be inspected' };
  }

  const aud = decoded.claims.aud;
  if (aud === undefined) {
    return { ok: false, reason: 'Token has no `aud` claim (RFC 8707 violation for resource-indicator flows)' };
  }

  const expected = normalizeResource(expectedResource);
  const audList = Array.isArray(aud) ? aud : [aud];

  for (const candidate of audList) {
    if (typeof candidate !== 'string') continue;
    if (normalizeResource(candidate) === expected) {
      return { ok: true, actualAudience: aud };
    }
  }

  return {
    ok: false,
    reason: `Token \`aud\` claim does not match expected resource "${expectedResource}"`,
    actualAudience: aud,
  };
}

function normalizeResource(value: string): string {
  try {
    const u = new URL(value);
    const scheme = u.protocol.toLowerCase();
    const host = u.hostname.toLowerCase();
    const port = u.port && !isDefaultPort(scheme, u.port) ? `:${u.port}` : '';
    const path = u.pathname.length > 1 && u.pathname.endsWith('/') ? u.pathname.slice(0, -1) : u.pathname;
    return `${scheme}//${host}${port}${path}${u.search}${u.hash}`;
  } catch {
    return value;
  }
}

function isDefaultPort(scheme: string, port: string): boolean {
  if (scheme === 'https:' && port === '443') return true;
  if (scheme === 'http:' && port === '80') return true;
  return false;
}

function base64UrlDecode(input: string): string {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = padded.length % 4;
  const full = padLen ? padded + '='.repeat(4 - padLen) : padded;
  return Buffer.from(full, 'base64').toString('utf8');
}
