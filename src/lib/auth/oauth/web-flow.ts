/**
 * Web (server-side) OAuth flow helpers for `@adcp/sdk`.
 *
 * Companion to `CLIFlowHandler` for environments where `/oauth/start` and
 * `/oauth/callback` may be served by different processes. Discovery, PKCE,
 * URL construction, and token exchange are delegated to the MCP SDK's
 * `client/auth.js` primitives so this module is glue plus a pending-flow
 * store interface — not reimplemented protocol logic.
 *
 * Wire contract:
 *   - An operator `resourceOverride` takes precedence for legacy or
 *     non-conformant integrations. Otherwise PRM (RFC 9728) is consulted;
 *     `prm.resource` is the source of truth for the RFC 8707 `resource`
 *     indicator. We fall back to
 *     `resourceUrlFromServerUrl(agent.agent_uri)` only when the resource
 *     server does not implement PRM (404). Connection / parse / 5xx
 *     errors throw `ProtectedResourceMetadataError` — never silently
 *     downgrade to local guessing.
 *   - Without a trusted override, `prm.resource` must share an origin with
 *     the agent URL; the MCP SDK's `checkResourceAllowed` guards against a
 *     poisoned PRM pointing the audience at a third party.
 *   - AS URL = `prm.authorization_servers[0]` when PRM is present, else
 *     the agent origin.
 *   - Scope priority: caller-supplied `scopeHint` (e.g. from a 401
 *     `WWW-Authenticate` challenge, per SEP-835) > `prm.scopes_supported`
 *     > `clientMetadata.scope`.
 *   - Refresh is NOT this module's concern. Once `oauth_tokens` are
 *     persisted, `MCPOAuthProvider` handles refresh on the next agent
 *     call and the MCP SDK forwards `resource` into the refresh request.
 *     Callers who DIY refresh against `oauth_tokens` are responsible for
 *     forwarding `resource` themselves.
 */

