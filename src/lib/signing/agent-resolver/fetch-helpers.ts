/**
 * SSRF-safe HTTPS fetches for the brand_json_url discovery chain. Wraps
 * `ssrfSafeFetch` with the spec's body caps and the strict-JSON parser.
 * No redirects, no caching here — that's the resolver's responsibility
 * one layer up.
 *
 * Error translation lives here too: `SsrfRefusedError`'s `address` /
 * `hostname` fields MUST NOT propagate onto `AgentResolverError.detail`
 * (internal-topology leak). We surface the `code` only.
 */

import { ssrfSafeFetch, SsrfRefusedError, type SsrfFetchOptions } from '../../net';

import { parseStrictJson, StrictJsonError } from './strict-json';

export const MAX_CAPABILITIES_BYTES = 65_536;
export const MAX_BRAND_JSON_BYTES = 262_144;
export const MAX_JWKS_BYTES = 65_536;
export const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
export const DEFAULT_TOTAL_TIMEOUT_MS = 10_000;

export type FetchKind = 'capabilities' | 'brand.json' | 'jwks';

export class SafeFetchError extends Error {
  readonly kind: FetchKind;
  readonly httpStatus: number | undefined;
  readonly transport: 'fetch_failed' | 'timeout' | 'dns_error' | 'ssrf_refused' | 'body_cap';
  constructor(kind: FetchKind, transport: SafeFetchError['transport'], message: string, httpStatus?: number) {
    super(message);
    this.name = 'SafeFetchError';
    this.kind = kind;
    this.transport = transport;
    this.httpStatus = httpStatus;
  }
}

export interface SafeFetchJsonResult {
  body: unknown;
  status: number;
  headers: Record<string, string>;
  fetchedAt: number;
}

/**
 * Fetch a JSON document under the spec's SSRF rules with a hard body cap and
 * the strict-JSON parser. Network errors, body-cap overruns, and JSON parse
 * errors are translated to a typed `SafeFetchError` so the resolver can map
 * each onto a `request_signature_*` code without inspecting the underlying
 * cause.
 */
export async function safeFetchJson(
  url: string,
  kind: FetchKind,
  options: { allowPrivateIp?: boolean; timeoutMs?: number; maxBodyBytes: number }
): Promise<SafeFetchJsonResult> {
  const fetchOpts: SsrfFetchOptions = {
    method: 'GET',
    headers: { accept: 'application/json' },
    allowPrivateIp: options.allowPrivateIp === true,
    timeoutMs: options.timeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS,
    maxBodyBytes: options.maxBodyBytes,
  };

  let res;
  try {
    res = await ssrfSafeFetch(url, fetchOpts);
  } catch (err) {
    if (err instanceof SsrfRefusedError) {
      throw new SafeFetchError(kind, 'ssrf_refused', `${kind} fetch refused: ${err.code}`);
    }
    const message = err instanceof Error ? err.message : String(err);
    if (/abort|timed?\s*out/i.test(message)) {
      throw new SafeFetchError(kind, 'timeout', `${kind} fetch timed out`);
    }
    throw new SafeFetchError(kind, 'fetch_failed', `${kind} fetch failed`);
  }

  if (res.status < 200 || res.status >= 300) {
    throw new SafeFetchError(kind, 'fetch_failed', `${kind} fetch returned HTTP ${res.status}`, res.status);
  }

  let parsed: unknown;
  try {
    const text = Buffer.from(res.body).toString('utf8');
    parsed = parseStrictJson(text);
  } catch (err) {
    if (err instanceof StrictJsonError) {
      throw new SafeFetchError(kind, 'fetch_failed', `${kind} body failed strict-JSON parse: ${err.code}`);
    }
    throw new SafeFetchError(kind, 'fetch_failed', `${kind} body parse failed`);
  }

  return {
    body: parsed,
    status: res.status,
    headers: res.headers,
    fetchedAt: Math.floor(Date.now() / 1000),
  };
}
