/**
 * `createUpstreamRecorder` implementation. See `./types.ts` for the public
 * surface and `./README` (file header on `index.ts`) for the why.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { redactSecrets, SECRET_KEY_PATTERN } from '../utils/redact-secrets';
import { globToRegExp } from '../utils/glob';
import {
  UpstreamRecorderScopeError,
  type QueryUpstreamTrafficResponse,
  type RecordInput,
  type RecordedCall,
  type UpstreamRecorder,
  type UpstreamRecorderDebugInfo,
  type UpstreamRecorderErrorEvent,
  type UpstreamRecorderOptions,
  type UpstreamRecorderQueryParams,
  type UpstreamRecorderQueryResult,
} from './types';

const DEFAULT_BUFFER_SIZE = 1000;
const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1h
const DEFAULT_QUERY_LIMIT = 100;
const DEFAULT_MAX_PAYLOAD_BYTES = 65_536; // mirrors spec's `recorded_calls[].payload.maxLength`
const MAX_BUFFER_SIZE = 100_000;
const MAX_TTL_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * Wrapped per-call entry stored in the buffer. Carries the public
 * `RecordedCall` plus the principal it was recorded under (kept off the
 * public type so cross-principal isolation is enforced at query time and
 * the principal never appears in the controller-response payload).
 */
interface InternalEntry {
  call: RecordedCall;
  principal: string;
  /** ms-since-epoch cached for TTL eviction; computed at insert time. */
  recordedAtMs: number;
}

function clamp(n: number | undefined, lo: number, hi: number, fallback: number): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
  // Out-of-range values (zero / negative / above ceiling) revert to the
  // default rather than silently saturating at the limit — a typo'd
  // `bufferSize: -10` silently saturating to `1` would drop nearly
  // everything; the default is a much safer failure mode.
  if (n < lo || n > hi) return fallback;
  return n;
}

function isPrincipalString(p: unknown): p is string {
  return typeof p === 'string' && p.length > 0;
}

/**
 * Build the recorder. Producer-side companion to the
 * `runner-output-contract.yaml` v2.0.0 `upstream_traffic` storyboard
 * check (spec PR adcontextprotocol/adcp#3816).
 */
