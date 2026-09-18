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
  getCaptureOverflowFromError,
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
import { PROBE_TASK_ALLOWLIST_SUMMARY } from './test-kit';
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
// probe therefore drives `Client.connect()` → `Client.callTool(target, {})` →
// `StreamableHTTPClientTransport.terminateSession()` and lets the SDK own
// `initialize`, `notifications/initialized`, response-id correlation, result
// schema validation and protocol-version negotiation.
//
// Two SDK-supported extension points make that compatible with security
// grading, which needs raw HTTP status and `WWW-Authenticate`:
//
//   - `StreamableHTTPClientTransportOptions.fetch` takes the repo's
//     SSRF-guarded `createAgentTransportFetch` (DNS classification,
//     connection pinning, redirect validation), wrapped in this probe's own
//     body cap and deadline plus the raw-capture layer `protocols/mcp.ts` uses.
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

/**
 * Session id the server issued on `initialize`.
 *
 * Scoped to the initialize exchange on purpose: a later response advertising a
 * different `Mcp-Session-Id` would otherwise be picked up and cleanup would
 * DELETE a session the probe never established, leaving the real one open.
 */
function sessionIdFromCaptures(captures: readonly RawHttpCapture[]): string | undefined {
  for (const capture of captures) {
    if (capture.requestJsonRpcMethod !== 'initialize') continue;
    const value = findHeader(capture.headers, 'mcp-session-id');
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
const ADCP_AUTH_REJECTION_CODES: readonly string[] = [
  'AUTH_MISSING',
  'AUTH_INVALID',
  // Deprecated in AdCP 3.x but retained by the error-code enum as a
  // backward-compatible alias for the two above, so an agent still emitting it
  // is making an authentication statement.
  'AUTH_REQUIRED',
];

/** AdCP error codes that mean the call shape was refused, not the credential. */
const ADCP_SCHEMA_REJECTION_CODES: readonly string[] = ['INVALID_REQUEST'];

/** Property names an AdCP error code is carried under. */
const ADCP_ERROR_CODE_FIELDS: ReadonlySet<string> = new Set(['code', 'error_code', 'errorCode']);

/**
 * Collect AdCP error codes from the **recognized error envelope** of a tool
 * result, never from arbitrary payload data.
 *
 * Two unsound shortcuts are avoided here:
 *
 *   - A substring scan over every string would grade a *successful*, fail-open
 *     payload that merely documents its vocabulary — prose like "on failure
 *     this returns AUTH_INVALID", or a `supported_error_codes` enum — as a
 *     credential rejection.
 *   - An exact `code` field *anywhere* is almost as bad: tenant data routinely
 *     carries `code` (a currency code, a country code, a line-item code), so a
 *     successful payload containing `{ code: 'AUTH_INVALID' }` in a data row
 *     would certify an agent that just served that row to a bogus token.
 *
 * So only the AdCP error envelope is inspected: `error` / `errors[]` on the
 * structured content (or on the result root). Per the error-handling contract
 * an agent signalling an operation-level failure populates that envelope *and*
 * flips `isError`, so this is where a real rejection lives.
 */
function adcpErrorCodesIn(toolResult: unknown): string[] {
  const result = toolResult as { structuredContent?: unknown; content?: unknown } | null | undefined;
  const roots = [result?.structuredContent, result].filter(
    (root): root is Record<string, unknown> => root !== null && typeof root === 'object'
  );
  const envelopes: unknown[] = [];
  for (const root of roots) {
    if (root.error !== undefined) envelopes.push(root.error);
    if (Array.isArray(root.errors)) envelopes.push(...root.errors);
  }
  const found: string[] = [];
  for (const envelope of envelopes) {
    if (envelope === null || typeof envelope !== 'object') continue;
    for (const [key, entry] of Object.entries(envelope as Record<string, unknown>)) {
      if (!ADCP_ERROR_CODE_FIELDS.has(key) || typeof entry !== 'string') continue;
      const code = entry.trim().toUpperCase();
      if (ADCP_AUTH_REJECTION_CODES.includes(code) || ADCP_SCHEMA_REJECTION_CODES.includes(code)) found.push(code);
    }
  }
  return found;
}

/** True when the official client refused the server's negotiated wire version. */
function isUnsupportedProtocolVersion(error: unknown): boolean {
  // Matched on the SDK's stable prefix only — the remainder of that message is
  // the agent-controlled version string and must not be propagated.
  return error instanceof Error && error.message.startsWith("Server's protocol version is not supported");
}

/**
 * Statuses that are an authentication rejection on their own.
 *
 * 401 is the semantically correct answer (RFC 6750 §3) and 403 is accepted
 * because production gateways conflate them.
 *
 * 400 is deliberately **not** here. RFC 6750 §3.1 permits it for a credential
 * the agent refused to parse, but a 400 is far more often a parameter
 * complaint — and the storyboard's `http_status_in: [400, 401, 403]` would
 * then certify an agent that never checked the credential at all. A 400 needs
 * explicit auth semantics: a `WWW-Authenticate` challenge, or an exact
 * operation-level AdCP auth code.
 */
const AUTH_REJECTION_STATUSES: ReadonlySet<number> = new Set([401, 403]);

/**
 * Whether a 400 carries affirmative evidence that it is about the credential
 * rather than the request shape.
 */
function fourHundredIsAuthRejection(evidence: HttpProbeResult, codes: readonly string[]): boolean {
  if (findHeader(evidence.headers, 'www-authenticate') !== undefined) return true;
  return codes.some(code => ADCP_AUTH_REJECTION_CODES.includes(code));
}

/** Fixed-vocabulary description of a non-HTTP SDK rejection. */
function sdkRejectionDetail(error: unknown): string {
  if (error instanceof ProbeResponseTooLargeError) return 'response exceeded the probe body cap';
  if (error instanceof ProbeAmplificationError) return `exceeded the probe ${error.kind} budget`;
  const cause = (error as { cause?: unknown } | undefined)?.cause;
  if (cause instanceof ProbeResponseTooLargeError) return 'response exceeded the probe body cap';
  if (cause instanceof ProbeAmplificationError) return `exceeded the probe ${cause.kind} budget`;
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
 * notification, the graded tools/call and the terminating DELETE.
 */
function wrapProbeFetch(
  upstream: typeof fetch,
  options: {
    maxResponseBytes: number;
    /** Hard ceiling on requests one lifecycle may make. */
    maxRequests: number;
    /** Hard ceiling on total bytes one lifecycle may read. */
    maxTotalBytes: number;
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
  const { maxResponseBytes, maxRequests, maxTotalBytes, timeoutMs, signal } = options;
  // Per-lifecycle amplification budget. A server may answer the SSE stream with
  // `retry: 0`, and the SDK's reconnection ceiling does not bind the POST-stream
  // path — unbounded reconnects would issue thousands of requests in seconds and
  // grow the capture array without limit. These counters are the backstop.
  let requestCount = 0;
  let totalBytes = 0;
  const wrapped: typeof fetch = async (input, init) => {
    requestCount += 1;
    if (requestCount > maxRequests) throw new ProbeAmplificationError('request', maxRequests);
    if (totalBytes > maxTotalBytes) throw new ProbeAmplificationError('byte', maxTotalBytes);
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

    // `redirect: 'manual'` on every request, not just the ones the SDK passes
    // `requestInit` to — the GET that opens the SSE stream drops it. An
    // agent-steered redirect must never be followed, and `--allow-http` must
    // not quietly turn that back on.
    const response = await upstream(input, {
      ...(init ?? {}),
      headers,
      redirect: 'manual',
      signal: composed,
    });
    return capResponseBody(response, maxResponseBytes, capAbort, options.onCapExceeded, read => {
      totalBytes += read;
      if (totalBytes > maxTotalBytes) {
        capAbort.abort(new ProbeAmplificationError('byte', maxTotalBytes));
        options.onCapExceeded?.();
        return false;
      }
      return true;
    });
  };
  return wrapped;
}

/** Error the body stream at `maxBytes`, for every content type including SSE. */
function capResponseBody(
  response: Response,
  maxBytes: number,
  capAbort: AbortController,
  onCapExceeded?: () => void,
  countBytes?: (read: number) => boolean
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
      if (countBytes?.(chunk.byteLength) === false) {
        controller.error(new ProbeAmplificationError('byte', maxBytes));
        return;
      }
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
 * Allowlisted read tools named in the schema-refusal remedy.
 *
 * Aliases the one canonical rendering so the probe, the runner's skip details
 * and the adopter docs cannot drift into naming different tools.
 */
const PROBE_TASK_ALLOWLIST_HINT = PROBE_TASK_ALLOWLIST_SUMMARY;

/**
 * Neutralise control characters in any externally supplied fragment before it
 * is interpolated into a diagnostic.
 *
 * The runner picks targets from its own canonical registry, but this primitive
 * is exported and a direct caller may pass any string — and these diagnostics
 * flow into terminals, CI logs, JSON reports and JUnit XML (where C0 controls
 * are not even legal). Escaped rather than dropped so the original bytes stay
 * diagnosable.
 */
function fenceAgentText(value: string, maxLength = 96): string {
  const clipped = value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
  return clipped.replace(
    /[\u0000-\u001f\u007f-\u009f]/g,
    char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
  );
}

/** Raised when an agent's reply exceeds the session probe's body cap. */
class ProbeResponseTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`MCP session probe response exceeded ${maxBytes} bytes`);
    this.name = 'ProbeResponseTooLargeError';
  }
}

/** Raised when one lifecycle exceeds its request or total-byte budget. */
class ProbeAmplificationError extends Error {
  constructor(
    readonly kind: 'request' | 'byte',
    limit: number
  ) {
    super(`MCP session probe exceeded its ${kind} budget (${limit})`);
    this.name = 'ProbeAmplificationError';
  }
}

/**
 * Per-lifecycle amplification budget.
 *
 * Five requests are expected: initialize, the initialized notification, the
 * optional standalone SSE stream, the graded `tools/call`, and the terminating
 * DELETE. 12 leaves slack for a conformant server that splits a response
 * across streams, while still bounding an agent that tries to turn one probe
 * into a request storm. Tripping it aborts the lifecycle rather than grading
 * whatever arrived.
 */
const MCP_SESSION_PROBE_MAX_REQUESTS = 12;

/** Reconnection ceiling: a probe never resumes a stream. */
const NO_RECONNECTION = {
  maxReconnectionDelay: 0,
  initialReconnectionDelay: 0,
  reconnectionDelayGrowFactor: 1,
  maxRetries: 0,
} as const;

/** Fresh deadline for the detached cleanup DELETE. */
const SESSION_TERMINATION_TIMEOUT_MS = 2_000;

/** Total bytes one lifecycle may read across every request. */
const MCP_SESSION_PROBE_MAX_TOTAL_BYTES = 8 * 1024 * 1024;

/**
 * Opt-in ceilings for the shared capture recorder. Passed explicitly so normal
 * MCP behaviour elsewhere is untouched; overflow is marked, and the probe then
 * fails closed rather than grading a silently truncated log.
 */
const CAPTURE_CEILINGS = {
  maxCaptures: MCP_SESSION_PROBE_MAX_REQUESTS,
  maxTotalBodyBytes: MCP_SESSION_PROBE_MAX_TOTAL_BYTES,
} as const;

/**
 * Body cap for the session probe.
 *
 * Sized for a real protected *data* tool, not a handshake: `list_creatives` or
 * `get_media_buy_delivery` on a busy tenant legitimately answers with hundreds
 * of KiB, and capping below that would turn a healthy acceptance control into
 * an inconclusive verdict. 4 MiB is generous for any single AdCP read page
 * while still bounding a hostile stream — unbounded is not an option, since
 * the graded body is buffered for evidence.
 */
const MCP_SESSION_PROBE_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/**
 * Drive one complete MCP session lifecycle with a single credential state and
 * report where the agent's auth decision landed.
 *
 * `Client.connect()` performs `initialize` plus `notifications/initialized`;
 * `Client.callTool(toolName, {})` is the graded protected operation; the
 * transport's `terminateSession()` issues the session-ending DELETE. Every
 * step is the official SDK's, so result schemas, response-id correlation and
 * version negotiation are the SDK's semantics rather than this module's.
 *
 * Grading a protected AdCP tool — rather than stopping at the handshake — is
 * what makes the verdict independent of the agent's enforcement point: a
 * server that authenticates the Streamable HTTP session rejects during
 * `connect()`, one that authenticates each operation rejects during the
 * `tools/call`, and both are reported as rejections with the rejecting
 * response as evidence. A server that answers the protected call with a
 * tenant payload for a bogus credential is reported as accepted, which
 * {@link rawMcpSessionProbe} then refuses to treat as rejection evidence — so
 * a fail-open agent fails visibly instead of being silently skipped.
 *
 * The target is chosen from the canonical AdCP registries with no required
 * request field, but an agent may still refuse an empty-argument call. That is
 * classified `schema_or_param` and reported inconclusive: a shape refusal is
 * not an authentication result.
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
        maxRequests: MCP_SESSION_PROBE_MAX_REQUESTS,
        maxTotalBytes: MCP_SESSION_PROBE_MAX_TOTAL_BYTES,
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
    // A conformance probe never wants a resumed stream: an agent answering
    // `retry: 0` would otherwise have the SDK reconnect in a tight loop.
    reconnectionOptions: NO_RECONNECTION,
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
  let capturesOverflowed: 'captures' | 'bytes' | undefined;
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
    }, CAPTURE_CEILINGS);
    captures = run.captures;
    capturesOverflowed = run.overflowed;
    toolResult = run.result;
  } catch (err) {
    thrown = err;
    captures = getCapturesFromError(err) ?? [];
    capturesOverflowed = getCaptureOverflowFromError(err);
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
    // Cleanup is deliberately detached from the caller's signal. When a run is
    // cancelled after `initialize`, composing the already-aborted signal here
    // meant no DELETE was ever sent and the session leaked; a fresh, short
    // deadline bounds it instead.
    const terminator = new StreamableHTTPClientTransport(new URL(agentUrl), {
      requestInit: { headers, redirect: 'manual' },
      fetch: wrapProbeFetch(
        createAgentTransportFetch(agentUrl, {
          allowPrivateIp,
          ...(fetchFn ? { trustedFetchFn: fetchFn } : {}),
        }),
        {
          maxResponseBytes: MCP_SESSION_PROBE_MAX_RESPONSE_BYTES,
          maxRequests: 2,
          maxTotalBytes: MCP_SESSION_PROBE_MAX_TOTAL_BYTES,
          timeoutMs: SESSION_TERMINATION_TIMEOUT_MS,
        }
      ),
      sessionId: issuedSessionId,
      reconnectionOptions: NO_RECONNECTION,
    });
    // Seed the negotiated version so the DELETE carries `MCP-Protocol-Version`
    // like every other post-initialize request; a server that requires the
    // header would otherwise reject its own session teardown.
    const negotiated = transport.protocolVersion ?? negotiatedVersionFromCaptures(captures);
    if (negotiated !== undefined) terminator.setProtocolVersion(negotiated);
    await terminateSessionBestEffort(terminator);
  }

  if (capturesOverflowed !== undefined) {
    const detail = `capture ${capturesOverflowed} ceiling exceeded`;
    return {
      verdict: 'unusable',
      accepted: false,
      stage: 'initialize',
      detail,
      evidence: transportErrorEvidence(agentUrl, detail),
    };
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
      // `isError` with no recognized AdCP code is an unexplained tool failure.
      // Bucketing it as a shape refusal would let a *control* that fails this
      // way count as "reached the handler", certifying an agent that refuses
      // the valid credential too. Unusable is the honest verdict.
      return {
        verdict: 'unusable',
        accepted: false,
        stage,
        detail: 'tool reported isError with no AdCP error code',
        evidence,
      };
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
  // Shape first. An `InvalidParams` answer says the agent rejected the *call*,
  // and classifying it as auth (which a bare 400 used to do) is how a probe
  // certifies an agent that never looked at the credential.
  const detail = sdkRejectionDetail(thrown);
  const bodyCodes = adcpErrorCodesIn(decodeCapturedBody(graded.body, findHeader(graded.headers, 'content-type')));
  const invalidParams = detail === `JSON-RPC error code ${ErrorCode.InvalidParams}`;
  const schemaCode = bodyCodes.some(code => ADCP_SCHEMA_REJECTION_CODES.includes(code));
  if (invalidParams || schemaCode) {
    return {
      verdict: 'schema_or_param',
      accepted: false,
      stage,
      detail: invalidParams ? 'JSON-RPC InvalidParams (-32602)' : 'operation-level INVALID_REQUEST',
      evidence,
    };
  }
  if (AUTH_REJECTION_STATUSES.has(graded.status)) {
    return { verdict: 'auth_rejected', accepted: false, stage, detail: `HTTP ${graded.status}`, evidence };
  }
  if (graded.status === 400) {
    if (fourHundredIsAuthRejection(evidence, bodyCodes)) {
      return { verdict: 'auth_rejected', accepted: false, stage, detail: 'HTTP 400 with an auth challenge', evidence };
    }
    return {
      verdict: 'schema_or_param',
      accepted: false,
      stage,
      detail: 'HTTP 400 with no authentication evidence',
      evidence,
    };
  }
  if (graded.status >= 400) {
    return { verdict: 'unusable', accepted: false, stage, detail: `HTTP ${graded.status}`, evidence };
  }
  return { verdict: 'unusable', accepted: false, stage, detail, evidence };
}

/**
 * Credential values the probe sent, in every form an agent could echo them:
 * the full `Authorization` header value and the bare token after the scheme
 * (which is also what rides in `x-adcp-auth`).
 *
 * The returned list is scrub input only and is never logged.
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
  // No length floor. A short credential is still a credential, and the caller
  // configured it deliberately; dropping 1–7-character values left a real
  // bypass. Over-redacting evidence is the cheaper failure.
  return [...values].filter(value => value.trim().length > 0);
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
 * See {@link runMcpSessionLifecycle} for the request sequence. Per credential
 * state the probe calls exactly one read-only AdCP tool with empty arguments
 * and mutates no agent state — mutating tasks are excluded from target
 * selection — and the session is terminated through the transport's own
 * `terminateSession()`.
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
   * Canonical AdCP tools to call with `{}` — the graded protected operation, in
   * the runner's deterministic preference order. When the agent refuses the
   * *shape* of the first, the next is tried: a shape refusal says nothing
   * about credentials, and a target that needs arguments would otherwise make
   * every probe inconclusive. See the runner's `protectedToolCandidates`.
   */
  toolName: string | readonly string[];
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
  /**
   * Extra secret values to scrub from evidence even though this probe never
   * sent them.
   *
   * The runner's other steps *do* forward `options.headers`, so a stateful
   * agent can echo an adopter's `x-gateway-token` back on a later step even
   * though the probe deliberately withholds it. Those values are still
   * credentials, and the evidence seam is where they would get persisted.
   */
  redactValues?: readonly string[];
}): Promise<{
  httpResult: HttpProbeResult;
  taskResult?: TaskResult;
  stage: McpSessionStage;
  /** Fixed-vocabulary description of the graded verdict. Never agent text. */
  detail: string;
  /** The exact canonical tool that was graded, so reports are auditable. */
  gradedTool: string;
}> {
  const { agentUrl, headers = {}, control, allowPrivateIp = false, fetchFn, signal, timeoutMs } = options;
  const candidates = typeof options.toolName === 'string' ? [options.toolName] : [...options.toolName];
  const base = { agentUrl, allowPrivateIp, fetchFn, signal, timeoutMs };

  // Walk candidates until one answers something other than a shape refusal.
  let graded!: McpSessionAttempt;
  let toolName = candidates[0] ?? '';
  for (const candidate of candidates) {
    toolName = candidate;
    graded = await runMcpSessionLifecycle({ ...base, toolName: candidate, headers });
    if (graded.verdict !== 'schema_or_param') break;
  }
  const lifecycle = { ...base, toolName };
  // Evidence seam: the graded attempt above ran before any control, so its
  // response is what everything downstream reads (`response`,
  // `response_record.payload`, validations). Scrub the credentials in play out
  // of it by value before anyone can persist it.
  const secrets = [
    ...sentCredentialValues(headers, control.kind === 'credential' ? control.headers : undefined),
    ...(options.redactValues ?? []).filter(value => value.trim().length > 0),
  ];
  graded = { ...graded, evidence: redactCredentialsFromEvidence(graded.evidence, secrets) };
  const conclusive = {
    httpResult: graded.evidence,
    taskResult: taskResultFromEvidence(graded),
    stage: graded.stage,
    detail: graded.detail,
    gradedTool: toolName,
  };

  // A positive probe presents the run's valid credential, so its own
  // acceptance IS the evidence — but only when the lifecycle actually
  // completed. Enforced here rather than in the authored `http_status`
  // validation for the same reason as the negative direction below: a
  // storyboard that omits that check must not be able to present a refused
  // credential as a successful static-credential probe.
  if (control.kind === 'probe_is_valid_credential') {
    if (graded.verdict === 'accepted') return conclusive;
    if (graded.protocolIncompatible) return protocolIncompatibleProbe(graded, toolName);
    if (graded.verdict === 'schema_or_param') return schemaOrParamProbe(graded, toolName);
    if (graded.verdict === 'unusable') return malformedResponseProbe(graded, toolName);
    return refusedSessionProbe(
      graded,
      `the run's valid credential was refused on the selected protected tool "${fenceAgentText(toolName)}" (rejected at ` +
        `${graded.stage}: ${graded.detail}), so there is no successful protected call to certify`,
      'Confirm the credential is current and that the agent accepts it on that tool.',
      toolName
    );
  }

  // Every other control kind means the graded attempt carried a credential
  // state the agent is expected to refuse (deliberately invalid, or none).
  if (graded.verdict === 'accepted') {
    return refusedSessionProbe(
      graded,
      `the credential state under test received a successful payload from the protected tool ` +
        `"${fenceAgentText(toolName)}" (accepted at ${graded.stage}: ${graded.detail}), so the agent served ` +
        `tenant-scoped data to credentials it was expected to refuse`,
      'Enforce credential validation on that tool before treating this path as conformant.',
      toolName
    );
  }

  if (graded.protocolIncompatible) return protocolIncompatibleProbe(graded, toolName);

  // "Not accepted" is not the same as "refused the credential". A shape
  // refusal says nothing about credentials in either direction (the chosen
  // target wants arguments this probe cannot synthesise); a 5xx, malformed
  // envelope or transport failure is a broken exchange. With an empty authored
  // validation list either would otherwise be handed back as conclusive and
  // mint `auth_mechanism_verified` on a healthy control.
  if (graded.verdict === 'schema_or_param') return schemaOrParamProbe(graded, toolName);
  if (graded.verdict === 'unusable') return malformedResponseProbe(graded, toolName);

  if (control.kind === 'unavailable') {
    return inconclusiveSessionProbe(graded, control.reason, control.remedy, toolName);
  }

  // Mechanism-matched control on the *same* target. It only has to prove the
  // endpoint does not refuse everything, so a successful payload and a
  // non-auth shape refusal both qualify — the latter still reached the tool
  // handler past the auth layer. An auth rejection of the valid credential
  // means the rejection under test cannot be attributed to credentials.
  const acceptance = await runMcpSessionLifecycle({ ...lifecycle, headers: control.headers });
  if (acceptance.verdict === 'accepted' || acceptance.verdict === 'schema_or_param') return conclusive;
  if (acceptance.protocolIncompatible) return protocolIncompatibleProbe(graded, toolName, acceptance);
  if (acceptance.verdict === 'auth_rejected') {
    return inconclusiveSessionProbe(
      graded,
      `the run's valid credential was also refused on "${fenceAgentText(toolName)}" (rejected at ${acceptance.stage}: ` +
        `${acceptance.detail})`,
      'Check that the credential is current and that it is accepted on that tool.',
      toolName
    );
  }
  return inconclusiveSessionProbe(
    graded,
    `the control call on "${fenceAgentText(toolName)}" did not produce a usable answer (${acceptance.stage}: ` +
      `${acceptance.detail})`,
    'Check that the agent URL is reachable and that the tool answers a credentialed call.',
    toolName
  );
}

