// Byte-equivalence comparator for the uniform-error-response invariant.
//
// Hard fails (populate `differences`, set `equivalent: false`):
//   - HTTP status diverges
//   - Error envelope fields diverge (code, message, field, details)
//     when both bodies parse as JSON error envelopes
//   - Raw body bytes diverge when bodies don't parse as recognized
//     error envelopes (MCP isError wrappers still compared body-level)
//   - Response headers diverge outside the narrow allowlist
//
// Soft metadata (populate `latencyDeltaMs`, no verdict change):
//   - Latency delta between the two probes. Extreme deltas are a
//     short-circuit-on-unknown smell (seller skips access check when
//     the id is well-formed-gibberish) — reviewers should inspect, but
//     one paired probe isn't enough to statistically fail on it.

import type { RawHttpCapture } from '../../protocols/rawResponseCapture';

export interface ProbeComparisonResult {
  equivalent: boolean;
  differences: string[];
  latencyDeltaMs: number;
}

/**
 * Response headers that MAY legitimately differ between two otherwise
 * identical probes. Everything else MUST match. Closed allowlist —
 * unknown headers default to must-match, which forces sellers to be
 * explicit about per-request fields.
 *
 * Three categories are covered:
 *   1. Timing/diagnostic: `Date`, `Server`, `Server-Timing`, `Age`, `Via`
 *   2. Request-ID / distributed tracing: `X-Request-Id`,
 *      `X-Correlation-Id`, `X-Trace-Id`, `Traceparent`, `Tracestate`
 *   3. CDN insertions: `CF-Ray` (Cloudflare), `X-Amz-Cf-Id`
 *      (CloudFront), `X-Amz-Request-Id` / `X-Amzn-Trace-Id` (AWS LB /
 *      API Gateway). These are inserted by the edge for every request
 *      and would otherwise false-positive fail any seller behind a CDN.
 *
 * NOT allowlisted (must-match) — and worth calling out because they
 * look variable but actually carry signal:
 *   - `Content-Length`: byte-equivalent bodies have equal length.
 *     Divergence = body divergence.
 *   - `Vary`: content-negotiation policy is per-resource, not
 *     per-request. Divergence implies the seller routed the two
 *     probes through different handlers.
 *   - `Content-Type`: same story — one codepath emits JSON, the other
 *     emits HTML error page = leak.
 *   - `ETag`, `Cache-Control`, `X-RateLimit-*`: attacker-visible side
 *     channels that MUST NOT differ.
 *
 * Header names are normalized to lowercase before membership check.
 */
const HEADER_ALLOWLIST: ReadonlySet<string> = new Set([
  // Timing / diagnostic
  'date',
  'server',
  'server-timing',
  'age',
  'via',
  // Request id / distributed tracing
  'x-request-id',
  'x-correlation-id',
  'x-trace-id',
  'traceparent',
  'tracestate',
  // CDN / edge insertions
  'cf-ray',
  'x-amz-cf-id',
  'x-amz-request-id',
  'x-amzn-trace-id',
]);

export function compareProbes(a: RawHttpCapture, b: RawHttpCapture): ProbeComparisonResult {
  const differences: string[] = [];

  if (a.status !== b.status) {
    differences.push(`HTTP status diverges: ${a.status} vs ${b.status}`);
  }

  diffHeaders(a.headers, b.headers, differences);
  diffBodies(a.body, b.body, differences);

  return {
    equivalent: differences.length === 0,
    differences,
    latencyDeltaMs: Math.abs(a.latencyMs - b.latencyMs),
  };
}

function diffHeaders(
  headersA: Record<string, string>,
  headersB: Record<string, string>,
  differences: string[]
): void {
  const namesA = normalizedNames(headersA);
  const namesB = normalizedNames(headersB);
  const allNames = new Set([...namesA.keys(), ...namesB.keys()]);
  for (const lower of allNames) {
    if (HEADER_ALLOWLIST.has(lower)) continue;
    const valueA = namesA.get(lower);
    const valueB = namesB.get(lower);
    if (valueA === undefined && valueB !== undefined) {
      differences.push(`header "${lower}" present on probe B only: ${JSON.stringify(valueB)}`);
    } else if (valueA !== undefined && valueB === undefined) {
      differences.push(`header "${lower}" present on probe A only: ${JSON.stringify(valueA)}`);
    } else if (valueA !== valueB) {
      differences.push(
        `header "${lower}" diverges: ${JSON.stringify(valueA)} vs ${JSON.stringify(valueB)}`
      );
    }
  }
}