export function createUpstreamRecorder(options: UpstreamRecorderOptions = {}): UpstreamRecorder {
  const enabled = options.enabled ?? true;
  // Disabled-recorder fast-path: skip every wrapping cost. Production
  // builds get a no-op object whose methods compile to inlinable returns.
  if (!enabled) return makeNoopRecorder();

  // Production-enable footgun guard: when adopters ship with `enabled:
  // true` in `NODE_ENV=production` (forgot the gate, or the gate is
  // mis-evaluated), emit a one-time warning. ADCP_RECORDER_PRODUCTION_ACK=1
  // is the explicit acknowledgment escape hatch for the rare adopters
  // who legitimately want recording in prod.
  warnIfEnabledInProduction();

  const redactPattern = options.redactPattern ?? SECRET_KEY_PATTERN;
  const bufferSize = clamp(options.bufferSize, 1, MAX_BUFFER_SIZE, DEFAULT_BUFFER_SIZE);
  const ttlMs = clamp(options.ttlMs, 1, MAX_TTL_MS, DEFAULT_TTL_MS);
  const maxPayloadBytes = clamp(options.maxPayloadBytes, 0, 16 * 1024 * 1024, DEFAULT_MAX_PAYLOAD_BYTES);
  const purpose = options.purpose;
  const strict = options.strict === true;
  const onError = options.onError;

  // Buffer: ordered by insertion (== timestamp ascending). Eviction is
  // FIFO when full or TTL-prune at record time.
  const buffer: InternalEntry[] = [];

  // Active-principal context. Set by `runWithPrincipal`; read by the
  // wrapped fetch and by `record` when no explicit principal is passed.
  const principalStorage = new AsyncLocalStorage<string>();

  // ────────────────────────────────────────────────────────────
  // Internal helpers
  // ────────────────────────────────────────────────────────────

  function emitError(event: UpstreamRecorderErrorEvent): void {
    if (!onError) return;
    try {
      onError(event);
    } catch {
      // onError MUST NOT crash the recorder — silent.
    }
  }

  function evictExpired(nowMs: number): void {
    if (buffer.length === 0) return;
    const cutoff = nowMs - ttlMs;
    let idx = 0;
    while (idx < buffer.length && buffer[idx]!.recordedAtMs < cutoff) idx++;
    if (idx > 0) buffer.splice(0, idx);
  }

  function pushEntry(entry: InternalEntry): void {
    buffer.push(entry);
    while (buffer.length > bufferSize) buffer.shift();
  }

  function applyRedactionToHeaders(headers: Record<string, string> | undefined): Record<string, string> {
    if (!headers) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      const lower = k.toLowerCase();
      out[lower] = redactPattern.test(lower) ? '[redacted]' : v;
    }
    return out;
  }

  /**
   * Apply per-key redaction to the body. JSON bodies (objects + arrays)
   * walk through `redactSecrets`. Form-urlencoded strings parse +
   * key-redact + re-stringify so `access_token=xxx` is caught without
   * the adopter pre-redacting. Other string types pass through. Binary
   * types (Buffer / Blob / ArrayBuffer / TypedArray) are replaced with
   * a marker — the buffer should not hold raw bytes whose JSON-shape
   * is misleading downstream.
   */
  function applyRedactionToPayload(payload: unknown, contentType: string): { value: unknown; bytes: number } {
    if (payload === undefined || payload === null) return { value: payload, bytes: 0 };

    // Binary-shaped bodies — replace with a marker. Adopters that need
    // the raw bytes recorded for diagnostics can stringify before
    // calling `record()`.
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(payload)) {
      return { value: `[binary ${payload.length} bytes]`, bytes: payload.length };
    }
    if (typeof Blob !== 'undefined' && payload instanceof Blob) {
      return { value: `[binary ${payload.size} bytes]`, bytes: payload.size };
    }
    if (payload instanceof ArrayBuffer) {
      return { value: `[binary ${payload.byteLength} bytes]`, bytes: payload.byteLength };
    }
    if (ArrayBuffer.isView(payload)) {
      return { value: `[binary ${payload.byteLength} bytes]`, bytes: payload.byteLength };
    }

    if (typeof payload === 'string') {
      // Form-urlencoded redaction: parse, redact, re-stringify so
      // `access_token=...` bodies don't slip through unredacted.
      if (isFormUrlEncoded(contentType)) {
        const redacted = redactFormUrlEncoded(payload, redactPattern);
        return { value: cap(redacted, maxPayloadBytes), bytes: byteLengthOf(redacted) };
      }
      return { value: cap(payload, maxPayloadBytes), bytes: byteLengthOf(payload) };
    }

    const redacted = redactSecrets(payload, redactPattern);
    const json = safeStringify(redacted);
    if (json && maxPayloadBytes > 0 && byteLengthOf(json) > maxPayloadBytes) {
      return { value: `[truncated ${byteLengthOf(json)} bytes]`, bytes: byteLengthOf(json) };
    }
    return { value: redacted, bytes: json ? byteLengthOf(json) : 0 };
  }

  function classifyPurpose(
    method: string,
    url: string,
    host: string,
    path: string,
    headers: Record<string, string>
  ): string | undefined {
    if (!purpose) return undefined;
    try {
      return purpose({ method, url, host, path, headers });
    } catch (err) {
      emitError({ kind: 'classifier_threw', err });
      return undefined;
    }
  }

  function buildRecordedCall(input: RecordInput, nowMs: number): RecordedCall | null {
    try {
      const url = input.url;
      let host = '';
      let pathPart = '';
      try {
        const parsed = new URL(url);
        host = parsed.host;
        pathPart = parsed.pathname;
      } catch {
        emitError({ kind: 'url_parse_failed', url });
      }
      const redactedHeaders = applyRedactionToHeaders(input.headers);
      const purposeTag = classifyPurpose(input.method, url, host, pathPart, redactedHeaders);
      const { value: payload } = applyRedactionToPayload(input.payload, input.content_type);
      return {
        method: input.method,
        endpoint: `${input.method} ${url}`,
        url,
        host,
        path: pathPart,
        content_type: input.content_type,
        payload,
        timestamp: new Date(nowMs).toISOString(),
        ...(input.status_code !== undefined && { status_code: input.status_code }),
        ...(purposeTag !== undefined && { purpose: purposeTag }),
      };
    } catch (err) {
      // Hostile / buggy payload (throwing getter, etc.). Recording MUST
      // never break the adapter call site.
      emitError({ kind: 'payload_build_failed', err });
      return null;
    }
  }

  // ────────────────────────────────────────────────────────────
  // Public methods
  // ────────────────────────────────────────────────────────────

  function runWithPrincipal<T>(principal: string, fn: () => T | Promise<T>): Promise<T> {
    if (!isPrincipalString(principal)) {
      return Promise.reject(
        new UpstreamRecorderScopeError(
          'runWithPrincipal: principal MUST be a non-empty string. Pass the same identifier you receive in your comply_test_controller handler.'
        )
      );
    }
    return Promise.resolve(principalStorage.run(principal, fn));
  }

  function record(input: RecordInput, explicitPrincipal?: string): void {
    const principal = explicitPrincipal ?? principalStorage.getStore();
    if (!isPrincipalString(principal)) {
      if (strict) {
        throw new UpstreamRecorderScopeError(
          `record() called outside runWithPrincipal scope (method=${input.method}, url=${input.url}). Wrap the call site or pass an explicit principal.`
        );
      }
      emitError({ kind: 'unscoped_record', method: input.method, url: input.url });
      return;
    }
    const nowMs = Date.now();
    evictExpired(nowMs);
    const call = buildRecordedCall(input, nowMs);
    if (!call) return;
    pushEntry({ call, principal, recordedAtMs: nowMs });
  }

  function wrapFetch(originalFetch: typeof globalThis.fetch): typeof globalThis.fetch {
    return async function wrappedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const principal = principalStorage.getStore();
      // No active principal: pass through unchanged in non-strict mode.
      // In strict mode, a fetch outside scope is the same authoring bug
      // as `record()` outside scope and surfaces the same way.
      if (!principal) {
        if (strict) {
          throw new UpstreamRecorderScopeError(
            `wrapFetch invoked outside runWithPrincipal scope (input=${typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url}). Wrap the call site.`
          );
        }
        return originalFetch(input as Parameters<typeof globalThis.fetch>[0], init);
      }

      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

      // Header normalization — fetch's Headers form vs init.headers Record vs Request body.
      const headerObj: Record<string, string> = {};
      if (init?.headers) {
        const h = init.headers;
        if (h instanceof Headers) {
          h.forEach((v, k) => {
            headerObj[k.toLowerCase()] = v;
          });
        } else if (Array.isArray(h)) {
          for (const [k, v] of h) headerObj[k.toLowerCase()] = v;
        } else {
          for (const [k, v] of Object.entries(h as Record<string, string>)) headerObj[k.toLowerCase()] = v;
        }
      } else if (input instanceof Request) {
        input.headers.forEach((v, k) => {
          headerObj[k.toLowerCase()] = v;
        });
      }

      const contentType = headerObj['content-type'] ?? '';
      const payload = await readBody(input, init, contentType);

      // Fire the actual call; record after we have a status_code. On
      // throw, we still record the attempt with no status_code so the
      // adopter can see the call was made.
      let response: Response | undefined;
      let thrown: unknown;
      try {
        response = await originalFetch(input as Parameters<typeof globalThis.fetch>[0], init);
      } catch (err) {
        thrown = err;
      }

      record(
        {
          method,
          url,
          content_type: contentType,
          headers: headerObj,
          payload,
          ...(response && { status_code: response.status }),
        },
        principal
      );

      if (thrown) throw thrown;
      return response!;
    };
  }

  function query(params: UpstreamRecorderQueryParams): UpstreamRecorderQueryResult {
    if (!isPrincipalString(params.principal)) {
      throw new UpstreamRecorderScopeError(
        'query({ principal }): principal MUST be a non-empty string. Cross-principal isolation depends on this — passing an empty / non-string value would silently match no entries and conceal misconfiguration.'
      );
    }
    const nowMs = Date.now();
    evictExpired(nowMs);
    const limit = clamp(params.limit, 1, bufferSize, DEFAULT_QUERY_LIMIT);
    const sinceMs = params.sinceTimestamp ? Date.parse(params.sinceTimestamp) : 0;
    const endpointMatcher = params.endpointPattern ? globToRegExp(params.endpointPattern) : undefined;

    const matched = buffer.filter(entry => {
      if (entry.principal !== params.principal) return false; // hard isolation
      if (entry.recordedAtMs < sinceMs) return false;
      if (endpointMatcher && !endpointMatcher.test(entry.call.endpoint)) return false;
      return true;
    });

    const total = matched.length;
    const items = matched.slice(0, limit).map(e => e.call);
    const since_timestamp =
      params.sinceTimestamp ?? matched[0]?.call.timestamp ?? new Date(nowMs - ttlMs).toISOString();
    return {
      items,
      total,
      truncated: total > items.length,
      since_timestamp,
    };
  }

  function clear(): void {
    buffer.length = 0;
  }

  function debug(): UpstreamRecorderDebugInfo {
    const principals = Array.from(new Set(buffer.map(e => e.principal))).sort();
    const last = buffer[buffer.length - 1];
    return {
      enabled: true,
      bufferSize,
      bufferedEntries: buffer.length,
      principals,
      lastRecordedAt: last ? last.call.timestamp : null,
      activePrincipal: principalStorage.getStore() ?? null,
      strict,
    };
  }

  return {
    runWithPrincipal,
    wrapFetch,
    record,
    query,
    clear,
    debug,
    enabled: true,
  };
}