import { randomBytes } from 'crypto';
import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  exchangeAuthorization,
  registerClient,
  startAuthorization,
} from '@modelcontextprotocol/sdk/client/auth.js';
import { checkResourceAllowed, resourceUrlFromServerUrl } from '@modelcontextprotocol/sdk/shared/auth-utils.js';
import type {
  AuthorizationServerMetadata,
  OAuthClientInformation,
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthProtectedResourceMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

import type { AgentConfig, OAuthConfigStorage } from './types';
import { DEFAULT_CLIENT_METADATA, fromMCPClientInfo, fromMCPTokens, OAuthError, toMCPClientInfo } from './types';
import { validateOAuthResourceUrl } from './resource-url';
import { ssrfSafeFetch } from '../../net/ssrf-fetch';

/**
 * Default TTL for a pending web flow row. RFC 6749 §10.12 recommends
 * short-lived state; 10 minutes covers slow-typing users without leaving
 * the PKCE verifier on disk longer than necessary.
 */
export const DEFAULT_WEB_FLOW_TTL_MS = 10 * 60 * 1000;

/**
 * State persisted between `/oauth/start` and `/oauth/callback`.
 *
 * `codeVerifier` is a PKCE secret. Store implementations MUST encrypt it
 * at rest if persistence crosses a trust boundary (shared DB, cross-tenant
 * Redis, etc.).
 *
 * `carry` is preserved verbatim and round-tripped to the callback. It
 * MUST be JSON-serializable, MUST NOT contain secrets, and MUST be
 * treated as attacker-influenced data (the caller typically populates it
 * from the `/start` request).
 */
export interface PendingWebFlow {
  state: string;
  agentId: string;
  agentUrl: string;
  codeVerifier: string;
  redirectUri: string;
  resource?: string;
  /** Explicit operator override, persisted separately so refresh can retain it. */
  resourceOverride?: string;
  /** Mutation requested by this flow. Absent on legacy rows and preserve-only flows. */
  resourceOverrideAction?: 'set' | 'clear';
  /** Value observed at flow start; used to reject concurrent operator edits. */
  resourceOverrideSnapshot?: string | null;
  scope?: string;
  authorizationServerUrl: string;
  /** Persist as JSON (e.g. Postgres `jsonb`); contents are MCP SDK-typed. */
  clientInformation: OAuthClientInformation;
  createdAt: Date;
  expiresAt: Date;
  /** JSON-serializable, no secrets, attacker-influenced. */
  carry?: Record<string, unknown>;
}

/**
 * Persistence interface for in-flight web OAuth flows.
 *
 * Canonical implementations:
 *
 * Postgres:
 * ```sql
 * INSERT INTO pending_oauth_flows (state, payload, expires_at)
 *   VALUES ($1, $2, $3);
 * -- consume:
 * DELETE FROM pending_oauth_flows
 *   WHERE state = $1 AND expires_at > now()
 *   RETURNING payload;
 * ```
 *
 * Redis:
 * ```
 * SET pending:flow:<state> <payload> EX 600 NX     -- put
 * GETDEL pending:flow:<state>                      -- consume
 * ```
 *
 * `consume` MUST be a single atomic operation that deletes and returns the
 * row (or returns null). A `SELECT` followed by a separate `DELETE` is a
 * replay vulnerability and DOES NOT satisfy this contract — a callback
 * replayed before the first one commits would mint two tokens.
 *
 * `consume` MUST treat expired rows as absent (return null) and SHOULD
 * delete them on read so a separate sweep is not strictly required.
 *
 * **Tradeoff: consume runs before token exchange.** `completeWebOAuthFlow`
 * consumes the pending row before attempting `exchangeAuthorization`. If
 * the AS returns a transient 5xx (or the network blips between us and the
 * AS), the row is gone and the user must restart from `/oauth/start`.
 * This is the right call for `invalid_grant` (replay protection — the
 * authorization code is one-shot at the AS regardless), but it means
 * transient AS failures cost the user a click. Revisit only if you see
 * real retry-loss in the field.
 */
export interface PendingWebFlowStore {
  /** Insert a new flow. MUST reject duplicate `state`. */
  put(flow: PendingWebFlow): Promise<void>;
  /**
   * Atomic delete-and-return. MUST NOT return the same row twice.
   * Returns null if the row is absent or expired.
   */
  consume(state: string): Promise<PendingWebFlow | null>;
  /** Optional housekeeping for expired rows that were never claimed. */
  cleanupExpired?(): Promise<number>;
}

/** @deprecated Renamed to `PendingWebFlowStore`. */
export type PendingFlowStore = PendingWebFlowStore;

export class InvalidOrExpiredFlowError extends OAuthError {
  constructor(state: string) {
    super(`OAuth flow not found or expired (state=${state})`, 'invalid_or_expired_flow');
    this.name = 'InvalidOrExpiredFlowError';
  }
}

export class StateMismatchError extends OAuthError {
  constructor() {
    super('OAuth state does not match the value the caller bound to this session', 'state_mismatch');
    this.name = 'StateMismatchError';
  }
}

export class TokenExchangeError extends OAuthError {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string,
    /**
     * RFC 6749 §5.2 error code when the authorization server returned a
     * standard error envelope (`invalid_grant`, `invalid_client`, etc.).
     * Undefined when the AS returned a non-OAuth-shaped failure.
     */
    public readonly oauthErrorCode?: string
  ) {
    super(message, 'token_exchange_failed');
    this.name = 'TokenExchangeError';
  }
}

export class ProtectedResourceMetadataError extends OAuthError {
  constructor(message: string) {
    super(message, 'protected_resource_metadata_error');
    this.name = 'ProtectedResourceMetadataError';
  }
}

export class AgentVanishedDuringFlowError extends OAuthError {
  constructor(agentId: string) {
    super(
      `Agent ${agentId} could not be loaded from storage during token persistence; tokens were not saved`,
      'agent_vanished_during_flow',
      agentId
    );
    this.name = 'AgentVanishedDuringFlowError';
  }
}

export class AgentChangedDuringFlowError extends OAuthError {
  constructor(agentId: string) {
    super(
      `Agent ${agentId} changed while OAuth authorization was pending; tokens were not saved`,
      'agent_changed_during_flow',
      agentId
    );
    this.name = 'AgentChangedDuringFlowError';
  }
}

