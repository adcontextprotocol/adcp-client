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
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  ErrorCode,
  LATEST_PROTOCOL_VERSION,
  McpError,
  SUPPORTED_PROTOCOL_VERSIONS,
} from '@modelcontextprotocol/sdk/types.js';
import { createAgentTransportFetch } from '../../net';
import {
  getCapturesFromError,
  withRawResponseCapture,
  wrapFetchWithCapture,
  type RawHttpCapture,
} from '../../protocols/rawResponseCapture';
import { terminateSessionBestEffort } from '../../protocols/session-termination';
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
//
// AGENTS.md is absolute: MCP goes through the official
// `@modelcontextprotocol/sdk` client, never a hand-rolled lifecycle. This
// probe therefore drives `Client.connect()` → `Client.listTools()` →
// `StreamableHTTPClientTransport.terminateSession()` and lets the SDK own
// `initialize`, `notifications/initialized`, response-id correlation, result
// schema validation and protocol-version negotiation.
//
// Two SDK-supported extension points make that compatible with security
// grading, which needs raw HTTP status and `WWW-Authenticate`:
//
//   - `StreamableHTTPClientTransportOptions.fetch` takes the repo's
//     SSRF-guarded `createAgentTransportFetch` (DNS classification,
//     connection pinning, redirect validation), wrapped in the same
//     size-limit and raw-capture layers `protocols/mcp.ts` uses.
//   - `withRawResponseCapture` records each exchange, and attaches partial
//     captures to a thrown error — which is how a 401 stays gradable even
//     though `connect()` rejects.

/**
 * Lifecycle stage a session-probe verdict landed on.
 *
 * `tools/list` is deliberately absent: MCP discovery is not an AdCP protected
 * task — `get_adcp_capabilities` is mandatory-public and the SDK's own
 * unauthenticated capability path lists tools — so a `tools/list` answer is
 * never graded evidence about this agent's authentication.
 */
export type McpSessionStage = 'initialize' | 'tools/call';

const SESSION_PROBE_CLIENT_INFO = { name: 'AdCP Storyboard MCP Session Probe', version: '1.0.0' };

/**
 * Verdict for one full session attempt with one credential state.
 *
 * `detail` is drawn from a **fixed vocabulary** plus values the runner itself
 * produced (an HTTP status, a numeric JSON-RPC code). No agent-supplied string
 * is ever interpolated — not even by way of an SDK error message: the official
 * client embeds the server's `protocolVersion` verbatim in
 * `Server's protocol version is not supported: …`, so that condition is
 * detected and re-described rather than propagated. The control attempt
 * carries the run's *valid* credential, so a leak there would be the worst
 * kind.
 */
/**
 * What the agent's answer to the selected protected tool actually was.
 *
 * - `accepted` — the tool returned a successful, tenant-scoped payload. For a
 *   deliberately-bad credential that is fail-open, not evidence of rejection.
 * - `auth_rejected` — 401/403 at `initialize` or at the `tools/call`, or an
 *   operation-level AdCP `AUTH_MISSING` / `AUTH_INVALID` inside an otherwise
 *   successful MCP envelope.
 * - `schema_or_param` — the agent refused the *shape* of the call
 *   (`INVALID_REQUEST`, a missing required parameter). Says nothing about
 *   credentials either way: the chosen target needs arguments this probe
 *   cannot synthesise.
 * - `unusable` — protocol incompatibility, malformed envelope, transport
 *   failure, timeout. A broken exchange, not an authentication result.
 */
type McpSessionVerdict = 'accepted' | 'auth_rejected' | 'schema_or_param' | 'unusable';

interface McpSessionAttempt {
  /** Classified answer for the selected protected tool. */
  verdict: McpSessionVerdict;
  /** True only when connect() and the protected tools/call both succeeded. */
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
  /** The exchange the verdict landed on — this is the graded evidence. */
  evidence: HttpProbeResult;
}

/**
 * Build an `HttpProbeResult` from a captured exchange. Mirrors the runner's
 * `httpProbeResultFromCapture` for the A2A path; duplicated rather than shared
 * because the runner imports this module, not the other way round.
 */
function httpProbeResultFromCapture(capture: RawHttpCapture): HttpProbeResult {
  const headers = Object.fromEntries(
    Object.entries(capture.headers).map(([name, value]) => [name.toLowerCase(), value])
  );
  return {
    url: capture.url,
    status: capture.status,
    headers,
    body: decodeCapturedBody(capture.body, headers['content-type']),
  };
}

