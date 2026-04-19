/**
 * `adcp diagnose-auth` — structured OAuth handshake diagnostics.
 *
 * Performs an end-to-end trace of the OAuth flow for a single MCP agent and
 * emits a structured {@link AuthDiagnosisReport} with wire-level HTTP captures,
 * decoded token claims, and ranked hypotheses about what might be wrong.
 *
 * Designed for incident diagnosis, not continuous monitoring — each run does
 * a full round-trip including (optionally) a token refresh and a `tools/call`
 * attempt, so don't call this in a tight loop.
 *
 * The runner is decoupled from the CLI so library consumers can invoke it
 * programmatically (e.g. from a monitoring agent or a test-controller fixture)
 * and render their own output.
 */
import { ssrfSafeFetch, decodeBodyAsJsonOrText, SsrfRefusedError } from '../../net';
import type { AgentConfig } from './types';
import { decodeAccessTokenClaims, parseWWWAuthenticate, validateTokenAudience } from './diagnostics';
import type { DecodedAccessToken } from './diagnostics';

/**
 * Options for {@link runAuthDiagnosis}. Most callers pass an `AgentConfig` and
 * accept the defaults.
 */
export interface DiagnoseOptions {
  /** Allow http:// and private-IP probe targets. Default false. */
  allowPrivateIp?: boolean;
  /** Skip the `tools/call` probe (e.g. if the agent doesn't expose a no-op tool). */
  skipToolCall?: boolean;
  /**
   * Name of the tool to exercise in the `tools/call` probe. Default: `get_products`.
   * This default is AdCP-specific; for non-AdCP MCP agents, pass a tool name that exists.
   */
  probeToolName?: string;
  /** Arguments to send with the probe tool call. Default: `{ brief: 'diagnose-auth probe' }`. */
  probeToolArgs?: Record<string, unknown>;
  /** Skip the token-refresh attempt even when a refresh_token is available. */
  skipRefresh?: boolean;
  /** Replace the default timeout for individual HTTP probes (ms). Default inherits from ssrfSafeFetch (10s). */
  timeoutMs?: number;
  /**
   * Include raw access_token / refresh_token / id_token values in the report.
   * Default false — tokens are replaced with `<redacted length=N>` markers so
   * that `--json` output is safe to paste into bug reports and log aggregators.
   */
  includeTokens?: boolean;
}

/** Wire-level capture of a single HTTP probe. */
export interface HttpCapture {
  url: string;
  method: string;
  /** 0 if the request never left the client (DNS failure, SSRF refusal, …). */
  status: number;
  /** Response headers with lowercased keys. */
  headers: Record<string, string>;
  /** Parsed JSON body if `content-type` is JSON, raw text otherwise, or `null` on error. */
  body: unknown;
  /** Client-side error message, if any. */
  error?: string;
}

/** One step of the diagnosis, in execution order. */
export interface DiagnosisStep {
  name:
    | 'probe_protected_resource_metadata'
    | 'probe_authorization_server_metadata'
    | 'decode_current_token'
    | 'token_refresh_attempt'
    | 'decode_refreshed_token'
    | 'list_tools_probe'
    | 'tool_call_probe';
  /** Present for HTTP steps. */
  http?: HttpCapture;
  /** Present for decode steps. Claims are unverified. */
  decodedToken?: DecodedAccessToken | null;
  /** Free-form notes attached by the step for hypothesis ranking. */
  notes?: string[];
  /** Step-level error (distinct from `http.error` — set when the step was skipped or could not run). */
  error?: string;
}

/** Rank verdict for a hypothesis. Ordered most-to-least actionable. */
export type HypothesisVerdict = 'likely' | 'possible' | 'ruled_out' | 'not_observed';

/** One ranked hypothesis about what might be wrong. */
export interface Hypothesis {
  /**
   * Stable ID. Currently `H1`, `H2`, `H4`, `H5`, `H6` — `H3` (session ID handling)
   * is reserved for a future addition. Downstream consumers should treat this as
   * an opaque string rather than exhaustively switching on it.
   */
  id: string;
  /** Short human-readable title. */
  title: string;
  /** One-line summary, tailored with evidence from this run. */
  summary: string;
  verdict: HypothesisVerdict;
  /** Supporting evidence extracted from the steps above. */
  evidence: string[];
}

