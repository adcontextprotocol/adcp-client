import { globalAsyncLocalStorage } from '../utils/global-async-local-storage';
import { createHmac, randomUUID } from 'node:crypto';

export type TransportActivityType = 'request_started' | 'response_received' | 'request_failed';

export interface TransportActivityContext {
  agentId: string;
  protocol: 'mcp' | 'a2a';
  tool?: string;
  taskType?: string;
  operationId?: string;
  taskId?: string;
  contextId?: string;
  idempotencyKey?: string;
}

export interface TransportActivity {
  type: TransportActivityType;
  /** Correlates one request_started event with its response/failure event. */
  transportRequestId: string;
  agentId: string;
  protocol: 'mcp' | 'a2a';
  tool?: string;
  taskType?: string;
  operationId?: string;
  taskId?: string;
  contextId?: string;
  idempotencyKeyHash?: string;
  method: string;
  url: string;
  requestHeaders: Record<string, string>;
  requestBody?: string;
  requestBodyTruncated?: boolean;
  startedAt: string;
  timestamp: string;
  durationMs?: number;
  httpStatus?: number;
  statusText?: string;
  responseHeaders?: Record<string, string>;
  responseBody?: string;
  responseBodyTruncated?: boolean;
  errorName?: string;
  errorMessage?: string;
}

export type TransportActivityHandler = (event: TransportActivity) => void | Promise<void>;

interface TransportDiagnosticsSlot extends TransportActivityContext {
  onTransportActivity?: TransportActivityHandler;
  pending: Promise<void>[];
}

const BODY_SNIPPET_LIMIT = 64 * 1024;
/** Maximum time diagnostics may spend waiting for a response-body preview. */
export const BODY_SNIPPET_TIMEOUT_MS = 1_000;
/** Maximum time a request waits for asynchronous diagnostics observers to flush. */
export const OBSERVER_FLUSH_TIMEOUT_MS = 5_000;
const REDACTED = '[redacted]';

const SAFE_HEADER_NAMES = new Set([
  'accept',
  'accept-encoding',
  'content-type',
  'last-event-id',
  'mcp-protocol-version',
  'traceparent',
  'tracestate',
  'user-agent',
  'x-adcp-agent-id',
  'x-adcp-request-id',
  'x-correlation-id',
  'x-request-id',
  'x-scope3-debug-id',
]);

const SENSITIVE_HEADER_NAMES = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
  'set-cookie',
  'x-adcp-auth',
  'x-api-key',
  'mcp-session-id',
]);

const SENSITIVE_EXACT_KEYS = new Set(['governance_context', 'consultation_context']);

const SENSITIVE_KEY_RE =
  /(^|[_-])(authorization|cookie|credentials?|secret|signature|token|api[_-]?key|private[_-]?key|idempotency[_-]?key|governance[_-]?context|consultation[_-]?context|password)([_-]|$)/i;
const SENSITIVE_TEXT_FIELD_RE =
  /((?:"[^"]*(?:authorization|cookie|credentials?|secret|signature|token|api[_-]?key|private[_-]?key|idempotency[_-]?key|governance[_-]?context|consultation[_-]?context|password)[^"]*"\s*:\s*)|(?:^|[&\s])[^=&\s]*(?:authorization|cookie|credentials?|secret|signature|token|api[_-]?key|private[_-]?key|idempotency[_-]?key|governance[_-]?context|consultation[_-]?context|password)[^=&\s]*=)("[^"]*"|[^&\s,}]+)/gi;
const URL_LIKE_RE = /\bhttps?:\/\/[^\s"'<>]+/gi;

export const transportDiagnosticsStorage = globalAsyncLocalStorage<TransportDiagnosticsSlot>('transportDiagnostics');

export function withTransportDiagnostics<T>(
  context: TransportActivityContext & { onTransportActivity?: TransportActivityHandler },
  fn: () => Promise<T>
): Promise<T> {
  if (!context.onTransportActivity) return fn();
  const slot: TransportDiagnosticsSlot = { ...context, pending: [] };
  return transportDiagnosticsStorage.run(slot, async () => {
    try {
      return await fn();
    } finally {
      await settleWithin(Promise.allSettled(slot.pending), OBSERVER_FLUSH_TIMEOUT_MS);
    }
  });
}

export function sanitizeTransportUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return 'invalid_url';
  }
}

