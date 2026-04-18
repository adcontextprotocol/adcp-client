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
 */
import type { IncomingMessage, ServerResponse } from 'http';
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyOptions } from 'jose';

/**
 * Successful authentication result. Attach whatever claims you want —
 * `principal` is recommended (an opaque identifier for who's calling).
 */
export interface AuthPrincipal {
  principal: string;
  scopes?: string[];
  claims?: JWTPayload | Record<string, unknown>;
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
      return options.keys[token]!;
    }
    if (options.verify) {
      return options.verify(token);
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
   */
  audience: string;
  /** Optional: required scopes (all must be present in the `scope` claim). */
  requiredScopes?: string[];
  /** Optional: JWT verification options passthrough (algorithms, clock tolerance). */
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
  return async req => {
    const token = extractBearerToken(req);
    if (!token) return null;
    // jose throws on any validation failure. Propagate as a hard rejection so
    // combinators don't silently fall through to a less-strict authenticator.
    const { payload } = await jwtVerify(token, jwks, {
      issuer: options.issuer,
      audience: options.audience,
      ...options.jwtOptions,
    });
    if (options.requiredScopes?.length) {
      const scopeClaim = typeof payload.scope === 'string' ? payload.scope.split(/\s+/) : [];
      const missing = options.requiredScopes.filter(s => !scopeClaim.includes(s));
      if (missing.length > 0) {
        throw new Error(`Missing required scope(s): ${missing.join(', ')}`);
      }
    }
    return {
      principal: typeof payload.sub === 'string' ? payload.sub : 'unknown',
      scopes: typeof payload.scope === 'string' ? payload.scope.split(/\s+/) : undefined,
      claims: payload,
    };
  };
}

// ---------------------------------------------------------------------------
// Combinators
// ---------------------------------------------------------------------------

/**
 * Pass if any authenticator succeeds. A `null` from one falls through to the
 * next; a thrown error short-circuits to 401 (credentials were presented but
 * rejected — not a "no credentials" case).
 */
export function anyOf(...authenticators: Authenticator[]): Authenticator {
  return async req => {
    let lastError: unknown;
    for (const auth of authenticators) {
      try {
        const result = await auth(req);
        if (result) return result;
      } catch (err) {
        lastError = err;
      }
    }
    if (lastError) throw lastError;
    return null;
  };
}

// ---------------------------------------------------------------------------
// 401 / 403 response helper
// ---------------------------------------------------------------------------

export interface RespondUnauthorizedOptions {
  /**
   * Bearer realm value. Defaults to the request host. Appears in
   * `WWW-Authenticate: Bearer realm="..."`.
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
}

/**
 * Send an RFC 6750-compliant 401/403 response with the `WWW-Authenticate`
 * header set. Called automatically by {@link serve} when `authenticate`
 * returns `null` or throws.
 */
export function respondUnauthorized(
  req: IncomingMessage,
  res: ServerResponse,
  options: RespondUnauthorizedOptions = {}
): void {
  const realm = options.realm ?? req.headers.host ?? 'adcp-agent';
  const parts = [`realm="${realm}"`];
  if (options.error) parts.push(`error="${options.error}"`);
  if (options.errorDescription) parts.push(`error_description="${escapeQuotes(options.errorDescription)}"`);
  if (options.resourceMetadata) parts.push(`resource_metadata="${options.resourceMetadata}"`);

  res.writeHead(options.status ?? 401, {
    'Content-Type': 'application/json',
    'WWW-Authenticate': `Bearer ${parts.join(', ')}`,
  });
  res.end(
    JSON.stringify({
      error: options.error ?? 'unauthorized',
      error_description: options.errorDescription ?? 'Authentication required.',
    })
  );
}

function escapeQuotes(s: string): string {
  // Escape backslashes first so later-inserted escapes aren't re-escaped.
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