/** Parse a captured body as JSON, unwrapping a Streamable HTTP SSE frame. */
function decodeCapturedBody(body: string, contentType: string | undefined): unknown {
  if (body.length === 0) return null;
  if (contentType?.toLowerCase().includes('text/event-stream')) {
    const dataLines = body
      .split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice('data:'.length).trim())
      .filter(payload => payload.length > 0);
    for (const payload of dataLines.reverse()) {
      try {
        return JSON.parse(payload);
      } catch {
        // Keep walking; fall through to the raw text below.
      }
    }
    return body;
  }
  if (contentType?.toLowerCase().includes('json')) {
    try {
      return JSON.parse(body);
    } catch {
      // Preserve malformed JSON bodies verbatim for diagnostics.
      return body;
    }
  }
  return body;
}

/** Protocol version the server negotiated, read from the capture log. */
function negotiatedVersionFromCaptures(captures: readonly RawHttpCapture[]): string | undefined {
  for (const capture of captures) {
    if (capture.requestJsonRpcMethod !== 'initialize') continue;
    const body = decodeCapturedBody(capture.body, findHeader(capture.headers, 'content-type'));
    const version = (body as { result?: { protocolVersion?: unknown } } | null)?.result?.protocolVersion;
    if (typeof version === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(version)) return version;
  }
  return undefined;
}

/** Case-insensitive header lookup over a capture's recorded headers. */
function findHeader(headers: Record<string, string>, name: string): string | undefined {
  return Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
}

/** Session id the server issued on `initialize`, read from the capture log. */
function sessionIdFromCaptures(captures: readonly RawHttpCapture[]): string | undefined {
  for (const capture of [...captures].reverse()) {
    const entry = Object.entries(capture.headers).find(([name]) => name.toLowerCase() === 'mcp-session-id');
    const value = entry?.[1];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/**
 * The exchange a verdict is graded on: the protected `tools/call` if it
 * happened, else the `initialize` that prevented it.
 *
 * `tools/list` captures are excluded outright. The probe does not issue one,
 * but the SDK may (capability pre-compilation), and MCP discovery must never
 * become the evidence an auth verdict rests on.
 */
function gradedCapture(captures: readonly RawHttpCapture[]): RawHttpCapture | undefined {
  const graded = captures.filter(
    capture => capture.method !== 'DELETE' && capture.method !== 'GET' && capture.requestJsonRpcMethod !== 'tools/list'
  );
  const toolCalls = graded.filter(capture => capture.requestJsonRpcMethod === 'tools/call');
  if (toolCalls.length > 0) return toolCalls[toolCalls.length - 1];
  return graded.length > 0 ? graded[graded.length - 1] : undefined;
}

/**
 * AdCP error codes that mean "your credential was refused", as opposed to
 * "your request was malformed". A conformant agent may answer a credential
 * problem inside a successful MCP envelope rather than with an HTTP status;
 * both are rejections.
 *
 * Known limitation: the `security_baseline` storyboard grades
 * `http_status_in`, so an agent that only signals auth this way still fails
 * the authored status check upstream. This probe classifies it correctly and
 * the storyboard contract is the thing that needs to widen — tracked with the
 * other upstream items in the PR description.
 */
const ADCP_AUTH_REJECTION_CODES: readonly string[] = ['AUTH_MISSING', 'AUTH_INVALID'];

/** AdCP error codes that mean the call shape was refused, not the credential. */
const ADCP_SCHEMA_REJECTION_CODES: readonly string[] = ['INVALID_REQUEST'];

/** Scan a tool-result envelope for an AdCP error code, bounded in depth. */
function adcpErrorCodesIn(value: unknown, depth = 0): string[] {
  if (depth > 8 || value === null) return [];
  if (typeof value === 'string') {
    const upper = value.toUpperCase();
    return [...ADCP_AUTH_REJECTION_CODES, ...ADCP_SCHEMA_REJECTION_CODES].filter(code => upper.includes(code));
  }
  if (Array.isArray(value)) return value.flatMap(entry => adcpErrorCodesIn(entry, depth + 1));
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).flatMap(entry => adcpErrorCodesIn(entry, depth + 1));
  }
  return [];
}

/** True when the official client refused the server's negotiated wire version. */
function isUnsupportedProtocolVersion(error: unknown): boolean {
  // Matched on the SDK's stable prefix only — the remainder of that message is
  // the agent-controlled version string and must not be propagated.
  return error instanceof Error && error.message.startsWith("Server's protocol version is not supported");
}

