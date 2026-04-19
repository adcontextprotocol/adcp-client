/**
 * Zero-config OAuth discovery + actionable authorization errors.
 *
 * When a library consumer calls an OAuth-gated MCP agent without saved
 * credentials, they get a `NeedsAuthorizationError` containing everything
 * needed to either run an interactive flow or present a clear prompt — no
 * re-probing required.
 *
 * Design note: this module only *discovers* — it never opens a browser or
 * writes state. Interactive flow handling stays in the caller (CLI or a
 * bespoke `OAuthFlowHandler`) so library behavior is predictable.
 */
import { ssrfSafeFetch, decodeBodyAsJsonOrText } from '../../net';
import { AuthenticationRequiredError, type OAuthMetadataInfo } from '../../errors';
import { parseWWWAuthenticate, type WWWAuthenticateChallenge } from './diagnostics';

/**
 * Maximum length of an individual server-supplied string we copy into the
 * `AuthorizationRequirements` payload. Anything longer is truncated with a
 * `…` suffix so hostile agents can't smuggle megabyte error-descriptions
 * into operator-facing prompts and logs.
 */
const MAX_DISPLAY_STRING = 256;

/**
 * Maximum number of scope strings we copy into `scopesSupported`. RFC 8414
 * allows an unbounded array; hostile servers have sent thousands.
 */
const MAX_SCOPES = 64;

/**
 * Maximum number of auth-params we preserve under `challenge.params`. Bounds
 * memory pressure from hostile servers that pack the `WWW-Authenticate`
 * header with unknown auth-params.
 */
const MAX_CHALLENGE_PARAMS = 32;

/**
 * Strip ASCII control characters (excluding TAB) from a server-supplied
 * string that may be shown to a human. Defeats terminal-hijack tricks like
 * `\x1b]0;pwned\x07` (rewrites terminal title), `\r` (overwrites prompt),
 * and `\x1b[2J` (clears screen). Also truncates over-long values.
 */
function sanitizeDisplay(value: string): string {
  const stripped = value.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
  if (stripped.length <= MAX_DISPLAY_STRING) return stripped;
  return `${stripped.slice(0, MAX_DISPLAY_STRING - 1)}…`;
}

/**
 * Sanitize the parsed `WWW-Authenticate` challenge before embedding it in a
 * `NeedsAuthorizationError`. Consumers that render `requirements.challenge`
 * to a terminal should never see control characters. Caps `params` count to
 * bound hostile servers.
 *
 * The `scheme` is already lowercased + token-constrained by the parser.
 * Param keys are also token-constrained so they're safe; only values need
 * sanitizing.
 */
function sanitizeChallenge(c: WWWAuthenticateChallenge): WWWAuthenticateChallenge {
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(c.params)) {
    if (Object.keys(params).length >= MAX_CHALLENGE_PARAMS) break;
    params[k] = sanitizeDisplay(v);
  }
  return {
    scheme: c.scheme,
    ...(c.realm !== undefined ? { realm: sanitizeDisplay(c.realm) } : {}),
    ...(c.error !== undefined ? { error: sanitizeDisplay(c.error) } : {}),
    ...(c.error_description !== undefined ? { error_description: sanitizeDisplay(c.error_description) } : {}),
    ...(c.scope !== undefined ? { scope: sanitizeDisplay(c.scope) } : {}),
    ...(c.resource_metadata !== undefined ? { resource_metadata: sanitizeDisplay(c.resource_metadata) } : {}),
    params,
  };
}

/**
 * Structured description of what an agent's authorization server requires
 * before it will accept a `tools/call`. Produced by
 * {@link discoverAuthorizationRequirements}.
 */
