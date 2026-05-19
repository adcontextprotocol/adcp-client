---
"@adcp/sdk": patch
---

`connectMCP` now throws a typed `McpAuthRejectedError` (code `MCP_AUTH_REJECTED`) instead of a raw MCP SDK error when the server returns an HTTP 401. The error carries a `scheme` property (`'oauth' | 'bearer' | 'header' | 'none'`) identifying which credential the SDK sent, so the caller can immediately diff against their config without tracing the SDK internals.