/**
 * Statuses that constitute an affirmative authentication rejection.
 *
 * 401 is the semantically correct answer (RFC 6750 §3); 403 is accepted
 * because production gateways conflate them; 400 covers a credential the agent
 * refused to parse (RFC 6750 §3.1). Everything else — 5xx, a malformed 2xx, a
 * transport failure — is a broken exchange, not evidence about credentials.
 */
const AUTH_REJECTION_STATUSES: ReadonlySet<number> = new Set([400, 401, 403]);

/** Fixed-vocabulary description of a non-HTTP SDK rejection. */
function sdkRejectionDetail(error: unknown): string {
  if (error instanceof StreamableHTTPError && typeof error.code === 'number') {
    return `HTTP ${error.code}`;
  }
  if (error instanceof McpError) {
    return error.code === ErrorCode.RequestTimeout ? 'request timed out' : `JSON-RPC error code ${error.code}`;
  }
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return 'request aborted';
  }
  return 'protocol error';
}

/** Evidence placeholder for an attempt that never produced an HTTP response. */
function transportErrorEvidence(agentUrl: string, detail: string): HttpProbeResult {
  return { url: agentUrl, status: 0, headers: {}, body: null, error: detail };
}

/**
 * Hard byte cap and deadline for the probe's own fetch boundary.
 *
 * `wrapFetchWithSizeLimit` cannot do this job here for two reasons: it is inert
 * unless a `responseSizeLimitStorage` slot is active, and it deliberately
 * passes `text/event-stream` through uncapped because a normal tool call emits
 * an unbounded number of status frames. Streamable HTTP replies *are* SSE, so
 * for this probe that exemption is the whole attack surface — and
 * `withRawResponseCapture` buffers the body via `response.clone().text()`
 * before truncating, so an oversized reply is already in memory by then.
 *
 * The probe has no legitimate need for a large or long-lived body: it reads
 * exactly one `InitializeResult` and one `ListToolsResult`. So the cap applies
 * to every content type, counts bytes as they stream, and errors the stream at
 * the boundary rather than after buffering.
 *
 * The same wrapper carries the deadline. `RequestOptions.timeout` only covers
 * SDK *requests*; `notifications/initialized` is a fire-and-forget notification
 * with no response handler, so a server that accepts the POST and withholds the
 * response would hang `connect()` indefinitely. Applying the signal at the
 * fetch boundary bounds every exchange uniformly — initialize, the
 * notification, tools/list and the terminating DELETE.
 */
function wrapProbeFetch(
  upstream: typeof fetch,
  options: {
    maxResponseBytes: number;
    timeoutMs?: number;
    signal?: AbortSignal;
    /**
     * Invoked when the cap trips. Erroring the body stream frees the socket
     * but does not reject the SDK's pending JSON-RPC request — the transport
     * treats a stream fault as recoverable — so the caller uses this to close
     * the transport and fail fast instead of waiting out the deadline.
     */
    onCapExceeded?: () => void;
  }
): typeof fetch {
  const { maxResponseBytes, timeoutMs, signal } = options;
  const wrapped: typeof fetch = async (input, init) => {
    // Aborted by the body cap below: erroring the stream alone frees the
    // socket but leaves the SDK's pending request waiting out its own
    // timeout, so an oversized reply would still cost the full deadline.
    const capAbort = new AbortController();
    const signals: AbortSignal[] = [capAbort.signal];
    if (signal) signals.push(signal);
    if (init?.signal) signals.push(init.signal);
    if (timeoutMs !== undefined) signals.push(AbortSignal.timeout(timeoutMs));
    const composed = AbortSignal.any(signals);

    // Identity encoding so a small gzip bomb cannot decompress past the cap
    // before the counter sees it.
    const headers = new Headers(init?.headers);
    if (!headers.has('accept-encoding')) headers.set('accept-encoding', 'identity');

    const response = await upstream(input, { ...(init ?? {}), headers, signal: composed });
    return capResponseBody(response, maxResponseBytes, capAbort, options.onCapExceeded);
  };
  return wrapped;
}