/**
 * Report schema version. Bumped when breaking changes to the shape of
 * {@link AuthDiagnosisReport} land. Dashboards and downstream consumers should
 * check this before relying on specific fields.
 */
export const AUTH_DIAGNOSIS_SCHEMA_VERSION = 1 as const;

/** Full diagnosis report returned by {@link runAuthDiagnosis}. */
export interface AuthDiagnosisReport {
  /** See {@link AUTH_DIAGNOSIS_SCHEMA_VERSION}. */
  schemaVersion: typeof AUTH_DIAGNOSIS_SCHEMA_VERSION;
  /** Agent URL under test. */
  agentUrl: string;
  /** Alias from saved config, if one was provided. */
  aliasId?: string;
  /** Per-step wire captures, in execution order. */
  steps: DiagnosisStep[];
  /** Ranked hypotheses — `likely` first, then `possible`, then `ruled_out`. */
  hypotheses: Hypothesis[];
  /** Report generation timestamp (ISO-8601, UTC). */
  generatedAt: string;
}

/**
 * Run the full diagnosis. Pass an agent config with (optionally) saved
 * `oauth_tokens` to exercise a realistic handshake. Returns a structured
 * report — rendering is the caller's job (CLI renders a text summary;
 * programmatic consumers typically serialize to JSON).
 */