type SessionProbeOutcome = {
  httpResult: HttpProbeResult;
  taskResult: TaskResult;
  stage: McpSessionStage;
  detail: string;
  gradedTool: string;
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
  gradedTool: string,
  attempt: McpSessionAttempt = graded
): SessionProbeOutcome {
  return sessionProbeError(
    graded,
    `MCP session probe could not run: ${attempt.detail} at ${attempt.stage}. This is a protocol ` +
      `compatibility problem, not an authentication result — nothing was learned about this agent's ` +
      `credentials. Upgrade the SDK to one that implements the agent's MCP wire version, then re-run.`,
    gradedTool
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
    `MCP session auth probe is inconclusive: the agent refused the shape of the call to "${fenceAgentText(toolName)}" ` +
      `(${graded.detail}) rather than answering it, so nothing was learned about this agent's ` +
      `credentials. Advertise one auth-required, read-only tool that accepts an empty request body ` +
      `(${PROBE_TASK_ALLOWLIST_HINT}) so the probe has a parameter-free protected target.`,
    toolName
  );
}

function malformedResponseProbe(graded: McpSessionAttempt, gradedTool: string): SessionProbeOutcome {
  if (graded.detail === 'request timed out' || graded.detail === 'request aborted') {
    return sessionProbeError(
      graded,
      `MCP session probe could not run: the agent answered ${graded.stage} with HTTP ` +
        `${graded.evidence.status} but never delivered a usable response to that request ` +
        `(${graded.detail}). This is not an authentication result — nothing was learned about this ` +
        `agent's credentials.`,
      gradedTool
    );
  }
  return sessionProbeError(
    graded,
    `MCP session probe could not run: the agent answered ${graded.stage} with HTTP ` +
      `${graded.evidence.status} but a body the official MCP client rejected (${graded.detail}). This is a ` +
      `response-shape problem, not an authentication result — nothing was learned about this agent's ` +
      `credentials. Return a conformant result for that operation, then re-run.`,
    gradedTool
  );
}

function inconclusiveSessionProbe(
  graded: McpSessionAttempt,
  reason: string,
  remedy: string,
  gradedTool: string
): SessionProbeOutcome {
  return sessionProbeError(
    graded,
    `MCP session auth probe is inconclusive: ${reason}, so this step's response is not evidence ` +
      `that the agent validates credentials. ${remedy}`,
    gradedTool
  );
}

function refusedSessionProbe(
  graded: McpSessionAttempt,
  reason: string,
  remedy: string,
  gradedTool: string
): SessionProbeOutcome {
  return sessionProbeError(
    graded,
    `MCP session auth probe refuses this as auth evidence: ${reason}. ${remedy}`,
    gradedTool
  );
}

function sessionProbeError(graded: McpSessionAttempt, message: string, gradedTool: string): SessionProbeOutcome {
  return {
    httpResult: { ...graded.evidence, error: message },
    taskResult: failedTaskResult(message),
    stage: graded.stage,
    detail: graded.detail,
    gradedTool,
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
