---
'@adcp/client': minor
---

Expose `wrapEnvelope` from `@adcp/client/server` — a public helper for attaching AdCP envelope fields (`replayed`, `context`, `operation_id`) to handler responses, with error-code-specific field allowlists (e.g., IDEMPOTENCY_CONFLICT drops `replayed`). Promoted for sellers that wire their own MCP / A2A handlers without the framework.

Parity with the framework's internal `injectContextIntoResponse`: `opts.context` is NOT attached when the inner payload already carries a `context` the handler placed itself (handler wins). The per-error-code allowlist now lists `context` explicitly rather than short-circuiting — a module-load invariant asserts every allowlist entry includes `context` so future error codes can't silently drop correlation echo. Return type widened to surface the envelope fields (`replayed?`, `context?`, `operation_id?`) for caller autocomplete.
