/**
 * OpenTelemetry tracing utilities for @adcp/client
 *
 * Uses dynamic require to gracefully handle missing @opentelemetry/api.
 * When the package is not installed, all tracing becomes a no-op.
 */

// Type imports are safe - erased at compile time, no runtime dependency
import type { Tracer, Span, SpanKind } from '@opentelemetry/api';

const TRACER_NAME = '@adcp/client';

// Lazy-load the OTel API - null if not installed
let otelApi: typeof import('@opentelemetry/api') | null = null;
let checked = false;

function getOtelApi(): typeof import('@opentelemetry/api') | null {
  if (checked) return otelApi;
  checked = true;
  try {
    otelApi = require('@opentelemetry/api');
  } catch {
    otelApi = null;
  }
  return otelApi;
}

/**
 * Get the OpenTelemetry tracer for @adcp/client.
 * Returns null if @opentelemetry/api is not installed.
 */
export function getTracer(): Tracer | null {
  const api = getOtelApi();
  return api ? api.trace.getTracer(TRACER_NAME) : null;
}

/**
 * Check if OpenTelemetry is available.
 */
export function isTracingEnabled(): boolean {
  return getOtelApi() !== null;
}

/**
 * Inject trace context headers into an outgoing request.
 * Returns empty object if OTel is not available.
 */
export function injectTraceHeaders(): Record<string, string> {
  const api = getOtelApi();
  if (!api) return {};

  const headers: Record<string, string> = {};
  api.propagation.inject(api.context.active(), headers);
  return headers;
}

/**
 * Execute a function within an OpenTelemetry span.
 * If @opentelemetry/api is not installed, executes the function directly (no-op).
 *
 * @param name - Span name (e.g., 'adcp.mcp.call_tool')
 * @param attributes - Span attributes
 * @param fn - Async function to execute within the span
 * @returns The result of fn()
 */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean | undefined>,
  fn: () => Promise<T>
): Promise<T> {
  const api = getOtelApi();
  if (!api) return fn();

  const tracer = api.trace.getTracer(TRACER_NAME);
  const filteredAttrs: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined) {
      filteredAttrs[key] = value;
    }
  }

  return tracer.startActiveSpan(
    name,
    { kind: api.SpanKind.CLIENT, attributes: filteredAttrs },
    async (span: Span) => {
      try {
        const result = await fn();
        span.setStatus({ code: api.SpanStatusCode.OK });
        return result;
      } catch (error) {
        span.setStatus({
          code: api.SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : String(error),
        });
        span.recordException(error as Error);
        throw error;
      } finally {
        span.end();
      }
    }
  );
}

/**
 * Add attributes to the current active span.
 * No-op if OTel is not available or no active span exists.
 */
export function addSpanAttributes(attributes: Record<string, string | number | boolean | undefined>): void {
  const api = getOtelApi();
  if (!api) return;

  const span = api.trace.getActiveSpan();
  if (!span) return;

  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined) {
      span.setAttribute(key, value);
    }
  }
}

/**
 * Record an exception on the current active span.
 * No-op if OTel is not available or no active span exists.
 */
export function recordSpanException(error: Error): void {
  const api = getOtelApi();
  if (!api) return;

  const span = api.trace.getActiveSpan();
  if (!span) return;

  span.recordException(error);
}
