/**
 * Server-side authentication primitives for AdCP MCP agents.
 *
 * Wire one of these into {@link serve} via `ServeOptions.authenticate` to
 * require credentials on every incoming request. The supported mechanisms
 * match the storyboard security baseline:
 *
 * - `verifyApiKey({ verify })` — static or dynamic API-key lookup.
 * - `verifyBearer({ jwksUri, issuer, audience })` — OAuth 2.0 bearer JWT
 *   validation against a JWKS endpoint. Use this when your IdP issues
 *   signed JWTs (WorkOS, Auth0, Clerk, Okta, etc.).
 * - `anyOf(a, b, ...)` — pass if any sub-authenticator succeeds. The
 *   canonical way to accept "API key OR OAuth".
 *
 * On failure, the {@link respondUnauthorized} helper produces an RFC 6750
 * compliant 401 (or 403) with a `WWW-Authenticate` header — required for
 * compliance and what the storyboard runner probes for.
 *
 * **Audience binding is not optional.** `verifyBearer` requires an `audience`
 * and rejects tokens whose `aud` claim doesn't match — this is what stops
 * same-tenant tokens from being replayed against any agent that shares the
 * tenant. If you write a CUSTOM `authenticate` callback (instead of using
 * `verifyBearer`), you MUST validate `aud` yourself against your canonical
 * public URL. IdPs that don't include `aud` in user tokens (some WorkOS /
 * Clerk defaults) break the model: either add `aud` at mint time via a
 * custom claim, or pick a different IdP configuration. Signature + expiry
 * + scope alone is not per-resource isolation.
 */
import type { IncomingMessage, ServerResponse } from 'http';
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyOptions } from 'jose';
import type { RequestSignatureErrorCode } from '../signing/errors';
import { RequestSignatureError } from '../signing/errors';

/**
 * Default JWT algorithm allowlist. Asymmetric only — HS-family is intentionally
 * excluded to prevent algorithm-confusion attacks where a JWKS public key is
 * used as an HMAC secret. Callers can override via {@link VerifyBearerOptions.jwtOptions}.
 */
export const DEFAULT_JWT_ALGORITHMS = Object.freeze([
  'RS256',
  'RS384',
  'RS512',
  'ES256',
  'ES384',
  'PS256',
  'PS384',
  'EdDSA',
]);

/** Default `exp`/`nbf` tolerance to reduce flakes under minor clock drift. */
export const DEFAULT_JWT_CLOCK_TOLERANCE_SECONDS = 30;

/**
 * Successful authentication result. Attach whatever claims you want —
 * `principal` is recommended (an opaque identifier for who's calling).
 */
export interface AuthPrincipal {
  principal: string;
  /** Raw credential that authenticated the request. Propagated into `req.auth.token` for MCP tool handlers. */
  token?: string;
  scopes?: string[];
  claims?: JWTPayload;
  /** Token expiry (seconds since epoch) when known — propagated to MCP `AuthInfo.expiresAt`. */
  expiresAt?: number;
  [key: string]: unknown;
}

/**
 * Outcome of a single authenticator. Return `null` for "did not match" so
 * combinators like {@link anyOf} can move on to the next authenticator.
 * Throw for "definitely unauthorized" (e.g., a valid JWT that failed
 * audience validation) so callers can distinguish from "no credentials".
 */
export type AuthResult = AuthPrincipal | null;

/**
 * Authentication middleware applied before the MCP transport handles a request.
 * Receives the raw Node request so it can read the Authorization header or
 * a query parameter, as needed.
 */
export type Authenticator = (req: IncomingMessage) => AuthResult | Promise<AuthResult>;

/**
 * Error class signalling "credentials presented but rejected". Carries a
 * sanitized public `message` safe to surface to clients and a `cause` with
 * the underlying implementation error for server-side logs. `serve()` uses
 * this to avoid leaking library-internal messages (e.g. expected `aud` values
 * from `jose`) into `WWW-Authenticate` / response bodies.
 */