export class ConfidentialClientNotAllowedError extends OAuthError {
  constructor(agentId: string | undefined) {
    super(
      'Authorization server issued a confidential client (client_secret) during dynamic registration. ' +
        'Pass `allowConfidentialClient: true` if you intend to persist a long-lived AS credential to your agent storage.',
      'confidential_client_not_allowed',
      agentId
    );
    this.name = 'ConfidentialClientNotAllowedError';
  }
}

export class BrowserBindingRequiredError extends OAuthError {
  constructor() {
    super(
      'completeWebOAuthFlow requires expectedState by default — pass the state value from the session cookie ' +
        'set at /oauth/start, or set allowUnboundState:true only for a trusted non-browser flow',
      'browser_binding_required'
    );
    this.name = 'BrowserBindingRequiredError';
  }
}

export interface StartWebFlowOptions {
  /** Agent the flow is for. Must include `agent_uri`. */
  agent: AgentConfig;
  /** Absolute URL of the consumer's `/callback` route (must match what the AS sees). */
  redirectUri: string;
  /** Where to persist the pending flow until callback. */
  pendingFlowStore: PendingWebFlowStore;
  /** When provided, dynamic-registration results land in `agent.oauth_client`. */
  agentStorage?: OAuthConfigStorage;
  /**
   * Free-form caller payload, round-tripped to `completeWebOAuthFlow`.
   * Must be JSON-serializable. Do not store secrets here. Treated as
   * attacker-influenced — validate before reflecting (e.g. via
   * {@link safeReturnTo} for redirect targets).
   */
  carry?: Record<string, unknown>;
  /**
   * Scope hint (highest priority per SEP-835). Pass through the `scope`
   * value from a prior 401 `WWW-Authenticate` challenge if you have one.
   */
  scopeHint?: string;
  /**
   * Operator-supplied RFC 8707 resource override. Takes precedence over
   * `prm.resource` and the agent-URL-derived fallback, and is sent during
   * both authorization and code exchange. Pass `null` to explicitly clear a
   * persisted override and return to metadata/agent-URL discovery.
   */
  resourceOverride?: string | null;
  /**
   * Non-standard Auth0-compatible audience parameter. Sent only to the
   * authorization endpoint. Prefer `resourceOverride` for RFC 8707 servers.
   */
  audience?: string;
  /** Permit an HTTP resource override for local development. Default false. */
  allowHttp?: boolean;
  /** Override flow TTL. Default: {@link DEFAULT_WEB_FLOW_TTL_MS}. */
  ttlMs?: number;
  /** Override the random-state generator (defaults to 32 bytes base64url). */
  generateState?: () => string;
  /**
   * Override with a fetch that performs its own connect-time DNS pinning.
   * Intended for controlled tests or a hardened egress proxy.
   */
  trustedFetchFn?: typeof fetch;
  /** @deprecated Rename to `trustedFetchFn`; the custom transport must pin DNS. */
  fetch?: typeof fetch;
  /**
   * Override base client metadata. `redirect_uris` is always replaced
   * with `[redirectUri]` regardless of what's passed here.
   */
  clientMetadata?: Partial<OAuthClientMetadata>;
  /**
   * Permit the AS to register a confidential client (i.e. one that
   * returns a `client_secret` from dynamic registration). Default false:
   * if the AS issues a secret we throw {@link ConfidentialClientNotAllowedError}
   * rather than silently persisting a long-lived credential to your
   * agent storage.
   */
  allowConfidentialClient?: boolean;
}

export interface StartWebFlowResult {
  authorizationUrl: string;
  state: string;
  expiresAt: Date;
}

