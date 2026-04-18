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
import type { HttpProbeResult } from './types';

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
 */
export async function probeProtectedResourceMetadata(agentUrl: string): Promise<HttpProbeResult> {
  const u = new URL(agentUrl);
  const metadataUrl = `${u.origin}/.well-known/oauth-protected-resource${u.pathname}`;
  return fetchProbe(metadataUrl, { allowPrivateIp: false });
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
export async function probeOauthAuthServerMetadata(priorProbe: HttpProbeResult | undefined): Promise<HttpProbeResult> {
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
  return fetchProbe(metadataUrl, { allowPrivateIp: false });
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