/**
 * Project a `recorder.query()` result onto the spec wire shape returned
 * by `comply_test_controller`'s `query_upstream_traffic` scenario
 * (`UpstreamTrafficSuccess` in `comply-test-controller-response.json`,
 * spec PR adcontextprotocol/adcp#3816). Eliminates the
 * `items → recorded_calls` / `total → total_count` field-rename footgun
 * — adopters return this directly:
 *
 * ```ts
 * scenarios: {
 *   query_upstream_traffic: ({ params }, ctx) =>
 *     toQueryUpstreamTrafficResponse(
 *       recorder.query({
 *         principal: resolvePrincipal(ctx),
 *         sinceTimestamp: params?.since_timestamp,
 *         endpointPattern: params?.endpoint_pattern,
 *         limit: params?.limit,
 *       })
 *     ),
 * }
 * ```
 */
export function toQueryUpstreamTrafficResponse(result: UpstreamRecorderQueryResult): QueryUpstreamTrafficResponse {
  return {
    success: true,
    recorded_calls: result.items,
    total_count: result.total,
    truncated: result.truncated,
    since_timestamp: result.since_timestamp,
  };
}

/**
 * No-op recorder returned when `enabled: false`. Every method is a
 * pass-through / empty-result. Production builds drop in this object
 * with zero per-call overhead beyond the initial factory call.
 */
