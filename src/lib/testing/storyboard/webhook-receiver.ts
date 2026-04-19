/**
 * Ephemeral webhook receiver for storyboard runs.
 *
 * The runner binds an in-process HTTP listener, exposes its URL as
 * `$context.webhook_receiver_url`, and captures every POST so step-level
 * `expect_webhook` validations can assert on the publisher's outbound
 * webhook behavior (idempotency_key presence, retry key stability, signing).
 *
 * Scope: local HTTP only. For SUTs that require a publicly reachable
 * endpoint, callers pass a tunneled URL via `public_url` and bind the
 * listener on a port their tunnel terminates onto.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

/**
 * Size cap on any single webhook body. Agents that retry with oversize
 * payloads shouldn't be able to exhaust the runner's memory.
 */
const MAX_BODY_BYTES = 1_048_576; // 1 MiB

export interface CapturedWebhook {
  /** Runner-assigned id; stable across matching so consumers can correlate. */
  id: string;
  /** Wall-clock millis at receipt. */
  received_at: number;
  method: string;
  /** Path + query (e.g. "/webhook?x=1"). */
  path: string;
  /** Lowercased header names. */
  headers: Record<string, string>;
  /** Raw request body. Kept verbatim for signature verification in later slices. */
  raw_body: string;
  /** Parsed JSON body; undefined when parse failed or content-type wasn't JSON-like. */
  body?: unknown;
  /** Parse error message when raw_body was non-empty but not valid JSON. */
  parse_error?: string;
}

/**
 * Filter applied to a captured webhook when waiting. Each key/value pair in
 * `body` must equal the value at the same path in the captured payload for
 * the webhook to match. Absent / empty filter matches any webhook.
 */
export interface WebhookFilter {
  /**
   * Flat dotted-path → expected value map (matches `resolvePath` syntax used
   * elsewhere in the runner). Example: `{ 'task.task_id': 'media-buy-123' }`.
   */
  body?: Record<string, unknown>;
}

export interface WebhookReceiver {
  /** Public URL storyboards inject into push_notification_config. */
  readonly url: string;
  /** All webhooks captured since the receiver started, in arrival order. */
  all(): CapturedWebhook[];
  /**
   * Resolve with the first webhook matching `filter`, waiting up to
   * `timeout_ms`. Matches already-captured webhooks first, then waits for
   * arrivals. Returns `{ webhook }` on success, `{ timed_out: true }` when
   * the deadline expires with no match.
   */
  wait(filter: WebhookFilter | undefined, timeout_ms: number): Promise<WebhookWaitResult>;
  /** Stop the HTTP listener. Idempotent. */
  close(): Promise<void>;
}

export type WebhookWaitResult =
  | { webhook: CapturedWebhook; timed_out?: false }
  | { timed_out: true; webhook?: undefined };

export interface CreateWebhookReceiverOptions {
  /** Bind host. Defaults to `127.0.0.1` — loopback-only. */
  host?: string;
  /** Bind port. `0` (default) lets the kernel assign one. */
  port?: number;
  /**
   * Path under which POSTs are accepted. Defaults to `/webhook`. Other
   * paths return 404 so the receiver doesn't silently swallow probes.
   */
  path?: string;
  /**
   * Optional URL to advertise to storyboards instead of the bound
   * `http://host:port` pair. Use when the listener is behind a tunnel
   * (ngrok, cloudflared) whose public URL the caller already knows.
   */
  public_url?: string;
}

export async function createWebhookReceiver(
  options: CreateWebhookReceiverOptions = {}
): Promise<WebhookReceiver> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 0;
  const path = options.path ?? '/webhook';

  const captured: CapturedWebhook[] = [];
  const waiters: Array<{
    filter: WebhookFilter | undefined;
    resolve: (result: WebhookWaitResult) => void;
    timer: NodeJS.Timeout;
  }> = [];

  const server = createServer((req, res) => handleRequest(req, res, path, captured, waiters));

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolve();
    });
  });

  const bound = server.address() as AddressInfo;
  const url = options.public_url ?? `http://${formatHost(bound.address)}:${bound.port}${path}`;

  return {
    url,
    all: () => captured.slice(),
    wait: (filter, timeout_ms) => wait(filter, timeout_ms, captured, waiters),
    close: () => closeServer(server, waiters),
  };
}

// ────────────────────────────────────────────────────────────
// Request handling
// ────────────────────────────────────────────────────────────