export async function runAuthDiagnosis(
  agent: AgentConfig,
  options: DiagnoseOptions = {}
): Promise<AuthDiagnosisReport> {
  const steps: DiagnosisStep[] = [];
  const agentUrl = agent.agent_uri;
  const allowPrivateIp = options.allowPrivateIp ?? false;
  const includeTokens = options.includeTokens ?? false;
  // Per-invocation RPC id counter so concurrent `runAuthDiagnosis` calls don't share state.
  let rpcId = 0;
  const nextRpcId = () => ++rpcId;

  // Step 1: protected-resource metadata (RFC 9728)
  const prmCapture = await probeProtectedResourceMetadata(agentUrl, allowPrivateIp, options.timeoutMs);
  steps.push({ name: 'probe_protected_resource_metadata', http: prmCapture });

  // Step 2: authorization-server metadata (RFC 8414) — derives issuer from PRM
  const asCapture = await probeAuthorizationServerMetadata(prmCapture, allowPrivateIp, options.timeoutMs);
  steps.push({ name: 'probe_authorization_server_metadata', http: asCapture });

  // Step 3: decode the current access token (if saved)
  const currentToken = agent.oauth_tokens?.access_token;
  const currentDecoded = currentToken ? decodeAccessTokenClaims(currentToken) : null;
  steps.push({
    name: 'decode_current_token',
    decodedToken: currentDecoded,
    notes: currentToken
      ? currentDecoded
        ? [`Decoded JWT with claims: ${Object.keys(currentDecoded.claims).join(', ')}`]
        : ['Saved access_token is opaque (not a JWT) — `aud` inspection is not possible']
      : ['No saved access_token'],
  });

  // Step 4: token refresh (only if we have a refresh_token AND the user didn't skip)
  let refreshedAccessToken: string | undefined;
  let refreshedDecoded: DecodedAccessToken | null = null;
  if (!options.skipRefresh && agent.oauth_tokens?.refresh_token) {
    const tokenEndpoint = extractTokenEndpoint(asCapture);
    const clientId = agent.oauth_client?.client_id;
    // Always request the agent URL as the resource indicator, even if PRM
    // advertises something different — a well-behaved client sends what it
    // actually wants to talk to, and using PRM.resource here would cause H2
    // to fire spuriously when the real problem is H1.
    const resource = agentUrl;
    if (!tokenEndpoint) {
      steps.push({
        name: 'token_refresh_attempt',
        error: 'No token_endpoint available from authorization-server metadata — cannot attempt refresh',
      });
    } else if (!clientId) {
      steps.push({
        name: 'token_refresh_attempt',
        error: 'No saved oauth_client.client_id — cannot attempt refresh without it',
      });
    } else {
      const refreshCapture = await attemptTokenRefresh({
        tokenEndpoint,
        clientId,
        clientSecret: agent.oauth_client?.client_secret,
        refreshToken: agent.oauth_tokens.refresh_token,
        resource,
        allowPrivateIp,
        timeoutMs: options.timeoutMs,
      });
      // Capture the raw access_token string BEFORE redaction so we can still
      // decode claims for H2 analysis. The report body itself uses the
      // redacted capture unless includeTokens is set.
      if (refreshCapture.status === 200 && refreshCapture.body && typeof refreshCapture.body === 'object') {
        const body = refreshCapture.body as Record<string, unknown>;
        if (typeof body.access_token === 'string') {
          refreshedAccessToken = body.access_token;
          refreshedDecoded = decodeAccessTokenClaims(refreshedAccessToken);
        }
      }
      steps.push({
        name: 'token_refresh_attempt',
        http: includeTokens ? refreshCapture : redactTokenMaterial(refreshCapture),
      });
      if (refreshedAccessToken) {
        steps.push({
          name: 'decode_refreshed_token',
          decodedToken: refreshedDecoded,
          notes: refreshedDecoded
            ? [`Decoded refreshed JWT with claims: ${Object.keys(refreshedDecoded.claims).join(', ')}`]
            : ['Refreshed access_token is opaque (not a JWT)'],
        });
      }
    }
  }

  // Step 5: unauthenticated list_tools to surface 401 + WWW-Authenticate
  const listToolsCapture = await probeListTools(agentUrl, undefined, allowPrivateIp, options.timeoutMs, nextRpcId);
  steps.push({ name: 'list_tools_probe', http: listToolsCapture });

  // Step 6: authenticated tool_call (skip if no token or if caller opts out)
  const tokenForCall = refreshedAccessToken ?? currentToken;
  if (!options.skipToolCall && tokenForCall) {
    const toolName = options.probeToolName ?? 'get_products';
    const args = options.probeToolArgs ?? { brief: 'diagnose-auth probe' };
    const toolCapture = await probeToolCall(
      agentUrl,
      tokenForCall,
      toolName,
      args,
      allowPrivateIp,
      options.timeoutMs,
      nextRpcId
    );
    steps.push({ name: 'tool_call_probe', http: toolCapture });
  } else if (!tokenForCall) {
    steps.push({
      name: 'tool_call_probe',
      error: 'No access_token available — skipping authenticated tool call probe',
    });
  }

  const hypotheses = rankHypotheses({
    agentUrl,
    steps,
    currentDecoded,
    refreshedDecoded,
  });

  return {
    schemaVersion: AUTH_DIAGNOSIS_SCHEMA_VERSION,
    agentUrl,
    aliasId: agent.id,
    steps,
    hypotheses,
    generatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

async function probeProtectedResourceMetadata(
  agentUrl: string,
  allowPrivateIp: boolean,
  timeoutMs?: number
): Promise<HttpCapture> {
  const u = new URL(agentUrl);
  const url = `${u.origin}/.well-known/oauth-protected-resource${u.pathname}`;
  return httpGet(url, allowPrivateIp, timeoutMs);
}

async function probeAuthorizationServerMetadata(
  prm: HttpCapture,
  allowPrivateIp: boolean,
  timeoutMs?: number
): Promise<HttpCapture> {
  const issuer = extractIssuer(prm);
  if (!issuer) {
    return {
      url: '',
      method: 'GET',
      status: 0,
      headers: {},
      body: null,
      error: 'protected-resource metadata did not yield an authorization_servers[0] entry',
    };
  }
  const url = `${issuer.replace(/\/$/, '')}/.well-known/oauth-authorization-server`;
  return httpGet(url, allowPrivateIp, timeoutMs);
}

async function probeListTools(
  agentUrl: string,
  bearerToken: string | undefined,
  allowPrivateIp: boolean,
  timeoutMs: number | undefined,
  nextRpcId: () => number
): Promise<HttpCapture> {
  return httpJsonRpc(agentUrl, { method: 'tools/list' }, bearerToken, allowPrivateIp, timeoutMs, nextRpcId);
}

async function probeToolCall(
  agentUrl: string,
  bearerToken: string,
  toolName: string,
  args: Record<string, unknown>,
  allowPrivateIp: boolean,
  timeoutMs: number | undefined,
  nextRpcId: () => number
): Promise<HttpCapture> {
  return httpJsonRpc(
    agentUrl,
    { method: 'tools/call', params: { name: toolName, arguments: args } },
    bearerToken,
    allowPrivateIp,
    timeoutMs,
    nextRpcId
  );
}

async function attemptTokenRefresh(options: {
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  refreshToken: string;
  resource: string;
  allowPrivateIp: boolean;
  timeoutMs?: number;
}): Promise<HttpCapture> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: options.refreshToken,
    client_id: options.clientId,
    // RFC 8707: explicitly request a token for this resource. If the AS
    // ignores this (H2), the refreshed token's aud claim will still be wrong.
    resource: options.resource,
  });
  if (options.clientSecret) body.set('client_secret', options.clientSecret);

  return httpFormPost(options.tokenEndpoint, body, options.allowPrivateIp, options.timeoutMs);
}