export class AuthError extends Error {
  readonly publicMessage: string;
  constructor(publicMessage: string, options?: { cause?: unknown }) {
    super(publicMessage);
    this.name = 'AuthError';
    this.publicMessage = publicMessage;
    if (options?.cause !== undefined) (this as Error & { cause?: unknown }).cause = options.cause;
  }
}

/**
 * Marker tag on an {@link Authenticator} that needs `req.rawBody` to be
 * populated before it runs. `serve()` buffers the request body ahead of
 * authentication when any wired authenticator carries this tag — RFC 9421
 * signature verifiers need the raw bytes to recompute `Content-Digest`.
 *
 * Attach via {@link tagAuthenticatorNeedsRawBody}; {@link anyOf} propagates
 * the tag when any wrapped authenticator carries it.
 */
export const AUTH_NEEDS_RAW_BODY: unique symbol = Symbol.for('@adcp/client.auth.needsRawBody');

/**
 * Marker tag on an {@link Authenticator} whose contract depends on being the
 * sole path for some class of requests — wrapping it in {@link anyOf} would
 * reintroduce an either-or fall-through that the gate was built to prevent.
 *
 * Currently carried by the authenticator returned from
 * `requireSignatureWhenPresent`, which guarantees "if `Signature-Input` is
 * present, the signature path is the ONLY outcome." Composing it under
 * `anyOf` would let a valid bearer silently accept an invalid signature —
 * the exact bug the helper closes. `anyOf` throws at composition time when
 * any child is tagged.
 */
export const AUTH_PRESENCE_GATED: unique symbol = Symbol.for('@adcp/client.auth.presenceGated');

/**
 * Request-scoped context that {@link serve} stamps on the incoming request
 * before the authenticator runs. Authenticator callbacks read this via
 * {@link getServeRequestContext} so they inherit `serve()`'s host
 * resolution (which honors `trustForwardedHost`) instead of re-reading
 * headers that may be attacker-controlled.
 */
export const ADCP_SERVE_REQUEST_CONTEXT: unique symbol = Symbol.for('@adcp/client.auth.serveRequestContext');

/**
 * Per-request context exposed to the `verifyBearer` audience callback.
 * Authoritative host + resolved publicUrl come from `serve()` — the
 * callback MUST NOT reach past this object to read `X-Forwarded-Host`
 * itself, or it will diverge from the advertised OAuth `resource` and
 * let a spoofed header flip the audience check.
 */
export interface ServeRequestContext {
  /** Canonical host for the request as resolved by `serve()`. Lowercased, port preserved. */
  host: string;
  /** Resolved `publicUrl` for this host (if configured). Undefined in single-host mode with no publicUrl. */
  publicUrl?: string;
}

/** Read the serve()-populated context off a request. Returns `undefined` when the request didn't come through `serve()`. */
export function getServeRequestContext(req: IncomingMessage): ServeRequestContext | undefined {
  return (req as IncomingMessage & { [ADCP_SERVE_REQUEST_CONTEXT]?: ServeRequestContext })[ADCP_SERVE_REQUEST_CONTEXT];
}

interface AuthenticatorFlags {
  [AUTH_NEEDS_RAW_BODY]?: boolean;
  [AUTH_PRESENCE_GATED]?: boolean;
}

/**
 * Mark an authenticator as needing `req.rawBody`. Safe to call more than once.
 */
export function tagAuthenticatorNeedsRawBody(auth: Authenticator): Authenticator {
  (auth as unknown as AuthenticatorFlags)[AUTH_NEEDS_RAW_BODY] = true;
  return auth;
}

/**
 * Check whether an authenticator (possibly composed via {@link anyOf}) requires
 * the raw request body to be buffered before invocation.
 */