function normalizedNames(headers: Record<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [name, value] of Object.entries(headers)) {
    out.set(name.toLowerCase(), value);
  }
  return out;
}

/**
 * Body comparison order:
 *
 * 1. Exact string match — the happy path for sellers whose transport
 *    fully normalizes per-request metadata.
 * 2. JSON parse on both sides. If both parse:
 *    a. If both carry a recognizable error envelope, compare envelope
 *       fields + MCP isError / A2A state ONLY. Per-request metadata
 *       (JSON-RPC id, MCP request id, timestamps) legitimately varies
 *       and would otherwise mask the real invariant signal.
 *    b. Otherwise, structural equality — catches reordered keys that
 *       raw compare would call a miss.
 * 3. Non-JSON or mixed — raw byte-length hint.
 */
function diffBodies(bodyA: string, bodyB: string, differences: string[]): void {
  if (bodyA === bodyB) return;

  const parsedA = tryParseJson(bodyA);
  const parsedB = tryParseJson(bodyB);
  if (parsedA !== undefined && parsedB !== undefined) {
    // State indicators (MCP isError, A2A task state) run unconditionally
    // — they're protocol-level signals that live outside the error
    // envelope and MUST match even when the domain body is empty.
    diffStateIndicators(parsedA, parsedB, differences);

    const envA = extractEnvelope(parsedA);
    const envB = extractEnvelope(parsedB);
    if (envA !== undefined || envB !== undefined) {
      diffEnvelopeFields(envA, envB, differences);
      return;
    }
    if (deepEqual(parsedA, parsedB)) return;
    if (differences.length === 0) {
      differences.push('response body diverges (parsed JSON differs)');
    }
    return;
  }

  differences.push(
    `response body diverges (${bodyA.length} bytes vs ${bodyB.length} bytes)`
  );
}

function tryParseJson(text: string): unknown {
  if (text.length === 0) return undefined;
  const payload = text.startsWith('event:') || text.startsWith('data:') ? extractSsePayload(text) : text;
  if (!payload) return undefined;
  try {
    return JSON.parse(payload);
  } catch {
    return undefined;
  }
}

/**
 * Extract the JSON payload from an SSE-formatted response body.
 * MCP's StreamableHTTP transport returns single-shot responses as
 * ```
 * event: message
 * data: {"jsonrpc":"2.0",...}
 * ```
 * rather than a bare JSON document. Concatenates consecutive `data:`
 * lines per SSE spec; returns the last event's payload when multiple
 * events are present (the tool result is always the final one).
 */
function extractSsePayload(text: string): string | undefined {
  const lines = text.split(/\r?\n/);
  let current: string[] = [];
  let last: string | undefined;
  for (const line of lines) {
    if (line === '') {
      if (current.length > 0) {
        last = current.join('\n');
        current = [];
      }
      continue;
    }
    if (line.startsWith('data:')) {
      current.push(line.slice(5).replace(/^ /, ''));
    }
  }
  if (current.length > 0) last = current.join('\n');
  return last;
}

/** Field-level diff on two extracted envelopes. Either side may be undefined. */
function diffEnvelopeFields(
  envA: ErrorEnvelope | undefined,
  envB: ErrorEnvelope | undefined,
  differences: string[]
): void {
  if (envA === undefined && envB === undefined) return;
  if (envA === undefined) {
    differences.push('error envelope present on probe B only (probe A was not a recognized error shape)');
    return;
  }
  if (envB === undefined) {
    differences.push('error envelope present on probe A only (probe B was not a recognized error shape)');
    return;
  }
  const fields: Array<keyof ErrorEnvelope> = ['code', 'message', 'field', 'details'];
  for (const field of fields) {
    const vA = envA[field];
    const vB = envB[field];
    if (vA === undefined && vB === undefined) continue;
    if (!deepEqual(vA, vB)) {
      differences.push(`error.${field} diverges: ${safeSlice(vA)} vs ${safeSlice(vB)}`);
    }
  }
}

/**
 * MCP `isError` and A2A `task.status.state` live outside the error
 * envelope but must match — a seller that flips `isError` or the A2A
 * state between probes is leaking existence info through transport-
 * level state even when the domain envelope matches.
 */
