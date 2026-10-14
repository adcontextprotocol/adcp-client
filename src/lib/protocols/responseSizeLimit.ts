// Response-body byte cap enforcement for hostile-vendor protection.
//
// Wraps a base fetch with a streaming size counter so the SDK aborts large
// responses before any application-layer parsing buffers them. **On by
// default** (`DEFAULT_MAX_RESPONSE_BYTES`, 4 MiB) — agent responses are
// untrusted input, so the protection cannot depend on every adopter
// remembering to opt in (adcp-client#3253, adcontextprotocol/adcp#8190).
//
// `responseSizeLimitStorage` carries the per-call override: a slot with a
// numeric cap narrows or widens the default, and a slot with `null` is the
// explicit opt-out. With no slot the wrapper still applies the default, so a
// transport that fetches outside any `withResponseSizeLimit(...)` scope
// (OAuth token refresh, agent-card probes) is covered too.
//
// The counter sits downstream of the runtime's content-decoder, so it
// measures *decompressed* octets. That is the number that matters: a 5 KB
// gzip blob that inflates to gigabytes trips the cap after 4 MiB of output,
// and the SDK never asks for `Accept-Encoding: identity` — a hostile peer
// would ignore the request anyway, and forcing it would cost every honest
// adopter their response compression.
//
// The wrapper composes inside `wrapFetchWithCapture`: the diagnostic capture
// reads the size-limited body via `response.clone()`, so a hostile reply
// can't blow memory through the capture path either.

import { globalAsyncLocalStorage } from '../utils/global-async-local-storage';
import { ResponseTooLargeError } from '../errors';
import { sanitizeTransportUrl } from './transportDiagnostics';

/**
 * Default response-body cap, in octets. Applied to every agent response on
 * the MCP and A2A call paths (tool calls, discovery, `tools/list`, agent
 * card) unless the caller overrides it.
 *
 * 4 MiB matches the hosted compliance grader's cap and the SDK's own probe
 * caps. Raise it per client or per call with `transport.maxResponseBytes`
 * when an agent legitimately publishes a large catalog.
 */
export const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/**
 * Multiplier applied to the per-response cap to derive the cumulative
 * byte budget for `text/event-stream` responses in a single call.
 *
 * SSE needs two numbers, not one. The per-event cap is the memory bound —
 * a consumer buffers one event frame before dispatching it, so no single
 * event may exceed `maxResponseBytes`. The cumulative budget is the
 * liveness bound — it stops a peer from holding a connection open and
 * streaming forever in well-formed small frames.
 *
 * Deliberately small. Every multiple is a multiple a hostile peer can claim
 * for free by putting `Content-Type: text/event-stream` on an ordinary reply
 * and inserting a blank line every kilobyte, so the gap between the headline
 * cap and the worst case an adopter can actually suffer should stay narrow.
 * `2` leaves room for a normal tool call (many small status frames plus one
 * result frame) without turning the advertised 4 MiB into 32 MiB.
 */
export const SSE_CUMULATIVE_BUDGET_MULTIPLIER = 2;

/**
 * Cumulative `text/event-stream` octets consumed so far. Shared by reference
 * across nested `withResponseSizeLimit` scopes so a call spends one
 * allowance, not one per SDK layer it passes through.
 */
interface StreamMeter {
  consumed: number;
}

interface SizeLimitSlot {
  /**
   * Per-response cap in octets, or `null` when the caller explicitly opted
   * out of enforcement for this scope.
   */
  maxResponseBytes: number | null;
  /**
   * Cumulative SSE allowance for this scope, in octets. Absent when
   * enforcement is disabled.
   */
  streamLimit?: number;
  /**
   * Shared consumption counter for `text/event-stream` responses. Inherited
   * from the enclosing scope so nesting narrows the allowance but never
   * refills it. Absent when enforcement is disabled.
   */
  streamMeter?: StreamMeter;
  /**
   * First cap violation observed in this scope. A `TransformStream` error
   * reaches whoever reads the body, and some transports swallow it: the MCP
   * SDK treats a failed SSE read as a stream disconnect, retries, and lets
   * the request time out. Recording the typed error here lets
   * `withResponseSizeLimit` re-surface it instead of handing the caller an
   * unrelated timeout. See `rethrowRecordedViolation`.
   */
  violation?: ResponseTooLargeError;
}

