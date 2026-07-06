/**
 * Server-Sent Events transport for the registry change feed
 * (`GET /api/registry/feed/stream`, adcp#5733).
 *
 * Generated OpenAPI types alone are not enough because the response is
 * `text/event-stream`. This module provides a fetch-based SSE reader (so it can
 * carry the `Authorization` bearer and run under Node) plus the typed message
 * and error shapes the stream emits.
 *
 * The stream carries the resume cursor in the JSON `data.cursor` payload, not in
 * SSE `id:` / `Last-Event-ID` (the registry does not use native EventSource
 * resume in 3.x). Consumers persist `data.cursor` and reconnect with `?cursor=`.
 */

import type { FeedResponse } from './types';
import type { FeedFreshness } from './types.generated';

/** Query parameters for `GET /api/registry/feed/stream`. */
export interface FeedStreamQuery {
  /** Resume after this event id. Omit to start at the beginning of retention. */
  cursor?: string;
  /** Comma-separated event type filters with glob support (e.g. `authorization.*`). */
  types?: string;
  /** Max events per SSE feed page (default 100, max 10,000). */
  limit?: number;
  /** Server-side interval while caught up (5–60s, default 15). Backlog pages are sent without waiting. */
  pollIntervalSeconds?: number;
}

/** `heartbeat` event payload. Emitted while caught up; does not advance the cursor. */
export interface FeedHeartbeat {
  generated_at: string;
  cursor: string | null;
  freshness?: FeedFreshness;
}

/** `error` event payload. Sent once before the server closes the stream. */
export interface FeedStreamErrorData {
  /** e.g. `cursor_expired`, `feed_stream_error`. */
  error: string;
  message?: string;
}

/**
 * A typed message decoded from the SSE stream.
 *
 * @remarks
 * Registry-supplied strings (event payloads, `freshness`, `error.message`) are
 * untrusted input. Sanitize before logging them or injecting them into LLM
 * prompts/instructions or other executable context.
 */
export type FeedStreamMessage =
  | { type: 'feed'; page: FeedResponse }
  | { type: 'heartbeat'; heartbeat: FeedHeartbeat }
  | { type: 'error'; error: FeedStreamErrorData };

// ====== Errors ======

/** Base class for feed-stream transport failures. */
export class FeedStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeedStreamError';
  }
}

/**
 * The stream endpoint is unavailable (404/406/501) or did not return an event
 * stream (proxy returned HTML/JSON). Callers in `auto` mode fall back to polling.
 */
export class FeedStreamUnsupportedError extends FeedStreamError {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'FeedStreamUnsupportedError';
    this.status = status;
  }
}

/** The initial cursor is expired (HTTP 410). Callers re-bootstrap then resume. */
export class FeedStreamCursorExpiredError extends FeedStreamError {
  constructor(message: string) {
    super(message);
    this.name = 'FeedStreamCursorExpiredError';
  }
}

/** A non-success HTTP status that is neither unsupported nor cursor-expired (e.g. 429, 500). */
export class FeedStreamHttpError extends FeedStreamError {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'FeedStreamHttpError';
    this.status = status;
  }
}

/** A feed/heartbeat/error frame carried data that was not valid JSON or had the wrong shape. */
export class FeedStreamParseError extends FeedStreamError {
  constructor(message: string) {
    super(message);
    this.name = 'FeedStreamParseError';
  }
}

// ====== SSE line parser ======

interface SseEvent {
  event: string;
  data: string;
}

/** Mutable accumulation state for the SSE field parser. */
interface ParseState {
  dataLines: string[];
  dataBytes: number;
  eventType: string;
}

/**
 * Apply one SSE line to the accumulation state. Returns an event to yield when a
 * blank line dispatches a buffered event with data, else null. Follows the
 * WHATWG rules: `:`-prefixed comments ignored, one leading space stripped from
 * each value, `id`/`retry` ignored (the registry uses `data.cursor`, not
 * Last-Event-ID).
 *
 * Throws {@link FeedStreamParseError} as soon as accumulated `data` exceeds
 * `maxFrameBytes` — before the dispatching blank line — so an oversized frame is
 * never yielded (or JSON-parsed downstream), even when the whole frame, blank
 * line included, arrives in a single chunk.
 */