export interface AuthorizationRequirements {
  /** The agent URL we probed. */
  agentUrl: string;
  /** Resource URL the agent advertises in its `WWW-Authenticate` / PRM (RFC 9728). */
  resource?: string;
  /** URL of the protected-resource-metadata document (from `WWW-Authenticate: resource_metadata=…`). */
  resourceMetadataUrl?: string;
  /** First `authorization_servers[0]` from the protected-resource metadata. */
  authorizationServer?: string;
  /** `authorization_endpoint` from the authorization-server metadata (RFC 8414). */
  authorizationEndpoint?: string;
  /** `token_endpoint` from the authorization-server metadata. */
  tokenEndpoint?: string;
  /** `registration_endpoint` if the AS supports RFC 7591 dynamic client registration. */
  registrationEndpoint?: string;
  /** Scopes advertised by the AS (RFC 8414 `scopes_supported`). */
  scopesSupported?: string[];
  /** Scope hinted in the `WWW-Authenticate` challenge's `scope` auth-param. */
  challengeScope?: string;
  /** Raw parsed challenge the agent returned on the 401. */
  challenge: WWWAuthenticateChallenge;
}

/**
 * Error raised when an agent returns a 401 and we do not have credentials
 * to satisfy it. Carries everything needed to run an interactive OAuth flow
 * or show the operator an actionable prompt.
 *
 * Extends {@link AuthenticationRequiredError} so existing callers that catch
 * `AuthenticationRequiredError` automatically receive the richer variant —
 * they can downcast with `instanceof NeedsAuthorizationError` when they
 * want walked discovery metadata.
 *
 * Note on `code` vs `subCode`:
 *   The parent class declares `readonly code = 'AUTHENTICATION_REQUIRED'` as
 *   a class field that re-initializes on every construction, so a child-side
 *   override attempt is silently overwritten under `useDefineForClassFields`.
 *   The narrow discriminator is exposed as `subCode` — prefer
 *   `instanceof NeedsAuthorizationError` for type-narrowing and use `subCode`
 *   only for structured-log keying.
 *
 * Note on `hasOAuth`:
 *   The inherited getter returns `true` only when both `authorization_endpoint`
 *   and `token_endpoint` were walked successfully. A partially-walked
 *   requirements record (PRM reachable but AS metadata missing) still yields
 *   `hasOAuth === false` even though `requirements.authorizationServer` is set.
 *   Treat it as "we have enough to start a flow," not "server wants OAuth."
 */
export class NeedsAuthorizationError extends AuthenticationRequiredError {
  /** Narrow discriminator for consumers that already know about this class. */
  readonly subCode = 'needs_authorization' as const;
  readonly requirements: AuthorizationRequirements;

  constructor(requirements: AuthorizationRequirements, message?: string) {
    super(requirements.agentUrl, synthesizeOAuthMetadata(requirements), message ?? defaultMessage(requirements));
    this.name = 'NeedsAuthorizationError';
    this.requirements = requirements;
    // Extend the parent's `details` payload so structured-logging consumers
    // that read `err.details` (via `extractErrorInfo` or equivalent) see the
    // full walked chain, not just the synthesized one-hop oauthMetadata.
    this.details = { ...(this.details as object | undefined), requirements };
  }
}

/**
 * Build an {@link OAuthMetadataInfo} for the base-class constructor so that
 * legacy callers still see a non-empty `oauthMetadata` + working
 * `hasOAuth`/`authorizationUrl` getters on the error. When discovery didn't
 * yield enough info, return undefined and let the base class degrade
 * gracefully.
 */
function synthesizeOAuthMetadata(req: AuthorizationRequirements): OAuthMetadataInfo | undefined {
  if (!req.authorizationEndpoint || !req.tokenEndpoint) return undefined;
  return {
    authorization_endpoint: req.authorizationEndpoint,
    token_endpoint: req.tokenEndpoint,
    ...(req.registrationEndpoint ? { registration_endpoint: req.registrationEndpoint } : {}),
    ...(req.authorizationServer ? { issuer: req.authorizationServer } : {}),
  };
}

