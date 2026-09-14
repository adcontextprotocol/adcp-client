// Raw HTTP response capture for conformance probing.
//
// Scoped via AsyncLocalStorage so MCP + A2A protocol adapters can record
// status, headers, body, and latency without threading options through
// every call site. When the capture slot is absent, the fetch wrapper is a
// pass-through — production clients pay only one ALS lookup per request.
//
// Consumers call `withRawResponseCapture(fn)` and receive captures for
// every HTTP request that happened inside `fn`. The uniform-error invariant
// uses the captures to compare two probes byte-for-byte.

import { globalAsyncLocalStorage } from '../utils/global-async-local-storage';

export interface RawHttpCapture {
  url: string;
  method: string;
  /** JSON-RPC method parsed from a JSON request body, when available. */
  requestJsonRpcMethod?: string;
  /** AdCP skill parsed from an A2A SendMessage request, when available. */
  requestAdcpSkill?: string;
  status: number;
  headers: Record<string, string>;
  body: string;
  latencyMs: number;
  timestamp: string;
  /** True when body capture hit `maxBodyBytes` and was truncated. */
  bodyTruncated: boolean;
}

interface CaptureSlot {
  captures: RawHttpCapture[];
  maxBodyBytes: number;
}

// Counted as UTF-16 code units (string.length), not UTF-8 bytes. Close
// enough for ASCII-dominant response payloads and fine as a safety cap
// against accidentally retaining huge responses.
const DEFAULT_MAX_BODY_BYTES = 1_048_576;

export const rawResponseCaptureStorage = globalAsyncLocalStorage<CaptureSlot>('rawResponseCapture');

/**
 * Run `fn` with a raw-response capture slot active. Every HTTP request made
 * through the wrapped fetch inside `fn` is recorded.
 *
 * When `fn` rejects, the rejection propagates and the partial captures
 * are attached to the thrown error as `error.captures`. Callers that
 * need to inspect partial captures on failure can read that property;
 * callers that don't can ignore it. This lets storyboard validators
 * surface "the SDK threw before the wire shape parsed" diagnostics
 * with the actual bytes that arrived before the throw.
 */
export async function withRawResponseCapture<T>(
  fn: () => Promise<T>,
  options: { maxBodyBytes?: number } = {}
): Promise<{ result: T; captures: RawHttpCapture[] }> {
  const slot: CaptureSlot = {
    captures: [],
    maxBodyBytes: options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
  };
  try {
    const result = await rawResponseCaptureStorage.run(slot, fn);
    return { result, captures: slot.captures };
  } catch (err) {
    if (err && typeof err === 'object') {
      try {
        Object.defineProperty(err, 'captures', {
          value: slot.captures,
          enumerable: false,
          configurable: true,
          writable: true,
        });
      } catch {
        // Frozen / sealed errors won't accept the property — drop the
        // captures rather than crash on a defineProperty TypeError.
      }
    }
    throw err;
  }
}

/** Type guard for errors carrying partial captures from `withRawResponseCapture`. */
export function getCapturesFromError(err: unknown): RawHttpCapture[] | undefined {
  if (err && typeof err === 'object' && Array.isArray((err as { captures?: unknown }).captures)) {
    return (err as { captures: RawHttpCapture[] }).captures;
  }
  return undefined;
}

/**
 * Credential-bearing response header names. A misbehaving proxy that
 * echoes caller-supplied auth headers back on the response would
 * otherwise land bearer tokens in the capture — and downstream, in
 * `UniformErrorReport.probes.*.headers` which is written to disk /
 * pasted into tickets. Redact verbatim at capture time.
 */
const REDACTED_HEADER_NAMES: ReadonlySet<string> = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-adcp-auth',
  'x-api-key',
]);

const REDACTED_PLACEHOLDER = '[redacted]';

/**
 * Wrap a fetch implementation so it records raw responses when a capture
 * slot is active. Safe to install unconditionally — pass-through when no
 * slot is set.
 */
export function wrapFetchWithCapture(upstream: typeof fetch): typeof fetch {
  const wrapped: typeof fetch = async (input, init) => {
    const slot = rawResponseCaptureStorage.getStore();
    if (!slot) return upstream(input, init);

    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const requestMetadata = extractSafeRequestMetadata(init?.body, slot.maxBodyBytes);
    const startedAt = Date.now();
    const response = await upstream(input, init);
    const latencyMs = Date.now() - startedAt;

    // Clone before reading so the SDK still gets a consumable body.
    const cloneForRead = response.clone();
    const { body, bodyTruncated } = await readBodyBounded(cloneForRead, slot.maxBodyBytes);

    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      const lower = key.toLowerCase();
      headers[key] = REDACTED_HEADER_NAMES.has(lower) ? REDACTED_PLACEHOLDER : value;
    });

    slot.captures.push({
      url,
      method,
      ...requestMetadata,
      status: response.status,
      headers,
      body: redactBearerInBody(body),
      latencyMs,
      timestamp: new Date(startedAt).toISOString(),
      bodyTruncated,
    });

    return response;
  };
  return wrapped;
}

/**
 * Retain only the non-secret identifiers needed to correlate a captured A2A
 * response with its request. The request payload itself can contain account
 * data and credentials, so it is deliberately never stored in the capture.
 */
function extractSafeRequestMetadata(
  body: BodyInit | null | undefined,
  maxBodyBytes: number
): Pick<RawHttpCapture, 'requestJsonRpcMethod' | 'requestAdcpSkill'> {
  if (typeof body !== 'string' || body.length > maxBodyBytes) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return {};
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

  const envelope = parsed as { method?: unknown; params?: unknown };
  const requestJsonRpcMethod = typeof envelope.method === 'string' ? envelope.method : undefined;
  let requestAdcpSkill: string | undefined;
  const params =
    envelope.params != null && typeof envelope.params === 'object' && !Array.isArray(envelope.params)
      ? (envelope.params as { message?: unknown })
      : undefined;
  const message =
    params?.message != null && typeof params.message === 'object' && !Array.isArray(params.message)
      ? (params.message as { parts?: unknown })
      : undefined;
  if (Array.isArray(message?.parts)) {
    for (const part of message.parts) {
      if (part == null || typeof part !== 'object' || Array.isArray(part)) continue;
      const data = (part as { data?: unknown }).data;
      if (data == null || typeof data !== 'object' || Array.isArray(data)) continue;
      const skill = (data as { skill?: unknown }).skill;
      if (typeof skill === 'string') {
        requestAdcpSkill = skill;
        break;
      }
    }
  }

  return {
    ...(requestJsonRpcMethod !== undefined && { requestJsonRpcMethod }),
    ...(requestAdcpSkill !== undefined && { requestAdcpSkill }),
  };
}

/**
 * Response bodies sometimes echo request headers — e.g., a misbehaving
 * "debug" handler that logs the Authorization header into its error
 * payload, or a 500 HTML page that templates the request dump. Strip
 * bearer-shaped tokens so they don't persist into captured output.
 *
 * Conservative: only masks the TOKEN portion of a `Bearer <token>` span
 * (case-insensitive). Doesn't try to detect arbitrary high-entropy
 * strings — false positives on those would damage the comparator's
 * byte-equivalence check.
 */
function redactBearerInBody(body: string): string {
  return body.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]');
}

async function readBodyBounded(
  response: Response,
  maxBodyBytes: number
): Promise<{ body: string; bodyTruncated: boolean }> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return { body: '', bodyTruncated: false };
  }
  if (text.length <= maxBodyBytes) return { body: text, bodyTruncated: false };
  return { body: text.slice(0, maxBodyBytes), bodyTruncated: true };
}