function makeNoopRecorder(): UpstreamRecorder {
  return {
    runWithPrincipal: <T>(_p: string, fn: () => T | Promise<T>): Promise<T> => Promise.resolve(fn()),
    wrapFetch: (originalFetch: typeof globalThis.fetch): typeof globalThis.fetch => originalFetch,
    record: () => undefined,
    query: (params: UpstreamRecorderQueryParams): UpstreamRecorderQueryResult => ({
      items: [],
      total: 0,
      truncated: false,
      since_timestamp: params.sinceTimestamp ?? '',
    }),
    clear: () => undefined,
    debug: (): UpstreamRecorderDebugInfo => ({
      enabled: false,
      bufferSize: 0,
      bufferedEntries: 0,
      principals: [],
      lastRecordedAt: null,
      activePrincipal: null,
      strict: false,
    }),
    enabled: false,
  };
}

let warnedAboutProduction = false;
function warnIfEnabledInProduction(): void {
  if (warnedAboutProduction) return;
  if (typeof process === 'undefined' || !process.env) return;
  if (process.env.NODE_ENV !== 'production') return;
  if (process.env.ADCP_RECORDER_PRODUCTION_ACK === '1') return;
  warnedAboutProduction = true;
  // eslint-disable-next-line no-console
  console.warn(
    '[adcp/upstream-recorder] enabled: true in NODE_ENV=production. ' +
      'The recorder buffers outbound HTTP calls in-memory — sandbox-only by design. ' +
      'Set enabled: false (recommended) or ADCP_RECORDER_PRODUCTION_ACK=1 to silence.'
  );
}

