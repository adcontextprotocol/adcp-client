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
  requestJsonRpcMethod?: string;
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

// Request bodies are bounded as UTF-8 bytes while streaming. Response bodies
// retain the historical UTF-16 string cap below.
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
    const requestBody =
      init?.body !== undefined
        ? init.body
        : input instanceof Request
          ? await readRequestBodyFromClone(input, slot.maxBodyBytes)
          : undefined;
    const requestMetadata = extractSafeRequestMetadata(requestBody, slot.maxBodyBytes);
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

async function readRequestBodyFromClone(request: Request, maxBodyBytes: number): Promise<string | undefined> {
  if (request.bodyUsed || request.method === 'GET' || request.method === 'HEAD') return undefined;
  try {
    const body = request.clone().body;
    if (!body) return '';
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBodyBytes) {
        // This reader belongs to a tee created by Request.clone(). Awaiting
        // cancellation can deadlock until the original branch is consumed,
        // which cannot happen until this wrapper calls the upstream fetch.
        void reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
  } catch {
    return undefined;
  }
}

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
      const data = (part as { data?: unknown; content?: unknown }).data;
      const content = (part as { content?: unknown }).content;
      const nativeData =
        content != null && typeof content === 'object' && !Array.isArray(content)
          ? (content as { data?: unknown }).data
          : undefined;
      const value = data ?? nativeData;
      if (value == null || typeof value !== 'object' || Array.isArray(value)) continue;
      const skill = (value as { skill?: unknown }).skill;
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