function feedLine(line: string, st: ParseState, maxFrameBytes: number): SseEvent | null {
  if (line === '') {
    const ev = st.dataLines.length > 0 ? { event: st.eventType || 'message', data: st.dataLines.join('\n') } : null;
    st.dataLines = [];
    st.dataBytes = 0;
    st.eventType = '';
    return ev;
  }
  if (line[0] === ':') return null; // comment
  const colon = line.indexOf(':');
  const field = colon === -1 ? line : line.slice(0, colon);
  let value = colon === -1 ? '' : line.slice(colon + 1);
  if (value[0] === ' ') value = value.slice(1);
  if (field === 'event') st.eventType = value;
  else if (field === 'data') {
    st.dataLines.push(value);
    st.dataBytes += value.length;
    if (st.dataBytes > maxFrameBytes) {
      throw new FeedStreamParseError(`registry feed stream event exceeded ${maxFrameBytes} bytes without dispatching`);
    }
  }
  return null;
}

function asAsyncIterable(source: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
  if (Symbol.asyncIterator in (source as object)) {
    return source as AsyncIterable<Uint8Array>;
  }
  const reader = (source as ReadableStream<Uint8Array>).getReader();
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          const { done, value } = await reader.read();
          return done ? { done: true, value: undefined } : { done: false, value: value! };
        },
        async return() {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
          return { done: true, value: undefined };
        },
      };
    },
  };
}

/**
 * Default cap on a single un-dispatched SSE event before the parser fails
 * closed. Measured in UTF-16 code units (an approximate byte bound — JS string
 * length, which tracks heap cost). Generous enough for a full feed page (the
 * JSON feed endpoint caps responses at ~2 MiB) while bounding memory against a
 * hostile or buggy stream that never emits a blank line.
 */
export const DEFAULT_MAX_SSE_FRAME_BYTES = 16 * 1024 * 1024;

/**
 * Parse an SSE byte stream into events. Follows the WHATWG event-stream rules:
 * comments (`:`-prefixed) are ignored, `data` lines accumulate (joined by `\n`),
 * a blank line dispatches the buffered event, and a final block with no trailing
 * blank line is dropped as incomplete (so a partially-transferred page is never
 * surfaced).
 *
 * The in-progress line plus accumulated `data` lines for a single event are
 * bounded by `maxFrameBytes`; a stream that exceeds it (no line terminator, or
 * an unbounded run of `data:` lines before a blank line) throws
 * {@link FeedStreamParseError} rather than growing memory without limit — the
 * JSON feed path enforces the same fail-closed posture via its body-size cap.
 *
 * Parsing is O(n) regardless of how the bytes are chunked: each decoded chunk is
 * scanned once, and an un-terminated line is held as a list of fragments joined
 * only when it completes — never re-scanning or re-flattening a growing buffer.
 */
