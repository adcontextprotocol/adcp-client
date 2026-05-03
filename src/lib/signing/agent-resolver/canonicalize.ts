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
 * canonical host, no port when default, no path/query.
 *
 * Used for the step-7 `identity.key_origins` consistency check: the verifier
 * compares the canonicalized host of the resolved `jwks_uri` against the
 * canonicalized host of the declared `key_origins.{purpose}` value.
 */
export function canonicalizeOrigin(originOrUrl: string): string {
  if (typeof originOrUrl !== 'string' || originOrUrl.length === 0) {
    throw new CanonicalizeError('Empty origin', { input: originOrUrl });
  }
  let parsed: URL;
  try {
    parsed = new URL(originOrUrl);
  } catch {
    throw new CanonicalizeError(`Invalid origin: ${originOrUrl}`, { input: originOrUrl });
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new CanonicalizeError(`Unsupported scheme: ${parsed.protocol}`, { input: originOrUrl });
  }
  const port = parsed.port ? `:${parsed.port}` : '';
  return `${parsed.protocol}//${parsed.hostname}${port}`;
}

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
