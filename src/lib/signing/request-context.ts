/**
 * Adapter helpers that construct the `{ method, url }` shape that
 * `ResponseLike.request` (and any other caller binding RFC 9421 derived
 * components back to an originating request) requires.
 *
 * Why this exists: `ResponseLike.request.url` MUST be an absolute URL —
 * `canonicalAuthority` / `canonicalTargetUri` parse via `new URL(...)` and
 * throw on a relative path. Express handlers ship `req.url` / `req.originalUrl`
 * as path-only, so adopters reconstruct via
 * `${req.protocol}://${req.get('host')}${req.originalUrl}`. But `req.protocol`
 * lies behind a TLS-terminating proxy unless `trust proxy` is set, and
 * `req.get('host')` is attacker-controllable absent a Host allowlist. A
 * hostile peer that controls these headers can rebind a signature to
 * `attacker.example.com` while the operator believes they're signing for
 * `seller.example.com`.
 *
 * The library can warn (JSDoc on `ResponseLike.request`) but can't enforce.
 * These helpers make the safe path the default path — pass them an inbound
 * request handle from your platform and they emit a hardened
 * `{ method, url }` shape.
 */

/**
 * Minimal Express request shape this helper consumes. Kept narrow so
 * `@adcp/sdk` doesn't pull in `@types/express`; importing Express's own
 * `Request` type is safe in adopter code, since structural typing accepts
 * the wider shape anywhere this narrower one is expected.
 */
export interface ExpressRequestLike {
  readonly method: string;
  readonly protocol: string;
  readonly originalUrl: string;
  /** Express's typed `Request.get('host')` overload. */
  get(name: 'host'): string | undefined;
}

export interface RequestContextFromExpressOptions {
  /**
   * Allowed `Host` header values. When set, the helper throws if the
   * inbound `Host` doesn't match. Strongly recommended in production —
   * absent this, a hostile peer controlling the `Host` header can rebind
   * the signature origin (see file header).
   *
   * Each entry is compared verbatim against `req.get('host')` after
   * trimming and lowercasing. Include port suffixes where applicable
   * (`api.example.com:8080`).
   */
  hostAllowlist?: ReadonlyArray<string>;

  /**
   * When `true` (default), the helper throws if the reconstructed URL
   * scheme is not `https`. AdCP response / webhook signatures bound to
   * `http://` will fail strict-HTTPS verifier profiles, so this catches
   * the misconfig at construction time. Disable only for local dev /
   * loopback mock servers.
   */
  forceHttps?: boolean;
}

/**
 * Construct a hardened `{ method, url }` from an Express request.
 *
 * **You MUST configure `app.set('trust proxy', ...)`** with the IPs of
 * your trusted reverse proxies before relying on this helper. Without
 * `trust proxy`, Express returns the literal `req.connection.remoteAddress`
 * for `req.protocol` and `req.ip` — which a TLS-terminating proxy will
 * always set to the proxy's address, leaving you blind to whether the
 * original request actually arrived over HTTPS. This helper trusts what
 * Express tells it; the operator is responsible for telling Express what
 * to trust.
 *
 * Throws when the `Host` header is missing, doesn't match `hostAllowlist`,
 * or when the scheme is not `https` (unless `forceHttps: false`).
 */
export function requestContextFromExpress(
  req: ExpressRequestLike,
  options: RequestContextFromExpressOptions = {}
): { method: string; url: string } {
  const host = normalizeHost(req.get('host'));
  if (!host) {
    throw new TypeError(
      'requestContextFromExpress: Host header is missing. ' +
        'Express returned no `host` — either the inbound request omitted it, or your reverse proxy stripped it.'
    );
  }
  if (options.hostAllowlist && !hostMatchesAllowlist(host, options.hostAllowlist)) {
    throw new TypeError(
      `requestContextFromExpress: Host "${host}" is not in hostAllowlist. ` +
        `A hostile peer may be trying to rebind your signature origin via Host-header injection. ` +
        `Add the legitimate value to hostAllowlist, or fix your proxy's Host handling.`
    );
  }
  const protocol = req.protocol;
  const forceHttps = options.forceHttps !== false;
  if (forceHttps && protocol !== 'https') {
    throw new TypeError(
      `requestContextFromExpress: protocol is "${protocol}", not "https". ` +
        `Set app.set('trust proxy', ...) so Express sees the X-Forwarded-Proto header, ` +
        `or pass forceHttps: false for local dev (loopback / mock-server testing).`
    );
  }
  // Defense-in-depth: reject userinfo in originalUrl. A malicious middleware
  // could mutate req.originalUrl to inject `user@` between host and path —
  // canonicalAuthority would then sign the userinfo-bearing variant. Express
  // doesn't normally carry userinfo here but we check rather than trust.
  if (/[@]/.test(req.originalUrl.split('?')[0] ?? '')) {
    throw new TypeError('requestContextFromExpress: originalUrl path must not embed userinfo (@).');
  }
  return { method: req.method, url: `${protocol}://${host}${req.originalUrl}` };
}

/**
 * Fetch / Workers / Deno / Bun `Request` shape. `request.url` is already
 * an absolute URL per WHATWG spec, so there's no host-spoofing surface
 * here — the runtime owns URL construction, not the caller.
 */
export interface FetchRequestLike {
  readonly method: string;
  readonly url: string;
}

