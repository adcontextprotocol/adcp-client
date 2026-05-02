/**
 * `createUpstreamRecorder` implementation. See `./types.ts` for the public
 * surface and `./README` (file header on `index.ts`) for the why.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { redactSecrets, SECRET_KEY_PATTERN } from '../utils/redact-secrets';
import type {
  PurposeClassifier,
  RecordInput,
  RecordedCall,
  UpstreamRecorder,
  UpstreamRecorderOptions,
  UpstreamRecorderQueryParams,
  UpstreamRecorderQueryResult,
} from './types';

const DEFAULT_BUFFER_SIZE = 1000;
const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1h
const DEFAULT_QUERY_LIMIT = 100;

/**
 * Wrapped per-call entry stored in the buffer. Carries the public
 * `RecordedCall` plus the principal it was recorded under (kept off the
 * public type so cross-principal isolation is enforced at query time and
 * the principal never appears in the controller-response payload).
 */
interface InternalEntry {
  call: RecordedCall;
  principal: string;
  /** ms-since-epoch parse of `call.timestamp` cached for TTL eviction. */
  recordedAtMs: number;
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

  const redactPattern = options.redactPattern ?? SECRET_KEY_PATTERN;
  const bufferSize = options.bufferSize ?? DEFAULT_BUFFER_SIZE;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const purpose = options.purpose;

  // Buffer: ordered by insertion (== timestamp ascending). Eviction is
  // FIFO when full or TTL-prune at record time.
  const buffer: InternalEntry[] = [];

  // Active-principal context. Set by `runWithPrincipal`; read by the
  // wrapped fetch and by `record` when no explicit principal is passed.
  const principalStorage = new AsyncLocalStorage<string>();

  // ────────────────────────────────────────────────────────────
  // Internal helpers
  // ────────────────────────────────────────────────────────────

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

  function applyRedactionToPayload(payload: unknown): unknown {
    if (payload === undefined || payload === null) return payload;
    // Strings (form-urlencoded, multipart, etc.) — adapters MUST hand
    // already-formed bodies; the recorder doesn't try to parse and
    // re-redact arbitrary string formats. Adopter is responsible for
    // pre-redacting non-JSON bodies before passing them in.
    if (typeof payload === 'string') return payload;
    return redactSecrets(payload, redactPattern);
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
    } catch {
      // Classifier MUST NOT crash the recording path.
      return undefined;
    }
  }

  function buildRecordedCall(input: RecordInput): RecordedCall {
    const url = input.url;
    let host = '';
    let pathPart = '';
    try {
      const parsed = new URL(url);
      host = parsed.host;
      pathPart = parsed.pathname;
    } catch {
      // Invalid URL — fall back to defensible empties. The recorder
      // shouldn't reject a record because of a malformed URL; adopter
      // can still see the bad URL in `url`.
    }
    const redactedHeaders = applyRedactionToHeaders(input.headers);
    const purposeTag = classifyPurpose(input.method, url, host, pathPart, redactedHeaders);
    const call: RecordedCall = {
      method: input.method,
      endpoint: `${input.method} ${url}`,
      url,
      host,
      path: pathPart,
      content_type: input.content_type,
      payload: applyRedactionToPayload(input.payload),
      timestamp: new Date().toISOString(),
      ...(input.status_code !== undefined && { status_code: input.status_code }),
      ...(purposeTag !== undefined && { purpose: purposeTag }),
    };
    return call;
  }

  // ────────────────────────────────────────────────────────────
  // Public methods
  // ────────────────────────────────────────────────────────────

  function runWithPrincipal<T>(principal: string, fn: () => T | Promise<T>): Promise<T> {
    return Promise.resolve(principalStorage.run(principal, fn));
  }

  function record(input: RecordInput, explicitPrincipal?: string): void {
    const principal = explicitPrincipal ?? principalStorage.getStore();
    if (!principal) {
      // No active principal — drop on the floor. Adopters who want
      // strict-mode behavior can wrap and assert. Logging would risk
      // chattier production output if the recorder is left enabled
      // outside `runWithPrincipal`.
      return;
    }
    const nowMs = Date.now();
    evictExpired(nowMs);
    const call = buildRecordedCall(input);
    pushEntry({ call, principal, recordedAtMs: Date.parse(call.timestamp) });
  }

  function wrapFetch(originalFetch: typeof globalThis.fetch): typeof globalThis.fetch {
    return async function wrappedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const principal = principalStorage.getStore();
      // No active principal: pass through unchanged. The recorder is
      // intended to be a one-time wire-up at adapter boot; calls outside
      // `runWithPrincipal` (e.g. eager warm-up fetches at module load)
      // shouldn't be force-recorded under a synthetic principal.
      if (!principal) {
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
    const nowMs = Date.now();
    evictExpired(nowMs);
    const limit = Math.min(params.limit ?? DEFAULT_QUERY_LIMIT, bufferSize);
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

  return {
    runWithPrincipal,
    wrapFetch,
    record,
    query,
    clear,
    enabled: true,
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
      since_timestamp: params.sinceTimestamp ?? new Date().toISOString(),
    }),
    clear: () => undefined,
    enabled: false,
  };
}

/**
 * Read the request body off a fetch call site without consuming the
 * input (when the input is a `Request`, we'd lock its stream by reading
 * directly). Returns `undefined` for bodies the recorder can't snapshot
 * cheaply.
 *
 * Rules:
 *  - `init.body` as string / object / FormData / URLSearchParams: snapshot.
 *  - `init.body` missing AND `input instanceof Request`: clone the request
 *    so the wrapped fetch can still consume the original. (Spec-compliant
 *    fetch implementations support `.clone()`.)
 *  - JSON-shaped Content-Type with string body: parse, fall back to string
 *    on parse error.
 *  - Other types: pass the string through.
 */
async function readBody(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  contentType: string
): Promise<unknown> {
  const isJson = isJsonContentType(contentType);
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
    if (!isJson) return raw;
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
  // Object / array literal already, or a Buffer / Blob the adopter passed
  // in directly. Stringify objects; pass binary types through unchanged.
  if (typeof raw === 'object') return raw;
  return String(raw);
}

function isJsonContentType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const base = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  return base === 'application/json' || /\+json$/.test(base);
}

/**
 * Glob-to-regex translator. `*` → `.*` (greedy, `/`-crossing); all other
 * regex metacharacters are escaped literally. Matches the candidate
 * `endpoint_pattern` semantics the runner ships in `validations.ts`'s
 * `globToRegExp` so producer + consumer agree.
 */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}
