/**
 * RFC 7662 OAuth 2.0 Token Introspection authenticator.
 *
 * Use case: the agent is NOT the identity issuer. Instead it proxies an
 * upstream OAuth provider (Snap, Meta, TikTok, Google, …) — the Bearer
 * token a buyer presents is the upstream platform's access token, not a
 * JWT the adapter minted. {@link verifyBearer} doesn't apply there; the
 * only way to validate the token is to ask the upstream: POST the token
 * to its RFC 7662 introspection endpoint and check `active: true`.
 *
 * Matches the {@link Authenticator} contract of {@link verifyBearer}:
 * returns `null` when no bearer header is present (so {@link anyOf} can
 * fall through), throws {@link AuthError} when a token was presented
 * and rejected. Public error messages are sanitized — the upstream
 * response body never crosses the wire, only a generic "Token
 * validation failed." / "Insufficient scope." message on 401.
 *
 * **Positive-response caching is opt-in.** Introspection endpoints are
 * often rate-limited and always round-trip at least one TLS handshake
 * worth of latency — a small in-process LRU keyed on the token's
 * SHA-256 hash amortizes the cost across closely-spaced requests from
 * the same buyer. Negative responses are NOT cached by default; a
 * stolen-then-revoked token must be able to fail the next request. Set
 * `cache.negativeTtlSeconds` to cache `active: false` too (mitigates
 * introspection-amplification DoS, trades against revocation latency).
 */
import { createHash } from 'crypto';
import type { IncomingMessage } from 'http';
import { AuthError, extractBearerToken, type AuthPrincipal, type AuthResult, type Authenticator } from './auth';

/** RFC 7662 §2.2 introspection response. Fields are all optional except `active`. */
export interface IntrospectionResponse {
  active: boolean;
  scope?: string;
  client_id?: string;
  username?: string;
  token_type?: string;
  exp?: number;
  iat?: number;
  nbf?: number;
  sub?: string;
  aud?: string | string[];
  iss?: string;
  jti?: string;
  [extension: string]: unknown;
}

export interface IntrospectionCacheOptions {
  /** Max cached entries (positive + negative combined). Default 1024. */
  max?: number;
  /**
   * Seconds to cache `active: true` responses. Default 60. Must be <=
   * the token's remaining lifetime — the helper caps the effective
   * TTL at `exp - now` so the cache can't extend a token past its
   * issued expiry.
   */
  ttlSeconds?: number;
  /**
   * Seconds to cache `active: false` responses. Default 0 (disabled).
   * Caching negatives mitigates introspection-amplification DoS from an
   * attacker replaying a stolen-then-revoked token, but delays propagation
   * of a fresh revocation by up to this many seconds. Keep short (≤5s).
   */
  negativeTtlSeconds?: number;
}

export interface VerifyIntrospectionOptions {
  /** Absolute URL of the upstream introspection endpoint (RFC 7662 §2). */
  introspectionUrl: string;
  /**
   * Client credentials for the introspection call. Introspection endpoints
   * ALWAYS require client authentication — without credentials the endpoint
   * would be an open oracle for "is this token valid." Basic auth is the
   * default (RFC 7662 §2.1); `clientAuth: 'body'` sends `client_id` +
   * `client_secret` as form params instead (some IdPs require this).
   */
  clientId: string;
  clientSecret: string;
  clientAuth?: 'basic' | 'body';
  /**
   * Required scopes — the introspection response's `scope` claim (space
   * delimited per RFC 7662) must contain ALL of these. Useful when the
   * agent grants a subset of what the upstream IdP issues.
   */
  requiredScopes?: string[];
  /**
   * Optional constraint on the introspection response's `aud` claim.
   * When set, the helper rejects a token whose `aud` doesn't contain
   * this value. Note: many upstream platforms (Snap, Meta) don't set
   * `aud` on access tokens — their tokens are bound to the client_id,
   * not the resource URL. Leave undefined in that case.
   */
  audience?: string;
  /**
   * Optional cache. Disabled by default (every request round-trips to
   * the introspection endpoint). Enable for hot paths.
   */
  cache?: IntrospectionCacheOptions;
  /**
   * Timeout for the introspection request in milliseconds. Default
   * 2000ms. On timeout the authenticator throws an {@link AuthError}
   * (fail-closed — a slow upstream can't bypass authentication).
   */
  timeoutMs?: number;
  /**
   * `token_type_hint` sent with the introspection request (RFC 7662 §2.1).
   * Default `'access_token'`. Most IdPs ignore the hint but setting it
   * correctly is the spec-conformant move.
   */
  tokenTypeHint?: 'access_token' | 'refresh_token';
}

interface CacheEntry {
  principal: AuthResult;
  expiresAt: number; // ms since epoch
}

