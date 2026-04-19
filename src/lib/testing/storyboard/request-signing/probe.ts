import { lookup as dnsLookup } from 'dns/promises';
import { Agent, fetch as undiciFetch } from 'undici';
import { isAlwaysBlocked, isPrivateIp } from '../probes';
import type { SignedHttpRequest } from './builder';

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 64 * 1024;

export interface ProbeOptions {
  /** Allow http:// and private-IP destinations. Default false. */
  allowPrivateIp?: boolean;
  /** Per-call timeout override (ms). */
  timeoutMs?: number;
}

export interface ProbeResult {
  url: string;
  status: number;
  headers: Record<string, string>;
  /** Error code extracted from `WWW-Authenticate: Signature error="<code>"`. */
  wwwAuthenticateErrorCode?: string;
  /** Truncated response body (first 64 KiB, JSON-parsed if applicable). */
  body: unknown;
  /** Network-level error; non-undefined means the request didn't complete. */
  error?: string;
  duration_ms: number;
}

/**
 * Send a signed HTTP request to an AdCP agent and capture the response fields
 * needed for conformance grading (status, WWW-Authenticate error code, body).
 *
 * Reuses the SSRF guards established by `fetchProbe` — same classifier, same
 * IP pin against DNS rebinding. Bodies are capped at 64 KiB and parsed as JSON
 * when content-type matches; otherwise returned as text. `redirect: 'manual'`
 * is enforced so an agent that 301s can't smuggle the grader elsewhere.
 */
export async function probeSignedRequest(
  signed: SignedHttpRequest,
  options: ProbeOptions = {}
): Promise<ProbeResult> {
  const start = Date.now();
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const result: ProbeResult = { url: signed.url, status: 0, headers: {}, body: null, duration_ms: 0 };

  let parsed: URL;
  try {
    parsed = new URL(signed.url);
  } catch {
    result.error = `Invalid URL: ${signed.url}`;
    result.duration_ms = Date.now() - start;
    return result;
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    result.error = `Refusing to probe URL with unsupported scheme: ${parsed.protocol}`;
    result.duration_ms = Date.now() - start;
    return result;
  }
  if (parsed.protocol !== 'https:' && !options.allowPrivateIp) {
    result.error = `Refusing to probe non-HTTPS URL: ${signed.url}`;
    result.duration_ms = Date.now() - start;
    return result;
  }

  let addresses: { address: string; family: number }[];
  try {
    addresses = await dnsLookup(parsed.hostname, { all: true });
  } catch (err) {
    result.error = `DNS lookup failed for ${parsed.hostname}: ${err instanceof Error ? err.message : String(err)}`;
    result.duration_ms = Date.now() - start;
    return result;
  }
  if (addresses.length === 0) {
    result.error = `DNS returned no addresses for ${parsed.hostname}`;
    result.duration_ms = Date.now() - start;
    return result;
  }
  for (const a of addresses) {
    if (isAlwaysBlocked(a.address)) {
      result.error = `Refusing to probe always-blocked address ${a.address} for ${parsed.hostname}`;
      result.duration_ms = Date.now() - start;
      return result;
    }
  }
  if (!options.allowPrivateIp) {
    for (const a of addresses) {
      if (isPrivateIp(a.address)) {
        result.error = `Refusing to probe private/loopback address ${a.address} for ${parsed.hostname}`;
        result.duration_ms = Date.now() - start;
        return result;
      }
    }
  }
  const pinned = addresses[0]!;
  const dispatcher = new Agent({
    connect: { lookup: (_h, _o, cb) => cb(null, pinned.address, pinned.family) },
  });

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);
  try {
    const res = await undiciFetch(signed.url, {
      method: signed.method,
      redirect: 'manual',
      signal: ac.signal,
      headers: signed.headers,
      body: signed.body,
      dispatcher,
    });
    result.status = res.status;
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    result.headers = headers;

    const wwwAuth = headers['www-authenticate'];
    if (wwwAuth) {
      result.wwwAuthenticateErrorCode = extractSignatureErrorCode(wwwAuth);
    }

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
    result.duration_ms = Date.now() - start;
    await dispatcher.close().catch(() => {});
  }
}

/**
 * Extract `error="<code>"` from a `WWW-Authenticate: Signature ...` header.
 * Returns undefined when the header isn't a Signature challenge or the param
 * is absent — grading treats that as a mismatch (agent returned 401 but
 * didn't advertise a stable error code).
 */
export function extractSignatureErrorCode(headerValue: string): string | undefined {
  // `WWW-Authenticate` may carry multiple challenges concatenated with commas.
  // We only grade Signature challenges; ignore Basic/Bearer/etc.
  const challenges = splitChallenges(headerValue);
  for (const challenge of challenges) {
    if (!/^Signature\b/i.test(challenge)) continue;
    const m = /\berror\s*=\s*"([^"]*)"/.exec(challenge);
    if (m) return m[1];
  }
  return undefined;
}

function splitChallenges(headerValue: string): string[] {
  // Split on commas, but only when the preceding token looks like a scheme name
  // followed by whitespace. Challenge params are `k="v"` which may contain
  // commas — split on the scheme boundary only.
  const parts: string[] = [];
  let start = 0;
  const re = /,\s*([A-Za-z][A-Za-z0-9-]*\s+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(headerValue)) !== null) {
    parts.push(headerValue.slice(start, m.index).trim());
    start = m.index + m[0].length - m[1]!.length;
  }
  parts.push(headerValue.slice(start).trim());
  return parts.filter(p => p.length > 0);
}
