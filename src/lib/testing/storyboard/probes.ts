/**
 * HTTP probes used by security-baseline storyboard tasks.
 *
 * Three synthetic tasks dispatch through here instead of the MCP client:
 *
 * - `protected_resource_metadata` — GET the agent's
 *   `/.well-known/oauth-protected-resource<mountPath>` and verify RFC 9728.
 * - `oauth_auth_server_metadata` — GET `<issuer>/.well-known/oauth-authorization-server`
 *   using the first issuer from the previous step's response. Hardened against
 *   SSRF because the URL comes from agent-controlled data.
 * - `assert_contribution` — no network; evaluates accumulated flags set by
 *   prior steps that carried `contributes_to`.
 *
 * `mcp_session_probe` joins them as the runner-selected auth probe for agents
 * that advertise none of `PROBE_TASK_ALLOWLIST` — see
 * {@link rawMcpSessionProbe}.
 */
import { randomBytes } from 'crypto';
import {
  InitializeResultSchema,
  LATEST_PROTOCOL_VERSION,
  ListToolsResultSchema,
  SUPPORTED_PROTOCOL_VERSIONS,
} from '@modelcontextprotocol/sdk/types.js';
import {
  ssrfSafeFetch,
  decodeBodyAsJsonOrText,
  SsrfRefusedError,
  isAlwaysBlocked as sharedIsAlwaysBlocked,
  isPrivateIp as sharedIsPrivateIp,
} from '../../net';
import { MCP_SESSION_PROBE_TASK } from './types';
import type { HttpProbeResult } from './types';
import type { TaskResult } from '../types';

// Timeout + body-cap defaults come from `ssrfSafeFetch` (10 s, 64 KiB).
// The probe wrappers deliberately don't override them so probe behavior
// stays in sync with the shared primitive.

/** Task names dispatched via HTTP probes (not via the MCP client). */
export const PROBE_TASKS = new Set([
  'protected_resource_metadata',
  'oauth_auth_server_metadata',
  'assert_contribution',
  'request_signing_probe',
  'fetch_brand_jwks',
  'assert_jwks_purpose',
  'expect_rate_limit_not_replayed',
  'replay_trusted_match_context_vector',
  'trusted_match_missing_auth_context_probe',
  'trusted_match_invalid_auth_context_probe',
  'trusted_match_missing_auth_identity_probe',
  'trusted_match_invalid_auth_identity_probe',
  // Runner-selected fallback when the agent advertises no allowlisted probe
  // tool. Dispatched as a complete MCP session lifecycle, never as a tool call.
  MCP_SESSION_PROBE_TASK,
]);

export { MCP_SESSION_PROBE_TASK };

// ---------------------------------------------------------------------------
// Protected-resource metadata probe
// ---------------------------------------------------------------------------

/**
 * GET `<agentUrl origin>/.well-known/oauth-protected-resource<agentUrl path>`.
 * Same-origin as the agent, so SSRF risk is bounded.
 *
 * When `allowPrivateIp` is set (matches the runner's `--allow-http` flag),
 * loopback and RFC 1918 targets are allowed so dev loops against localhost
 * agents work end-to-end.
 */
export async function probeProtectedResourceMetadata(
  agentUrl: string,
  options: { allowPrivateIp?: boolean; fetchFn?: typeof fetch } = {}
): Promise<HttpProbeResult> {
  const u = new URL(agentUrl);
  const metadataUrl = `${u.origin}/.well-known/oauth-protected-resource${u.pathname}`;
  return fetchProbe(metadataUrl, {
    allowPrivateIp: options.allowPrivateIp ?? false,
    fetchFn: options.fetchFn,
  });
}

// ---------------------------------------------------------------------------
// OAuth authorization-server metadata probe
// ---------------------------------------------------------------------------

/**
 * GET `<issuer>/.well-known/oauth-authorization-server` for the first issuer
 * named in the protected-resource metadata. Because the URL is agent-supplied,
 * this is the SSRF-hot path — {@link fetchProbe} rejects private networks,
 * non-https schemes, and unbounded responses.
 */
export async function probeOauthAuthServerMetadata(
  priorProbe: HttpProbeResult | undefined,
  options: { allowPrivateIp?: boolean; fetchFn?: typeof fetch } = {}
): Promise<HttpProbeResult> {
  if (!priorProbe || priorProbe.error) {
    return {
      url: '',
      status: 0,
      headers: {},
      body: null,
      error: 'protected_resource_metadata step missing or errored — cannot resolve issuer',
    };
  }
  const body = priorProbe.body as { authorization_servers?: unknown } | null;
  const servers = Array.isArray(body?.authorization_servers) ? (body!.authorization_servers as string[]) : [];
  if (servers.length === 0 || typeof servers[0] !== 'string') {
    return {
      url: '',
      status: 0,
      headers: {},
      body: null,
      error: 'No authorization_servers[0] found in protected-resource metadata',
    };
  }
  const issuer = servers[0].replace(/\/$/, '');
  const metadataUrl = `${issuer}/.well-known/oauth-authorization-server`;
  return fetchProbe(metadataUrl, {
    allowPrivateIp: options.allowPrivateIp ?? false,
    fetchFn: options.fetchFn,
  });
}

// ---------------------------------------------------------------------------
// Fetch with guardrails
// ---------------------------------------------------------------------------

export interface FetchProbeOptions {
  /** Allow http:// and private-IP destinations. Default false. */
  allowPrivateIp?: boolean;
  /** Override timeout for specific call sites. */
  timeoutMs?: number;
  /** Trusted scoped fetch; must enforce DNS-rebinding protection. */
  fetchFn?: typeof fetch;
}