/** Build a token-introspection authenticator. See {@link VerifyIntrospectionOptions}. */
export function verifyIntrospection(options: VerifyIntrospectionOptions): Authenticator {
  // Resolved defaults + sanity-checks at construction so misconfig fails loud at boot.
  let introspectionUrl: URL;
  try {
    introspectionUrl = new URL(options.introspectionUrl);
  } catch {
    throw new Error(`verifyIntrospection: \`introspectionUrl\` is not a valid URL: ${options.introspectionUrl}`);
  }
  if (introspectionUrl.protocol !== 'https:' && !isLoopbackHost(introspectionUrl.hostname)) {
    throw new Error(
      `verifyIntrospection: \`introspectionUrl\` must use https:// (got ${introspectionUrl.protocol}). ` +
        'Sending bearer tokens over plain HTTP to remote hosts is a credential-exposure bug.'
    );
  }
  if (!options.clientId || !options.clientSecret) {
    throw new Error('verifyIntrospection: `clientId` and `clientSecret` are required (RFC 7662 mandates client auth).');
  }
  const clientAuth = options.clientAuth ?? 'basic';
  const timeoutMs = options.timeoutMs ?? 2000;
  const tokenTypeHint = options.tokenTypeHint ?? 'access_token';
  const requiredScopes = options.requiredScopes ?? [];

  const cache = options.cache ? createIntrospectionCache(options.cache) : undefined;

  // RFC 6749 §2.3.1 mandates application/x-www-form-urlencoded on the
  // clientId and clientSecret BEFORE base64'ing for Basic auth. That's
  // what `formUrlEncode` does (encodeURIComponent + `!*'()` escapes).
  // Some legacy ASes compare the decoded Basic-auth password directly
  // against the stored secret without percent-decoding — if that's
  // biting you, set `clientAuth: 'body'` to send creds in the form body
  // instead, which sidesteps the encoding negotiation entirely.
  const basicAuthHeader =
    clientAuth === 'basic'
      ? `Basic ${Buffer.from(`${formUrlEncode(options.clientId)}:${formUrlEncode(options.clientSecret)}`).toString('base64')}`
      : undefined;

  return async (req: IncomingMessage): Promise<AuthResult> => {
    const token = extractBearerToken(req);
    if (!token) return null;

    // Cache lookup keyed on SHA-256(token) so the cache never stores
    // the raw bearer in process memory.
    const cacheKey = cache ? sha256(token) : undefined;
    if (cache && cacheKey) {
      const hit = cache.get(cacheKey);
      if (hit) {
        if (hit.principal === null) {
          throw new AuthError('Token validation failed.');
        }
        return { ...hit.principal, token };
      }
    }

    let response: IntrospectionResponse;
    try {
      response = await introspect({
        introspectionUrl,
        token,
        tokenTypeHint,
        clientAuth,
        basicAuthHeader,
        clientId: options.clientId,
        clientSecret: options.clientSecret,
        timeoutMs,
      });
    } catch (err) {
      // Network / HTTP errors — fail closed but DON'T cache. The next
      // request retries. Public message is generic; cause is logged.
      throw new AuthError('Token validation failed.', { cause: err });
    }

    // Inactive token. Cache the negative result if enabled — mitigates
    // replay-amplification of a revoked token. Cause message is generic.
    if (!response.active) {
      if (cache && cacheKey && cache.negativeTtlMs > 0) {
        cache.set(cacheKey, { principal: null, expiresAt: Date.now() + cache.negativeTtlMs });
      }
      throw new AuthError('Token validation failed.');
    }

    // Audience check — only when the caller specified a required audience.
    // Many upstream IdPs don't populate `aud` on access tokens, so the
    // default "no audience required" is correct for the adapter case.
    if (options.audience !== undefined) {
      const aud = response.aud;
      const audList = typeof aud === 'string' ? [aud] : Array.isArray(aud) ? aud : [];
      if (!audList.includes(options.audience)) {
        throw new AuthError('Token validation failed.');
      }
    }

    const scopes = parseScope(response.scope);
    if (requiredScopes.length > 0) {
      const missing = requiredScopes.filter(s => !scopes.includes(s));
      if (missing.length > 0) {
        throw new AuthError('Insufficient scope.');
      }
    }

    const principal: AuthPrincipal = {
      principal:
        typeof response.sub === 'string'
          ? response.sub
          : typeof response.client_id === 'string'
            ? response.client_id
            : 'unknown',
      token,
      scopes,
      claims: response,
    };
    if (typeof response.exp === 'number') principal.expiresAt = response.exp;

    if (cache && cacheKey) {
      // Cap the positive TTL at the token's own remaining lifetime —
      // never let the cache extend a token past its issued `exp`. When
      // the IdP omits `exp`, fall back to the configured TTL.
      const nowSec = Math.floor(Date.now() / 1000);
      const configuredTtlMs = cache.positiveTtlMs;
      const effectiveTtlMs =
        typeof response.exp === 'number'
          ? Math.min(configuredTtlMs, Math.max(0, (response.exp - nowSec) * 1000))
          : configuredTtlMs;
      if (effectiveTtlMs > 0) {
        // Deep-clone the principal for the cache entry so callers that
        // mutate the returned principal can't poison the cached copy.
        // `claims` is cloned with structuredClone — a shallow spread would
        // leave nested objects aliased, and a malicious or buggy caller
        // that set `returned.claims.scope = 'admin'` would upgrade every
        // subsequent cached lookup.
        const cachedPrincipal: AuthPrincipal = {
          principal: principal.principal,
          scopes: [...scopes],
          claims: principal.claims ? structuredClone(principal.claims) : undefined,
        };
        if (principal.expiresAt !== undefined) cachedPrincipal.expiresAt = principal.expiresAt;
        cache.set(cacheKey, {
          principal: cachedPrincipal,
          expiresAt: Date.now() + effectiveTtlMs,
        });
      }
    }

    // Return a fresh object to callers — the cached copy is sealed behind
    // the `cachedPrincipal` closure. If the caller mutates the returned
    // `scopes` array or `claims` object, the cache entry stays clean
    // because it was cloned at `set` time (see block above).
    return principal;
  };
}