function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  expectedPath: string,
  captured: CapturedWebhook[],
  waiters: Array<{ filter: WebhookFilter | undefined; resolve: (r: WebhookWaitResult) => void; timer: NodeJS.Timeout }>
): void {
  if (req.method !== 'POST' || !matchesPath(req.url ?? '', expectedPath)) {
    res.statusCode = 404;
    res.end();
    return;
  }

  let size = 0;
  const chunks: Buffer[] = [];
  let tooLarge = false;

  req.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      tooLarge = true;
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });

  req.on('end', () => {
    if (tooLarge) return;
    const raw = Buffer.concat(chunks).toString('utf8');
    const headers = normalizeHeaders(req.headers);
    const webhook: CapturedWebhook = {
      id: randomUUID(),
      received_at: Date.now(),
      method: req.method ?? 'POST',
      path: req.url ?? '/',
      headers,
      raw_body: raw,
      ...parseBody(raw, headers['content-type']),
    };
    captured.push(webhook);

    // Deliver to any waiter whose filter now matches. Matched waiters fire
    // once and are removed so a later arrival doesn't re-trigger them.
    for (let i = waiters.length - 1; i >= 0; i--) {
      const waiter = waiters[i]!;
      if (matchesFilter(webhook, waiter.filter)) {
        clearTimeout(waiter.timer);
        waiters.splice(i, 1);
        waiter.resolve({ webhook });
      }
    }

    res.statusCode = 204;
    res.end();
  });

  req.on('error', () => {
    if (!res.headersSent) {
      res.statusCode = 400;
      res.end();
    }
  });
}

function matchesPath(reqUrl: string, expectedPath: string): boolean {
  const q = reqUrl.indexOf('?');
  const pathname = q === -1 ? reqUrl : reqUrl.slice(0, q);
  return pathname === expectedPath;
}

function normalizeHeaders(raw: IncomingMessage['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

function parseBody(raw: string, contentType: string | undefined): Pick<CapturedWebhook, 'body' | 'parse_error'> {
  if (raw.length === 0) return {};
  const looksJson = !contentType || /json/i.test(contentType);
  if (!looksJson) return {};
  try {
    return { body: JSON.parse(raw) };
  } catch (err) {
    return { parse_error: err instanceof Error ? err.message : String(err) };
  }
}

// ────────────────────────────────────────────────────────────
// Filter matching
// ────────────────────────────────────────────────────────────

function matchesFilter(webhook: CapturedWebhook, filter: WebhookFilter | undefined): boolean {
  if (!filter || !filter.body || Object.keys(filter.body).length === 0) return true;
  if (webhook.body === undefined) return false;
  for (const [path, expected] of Object.entries(filter.body)) {
    const actual = resolveDottedPath(webhook.body, path);
    if (!deepEqual(actual, expected)) return false;
  }
  return true;
}

function resolveDottedPath(obj: unknown, path: string): unknown {
  if (obj === null || obj === undefined) return undefined;
  const segments = path.split('.');
  let cursor: unknown = obj;
  for (const seg of segments) {
    if (cursor === null || cursor === undefined) return undefined;
    if (typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[seg];
  }
  return cursor;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== 'object') return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

// ────────────────────────────────────────────────────────────
// wait()
// ────────────────────────────────────────────────────────────

function wait(
  filter: WebhookFilter | undefined,
  timeout_ms: number,
  captured: CapturedWebhook[],
  waiters: Array<{ filter: WebhookFilter | undefined; resolve: (r: WebhookWaitResult) => void; timer: NodeJS.Timeout }>
): Promise<WebhookWaitResult> {
  const already = captured.find(w => matchesFilter(w, filter));
  if (already) return Promise.resolve({ webhook: already });

  return new Promise<WebhookWaitResult>(resolve => {
    const timer = setTimeout(() => {
      const idx = waiters.findIndex(w => w.timer === timer);
      if (idx >= 0) waiters.splice(idx, 1);
      resolve({ timed_out: true });
    }, Math.max(0, timeout_ms));
    // Don't keep the event loop alive purely for this timer — the receiver's
    // close() clears it anyway, and leaving it unref'd lets tests exit when
    // the run finishes without dangling handles.
    timer.unref?.();
    waiters.push({ filter, resolve, timer });
  });
}

// ────────────────────────────────────────────────────────────
// close()
// ────────────────────────────────────────────────────────────

function closeServer(
  server: Server,
  waiters: Array<{ filter: WebhookFilter | undefined; resolve: (r: WebhookWaitResult) => void; timer: NodeJS.Timeout }>
): Promise<void> {
  // Wake any pending waiters with a timeout so the run doesn't hang if the
  // user closed the receiver mid-wait.
  while (waiters.length > 0) {
    const w = waiters.pop()!;
    clearTimeout(w.timer);
    w.resolve({ timed_out: true });
  }
  return new Promise<void>((resolve, reject) => {
    server.close(err => {
      if (err && (err as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(err);
      else resolve();
    });
  });
}

function formatHost(address: string): string {
  // IPv6 addresses must appear bracketed in URLs.
  return address.includes(':') ? `[${address}]` : address;
}