async function httpGet(url: string, allowPrivateIp: boolean, timeoutMs?: number): Promise<HttpCapture> {
  try {
    const res = await ssrfSafeFetch(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      allowPrivateIp,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
    return {
      url,
      method: 'GET',
      status: res.status,
      headers: res.headers,
      body: decodeBodyAsJsonOrText(res.body, res.headers['content-type']),
    };
  } catch (err) {
    return { url, method: 'GET', status: 0, headers: {}, body: null, error: formatError(err) };
  }
}

async function httpJsonRpc(
  url: string,
  rpc: { method: string; params?: unknown },
  bearerToken: string | undefined,
  allowPrivateIp: boolean,
  timeoutMs: number | undefined,
  nextRpcId: () => number
): Promise<HttpCapture> {
  const body = JSON.stringify({ jsonrpc: '2.0', id: nextRpcId(), ...rpc });
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
  };
  if (bearerToken) headers.authorization = `Bearer ${bearerToken}`;

  try {
    const res = await ssrfSafeFetch(url, {
      method: 'POST',
      headers,
      body,
      allowPrivateIp,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
    return {
      url,
      method: 'POST',
      status: res.status,
      headers: res.headers,
      body: decodeBodyAsJsonOrText(res.body, res.headers['content-type']),
    };
  } catch (err) {
    return { url, method: 'POST', status: 0, headers: {}, body: null, error: formatError(err) };
  }
}

async function httpFormPost(
  url: string,
  body: URLSearchParams,
  allowPrivateIp: boolean,
  timeoutMs?: number
): Promise<HttpCapture> {
  try {
    const res = await ssrfSafeFetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: body.toString(),
      allowPrivateIp,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
    return {
      url,
      method: 'POST',
      status: res.status,
      headers: res.headers,
      body: decodeBodyAsJsonOrText(res.body, res.headers['content-type']),
    };
  } catch (err) {
    return { url, method: 'POST', status: 0, headers: {}, body: null, error: formatError(err) };
  }
}

// ---------------------------------------------------------------------------
// Hypothesis ranking
// ---------------------------------------------------------------------------

interface RankInput {
  agentUrl: string;
  steps: DiagnosisStep[];
  currentDecoded: DecodedAccessToken | null;
  refreshedDecoded: DecodedAccessToken | null;
}

function rankHypotheses(input: RankInput): Hypothesis[] {
  const out: Hypothesis[] = [];
  const prmStep = input.steps.find(s => s.name === 'probe_protected_resource_metadata');
  const asStep = input.steps.find(s => s.name === 'probe_authorization_server_metadata');
  const listStep = input.steps.find(s => s.name === 'list_tools_probe');
  const toolStep = input.steps.find(s => s.name === 'tool_call_probe');
  const refreshStep = input.steps.find(s => s.name === 'token_refresh_attempt');

  // H1: Resource URL mismatch between well-known and agent host
  out.push(rankH1(input.agentUrl, prmStep));

  // H2: Refresh grant missing `resource` parameter (RFC 8707)
  out.push(rankH2(input.agentUrl, refreshStep, input.refreshedDecoded));

  // H4: Agent endpoint returns 401 with no WWW-Authenticate (RFC 6750 violation)
  out.push(rankH4(listStep, toolStep));

  // H5: Token `aud` claim missing or doesn't match agent URL
  out.push(rankH5(input.agentUrl, input.currentDecoded, prmStep));

  // H6: Agent endpoint doesn't validate audience (accepts token but ignores it)
  out.push(rankH6(input.agentUrl, input.currentDecoded, toolStep));

  // Order: likely > possible > ruled_out > not_observed
  const order: Record<HypothesisVerdict, number> = {
    likely: 0,
    possible: 1,
    ruled_out: 2,
    not_observed: 3,
  };
  return out.sort((a, b) => order[a.verdict] - order[b.verdict]);
}

function rankH1(agentUrl: string, prmStep?: DiagnosisStep): Hypothesis {
  const base: Hypothesis = {
    id: 'H1',
    title: 'Resource URL mismatch between well-known and agent host',
    summary: '',
    verdict: 'not_observed',
    evidence: [],
  };
  if (
    !prmStep?.http ||
    prmStep.http.status !== 200 ||
    typeof prmStep.http.body !== 'object' ||
    prmStep.http.body === null
  ) {
    base.verdict = 'not_observed';
    base.summary = 'No protected-resource metadata was retrieved — cannot compare `resource` to agent URL';
    return base;
  }
  const advertised = (prmStep.http.body as { resource?: unknown }).resource;
  if (typeof advertised !== 'string') {
    base.verdict = 'not_observed';
    base.summary = 'protected-resource metadata has no `resource` field';
    return base;
  }

  const normAdvertised = normalizeForCompare(advertised);
  const normAgent = normalizeForCompare(agentUrl);
  if (normAdvertised === normAgent) {
    base.verdict = 'ruled_out';
    base.summary = `Advertised resource matches agent URL (${advertised})`;
  } else {
    base.verdict = 'likely';
    base.summary = `Advertised resource "${advertised}" does not match agent URL "${agentUrl}"`;
    base.evidence = [
      `PRM resource: ${advertised}`,
      `Agent URL: ${agentUrl}`,
      'Fix: align the agent server config so `.well-known/oauth-protected-resource` advertises the same origin+path as the agent endpoint itself.',
    ];
  }
  return base;
}

function rankH2(
  agentUrl: string,
  refreshStep: DiagnosisStep | undefined,
  refreshedDecoded: DecodedAccessToken | null
): Hypothesis {
  const base: Hypothesis = {
    id: 'H2',
    title: 'Refresh grant missing `resource` parameter (RFC 8707)',
    summary: '',
    verdict: 'not_observed',
    evidence: [],
  };
  if (!refreshStep) {
    base.summary = 'No token refresh was attempted (skipped, missing refresh_token, or missing client registration)';
    return base;
  }
  if (refreshStep.error) {
    base.summary = `Token refresh could not run: ${refreshStep.error}`;
    return base;
  }
  if (!refreshStep.http || refreshStep.http.status !== 200) {
    base.summary = `Token refresh returned HTTP ${refreshStep.http?.status ?? 0}; cannot evaluate aud handling`;
    base.evidence = refreshStep.http ? [`Body: ${safeStringify(refreshStep.http.body)}`] : [];
    return base;
  }
  if (!refreshedDecoded) {
    base.verdict = 'possible';
    base.summary = 'Refreshed token is opaque — audience cannot be inspected from the wire';
    base.evidence = [
      'If this agent is a public resource server, an opaque token should still carry `aud` when inspected via introspection.',
    ];
    return base;
  }
  const result = validateTokenAudience(jwtFromDecoded(refreshedDecoded), agentUrl);
  if (result.ok) {
    base.verdict = 'ruled_out';
    base.summary = 'Refreshed token `aud` claim matches the expected resource — AS honors RFC 8707 `resource`';
    return base;
  }
  base.verdict = 'likely';
  base.summary = 'We asked the AS to refresh with `resource=<agent-url>` but the new token `aud` still does not match';
  base.evidence = [
    `Expected aud: ${agentUrl}`,
    `Actual aud: ${safeStringify(result.actualAudience)}`,
    'Fix: update the AS to honor RFC 8707 `resource` and emit the corresponding `aud` claim on refresh_token grants.',
  ];
  return base;
}

function rankH4(listStep?: DiagnosisStep, toolStep?: DiagnosisStep): Hypothesis {
  const base: Hypothesis = {
    id: 'H4',
    title: 'Agent endpoint returns 401 with no `WWW-Authenticate` (RFC 6750 violation)',
    summary: '',
    verdict: 'not_observed',
    evidence: [],
  };
  const unauthed = listStep?.http;
  const authed = toolStep?.http;
  const rfc6750Offender = (cap: HttpCapture | undefined) =>
    cap && cap.status === 401 && !cap.headers['www-authenticate'];

  if (rfc6750Offender(unauthed) || rfc6750Offender(authed)) {
    base.verdict = 'likely';
    base.summary = 'Agent returned 401 without a `WWW-Authenticate` header — breaks RFC 6750 §3 and RFC 9728 discovery';
    base.evidence = [];
    if (rfc6750Offender(unauthed))
      base.evidence.push(`unauthenticated tools/list: ${unauthed!.status} (no WWW-Authenticate)`);
    if (rfc6750Offender(authed))
      base.evidence.push(`authenticated tools/call: ${authed!.status} (no WWW-Authenticate)`);
    base.evidence.push('Fix: emit `WWW-Authenticate: Bearer error="…", resource_metadata="…"` on 401 responses.');
    return base;
  }

  if (
    (unauthed?.status === 401 && unauthed.headers['www-authenticate']) ||
    (authed?.status === 401 && authed.headers['www-authenticate'])
  ) {
    base.verdict = 'ruled_out';
    base.summary = 'Agent correctly emits a WWW-Authenticate challenge on 401';
    const challenge = parseWWWAuthenticate(
      unauthed?.headers['www-authenticate'] ?? authed?.headers['www-authenticate']
    );
    if (challenge) {
      base.evidence = [
        `Scheme: ${challenge.scheme}`,
        ...(challenge.error ? [`error: ${challenge.error}`] : []),
        ...(challenge.resource_metadata ? [`resource_metadata: ${challenge.resource_metadata}`] : []),
      ];
    }
    return base;
  }

  base.summary = 'No 401 was observed on either probe — cannot evaluate challenge format';
  return base;
}

function rankH5(
  agentUrl: string,
  currentDecoded: DecodedAccessToken | null,
  prmStep: DiagnosisStep | undefined
): Hypothesis {
  const base: Hypothesis = {
    id: 'H5',
    title: 'Token `aud` claim missing or does not match agent URL',
    summary: '',
    verdict: 'not_observed',
    evidence: [],
  };
  if (!currentDecoded) {
    base.summary = 'No saved access token was decodable — cannot inspect `aud`';
    return base;
  }
  // Prefer the advertised resource (PRM) when available, fall back to agent URL.
  const prmResource =
    prmStep?.http?.body && typeof (prmStep.http.body as { resource?: unknown }).resource === 'string'
      ? (prmStep.http.body as { resource: string }).resource
      : undefined;
  const expected = prmResource ?? agentUrl;
  const prmDiffersFromAgent =
    prmResource !== undefined && normalizeForCompare(prmResource) !== normalizeForCompare(agentUrl);
  const result = validateTokenAudience(jwtFromDecoded(currentDecoded), expected);
  if (result.ok) {
    base.verdict = 'ruled_out';
    base.summary = `Saved token \`aud\` matches expected resource (${expected})`;
    if (prmDiffersFromAgent) {
      base.evidence = [
        `Compared against advertised PRM resource; agent URL differs (see H1). Token is valid for the resource the AS thinks it's protecting, not for the agent URL you configured.`,
      ];
    }
    return base;
  }
  base.verdict = 'likely';
  base.summary = result.reason ?? 'Saved token audience does not match expected resource';
  base.evidence = [
    `Expected: ${expected}${prmDiffersFromAgent ? ' (from PRM; see H1 — agent URL differs)' : ''}`,
    `Actual aud: ${safeStringify(result.actualAudience ?? '(missing)')}`,
    'Fix: ensure the AS sets `aud` to the resource URL on token issuance (RFC 9068 §2.2 / RFC 8707).',
  ];
  return base;
}

function rankH6(agentUrl: string, currentDecoded: DecodedAccessToken | null, toolStep?: DiagnosisStep): Hypothesis {
  const base: Hypothesis = {
    id: 'H6',
    title: 'Agent accepts token but does not validate audience',
    summary: '',
    verdict: 'not_observed',
    evidence: [],
  };
  if (!toolStep?.http || !currentDecoded) {
    base.summary = 'Need both a decoded token and a tool_call probe to evaluate';
    return base;
  }
  if (toolStep.http.status !== 200) {
    base.verdict = 'ruled_out';
    base.summary = `tool_call returned HTTP ${toolStep.http.status} — agent did not accept the token blindly`;
    return base;
  }
  const audResult = validateTokenAudience(jwtFromDecoded(currentDecoded), agentUrl);
  if (audResult.ok) {
    base.verdict = 'ruled_out';
    base.summary = 'Token `aud` matches agent URL and tool_call succeeded — cannot distinguish from correct behavior';
    return base;
  }
  base.verdict = 'likely';
  base.summary =
    'tool_call succeeded with a token whose `aud` does not match the agent URL — agent is not enforcing audience';
  base.evidence = [
    `tool_call status: ${toolStep.http.status}`,
    `Token aud: ${safeStringify(audResult.actualAudience ?? '(missing)')}`,
    `Agent URL: ${agentUrl}`,
    'Fix: have the agent reject tokens whose `aud` does not include its own resource URL (RFC 9068).',
  ];
  return base;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractIssuer(prm: HttpCapture): string | undefined {
  if (prm.status !== 200 || !prm.body || typeof prm.body !== 'object') return undefined;
  const servers = (prm.body as { authorization_servers?: unknown }).authorization_servers;
  if (!Array.isArray(servers) || typeof servers[0] !== 'string') return undefined;
  return servers[0];
}

function extractTokenEndpoint(as: HttpCapture): string | undefined {
  if (as.status !== 200 || !as.body || typeof as.body !== 'object') return undefined;
  const endpoint = (as.body as { token_endpoint?: unknown }).token_endpoint;
  return typeof endpoint === 'string' ? endpoint : undefined;
}

function extractResourceUri(prm: HttpCapture): string | undefined {
  if (prm.status !== 200 || !prm.body || typeof prm.body !== 'object') return undefined;
  const resource = (prm.body as { resource?: unknown }).resource;
  return typeof resource === 'string' ? resource : undefined;
}

/** Fields in an OAuth token-endpoint response that should never leak to disk/logs. */
const TOKEN_MATERIAL_FIELDS = new Set(['access_token', 'refresh_token', 'id_token']);

/**
 * Redact token-bearing fields from a token-endpoint capture so that `--json`
 * output can safely be pasted into bug reports. The redacted form preserves
 * the original length (useful for "wrong length" diagnostics) without leaking
 * the secret. Set `includeTokens: true` on {@link DiagnoseOptions} to skip.
 */
function redactTokenMaterial(capture: HttpCapture): HttpCapture {
  if (!capture.body || typeof capture.body !== 'object' || Array.isArray(capture.body)) return capture;
  const body = capture.body as Record<string, unknown>;
  const redacted: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (TOKEN_MATERIAL_FIELDS.has(k) && typeof v === 'string') {
      redacted[k] = `<redacted length=${v.length}>`;
    } else {
      redacted[k] = v;
    }
  }
  return { ...capture, body: redacted };
}

function normalizeForCompare(value: string): string {
  try {
    const u = new URL(value);
    const port = u.port && !isDefaultPort(u.protocol, u.port) ? `:${u.port}` : '';
    const path = u.pathname.length > 1 && u.pathname.endsWith('/') ? u.pathname.slice(0, -1) : u.pathname;
    return `${u.protocol.toLowerCase()}//${u.hostname.toLowerCase()}${port}${path}`;
  } catch {
    return value;
  }
}

function isDefaultPort(scheme: string, port: string): boolean {
  if (scheme === 'https:' && port === '443') return true;
  if (scheme === 'http:' && port === '80') return true;
  return false;
}

function jwtFromDecoded(_decoded: DecodedAccessToken): string {
  // validateTokenAudience re-decodes from a JWT string, so we round-trip.
  // Since we already decoded this, we can't reconstruct the original signature,
  // but the validator only cares about the claims segment — so we synthesize a
  // three-segment token with the original claims and dummy header/signature.
  const h = base64url(JSON.stringify(_decoded.header));
  const c = base64url(JSON.stringify(_decoded.claims));
  return `${h}.${c}.${_decoded.signature || 'sig'}`;
}

function base64url(input: string): string {
  // `base64` output has at most 2 trailing `=` characters; the bounded form
  // `={0,2}$` avoids the polynomial-regex flag CodeQL raises on `=+$`.
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/={0,2}$/, '');
}

function formatError(err: unknown): string {
  if (err instanceof SsrfRefusedError) {
    return `SSRF guard refused: ${err.code} (${err.message})`;
  }
  return err instanceof Error ? err.message : String(err);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