/**
 * Perform a GET against an attacker-influenceable URL with defensive limits.
 *
 * Guardrails (RFC 9728 / RFC 8414 metadata endpoints typically live on public
 * HTTPS; anything else is suspicious):
 *   - Scheme: `https:` only by default; `http:` allowed only when
 *     `allowPrivateIp` is set. `file:`, `ftp:`, `data:`, etc. are always rejected.
 *   - DNS: resolves all A/AAAA records once, rejects if any is private, then
 *     pins the outbound connection to the validated IP. Defeats DNS rebinding
 *     where an attacker's authoritative nameserver returns a public address
 *     to our guard lookup and a private address to the connect-time lookup.
 *   - Private-IP block applies RFC 1918, loopback, link-local, IPv6 ULA,
 *     CGNAT (100.64/10), multicast, broadcast, and IPv4-mapped IPv6.
 *   - IMDS (169.254.169.254 / fe80::) stays blocked **even under
 *     `allowPrivateIp`** — no legitimate dev use for probing it.
 *   - Redirects are NOT followed (`redirect: 'manual'`).
 *   - Body capped at 64 KiB, total fetch time capped at 10 s.
 */
export async function fetchProbe(url: string, options: FetchProbeOptions = {}): Promise<HttpProbeResult> {
  try {
    const res = await ssrfSafeFetch(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      allowPrivateIp: options.allowPrivateIp ?? false,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.fetchFn ? { trustedFetchFn: options.fetchFn } : {}),
    });
    return {
      url,
      status: res.status,
      headers: res.headers,
      body: decodeBodyAsJsonOrText(res.body, res.headers['content-type']),
    };
  } catch (err) {
    return {
      url,
      status: 0,
      headers: {},
      body: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Credential generators (value_strategy)
// ---------------------------------------------------------------------------

/**
 * Generate a per-run bogus API key. Prefix is human-readable for log grep;
 * the 32 random hex bytes guarantee no allowlist collision.
 */
export function generateRandomInvalidApiKey(): string {
  return `invalid-${randomBytes(32).toString('hex')}`;
}

/**
 * Generate a per-run bogus JWT-shaped Bearer token. Emits three segments with
 * valid base64url-encoded JSON header/payload and a random signature — so
 * well-implemented validators fail at signature verification (→ 401), and
 * strict parse-time validators that reject at the structural level also fail
 * cleanly (→ 400 per RFC 6750 §3.1). Either is conformant.
 */
export function generateRandomInvalidJwt(): string {
  const header = base64url(Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const payload = base64url(
    Buffer.from(JSON.stringify({ sub: `invalid-${randomBytes(8).toString('hex')}`, aud: 'invalid-probe' }))
  );
  const signature = base64url(randomBytes(32));
  return `${header}.${payload}.${signature}`;
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ---------------------------------------------------------------------------
// Raw-MCP probe (auth-override dispatch)
// ---------------------------------------------------------------------------

let probeRequestId = 0;
const MCP_SESSION_ID_HEADER = 'mcp-session-id';
const MCP_PROTOCOL_VERSION_HEADER = 'mcp-protocol-version';

type JsonRpcEnvelope = {
  jsonrpc: '2.0';
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: { structuredContent?: unknown; content?: unknown; isError?: boolean; protocolVersion?: string };
  error?: { message?: string; code?: number };
};

interface RawJsonRpcPostResult {
  httpResult: HttpProbeResult;
  parsed?: JsonRpcEnvelope;
  parseError?: boolean;
}

async function postRawMcpJsonRpc(options: {
  agentUrl: string;
  envelope: Record<string, unknown>;
  headers: Record<string, string>;
  allowPrivateIp: boolean;
  sessionId?: string;
  protocolVersion?: string;
  responseId?: number;
  parseBody?: boolean;
  allowEmptyBody?: boolean;
  fetchFn?: typeof fetch;
  /** Run-level cancellation, composed with the fetch primitive's timeout. */
  signal?: AbortSignal;
  /** Per-request cap; defaults to `ssrfSafeFetch`'s 10 s. */
  timeoutMs?: number;
}): Promise<RawJsonRpcPostResult> {
  const {
    agentUrl,
    envelope,
    headers,
    allowPrivateIp,
    sessionId,
    protocolVersion,
    responseId,
    parseBody = true,
    allowEmptyBody = false,
  } = options;
  const httpResult: HttpProbeResult = { url: agentUrl, status: 0, headers: {}, body: null };
  try {
    const res = await ssrfSafeFetch(agentUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...withoutMcpSessionHeaders(headers),
        ...(sessionId ? { [MCP_SESSION_ID_HEADER]: sessionId } : {}),
        ...(protocolVersion ? { [MCP_PROTOCOL_VERSION_HEADER]: protocolVersion } : {}),
      },
      body: JSON.stringify(envelope),
      allowPrivateIp,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.fetchFn ? { trustedFetchFn: options.fetchFn } : {}),
    });
    httpResult.status = res.status;
    httpResult.headers = res.headers;

    const text = Buffer.from(res.body.buffer, res.body.byteOffset, res.body.byteLength).toString('utf8');
    if (!parseBody) {
      httpResult.body = text || null;
      return { httpResult };
    }
    if (allowEmptyBody && text.trim() === '') {
      httpResult.body = null;
      return { httpResult };
    }
    try {
      const parsed = parseMcpJsonRpcResponse(text, httpResult.headers['content-type'], responseId);
      httpResult.body = parsed;
      return { httpResult, parsed };
    } catch {
      httpResult.body = text;
      return { httpResult, parseError: true };
    }
  } catch (err) {
    httpResult.error = err instanceof Error ? err.message : String(err);
    return { httpResult };
  }
}

function withoutMcpSessionHeaders(headers: Record<string, string>): Record<string, string> {
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const normalized = key.toLowerCase();
    if (normalized === MCP_SESSION_ID_HEADER || normalized === MCP_PROTOCOL_VERSION_HEADER) continue;
    cleaned[key] = value;
  }
  return cleaned;
}

