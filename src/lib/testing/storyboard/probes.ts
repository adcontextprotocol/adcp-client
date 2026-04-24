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
 */
import { randomBytes } from 'crypto';
import {
  ssrfSafeFetch,
  decodeBodyAsJsonOrText,
  SsrfRefusedError,
  isAlwaysBlocked as sharedIsAlwaysBlocked,
  isPrivateIp as sharedIsPrivateIp,
} from '../../net';
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
  options: { allowPrivateIp?: boolean } = {}
): Promise<HttpProbeResult> {
  const u = new URL(agentUrl);
  const metadataUrl = `${u.origin}/.well-known/oauth-protected-resource${u.pathname}`;
  return fetchProbe(metadataUrl, { allowPrivateIp: options.allowPrivateIp ?? false });
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
  options: { allowPrivateIp?: boolean } = {}
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
  return fetchProbe(metadataUrl, { allowPrivateIp: options.allowPrivateIp ?? false });
}

// ---------------------------------------------------------------------------
// Fetch with guardrails
// ---------------------------------------------------------------------------

export interface FetchProbeOptions {
  /** Allow http:// and private-IP destinations. Default false. */
  allowPrivateIp?: boolean;
  /** Override timeout for specific call sites. */
  timeoutMs?: number;
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

/**
 * POST a JSON-RPC `tools/call` request to the MCP endpoint with caller-provided
 * headers. Bypasses the MCP SDK so auth overrides (none / literal / strategy)
 * can be exercised and the raw HTTP status + `WWW-Authenticate` header can be
 * captured.
 *
 * **Known limitation**: this probe skips MCP Streamable HTTP session
 * initialization (`initialize` + `tools/list`). Agents that enforce
 * session-init before `tools/call` will return `-32002 Session not initialized`
 * (or similar). The probe detects that response and reports
 * `error: 'session_not_initialized'` on the synthetic TaskResult so callers
 * don't mistake it for a valid auth rejection. For agents that gate auth at
 * the HTTP/transport layer (the common pattern) the 401 + WWW-Authenticate
 * fires before the session check, which is what this probe is designed to see.
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
}): Promise<{ httpResult: HttpProbeResult; taskResult?: TaskResult }> {
  const { agentUrl, toolName, args, headers = {}, allowPrivateIp = false } = options;
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: ++probeRequestId,
    method: 'tools/call',
    params: { name: toolName, arguments: args },
  });

  const httpResult: HttpProbeResult = { url: agentUrl, status: 0, headers: {}, body: null };
  try {
    // Accept only JSON. Streamable-HTTP MCP servers that prefer SSE framing
    // will 406 or downgrade to JSON; we can't robustly parse event-stream
    // wire format in a probe without reimplementing the transport, and silently
    // misreading an SSE body would make expect_error steps falsely pass.
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
      // Body didn't parse — almost certainly SSE framing or HTML from an edge
      // proxy. We deliberately don't attempt SSE parsing (see the advertised
      // Accept gate above). Surface a distinct error so callers don't mistake
      // a non-JSON response for a silent success.
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
      result?: { structuredContent?: unknown; content?: unknown; isError?: boolean };
      error?: { message?: string; code?: number };
    };
    // HTTP-level failure trumps the JSON-RPC envelope — a 401/500 with any body
    // shape is still a failure.
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
      // MCP Streamable HTTP session-init errors — agents that require
      // `initialize` before `tools/call`. Distinct from auth failures so
      // downstream compliance reporting doesn't misdiagnose.
      const code = rpc.error.code;
      const isSessionInit =
        code === -32002 ||
        (typeof rpc.error.message === 'string' && /session.*(?:not.*)?initialized/i.test(rpc.error.message));
      return {
        httpResult,
        taskResult: {
          success: false,
          data: undefined,
          error: isSessionInit
            ? `MCP session not initialized (${code}: ${rpc.error.message ?? 'no message'}). rawMcpProbe skips the initialize handshake; strict servers will reject here before auth is evaluated.`
            : (rpc.error.message ?? `JSON-RPC error ${code}`),
          _extraction_path: 'error',
        },
      };
    }
    // Record which branch produced the data — rawMcpProbe reads the JSON-RPC
    // envelope directly, so the provenance is knowable here (unlike the SDK
    // path where we have to plumb it through the unwrapper).
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
    return { httpResult, taskResult: { success: !isError, data, _extraction_path: extractionPath } };
  } catch (err) {
    httpResult.error = err instanceof Error ? err.message : String(err);
    return { httpResult };
  }
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
