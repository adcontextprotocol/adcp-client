import { AsyncLocalStorage } from 'node:async_hooks';
import { createHmac } from 'node:crypto';

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

const SENSITIVE_KEY_RE =
  /(^|[_-])(authorization|cookie|credentials?|secret|signature|token|api[_-]?key|private[_-]?key|idempotency[_-]?key|password)([_-]|$)/i;
const SENSITIVE_TEXT_FIELD_RE =
  /((?:"[^"]*(?:authorization|cookie|credentials?|secret|signature|token|api[_-]?key|private[_-]?key|idempotency[_-]?key|password)[^"]*"\s*:\s*)|(?:^|[&\s])[^=&\s]*(?:authorization|cookie|credentials?|secret|signature|token|api[_-]?key|private[_-]?key|idempotency[_-]?key|password)[^=&\s]*=)("[^"]*"|[^&\s,}]+)/gi;
const URL_LIKE_RE = /\bhttps?:\/\/[^\s"'<>]+/gi;

export const transportDiagnosticsStorage = new AsyncLocalStorage<TransportDiagnosticsSlot>();

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
      await Promise.allSettled(slot.pending);
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

    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    const method = getMethod(input, init);
    const url = sanitizeTransportUrl(getUrl(input));
    const requestHeaders = sanitizeTransportHeaders(mergeRequestHeaders(input, init));
    const requestBody = bodySnippet(init?.body);
    const baseEvent = {
      agentId: slot.agentId,
      protocol: slot.protocol,
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

    emitTransportActivity(slot.onTransportActivity, {
      type: 'request_started',
      ...baseEvent,
      timestamp: startedAt,
    });

    try {
      const response = await upstream(input, init);
      const durationMs = Date.now() - startedAtMs;
      const responseHeaders = sanitizeResponseHeaders(response.headers);
      const responseBody = await responseBodySnippet(response);
      emitTransportActivity(slot.onTransportActivity, {
        type: 'response_received',
        ...baseEvent,
        timestamp: new Date().toISOString(),
        durationMs,
        httpStatus: response.status,
        statusText: response.statusText,
        responseHeaders,
        ...(responseBody && {
          responseBody: responseBody.body,
          responseBodyTruncated: responseBody.truncated,
        }),
      });
      return response;
    } catch (error) {
      emitTransportActivity(slot.onTransportActivity, {
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

function emitTransportActivity(handler: TransportActivityHandler, event: TransportActivity): void {
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
  } catch {
    // Observability hooks must not change protocol behavior.
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
  if (headers instanceof Headers) {
    const entries: Array<[string, string]> = [];
    headers.forEach((value, key) => entries.push([key, value]));
    return entries;
  }
  if (Array.isArray(headers)) return headers.map(([key, value]) => [key, value]);
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

async function responseBodySnippet(response: Response): Promise<{ body: string; truncated: boolean } | undefined> {
  const contentType = response.headers.get('content-type') ?? '';
  if (!isDiagnosticTextContentType(contentType)) return undefined;
  try {
    const { text, truncated } = await readResponseTextBounded(response.clone(), BODY_SNIPPET_LIMIT);
    return { body: redactSensitiveJsonOrText(text), truncated };
  } catch {
    return undefined;
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
  return SENSITIVE_KEY_RE.test(normalizedKey(key));
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
  limit: number
): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) {
    const text = await response.text();
    return { text: text.slice(0, limit), truncated: text.length > limit };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let truncated = false;

  try {
    while (text.length <= limit) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.length > limit) {
        truncated = true;
        text = text.slice(0, limit);
        await reader.cancel();
        break;
      }
    }
    if (!truncated) text += decoder.decode();
  } finally {
    reader.releaseLock();
  }

  return { text, truncated };
}

function fingerprintDiagnosticValue(value: string): string {
  return createHmac('sha256', 'adcp-transport-diagnostics').update(value).digest('hex').slice(0, 16);
}
