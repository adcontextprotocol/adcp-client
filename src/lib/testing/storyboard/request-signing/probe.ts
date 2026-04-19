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
 * Returns undefined when the header isn't a Signature challenge, the param
 * is absent, or the extracted value isn't a well-formed spec error code
 * (a token in `[a-z0-9_]+`). Sanitizing at source keeps downstream
 * diagnostics / LLM-consumption paths safe from smuggled content in
 * attacker-controlled header values.
 */
export function extractSignatureErrorCode(headerValue: string): string | undefined {
  // `WWW-Authenticate` may carry multiple challenges concatenated with commas.
  // We only grade Signature challenges; ignore Basic/Bearer/etc.
  const challenges = splitChallenges(headerValue);
  for (const challenge of challenges) {
    if (!/^Signature\b/i.test(challenge)) continue;
    const m = /\berror\s*=\s*"([^"]*)"/.exec(challenge);
    if (!m) continue;
    const value = m[1];
    // Spec error codes are `request_signature_*` — all lowercase-alnum +
    // underscore. Reject anything else so quotes/newlines/HTML/LLM-poisoning
    // content can't flow into diagnostic strings or rendered reports.
    if (value && /^[a-z0-9_]+$/.test(value)) return value;
    return undefined;
  }
  return undefined;
}

/**
 * Split a `WWW-Authenticate` header into per-challenge chunks. RFC 7235 §4.1
 * lets multiple challenges coexist separated by commas, and challenge params
 * are `k="v"` where `v` can contain commas. Track quote state so an
 * adversarial `error="foo, Bar baz"` doesn't spuriously split mid-value.
 */
function splitChallenges(headerValue: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inQuotes = false;
  let lastTokenWasScheme = false;
  for (let i = 0; i < headerValue.length; i++) {
    const ch = headerValue[i]!;
    if (ch === '"' && headerValue[i - 1] !== '\\') {
      inQuotes = !inQuotes;
      current += ch;
      continue;
    }
    if (!inQuotes && ch === ',') {
      // Look ahead for a scheme-like token (`<name><whitespace>`) — only
      // then treat this comma as a challenge boundary; otherwise it's a
      // param-list separator inside the current challenge.
      const rest = headerValue.slice(i + 1);
      if (/^\s*[A-Za-z][A-Za-z0-9-]*\s+/.test(rest)) {
        parts.push(current.trim());
        current = '';
        lastTokenWasScheme = false;
        continue;
      }
    }
    current += ch;
    if (!inQuotes && /\s/.test(ch)) lastTokenWasScheme = true;
  }
  if (current.trim().length > 0) parts.push(current.trim());
  void lastTokenWasScheme; // reserved for stricter validation if needed later
  return parts.filter(p => p.length > 0);
}
