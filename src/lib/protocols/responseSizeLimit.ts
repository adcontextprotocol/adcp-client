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
    // Nesting narrows both numbers. `?? resolved` deliberately also covers an
    // enclosing opt-out (`null`): an inner scope that asks for a cap is the
    // more specific instruction, so it still gets one.
    maxResponseBytes: Math.min(resolved, enclosing?.maxResponseBytes ?? resolved),
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
 * Cache-key fragment for the response cap in effect right now.
 *
 * Connection caches must not hand a connection established under one cap to a
 * call that configured another. `wrapFetchWithSizeLimit` decides once, per
 * request, whether to wrap — and a long-lived `GET` listener issues exactly
 * one request, at connect time, then carries that decision for the life of
 * the connection. Without this fragment a single `maxResponseBytes: 0` call
 * would turn a per-call opt-out into a per-session one for every later caller
 * that reuses the connection, and a call with a tight cap would pin the
 * session's listener to a number chosen for one tool response.
 *
 * @internal
 */
export function responseSizeCapCacheKey(): string {
  const slot = responseSizeLimitStorage.getStore();
  const cap = slot ? slot.maxResponseBytes : DEFAULT_MAX_RESPONSE_BYTES;
  return `max-response-bytes:${cap === null ? 'off' : cap}`;
}

/**
 * Run `fn` with a response body byte cap active. Every fetch made through
 * a wrapped transport inside `fn` aborts with `ResponseTooLargeError` when
 * the response body exceeds the cap.
 *
 * Passing `undefined` installs `DEFAULT_MAX_RESPONSE_BYTES` — unless an
 * enclosing scope already set one, in which case the enclosing cap and its
 * cumulative SSE allowance are inherited. More generally, **nesting only ever
 * tightens**: both numbers take the minimum of the enclosing scope's and the
 * new one's, and the cumulative SSE meter is shared rather than refilled.
 *
 * Nested SDK layers re-enter this helper on the way down (`callTool` →
 * `callMCPToolWithTasks`), normally with the same value. Narrow-only means an
 * inner layer that wasn't handed the caller's `transport` can't widen a tight
 * outer cap back to the default, and re-entering with the same number can't
 * multiply the cumulative allowance by the nesting depth. Per-call vs
 * constructor `transport` is resolved with `??` before any scope is entered,
 * so a per-call override still beats the constructor exactly as documented.
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
 * Only a rejection is rewritten. Overriding a *resolution* too would make the
 * cap terminal for anything that merely ran inside the scope, and several
 * SDK paths deliberately treat a failed sub-fetch as "no result, carry on" —
 * `discoverOAuthMetadata` returns `null` after exhausting its candidate URLs,
 * for instance. Failing their caller with `RESPONSE_TOO_LARGE` would point an
 * operator at the wrong knob. The cap bounds memory and reports honestly; it
 * does not retroactively invalidate a result some other request produced.
 *
 * Violations are only recorded for call-scoped responses — a connection-scoped
 * listener that outlives the call does not get to fail an unrelated later
 * call. See `wrapFetchWithSizeLimit`.
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
    // A null-body status carries nothing to bound, and rebuilding it would
    // make the `Response` constructor throw an untyped `TypeError`.
    if (NULL_BODY_STATUSES.has(response.status)) return response;
    // A HEAD reply's `Content-Length` describes the body the server *would*
    // have sent, not bytes on the wire, so the pre-check would reject it as
    // oversized despite nothing arriving. The streaming counter still runs:
    // a peer that answers a HEAD with a body does not get a free pass.
    const skipDeclaredLength = methodOf(input, init) === 'HEAD';
    // `sanitizeTransportUrl` clears userinfo, query and fragment, and
    // returns `'invalid_url'` for anything unparseable. `ResponseTooLargeError`
    // now fires on ordinary calls rather than only for adopters who opted in,
    // so its `url` lands in logs and error envelopes routinely.
    const url = sanitizeTransportUrl(urlOfInput(input));
    if (isEventStream(response)) {
      // A connection-scoped listener outlives the call that opened it, so it
      // neither shares that call's allowance nor gets to fail it: `slot` is
      // withheld so no violation is recorded against an unrelated later call.
      const connectionScoped = methodOf(input, init) === 'GET';
      const { limit, meter } = streamBudgetFor(connectionScoped, slot, maxBytes);
      return enforceEventStreamLimit(
        response,
        maxBytes,
        limit,
        meter,
        url,
        connectionScoped ? undefined : slot,
        skipDeclaredLength
      );
    }
    return enforceSizeLimit(response, maxBytes, url, slot, skipDeclaredLength);
  };
  return wrapped;
}

/**
 * Pick the bounds an event-stream response is held to.
 *
 * Call-scoped streams share the call's allowance — that is what "cumulative
 * per call" means, and it stops a peer from resetting its allowance by
 * splitting a flood across several replies.
 *
 * `GET` event-streams are the exception. MCP's standalone listener and the
 * legacy SSE transport open one `GET` stream that carries server→client
 * traffic for the whole *session*, and the connection cache keeps it alive
 * long after the call that established it returned. Its fetch still runs in
 * that first call's async context, which makes the call's numbers the wrong
 * ones: a shared allowance would kill the listener mid-session once some
 * unrelated call's allowance ran out. So it meters per connection instead.
 *
 * Which cap value it carries is settled by the connection cache rather than
 * here — `responseSizeCapCacheKey` keys cached connections on the cap in
 * effect, so a listener is only ever reused by calls that configured the same
 * policy as the call that opened it.
 *
 * Note this is a memory bound per *stream*, not per call: each reconnect
 * starts a fresh allowance. A peer that keeps tripping it gets an endless
 * reconnect cycle at a bounded cost per cycle — bandwidth, not memory.
 */