export const responseSizeLimitStorage = globalAsyncLocalStorage<SizeLimitSlot>('responseSizeLimit');

/**
 * Resolve a caller-supplied cap to the value the wrapper enforces.
 *
 * - `undefined` → `DEFAULT_MAX_RESPONSE_BYTES` (on by default).
 * - a positive finite number → that number.
 * - `NaN`, `Infinity`, or a negative number → `DEFAULT_MAX_RESPONSE_BYTES`.
 *   Those all arrive from a mistake rather than an intention — a misparsed
 *   env var, a remaining-budget subtraction that went below zero — and
 *   failing closed on the default is safer than silently disabling the cap.
 * - exactly `0` → `null`, the one explicit opt-out.
 */
function resolveResponseSizeCap(maxResponseBytes: number | undefined): number | null {
  if (maxResponseBytes === undefined) return DEFAULT_MAX_RESPONSE_BYTES;
  if (maxResponseBytes === 0) return null;
  if (!Number.isFinite(maxResponseBytes) || maxResponseBytes < 0) return DEFAULT_MAX_RESPONSE_BYTES;
  return maxResponseBytes;
}

function newSlot(maxResponseBytes: number | undefined): SizeLimitSlot {
  const resolved = resolveResponseSizeCap(maxResponseBytes);
  if (resolved === null) return { maxResponseBytes: null };
  // Narrow the enclosing allowance, never refill it: `callTool` and
  // `callMCPToolWithTasks` both re-enter with the same explicit cap, and a
  // fresh meter per layer would multiply the cumulative SSE bound by the
  // nesting depth — leaving the adopter who configured a cap *less*
  // protected than the one who configured nothing.
  const enclosing = responseSizeLimitStorage.getStore();
  const limit = sseBudgetFor(resolved);
  return {
    maxResponseBytes: resolved,
    streamLimit: Math.min(limit, enclosing?.streamLimit ?? limit),
    streamMeter: enclosing?.streamMeter ?? { consumed: 0 },
  };
}

/**
 * Cumulative SSE allowance for a call. Clamped to `Number.MAX_SAFE_INTEGER`
 * so an absurdly large `maxResponseBytes` can't multiply out to `Infinity`
 * and quietly turn the stream allowance back off.
 */
function sseBudgetFor(maxResponseBytes: number): number {
  return Math.min(maxResponseBytes * SSE_CUMULATIVE_BUDGET_MULTIPLIER, Number.MAX_SAFE_INTEGER);
}

/**
 * Run `fn` with a response body byte cap active. Every fetch made through
 * a wrapped transport inside `fn` aborts with `ResponseTooLargeError` when
 * the response body exceeds the cap.
 *
 * Passing `undefined` installs `DEFAULT_MAX_RESPONSE_BYTES` — unless an
 * enclosing scope already set one, in which case the enclosing cap and its
 * cumulative SSE budget are inherited. Nested SDK layers re-enter this
 * helper on the way down (`callTool` → `callMCPToolWithTasks`), and without
 * the inheritance an inner layer that wasn't handed the caller's `transport`
 * would silently widen a tight outer cap back to the default.
 *
 * Passing exactly `0` is the explicit opt-out: the slot is entered with
 * enforcement disabled so an enclosing scope's cap (and the default the fetch
 * wrapper would otherwise apply) is suppressed for the duration. `Infinity`
 * and negative numbers are *not* opt-outs — they fall back to the default.
 */
export function withResponseSizeLimit<T>(maxResponseBytes: number | undefined, fn: () => Promise<T>): Promise<T> {
  if (maxResponseBytes === undefined && responseSizeLimitStorage.getStore()) {
    return fn();
  }
  const slot = newSlot(maxResponseBytes);
  return responseSizeLimitStorage.run(slot, () => rethrowRecordedViolation(slot, fn));
}