/** Error the body stream at `maxBytes`, for every content type including SSE. */
function capResponseBody(
  response: Response,
  maxBytes: number,
  capAbort: AbortController,
  onCapExceeded?: () => void
): Response {
  const declared = response.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared.trim()) && Number(declared.trim()) > maxBytes) {
    response.body?.cancel().catch(() => {});
    onCapExceeded?.();
    throw new ProbeResponseTooLargeError(maxBytes);
  }
  if (!response.body) return response;
  let seen = 0;
  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > maxBytes) {
        const tooLarge = new ProbeResponseTooLargeError(maxBytes);
        controller.error(tooLarge);
        capAbort.abort(tooLarge);
        onCapExceeded?.();
        return;
      }
      controller.enqueue(chunk);
    },
  });
  return new Response(response.body.pipeThrough(counter), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * Allowlisted read tools named in the schema-refusal remedy. Spelled out here
 * rather than imported so `probes.ts` keeps no dependency on the test-kit
 * module.
 */
const PROBE_TASK_ALLOWLIST_HINT = 'list_creatives, get_media_buy_delivery, get_signals, list_accounts, …';

/** Raised when an agent's reply exceeds the session probe's body cap. */
class ProbeResponseTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`MCP session probe response exceeded ${maxBytes} bytes`);
    this.name = 'ProbeResponseTooLargeError';
  }
}

/**
 * Body cap for the session probe. An `InitializeResult` and a `ListToolsResult`
 * for a realistic agent are kilobytes; 256 KiB leaves generous headroom for a
 * large tool catalogue while bounding a hostile stream.
 */
const MCP_SESSION_PROBE_MAX_RESPONSE_BYTES = 256 * 1024;

/**
 * Drive one complete MCP session lifecycle with a single credential state and
 * report where the agent's auth decision landed.
 *
 * `Client.connect()` performs `initialize` plus `notifications/initialized`;
 * `Client.listTools()` is the graded protected operation; the transport's
 * `terminateSession()` issues the session-ending DELETE. Every step is the
 * official SDK's, so result schemas, response-id correlation and version
 * negotiation are the SDK's semantics rather than this module's.
 *
 * Grading the protected operation — rather than stopping at the handshake — is
 * what makes the verdict independent of the agent's enforcement point: a
 * server that authenticates the Streamable HTTP session rejects during
 * `connect()`, one that authenticates each operation rejects during
 * `listTools()`, and both are reported as rejections with the rejecting
 * response as evidence. A server that serves `tools/list` with no credential is
 * reported as accepted, which {@link rawMcpSessionProbe} then refuses to treat
 * as rejection evidence — so a fail-open agent fails visibly instead of being
 * silently skipped.
 *
 * `tools/list` takes only an optional `cursor`, so no agent-authored request
 * schema can 400 the probe before the auth layer runs.
 */