export async function* parseSseStream(
  source: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>,
  options?: { maxFrameBytes?: number }
): AsyncGenerator<SseEvent> {
  const maxFrameBytes = options?.maxFrameBytes ?? DEFAULT_MAX_SSE_FRAME_BYTES;
  const decoder = new TextDecoder();
  const st: ParseState = { dataLines: [], dataBytes: 0, eventType: '' };
  // Fragments of the current un-terminated line, spanning chunks; joined once
  // when the line completes.
  let lineFragments: string[] = [];
  let lineFragmentsLen = 0;
  // A `\r` ended the previous chunk; a leading `\n` here is the LF of that CRLF
  // and must be skipped (the line already terminated at the `\r`).
  let skipLeadingLF = false;

  for await (const chunk of asAsyncIterable(source)) {
    const c = decoder.decode(chunk, { stream: true });
    if (c.length === 0) continue;
    let pos = 0;
    if (skipLeadingLF) {
      if (c[0] === '\n') pos = 1;
      skipLeadingLF = false;
    }
    while (pos < c.length) {
      // Scan only this (small) chunk for the next terminator — never the
      // accumulated frame — so indexing stays on a flat, short string.
      let j = pos;
      while (j < c.length && c[j] !== '\n' && c[j] !== '\r') j += 1;
      if (j === c.length) break; // no terminator in the rest of this chunk
      lineFragments.push(c.slice(pos, j));
      const line = lineFragments.length === 1 ? lineFragments[0]! : lineFragments.join('');
      lineFragments = [];
      lineFragmentsLen = 0;
      const ev = feedLine(line, st, maxFrameBytes);
      if (ev) yield ev;
      if (c[j] === '\r') {
        if (j === c.length - 1) {
          skipLeadingLF = true; // defer the CRLF check to the next chunk
          pos = c.length;
        } else {
          pos = c[j + 1] === '\n' ? j + 2 : j + 1;
        }
      } else {
        pos = j + 1;
      }
    }
    if (pos < c.length) {
      const tail = c.slice(pos);
      lineFragments.push(tail);
      lineFragmentsLen += tail.length;
    }
    // Fail closed if a single un-dispatched event grows past the cap, whether
    // from an unterminated line or an unbounded run of data lines.
    if (lineFragmentsLen + st.dataBytes > maxFrameBytes) {
      throw new FeedStreamParseError(`registry feed stream event exceeded ${maxFrameBytes} bytes without dispatching`);
    }
  }
}

// ====== Frame → typed message ======

function parseJsonFrame(event: string, data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    throw new FeedStreamParseError(`registry feed stream sent malformed JSON on '${event}' event`);
  }
}

function toFeedStreamMessage(evt: SseEvent): FeedStreamMessage | null {
  switch (evt.event) {
    case 'feed': {
      const page = parseJsonFrame('feed', evt.data);
      if (!page || typeof page !== 'object' || !Array.isArray((page as FeedResponse).events)) {
        throw new FeedStreamParseError("registry feed stream 'feed' event was not a feed page");
      }
      return { type: 'feed', page: page as FeedResponse };
    }
    case 'heartbeat': {
      const heartbeat = parseJsonFrame('heartbeat', evt.data);
      if (!heartbeat || typeof heartbeat !== 'object') {
        throw new FeedStreamParseError("registry feed stream 'heartbeat' event was not an object");
      }
      return { type: 'heartbeat', heartbeat: heartbeat as FeedHeartbeat };
    }
    case 'error': {
      const error = parseJsonFrame('error', evt.data);
      if (!error || typeof error !== 'object' || typeof (error as FeedStreamErrorData).error !== 'string') {
        throw new FeedStreamParseError("registry feed stream 'error' event had no error code");
      }
      return { type: 'error', error: error as FeedStreamErrorData };
    }
    default:
      // Unknown / `message` events (e.g. comments-as-keepalive frames) are ignored.
      return null;
  }
}

// ====== Connection ======

const ERROR_BODY_LIMIT_BYTES = 64 * 1024;
const ERROR_MESSAGE_MAX_CHARS = 256;

/**
 * Escape control characters and bound the length of a registry-supplied string
 * before it is embedded in an Error message or logged. Registry/proxy text is
 * untrusted input — left raw it is a log-injection / terminal-spoofing vector
 * (and the repo treats registry strings as untrusted everywhere else). Mirrors
 * the JSON client's `preview()`.
 */