function diffStateIndicators(a: unknown, b: unknown, differences: string[]): void {
  const isErrorA = extractIsError(a);
  const isErrorB = extractIsError(b);
  if (isErrorA !== isErrorB) {
    differences.push(`MCP isError diverges: ${isErrorA} vs ${isErrorB}`);
  }
  const stateA = extractA2AState(a);
  const stateB = extractA2AState(b);
  if (stateA !== stateB) {
    differences.push(`A2A task.status.state diverges: ${stateA} vs ${stateB}`);
  }
}

interface ErrorEnvelope {
  code?: unknown;
  message?: unknown;
  field?: unknown;
  details?: unknown;
}

function extractEnvelope(body: unknown): ErrorEnvelope | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const obj = body as Record<string, unknown>;

  // JSON-RPC wrapper — `result` carries the MCP CallToolResult on
  // success, `error` carries a JSON-RPC error on transport-level
  // failures. Recurse into whichever is present before the domain
  // extractors below.
  if (
    typeof obj.jsonrpc === 'string' &&
    'id' in obj &&
    (obj.result !== undefined || obj.error !== undefined)
  ) {
    if (obj.result !== undefined) {
      const inner = extractEnvelope(obj.result);
      if (inner) return inner;
    }
    if (obj.error !== undefined) {
      const inner = extractEnvelope(obj.error);
      if (inner) return inner;
    }
    return undefined;
  }

  // MCP CallToolResult: { isError?, structuredContent?, content?[{type:'text',text}] }.
  // Prefer structuredContent — it's the normalized shape the AdCP
  // server SDK emits. Fall back to parsing the text content for
  // agents that only set `content`.
  if (obj.structuredContent && typeof obj.structuredContent === 'object') {
    const inner = extractEnvelope(obj.structuredContent);
    if (inner) return inner;
  }
  if (Array.isArray(obj.content) && obj.content.length > 0) {
    for (const part of obj.content) {
      const text = (part as { type?: string; text?: string })?.text;
      if (typeof text === 'string') {
        const parsed = tryParseJson(text);
        if (parsed && typeof parsed === 'object') {
          const inner = extractEnvelope(parsed);
          if (inner) return inner;
        }
      }
    }
  }

  // AdCP server SDK emits { adcp_error: { code, message, ... } }.
  if (obj.adcp_error && typeof obj.adcp_error === 'object') {
    return obj.adcp_error as ErrorEnvelope;
  }

  // AdCP `errors[0]` — preferred over bare `error` since the spec
  // ships a plural array.
  if (Array.isArray(obj.errors) && obj.errors.length > 0) {
    const first = obj.errors[0];
    if (first && typeof first === 'object') return first as ErrorEnvelope;
  }

  // Bare `error` — plain domain envelope or JSON-RPC error with `data`
  // carrying the AdCP code.
  if (typeof obj.error === 'object' && obj.error !== null) {
    const e = obj.error as Record<string, unknown>;
    if (e.data && typeof e.data === 'object') return e.data as ErrorEnvelope;
    return e as ErrorEnvelope;
  }

  return undefined;
}

function extractIsError(body: unknown): boolean | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const obj = body as Record<string, unknown>;
  // JSON-RPC wrapper — CallToolResult sits under `result`.
  if (typeof obj.jsonrpc === 'string' && obj.result && typeof obj.result === 'object') {
    return extractIsError(obj.result);
  }
  const value = obj.isError;
  return typeof value === 'boolean' ? value : undefined;
}

function extractA2AState(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const obj = body as Record<string, unknown>;
  // A2A messages wrap the task under `result` inside JSON-RPC.
  if (typeof obj.jsonrpc === 'string' && obj.result && typeof obj.result === 'object') {
    return extractA2AState(obj.result);
  }
  const state = (obj as { task?: { status?: { state?: unknown } } }).task?.status?.state;
  if (typeof state === 'string') return state;
  // A2A payloads sometimes embed the status directly on the result.
  const directStatus = (obj as { status?: { state?: unknown } }).status?.state;
  return typeof directStatus === 'string' ? directStatus : undefined;
}

function safeSlice(value: unknown, limit = 120): string {
  try {
    const s = JSON.stringify(value);
    if (!s) return String(value);
    return s.length <= limit ? s : s.slice(0, limit) + '…';
  } catch {
    return String(value);
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== 'object') return a === b;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const aKeys = Object.keys(a as object).sort();
  const bKeys = Object.keys(b as object).sort();
  if (aKeys.length !== bKeys.length) return false;
  for (let i = 0; i < aKeys.length; i++) if (aKeys[i] !== bKeys[i]) return false;
  for (const key of aKeys) {
    if (!deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) return false;
  }
  return true;
}