export function authenticatorNeedsRawBody(auth: Authenticator | undefined): boolean {
  return !!auth && (auth as unknown as AuthenticatorFlags)[AUTH_NEEDS_RAW_BODY] === true;
}

/**
 * Mark an authenticator as presence-gated. {@link anyOf} refuses to wrap a
 * tagged authenticator — wrapping would defeat the gate.
 */
export function tagAuthenticatorPresenceGated(auth: Authenticator): Authenticator {
  (auth as unknown as AuthenticatorFlags)[AUTH_PRESENCE_GATED] = true;
  return auth;
}

/**
 * Check whether an authenticator is presence-gated (see {@link AUTH_PRESENCE_GATED}).
 */
export function isAuthenticatorPresenceGated(auth: Authenticator | undefined): boolean {
  return !!auth && (auth as unknown as AuthenticatorFlags)[AUTH_PRESENCE_GATED] === true;
}

// ---------------------------------------------------------------------------
// Token extraction
// ---------------------------------------------------------------------------

/**
 * Extract a bearer token from the request. Checks the `Authorization` header
 * first (`Bearer <token>`), then the legacy `x-adcp-auth` header our older
 * clients use.
 */
export function extractBearerToken(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (auth && auth.length > 7 && auth.slice(0, 6).toLowerCase() === 'bearer') {
    // Require at least one whitespace byte between scheme and token — avoids
    // backtracking-prone regexes on attacker-controlled header values.
    const sep = auth.charCodeAt(6);
    if (sep === 0x20 || sep === 0x09) {
      const token = auth.slice(7).trim();
      if (token.length > 0) return token;
    }
  }
  const legacy = req.headers['x-adcp-auth'];
  if (typeof legacy === 'string' && legacy.length > 0) return legacy;
  return null;
}

// ---------------------------------------------------------------------------
// API-key authenticator
// ---------------------------------------------------------------------------

export interface VerifyApiKeyOptions {
  /**
   * Static map of API keys to the principal they represent. Handy for
   * single-tenant agents or local development.
   */
  keys?: Record<string, AuthPrincipal>;
  /**
   * Dynamic verifier for keys that live in a database or secret store.
   * Return `null` for "not my key" (falls through to other authenticators),
   * or a principal to accept.
   */
  verify?: (token: string) => Promise<AuthResult> | AuthResult;
}

/**
 * Build an API-key authenticator. Accepts a static map and/or a dynamic
 * verifier; if both are provided, the static map is checked first.
 *
 * ```ts
 * serve(createAgent, {
 *   authenticate: verifyApiKey({
 *     keys: { 'sk_live_abc': { principal: 'acct_42' } },
 *     verify: async token => db.lookupKey(token),
 *   }),
 * });
 * ```
 */
export function verifyApiKey(options: VerifyApiKeyOptions): Authenticator {
  if (!options.keys && !options.verify) {
    throw new Error('verifyApiKey: provide at least one of `keys` or `verify`.');
  }
  return async req => {
    const token = extractBearerToken(req);
    if (!token) return null;
    if (options.keys && Object.prototype.hasOwnProperty.call(options.keys, token)) {
      return { ...options.keys[token]!, token };
    }
    if (options.verify) {
      const result = await options.verify(token);
      return result ? { ...result, token: result.token ?? token } : null;
    }
    return null;
  };
}

// ---------------------------------------------------------------------------
// Bearer / JWT authenticator
// ---------------------------------------------------------------------------

