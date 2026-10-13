/**
 * Origin canonicalization for the brand_json_url verifier algorithm.
 * `security.mdx` §"Quickstart: implement a `brand_json_url`-based verifier"
 * step 3 mandates: ASCII-lowercase the host, then convert to IDNA-2008
 * A-label (Punycode) form before byte-equality. A non-canonical comparison
 * (raw `Example.COM` vs `example.com`, or U-label vs A-label) silently
 * rejects legitimate traffic.
 *
 * Node's WHATWG URL parser already performs IDNA-2008 A-label conversion
 * and ASCII-lowercases the host on construction (`new URL('https://Bücher.example/').hostname`
 * returns `xn--bcher-kva.example`). We delegate to it rather than vendoring
 * an IDNA implementation — the rule is "use the platform's IDNA-2008", not
 * "ship our own".
 */
import { canonicalAuthority } from '../canonicalize';

export class CanonicalizeError extends Error {
  constructor(
    message: string,
    readonly meta: { input: string }
  ) {
    super(message);
    this.name = 'CanonicalizeError';
  }
}

/**
 * Canonicalize a hostname (no scheme, no port, no path). Throws on inputs
 * that the URL parser rejects.
 */
export function canonicalizeHost(host: string): string {
  if (typeof host !== 'string' || host.length === 0) {
    throw new CanonicalizeError('Empty host', { input: host });
  }
  try {
    const u = new URL(`https://${host}/`);
    return u.hostname;
  } catch {
    throw new CanonicalizeError(`Invalid host: ${host}`, { input: host });
  }
}

/**
 * Canonicalize the origin component (scheme + host) of a URL or origin string.
 * Accepts either a full URL (`https://Example.COM/path`) or a bare origin
 * (`https://Example.COM`). Output is `https://example.com` form — scheme +
 * canonical host, no port when default, no path/query. Authority validation
 * follows the shared URL canonicalization steps 1–4, including removal of
 * one DNS root-label dot and rejection of malformed authorities.
 *
 * Used for the step-7 `identity.key_origins` consistency check: the verifier
 * compares the canonicalized host of the resolved `jwks_uri` against the
 * canonicalized host of the declared `key_origins.{purpose}` value.
 */
export function canonicalizeOrigin(originOrUrl: string): string {
  // Origin locators can contain userinfo, tokens in paths, or query secrets.
  // Keep the existing error shape without reflecting the supplied URL.
  const errorMeta = { input: '[redacted]' };
  if (typeof originOrUrl !== 'string' || originOrUrl.length === 0) {
    throw new CanonicalizeError('Empty origin', errorMeta);
  }
  // WHATWG parsing repairs backslashes and drops tabs/newlines. Reject them
  // in the raw authority before they can change the origin being compared.
  const authority = /^[a-z][a-z0-9+.\-]*:\/\/([^/?#]*)/i.exec(originOrUrl)?.[1];
  if (!authority || /[\u0000-\u0020\u007f\\]/.test(authority)) {
    throw new CanonicalizeError('Malformed origin authority', errorMeta);
  }
  let parsed: URL;
  try {
    parsed = new URL(originOrUrl);
  } catch {
    throw new CanonicalizeError('Invalid origin', errorMeta);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new CanonicalizeError('Unsupported origin scheme', errorMeta);
  }
  try {
    return `${parsed.protocol}//${canonicalAuthority(originOrUrl, '3.2')}`;
  } catch {
    throw new CanonicalizeError('Invalid origin authority', errorMeta);
  }
}

/**
 * Canonical agent origin, without path, query, fragment, or userinfo.
 * Normalizes producer inputs, including IDN U-labels. Wire comparers must
 * separately reject unnormalized non-ASCII hostnames, as canonicalAgentUrl
 * does. Normalizing a locator does not establish signer identity or authority.
 */
export const canonicalAgentOrigin = canonicalizeOrigin;

/**
 * Compare two origins (scheme + host + port) for byte-equality after
 * canonicalization. Wrong scheme, wrong port, or wrong host all return false.
 */
export function originsEqual(a: string, b: string): boolean {
  try {
    return canonicalizeOrigin(a) === canonicalizeOrigin(b);
  } catch {
    return false;
  }
}
