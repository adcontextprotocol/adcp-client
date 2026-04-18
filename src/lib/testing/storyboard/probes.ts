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
import { Agent, fetch as undiciFetch } from 'undici';
import type { HttpProbeResult } from './types';
import type { TaskResult } from '../types';

const PROBE_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 64 * 1024;
const ALLOWED_SCHEMES = new Set(['https:', 'http:']);

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
  const timeout = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const result: HttpProbeResult = { url, status: 0, headers: {}, body: null };

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    result.error = `Invalid URL: ${url}`;
    return result;
  }

  // Scheme gate: only http/https ever reachable. http only under dev opt-in.
  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    result.error = `Refusing to probe URL with unsupported scheme: ${parsed.protocol}`;
    return result;
  }
  if (parsed.protocol !== 'https:' && !options.allowPrivateIp) {
    result.error = `Refusing to probe non-HTTPS URL: ${url}`;
    return result;
  }

  // Resolve every A/AAAA once and validate the full set — `dnsLookup` without
  // `{ all: true }` picks one at random. An attacker that publishes a public
  // address alongside a private one would slip past a single-record check.
  let addresses: { address: string; family: number }[];
  try {
    addresses = await dnsLookup(parsed.hostname, { all: true });
  } catch (err) {
    result.error = `DNS lookup failed for ${parsed.hostname}: ${err instanceof Error ? err.message : String(err)}`;
    return result;
  }
  if (addresses.length === 0) {
    result.error = `DNS returned no addresses for ${parsed.hostname}`;
    return result;
  }
  // Always block IMDS / link-local, even when allowPrivateIp is set.
  for (const a of addresses) {
    if (isAlwaysBlocked(a.address)) {
      result.error = `Refusing to probe always-blocked address ${a.address} for ${parsed.hostname}`;
      return result;
    }
  }
  if (!options.allowPrivateIp) {
    for (const a of addresses) {
      if (isPrivateIp(a.address)) {
        result.error = `Refusing to probe private/loopback address ${a.address} for ${parsed.hostname}`;
        return result;
      }
    }
  }
  // Pin the connection to the resolved IP so undici doesn't re-resolve and
  // see a rebind. Picks the first address; all addresses were validated above.
  const pinned = addresses[0]!;
  const dispatcher = new Agent({
    connect: { lookup: (_h, _o, cb) => cb(null, pinned.address, pinned.family) },
  });

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);
  try {
    const res = await undiciFetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: ac.signal,
      headers: { accept: 'application/json' },
      dispatcher,
    });
    result.status = res.status;
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    result.headers = headers;

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
    await dispatcher.close().catch(() => {});
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
    // Accept only JSON. Streamable-HTTP MCP servers that prefer SSE framing
    // will 406 or downgrade to JSON; we can't robustly parse event-stream
    // wire format in a probe without reimplementing the transport, and silently
    // misreading an SSE body would make expect_error steps falsely pass.
    const res = await fetch(agentUrl, {
      method: 'POST',
      redirect: 'manual',
      signal: ac.signal,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
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
        taskResult: { success: false, data: undefined, error: rpc.error?.message ?? `HTTP ${httpResult.status}` },
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
        },
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
 * Fold IPv4-mapped and 6to4 IPv6 encodings back to their underlying IPv4
 * address so the classifier catches `::ffff:10.0.0.1`, `::ffff:169.254.169.254`,
 * `64:ff9b::a.b.c.d` (NAT64), and `2002:a.b.c.d::` (6to4). Returns null for
 * native IPv6 addresses.
 */
function extractEmbeddedIpv4(address: string): string | null {
  const lower = address.toLowerCase();
  // ::ffff:a.b.c.d or ::ffff:<hex>:<hex>
  const mapped = /^::ffff:(?:([0-9a-f]{1,4}):([0-9a-f]{1,4})|((?:\d{1,3}\.){3}\d{1,3}))$/i.exec(lower);
  if (mapped) {
    if (mapped[3]) return mapped[3]!;
    const hi = parseInt(mapped[1]!, 16);
    const lo = parseInt(mapped[2]!, 16);
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }
  // NAT64 well-known prefix 64:ff9b::a.b.c.d
  const nat64 = /^64:ff9b::((?:\d{1,3}\.){3}\d{1,3})$/i.exec(lower);
  if (nat64) return nat64[1]!;
  // 6to4: 2002:<v4-in-hex>::...
  const sixtofour = /^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4})(::|:)/i.exec(lower);
  if (sixtofour) {
    const hi = parseInt(sixtofour[1]!, 16);
    const lo = parseInt(sixtofour[2]!, 16);
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }
  return null;
}

/**
 * Addresses we block even when the dev opt-in `allowPrivateIp` is on — there
 * is no legitimate reason for a compliance probe to hit cloud metadata
 * endpoints (AWS IMDS, GCP metadata, Azure IMDS), and landing there in a CI
 * runner exfiltrates credentials.
 */
export function isAlwaysBlocked(address: string): boolean {
  const v4 = isIP(address) === 4 ? address : (extractEmbeddedIpv4(address) ?? '');
  if (v4) {
    const [a, b] = v4.split('.').map(Number);
    // 169.254/16 — link-local + IMDS (169.254.169.254).
    if (a === 169 && b === 254) return true;
  }
  const lower = address.toLowerCase();
  if (lower.startsWith('fe80:')) return true; // IPv6 link-local
  return false;
}

/**
 * Reject loopback, link-local, RFC 1918 private ranges, CGNAT (RFC 6598),
 * broadcast, multicast, the unspecified address, and IPv6 equivalents.
 * Unwraps IPv4-mapped/NAT64/6to4 IPv6 encodings before classifying.
 */
export function isPrivateIp(address: string): boolean {
  // Broadcast.
  if (address === '255.255.255.255') return true;

  const embedded = extractEmbeddedIpv4(address);
  const v4 = isIP(address) === 4 ? address : embedded;
  if (v4) {
    const [a, b] = v4.split('.').map(Number);
    if (a === 0) return true;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 100 && b! >= 64 && b! <= 127) return true; // RFC 6598 CGNAT 100.64/10
    if (a === 169 && b === 254) return true;
    if (a === 172 && b! >= 16 && b! <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a! >= 224 && a! <= 239) return true; // multicast
    if (a === 255) return true;
  }
  if (isIP(address) === 6) {
    const lower = address.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fe80:')) return true;
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
    if (lower.startsWith('ff')) return true; // multicast
  }
  return false;
}
