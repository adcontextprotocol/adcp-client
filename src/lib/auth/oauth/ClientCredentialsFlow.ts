/**
 * OAuth 2.0 client credentials grant — RFC 6749 §4.4.
 *
 * For machine-to-machine use cases (CI compliance runs, automated checks)
 * where there is no user to walk through an authorization-code flow. The
 * client POSTs its ID + secret to the authorization server's token endpoint
 * and gets back an access token directly.
 *
 * This file provides:
 * - {@link exchangeClientCredentials}: one-shot token exchange. Use for the
 *   initial fetch during `--save-auth` and for forced refresh.
 * - {@link ensureClientCredentialsTokens}: reads the cached tokens on an
 *   `AgentConfig`, checks expiry, re-exchanges if needed, and persists the
 *   refreshed tokens via an optional {@link OAuthConfigStorage}.
 *
 * Why a dedicated module instead of the MCP SDK's `OAuthClientProvider`:
 * client credentials doesn't need discovery, dynamic client registration,
 * PKCE, or authorization code exchange — all the plumbing that provider
 * exists to coordinate. A direct token POST and a cached-token check is the
 * entire protocol. The call path keeps using the plain `Authorization:
 * Bearer` header path — the same path it already uses for `auth_token`.
 *
 * **Security note (library consumers):** `token_endpoint` is passed to
 * `fetch` directly. Callers that accept untrusted `AgentConfig` values
 * from network requests (e.g. a hosted compliance service accepting
 * user-supplied configs) MUST validate the URL against an allowlist or
 * SSRF-block private IPs before invoking these helpers. The CLI and
 * operator-driven flows are already trusted.
 */

import { fromMCPTokens, type OAuthTokens, type AgentConfig, type AgentOAuthTokens } from './types';
import type { AgentOAuthClientCredentials } from '../../types/adcp';
import type { OAuthConfigStorage } from './types';
import { resolveSecret } from './secret-resolver';
import { isLikelyPrivateUrl } from '../../net';

/** Max length we'll echo from an AS-supplied error description into errors. */
const MAX_AS_ERROR_LENGTH = 200;

/**
 * Raised when the authorization server rejects a client credentials
 * exchange or the token endpoint is unreachable/malformed.
 *
 * The {@link kind} discriminator lets callers branch without
 * string-matching on the message:
 * - `oauth`: the AS returned a structured OAuth error (RFC 6749 §5.2 —
 *   `invalid_client`, `invalid_grant`, `invalid_scope`, …). Read
 *   {@link oauthError} / {@link oauthErrorDescription}.
 * - `malformed`: the AS returned HTTP 200 but no `access_token`, or a
 *   non-JSON body.
 * - `network`: the exchange never reached the AS (DNS failure, connection
 *   refused, timeout, TLS error).
 */
export class ClientCredentialsExchangeError extends Error {
  readonly code = 'client_credentials_exchange_failed';
  constructor(
    message: string,
    public readonly kind: 'oauth' | 'malformed' | 'network',
    public readonly oauthError?: string,
    public readonly oauthErrorDescription?: string,
    public readonly httpStatus?: number
  ) {
    super(message);
    this.name = 'ClientCredentialsExchangeError';
  }
}

/**
 * Options for {@link exchangeClientCredentials}.
 */
export interface ExchangeClientCredentialsOptions {
  /**
   * Custom fetch implementation (default: global `fetch`).
   * Primarily a testing hook — lets unit tests stub the authorization server
   * without intercepting the global.
   */
  fetch?: typeof fetch;
  /**
   * Request timeout in milliseconds (default: 30_000). Guards against a
   * silently hung authorization server blocking the caller indefinitely.
   */
  timeoutMs?: number;
  /**
   * Allow `token_endpoint` to resolve to a private / loopback IP address.
   * Default: false (SSRF guard). The CLI opts in because the operator is
   * explicitly configuring the endpoint; hosted consumers accepting
   * user-supplied configs should leave this off.
   */
  allowPrivateIp?: boolean;
}