function parseMcpJsonRpcResponse(text: string, contentType: string | undefined, responseId?: number): JsonRpcEnvelope {
  if (contentType?.toLowerCase().includes('text/event-stream')) {
    // Streamable-HTTP MCP: the response is one or more SSE events whose
    // `data:` payloads are JSON-RPC envelopes. The spec lets a server emit
    // notifications before the final response, so choose the matching id.
    const dataLines = text.split(/\r?\n/).filter(l => l.startsWith('data:'));
    if (dataLines.length === 0) throw new Error('SSE response with no data event');
    let matched: JsonRpcEnvelope | undefined;
    let lastParsed: JsonRpcEnvelope | undefined;
    for (const line of dataLines) {
      const payload = line.slice('data:'.length).trim();
      if (!payload) continue;
      try {
        const envelope = JSON.parse(payload) as JsonRpcEnvelope;
        lastParsed = envelope;
        if (responseId !== undefined && envelope?.id === responseId) {
          matched = envelope;
          break;
        }
      } catch {
        // Skip non-JSON data lines (heartbeats, etc.); keep walking.
      }
    }
    const parsed = matched ?? lastParsed;
    if (parsed === undefined) throw new Error('SSE response had data events but none were parseable JSON');
    return parsed;
  }
  return JSON.parse(text) as JsonRpcEnvelope;
}

function taskResultFromRpc(httpResult: HttpProbeResult, rpc: JsonRpcEnvelope): TaskResult {
  if (httpResult.status >= 400) {
    return {
      success: false,
      data: undefined,
      error: rpc.error?.message ?? `HTTP ${httpResult.status}`,
      _extraction_path: 'error',
    };
  }
  if (rpc.error) {
    const code = rpc.error.code;
    return {
      success: false,
      data: undefined,
      error:
        code !== undefined
          ? `JSON-RPC error ${code}: ${rpc.error.message ?? 'no message'}`
          : (rpc.error.message ?? 'JSON-RPC error (no code)'),
      _extraction_path: 'error',
    };
  }
  const structured = rpc.result?.structuredContent;
  const hasStructured = structured !== undefined && structured !== null;
  const data = hasStructured ? structured : rpc.result?.content;
  const isError = !!rpc.result?.isError;
  const extractionPath: 'structured_content' | 'text_fallback' | 'error' | 'none' = isError
    ? 'error'
    : hasStructured
      ? 'structured_content'
      : data !== undefined && data !== null
        ? 'text_fallback'
        : 'none';
  return { success: !isError, data, _extraction_path: extractionPath };
}

function failedTaskResult(message: string): TaskResult {
  return {
    success: false,
    data: undefined,
    error: message,
    _extraction_path: 'error',
  };
}

function taskResultFromPostFailure(posted: RawJsonRpcPostResult): TaskResult {
  if (posted.parseError) {
    return failedTaskResult(
      `Non-JSON response body (content-type: ${posted.httpResult.headers['content-type'] ?? 'unknown'}).`
    );
  }
  if (posted.parsed) return taskResultFromRpc(posted.httpResult, posted.parsed);
  return failedTaskResult(posted.httpResult.error ?? `HTTP ${posted.httpResult.status}`);
}

/**
 * POST a JSON-RPC `tools/call` request to the MCP endpoint with caller-provided
 * headers. The probe first performs the Streamable HTTP initialize handshake,
 * including `notifications/initialized`, so auth probes hit the same session
 * boundary as normal MCP clients while still exposing raw HTTP status and
 * `WWW-Authenticate` headers for security storyboards.
 *
 * **Args are not secret** — must not contain credentials or PII. The server's
 * response body lands in `httpResult.body` and is written to compliance
 * reports. Outbound request body is not persisted.
 *
 * Returns an HttpProbeResult plus a synthetic TaskResult for steps that also
 * want to validate body shape — the structuredContent is unwrapped so
 * `field_present: "context"` resolves naturally.
 */
export async function rawMcpProbe(options: {
  agentUrl: string;
  toolName: string;
  args: Record<string, unknown>;
  headers?: Record<string, string>;
  /** Allow http:// and private-IP agent URLs (dev loops). Default false. */
  allowPrivateIp?: boolean;
  /** Scoped fetch implementation for every handshake and tool request. */
  fetchFn?: typeof fetch;
}): Promise<{ httpResult: HttpProbeResult; taskResult?: TaskResult }> {
  const { agentUrl, toolName, args, headers = {}, allowPrivateIp = false, fetchFn } = options;
  const initializeId = ++probeRequestId;
  const initialize = await postRawMcpJsonRpc({
    agentUrl,
    envelope: {
      jsonrpc: '2.0',
      id: initializeId,
      method: 'initialize',
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'AdCP Storyboard Raw MCP Probe', version: '1.0.0' },
      },
    },
    headers,
    allowPrivateIp,
    fetchFn,
    responseId: initializeId,
  });
  if (
    initialize.httpResult.error ||
    initialize.httpResult.status >= 400 ||
    !initialize.parsed ||
    initialize.parsed.error
  ) {
    return {
      httpResult: initialize.httpResult,
      taskResult: taskResultFromPostFailure(initialize),
    };
  }
  const negotiatedProtocolVersion = initialize.parsed.result?.protocolVersion;
  if (
    typeof negotiatedProtocolVersion !== 'string' ||
    !SUPPORTED_PROTOCOL_VERSIONS.includes(negotiatedProtocolVersion)
  ) {
    return {
      httpResult: initialize.httpResult,
      taskResult: failedTaskResult(
        negotiatedProtocolVersion
          ? `Server's protocol version is not supported: ${negotiatedProtocolVersion}`
          : 'Server sent invalid initialize result: missing protocolVersion'
      ),
    };
  }

  const sessionId = initialize.httpResult.headers[MCP_SESSION_ID_HEADER];
  const initialized = await postRawMcpJsonRpc({
    agentUrl,
    envelope: {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
      params: {},
    },
    headers,
    allowPrivateIp,
    fetchFn,
    ...(sessionId && { sessionId }),
    protocolVersion: negotiatedProtocolVersion,
    allowEmptyBody: true,
  });
  if (
    initialized.httpResult.error ||
    initialized.httpResult.status >= 400 ||
    initialized.parseError ||
    initialized.parsed?.error
  ) {
    return {
      httpResult: initialized.httpResult,
      taskResult: taskResultFromPostFailure(initialized),
    };
  }

  const requestId = ++probeRequestId;
  const toolEnvelope = {
    jsonrpc: '2.0',
    id: requestId,
    method: 'tools/call',
    params: { name: toolName, arguments: args },
  };
  const posted = await postRawMcpJsonRpc({
    agentUrl,
    envelope: toolEnvelope,
    headers,
    allowPrivateIp,
    fetchFn,
    ...(sessionId && { sessionId }),
    protocolVersion: negotiatedProtocolVersion,
    responseId: requestId,
  });
  const { httpResult, parsed } = posted;
  if (httpResult.error) return { httpResult, taskResult: taskResultFromPostFailure(posted) };
  if (!parsed) {
    return {
      httpResult,
      taskResult: taskResultFromPostFailure(posted),
    };
  }
  return { httpResult, taskResult: taskResultFromRpc(httpResult, parsed) };
}