/**
 * Check whether a hostname is a loopback address. Exact-match for the
 * three literal forms (`localhost`, `127.0.0.1`, `[::1]`) so attacker
 * tricks like `localhost.evil.com` don't slip past — URL parser sets
 * `.hostname` to the whole string, not the left-most label.
 */
function isLoopbackHost(hostname: string): boolean {
  // URL parses IPv6 `[::1]` as hostname `::1` (brackets stripped). The
  // 127.0.0.0/8 range is loopback per RFC 6890 — accept anything in
  // that range since Node's own fetch routes it to lo0.
  if (hostname === 'localhost' || hostname === '::1') return true;
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!m) return false;
  return m.slice(1).every(octet => {
    const n = Number(octet);
    return n >= 0 && n <= 255;
  });
}

/**
 * application/x-www-form-urlencoded encoding per RFC 6749 §2.3.1 and
 * Appendix B. Differs from `encodeURIComponent` in that `!*'()` MUST be
 * percent-encoded (those are reserved in the form-urlencoded grammar).
 * Rare in real-world client credentials but spec-correct and avoids
 * per-IdP quirks when a secret happens to include one of those chars.
 */
function formUrlEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!*'()]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

// ---------------------------------------------------------------------------
// Introspection transport
// ---------------------------------------------------------------------------

async function introspect(args: {
  introspectionUrl: URL;
  token: string;
  tokenTypeHint: 'access_token' | 'refresh_token';
  clientAuth: 'basic' | 'body';
  basicAuthHeader: string | undefined;
  clientId: string;
  clientSecret: string;
  timeoutMs: number;
}): Promise<IntrospectionResponse> {
  const body = new URLSearchParams();
  body.set('token', args.token);
  body.set('token_type_hint', args.tokenTypeHint);
  if (args.clientAuth === 'body') {
    body.set('client_id', args.clientId);
    body.set('client_secret', args.clientSecret);
  }

  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json',
  };
  if (args.basicAuthHeader) headers.authorization = args.basicAuthHeader;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs);
  try {
    const res = await fetch(args.introspectionUrl, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });
    if (!res.ok) {
      // 4xx/5xx — don't treat as `active: false`; that would mask a
      // misconfigured client credential as a revoked token.
      const statusText = res.statusText || 'no status text';
      throw new Error(`introspection endpoint returned HTTP ${res.status} (${statusText})`);
    }
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('application/json')) {
      throw new Error(`introspection endpoint returned non-JSON content-type: ${ct}`);
    }
    const json = (await res.json()) as IntrospectionResponse;
    if (typeof json?.active !== 'boolean') {
      throw new Error('introspection response missing required `active` field');
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function parseScope(scope: unknown): string[] {
  if (typeof scope !== 'string' || scope.length === 0) return [];
  return scope.split(/\s+/).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

interface IntrospectionCacheHandle {
  get(key: string): CacheEntry | undefined;
  set(key: string, entry: CacheEntry): void;
  readonly positiveTtlMs: number;
  readonly negativeTtlMs: number;
}

/**
 * Small insertion-ordered LRU. Map iteration order is insertion order; to
 * bump an entry on access, delete + re-set. Keeps the implementation
 * dependency-free.
 */
function createIntrospectionCache(options: IntrospectionCacheOptions): IntrospectionCacheHandle {
  const max = options.max ?? 1024;
  const positiveTtlMs = (options.ttlSeconds ?? 60) * 1000;
  const negativeTtlMs = (options.negativeTtlSeconds ?? 0) * 1000;
  const store = new Map<string, CacheEntry>();

  return {
    positiveTtlMs,
    negativeTtlMs,
    get(key) {
      const entry = store.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= Date.now()) {
        store.delete(key);
        return undefined;
      }
      // Bump LRU: re-insert at the tail.
      store.delete(key);
      store.set(key, entry);
      return entry;
    },
    set(key, entry) {
      if (store.has(key)) store.delete(key);
      store.set(key, entry);
      while (store.size > max) {
        const oldest = store.keys().next().value;
        if (oldest === undefined) break;
        store.delete(oldest);
      }
    },
  };
}