/**
 * RFC 6749 §2.3.1 application/x-www-form-urlencoded encoding.
 *
 * Differs from `encodeURIComponent` in two important ways:
 * 1. Spaces are encoded as `+`, not `%20`.
 * 2. The characters `!'()*` are percent-encoded (URI component leaves them
 *    alone).
 *
 * A secret containing any of those chars would hash to a different Basic
 * string than the AS computes, producing a spurious `invalid_client`.
 */
function formUrlEncode(value: string): string {
  return encodeURIComponent(value)
    .replace(/%20/g, '+')
    .replace(/!/g, '%21')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\*/g, '%2A');
}

/**
 * Strip control chars (C0, C1, DEL) and truncate.
 *
 * Defensive cleanup on AS-controlled strings we print to a TTY. A
 * malicious or compromised AS could emit ANSI escape sequences or CRLF
 * payloads in `error_description`; we don't want those rewriting terminal
 * titles or forging log lines.
 */
function sanitizeAsMessage(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const stripped = raw.replace(/[\x00-\x1F\x7F-\x9F]/g, ' ');
  if (stripped.length <= MAX_AS_ERROR_LENGTH) return stripped;
  return stripped.slice(0, MAX_AS_ERROR_LENGTH) + '…';
}

/**
 * Validate the token endpoint before we hit it. Three checks, in order:
 *
 * 1. Parse as a URL. Unparseable → `malformed`.
 * 2. Reject URLs that carry `user:pass@` userinfo — they'd leak via error
 *    messages and log aggregators, and the OAuth client credentials live
 *    in `client_id` / `client_secret`, never the URL.
 * 3. Reject plaintext `http://` outside `localhost` / loopback IPs.
 *    RFC 6749 §3.1 requires TLS; the loopback carve-out covers local dev
 *    authorization servers where plaintext is not a leak risk.
 * 4. Reject private / loopback / link-local IPs unless `allowPrivateIp`.
 *    The library default is a SSRF guard; the CLI (operator-driven) opts
 *    in because a user pointing at `localhost:8080` is legitimate. Network
 *    code behind this call will still do DNS resolution, so this is a
 *    best-effort literal-IP / known-loopback check — host allowlisting
 *    upstream is the right control for adversarial environments.
 */
function validateTokenEndpoint(tokenEndpoint: string, options: { allowPrivateIp?: boolean } = {}): URL {
  let url: URL;
  try {
    url = new URL(tokenEndpoint);
  } catch {
    throw new ClientCredentialsExchangeError(`Invalid token_endpoint URL: ${tokenEndpoint}`, 'malformed');
  }

  if (url.username || url.password) {
    throw new ClientCredentialsExchangeError(
      `token_endpoint must not contain userinfo (user:pass@). Put credentials in client_id / client_secret instead.`,
      'malformed'
    );
  }

  const host = url.hostname;
  const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';

  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) {
    throw new ClientCredentialsExchangeError(
      `token_endpoint must be HTTPS (got ${url.protocol}//${host}). The client secret would be sent in plaintext over HTTP. Use https:// (or http://localhost for local dev).`,
      'malformed'
    );
  }

  if (!options.allowPrivateIp && isLikelyPrivateUrl(tokenEndpoint)) {
    throw new ClientCredentialsExchangeError(
      `token_endpoint resolves to a private or loopback address (${host}). Pass { allowPrivateIp: true } to exchangeClientCredentials / ensureClientCredentialsTokens if this is intentional (operator-driven CLI or local test setups).`,
      'malformed'
    );
  }

  return url;
}

/**
 * Exchange client credentials for an access token.
 *
 * Secret values in `credentials.client_id` / `client_secret` may be `$ENV:VAR`
 * references — they are resolved here at exchange time. Missing env vars
 * surface as `MissingEnvSecretError` (from `secret-resolver`), which
 * callers typically print with the variable name for the user to fix.
 *
 * @throws {ClientCredentialsExchangeError} on any non-2xx response, malformed 200, or network failure
 * @throws {MissingEnvSecretError} if a `$ENV:VAR` ref points at an unset var
 */