/**
 * Give the caller the typed error even when the transport swallowed it.
 *
 * Erroring a `TransformStream` surfaces to whoever reads the body, and not
 * every transport propagates that verbatim: the MCP SDK classifies a failed
 * `text/event-stream` read as a stream disconnect, reconnects, and lets the
 * in-flight request run out its deadline. Without this the buyer sees a
 * `TaskTimeoutError` for what is really an over-cap response, and the
 * documented `ResponseTooLargeError` recovery (raise the cap or flag the
 * agent) never reaches them.
 *
 * Only rewrites a rejection — a scope that recovered and completed stays
 * successful, so a retried call that eventually got an in-cap response is
 * not failed retroactively.
 */
async function rethrowRecordedViolation<T>(slot: SizeLimitSlot, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const violation = slot.violation;
    if (!violation || error instanceof ResponseTooLargeError) throw error;
    const surfaced = new ResponseTooLargeError(
      violation.limit,
      violation.bytesRead,
      violation.url,
      violation.contentLengthHeader
    );
    // Non-enumerable, matching the `cause` convention the other ADCP errors
    // use so reflected/serialized errors don't grow a transport blob.
    Object.defineProperty(surfaced, 'cause', { value: error, configurable: true });
    throw surfaced;
  }
}

/** Record the first violation of a scope so `withResponseSizeLimit` can re-surface it. */
function recordViolation(slot: SizeLimitSlot | undefined, error: ResponseTooLargeError): ResponseTooLargeError {
  if (slot && !slot.violation) slot.violation = error;
  return error;
}