export interface CompleteWebFlowOptions {
  state: string;
  code: string;
  pendingFlowStore: PendingWebFlowStore;
  /** When provided, the issued tokens are persisted to `agent.oauth_tokens`. */
  agentStorage?: OAuthConfigStorage;
  /** Caller-owned fetch that performs its own connect-time DNS pinning. */
  trustedFetchFn?: typeof fetch;
  /** @deprecated Rename to `trustedFetchFn`; the custom transport must pin DNS. */
  fetch?: typeof fetch;
  /** Permit HTTP/private OAuth endpoints for local development. Default false. */
  allowHttp?: boolean;
  /**
   * The caller-bound expected state (e.g. from a session cookie set at
   * `/oauth/start`). Must equal `state`; mismatch throws
   * {@link StateMismatchError}. Omission fails closed unless the caller
   * explicitly sets `allowUnboundState`.
   */
  expectedState?: string;
  /**
   * Explicit compatibility escape hatch for non-browser flows that cannot
   * bind state to a session. Default false. Do not enable for browser callbacks.
   */
  allowUnboundState?: boolean;
  /** @deprecated Browser binding is now required by default. */
  requireBrowserBinding?: boolean;
}

export interface CompleteWebFlowResult {
  agentId: string;
  agentUrl: string;
  tokens: OAuthTokens;
  carry?: Record<string, unknown>;
  /** True if `agentStorage` was provided AND `saveAgent` succeeded. */
  persisted: boolean;
}

/**
 * Begin a web OAuth flow. Returns the authorization URL the consumer
 * should redirect the browser to. Persists the PKCE verifier and other
 * flow state via `pendingFlowStore.put` so a different process can complete it.
 */
export async function startWebOAuthFlow(opts: StartWebFlowOptions): Promise<StartWebFlowResult> {
  const {
    agent,
    redirectUri,
    pendingFlowStore,
    agentStorage,
    carry,
    scopeHint,
    resourceOverride: requestedResourceOverride,
    audience,
    allowHttp = false,
    ttlMs = DEFAULT_WEB_FLOW_TTL_MS,
    generateState,
    trustedFetchFn,
    fetch: legacyFetchFn,
    clientMetadata: clientMetadataOverrides,
    allowConfidentialClient = false,
  } = opts;
  const fetchFn = resolveTrustedOAuthFetch(trustedFetchFn, legacyFetchFn);

  if (!agent.agent_uri) {
    throw new OAuthError('Agent missing agent_uri', 'invalid_agent', agent.id);
  }

  const resourceOverrideAction =
    requestedResourceOverride === null ? 'clear' : requestedResourceOverride !== undefined ? 'set' : undefined;
  const rawResourceOverride =
    requestedResourceOverride === null ? undefined : (requestedResourceOverride ?? agent.oauth_resource);
  const resourceOverride = rawResourceOverride
    ? validateOAuthResourceUrl(rawResourceOverride, { allowHttp }).href
    : undefined;

  const guardedFetch = createSsrfSafeOAuthFetch(fetchFn, allowHttp);
  const prm = await tryDiscoverPRM(agent.agent_uri, guardedFetch);
  if (!resourceOverride && prm?.resource) {
    assertPrmResourceMatchesAgentOrigin(agent.agent_uri, prm.resource);
  }

  const asUrl = resolveAuthorizationServerUrl(agent.agent_uri, prm, allowHttp);

  const asMetadata = await discoverAuthorizationServerMetadata(asUrl.toString(), { fetchFn: guardedFetch });
  if (!asMetadata) {
    throw new OAuthError(`No OAuth metadata at ${asUrl.toString()}`, 'no_authorization_server_metadata', agent.id);
  }

  const resource = resourceOverride
    ? new URL(resourceOverride)
    : prm?.resource
      ? new URL(prm.resource)
      : resourceUrlFromServerUrl(new URL(agent.agent_uri));

  const baseClientMetadata: OAuthClientMetadata = {
    ...DEFAULT_CLIENT_METADATA,
    ...clientMetadataOverrides,
    redirect_uris: [redirectUri],
  };

  const scope = scopeHint ?? prm?.scopes_supported?.join(' ') ?? baseClientMetadata.scope;

  const clientInformation = await resolveClientInformation({
    agent,
    agentStorage,
    asUrl,
    asMetadata,
    clientMetadata: baseClientMetadata,
    fetchFn: guardedFetch,
    allowConfidentialClient,
  });

  const state = (generateState ?? defaultGenerateState)();
  const { authorizationUrl, codeVerifier } = await startAuthorization(asUrl.toString(), {
    metadata: asMetadata,
    clientInformation,
    redirectUrl: redirectUri,
    scope,
    state,
    resource,
  });
  if (audience) {
    authorizationUrl.searchParams.set('audience', audience);
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);
  const flow: PendingWebFlow = {
    state,
    agentId: agent.id,
    agentUrl: agent.agent_uri,
    codeVerifier,
    redirectUri,
    resource: resource.href,
    resourceOverride,
    resourceOverrideAction,
    resourceOverrideSnapshot: agent.oauth_resource ?? null,
    scope,
    authorizationServerUrl: asUrl.toString(),
    clientInformation,
    createdAt: now,
    expiresAt,
    carry,
  };
  await pendingFlowStore.put(flow);

  return {
    authorizationUrl: authorizationUrl.toString(),
    state,
    expiresAt,
  };
}

