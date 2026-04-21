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

import { AsyncLocalStorage } from 'node:async_hooks';

export interface RawHttpCapture {
  url: string;
  method: string;
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

export const rawResponseCaptureStorage = new AsyncLocalStorage<CaptureSlot>();

/**
 * Run `fn` with a raw-response capture slot active. Every HTTP request made
 * through the wrapped fetch inside `fn` is recorded.
 */
export async function withRawResponseCapture<T>(
  fn: () => Promise<T>,
  options: { maxBodyBytes?: number } = {}
): Promise<{ result: T; captures: RawHttpCapture[] }> {
  const slot: CaptureSlot = {
    captures: [],
    maxBodyBytes: options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
  };
  const result = await rawResponseCaptureStorage.run(slot, fn);
  return { result, captures: slot.captures };
}

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
    const startedAt = Date.now();
    const response = await upstream(input, init);
    const latencyMs = Date.now() - startedAt;

    // Clone before reading so the SDK still gets a consumable body.
    const cloneForRead = response.clone();
    const { body, bodyTruncated } = await readBodyBounded(cloneForRead, slot.maxBodyBytes);

    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });

    slot.captures.push({
      url,
      method,
      status: response.status,
      headers,
      body,
      latencyMs,
      timestamp: new Date(startedAt).toISOString(),
      bodyTruncated,
    });

    return response;
  };
  return wrapped;
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