function urlOfInput(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

/**
 * Wrap a fetch implementation so its responses honor the response size cap.
 *
 * Uses the active `responseSizeLimitStorage` slot when there is one, and
 * `DEFAULT_MAX_RESPONSE_BYTES` when there isn't — the cap is on by default,
 * not conditional on a caller having opened a scope. Only an explicit
 * opt-out slot (`withResponseSizeLimit(0, …)`) disables it.
 *
 * Pre-checks `Content-Length` and refuses to read the body when the declared
 * size already exceeds the cap. Otherwise wraps `Response.body` in a
 * `TransformStream` that counts bytes and errors with `ResponseTooLargeError`
 * at the cap boundary, propagating to anyone reading the response (including
 * `Response.clone()` branches used by the diagnostic capture wrapper).
 *
 * `text/event-stream` responses are enforced too, with a per-event cap and a
 * cumulative per-call budget — see `enforceEventStreamLimit`.
 */
export function wrapFetchWithSizeLimit(upstream: typeof fetch): typeof fetch {
  const wrapped: typeof fetch = async (input, init) => {
    const slot = responseSizeLimitStorage.getStore();
    const maxBytes = slot ? slot.maxResponseBytes : DEFAULT_MAX_RESPONSE_BYTES;
    if (maxBytes === null) return upstream(input, init);

    const response = await upstream(input, init);
    // A HEAD reply's `Content-Length` describes the body the server *would*
    // have sent, not bytes on the wire, and 204/304 carry none either. The
    // pre-check would reject those as oversized despite nothing to buffer.
    if (carriesNoBody(input, init, response)) return response;
    // `sanitizeTransportUrl` clears userinfo, query and fragment, and
    // returns `'invalid_url'` for anything unparseable. `ResponseTooLargeError`
    // now fires on ordinary calls rather than only for adopters who opted in,
    // so its `url` lands in logs and error envelopes routinely.
    const url = sanitizeTransportUrl(urlOfInput(input));
    if (isEventStream(response)) {
      const { limit, meter } = streamBudgetFor(input, init, slot, maxBytes);
      return enforceEventStreamLimit(response, maxBytes, limit, meter, url, slot);
    }
    return enforceSizeLimit(response, maxBytes, url, slot);
  };
  return wrapped;
}

/**
 * Pick the cumulative budget an event-stream response charges against.
 *
 * Call-scoped streams share the call's budget — that is what "cumulative per
 * call" means, and it stops a peer from resetting its allowance by splitting
 * a flood across several replies.
 *
 * `GET` event-streams are the exception. MCP's standalone listener and the
 * legacy SSE transport open one `GET` stream that carries server→client
 * traffic for the whole *session*, and the connection cache keeps it alive
 * long after the call that established it returned. Its fetch still runs in
 * that first call's async context, so sharing the call's budget would charge
 * an open-ended session against a one-call allowance: the listener would die
 * mid-session once the allowance ran out, through no fault of any single
 * response. Give it a fresh budget per connection instead — still bounded,
 * just bounded per stream rather than per call.
 *
 * The cap *value* for such a listener is whatever the establishing call
 * configured; that is a property of the connection cache, not of this
 * wrapper. Re-establish the connection (`closeConnections()`) to pick up a
 * different transport policy.
 */
function streamBudgetFor(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  slot: SizeLimitSlot | undefined,
  maxBytes: number
): { limit: number; meter: StreamMeter } {
  const connectionScoped = methodOf(input, init) === 'GET';
  if (!connectionScoped && slot?.streamMeter) {
    return { limit: slot.streamLimit ?? sseBudgetFor(maxBytes), meter: slot.streamMeter };
  }
  return { limit: sseBudgetFor(maxBytes), meter: { consumed: 0 } };
}

/** Effective request method, honoring a `Request` input's own method. */
function methodOf(input: RequestInfo | URL, init: RequestInit | undefined): string {
  const method = init?.method ?? (typeof Request !== 'undefined' && input instanceof Request ? input.method : 'GET');
  return method.toUpperCase();
}

/**
 * Responses that definitionally carry no body, so there is nothing for the
 * cap to bound and a declared `Content-Length` would be a false positive.
 */
function carriesNoBody(input: RequestInfo | URL, init: RequestInit | undefined, response: Response): boolean {
  if (NULL_BODY_STATUSES.has(response.status)) return true;
  return methodOf(input, init) === 'HEAD';
}

/**
 * Statuses the `Response` constructor refuses to pair with a body. Returning
 * these untouched keeps `respondWith` from turning a hostile-but-harmless
 * reply into an untyped `TypeError` — undici never hands us a body on them,
 * but an adopter `trustedFetchFn` or a test double can.
 */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

/**
 * Case-insensitive prefix match so `text/event-stream; charset=utf-8` and
 * `Text/Event-Stream` are both recognised.
 */
function isEventStream(response: Response): boolean {
  return response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream') === true;
}

function enforceSizeLimit(response: Response, maxBytes: number, url: string, slot?: SizeLimitSlot): Response {
  // Cheap pre-check: if the server declares a Content-Length over the cap,
  // tear the connection down before reading any of the body. Servers can
  // omit or lie about Content-Length, which is why the streaming counter
  // below is the authoritative enforcement.
  const declared = parseContentLength(response.headers.get('content-length'));
  if (declared !== undefined && declared > maxBytes) {
    cancelBody(response);
    throw recordViolation(slot, new ResponseTooLargeError(maxBytes, 0, url, declared));
  }

  if (!response.body) return response;

  let bytesRead = 0;
  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytesRead += chunk.byteLength;
      if (bytesRead > maxBytes) {
        controller.error(recordViolation(slot, new ResponseTooLargeError(maxBytes, bytesRead, url)));
        return;
      }
      controller.enqueue(chunk);
    },
  });

  return respondWith(response, response.body.pipeThrough(counter));
}

const CR = 0x0d;
const LF = 0x0a;

/**
 * Enforce the cap on a `text/event-stream` response.
 *
 * SSE used to be exempt, which let any peer opt itself out of the cap by
 * changing one response header. Two bounds replace the bypass:
 *
 *  - **Per event** (`maxBytes`): the octets of a single event frame, counted
 *    from the end of the previous blank-line separator. This is the memory
 *    bound — an SSE consumer buffers one frame at a time, so a single
 *    multi-gigabyte frame is the memory bomb the cap exists to stop.
 *  - **Cumulative per call** (`streamLimit` / `meter`): octets across every
 *    call-scoped SSE response read inside the same `withResponseSizeLimit`
 *    scope, defaulting to `maxBytes * SSE_CUMULATIVE_BUDGET_MULTIPLIER`.
 *    This is the liveness bound — it stops an endless drip of small,
 *    individually legal frames. Connection-scoped `GET` listeners meter
 *    separately; see `streamBudgetFor`.
 *
 * Both failures surface the same typed `ResponseTooLargeError` the one-shot
 * path uses; the stream errors rather than truncating, so the transport sees
 * a failed read instead of a short, plausible-looking response.
 */