async function runMcpSessionLifecycle(options: {
  agentUrl: string;
  headers: Record<string, string>;
  /** Advertised, read-shaped, auth-required AdCP tool to call with `{}`. */
  toolName: string;
  allowPrivateIp: boolean;
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<McpSessionAttempt> {
  const { agentUrl, headers, toolName, allowPrivateIp, fetchFn, signal, timeoutMs } = options;

  // SSRF-guarded transport fetch innermost, then this probe's own hard byte
  // cap + deadline, then raw capture for grading. The cap sits *below* the
  // capture so the clone the capture reads is already bounded.
  // Assigned once the transport exists; the cap uses it to fail fast.
  let closeOnCapExceeded: () => void = () => {};
  const transportFetch = wrapFetchWithCapture(
    wrapProbeFetch(
      createAgentTransportFetch(agentUrl, {
        allowPrivateIp,
        ...(fetchFn ? { trustedFetchFn: fetchFn } : {}),
      }),
      {
        maxResponseBytes: MCP_SESSION_PROBE_MAX_RESPONSE_BYTES,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(signal ? { signal } : {}),
        onCapExceeded: () => closeOnCapExceeded(),
      }
    )
  );

  const client = new McpClient(SESSION_PROBE_CLIENT_INFO, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(agentUrl), {
    requestInit: {
      headers,
      redirect: 'manual',
      // Run cancellation reaches the socket, not just the SDK's request timer.
      ...(signal ? { signal } : {}),
    },
    fetch: transportFetch,
  });
  // Closing the transport rejects every pending request with
  // `ConnectionClosed`, which is what turns a tripped cap into a prompt
  // failure instead of a deadline-length wait.
  closeOnCapExceeded = () => void transport.close().catch(() => {});
  const requestOptions = {
    ...(signal ? { signal } : {}),
    ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}),
  };

  let captures: readonly RawHttpCapture[] = [];
  let thrown: unknown;
  let toolResult: unknown;
  try {
    const run = await withRawResponseCapture(async () => {
      try {
        await client.connect(transport, requestOptions);
        // The graded protected operation: an advertised, auth-required,
        // read-shaped AdCP tool, called with empty arguments. No `tools/list`
        // — discovery is not a protected task and must not become evidence.
        return await client.callTool({ name: toolName, arguments: {} }, undefined, requestOptions);
      } finally {
        await client.close().catch(() => {});
      }
    });
    captures = run.captures;
    toolResult = run.result;
  } catch (err) {
    thrown = err;
    captures = getCapturesFromError(err) ?? [];
  }

  // Official session termination on every exit path — including a 200
  // `initialize` whose body then failed the SDK's schema or version checks,
  // which still leaves a server-side session behind.
  //
  // `Client.connect()` closes the transport when initialization fails, and
  // `StreamableHTTPClientTransport.close()` clears its session id, so the live
  // transport can no longer name the session by the time we get here. Recover
  // the id the server issued from the captured `initialize` response and
  // terminate through a transport seeded with it — the documented purpose of
  // the `sessionId` option.
  const issuedSessionId = transport.sessionId ?? sessionIdFromCaptures(captures);
  if (issuedSessionId !== undefined) {
    const terminator = new StreamableHTTPClientTransport(new URL(agentUrl), {
      requestInit: { headers, redirect: 'manual', ...(signal ? { signal } : {}) },
      fetch: transportFetch,
      sessionId: issuedSessionId,
    });
    // Seed the negotiated version so the DELETE carries `MCP-Protocol-Version`
    // like every other post-initialize request; a server that requires the
    // header would otherwise reject its own session teardown.
    const negotiated = transport.protocolVersion ?? negotiatedVersionFromCaptures(captures);
    if (negotiated !== undefined) terminator.setProtocolVersion(negotiated);
    await terminateSessionBestEffort(terminator);
  }

  const graded = gradedCapture(captures);
  if (graded === undefined) {
    const detail = thrown === undefined ? 'no HTTP exchange observed' : sdkRejectionDetail(thrown);
    return {
      verdict: 'unusable',
      accepted: false,
      stage: 'initialize',
      detail,
      evidence: transportErrorEvidence(agentUrl, detail),
    };
  }

  const stage: McpSessionStage = graded.requestJsonRpcMethod === 'tools/call' ? 'tools/call' : 'initialize';
  const evidence = httpProbeResultFromCapture(graded);

  if (thrown === undefined) {
    // The call completed at the MCP layer. An operation-level AdCP error can
    // still sit inside that successful envelope, so classify the payload.
    const codes = adcpErrorCodesIn(toolResult);
    if (codes.some(code => ADCP_AUTH_REJECTION_CODES.includes(code))) {
      return {
        verdict: 'auth_rejected',
        accepted: false,
        stage,
        detail: `operation-level ${codes.find(c => ADCP_AUTH_REJECTION_CODES.includes(c))}`,
        evidence,
      };
    }
    if (codes.some(code => ADCP_SCHEMA_REJECTION_CODES.includes(code))) {
      return {
        verdict: 'schema_or_param',
        accepted: false,
        stage,
        detail: 'operation-level INVALID_REQUEST',
        evidence,
      };
    }
    const isError = (toolResult as { isError?: unknown } | undefined)?.isError === true;
    if (isError) {
      return { verdict: 'schema_or_param', accepted: false, stage, detail: 'tool reported isError', evidence };
    }
    return { verdict: 'accepted', accepted: true, stage, detail: `HTTP ${graded.status}`, evidence };
  }

  if (isUnsupportedProtocolVersion(thrown)) {
    // Per the MCP lifecycle the client offers its latest version and the
    // server may answer with another it supports. A version this SDK does not
    // implement is a *protocol compatibility* problem, not an auth verdict.
    return {
      verdict: 'unusable',
      accepted: false,
      protocolIncompatible: true,
      stage: 'initialize',
      detail:
        `agent negotiated a protocolVersion this SDK does not implement ` +
        `(supports ${SUPPORTED_PROTOCOL_VERSIONS.length} versions)`,
      evidence,
    };
  }
  if (AUTH_REJECTION_STATUSES.has(graded.status)) {
    return { verdict: 'auth_rejected', accepted: false, stage, detail: `HTTP ${graded.status}`, evidence };
  }
  if (graded.status >= 400) {
    return { verdict: 'unusable', accepted: false, stage, detail: `HTTP ${graded.status}`, evidence };
  }
  // A 2xx the SDK rejected: an AdCP schema/param refusal surfaces as a
  // JSON-RPC -32602, anything else is an unusable exchange.
  const detail = sdkRejectionDetail(thrown);
  const schemaish = detail === `JSON-RPC error code ${ErrorCode.InvalidParams}`;
  return { verdict: schemaish ? 'schema_or_param' : 'unusable', accepted: false, stage, detail, evidence };
}

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
    if (spaceAt <= 0) continue;
    const scheme = authorization.slice(0, spaceAt).toLowerCase();
    const credential = authorization.slice(spaceAt + 1);
    values.add(credential);
    if (scheme !== 'basic') continue;
    // Basic credentials travel base64-encoded, but an agent that decodes the
    // header before echoing it (a "debug" handler logging the resolved user,
    // an error template interpolating the password) leaks the cleartext form,
    // which no amount of matching on the encoded blob catches.
    const decoded = decodeBase64Utf8(credential);
    if (decoded === undefined) continue;
    values.add(decoded);
    const colonAt = decoded.indexOf(':');
    if (colonAt >= 0) {
      const password = decoded.slice(colonAt + 1);
      // The password alone is the secret half; the username is often an
      // account identifier that appears legitimately in evidence.
      if (password.length > 0) values.add(password);
    }
  }
  // Floor of 4 rather than 8: short API keys and short Basic passwords are
  // still credentials, and a run that configured one is asking for it to be
  // protected. Below 4 characters a substring replace would mangle unrelated
  // evidence for no meaningful secrecy gain.
  return [...values].filter(value => value.trim().length >= 4);
}

