/**
 * Observability utilities for @adcp/client
 *
 * Provides OpenTelemetry tracing integration. All functions gracefully
 * handle the case where @opentelemetry/api is not installed.
 */

export {
  getTracer,
  isTracingEnabled,
  injectTraceHeaders,
  withSpan,
  addSpanAttributes,
  recordSpanException,
} from './tracing';