function enforceEventStreamLimit(
  response: Response,
  maxBytes: number,
  streamLimit: number,
  meter: StreamMeter,
  url: string,
  slot?: SizeLimitSlot
): Response {
  const remaining = streamLimit - meter.consumed;
  const declared = parseContentLength(response.headers.get('content-length'));
  if (declared !== undefined && declared > remaining) {
    cancelBody(response);
    throw recordViolation(slot, new ResponseTooLargeError(streamLimit, meter.consumed, url, declared));
  }

  if (!response.body) return response;

  // Octets seen since the last event separator (a blank line). SSE line
  // endings are CRLF, LF, or a bare CR, so an event ends at the second
  // consecutive line ending.
  let bytesInEvent = 0;
  let lineEndings = 0;
  let pendingCR = false;

  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      meter.consumed += chunk.byteLength;
      if (meter.consumed > streamLimit) {
        controller.error(recordViolation(slot, new ResponseTooLargeError(streamLimit, meter.consumed, url)));
        return;
      }

      if (chunk.length === 0) {
        // Nothing arrived, so nothing about the framing state changed. The
        // fast path below would wrongly clear a line ending carried over from
        // the previous chunk.
        controller.enqueue(chunk);
        return;
      }

      // Fast path for payload-heavy chunks. `indexOf` stops at the first
      // match, so this is two cheap native probes on newline-dense SSE and a
      // full skip of the per-byte loop on the case that matters — a single
      // enormous frame arriving in newline-free chunks.
      if (chunk.indexOf(LF) === -1 && chunk.indexOf(CR) === -1) {
        bytesInEvent += chunk.length;
        lineEndings = 0;
        pendingCR = false;
        if (bytesInEvent > maxBytes) {
          controller.error(recordViolation(slot, new ResponseTooLargeError(maxBytes, bytesInEvent, url)));
          return;
        }
        controller.enqueue(chunk);
        return;
      }

      for (let i = 0; i < chunk.length; i += 1) {
        const byte = chunk[i];
        bytesInEvent += 1;
        if (byte === CR) {
          lineEndings += 1;
          pendingCR = true;
        } else if (byte === LF) {
          // A LF right after a CR completes that CRLF rather than opening a
          // second line ending.
          if (!pendingCR) lineEndings += 1;
          pendingCR = false;
        } else {
          lineEndings = 0;
          pendingCR = false;
        }

        // Checked before the boundary reset so an event can't slip past the
        // cap by ending on the byte that would have cleared the counter.
        if (bytesInEvent > maxBytes) {
          controller.error(recordViolation(slot, new ResponseTooLargeError(maxBytes, bytesInEvent, url)));
          return;
        }
        if (lineEndings >= 2) {
          // End of event. `pendingCR` survives the reset so a trailing LF of
          // a CRLF separator isn't miscounted as the next event's first line
          // ending.
          lineEndings = 0;
          bytesInEvent = 0;
        }
      }

      controller.enqueue(chunk);
    },
  });

  return respondWith(response, response.body.pipeThrough(counter));
}

/**
 * Best-effort cancel so the runtime can release the socket. We swallow any
 * rejection because the typed `ResponseTooLargeError` the caller throws next
 * is the signal it acts on — a `cancel()` rejection here would only happen if
 * the body stream is already errored / locked, in which case the socket is
 * already on its way down and there's nothing to recover.
 */
function cancelBody(response: Response): void {
  response.body?.cancel().catch(() => {});
}

/**
 * Rebuild a response around a replacement body, preserving the status line.
 *
 * Headers are carried over verbatim, including `Content-Encoding` and
 * `Content-Length`. Those describe the bytes on the wire rather than the
 * decompressed body the runtime hands us — but that is exactly what an
 * unwrapped `fetch()` reports too, so copying them keeps a size-limited
 * response indistinguishable from a plain one for every consumer downstream.
 */
function respondWith(response: Response, body: ReadableStream<Uint8Array>): Response {
  return new Response(body, {
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
