---
"@adcp/client": minor
---

Add OpenTelemetry tracing support for observability

- Added `@opentelemetry/api` as an optional peer dependency
- New `withSpan()` utility wraps async operations in OTel spans
- Instrumented `ProtocolClient.callTool()`, `callMCPTool()`, `callA2ATool()`, and `connectMCPWithFallback()`
- Trace context headers (`traceparent`) automatically injected into tool call requests (excludes discovery endpoints to avoid leaking trace IDs to untrusted servers)
- All tracing is no-op when `@opentelemetry/api` is not installed
- Exported utilities: `getTracer`, `isTracingEnabled`, `injectTraceHeaders`, `withSpan`, `addSpanAttributes`, `recordSpanException`

When consumers use an OTel-compatible observability system (like `@scope3data/observability-js` with `enableOtel: true`), spans from this library automatically appear as children of the consuming application's traces.