// ---------------------------------------------------------------------------
// MCP session auth probe (`mcp_session_probe` sentinel)
// ---------------------------------------------------------------------------

/** Lifecycle stage a session-probe verdict landed on. */
export type McpSessionStage = 'initialize' | 'notifications/initialized' | 'tools/list';

/**
 * Verdict for one full session attempt with one credential state.
 *
 * `detail` is drawn from a **fixed vocabulary** plus values the runner itself
 * produced (an HTTP status, a numeric JSON-RPC code). No agent-supplied string
 * is ever interpolated: a misbehaving agent that echoed the `Authorization`
 * header it received into `error.message`, `protocolVersion`, `serverInfo`, or
 * any other response field would otherwise route a credential into compliance
 * reports and CI logs — and the control attempt carries the run's *valid*
 * credential, so that leak would be the worst kind.
 */
interface McpSessionAttempt {
  /** True only when initialize + initialized + tools/list all succeeded. */
  accepted: boolean;
  /**
   * The attempt failed because this SDK cannot speak the version the agent
   * negotiated — never because of credentials. Reported separately so a
   * protocol mismatch is not presented as an auth finding.
   */
  protocolIncompatible?: boolean;
  /** Where the verdict was decided. */
  stage: McpSessionStage;
  /** Credential-free description of the verdict. */
  detail: string;
  /** The response the verdict landed on — this is the graded evidence. */
  posted: RawJsonRpcPostResult;
}

async function postMcpLifecycleRequest(options: {
  agentUrl: string;
  envelope: Record<string, unknown>;
  headers: Record<string, string>;
  allowPrivateIp: boolean;
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  sessionId?: string;
  protocolVersion?: string;
  responseId?: number;
  allowEmptyBody?: boolean;
}): Promise<RawJsonRpcPostResult> {
  return postRawMcpJsonRpc({
    agentUrl: options.agentUrl,
    envelope: options.envelope,
    headers: options.headers,
    allowPrivateIp: options.allowPrivateIp,
    fetchFn: options.fetchFn,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
    ...(options.protocolVersion !== undefined ? { protocolVersion: options.protocolVersion } : {}),
    ...(options.responseId !== undefined ? { responseId: options.responseId } : {}),
    ...(options.allowEmptyBody !== undefined ? { allowEmptyBody: options.allowEmptyBody } : {}),
  });
}

/**
 * Credential-free description of a rejected JSON-RPC exchange.
 *
 * `expectResponseBody: false` is for `notifications/initialized`, where the
 * conformant answer is `202 Accepted` with an empty body — an absent envelope
 * there is success, not a parse failure.
 */
function rejectionDetail(
  posted: RawJsonRpcPostResult,
  options: { expectResponseBody?: boolean; expectedId?: number } = {}
): string | undefined {
  const { expectResponseBody = true, expectedId } = options;
  const { httpResult, parsed, parseError } = posted;
  if (httpResult.error) return 'transport error';
  if (httpResult.status >= 400) return `HTTP ${httpResult.status}`;
  if (parseError || (expectResponseBody && !parsed)) return 'unparseable JSON-RPC response';
  // A response that does not correlate to the request is not an answer. Without
  // this an agent could return someone else's success envelope — or a bare
  // notification — and have the control graded as accepted.
  if (parsed !== undefined && expectedId !== undefined) {
    if (parsed.jsonrpc !== '2.0') return 'response is not a JSON-RPC 2.0 envelope';
    if (parsed.id !== expectedId) return 'response id does not correlate to the request';
  }
  if (parsed?.error) {
    // `error.code` only when it is genuinely numeric — never `error.message`,
    // and never a stringified agent-supplied value.
    return typeof parsed.error.code === 'number'
      ? `JSON-RPC error code ${parsed.error.code}`
      : 'JSON-RPC error response';
  }
  return undefined;
}

/**
 * Terminate a Streamable HTTP session per the MCP transport spec's
 * session-management guidance (`DELETE` with `Mcp-Session-Id`).
 *
 * Best effort by design: servers that do not support explicit termination
 * answer 405, and a probe must not turn cleanup into a verdict. Failures are
 * swallowed — the caller's grading has already been decided.
 */