export async function exchangeClientCredentials(
  credentials: AgentOAuthClientCredentials,
  options: ExchangeClientCredentialsOptions = {}
): Promise<AgentOAuthTokens> {
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;

  validateTokenEndpoint(credentials.token_endpoint, { allowPrivateIp: options.allowPrivateIp });

  const clientId = resolveSecret(credentials.client_id);
  const clientSecret = resolveSecret(credentials.client_secret);
  const authMethod = credentials.auth_method ?? 'basic';

  const body = new URLSearchParams();
  body.set('grant_type', 'client_credentials');
  if (credentials.scope) {
    body.set('scope', credentials.scope);
  }
  // RFC 8707 resource indicators — emitted as one `resource` field per URI
  // so the AS receives the full list. URLSearchParams#append is the only
  // way to produce repeated keys in form encoding.
  if (credentials.resource) {
    const resources = Array.isArray(credentials.resource) ? credentials.resource : [credentials.resource];
    for (const r of resources) body.append('resource', r);
  }
  if (credentials.audience) {
    body.set('audience', credentials.audience);
  }

  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json',
  };

  if (authMethod === 'basic') {
    // RFC 6749 §2.3.1: form-urlencode ID/secret before base64 (NOT URI
    // component encoding — space is `+`, and `!'()*` must be percent-
    // encoded). Most deployed servers accept raw values too, but spec
    // compliance avoids a footgun with secrets containing those chars.
    const encoded = Buffer.from(`${formUrlEncode(clientId)}:${formUrlEncode(clientSecret)}`, 'utf-8').toString(
      'base64'
    );
    headers.authorization = `Basic ${encoded}`;
  } else {
    body.set('client_id', clientId);
    body.set('client_secret', clientSecret);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetchImpl(credentials.token_endpoint, {
      method: 'POST',
      headers,
      body: body.toString(),
      signal: controller.signal,
    });
  } catch (err) {
    if ((err as { name?: string }).name === 'AbortError') {
      throw new ClientCredentialsExchangeError(
        `Token endpoint ${credentials.token_endpoint} did not respond within ${timeoutMs}ms.`,
        'network'
      );
    }
    throw new ClientCredentialsExchangeError(
      `Failed to reach token endpoint ${credentials.token_endpoint}: ${(err as Error).message}`,
      'network'
    );
  } finally {
    clearTimeout(timeout);
  }

  const bodyText = await response.text();
  let parsed: Record<string, unknown> | undefined;
  try {
    parsed = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : undefined;
  } catch {
    // Non-JSON response; parsed stays undefined, handled below.
  }

  if (!response.ok) {
    const rawOauthError = typeof parsed?.error === 'string' ? parsed.error : undefined;
    const rawOauthDesc = typeof parsed?.error_description === 'string' ? parsed.error_description : undefined;
    const oauthError = rawOauthError ? sanitizeAsMessage(rawOauthError) : undefined;
    const oauthDesc = rawOauthDesc ? sanitizeAsMessage(rawOauthDesc) : undefined;
    const message =
      oauthError || oauthDesc
        ? `Client credentials exchange failed: ${oauthError ?? 'error'}${oauthDesc ? ` — ${oauthDesc}` : ''}`
        : `Client credentials exchange failed with HTTP ${response.status}: ${sanitizeAsMessage(bodyText) || '(empty body)'}`;
    const kind = rawOauthError ? 'oauth' : 'malformed';
    throw new ClientCredentialsExchangeError(message, kind, oauthError, oauthDesc, response.status);
  }

  if (!parsed || typeof parsed.access_token !== 'string') {
    throw new ClientCredentialsExchangeError(
      `Token endpoint returned HTTP ${response.status} but no access_token. Body: ${sanitizeAsMessage(bodyText)}`,
      'malformed',
      undefined,
      undefined,
      response.status
    );
  }

  return fromMCPTokens(parsed as unknown as OAuthTokens);
}

/**
 * Options for {@link ensureClientCredentialsTokens}.
 */
export interface EnsureClientCredentialsOptions extends ExchangeClientCredentialsOptions {
  /**
   * Storage backend used to persist refreshed tokens. Optional — if omitted,
   * tokens are only mutated on the in-memory `agent` object and the caller
   * is responsible for persisting.
   */
  storage?: OAuthConfigStorage;
  /**
   * Force a re-exchange even if the cached token looks valid. Useful after a
   * 401 in case the authorization server rotated something out-of-band.
   */
  force?: boolean;
  /**
   * Expiration skew (ms). Treat the token as expired this many milliseconds
   * before its nominal `expires_at` — protects against clock skew and
   * in-flight requests. Default: 60_000 (1 minute). The interactive auth
   * code flow uses 5 minutes; client credentials refresh is cheap (single
   * POST) so the shorter window is fine here.
   */
  expirationSkewMs?: number;
}