function defaultMessage(req: AuthorizationRequirements): string {
  const parts = [`Agent ${sanitizeDisplay(req.agentUrl)} requires OAuth authorization.`];
  if (req.authorizationServer) {
    parts.push(`Authorization server: ${req.authorizationServer}.`);
  }
  if (req.challenge.error_description) {
    parts.push(`Server said: ${sanitizeDisplay(req.challenge.error_description)}.`);
  }
  parts.push('Provide an OAuthFlowHandler or run an interactive flow to complete authorization.');
  return parts.join(' ');
}

/**
 * Options for {@link discoverAuthorizationRequirements}.
 */
export interface DiscoverAuthorizationOptions {
  /** Allow http:// and private-IP probe targets. Default false. */
  allowPrivateIp?: boolean;
  /** Override per-probe HTTP timeout (ms). Default inherits from ssrfSafeFetch (10s). */
  timeoutMs?: number;
  /**
   * If provided, use this `WWW-Authenticate` header verbatim instead of
   * re-probing the agent. Use this when you already have a 401 response in
   * hand and want to avoid a second round-trip.
   */
  wwwAuthenticate?: string;
}

/**
 * Walk the OAuth discovery chain starting from an agent URL. Returns
 * `AuthorizationRequirements` when the agent demands OAuth, or `null` when a
 * `tools/list` call succeeds without credentials.
 *
 * Strategy:
 *   1. POST `tools/list` to the agent with no `Authorization` header.
 *   2. If 401 + `WWW-Authenticate: Bearer`: parse the challenge.
 *   3. If the challenge carries `resource_metadata=…`: GET it and read
 *      `resource` + `authorization_servers`.
 *   4. For the first `authorization_servers[0]`: GET `/.well-known/oauth-authorization-server`
 *      and read `authorization_endpoint`, `token_endpoint`, `registration_endpoint`,
 *      `scopes_supported`.
 *   5. Return a structured record.
 *
 * Anything missing from the chain surfaces as `undefined` on the result —
 * callers can still present a partial picture without re-probing.
 */
export async function discoverAuthorizationRequirements(
  agentUrl: string,
  options: DiscoverAuthorizationOptions = {}
): Promise<AuthorizationRequirements | null> {
  // `allowPrivateIp` authorizes the agent probe. Chain hops (PRM, AS
  // metadata) inherit that trust ONLY when they share the agent's origin —
  // a compromised agent that advertises a private-IP authorization server
  // on a different origin would otherwise pivot a discovery walk into the
  // host's internal network.
  const allowPrivateIpOnAgent = options.allowPrivateIp ?? false;
  const agentOrigin = originOf(agentUrl);
  const allowPrivateIpForHop = (url: string): boolean =>
    allowPrivateIpOnAgent && agentOrigin !== undefined && originOf(url) === agentOrigin;

  let challengeHeader = options.wwwAuthenticate;
  if (!challengeHeader) {
    const probe = await probeAgent401(agentUrl, allowPrivateIpOnAgent, options.timeoutMs);
    if (probe.status !== 401) {
      // 200, 403, 5xx, or network error — not an OAuth 401 we can act on.
      return null;
    }
    challengeHeader = probe.wwwAuthenticate;
  }

  const challenge = parseWWWAuthenticate(challengeHeader ?? null);
  if (!challenge || challenge.scheme !== 'bearer') {
    // A 401 without a Bearer challenge isn't our kind of problem — let it propagate.
    return null;
  }

  const requirements: AuthorizationRequirements = {
    agentUrl,
    resourceMetadataUrl: challenge.resource_metadata ? sanitizeDisplay(challenge.resource_metadata) : undefined,
    challengeScope: challenge.scope ? sanitizeDisplay(challenge.scope) : undefined,
    challenge: sanitizeChallenge(challenge),
  };

  // Walk protected-resource metadata (RFC 9728 §3). Private-IP targets are
  // only allowed when the hop's origin matches the agent's.
  if (challenge.resource_metadata && isSafeHttpUrl(challenge.resource_metadata)) {
    const prm = await fetchJson(
      challenge.resource_metadata,
      allowPrivateIpForHop(challenge.resource_metadata),
      options.timeoutMs
    );
    if (prm && typeof prm === 'object') {
      const resource = (prm as { resource?: unknown }).resource;
      const servers = (prm as { authorization_servers?: unknown }).authorization_servers;
      if (typeof resource === 'string') requirements.resource = sanitizeDisplay(resource);
      if (Array.isArray(servers) && typeof servers[0] === 'string' && isSafeHttpUrl(servers[0])) {
        requirements.authorizationServer = sanitizeDisplay(servers[0]);
      }
    }
  }

  // Walk authorization-server metadata (RFC 8414 §3) using the first issuer.
  if (requirements.authorizationServer) {
    const asUrl = buildAuthorizationServerMetadataUrl(requirements.authorizationServer);
    if (asUrl) {
      const as = await fetchJson(asUrl, allowPrivateIpForHop(asUrl), options.timeoutMs);
      if (as && typeof as === 'object') {
        const md = as as {
          authorization_endpoint?: unknown;
          token_endpoint?: unknown;
          registration_endpoint?: unknown;
          scopes_supported?: unknown;
        };
        if (typeof md.authorization_endpoint === 'string') {
          requirements.authorizationEndpoint = sanitizeDisplay(md.authorization_endpoint);
        }
        if (typeof md.token_endpoint === 'string') {
          requirements.tokenEndpoint = sanitizeDisplay(md.token_endpoint);
        }
        if (typeof md.registration_endpoint === 'string') {
          requirements.registrationEndpoint = sanitizeDisplay(md.registration_endpoint);
        }
        if (Array.isArray(md.scopes_supported)) {
          const scopes = md.scopes_supported
            .filter((s: unknown): s is string => typeof s === 'string')
            .slice(0, MAX_SCOPES)
            .map(sanitizeDisplay);
          if (scopes.length > 0) requirements.scopesSupported = scopes;
        }
      }
    }
  }

  return requirements;
}

