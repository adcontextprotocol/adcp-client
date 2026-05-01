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
 * Strip the search component from a URL before storing it on
 * `ResponseTooLargeError`. Some agents publish manifests with auth tokens
 * in the query string (`?api_key=…`); without redaction those land in
 * `err.message`, `err.details.url`, and downstream log sinks.
 *
 * Returns the input unchanged when it can't be parsed (relative paths,
 * non-URL inputs from custom test stubs) — the alternative is throwing,
 * which would mask the original `ResponseTooLargeError`.
 */
function redactUrlForError(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.search = '';
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * Force `Accept-Encoding: identity` on outgoing requests when the size cap
 * is active. Without this, undici sets `Accept-Encoding: gzip, deflate, br`
 * by default and decompresses the body before our counter sees it — a
 * hostile vendor can ship a 5 KB gzip blob that decompresses to GBs and
 * costs the attacker nothing for asymmetric CPU burn before the cap fires.
 * Forcing identity removes the asymmetry: the bomb has to be sent on the
 * wire at full size, where `Content-Length` pre-check catches it.
 *
 * No-op when the caller already set their own `Accept-Encoding` (signing
 * fetch may need a specific value to keep the signed bytes stable).
 */
function withIdentityEncoding(init: RequestInit | undefined): RequestInit {
  const headers = new Headers(init?.headers);
  if (!headers.has('accept-encoding')) {
    headers.set('accept-encoding', 'identity');
  }
  return { ...(init ?? {}), headers };
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

    const response = await upstream(input, withIdentityEncoding(init));
    return enforceSizeLimit(response, slot.maxResponseBytes, redactUrlForError(urlOfInput(input)));
  };
  return wrapped;
}

function enforceSizeLimit(response: Response, maxBytes: number, url: string): Response {
  // SSE is unbounded by design. Server-initiated message streams and the
  // MCP transport's long-lived GET /mcp side channel legitimately emit
  // frames indefinitely. Don't cap them — return the original response.
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    return response;
  }

  // Cheap pre-check: if the server declares a Content-Length over the cap,
  // tear the connection down before reading any of the body. Servers can
  // omit or lie about Content-Length, which is why the streaming counter
  // below is the authoritative enforcement.
  const declared = parseContentLength(response.headers.get('content-length'));
  if (declared !== undefined && declared > maxBytes) {
    // Best-effort cancel so the runtime can release the socket. We swallow
    // any rejection because the typed `ResponseTooLargeError` below is the
    // signal the caller acts on — a `cancel()` rejection here would only
    // happen if the body stream is already errored / locked, in which case
    // the socket is already on its way down and there's nothing to recover.
    response.body?.cancel().catch(() => {});
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