/**
 * Finish a web OAuth flow. Atomically consumes the pending row, exchanges
 * the authorization code for tokens, and (if storage is provided)
 * persists tokens to `agent.oauth_tokens`. Returns whatever the caller
 * stashed in `carry` so the consumer can route the user appropriately.
 *
 * The pending row is consumed BEFORE `exchangeAuthorization` runs. A
 * transient AS failure leaves the user with no row to retry against and
 * they must restart from `/oauth/start`. See {@link PendingWebFlowStore}
 * for the full tradeoff discussion.
 */
export async function completeWebOAuthFlow(opts: CompleteWebFlowOptions): Promise<CompleteWebFlowResult> {
  const {
    state,
    code,
    pendingFlowStore,
    agentStorage,
    trustedFetchFn,
    fetch: legacyFetchFn,
    allowHttp = false,
    expectedState,
    allowUnboundState = false,
    requireBrowserBinding = false,
  } = opts;
  const fetchFn = resolveTrustedOAuthFetch(trustedFetchFn, legacyFetchFn);

  if (expectedState === undefined) {
    if (!allowUnboundState || requireBrowserBinding) throw new BrowserBindingRequiredError();
  } else if (expectedState !== state) {
    throw new StateMismatchError();
  }

  const flow = await pendingFlowStore.consume(state);
  if (!flow || flow.expiresAt.getTime() < Date.now()) {
    throw new InvalidOrExpiredFlowError(state);
  }

  const guardedFetch = createSsrfSafeOAuthFetch(fetchFn, allowHttp);

  let agentForPersistence: AgentConfig | undefined;
  if (agentStorage) {
    agentForPersistence = await agentStorage.loadAgent(flow.agentId);
    assertAgentUnchangedForFlow(agentForPersistence, flow);
  }

  const asMetadata = await discoverAuthorizationServerMetadata(flow.authorizationServerUrl, {
    fetchFn: guardedFetch,
  });

  let tokens: OAuthTokens;
  try {
    tokens = await exchangeAuthorization(flow.authorizationServerUrl, {
      metadata: asMetadata ?? undefined,
      clientInformation: flow.clientInformation,
      authorizationCode: code,
      codeVerifier: flow.codeVerifier,
      redirectUri: flow.redirectUri,
      resource: flow.resource ? new URL(flow.resource) : undefined,
      fetchFn: guardedFetch,
    });
  } catch (err) {
    throw wrapTokenExchangeError(err);
  }

  let persisted = false;
  if (agentStorage) {
    // Re-read after the network round trips so we do not save the stale object
    // loaded before token exchange or overwrite an edit made while the AS was
    // responding. Storage implementations that need a hard same-ID/same-URI
    // tenant guarantee should additionally make saveAgent revision-aware.
    agentForPersistence = await agentStorage.loadAgent(flow.agentId);
    assertAgentUnchangedForFlow(agentForPersistence, flow);
    agentForPersistence.oauth_tokens = fromMCPTokens(tokens);
    if (flow.resourceOverrideAction === 'set' && flow.resourceOverride) {
      agentForPersistence.oauth_resource = flow.resourceOverride;
    } else if (flow.resourceOverrideAction === 'clear') {
      delete agentForPersistence.oauth_resource;
    }
    delete agentForPersistence.oauth_code_verifier;
    await agentStorage.saveAgent(agentForPersistence);
    persisted = true;
  }

  return {
    agentId: flow.agentId,
    agentUrl: flow.agentUrl,
    tokens,
    carry: flow.carry,
    persisted,
  };
}