/**
 * In-flight refresh coalescing map. Keyed by the tuple
 * `(agent.id, token_endpoint, client_id)` — concurrent
 * `ensureClientCredentialsTokens` calls for the same credentials share a
 * single token POST instead of each racing to exchange the same secret.
 *
 * Two different `AgentConfig` objects that accidentally reuse the same
 * `id` (e.g. two tenants both creating `cli-agent`) but hold different
 * credentials won't cross-contaminate — the endpoint + client_id in the
 * key keeps them distinct.
 *
 * Cleared on completion regardless of success/failure.
 *
 * Note: this is an in-process map. Multi-process deployments (worker
 * pools, multiple CLI invocations, horizontally scaled Node servers)
 * don't coalesce across workers — each process will do its own refresh.
 * For the CLI this is fine; for high-throughput server deployments,
 * coalesce upstream at the storage layer.
 */
const inFlightRefresh = new Map<string, Promise<AgentOAuthTokens>>();

/**
 * Compute the coalesce key for `ensureClientCredentialsTokens`. `force: true`
 * uses a distinct bucket so a 401-triggered forced refresh never piggybacks
 * on a still-pending non-forced exchange — the whole point of forcing is
 * that the in-flight token is *known* stale, so awaiting it would defeat
 * the retry.
 */
function coalesceKeyFor(agent: AgentConfig, credentials: AgentOAuthClientCredentials, force: boolean): string {
  return `${force ? 'force' : 'normal'}\u0000${agent.id}\u0000${credentials.token_endpoint}\u0000${credentials.client_id}`;
}

/**
 * Ensure an agent has a valid access token, refreshing via client credentials
 * if the cached one is missing or expired. Idempotent and safe to call
 * before every request.
 *
 * Concurrent calls for the same `agent.id` are coalesced into a single
 * token POST via an in-process promise map — the common case of a
 * storyboard fan-out firing 10 tool calls in parallel does one refresh,
 * not ten.
 *
 * **Mutation:** this function writes `agent.oauth_tokens` in place. That is
 * the contract the MCP SDK's `OAuthClientProvider` pattern also uses, and
 * it lets the CLI's file-backed storage see the same object. Callers that
 * share an `AgentConfig` across different logical agents must copy first.
 *
 * Precondition: `agent.oauth_client_credentials` must be set. Throws a plain
 * Error if not — callers are expected to branch on its presence before
 * calling this.
 */
export async function ensureClientCredentialsTokens(
  agent: AgentConfig,
  options: EnsureClientCredentialsOptions = {}
): Promise<AgentOAuthTokens> {
  if (!agent.oauth_client_credentials) {
    throw new Error(
      `ensureClientCredentialsTokens called for agent '${agent.id}' with no oauth_client_credentials configured.`
    );
  }

  const skew = options.expirationSkewMs ?? 60_000;
  const cached = agent.oauth_tokens;
  const cachedIsValid =
    !options.force &&
    cached?.access_token &&
    (!cached.expires_at || new Date(cached.expires_at).getTime() - Date.now() > skew);

  if (cachedIsValid) {
    return cached!;
  }

  const coalesceKey = coalesceKeyFor(agent, agent.oauth_client_credentials, options.force === true);
  const existing = inFlightRefresh.get(coalesceKey);
  if (existing) {
    const tokens = await existing;
    agent.oauth_tokens = tokens;
    return tokens;
  }

  const exchange = (async () => {
    try {
      const tokens = await exchangeClientCredentials(agent.oauth_client_credentials!, {
        fetch: options.fetch,
        timeoutMs: options.timeoutMs,
        allowPrivateIp: options.allowPrivateIp,
      });
      agent.oauth_tokens = tokens;
      if (options.storage) {
        await options.storage.saveAgent(agent);
      }
      return tokens;
    } finally {
      inFlightRefresh.delete(coalesceKey);
    }
  })();

  inFlightRefresh.set(coalesceKey, exchange);
  return exchange;
}
