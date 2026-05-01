// Response-body byte cap enforcement for hostile-vendor protection.
//
// Wraps a base fetch with a streaming size counter so the SDK aborts large
// responses before any application-layer parsing buffers them. Active when
// `responseSizeLimitStorage` carries a slot — installed unconditionally as
// the innermost transport wrapper so production callers without the slot
// pay only one ALS lookup per request.
//
// The wrapper composes inside `wrapFetchWithCapture`: the diagnostic capture
// reads the size-limited body via `response.clone()`, so a hostile reply
// can't blow memory through the capture path either.

import { AsyncLocalStorage } from 'node:async_hooks';
import { ResponseTooLargeError } from '../errors';

interface SizeLimitSlot {
  maxResponseBytes: number;
}

export const responseSizeLimitStorage = new AsyncLocalStorage<SizeLimitSlot>();

/**
 * Run `fn` with a response body byte cap active. Every fetch made through
 * a wrapped transport inside `fn` aborts with `ResponseTooLargeError` when
 * the response body exceeds `maxResponseBytes`. Non-positive caps disable
 * enforcement (ALS slot is not entered).
 */
export function withResponseSizeLimit<T>(maxResponseBytes: number | undefined, fn: () => Promise<T>): Promise<T> {
  if (!maxResponseBytes || !Number.isFinite(maxResponseBytes) || maxResponseBytes <= 0) {
    return fn();
  }
  return responseSizeLimitStorage.run({ maxResponseBytes }, fn);
}

function urlOfInput(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

/**
 * Wrap a fetch implementation so its responses honor the size cap from the
 * active `responseSizeLimitStorage` slot. Pass-through when no slot is set.
 *
 * Pre-checks `Content-Length` and refuses to read the body when the declared
 * size already exceeds the cap. Otherwise wraps `Response.body` in a
 * `TransformStream` that counts bytes and errors with `ResponseTooLargeError`
 * at the cap boundary, propagating to anyone reading the response (including
 * `Response.clone()` branches used by the diagnostic capture wrapper).
 */
export function wrapFetchWithSizeLimit(upstream: typeof fetch): typeof fetch {
  const wrapped: typeof fetch = async (input, init) => {
    const slot = responseSizeLimitStorage.getStore();
    if (!slot) return upstream(input, init);

    const response = await upstream(input, init);
    return enforceSizeLimit(response, slot.maxResponseBytes, urlOfInput(input));
  };
  return wrapped;
}

function enforceSizeLimit(response: Response, maxBytes: number, url: string): Response {
  // Cheap pre-check: if the server declares a Content-Length over the cap,
  // tear the connection down before reading any of the body. Servers can
  // omit or lie about Content-Length, which is why the streaming counter
  // below is the authoritative enforcement.
  const declared = parseContentLength(response.headers.get('content-length'));
  if (declared !== undefined && declared > maxBytes) {
    response.body?.cancel().catch(() => {
      /* socket already closed by transport */
    });
    throw new ResponseTooLargeError(maxBytes, 0, url, declared);
  }

  if (!response.body) return response;

  let bytesRead = 0;
  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytesRead += chunk.byteLength;
      if (bytesRead > maxBytes) {
        controller.error(new ResponseTooLargeError(maxBytes, bytesRead, url));
        return;
      }
      controller.enqueue(chunk);
    },
  });

  return new Response(response.body.pipeThrough(counter), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function parseContentLength(value: string | null): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}