function assertAgentUnchangedForFlow(
  agent: AgentConfig | undefined,
  flow: PendingWebFlow
): asserts agent is AgentConfig {
  if (!agent) {
    throw new AgentVanishedDuringFlowError(flow.agentId);
  }
  if (agent.agent_uri !== flow.agentUrl) {
    throw new AgentChangedDuringFlowError(flow.agentId);
  }
  if (
    Object.prototype.hasOwnProperty.call(flow, 'resourceOverrideSnapshot') &&
    (agent.oauth_resource ?? null) !== flow.resourceOverrideSnapshot
  ) {
    throw new AgentChangedDuringFlowError(flow.agentId);
  }
}

/**
 * Validate a redirect target supplied via `carry`.
 *
 * Treats `value` as attacker-influenced. Returns a string that is safe to
 * pass to `res.redirect`, or `undefined` if the value is invalid.
 *
 * Defaults to **path-only** redirects (must start with a single `/` and
 * not be protocol-relative `//evil.example`). Pass `allowedReturnHosts`
 * to permit absolute URLs against an allowlist.
 *
 * @example
 * ```ts
 * res.redirect(safeReturnTo(carry?.return_to) ?? '/');
 * res.redirect(safeReturnTo(carry?.return_to, { allowedReturnHosts: ['app.example.com'] }) ?? '/');
 * ```
 */
export function safeReturnTo(value: unknown, options: { allowedReturnHosts?: string[] } = {}): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;

  // Path-only: must be `/...` but not `//...` (protocol-relative) or `/\...`.
  if (value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\')) {
    return value;
  }

  const allowed = options.allowedReturnHosts;
  if (!allowed || allowed.length === 0) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined;
  if (!allowed.includes(parsed.host)) return undefined;
  return parsed.toString();
}

/**
 * In-memory pending-flow store for tests and single-instance dev.
 *
 * Production deployments MUST implement `PendingWebFlowStore` against a
 * shared store (Postgres `DELETE … RETURNING`, Redis `GETDEL`) so
 * `/start` and `/callback` can hit different processes.
 */
export class InMemoryPendingFlowStore implements PendingWebFlowStore {
  private readonly flows = new Map<string, PendingWebFlow>();

  async put(flow: PendingWebFlow): Promise<void> {
    if (this.flows.has(flow.state)) {
      throw new Error(`Pending flow already exists for state ${flow.state}`);
    }
    this.flows.set(flow.state, flow);
  }

  async consume(state: string): Promise<PendingWebFlow | null> {
    const flow = this.flows.get(state);
    if (!flow) return null;
    this.flows.delete(state);
    if (flow.expiresAt.getTime() < Date.now()) return null;
    return flow;
  }

  async cleanupExpired(): Promise<number> {
    const now = Date.now();
    let removed = 0;
    for (const [state, flow] of this.flows) {
      if (flow.expiresAt.getTime() < now) {
        this.flows.delete(state);
        removed++;
      }
    }
    return removed;
  }
}

// ============================================================
// Internals
// ============================================================

/**
 * The MCP SDK reports a 404 PRM lookup with this exact message; treat it
 * as "PRM is genuinely absent" and fall back. Anything else is a
 * connection, parse, or 5xx error and is allowed to bubble.
 *
 * Source (verified against `@modelcontextprotocol/sdk@1.29.0`):
 *   `dist/esm/client/auth.js` → `discoverOAuthProtectedResourceMetadata`
 *   throws `new Error(`Resource server does not implement OAuth 2.0 Protected Resource Metadata.`)`
 *   when `response.status === 404` (or no response was returned).
 *
 * If a future MCP SDK reword this message, the test
 * "falls back to server-derived resource on a 404 PRM" at
 * `test/lib/oauth-web-flow.test.js` will fail — that test calls the real
 * SDK against a 404 fixture and is the canary for this regression.
 */
