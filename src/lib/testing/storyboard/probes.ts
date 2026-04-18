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
import { lookup as dnsLookup } from 'dns/promises';
import { isIP } from 'net';
import { randomBytes } from 'crypto';
import type { HttpProbeResult } from './types';
import type { TaskResult } from '../types';

const PROBE_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 64 * 1024;

/** Task names dispatched via HTTP probes (not via the MCP client). */
export const PROBE_TASKS = new Set([
  'protected_resource_metadata',
  'oauth_auth_server_metadata',
  'assert_contribution',
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
 *   - HTTPS only unless `allowPrivateIp` overrides.
 *   - Resolves the hostname and rejects RFC 1918 / loopback / link-local unless overridden.
 *   - Does not follow redirects across hosts.
 *   - Caps response body at 64 KiB and total fetch time at 10 s.
 */
export async function fetchProbe(url: string, options: FetchProbeOptions = {}): Promise<HttpProbeResult> {
  const timeout = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const result: HttpProbeResult = { url, status: 0, headers: {}, body: null };

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    result.error = `Invalid URL: ${url}`;
    return result;
  }

  if (parsed.protocol !== 'https:' && !options.allowPrivateIp) {
    result.error = `Refusing to probe non-HTTPS URL: ${url}`;
    return result;
  }

  if (!options.allowPrivateIp) {
    try {
      const { address } = await dnsLookup(parsed.hostname);
      if (isPrivateIp(address)) {
        result.error = `Refusing to probe private/loopback address ${address} for ${parsed.hostname}`;
        return result;
      }
    } catch (err) {
      result.error = `DNS lookup failed for ${parsed.hostname}: ${err instanceof Error ? err.message : String(err)}`;
      return result;
    }
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: ac.signal,
      headers: { accept: 'application/json' },
    });
    result.status = res.status;
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    result.headers = headers;

    // Cap body size before consuming.
    const reader = res.body?.getReader();
    if (reader) {
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_BODY_BYTES) {
          await reader.cancel();
          result.error = `Response body exceeded ${MAX_BODY_BYTES} bytes`;
          return result;
        }
        chunks.push(value);
      }
      const buf = Buffer.concat(chunks.map(c => Buffer.from(c.buffer, c.byteOffset, c.byteLength)));
      const contentType = headers['content-type'] ?? '';
      if (contentType.includes('application/json')) {
        try {
          result.body = JSON.parse(buf.toString('utf8'));
        } catch {
          result.body = buf.toString('utf8');
        }
      } else {
        result.body = buf.toString('utf8');
      }
    }

    return result;
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    return result;
  } finally {
    clearTimeout(timer);
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
 * Returns an HttpProbeResult plus a synthetic TaskResult for steps that also
 * want to validate body shape — the structuredContent is unwrapped so
 * `field_present: "context"` resolves naturally.
 */
export async function rawMcpProbe(options: {
  agentUrl: string;
  toolName: string;
  args: Record<string, unknown>;
  headers?: Record<string, string>;
}): Promise<{ httpResult: HttpProbeResult; taskResult?: TaskResult }> {
  const { agentUrl, toolName, args, headers = {} } = options;
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: ++probeRequestId,
    method: 'tools/call',
    params: { name: toolName, arguments: args },
  });

  const httpResult: HttpProbeResult = { url: agentUrl, status: 0, headers: {}, body: null };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(agentUrl, {
      method: 'POST',
      redirect: 'manual',
      signal: ac.signal,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...headers,
      },
      body,
    });
    httpResult.status = res.status;
    const respHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      respHeaders[k.toLowerCase()] = v;
    });
    httpResult.headers = respHeaders;

    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      httpResult.body = text;
      return { httpResult };
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
        taskResult: { success: false, data: undefined, error: rpc.error?.message ?? `HTTP ${httpResult.status}` },
      };
    }
    if (rpc.error) {
      return {
        httpResult,
        taskResult: { success: false, data: undefined, error: rpc.error.message ?? `JSON-RPC error ${rpc.error.code}` },
      };
    }
    const data = rpc.result?.structuredContent ?? rpc.result?.content;
    return { httpResult, taskResult: { success: !rpc.result?.isError, data } };
  } catch (err) {
    httpResult.error = err instanceof Error ? err.message : String(err);
    return { httpResult };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reject loopback, link-local, and RFC 1918 private ranges (and IPv6
 * equivalents). Returns false for public addresses — those are the only ones
 * allowed when `allowPrivateIp` is false.
 */
export function isPrivateIp(address: string): boolean {
  const v = isIP(address);
  if (v === 4) {
    const [a, b] = address.split('.').map(Number);
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b! >= 16 && b! <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 0) return true;
    return false;
  }
  if (v === 6) {
    const lower = address.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fe80:')) return true; // link-local
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // ULA
    return false;
  }
  return false;
}
