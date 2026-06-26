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

import type { FeedResponse, FeedFreshness } from './types.generated';

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

/** A typed message decoded from the SSE stream. */
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

/**
 * Split a buffer into complete lines, deferring a trailing lone `\r` (which may
 * be the first half of a `\r\n` split across chunks). Handles `\n`, `\r\n`, `\r`.
 */
function extractLines(buffer: string): { lines: string[]; rest: string } {
  const lines: string[] = [];
  let start = 0;
  let i = 0;
  while (i < buffer.length) {
    const ch = buffer[i];
    if (ch === '\n') {
      lines.push(buffer.slice(start, i));
      i += 1;
      start = i;
    } else if (ch === '\r') {
      if (i === buffer.length - 1) break; // defer: could be split \r\n
      lines.push(buffer.slice(start, i));
      i += buffer[i + 1] === '\n' ? 2 : 1;
      start = i;
    } else {
      i += 1;
    }
  }
  return { lines, rest: buffer.slice(start) };
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
 * Default cap on the bytes a single un-dispatched SSE event may buffer before
 * the parser fails closed. Generous enough for a full feed page (the JSON feed
 * endpoint caps responses at ~2 MiB) while bounding memory against a hostile or
 * buggy stream that never emits a blank line.
 */
export const DEFAULT_MAX_SSE_FRAME_BYTES = 16 * 1024 * 1024;

/**
 * Parse an SSE byte stream into events. Follows the WHATWG event-stream rules:
 * comments (`:`-prefixed) are ignored, `data` lines accumulate (joined by `\n`),
 * a blank line dispatches the buffered event, and a final block with no trailing
 * blank line is dropped as incomplete (so a partially-transferred page is never
 * surfaced).
 *
 * The unparsed buffer plus accumulated `data` lines for a single event are
 * bounded by `maxFrameBytes`; a stream that exceeds it (no line terminator, or
 * an unbounded run of `data:` lines before a blank line) throws
 * {@link FeedStreamParseError} rather than growing memory without limit — the
 * JSON feed path enforces the same fail-closed posture via its body-size cap.
 */
export async function* parseSseStream(
  source: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>,
  options?: { maxFrameBytes?: number }
): AsyncGenerator<SseEvent> {
  const maxFrameBytes = options?.maxFrameBytes ?? DEFAULT_MAX_SSE_FRAME_BYTES;
  const decoder = new TextDecoder();
  let buffer = '';
  let dataLines: string[] = [];
  let dataBytes = 0;
  let eventType = '';

  for await (const chunk of asAsyncIterable(source)) {
    buffer += decoder.decode(chunk, { stream: true });
    const { lines, rest } = extractLines(buffer);
    buffer = rest;
    for (const line of lines) {
      if (line === '') {
        if (dataLines.length > 0) {
          yield { event: eventType || 'message', data: dataLines.join('\n') };
        }
        dataLines = [];
        dataBytes = 0;
        eventType = '';
        continue;
      }
      if (line[0] === ':') continue; // comment
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value[0] === ' ') value = value.slice(1);
      if (field === 'event') eventType = value;
      else if (field === 'data') {
        dataLines.push(value);
        dataBytes += value.length;
      }
      // `id` and `retry` are intentionally ignored — the registry does not use
      // Last-Event-ID resume; the cursor lives in the JSON payload.
    }
    // Fail closed if a single un-dispatched event grows past the cap, whether
    // from an unterminated buffer or an unbounded run of data lines.
    if (buffer.length + dataBytes > maxFrameBytes) {
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

function buildStreamUrl(baseUrl: string, query?: FeedStreamQuery): string {
  const params = new URLSearchParams();
  if (query?.cursor) params.set('cursor', query.cursor);
  if (query?.types) params.set('types', query.types);
  if (query?.limit != null) params.set('limit', String(query.limit));
  if (query?.pollIntervalSeconds != null) params.set('poll_interval_seconds', String(query.pollIntervalSeconds));
  const qs = params.toString();
  return `${baseUrl}/api/registry/feed/stream${qs ? `?${qs}` : ''}`;
}

async function readErrorMessage(res: Response): Promise<string | undefined> {
  try {
    const text = await res.text();
    const trimmed = text.slice(0, ERROR_BODY_LIMIT_BYTES);
    try {
      const body = JSON.parse(trimmed) as { message?: unknown; error?: unknown };
      if (typeof body.message === 'string') return body.message;
      if (typeof body.error === 'string') return body.error;
    } catch {
      /* not JSON */
    }
    return trimmed.trim() || undefined;
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