const PRM_ABSENT_MARKER = 'does not implement OAuth 2.0 Protected Resource Metadata';

async function tryDiscoverPRM(
  agentUrl: string,
  fetchFn: typeof fetch | undefined
): Promise<OAuthProtectedResourceMetadata | undefined> {
  try {
    return await discoverOAuthProtectedResourceMetadata(agentUrl, undefined, fetchFn);
  } catch (err) {
    if (err instanceof Error && err.message.includes(PRM_ABSENT_MARKER)) {
      // PRM is optional under RFC 9728 — fall back to local resource
      // derivation. Connection/parse/5xx errors fall through.
      return undefined;
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new ProtectedResourceMetadataError(`PRM discovery failed: ${message}`);
  }
}

function assertPrmResourceMatchesAgentOrigin(agentUrl: string, prmResource: string): void {
  const requested = resourceUrlFromServerUrl(new URL(agentUrl));
  if (!checkResourceAllowed({ requestedResource: requested, configuredResource: prmResource })) {
    throw new ProtectedResourceMetadataError(
      `PRM advertises resource ${prmResource} which does not share an origin/path with agent ${agentUrl}`
    );
  }
}

function resolveAuthorizationServerUrl(
  agentUrl: string,
  prm: OAuthProtectedResourceMetadata | undefined,
  allowHttp: boolean
): URL {
  const first = prm?.authorization_servers?.[0];
  let url: URL;
  try {
    url = first ? new URL(first) : new URL(new URL(agentUrl).origin);
  } catch {
    throw new ProtectedResourceMetadataError('Authorization server metadata contains an invalid URL');
  }
  if (url.username || url.password || url.hash) {
    throw new ProtectedResourceMetadataError('Authorization server URL must not contain userinfo or a fragment');
  }
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) {
    throw new ProtectedResourceMetadataError('Authorization server URL must use HTTPS');
  }
  return url;
}

let warnedLegacyOAuthFetch = false;

function resolveTrustedOAuthFetch(
  trustedFetchFn: typeof fetch | undefined,
  legacyFetchFn: typeof fetch | undefined
): typeof fetch | undefined {
  if (trustedFetchFn && legacyFetchFn && trustedFetchFn !== legacyFetchFn) {
    throw new TypeError('OAuth flow options cannot set different fetch and trustedFetchFn implementations');
  }
  if (legacyFetchFn && !warnedLegacyOAuthFetch) {
    warnedLegacyOAuthFetch = true;
    console.warn(
      '[adcp] OAuth flow option fetch is deprecated; rename it to trustedFetchFn. ' +
        'Custom fetch implementations must provide connect-time DNS pinning.'
    );
  }
  return trustedFetchFn ?? legacyFetchFn;
}

/**
 * Adapt the buffered DNS-pinning SSRF primitive to the Fetch API expected by
 * the MCP OAuth helpers. Redirects remain manual, so every endpoint is bound
 * to the validated URL and credentials are never forwarded to a second hop.
 */
function createSsrfSafeOAuthFetch(trustedFetchFn: typeof fetch | undefined, allowHttp: boolean): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const inputRequest = typeof Request !== 'undefined' && input instanceof Request ? input : undefined;
    const url = inputRequest?.url ?? input.toString();
    const method = init?.method ?? inputRequest?.method ?? 'GET';
    const headers = new Headers(inputRequest?.headers);
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));

    let body: string | Uint8Array | undefined;
    const rawBody = init?.body;
    if (typeof rawBody === 'string') body = rawBody;
    else if (rawBody instanceof URLSearchParams) body = rawBody.toString();
    else if (rawBody instanceof Uint8Array) body = rawBody;
    else if (rawBody instanceof ArrayBuffer) body = new Uint8Array(rawBody);
    else if (rawBody !== undefined && rawBody !== null) {
      throw new OAuthError('Unsupported OAuth request body type', 'oauth_fetch_body_unsupported');
    } else if (inputRequest && inputRequest.body) {
      body = new Uint8Array(await inputRequest.arrayBuffer());
    }

    const headerRecord: Record<string, string> = {};
    headers.forEach((value, key) => {
      headerRecord[key] = value;
    });

    const result = await ssrfSafeFetch(url, {
      method,
      headers: headerRecord,
      body,
      allowPrivateIp: allowHttp,
      maxBodyBytes: 1024 * 1024,
      signal: init?.signal ?? inputRequest?.signal,
      ...(trustedFetchFn ? { trustedFetchFn } : {}),
    });

    return new Response(Buffer.from(result.body), {
      status: result.status,
      headers: result.headers,
    });
  }) as typeof fetch;
}