/**
 * Read the request body off a fetch call site without consuming the
 * input (when the input is a `Request`, we'd lock its stream by reading
 * directly). Returns `undefined` for bodies the recorder can't snapshot
 * cheaply.
 */
async function readBody(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  contentType: string
): Promise<unknown> {
  let raw: unknown;

  if (init?.body !== undefined && init.body !== null) {
    raw = init.body;
  } else if (input instanceof Request) {
    try {
      raw = await input.clone().text();
    } catch {
      raw = undefined;
    }
  } else {
    raw = undefined;
  }

  if (raw === undefined) return undefined;
  if (typeof raw === 'string') {
    if (!isJsonContentType(contentType)) return raw;
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  // FormData / URLSearchParams stringify cleanly enough for diagnostic value.
  if (raw instanceof URLSearchParams) return raw.toString();
  if (typeof FormData !== 'undefined' && raw instanceof FormData) {
    const out: Record<string, unknown> = {};
    raw.forEach((v, k) => {
      out[k] = typeof v === 'string' ? v : '[file]';
    });
    return out;
  }
  // Object / array literal already, or a Buffer / Blob / TypedArray /
  // ArrayBuffer the adopter passed in directly. Pass through — the
  // redaction step below detects binary types and substitutes markers
  // before they sit in the buffer.
  if (typeof raw === 'object') return raw;
  return String(raw);
}

function isJsonContentType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const base = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  return base === 'application/json' || /\+json$/.test(base);
}

function isFormUrlEncoded(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const base = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  return base === 'application/x-www-form-urlencoded';
}

function redactFormUrlEncoded(body: string, pattern: RegExp): string {
  try {
    const params = new URLSearchParams(body);
    const out = new URLSearchParams();
    params.forEach((v, k) => {
      out.append(k, pattern.test(k.toLowerCase()) ? '[redacted]' : v);
    });
    return out.toString();
  } catch {
    return body;
  }
}

function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function byteLengthOf(s: string): number {
  if (typeof Buffer !== 'undefined') return Buffer.byteLength(s, 'utf8');
  // Fallback — rough UTF-16 count.
  return s.length;
}

function cap(s: string, maxBytes: number): string {
  if (maxBytes <= 0) return s;
  if (byteLengthOf(s) <= maxBytes) return s;
  return `[truncated ${byteLengthOf(s)} bytes]`;
}