export interface VerifyBearerOptions {
  /** JWKS URI — usually `<issuer>/.well-known/jwks.json`. */
  jwksUri: string;
  /** Expected `iss` claim. */
  issuer: string;
  /**
   * Expected `aud` claim — the canonical URL clients see for this MCP
   * endpoint (e.g., `https://my-agent.example.com/mcp`). MUST match what
   * the token was issued for. If you advertise via
   * {@link ServeOptions.protectedResource}, set this to the same URL.
   *
   * For multi-host deployments pass a function. The two-argument form
   * receives `(req, ctx)` where `ctx.host` and `ctx.publicUrl` come from
   * `serve()`'s host resolution — inheriting the same
   * `trustForwardedHost` policy that governs the advertised PRM. Prefer
   * `(_req, { publicUrl }) => publicUrl!` so the JWT audience check and
   * the RFC 9728 `resource` URL can never diverge; a callback that reads
   * `X-Forwarded-Host` directly is a footgun when `trustForwardedHost`
   * is off.
   *
   * The single-argument form `(req) => string` still works for agents
   * mounting `verifyBearer` outside `serve()` (e.g., under
   * `createExpressAdapter`), but inherits none of `serve()`'s header
   * hardening — you MUST validate audience inputs yourself.
   */
  audience: string | ((req: IncomingMessage) => string) | ((req: IncomingMessage, ctx: ServeRequestContext) => string);
  /** Optional: required scopes (all must be present in the `scope` / `scp` claim). */
  requiredScopes?: string[];
  /**
   * Optional: JWT verification options passthrough. Defaults to the secure
   * asymmetric-only algorithm allowlist and a 30s clock tolerance — override
   * only if you know why. HS256/HS384/HS512 are rejected by default to prevent
   * algorithm-confusion attacks against the JWKS.
   */
  jwtOptions?: Omit<JWTVerifyOptions, 'issuer' | 'audience'>;
}

/**
 * Build a JWT bearer authenticator that validates tokens against a JWKS.
 *
 * Uses the `jose` library (already in the dependency tree). Audience and
 * issuer are enforced strictly — a token minted for the wrong audience
 * is rejected, which is the bug pattern we've seen in the wild when an
 * agent advertises an incorrect `/.well-known/oauth-protected-resource`
 * `resource` URL.
 *
 * ```ts
 * serve(createAgent, {
 *   authenticate: verifyBearer({
 *     jwksUri: 'https://auth.example/.well-known/jwks.json',
 *     issuer: 'https://auth.example',
 *     audience: 'https://my-agent.example.com/mcp',
 *   }),
 * });
 * ```
 */
export function verifyBearer(options: VerifyBearerOptions): Authenticator {
  const jwks = createRemoteJWKSet(new URL(options.jwksUri));
  const audienceIsFn = typeof options.audience === 'function';
  const baseVerifyOptions: Omit<JWTVerifyOptions, 'audience'> = {
    algorithms: DEFAULT_JWT_ALGORITHMS.slice(),
    clockTolerance: DEFAULT_JWT_CLOCK_TOLERANCE_SECONDS,
    ...options.jwtOptions,
    issuer: options.issuer,
  };
  const staticVerifyOptions: JWTVerifyOptions | undefined = audienceIsFn
    ? undefined
    : { ...baseVerifyOptions, audience: options.audience as string };
  return async req => {
    const token = extractBearerToken(req);
    if (!token) return null;
    let payload: JWTPayload;
    let verifyOptions: JWTVerifyOptions;
    if (audienceIsFn) {
      let audience: string;
      try {
        // Pass the serve()-resolved context as the second argument. The
        // callback can use `ctx.publicUrl` (preferred — it's the same URL
        // the RFC 9728 PRM advertises) or `ctx.host` for its own
        // reconstruction. Falls back to an empty-host ctx when the
        // authenticator is mounted outside `serve()`, so callbacks must
        // still tolerate `host === ''`.
        const ctx: ServeRequestContext = getServeRequestContext(req) ?? { host: '' };
        audience = (options.audience as (r: IncomingMessage, c: ServeRequestContext) => string)(req, ctx);
      } catch (err) {
        // Resolver threw — surface as auth failure rather than 500 so the
        // client sees a clean 401 and the operator sees the cause in the log.
        throw new AuthError('Token validation failed.', { cause: err });
      }
      verifyOptions = { ...baseVerifyOptions, audience };
    } else {
      verifyOptions = staticVerifyOptions as JWTVerifyOptions;
    }
    try {
      ({ payload } = await jwtVerify(token, jwks, verifyOptions));
    } catch (err) {
      // Never surface jose's message to the client — it echoes expected audience,
      // issuer, or token-shape details that probing attackers can use.
      throw new AuthError('Token validation failed.', { cause: err });
    }
    const scopes = extractScopes(payload);
    if (options.requiredScopes?.length) {
      const missing = options.requiredScopes.filter(s => !scopes.includes(s));
      if (missing.length > 0) {
        throw new AuthError('Insufficient scope.', {
          cause: new Error(`Missing required scope(s): ${missing.join(', ')}`),
        });
      }
    }
    const principal: AuthPrincipal = {
      principal: typeof payload.sub === 'string' ? payload.sub : 'unknown',
      token,
      scopes,
      claims: payload,
    };
    if (typeof payload.exp === 'number') principal.expiresAt = payload.exp;
    return principal;
  };
}

