/**
 * Per-call context for MCP connections that are shared between calls.
 *
 * A reusable MCP session must be keyed only by what changes the *connection*:
 * endpoint, credential, tenant/routing headers, signing identity and transport
 * policy. Correlation headers (`x-request-id`, `traceparent`, ...), the caller's
 * `AbortSignal` and the per-call timeout describe one *call*. They are carried
 * in an `AsyncLocalStorage` store and applied by the transport fetch on every
 * request, so concurrent calls over one session never see each other's values.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { injectTraceHeaders } from '../observability/tracing';
import { isAbortOrTimeoutError, resolveRequestTimeoutMs, withAbortSignal } from './abort';

export interface MCPCallContext {
  /** Correlation-only headers applied to every request made inside this call. */
  headers?: Record<string, string>;
  /** Cancellation for this call's own POST requests; set by {@link runCallPhase}. */
  callSignal?: AbortSignal;
  /** Per-call request timeout (already resolved; `undefined` means no SDK-imposed cap). */
  requestTimeoutMs?: number;
}

const callContextStorage = new AsyncLocalStorage<MCPCallContext>();

export function runWithMCPCallContext<T>(context: MCPCallContext, fn: () => T): T {
  return callContextStorage.run(context, fn);
}

export function currentMCPCallContext(): MCPCallContext | undefined {
  return callContextStorage.getStore();
}

// Names that only correlate a request with the caller's own tracing/logging.
// Everything else — including unknown `x-*` headers and `baggage`, which can
// carry tenant/account/routing members — can select a tenant, upstream account
// or policy at a gateway, so it stays part of connection identity (fail closed).
const CORRELATION_HEADER_NAMES = new Set([
  'traceparent',
  'tracestate',
  'sentry-trace',
  'b3',
  'x-request-id',
  'x-correlation-id',
  'x-trace-id',
  'x-span-id',
  'x-debug-id',
  'x-client-request-id',
  'x-amzn-trace-id',
  'x-cloud-trace-context',
  'x-ms-client-request-id',
  'x-b3-traceid',
  'x-b3-spanid',
  'x-b3-parentspanid',
  'x-b3-sampled',
  'x-b3-flags',
  'x-datadog-trace-id',
  'x-datadog-parent-id',
  'x-datadog-sampling-priority',
  'x-datadog-tags',
]);

// `x-<vendor>-request-id` / `-correlation-id` / `-trace-id` / `-span-id` / `-debug-id`.
const CORRELATION_HEADER_PATTERN = /^x-(?:[a-z0-9]+-)+(?:request|correlation|trace|span|debug)-id$/;

// A header whose name suggests credentials or tenant/account selection is never
// treated as correlation-only, even if it ends in `-id`.
const IDENTITY_HEADER_HINT =
  /auth|token|key|secret|cookie|session|tenant|account|org|user|principal|cred|signature|advertiser|workspace|seat|brand|buyer|seller|customer|network|publisher|property|route|routing|region|project|team/;

/** Is this header a transient per-request correlation header (excluded from connection identity)? */
export function isCorrelationHeader(name: string): boolean {
  const lower = name.toLowerCase();
  if (IDENTITY_HEADER_HINT.test(lower)) return false;
  return CORRELATION_HEADER_NAMES.has(lower) || CORRELATION_HEADER_PATTERN.test(lower);
}

/** Snapshot ambient routing headers before choosing a connection or discovery key. */
export function withAmbientIdentityHeaders(headers?: Record<string, string>): Record<string, string> {
  const effective = new Headers(headers);
  // An explicit trace family suppresses unrelated ambient baggage as well.
  if (!effective.has('traceparent')) {
    for (const [name, value] of Object.entries(injectTraceHeaders())) {
      if (!isCorrelationHeader(name) && !effective.has(name)) effective.set(name, value);
    }
  }
  const result: Record<string, string> = {};
  effective.forEach((value, name) => {
    result[name] = value;
  });
  return result;
}