/**
 * Construct `{ method, url }` from a Fetch / WHATWG `Request`. Trivial
 * passthrough; included for API symmetry with the Express / Lambda
 * helpers. No proxy hardening needed — `request.url` is the absolute URL
 * the runtime constructed from the wire, and Workers / Deno / Bun all
 * terminate TLS at the edge so `https` is honest.
 */
export function requestContextFromFetch(request: FetchRequestLike): { method: string; url: string } {
  // WHATWG accepts `https://user:pw@host/path` as a valid Request URL and
  // echoes it back verbatim. `canonicalAuthority` would then sign the
  // userinfo-bearing form, splitting the signature namespace between
  // userinfo and userinfo-stripped variants of the same logical origin.
  // Reject at construction time — userinfo never belongs in a signed
  // `@authority` / `@target-uri`.
  let parsed: URL;
  try {
    parsed = new URL(request.url);
  } catch {
    throw new TypeError(`requestContextFromFetch: request.url "${request.url}" is not a parseable URL.`);
  }
  if (parsed.username || parsed.password) {
    throw new TypeError(
      'requestContextFromFetch: request.url must not embed userinfo. ' +
        'A signed @authority component with userinfo creates a verifier-splitting confusion vector.'
    );
  }
  return { method: request.method, url: request.url };
}

/**
 * AWS Lambda API Gateway v2 / ALB event shape. Narrow rather than
 * importing `@types/aws-lambda` — adopter code that ships against the
 * full Lambda types can pass the wider object verbatim.
 */
export interface LambdaRequestEvent {
  readonly requestContext: {
    readonly domainName?: string;
    readonly http?: { readonly method?: string };
    readonly httpMethod?: string;
  };
  readonly rawPath?: string;
  readonly rawQueryString?: string;
  readonly path?: string;
  readonly httpMethod?: string;
  readonly queryStringParameters?: { readonly [key: string]: string | undefined };
}

export interface RequestContextFromLambdaOptions {
  /**
   * Same semantics as the Express helper — allowed `domainName` values.
   * Lambda's `event.requestContext.domainName` is set by API Gateway from
   * the matched custom-domain configuration; it's not attacker-controllable
   * the way Express's `req.get('host')` is, but pinning it still catches
   * misrouted traffic (e.g. one tenant's Lambda receiving another tenant's
   * domain via a misconfigured shared API Gateway).
   */
  hostAllowlist?: ReadonlyArray<string>;
}

/**
 * Construct `{ method, url }` from an AWS Lambda API Gateway v2 / ALB
 * event. Reads `requestContext.domainName` for the authority, `rawPath` +
 * `rawQueryString` for the target (v2 / ALB), falling back to `path` +
 * `queryStringParameters` reconstruction (v1).
 *
 * Always emits `https://` — Lambda is not addressable over plain HTTP
 * through API Gateway / ALB in any documented configuration.
 */
export function requestContextFromLambda(
  event: LambdaRequestEvent,
  options: RequestContextFromLambdaOptions = {}
): { method: string; url: string } {
  const domainName = event.requestContext.domainName;
  if (!domainName) {
    throw new TypeError(
      'requestContextFromLambda: event.requestContext.domainName is missing. ' +
        'API Gateway v2 / ALB events should always carry this; ' +
        'is this event shaped like something else?'
    );
  }
  const host = normalizeHost(domainName);
  if (!host) {
    throw new TypeError('requestContextFromLambda: domainName is empty after normalization.');
  }
  if (options.hostAllowlist && !hostMatchesAllowlist(host, options.hostAllowlist)) {
    throw new TypeError(
      `requestContextFromLambda: domainName "${host}" is not in hostAllowlist. ` +
        `Multi-tenant API Gateway misroute? Add the legitimate value, or fix the API mapping.`
    );
  }
  const method = event.requestContext.http?.method ?? event.requestContext.httpMethod ?? event.httpMethod;
  if (!method) {
    throw new TypeError('requestContextFromLambda: HTTP method is missing from the event.');
  }
  const path = event.rawPath ?? event.path ?? '/';
  // Lambda's domainName won't carry a trailing dot in supported configs but
  // we normalize here so a future shape change can't bypass the allowlist.
  let url = `https://${host}${path}`;
  if (event.rawQueryString) {
    url += `?${event.rawQueryString}`;
  } else if (event.queryStringParameters) {
    const params = Object.entries(event.queryStringParameters)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v as string)}`);
    if (params.length) url += `?${params.join('&')}`;
  }
  return { method, url };
}

/**
 * Normalize a Host / domainName value for allowlist comparison. Lowercase
 * + trim handle the obvious cases; trailing-dot stripping closes a
 * documented Host-header bypass where `example.com.` is a distinct string
 * from `example.com` on some stacks. IPv6 brackets are preserved so the
 * allowlist entry and the inbound value agree on bracket presence.
 */
function normalizeHost(raw: string | undefined): string {
  if (!raw) return '';
  let h = raw.trim().toLowerCase();
  // Strip trailing dot from FQDN. Bracketed IPv6 cannot legitimately
  // carry a trailing dot, so this only fires on hostnames.
  if (h.endsWith('.') && !h.endsWith(']')) h = h.slice(0, -1);
  return h;
}

function hostMatchesAllowlist(host: string, allowlist: ReadonlyArray<string>): boolean {
  return allowlist.some(entry => normalizeHost(entry) === host);
}