export function sanitizeTransportHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of headerEntries(headers)) {
    const lower = key.toLowerCase();
    if (SENSITIVE_HEADER_NAMES.has(lower) || SENSITIVE_KEY_RE.test(lower)) {
      out[lower] = REDACTED;
    } else if (SAFE_HEADER_NAMES.has(lower) || isSafeCorrelationHeader(lower)) {
      out[lower] = value;
    }
  }
  return out;
}

export function wrapFetchWithTransportDiagnostics(upstream: typeof fetch): typeof fetch {
  const wrapped: typeof fetch = async (input, init) => {
    const slot = transportDiagnosticsStorage.getStore();
    if (!slot?.onTransportActivity) return upstream(input, init);
    const handler = slot.onTransportActivity;

    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    const transportRequestId = randomUUID();
    const method = getMethod(input, init);
    const url = sanitizeTransportUrl(getUrl(input));
    const requestHeaders = sanitizeTransportHeaders(mergeRequestHeaders(input, init));
    const requestBody = bodySnippet(init?.body);
    const baseEvent = {
      agentId: slot.agentId,
      protocol: slot.protocol,
      transportRequestId,
      ...(slot.tool && { tool: slot.tool, taskType: slot.taskType ?? slot.tool }),
      ...(slot.operationId && { operationId: slot.operationId }),
      ...(slot.taskId && { taskId: slot.taskId }),
      ...(slot.contextId && { contextId: slot.contextId }),
      ...(slot.idempotencyKey && { idempotencyKeyHash: fingerprintDiagnosticValue(slot.idempotencyKey) }),
      method,
      url,
      requestHeaders,
      ...(requestBody && {
        requestBody: requestBody.body,
        requestBodyTruncated: requestBody.truncated,
      }),
      startedAt,
    };

    emitTransportActivity(handler, {
      type: 'request_started',
      ...baseEvent,
      timestamp: startedAt,
    });

    try {
      const response = await upstream(input, init);
      const durationMs = Date.now() - startedAtMs;
      const responseHeaders = sanitizeResponseHeaders(response.headers);
      const responseEvent = {
        type: 'response_received',
        ...baseEvent,
        timestamp: new Date().toISOString(),
        durationMs,
        httpStatus: response.status,
        statusText: response.statusText,
        responseHeaders,
      } as const;
      const responseBody = responseBodySnippet(response);
      if (!responseBody) {
        // Non-text bodies, SSE, bodies without a finite declared size, and
        // bodies declared over the capture limit are never cloned. An absent
        // body is complete; a present but uncaptured body is truncated.
        emitTransportActivity(
          handler,
          response.body
            ? {
                ...responseEvent,
                responseBodyTruncated: true,
              }
            : responseEvent
        );
      } else {
        // Body capture is fire-and-forget. The response_received event fires
        // when capture completes, which may be after the diagnostics scope exits.
        void responseBody.then(
          captured => {
            return emitTransportActivity(handler, {
              ...responseEvent,
              ...(captured && { responseBody: captured.body }),
              responseBodyTruncated: captured?.truncated ?? true,
            });
          },
          () => {
            return emitTransportActivity(handler, {
              ...responseEvent,
              responseBodyTruncated: true,
            });
          }
        );
      }
      return response;
    } catch (error) {
      emitTransportActivity(handler, {
        type: 'request_failed',
        ...baseEvent,
        timestamp: new Date().toISOString(),
        durationMs: Date.now() - startedAtMs,
        errorName: error instanceof Error ? error.name : typeof error,
        errorMessage: sanitizeDiagnosticText(error instanceof Error ? error.message : String(error)),
      });
      throw error;
    }
  };
  return wrapped;
}