/**
 * Split a header bag into the headers that define the connection and the
 * correlation headers that are sent per request.
 */
export function splitConnectionHeaders(headers: Record<string, string> | undefined): {
  identity: Record<string, string>;
  perRequest: Record<string, string>;
} {
  const identity: Record<string, string> = {};
  const perRequest: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    (isCorrelationHeader(key) ? perRequest : identity)[key] = value;
  }
  return { identity, perRequest };
}

/**
 * Apply correlation headers to an outgoing request. Inside a call context the
 * active call's headers apply (and only those, so a shared session never leaks
 * another caller's values). With no active call — a caller who owns the
 * connection directly — the headers configured on that connection apply.
 */
export function applyMCPCallHeaders(headers: Headers, directDefaults?: Record<string, string>): void {
  const context = callContextStorage.getStore();
  const perCall = context ? context.headers : directDefaults;
  if (!perCall) return;
  for (const [key, value] of Object.entries(perCall)) headers.set(key, value);
}

interface ConnectionUse {
  active: number;
  retire?: () => Promise<void>;
}

const connectionUse = new WeakMap<object, ConnectionUse>();

/**
 * Run one call over a shared connection while counting it as a user of that
 * connection, so a failure in one call can retire the session without closing
 * it underneath other in-flight calls.
 */
export async function trackConnectionUse<T>(client: object, fn: () => Promise<T>): Promise<T> {
  let use = connectionUse.get(client);
  if (!use) {
    use = { active: 0 };
    connectionUse.set(client, use);
  }
  use.active++;
  try {
    return await fn();
  } finally {
    use.active--;
    if (use.active === 0 && use.retire) {
      const retire = use.retire;
      use.retire = undefined;
      // The healthy call's result must not wait on a graceful session DELETE.
      void retire().catch(() => {});
    }
  }
}

/**
 * Close a connection that must no longer be used: immediately when idle,
 * otherwise once the last in-flight call has finished.
 */
export async function closeWhenIdle(client: object, close: () => Promise<void>): Promise<void> {
  const use = connectionUse.get(client);
  if (!use || use.active === 0) {
    await close();
    return;
  }
  use.retire = close;
}

/** Bounded retries for joiners whose shared connect was cancelled by its creator. */
export const MAX_FOREIGN_ABORT_RETRIES = 2;

export const RETRY_CONNECT = Symbol('retry-connect');

/**
 * Wait for a connect another caller started, under *this* caller's signal and
 * timeout. The creator's cancellation or deadline belongs to the creator: when
 * the shared connect fails that way, resolve `RETRY_CONNECT` so this caller
 * connects for itself instead of inheriting someone else's abort. This
 * caller's own abort or timeout still rejects.
 */
export async function joinPendingConnection<T>(
  pending: Promise<T>,
  caller: { signal?: AbortSignal; requestTimeoutMs?: number },
  attempt: number
): Promise<T | typeof RETRY_CONNECT> {
  const settled = pending.then(
    value => ({ value }) as const,
    error => ({ error }) as const
  );
  const outcome = await withAbortSignal(
    [caller.signal],
    resolveRequestTimeoutMs(caller.requestTimeoutMs),
    () => settled
  );
  if ('value' in outcome) return outcome.value;
  if (isAbortOrTimeoutError(outcome.error) && attempt < MAX_FOREIGN_ABORT_RETRIES) return RETRY_CONNECT;
  throw outcome.error;
}

/**
 * Give a call over a shared v1 session its own cancellable HTTP scope. Every
 * request the call makes (its POSTs and any `Last-Event-ID` stream resumption)
 * observes one per-call signal, which fires when the caller's own signal does
 * and, regardless of outcome, once the call settles. A call that is aborted, or
 * that the v1 client timed out on while its HTTP request was still open, so
 * leaves nothing running on the shared session, which stays usable by others.
 *
 * No deadline is applied here: the v1 client's per-request timeout resets on
 * progress, so an absolute timer would cut a long-running Tasks stream.
 *
 * Only this call's requests observe the signal (`callRequestSignal`). The
 * transport's long-lived background GET/SSE listener is created at connect
 * time, outside this phase, and keeps its own lifetime.
 */