/**
 * Extract scopes from a JWT payload. Handles both RFC 8693 `scope` (string,
 * space-delimited) and RFC 9068 / Azure AD / Okta `scp` (string or string[]).
 */
function extractScopes(payload: JWTPayload): string[] {
  const out: string[] = [];
  if (typeof payload.scope === 'string') {
    out.push(...payload.scope.split(/\s+/).filter(Boolean));
  } else if (Array.isArray(payload.scope)) {
    out.push(...(payload.scope as unknown[]).filter((s): s is string => typeof s === 'string'));
  }
  const scp = (payload as JWTPayload & { scp?: unknown }).scp;
  if (typeof scp === 'string') {
    out.push(...scp.split(/\s+/).filter(Boolean));
  } else if (Array.isArray(scp)) {
    out.push(...scp.filter((s): s is string => typeof s === 'string'));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Combinators
// ---------------------------------------------------------------------------

/**
 * Pass if any authenticator succeeds. A `null` from one falls through to the
 * next; a thrown error short-circuits to 401 (credentials were presented but
 * rejected — not a "no credentials" case). Errors are wrapped in an
 * {@link AuthError} with a generic public message so the client can't tell
 * which mechanism rejected them.
 */
export function anyOf(...authenticators: Authenticator[]): Authenticator {
  for (const auth of authenticators) {
    if (isAuthenticatorPresenceGated(auth)) {
      throw new Error(
        'anyOf: refusing to wrap a presence-gated authenticator. Wrapping would ' +
          'reintroduce the bearer-bypass bug the gate was built to prevent. ' +
          'Invert the composition: requireSignatureWhenPresent(sig, anyOf(...others)).'
      );
    }
  }
  const combined: Authenticator = async req => {
    let rejected = false;
    const causes: unknown[] = [];
    for (const auth of authenticators) {
      try {
        const result = await auth(req);
        if (result) return result;
      } catch (err) {
        rejected = true;
        causes.push(err);
      }
    }
    if (rejected) {
      throw new AuthError('Credentials rejected.', { cause: causes });
    }
    return null;
  };
  if (authenticators.some(a => authenticatorNeedsRawBody(a))) {
    tagAuthenticatorNeedsRawBody(combined);
  }
  return combined;
}

// ---------------------------------------------------------------------------
// 401 / 403 response helper
// ---------------------------------------------------------------------------

export interface RespondUnauthorizedOptions {
  /**
   * Bearer realm value. Defaults to `"mcp"` — a stable value that won't reflect
   * an attacker-controlled `Host` header into the challenge.
   */
  realm?: string;
  /** RFC 6750 error code. Defaults to `invalid_token`. */
  error?: 'invalid_request' | 'invalid_token' | 'insufficient_scope';
  /** Human-readable description. */
  errorDescription?: string;
  /**
   * OAuth 2.0 resource URL (RFC 9728). If set, included in the challenge so
   * clients can discover the auth server from the protected-resource metadata.
   */
  resourceMetadata?: string;
  /** Set to 403 instead of 401 for valid-but-unauthorized scenarios. */
  status?: 401 | 403;
  /**
   * RFC 9421 signature error code. When set, the challenge scheme switches
   * from `Bearer` to `Signature` and the body's `error` field carries the
   * signature code verbatim — what the `signed_requests` conformance grader
   * reads from `WWW-Authenticate` to decide pass/fail on negative vectors.
   *
   * Set this whenever the rejection is a signature-layer failure (invalid
   * signature, missing required signature, revoked key, replayed nonce,
   * etc.). `serve()` auto-detects this from an {@link AuthError} whose
   * `cause` is a {@link RequestSignatureError}; callers rarely set it
   * directly.
   */
  signatureError?: RequestSignatureErrorCode;
}

/**
 * Send an RFC 6750-compliant 401/403 response with the `WWW-Authenticate`
 * header set. Called automatically by {@link serve} when `authenticate`
 * returns `null` or throws.
 *
 * When {@link RespondUnauthorizedOptions.signatureError} is set, the
 * challenge scheme becomes `Signature` (per the `signed-requests`
 * specialism) and the body's `error` field carries the RFC 9421 error
 * code — the `signed_requests` grader reads both from the challenge.
 */
export function respondUnauthorized(
  _req: IncomingMessage,
  res: ServerResponse,
  options: RespondUnauthorizedOptions = {}
): void {
  const realm = options.realm ?? 'mcp';
  const parts = [`realm="${escapeQuotes(realm)}"`];
  const useSignatureChallenge = options.signatureError !== undefined;
  // The `error` codes are typed unions — the type system gives us the
  // only quote-safe guarantee. Route through `escapeQuotes` so a future
  // widening to `string` or a code that happens to include `"` doesn't
  // inject a new parameter into the challenge header.
  if (useSignatureChallenge) {
    parts.push(`error="${escapeQuotes(options.signatureError!)}"`);
  } else if (options.error) {
    parts.push(`error="${escapeQuotes(options.error)}"`);
  }
  if (options.errorDescription) parts.push(`error_description="${escapeQuotes(options.errorDescription)}"`);
  if (options.resourceMetadata) parts.push(`resource_metadata="${escapeQuotes(options.resourceMetadata)}"`);

  const scheme = useSignatureChallenge ? 'Signature' : 'Bearer';
  res.writeHead(options.status ?? 401, {
    'Content-Type': 'application/json',
    'WWW-Authenticate': `${scheme} ${parts.join(', ')}`,
  });
  res.end(
    JSON.stringify({
      error: useSignatureChallenge ? options.signatureError : (options.error ?? 'unauthorized'),
      error_description: options.errorDescription ?? 'Authentication required.',
    })
  );
}

/**
 * Unwrap the first {@link RequestSignatureError} found walking the
 * `cause` chain of an {@link AuthError} (or any error), so callers can
 * switch the `WWW-Authenticate` challenge scheme on signature-layer
 * failures. Returns `null` for non-signature errors.
 */
export function signatureErrorCodeFromCause(err: unknown): RequestSignatureErrorCode | null {
  // Track visited refs to break arbitrary cycles (self-reference, N-cycles,
  // or a long non-signature chain that would otherwise exhaust the walker).
  // The visited set is a belt-and-suspenders companion to the hop cap —
  // either one alone is enough for legitimate chains, but cycle resistance
  // is the security-relevant property.
  const visited = new Set<unknown>();
  let current: unknown = err;
  let hops = 0;
  while (current != null && hops < 32 && !visited.has(current)) {
    if (current instanceof RequestSignatureError) return current.code;
    visited.add(current);
    current = (current as { cause?: unknown }).cause;
    hops++;
  }
  return null;
}

function escapeQuotes(s: string): string {
  // Escape backslashes first so later-inserted escapes aren't re-escaped.
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
