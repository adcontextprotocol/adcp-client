/**
 * Ephemeral webhook receiver for storyboard runs.
 *
 * The runner binds an HTTP listener, mints per-step URLs under
 * `/step/<step_id>/<operation_id>`, and captures inbound POSTs so
 * `expect_webhook*` pseudo-steps can observe outbound webhook behavior
 * (idempotency_key presence, retry-key stability, 9421 signature validity).
 *
 * Matches the `webhook_receiver_runner` test-kit contract in
 * adcontextprotocol/adcp#2431:
 *   - Per-step URL template `{{runner.webhook_base}}/step/<step_id>/<operation_id>`.
 *   - Retry-replay: the receiver returns a configurable 5xx for the first N
 *     deliveries on a given `(step_id, operation_id)`, then 2xx, so senders
 *     are forced to retry and retry-key stability can be graded.
 *   - Loopback-mock mode (HTTP on 127.0.0.1, zero external deps) by default;
 *     proxy-URL mode swaps in an operator-supplied public base.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

/**
 * Size cap on any single webhook body. A non-conformant sender retrying
 * with oversize payloads shouldn't be able to exhaust the runner's memory.
 */
const MAX_BODY_BYTES = 1_048_576; // 1 MiB

/** Default path shape under the receiver base. */
const STEP_PATH_RE = /^\/step\/([A-Za-z0-9_]+)\/([A-Za-z0-9_-]+)\/?$/;

export interface CapturedWebhook {
  /** Runner-assigned id; stable across filter matches. */
  id: string;
  /** Step id extracted from the URL path. */
  step_id: string;
  /** Operation id extracted from the URL path. */
  operation_id: string;
  /** Delivery sequence number for this (step_id, operation_id) — 1-based. */
  delivery_index: number;
  /** Wall-clock millis at receipt. */
  received_at: number;
  method: string;
  /** Path + query. */
  path: string;
  /** Lowercased header names; duplicate values joined with ", ". */
  headers: Record<string, string>;
  /** Raw request body — needed for RFC 9421 content-digest recompute. */
  raw_body: string;
  /** Parsed JSON body; undefined on parse failure. */
  body?: unknown;
  /** Parse error message when raw_body was non-empty but not valid JSON. */
  parse_error?: string;
  /** HTTP status the receiver returned (reflects retry-replay policy). */
  response_status: number;
}

/** Match predicate applied when waiting for a webhook. */
export interface WebhookFilter {
  /** Restrict matches to this step id's URL. */
  step_id?: string;
  /** Restrict matches to this operation id. */
  operation_id?: string;
  /** Dotted-path → expected-value pairs compared against the parsed body. */
  body?: Record<string, unknown>;
}

export type WebhookWaitResult =
  | { webhook: CapturedWebhook; timed_out?: false }
  | { timed_out: true; webhook?: undefined };

export interface RetryReplayPolicy {
  /** How many deliveries to reject before accepting. */
  count: number;
  /** HTTP status to return on rejection. */
  http_status: number;
}

export interface WebhookReceiver {
  /** Public base URL (`http://host:port` for loopback, operator URL for proxy). */
  readonly base_url: string;
  /** Whether the receiver is in loopback-mock or proxy-url mode. */
  readonly mode: 'loopback_mock' | 'proxy_url';
  /** All webhooks captured so far, in arrival order. */
  all(): CapturedWebhook[];
  /** Webhooks matching a filter, in arrival order. */
  matching(filter: WebhookFilter): CapturedWebhook[];
  /**
   * Configure the receiver to return `http_status` for the first `count`
   * deliveries at `(step_id, operation_id)` and 2xx afterwards. Idempotent:
   * setting a new policy replaces any existing one for the same key.
   */
  set_retry_replay(key: { step_id: string; operation_id: string }, policy: RetryReplayPolicy): void;
  /** Resolve with the first match within `timeout_ms`, or `timed_out: true`. */
  wait(filter: WebhookFilter, timeout_ms: number): Promise<WebhookWaitResult>;
  /**
   * Resolve with every match observed between call time and deadline. Used
   * by `expect_webhook_retry_keys_stable` which needs the full sequence of
   * deliveries for the retry-replay assertion.
   */
  wait_all(filter: WebhookFilter, timeout_ms: number): Promise<CapturedWebhook[]>;
  /** Stop the listener. Idempotent. */
  close(): Promise<void>;
}