export function sanitizeStreamText(text: string, maxChars = ERROR_MESSAGE_MAX_CHARS): string {
  // Match C0 controls (\u0000-\u001f) and DEL (\u007f); built from a string so
  // the source never carries raw control bytes.
  const CONTROL = new RegExp('[\\u0000-\\u001f\\u007f]', 'g');
  return text.slice(0, maxChars).replace(CONTROL, ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function buildStreamUrl(baseUrl: string, query?: FeedStreamQuery): string {
  const params = new URLSearchParams();
  if (query?.cursor) params.set('cursor', query.cursor);
  if (query?.types) params.set('types', query.types);
  if (query?.limit != null) params.set('limit', String(query.limit));
  if (query?.pollIntervalSeconds != null) params.set('poll_interval_seconds', String(query.pollIntervalSeconds));
  const qs = params.toString();
  return `${baseUrl}/api/registry/feed/stream${qs ? `?${qs}` : ''}`;
}

/** Read at most `maxBytes` of a response body, then cancel — never buffers a hostile multi-GB error body. */
async function readBoundedText(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) {
    // No stream (e.g. a mocked Response): fall back, but still bound the result.
    const text = await res.text().catch(() => '');
    return text.slice(0, maxBytes);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.byteLength;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return new TextDecoder().decode(concatChunks(chunks)).slice(0, maxBytes);
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

async function readErrorMessage(res: Response): Promise<string | undefined> {
  try {
    const trimmed = await readBoundedText(res, ERROR_BODY_LIMIT_BYTES);
    try {
      const body = JSON.parse(trimmed) as { message?: unknown; error?: unknown };
      if (typeof body.message === 'string') return sanitizeStreamText(body.message);
      if (typeof body.error === 'string') return sanitizeStreamText(body.error);
    } catch {
      /* not JSON */
    }
    const tail = trimmed.trim();
    return tail ? sanitizeStreamText(tail) : undefined;
  } catch {
    return undefined;
  }
}

export interface OpenFeedStreamOptions {
  fetchImpl: typeof globalThis.fetch;
  baseUrl: string;
  apiKey: string;
  query?: FeedStreamQuery;
  /**
   * Redirect policy for the stream fetch. Defaults to `'error'`, which prevents
   * the `Authorization` bearer from being replayed to a redirect target. Set
   * `'follow'` only with a fully trusted `baseUrl` — fetch may forward the bearer
   * to the redirect location.
   */
  redirect?: 'follow' | 'error';
  /** Cap on bytes buffered for a single un-dispatched SSE event. See {@link DEFAULT_MAX_SSE_FRAME_BYTES}. */
  maxFrameBytes?: number;
  signal?: AbortSignal;
}

/**
 * Open the SSE feed stream and yield typed messages until the stream closes.
 *
 * Throws {@link FeedStreamCursorExpiredError} (410), {@link FeedStreamUnsupportedError}
 * (404/406/501 or non-stream content-type), {@link FeedStreamHttpError} (other
 * non-2xx), or {@link FeedStreamParseError} (malformed frame). Network/abort
 * errors propagate from the underlying fetch.
 */
export async function* openFeedStream(opts: OpenFeedStreamOptions): AsyncGenerator<FeedStreamMessage> {
  const url = buildStreamUrl(opts.baseUrl, opts.query);
  const res = await opts.fetchImpl(url, {
    method: 'GET',
    headers: { Accept: 'text/event-stream', Authorization: `Bearer ${opts.apiKey}` },
    redirect: opts.redirect ?? 'error',
    signal: opts.signal,
  });

  if (!res.ok) {
    const message = await readErrorMessage(res);
    if (res.status === 410) {
      throw new FeedStreamCursorExpiredError(message ?? 'registry feed cursor expired');
    }
    if (res.status === 404 || res.status === 406 || res.status === 501) {
      throw new FeedStreamUnsupportedError(
        `registry feed stream unsupported (HTTP ${res.status})${message ? `: ${message}` : ''}`,
        res.status
      );
    }
    throw new FeedStreamHttpError(
      `registry feed stream request failed (HTTP ${res.status})${message ? `: ${message}` : ''}`,
      res.status
    );
  }

  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('text/event-stream')) {
    await res.body?.cancel?.().catch(() => {});
    throw new FeedStreamUnsupportedError(
      `registry feed stream returned non-stream content-type: ${contentType || 'none'}`
    );
  }
  if (!res.body) {
    throw new FeedStreamUnsupportedError('registry feed stream response had no body');
  }

  for await (const evt of parseSseStream(res.body, { maxFrameBytes: opts.maxFrameBytes })) {
    const msg = toFeedStreamMessage(evt);
    if (msg) yield msg;
  }
}