function emitTransportActivity(handler: TransportActivityHandler, event: TransportActivity): Promise<void> | undefined {
  try {
    const slot = transportDiagnosticsStorage.getStore();
    const frozen = Object.freeze(structuredClone(event));
    const pending = Promise.resolve()
      .then(() => handler(frozen))
      .then(
        () => {},
        () => {}
      );
    slot?.pending.push(pending);
    return pending;
  } catch {
    // Observability hooks must not change protocol behavior.
    return undefined;
  }
}

function getUrl(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
}

function getMethod(input: RequestInfo | URL, init?: RequestInit): string {
  return (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
}

function mergeRequestHeaders(input: RequestInfo | URL, init?: RequestInit): Headers {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  if (init?.headers) {
    for (const [key, value] of headerEntries(init.headers)) {
      headers.set(key, value);
    }
  }
  return headers;
}

function sanitizeResponseHeaders(headers: Headers): Record<string, string> {
  return sanitizeTransportHeaders(headers);
}

function headerEntries(headers: HeadersInit | undefined): Array<[string, string]> {
  if (!headers) return [];
  if (Array.isArray(headers)) return headers.map(([key, value]) => [key, String(value)]);

  // Headers objects are not required to share the global constructor. In
  // particular, callers can return an undici Response whose Headers instance
  // comes from a different package version than Node's built-in fetch. Use the
  // web-platform iteration surface instead of a realm-sensitive instanceof
  // check so diagnostics retain correlation metadata across those boundaries.
  const forEach = (headers as { forEach?: unknown }).forEach;
  if (typeof forEach === 'function') {
    const entries: Array<[string, string]> = [];
    try {
      forEach.call(headers, (value: unknown, key: unknown) => entries.push([String(key), String(value)]));
      return entries;
    } catch {
      // Diagnostics must not change request behavior when a non-standard
      // Headers-like object exposes a throwing iterator. Fall through to the
      // record representation, which is also how plain HeadersInit is handled.
    }
  }
  return Object.entries(headers).map(([key, value]) => [key, String(value)]);
}

function isSafeCorrelationHeader(lower: string): boolean {
  if (!lower.startsWith('x-')) return false;
  return (
    lower.includes('correlation') || lower.includes('debug') || lower.includes('request-id') || lower.includes('trace')
  );
}

function bodySnippet(body: BodyInit | null | undefined): { body: string; truncated: boolean } | undefined {
  if (body == null) return undefined;
  if (typeof body === 'string') return sanitizeBodyText(body, BODY_SNIPPET_LIMIT);
  if (body instanceof URLSearchParams) return sanitizeBodyText(body.toString(), BODY_SNIPPET_LIMIT);
  if (body instanceof Blob) return { body: `[blob ${body.size} bytes]`, truncated: false };
  if (body instanceof ArrayBuffer) {
    return sanitizeBodyText(Buffer.from(body).toString('utf8'), BODY_SNIPPET_LIMIT);
  }
  if (ArrayBuffer.isView(body)) {
    return sanitizeBodyText(
      Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString('utf8'),
      BODY_SNIPPET_LIMIT
    );
  }
  return undefined;
}

function responseBodySnippet(
  response: Response
): Promise<{ body: string; truncated: boolean } | undefined> | undefined {
  const contentType = response.headers.get('content-type') ?? '';
  if (!isDiagnosticTextContentType(contentType)) return undefined;
  const declaredLength = parseDiagnosticContentLength(response.headers.get('content-length'));
  if (declaredLength === undefined || declaredLength > BODY_SNIPPET_LIMIT) return undefined;

  let diagnosticResponse: Response;
  try {
    diagnosticResponse = response.clone();
  } catch {
    return undefined;
  }

  return (async () => {
    try {
      const captureAbort = new AbortController();
      const captured = await settleWithin(
        readResponseTextBounded(diagnosticResponse, BODY_SNIPPET_LIMIT, captureAbort.signal),
        BODY_SNIPPET_TIMEOUT_MS,
        () => captureAbort.abort()
      );
      if (captured === undefined) return undefined;
      const { text, truncated } = captured;
      return { body: redactSensitiveJsonOrText(text), truncated };
    } catch {
      return undefined;
    }
  })();
}

/**
 * Parse an explicit finite decimal length when one is available. Missing or
 * invalid lengths disable response-body capture.
 */
function parseDiagnosticContentLength(value: string | null): number | undefined {
  if (value === null || !/^(0|[1-9][0-9]*)$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

async function settleWithin<T>(
  operation: Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void
): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<undefined>(resolve => {
        timer = setTimeout(() => {
          onTimeout?.();
          resolve(undefined);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function sanitizeBodyText(text: string, limit: number): { body: string; truncated: boolean } {
  const truncated = text.length > limit;
  const bounded = truncated ? text.slice(0, limit) : text;
  return { body: redactSensitiveJsonOrText(bounded), truncated };
}

function redactSensitiveJsonOrText(text: string): string {
  try {
    return JSON.stringify(redactSensitiveValue(JSON.parse(text)));
  } catch {
    return sanitizeDiagnosticText(text);
  }
}

function redactSensitiveValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSensitiveValue);
  if (typeof value === 'string') return sanitizeStringValue(value);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = isSensitiveKey(key) ? REDACTED : redactSensitiveValue(child);
  }
  return out;
}

function sanitizeDiagnosticText(text: string): string {
  return text
    .replace(URL_LIKE_RE, value => sanitizeTransportUrl(value))
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/Basic\s+[A-Za-z0-9+/=-]+/gi, 'Basic [redacted]')
    .replace(SENSITIVE_TEXT_FIELD_RE, (_match, prefix) => `${prefix}${REDACTED}`);
}

function sanitizeStringValue(value: string): string {
  return sanitizeDiagnosticText(value);
}

function normalizedKey(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

function isSensitiveKey(key: string): boolean {
  const normalized = normalizedKey(key);
  return SENSITIVE_EXACT_KEYS.has(normalized) || SENSITIVE_KEY_RE.test(normalized);
}

function isDiagnosticTextContentType(contentType: string): boolean {
  const lower = contentType.toLowerCase();
  if (!lower) return true;
  if (lower.includes('text/event-stream')) return false;
  return (
    lower.startsWith('text/') ||
    lower.includes('json') ||
    lower.includes('xml') ||
    lower.includes('javascript') ||
    lower.includes('x-www-form-urlencoded')
  );
}

async function readResponseTextBounded(
  response: Response,
  limit: number,
  signal?: AbortSignal
): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) {
    const text = await response.text();
    return { text: text.slice(0, limit), truncated: text.length > limit };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let truncated = false;
  const cancel = () => {
    // This reader owns only the cloned diagnostics branch. Do not await tee
    // cancellation because the caller may not consume the original until the
    // wrapper returns.
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();

  try {
    while (text.length <= limit) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.length > limit) {
        truncated = true;
        text = text.slice(0, limit);
        // A cloned Response body is one branch of a tee. Waiting for this
        // cancellation can wait for the original branch to be consumed, but
        // the caller cannot consume it until this diagnostics wrapper returns.
        // Start cancellation to release the bounded diagnostic branch without
        // putting that circular dependency on the request path.
        void reader.cancel().catch(() => {});
        break;
      }
    }
    if (!truncated) text += decoder.decode();
  } finally {
    signal?.removeEventListener('abort', cancel);
    reader.releaseLock();
  }

  return { text, truncated };
}

function fingerprintDiagnosticValue(value: string): string {
  return createHmac('sha256', 'adcp-transport-diagnostics').update(value).digest('hex').slice(0, 16);
}