export interface CreateWebhookReceiverOptions {
  mode?: 'loopback_mock' | 'proxy_url';
  /** Bind host for the local listener. Defaults to `127.0.0.1`. */
  host?: string;
  /** Bind port. `0` (default) lets the kernel assign one. */
  port?: number;
  /** Public URL to advertise when `mode: 'proxy_url'`. */
  public_url?: string;
}

interface RetryKey {
  step_id: string;
  operation_id: string;
}

function retryKeyString(k: RetryKey): string {
  return `${k.step_id}::${k.operation_id}`;
}

export async function createWebhookReceiver(
  options: CreateWebhookReceiverOptions = {}
): Promise<WebhookReceiver> {
  const mode = options.mode ?? 'loopback_mock';
  if (mode === 'proxy_url' && !options.public_url) {
    throw new Error('webhook_receiver.mode=proxy_url requires `public_url`');
  }

  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 0;

  const captured: CapturedWebhook[] = [];
  const waiters: Array<{
    filter: WebhookFilter;
    resolve: (result: WebhookWaitResult) => void;
    timer: NodeJS.Timeout;
  }> = [];
  const retryPolicies = new Map<string, { policy: RetryReplayPolicy; delivered: number }>();
  const deliveryCounts = new Map<string, number>();

  const server = createServer((req, res) =>
    handleRequest(req, res, { captured, waiters, retryPolicies, deliveryCounts })
  );

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolve();
    });
  });

  const bound = server.address() as AddressInfo;
  const base_url =
    mode === 'proxy_url' ? options.public_url!.replace(/\/$/, '') : `http://${formatHost(bound.address)}:${bound.port}`;

  return {
    base_url,
    mode,
    all: () => captured.slice(),
    matching: filter => captured.filter(w => matchesFilter(w, filter)),
    set_retry_replay: (key, policy) => {
      retryPolicies.set(retryKeyString(key), { policy, delivered: 0 });
    },
    wait: (filter, timeout_ms) => wait(filter, timeout_ms, captured, waiters),
    wait_all: (filter, timeout_ms) => waitAll(filter, timeout_ms, captured),
    close: () => closeServer(server, waiters),
  };
}

// ────────────────────────────────────────────────────────────
// Request handling
// ────────────────────────────────────────────────────────────

interface HandlerState {
  captured: CapturedWebhook[];
  waiters: Array<{
    filter: WebhookFilter;
    resolve: (r: WebhookWaitResult) => void;
    timer: NodeJS.Timeout;
  }>;
  retryPolicies: Map<string, { policy: RetryReplayPolicy; delivered: number }>;
  deliveryCounts: Map<string, number>;
}

function handleRequest(req: IncomingMessage, res: ServerResponse, state: HandlerState): void {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.end();
    return;
  }

  const pathParts = parseStepPath(req.url ?? '');
  if (!pathParts) {
    res.statusCode = 404;
    res.end();
    return;
  }
  const { step_id, operation_id } = pathParts;

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
    if (tooLarge) {
      if (!res.headersSent) {
        res.statusCode = 413;
        res.end();
      }
      return;
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    const headers = normalizeHeaders(req.headers);

    const key = retryKeyString({ step_id, operation_id });
    const deliveryIndex = (state.deliveryCounts.get(key) ?? 0) + 1;
    state.deliveryCounts.set(key, deliveryIndex);
    const status = nextResponseStatus(state.retryPolicies, key);

    const webhook: CapturedWebhook = {
      id: randomUUID(),
      step_id,
      operation_id,
      delivery_index: deliveryIndex,
      received_at: Date.now(),
      method: req.method ?? 'POST',
      path: req.url ?? '/',
      headers,
      raw_body: raw,
      ...parseBody(raw, headers['content-type']),
      response_status: status,
    };
    state.captured.push(webhook);

    // Deliver to any matching waiters. First-match-wins per waiter; later
    // arrivals may still deliver to other waiters in the queue.
    for (let i = state.waiters.length - 1; i >= 0; i--) {
      const waiter = state.waiters[i]!;
      if (matchesFilter(webhook, waiter.filter)) {
        clearTimeout(waiter.timer);
        state.waiters.splice(i, 1);
        waiter.resolve({ webhook });
      }
    }

    res.statusCode = status;
    res.end();
  });

  req.on('error', () => {
    if (!res.headersSent) {
      res.statusCode = 400;
      res.end();
    }
  });
}