function streamBudgetFor(
  connectionScoped: boolean,
  slot: SizeLimitSlot | undefined,
  maxBytes: number
): { limit: number; meter: StreamMeter } {
  if (connectionScoped) return { limit: sseBudgetFor(maxBytes), meter: { consumed: 0 } };
  return {
    limit: slot?.streamLimit ?? sseBudgetFor(maxBytes),
    meter: slot?.streamMeter ?? { consumed: 0 },
  };
}

/** Effective request method, honoring a `Request` input's own method. */
function methodOf(input: RequestInfo | URL, init: RequestInit | undefined): string {
  const method = init?.method ?? (typeof Request !== 'undefined' && input instanceof Request ? input.method : 'GET');
  return method.toUpperCase();
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

function enforceSizeLimit(
  response: Response,
  maxBytes: number,
  url: string,
  slot?: SizeLimitSlot,
  skipDeclaredLength = false
): Response {
  // Cheap pre-check: if the server declares a Content-Length over the cap,
  // tear the connection down before reading any of the body. Servers can
  // omit or lie about Content-Length, which is why the streaming counter
  // below is the authoritative enforcement.
  const declared = skipDeclaredLength ? undefined : parseContentLength(response.headers.get('content-length'));
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
  slot?: SizeLimitSlot,
  skipDeclaredLength = false
): Response {
  const remaining = streamLimit - meter.consumed;
  const declared = skipDeclaredLength ? undefined : parseContentLength(response.headers.get('content-length'));
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
  // An event's separator can end on a CR whose LF hasn't arrived yet, so the
  // counter can't reset the moment the blank line completes. `pendingReset`
  // defers the reset by one byte; `separatorTail` says that byte is the LF
  // that finishes a CRLF and therefore belongs to the event that just ended.
  //
  // Resetting eagerly instead gets the boundary wrong in both directions: the
  // trailing LF lands on the next event, docking a byte from its allowance
  // (two consecutive CRLF events of exactly `maxBytes` would see the first
  // pass and the second rejected) while the event that owns it is undercounted
  // by one, letting a `maxBytes + 1` frame through.
  let separatorTail = false;
  let pendingReset = false;

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
        // No line ending in this chunk, so a deferred reset can be settled
        // here: its separator is over and nothing in this chunk belonged to it.
        if (pendingReset) {
          pendingReset = false;
          separatorTail = false;
          bytesInEvent = 0;
        }
        // `bytesInEvent` can overshoot the cap by up to one chunk here before
        // the check fires, so `bytesRead` on the error is approximate. The
        // bound is still `maxBytes + chunkLength`, and chunk size is the
        // runtime's read buffer, not something the peer picks.
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

        if (pendingReset) {
          pendingReset = false;
          if (separatorTail && byte === LF) {
            // The LF that finishes the separator's closing CRLF. It belongs to
            // the event that just ended, so charge it there, then reset.
            separatorTail = false;
            pendingCR = false;
            bytesInEvent += 1;
            if (bytesInEvent > maxBytes) {
              controller.error(recordViolation(slot, new ResponseTooLargeError(maxBytes, bytesInEvent, url)));
              return;
            }
            bytesInEvent = 0;
            continue;
          }
          separatorTail = false;
          bytesInEvent = 0;
        }

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
          // End of event — but defer the reset: if the separator ended on a
          // CR, the next byte may be the LF that completes it and that octet
          // is still this event's.
          lineEndings = 0;
          pendingReset = true;
          separatorTail = pendingCR;
          pendingCR = false;
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
