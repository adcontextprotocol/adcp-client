---
'@adcp/client': minor
---

Expose `wrapEnvelope` from `@adcp/client/server` — a public helper for attaching AdCP envelope fields (`replayed`, `context`, `operation_id`) to handler responses, with error-code-specific field allowlists (e.g., IDEMPOTENCY_CONFLICT drops `replayed`). Previously internal to `createAdcpServer`; promoted for sellers that wire their own MCP / A2A handlers without the framework.