async function terminateMcpSession(options: {
  agentUrl: string;
  headers: Record<string, string>;
  sessionId: string;
  protocolVersion?: string;
  allowPrivateIp: boolean;
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<void> {
  try {
    await ssrfSafeFetch(options.agentUrl, {
      method: 'DELETE',
      headers: {
        accept: 'application/json, text/event-stream',
        ...withoutMcpSessionHeaders(options.headers),
        [MCP_SESSION_ID_HEADER]: options.sessionId,
        ...(options.protocolVersion ? { [MCP_PROTOCOL_VERSION_HEADER]: options.protocolVersion } : {}),
      },
      allowPrivateIp: options.allowPrivateIp,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.fetchFn ? { trustedFetchFn: options.fetchFn } : {}),
    });
  } catch {
    // Cleanup is advisory; never let it influence the probe's result.
  }
}

/**
 * Drive one complete MCP session lifecycle with a single credential state and
 * report where the agent's auth decision landed.
 *
 * `initialize` → `notifications/initialized` → `tools/list` → `DELETE`.
 *
 * Probing all the way through `tools/list` is what makes the verdict
 * independent of the agent's enforcement point: a server that authenticates
 * the Streamable HTTP session rejects at `initialize`, one that authenticates
 * each operation rejects at `tools/list`, and both are reported as rejections
 * with the rejecting response as evidence. A server that serves `tools/list`
 * with no credential is reported as accepted, which {@link rawMcpSessionProbe}
 * then refuses to treat as rejection evidence — so a fail-open agent fails
 * visibly instead of being silently skipped.
 *
 * Every parameter is MCP-defined (`tools/list` takes only an optional
 * `cursor`), so no agent-authored request schema can 400 the probe before the
 * auth layer runs. Results are validated against the official SDK's
 * `InitializeResultSchema` / `ListToolsResultSchema`.
 */
async function runMcpSessionLifecycle(options: {
  agentUrl: string;
  headers: Record<string, string>;
  allowPrivateIp: boolean;
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<McpSessionAttempt> {
  const { agentUrl, headers, allowPrivateIp, fetchFn, signal, timeoutMs } = options;
  const perRequest = { agentUrl, headers, allowPrivateIp, fetchFn, signal, timeoutMs };

  const initializeId = ++probeRequestId;
  const initialize = await postMcpLifecycleRequest({
    ...perRequest,
    envelope: {
      jsonrpc: '2.0',
      id: initializeId,
      method: 'initialize',
      // Protocol-defined parameters only — sourced from the official
      // @modelcontextprotocol/sdk constants, never from agent-authored schemas.
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'AdCP Storyboard MCP Session Probe', version: '1.0.0' },
      },
    },
    responseId: initializeId,
  });

  // Capture the session id before any early return. A server can issue one on
  // a 200 whose body then fails schema or version validation; without this the
  // probe would abandon a live session on those paths.
  const sessionId = initialize.httpResult.headers[MCP_SESSION_ID_HEADER];
  let negotiatedProtocolVersion: string | undefined;
  try {
    const initializeRejection = rejectionDetail(initialize, { expectedId: initializeId });
    if (initializeRejection !== undefined) {
      return { accepted: false, stage: 'initialize', detail: initializeRejection, posted: initialize };
    }
    if (!InitializeResultSchema.safeParse(initialize.parsed?.result).success) {
      return {
        accepted: false,
        stage: 'initialize',
        detail: 'initialize result did not match the MCP InitializeResult schema',
        posted: initialize,
      };
    }
    const negotiated = initialize.parsed?.result?.protocolVersion;
    if (typeof negotiated !== 'string' || !SUPPORTED_PROTOCOL_VERSIONS.includes(negotiated)) {
      // Per the MCP lifecycle the client offers its latest version and the
      // server may answer with another it supports; a version this SDK does
      // not implement is a *protocol compatibility* problem, not an auth
      // verdict, and is labelled as such so nobody reads it as a credential
      // rejection. Widening the accepted set would mean speaking a wire
      // version we do not implement — the remedy is an SDK bump, not a
      // looser probe. The value itself is agent-controlled, so it is
      // described rather than echoed.
      return {
        accepted: false,
        protocolIncompatible: true,
        stage: 'initialize',
        detail:
          `agent negotiated a protocolVersion this SDK does not implement (offered ` +
          `${LATEST_PROTOCOL_VERSION}; supports ${SUPPORTED_PROTOCOL_VERSIONS.length} versions)`,
        posted: initialize,
      };
    }
    negotiatedProtocolVersion = negotiated;

    const initialized = await postMcpLifecycleRequest({
      ...perRequest,
      envelope: { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
      ...(sessionId ? { sessionId } : {}),
      protocolVersion: negotiatedProtocolVersion,
      allowEmptyBody: true,
    });
    const initializedRejection = rejectionDetail(initialized, { expectResponseBody: false });
    if (initializedRejection !== undefined) {
      return {
        accepted: false,
        stage: 'notifications/initialized',
        detail: initializedRejection,
        posted: initialized,
      };
    }

    const listId = ++probeRequestId;
    const list = await postMcpLifecycleRequest({
      ...perRequest,
      envelope: { jsonrpc: '2.0', id: listId, method: 'tools/list', params: {} },
      ...(sessionId ? { sessionId } : {}),
      protocolVersion: negotiatedProtocolVersion,
      responseId: listId,
    });
    const listRejection = rejectionDetail(list, { expectedId: listId });
    if (listRejection !== undefined) {
      return { accepted: false, stage: 'tools/list', detail: listRejection, posted: list };
    }
    if (!ListToolsResultSchema.safeParse(list.parsed?.result).success) {
      return {
        accepted: false,
        stage: 'tools/list',
        detail: 'tools/list result did not match the MCP ListToolsResult schema',
        posted: list,
      };
    }
    return { accepted: true, stage: 'tools/list', detail: `HTTP ${list.httpResult.status}`, posted: list };
  } finally {
    if (sessionId) {
      await terminateMcpSession({
        agentUrl,
        headers,
        sessionId,
        ...(negotiatedProtocolVersion ? { protocolVersion: negotiatedProtocolVersion } : {}),
        allowPrivateIp,
        fetchFn,
        ...(signal ? { signal } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      });
    }
  }
}

/**
 * Whether a credential is available to prove this endpoint accepts one, and
 * that it is the right *kind* of credential for the mechanism under test.
 *
 * Required (not optional) on {@link rawMcpSessionProbe} so no caller can omit
 * it and silently receive a conclusive verdict:
 *
 * - `credential` — drive a control lifecycle with these valid credentials.
 * - `probe_is_valid_credential` — the credential under test *is* the run's
 *   valid credential (a positive probe), so its own acceptance is the
 *   evidence and a separate control would prove nothing.
 * - `unavailable` — no credential of the required kind is configured. A
 *   rejection then cannot be distinguished from an endpoint that refuses
 *   everything, so the probe reports inconclusive. `reason` / `remedy` come
 *   from the caller, which owns mechanism policy.
 */
export type McpSessionProbeControl =
  | { kind: 'credential'; headers: Record<string, string> }
  | { kind: 'probe_is_valid_credential' }
  | { kind: 'unavailable'; reason: string; remedy: string };

/**
 * Probe an MCP agent's auth enforcement with a complete session lifecycle —
 * the auth probe for agents that advertise none of `PROBE_TASK_ALLOWLIST`
 * (adcp-client#2940).
 *
 * See {@link runMcpSessionLifecycle} for the request sequence. The probe never
 * reaches an AdCP tool handler and never mutates agent state: `tools/list` is
 * a read-only protocol operation, and the session it opens is explicitly
 * terminated. Transport is the same SSRF-bounded `postRawMcpJsonRpc` /
 * `ssrfSafeFetch` primitive the other raw security probes use.
 *
 * ## Credential discrimination (fail-closed)
 *
 * A rejection is only evidence that the agent validates credentials if a
 * *valid* credential completes the same lifecycle on the same endpoint — an
 * endpoint that refuses everything (down, firewalled, wrong tenant, gateway
 * misconfiguration) is otherwise indistinguishable from one that enforces
 * credentials correctly. {@link McpSessionProbeControl} is therefore a
 * required argument, and the probe is conclusive in exactly two shapes:
 *
 * - `control.kind === 'credential'` and that control lifecycle is accepted;
 * - `control.kind === 'probe_is_valid_credential'`, where the graded attempt
 *   is itself the acceptance test.
 *
 * Otherwise — control refused, or no credential of the required kind
 * configured — the probe returns the graded attempt's response as evidence
 * **plus** an `error`, which fails the step instead of certifying an auth
 * mechanism. Correct metadata alone can never earn a contribution, and the
 * caller decides what counts as the right kind of credential so that (for
 * example) a static API key cannot stand in for an OAuth access token.
 *
 * **Credentials in, never out.** Credentials are sent to the agent and never
 * written back onto the result. Only the graded attempt's status/headers/body
 * land on `httpResult`; the control contributes only a fixed-vocabulary
 * description (see {@link McpSessionAttempt}) so an agent that echoes the
 * `Authorization` header it received cannot route the *valid* credential into
 * a report through the control's diagnostics. Echoes in the graded attempt's
 * own body are the same exposure every raw probe has, and are handled by the
 * runner's `redactSecrets` / response-header allowlist.
 */
/**
 * Credential values the probe sent, in every form an agent could echo them:
 * the full `Authorization` header value and the bare token after the scheme.
 *
 * Very short values are excluded — redacting a one- or two-character string
 * would corrupt unrelated evidence — and the list is never logged.
 */
function sentCredentialValues(...headerSets: Array<Record<string, string> | undefined>): string[] {
  const values = new Set<string>();
  for (const headers of headerSets) {
    const authorization = headers?.authorization;
    if (typeof authorization !== 'string' || authorization.length === 0) continue;
    values.add(authorization);
    const spaceAt = authorization.indexOf(' ');
    if (spaceAt > 0) values.add(authorization.slice(spaceAt + 1));
  }
  return [...values].filter(value => value.trim().length >= 8);
}

/** Replace every occurrence of a sent credential inside one string. */
function redactCredentialValuesInText(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret) continue;
    out = out.split(secret).join('[REDACTED_CREDENTIAL]');
  }
  return out;
}

/**
 * Deep value-based redaction of sent credentials across a parsed JSON body.
 *
 * The runner's `redactSecrets` matches property *names* (`token`, `api_key`,
 * …). That does not help when an agent echoes the `Authorization` header it
 * received into a value the probe legitimately records — a tool `description`,
 * a `serverInfo.name`, a `WWW-Authenticate` parameter. On the positive probe
 * the echoed value is the run's **valid** credential, so the evidence seam
 * scrubs by value before anything reaches `response` /
 * `response_record.payload`.
 *
 * Object keys are scrubbed too: a credential echoed as a key would otherwise
 * survive as a property name.
 */
function redactCredentialValuesDeep(value: unknown, secrets: readonly string[], depth = 0): unknown {
  if (secrets.length === 0 || depth > 12) return value;
  if (typeof value === 'string') return redactCredentialValuesInText(value, secrets);
  if (Array.isArray(value)) return value.map(entry => redactCredentialValuesDeep(entry, secrets, depth + 1));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      Object.defineProperty(out, redactCredentialValuesInText(key, secrets), {
        value: redactCredentialValuesDeep(entry, secrets, depth + 1),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return out;
  }
  return value;
}

/**
 * Scrub sent credentials from the one probe response that becomes evidence.
 * Body and headers both: `www-authenticate` is on the runner's response-header
 * allowlist, so an agent could route a credential into a report through an
 * `error_description` parameter.
 */
function redactCredentialsFromEvidence(httpResult: HttpProbeResult, secrets: readonly string[]): HttpProbeResult {
  if (secrets.length === 0) return httpResult;
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(httpResult.headers)) {
    headers[name] = redactCredentialValuesInText(value, secrets);
  }
  return {
    ...httpResult,
    headers,
    body: redactCredentialValuesDeep(httpResult.body, secrets),
    ...(httpResult.error !== undefined ? { error: redactCredentialValuesInText(httpResult.error, secrets) } : {}),
  };
}

export async function rawMcpSessionProbe(options: {
  agentUrl: string;
  /** Credentials under test. Empty for the unauthenticated probe. */
  headers?: Record<string, string>;
  /** Acceptance control. Required — see {@link McpSessionProbeControl}. */
  control: McpSessionProbeControl;
  /** Allow http:// and private-IP agent URLs (dev loops). Default false. */
  allowPrivateIp?: boolean;
  /** Scoped fetch implementation for every request this probe makes. */
  fetchFn?: typeof fetch;
  /** Run-level cancellation. Threaded through every request and cleanup. */
  signal?: AbortSignal;
  /** Per-request cap; defaults to `ssrfSafeFetch`'s 10 s. */
  timeoutMs?: number;
}): Promise<{
  httpResult: HttpProbeResult;
  taskResult?: TaskResult;
  stage: McpSessionStage;
  /** Fixed-vocabulary description of the graded verdict. Never agent text. */
  detail: string;
}> {
  const { agentUrl, headers = {}, control, allowPrivateIp = false, fetchFn, signal, timeoutMs } = options;
  const lifecycle = { agentUrl, allowPrivateIp, fetchFn, signal, timeoutMs };
  // The graded attempt runs first so its response is captured as evidence
  // regardless of what the control does afterwards.
  const rawGraded = await runMcpSessionLifecycle({ ...lifecycle, headers });
  // Evidence seam: everything downstream (`response`,
  // `response_record.payload`, validations) reads this response, so scrub the
  // credentials we just sent out of it by value before anyone can persist it.
  // The runner's name-based `redactSecrets` still runs on top.
  const secrets = sentCredentialValues(headers, control.kind === 'credential' ? control.headers : undefined);
  const graded: McpSessionAttempt = {
    ...rawGraded,
    posted: { ...rawGraded.posted, httpResult: redactCredentialsFromEvidence(rawGraded.posted.httpResult, secrets) },
  };
  const taskResult =
    graded.posted.parsed && !graded.posted.parseError
      ? taskResultFromRpc(graded.posted.httpResult, graded.posted.parsed)
      : taskResultFromPostFailure(graded.posted);
  const conclusive = {
    httpResult: graded.posted.httpResult,
    taskResult: {
      ...taskResult,
      ...(taskResult.data !== undefined ? { data: redactCredentialValuesDeep(taskResult.data, secrets) } : {}),
      ...(taskResult.error !== undefined ? { error: redactCredentialValuesInText(taskResult.error, secrets) } : {}),
    },
    stage: graded.stage,
    detail: graded.detail,
  };

  // A positive probe presents the run's valid credential, so its own
  // acceptance IS the evidence — but only when the lifecycle actually
  // completed. Enforced here rather than in the authored `http_status`
  // validation for the same reason as the negative direction below: a
  // storyboard that omits that check must not be able to present a refused
  // credential as a successful static-credential probe.
  if (control.kind === 'probe_is_valid_credential') {
    if (graded.accepted) return conclusive;
    if (graded.protocolIncompatible) {
      return inconclusiveSessionProbe(
        graded,
        `${graded.detail} at ${graded.stage}`,
        "Upgrade the SDK to one that implements the agent's MCP wire version, then re-run."
      );
    }
    return refusedSessionProbe(
      graded,
      `the run's valid credential did not complete the protected operation (rejected at ` +
        `${graded.stage}: ${graded.detail}), so there is no successful protected call to certify`,
      'Confirm the credential is current and that the agent accepts it on MCP protocol operations.'
    );
  }

  // Every other control kind means the graded attempt carried a credential
  // state the agent is expected to refuse (deliberately invalid, or none).
  //
  // Enforced HERE, in the primitive, rather than left to the authored
  // `http_status_in` validation: a storyboard step that omits that check —
  // a future revision, a custom `--file` storyboard, an adopter's own
  // narrative — would otherwise mint `auth_mechanism_verified` off an
  // endpoint that completed the whole lifecycle for a credential it should
  // have rejected. The probe refuses to characterise an acceptance as
  // rejection evidence no matter what the YAML asks of it.
  if (graded.accepted) {
    return refusedSessionProbe(
      graded,
      `the credential state under test completed the full session lifecycle (accepted at ` +
        `${graded.stage}: ${graded.detail}), so the agent served a protected protocol operation with ` +
        `credentials it was expected to refuse`,
      'Enforce credential validation on MCP protocol operations before treating this path as conformant.'
    );
  }

  if (graded.protocolIncompatible) {
    return inconclusiveSessionProbe(
      graded,
      `${graded.detail} at ${graded.stage}`,
      "Upgrade the SDK to one that implements the agent's MCP wire version, then re-run."
    );
  }

  if (control.kind === 'unavailable') {
    return inconclusiveSessionProbe(graded, control.reason, control.remedy);
  }

  const acceptance = await runMcpSessionLifecycle({ ...lifecycle, headers: control.headers });
  if (acceptance.accepted) return conclusive;

  if (acceptance.protocolIncompatible) {
    return inconclusiveSessionProbe(
      graded,
      `${acceptance.detail} at ${acceptance.stage}`,
      "Upgrade the SDK to one that implements the agent's MCP wire version, then re-run."
    );
  }

  return inconclusiveSessionProbe(
    graded,
    `the run's valid credential was also refused (rejected at ${acceptance.stage}: ${acceptance.detail})`,
    'Check that the credential is current and that the agent URL is reachable.'
  );
}

type SessionProbeOutcome = {
  httpResult: HttpProbeResult;
  taskResult: TaskResult;
  stage: McpSessionStage;
  detail: string;
};

function inconclusiveSessionProbe(graded: McpSessionAttempt, reason: string, remedy: string): SessionProbeOutcome {
  return sessionProbeError(
    graded,
    `MCP session auth probe is inconclusive: ${reason}, so this step's response is not evidence ` +
      `that the agent validates credentials. ${remedy}`
  );
}

function refusedSessionProbe(graded: McpSessionAttempt, reason: string, remedy: string): SessionProbeOutcome {
  return sessionProbeError(graded, `MCP session auth probe refuses this as auth evidence: ${reason}. ${remedy}`);
}

function sessionProbeError(graded: McpSessionAttempt, message: string): SessionProbeOutcome {
  return {
    httpResult: { ...graded.posted.httpResult, error: message },
    taskResult: failedTaskResult(message),
    stage: graded.stage,
    detail: graded.detail,
  };
}

// ---------------------------------------------------------------------------
// Raw-A2A probe (transport-layer diagnostics for A2A agents)
// ---------------------------------------------------------------------------

/**
 * POST a JSON-RPC 2.0 request to an A2A agent endpoint with caller-provided
 * headers. Bypasses the A2A SDK so raw HTTP status, headers, and JSON-RPC
 * error codes can be captured by storyboard diagnostics.
 *
 * Mirrors `rawMcpProbe` in structure and SSRF-safety contract. Key
 * differences from the MCP variant:
 *
 * - The caller supplies `method` + optional `params` (not a fixed `tools/call`
 *   body). A2A has no single canonical method — use `"message/send"` for most
 *   auth and error-code probes, `"tasks/get"` / `"tasks/cancel"` for lifecycle
 *   checks. **Note:** `message/send` requires `params.message` (a full A2A
 *   `Message` object with `messageId`, `role`, `kind`, `parts`). Passing
 *   `params: {}` will produce `-32602 Invalid params` from a conformant server,
 *   masking auth rejections — supply a minimal message when probing auth paths.
 * - A2A JSON-RPC error codes differ from MCP's. Notably `-32002` means
 *   `TaskNotCancelable` in A2A (not session-not-initialized). The probe
 *   surfaces raw numeric codes without protocol-specific aliasing so
 *   storyboards can assert on the exact code.
 * - SSE (streaming) responses are handled the same way as `rawMcpProbe`:
 *   `Accept: application/json` is sent; non-JSON bodies surface a distinct
 *   error so callers don't mistake an event-stream for a silent success.
 *
 * **Args are not secret** — must not contain credentials or PII. The
 * server's response body lands in `httpResult.body` and is written to
 * compliance reports.
 *
 * Returns an `HttpProbeResult` plus an optional `TaskResult` (same shape as
 * `rawMcpProbe`) so the storyboard `ValidationContext` can consume both probes
 * interchangeably. The A2A success `_extraction_path` is `'text_fallback'`
 * (not `'structured_content'`) because A2A's `result` field is a plain object,
 * not an MCP structured-content envelope.
 */
export async function rawA2aProbe(options: {
  /** Base URL of the A2A agent endpoint (e.g. `https://agent.example.com/a2a`). */
  agentUrl: string;
  /** A2A/JSON-RPC 2.0 method name (e.g. `"message/send"`, `"tasks/get"`). */
  method: string;
  /** JSON-RPC params. Defaults to `{}` so the probe always emits a valid envelope. */
  params?: Record<string, unknown>;
  headers?: Record<string, string>;
  /** Allow http:// and private-IP agent URLs (dev loops). Default false. */
  allowPrivateIp?: boolean;
}): Promise<{ httpResult: HttpProbeResult; taskResult?: TaskResult }> {
  const { agentUrl, method, params, headers = {}, allowPrivateIp = false } = options;
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: ++probeRequestId,
    method,
    params: params ?? {},
  });

  const httpResult: HttpProbeResult = { url: agentUrl, status: 0, headers: {}, body: null };
  try {
    const res = await ssrfSafeFetch(agentUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...headers,
      },
      body,
      allowPrivateIp,
    });
    httpResult.status = res.status;
    httpResult.headers = res.headers;

    const text = Buffer.from(res.body.buffer, res.body.byteOffset, res.body.byteLength).toString('utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      httpResult.body = text;
      return {
        httpResult,
        taskResult: {
          success: false,
          data: undefined,
          error: `Non-JSON response body (content-type: ${httpResult.headers['content-type'] ?? 'unknown'}).`,
          _extraction_path: 'error',
        },
      };
    }
    httpResult.body = parsed;

    const rpc = parsed as {
      result?: unknown;
      error?: { message?: string; code?: number };
    };

    if (httpResult.status >= 400) {
      return {
        httpResult,
        taskResult: {
          success: false,
          data: undefined,
          error: rpc.error?.message ?? `HTTP ${httpResult.status}`,
          _extraction_path: 'error',
        },
      };
    }

    if (rpc.error) {
      const code = rpc.error.code;
      return {
        httpResult,
        taskResult: {
          success: false,
          data: undefined,
          error:
            code !== undefined
              ? `JSON-RPC error ${code}: ${rpc.error.message ?? 'no message'}`
              : (rpc.error.message ?? 'JSON-RPC error (no code)'),
          _extraction_path: 'error',
        },
      };
    }

    const data = rpc.result;
    const extractionPath: 'text_fallback' | 'none' = data !== undefined && data !== null ? 'text_fallback' : 'none';
    return { httpResult, taskResult: { success: true, data, _extraction_path: extractionPath } };
  } catch (err) {
    httpResult.error = err instanceof Error ? err.message : String(err);
    return { httpResult };
  }
}

// IP classifiers live in `src/lib/net/address-guards.ts` so the SSRF-safe
// fetch primitive can use them without depending on the testing module.
// Re-exported here for existing import sites (storyboard-security test + any
// external probe consumers).
export const isAlwaysBlocked = sharedIsAlwaysBlocked;
export const isPrivateIp = sharedIsPrivateIp;
export { SsrfRefusedError };