/** Decode a base64 Basic credential, or undefined when it is not valid base64. */
function decodeBase64Utf8(value: string): string | undefined {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length === 0) return undefined;
  try {
    const decoded = Buffer.from(value, 'base64').toString('utf8');
    // Reject lossy round-trips: a non-base64 token can decode to mojibake.
    return decoded.includes('\uFFFD') ? undefined : decoded;
  } catch {
    return undefined;
  }
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
  if (secrets.length === 0) return value;
  // Fail closed at the limits. Returning the original subtree here would let a
  // hostile agent bury a live credential below the traversal depth (or past an
  // entry cap) and have it published verbatim; an elided subtree costs
  // diagnostics, a leaked bearer costs the tenant.
  if (depth > MAX_REDACTION_DEPTH) return REDACTION_DEPTH_PLACEHOLDER;
  if (typeof value === 'string') return redactCredentialValuesInText(value, secrets);
  if (Array.isArray(value)) {
    const kept = value
      .slice(0, MAX_REDACTION_ENTRIES)
      .map(entry => redactCredentialValuesDeep(entry, secrets, depth + 1));
    return value.length > MAX_REDACTION_ENTRIES ? [...kept, REDACTION_SIZE_PLACEHOLDER] : kept;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>);
    for (const [key, entry] of entries.slice(0, MAX_REDACTION_ENTRIES)) {
      Object.defineProperty(out, redactCredentialValuesInText(key, secrets), {
        value: redactCredentialValuesDeep(entry, secrets, depth + 1),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    if (entries.length > MAX_REDACTION_ENTRIES) {
      Object.defineProperty(out, '__redacted__', {
        value: REDACTION_SIZE_PLACEHOLDER,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return out;
  }
  // Numbers, booleans, null: cannot carry a credential substring.
  return value;
}

/** Traversal bounds for {@link redactCredentialValuesDeep}; exceeded ⇒ elided. */
const MAX_REDACTION_DEPTH = 24;
const MAX_REDACTION_ENTRIES = 512;
const REDACTION_DEPTH_PLACEHOLDER = '[REDACTED_UNSCANNABLE_DEPTH]';
const REDACTION_SIZE_PLACEHOLDER = '[REDACTED_UNSCANNABLE_SIZE]';

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
 * Probe an MCP agent's auth enforcement with a complete session lifecycle
 * driven by the official SDK client — the auth probe for agents that advertise
 * none of `PROBE_TASK_ALLOWLIST` (adcp-client#2940).
 *
 * See {@link runMcpSessionLifecycle} for the request sequence. The probe never
 * reaches an AdCP tool handler and never mutates agent state: `tools/list` is
 * a read-only protocol operation and the session is terminated through the
 * transport's own `terminateSession()`.
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
 * - `control.kind === 'probe_is_valid_credential'` whose own lifecycle
 *   completed.
 *
 * Otherwise — control refused, no credential of the required kind configured,
 * or a positive credential that never completed the protected operation — the
 * probe returns the graded response as evidence **plus** an `error`, which
 * fails the step instead of certifying an auth mechanism. Correct metadata
 * alone can never earn a contribution, and the caller decides what counts as
 * the right kind of credential so that (for example) a static API key cannot
 * stand in for an OAuth access token.
 *
 * The same refusal applies when the graded attempt is **accepted** under a
 * discrimination control: an acceptance is never characterised as rejection
 * evidence. That check lives here rather than in the authored
 * `http_status_in` validation so a storyboard that omits it — a future
 * revision, a custom `--file` storyboard, an adopter's own narrative — cannot
 * mint a contribution off a fail-open endpoint.
 *
 * **Credentials in, never out.** Credentials are sent to the agent and never
 * written back onto the result. `wrapFetchWithCapture` already redacts
 * credential-bearing response headers and `Bearer` spans; on top of that this
 * function scrubs the exact values it sent — by value, across body, headers
 * and error, failing closed at its traversal limits — because an agent that
 * echoes the `Authorization` header it received into a tool description or a
 * `WWW-Authenticate` parameter is invisible to name-based redaction, and on a
 * positive probe that echo is the run's live credential.
 */
export async function rawMcpSessionProbe(options: {
  agentUrl: string;
  /** Credentials under test. Empty for the unauthenticated probe. */
  headers?: Record<string, string>;
  /**
   * Advertised, read-shaped, auth-required AdCP tool to call with `{}` — the
   * graded protected operation. The caller selects it; see the runner's
   * `selectProtectedToolTarget`.
   */
  toolName: string;
  /** Acceptance control. Required — see {@link McpSessionProbeControl}. */
  control: McpSessionProbeControl;
  /** Allow http:// and private-IP agent URLs (dev loops). Default false. */
  allowPrivateIp?: boolean;
  /** Scoped fetch implementation for every request this probe makes. */
  fetchFn?: typeof fetch;
  /** Run-level cancellation. Threaded through every request and cleanup. */
  signal?: AbortSignal;
  /** Per-request cap handed to the SDK's `RequestOptions.timeout`. */
  timeoutMs?: number;
}): Promise<{
  httpResult: HttpProbeResult;
  taskResult?: TaskResult;
  stage: McpSessionStage;
  /** Fixed-vocabulary description of the graded verdict. Never agent text. */
  detail: string;
}> {
  const { agentUrl, headers = {}, toolName, control, allowPrivateIp = false, fetchFn, signal, timeoutMs } = options;
  const lifecycle = { agentUrl, toolName, allowPrivateIp, fetchFn, signal, timeoutMs };
  // The graded attempt runs first so its response is captured as evidence
  // regardless of what the control does afterwards.
  const rawGraded = await runMcpSessionLifecycle({ ...lifecycle, headers });
  // Evidence seam: everything downstream (`response`,
  // `response_record.payload`, validations) reads this response, so scrub the
  // credentials we just sent out of it by value before anyone can persist it.
  const secrets = sentCredentialValues(headers, control.kind === 'credential' ? control.headers : undefined);
  const graded: McpSessionAttempt = {
    ...rawGraded,
    evidence: redactCredentialsFromEvidence(rawGraded.evidence, secrets),
  };
  const conclusive = {
    httpResult: graded.evidence,
    taskResult: taskResultFromEvidence(graded),
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
    if (graded.verdict === 'accepted') return conclusive;
    if (graded.protocolIncompatible) return protocolIncompatibleProbe(graded);
    if (graded.verdict === 'schema_or_param') return schemaOrParamProbe(graded, toolName);
    if (graded.verdict === 'unusable') return malformedResponseProbe(graded);
    return refusedSessionProbe(
      graded,
      `the run's valid credential was refused on the selected protected tool "${toolName}" (rejected at ` +
        `${graded.stage}: ${graded.detail}), so there is no successful protected call to certify`,
      'Confirm the credential is current and that the agent accepts it on that tool.'
    );
  }

  // Every other control kind means the graded attempt carried a credential
  // state the agent is expected to refuse (deliberately invalid, or none).
  if (graded.verdict === 'accepted') {
    return refusedSessionProbe(
      graded,
      `the credential state under test received a successful payload from the protected tool ` +
        `"${toolName}" (accepted at ${graded.stage}: ${graded.detail}), so the agent served ` +
        `tenant-scoped data to credentials it was expected to refuse`,
      'Enforce credential validation on that tool before treating this path as conformant.'
    );
  }

  if (graded.protocolIncompatible) return protocolIncompatibleProbe(graded);

  // "Not accepted" is not the same as "refused the credential". A shape
  // refusal says nothing about credentials in either direction (the chosen
  // target wants arguments this probe cannot synthesise); a 5xx, malformed
  // envelope or transport failure is a broken exchange. With an empty authored
  // validation list either would otherwise be handed back as conclusive and
  // mint `auth_mechanism_verified` on a healthy control.
  if (graded.verdict === 'schema_or_param') return schemaOrParamProbe(graded, toolName);
  if (graded.verdict === 'unusable') return malformedResponseProbe(graded);

  if (control.kind === 'unavailable') {
    return inconclusiveSessionProbe(graded, control.reason, control.remedy);
  }

  // Mechanism-matched control on the *same* target. It only has to prove the
  // endpoint does not refuse everything, so a successful payload and a
  // non-auth shape refusal both qualify — the latter still reached the tool
  // handler past the auth layer. An auth rejection of the valid credential
  // means the rejection under test cannot be attributed to credentials.
  const acceptance = await runMcpSessionLifecycle({ ...lifecycle, headers: control.headers });
  if (acceptance.verdict === 'accepted' || acceptance.verdict === 'schema_or_param') return conclusive;
  if (acceptance.protocolIncompatible) return protocolIncompatibleProbe(graded, acceptance);
  if (acceptance.verdict === 'auth_rejected') {
    return inconclusiveSessionProbe(
      graded,
      `the run's valid credential was also refused on "${toolName}" (rejected at ${acceptance.stage}: ` +
        `${acceptance.detail})`,
      'Check that the credential is current and that it is accepted on that tool.'
    );
  }
  return inconclusiveSessionProbe(
    graded,
    `the control call on "${toolName}" did not produce a usable answer (${acceptance.stage}: ` +
      `${acceptance.detail})`,
    'Check that the agent URL is reachable and that the tool answers a credentialed call.'
  );
}

type SessionProbeOutcome = {
  httpResult: HttpProbeResult;
  taskResult: TaskResult;
  stage: McpSessionStage;
  detail: string;
};

/** Synthetic TaskResult so callers that want a body shape can read one. */
function taskResultFromEvidence(graded: McpSessionAttempt): TaskResult {
  if (graded.accepted) {
    return { success: true, data: graded.evidence.body, _extraction_path: 'structured_content' };
  }
  return { success: false, data: undefined, error: graded.detail, _extraction_path: 'error' };
}

function protocolIncompatibleProbe(
  graded: McpSessionAttempt,
  attempt: McpSessionAttempt = graded
): SessionProbeOutcome {
  return sessionProbeError(
    graded,
    `MCP session probe could not run: ${attempt.detail} at ${attempt.stage}. This is a protocol ` +
      `compatibility problem, not an authentication result — nothing was learned about this agent's ` +
      `credentials. Upgrade the SDK to one that implements the agent's MCP wire version, then re-run.`
  );
}

/**
 * A lifecycle the official client refused on *shape* rather than status: a 2xx
 * whose body is not a conformant `InitializeResult` / `ListToolsResult`, or an
 * envelope it would not parse. Worded distinctly from both the credential and
 * the wire-version diagnostics so an adopter reads "fix your response shape"
 * instead of hunting a token problem.
 */
/**
 * The agent refused the *shape* of the protected call. Not an auth result in
 * either direction: the selected target needs arguments this probe cannot
 * synthesise, which is exactly the hazard `PROBE_TASK_ALLOWLIST` exists to
 * avoid, so the remedy is to advertise an allowlisted read tool.
 */
function schemaOrParamProbe(graded: McpSessionAttempt, toolName: string): SessionProbeOutcome {
  return sessionProbeError(
    graded,
    `MCP session auth probe is inconclusive: the agent refused the shape of the call to "${toolName}" ` +
      `(${graded.detail}) rather than answering it, so nothing was learned about this agent's ` +
      `credentials. Advertise one auth-required, read-only tool that accepts an empty request body ` +
      `(${PROBE_TASK_ALLOWLIST_HINT}) so the probe has a parameter-free protected target.`
  );
}

function malformedResponseProbe(graded: McpSessionAttempt): SessionProbeOutcome {
  if (graded.detail === 'request timed out' || graded.detail === 'request aborted') {
    return sessionProbeError(
      graded,
      `MCP session probe could not run: the agent answered ${graded.stage} with HTTP ` +
        `${graded.evidence.status} but never delivered a usable response to that request ` +
        `(${graded.detail}). This is not an authentication result — nothing was learned about this ` +
        `agent's credentials.`
    );
  }
  return sessionProbeError(
    graded,
    `MCP session probe could not run: the agent answered ${graded.stage} with HTTP ` +
      `${graded.evidence.status} but a body the official MCP client rejected (${graded.detail}). This is a ` +
      `response-shape problem, not an authentication result — nothing was learned about this agent's ` +
      `credentials. Return a conformant result for that operation, then re-run.`
  );
}

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
    httpResult: { ...graded.evidence, error: message },
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