function parseStepPath(reqUrl: string): { step_id: string; operation_id: string } | undefined {
  const q = reqUrl.indexOf('?');
  const pathname = q === -1 ? reqUrl : reqUrl.slice(0, q);
  const match = STEP_PATH_RE.exec(pathname);
  if (!match) return undefined;
  return { step_id: match[1]!, operation_id: match[2]! };
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

function matchesFilter(webhook: CapturedWebhook, filter: WebhookFilter): boolean {
  if (filter.step_id && webhook.step_id !== filter.step_id) return false;
  if (filter.operation_id && webhook.operation_id !== filter.operation_id) return false;
  if (filter.body && Object.keys(filter.body).length > 0) {
    if (webhook.body === undefined) return false;
    for (const [path, expected] of Object.entries(filter.body)) {
      const actual = resolveDottedPath(webhook.body, path);
      if (!deepEqual(actual, expected)) return false;
    }
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
// Retry-replay policy
// ────────────────────────────────────────────────────────────

function nextResponseStatus(
  retryPolicies: Map<string, { policy: RetryReplayPolicy; delivered: number }>,
  key: string
): number {
  const entry = retryPolicies.get(key);
  if (!entry) return 204;
  if (entry.delivered < entry.policy.count) {
    entry.delivered += 1;
    return entry.policy.http_status;
  }
  return 204;
}

// ────────────────────────────────────────────────────────────
// wait / wait_all
// ────────────────────────────────────────────────────────────

function wait(
  filter: WebhookFilter,
  timeout_ms: number,
  captured: CapturedWebhook[],
  waiters: Array<{ filter: WebhookFilter; resolve: (r: WebhookWaitResult) => void; timer: NodeJS.Timeout }>
): Promise<WebhookWaitResult> {
  const already = captured.find(w => matchesFilter(w, filter));
  if (already) return Promise.resolve({ webhook: already });
  return new Promise<WebhookWaitResult>(resolve => {
    const timer = setTimeout(() => {
      const idx = waiters.findIndex(w => w.timer === timer);
      if (idx >= 0) waiters.splice(idx, 1);
      resolve({ timed_out: true });
    }, Math.max(0, timeout_ms));
    timer.unref?.();
    waiters.push({ filter, resolve, timer });
  });
}

/**
 * Poll until the deadline, then return every capture matching `filter`.
 * Used when the assertion needs the whole delivery sequence (retry-stability).
 * Waits a minimum of `timeout_ms` even if matches arrive earlier — callers
 * that need "resolve on first match" should use `wait` instead.
 */
function waitAll(
  filter: WebhookFilter,
  timeout_ms: number,
  captured: CapturedWebhook[]
): Promise<CapturedWebhook[]> {
  return new Promise<CapturedWebhook[]>(resolve => {
    const timer = setTimeout(() => {
      resolve(captured.filter(w => matchesFilter(w, filter)));
    }, Math.max(0, timeout_ms));
    timer.unref?.();
  });
}

// ────────────────────────────────────────────────────────────
// close
// ────────────────────────────────────────────────────────────

function closeServer(
  server: Server,
  waiters: Array<{ filter: WebhookFilter; resolve: (r: WebhookWaitResult) => void; timer: NodeJS.Timeout }>
): Promise<void> {
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
  return address.includes(':') ? `[${address}]` : address;
}