/**
 * Fire a single unauthenticated `tools/list` at the agent and return the
 * status + `WWW-Authenticate` header. Used when the caller hasn't provided
 * a cached 401 response.
 */
async function probeAgent401(
  agentUrl: string,
  allowPrivateIp: boolean,
  timeoutMs?: number
): Promise<{ status: number; wwwAuthenticate?: string }> {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  try {
    const res = await ssrfSafeFetch(agentUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body,
      allowPrivateIp,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
    return { status: res.status, wwwAuthenticate: res.headers['www-authenticate'] };
  } catch {
    return { status: 0 };
  }
}

/**
 * Check a URL is an absolute `http:`/`https:` URL before we hand it to
 * `ssrfSafeFetch`. Defeats `javascript:`, `file:`, `data:`, etc. the agent
 * might echo back in PRM or AS metadata. `ssrfSafeFetch` refuses non-HTTP
 * schemes too, but failing fast here gives a cleaner discovery flow and
 * avoids surfacing scheme errors as mysterious discovery misses.
 */
function originOf(value: string): string | undefined {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

function isSafeHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * Build the authorization-server metadata URL for an issuer per RFC 8414 §3.
 *
 * For issuer `https://as.example.com/tenant1`, metadata lives at
 * `https://as.example.com/.well-known/oauth-authorization-server/tenant1`
 * (well-known prefix inserted BEFORE the issuer path, not after). This
 * matches how the MCP SDK and most authorization servers advertise metadata.
 */
function buildAuthorizationServerMetadataUrl(issuer: string): string | undefined {
  if (!isSafeHttpUrl(issuer)) return undefined;
  const u = new URL(issuer);
  const pathname = u.pathname.endsWith('/') ? u.pathname.slice(0, -1) : u.pathname;
  return `${u.origin}/.well-known/oauth-authorization-server${pathname}`;
}

async function fetchJson(url: string, allowPrivateIp: boolean, timeoutMs?: number): Promise<unknown> {
  try {
    const res = await ssrfSafeFetch(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      allowPrivateIp,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
    if (res.status !== 200) return undefined;
    return decodeBodyAsJsonOrText(res.body, res.headers['content-type']);
  } catch {
    return undefined;
  }
}