/** Internal cleanup of a response stream after the SDK has delivered a successful result. */
const MCP_CALL_COMPLETED_MARKER = Symbol.for('@adcp/sdk/mcp-call-completed');
export const MCP_CALL_COMPLETED = Object.assign(new DOMException('MCP call completed', 'AbortError'), {
  [MCP_CALL_COMPLETED_MARKER]: true,
});

/** Recognize the cleanup reason across independently bundled CJS/ESM entry points. */
export function isMCPCallCompleted(reason: unknown): boolean {
  return (
    typeof reason === 'object' &&
    reason !== null &&
    (reason as Record<symbol, unknown>)[MCP_CALL_COMPLETED_MARKER] === true
  );
}

export async function runCallPhase<T>(signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
  const context = callContextStorage.getStore();
  if (!context) return fn();
  const controller = new AbortController();
  const forward = () => controller.abort(signal?.reason);
  if (signal?.aborted) forward();
  else signal?.addEventListener('abort', forward, { once: true });
  let completed = false;
  try {
    const result = await callContextStorage.run({ ...context, callSignal: controller.signal }, fn);
    completed = true;
    return result;
  } finally {
    signal?.removeEventListener('abort', forward);
    controller.abort(completed ? MCP_CALL_COMPLETED : undefined);
  }
}

const JSON_RPC_NOTIFICATION = /^\s*\{[^]{0,120}?"method"\s*:\s*"notifications\//;

function isNotificationBody(body: string): boolean {
  // The cheap prefix check avoids parsing ordinary tool payloads. Confirm the
  // top-level method: a tool argument named `method` is still a cancellable call.
  if (!JSON_RPC_NOTIFICATION.test(body)) return false;
  try {
    const message = JSON.parse(body);
    return (
      message !== null &&
      typeof message === 'object' &&
      !Array.isArray(message) &&
      !Object.prototype.hasOwnProperty.call(message, 'id') &&
      typeof message.method === 'string' &&
      message.method.startsWith('notifications/')
    );
  } catch {
    return false;
  }
}

/**
 * The active call's cancellation signal for its own requests: POSTs, and the
 * `Last-Event-ID` GET that resumes a dropped response stream for that call.
 */
export function callRequestSignal(init: RequestInit | undefined): AbortSignal | undefined {
  const method = (init?.method ?? 'GET').toUpperCase();
  if (method !== 'POST' && !(method === 'GET' && new Headers(init?.headers).has('last-event-id'))) return undefined;
  // A JSON-RPC notification (notably `notifications/cancelled`) tells the seller
  // to stop work for a call that is ending, so it must still be delivered.
  if (method === 'POST' && typeof init?.body === 'string' && isNotificationBody(init.body)) return undefined;
  return callContextStorage.getStore()?.callSignal;
}

/**
 * Deadline for one HTTP request: the active call's timeout, or `fallback` when
 * no call context is active (a direct caller who owns the connection). The
 * transport's background GET/SSE listener is long-lived by design and is never
 * given a per-call deadline.
 */
export function requestTimeoutFor(init: RequestInit | undefined, fallback?: number): number | undefined {
  if ((init?.method ?? 'GET').toUpperCase() === 'GET') return undefined;
  const context = callContextStorage.getStore();
  return context ? context.requestTimeoutMs : fallback;
}

/**
 * `{ signal }` for an outgoing request: the request's own signal combined with
 * the active call's. Applied at the outermost transport wrapper so every layer
 * below (diagnostics, signing, network) observes the call's cancellation and
 * classifies the stream as aborted, rather than seeing only a raw network abort.
 */
export function linkedCallSignal(init: RequestInit | undefined): { signal?: AbortSignal } {
  const callSignal = callRequestSignal(init);
  if (!callSignal) return {};
  return { signal: init?.signal ? AbortSignal.any([init.signal, callSignal]) : callSignal };
}