async function resolveClientInformation(args: {
  agent: AgentConfig;
  agentStorage?: OAuthConfigStorage;
  asUrl: URL;
  asMetadata: AuthorizationServerMetadata;
  clientMetadata: OAuthClientMetadata;
  fetchFn?: typeof fetch;
  allowConfidentialClient: boolean;
}): Promise<OAuthClientInformation> {
  const { agent, agentStorage, asUrl, asMetadata, clientMetadata, fetchFn, allowConfidentialClient } = args;

  if (agent.oauth_client) {
    return toMCPClientInfo(agent.oauth_client);
  }

  if (!asMetadata.registration_endpoint) {
    throw new OAuthError(
      'Agent has no oauth_client and authorization server does not advertise dynamic client registration',
      'no_client_credentials',
      agent.id
    );
  }

  const registered: OAuthClientInformationFull = await registerClient(asUrl.toString(), {
    metadata: asMetadata,
    clientMetadata,
    fetchFn,
  });

  if (registered.client_secret && !allowConfidentialClient) {
    throw new ConfidentialClientNotAllowedError(agent.id);
  }

  if (agentStorage) {
    // Load fresh and save fresh so two concurrent /start calls for the
    // same agentId do not trample each other's `oauth_client` via a
    // shared in-memory reference.
    const fresh = (await agentStorage.loadAgent(agent.id)) ?? agent;
    fresh.oauth_client = fromMCPClientInfo(registered);
    await agentStorage.saveAgent(fresh);
  }

  return registered;
}

function defaultGenerateState(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Map an MCP SDK token-exchange failure to {@link TokenExchangeError},
 * redacting bearer/refresh tokens that some authorization servers echo
 * back in error responses for debugging.
 */
function wrapTokenExchangeError(err: unknown): TokenExchangeError {
  // The MCP SDK's `parseErrorResponse` decodes a well-formed OAuth error
  // envelope into an `OAuthError` subclass with `errorCode` (e.g.
  // `InvalidGrantError`). Malformed responses come through as
  // `ServerError` with the raw body in `message`, so the redaction pass
  // covers both cases.
  const oauthErrorCode = (err as { errorCode?: string })?.errorCode;
  const message = err instanceof Error ? err.message : String(err);
  const status = (err as { status?: number })?.status ?? 0;
  const rawBody = (err as { body?: string })?.body ?? message;
  const body = redactTokens(rawBody);
  const display = oauthErrorCode ? `${oauthErrorCode}: ${message}` : message;
  return new TokenExchangeError(`Token exchange failed: ${redactTokens(display)}`, status, body, oauthErrorCode);
}

const SENSITIVE_TOKEN_KEYS = ['access_token', 'refresh_token', 'id_token', 'token'];

/**
 * Best-effort redaction of bearer/refresh tokens from an AS error body
 * (which may be JSON, form-encoded, or freeform). Adopters MUST still
 * treat `TokenExchangeError.body` as sensitive — do not reflect it to
 * the browser or write it to access logs unredacted.
 */
function redactTokens(input: string): string {
  let out = input;
  for (const key of SENSITIVE_TOKEN_KEYS) {
    // JSON form: "key":"…"
    out = out.replace(new RegExp(`("${key}"\\s*:\\s*")[^"]*(")`, 'gi'), '$1<redacted>$2');
    // form-encoded: key=…
    out = out.replace(new RegExp(`(\\b${key}=)[^&\\s]+`, 'gi'), '$1<redacted>');
  }
  return out;
}
