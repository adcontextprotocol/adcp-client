---
'@adcp/client': minor
---

Support HTTP Basic auth in testing SDK and fix MCP SSE fallback auth forwarding

- `TestOptions.auth.type` now accepts `'basic'` in addition to `'bearer'`
- Basic auth routes the pre-encoded token to `agentConfig.headers` as `Authorization: Basic <token>` instead of `agentConfig.auth_token`, preventing the library from double-wrapping it as Bearer
- MCP SSE transport fallback now forwards the `Authorization` header via `?auth=` URL param (same workaround already used for `auth_token`), so Basic auth works on agents that only support the older SSE transport
- Header name lookup for SSE fallback is now case-insensitive
- A2A debug log now redacts the `Authorization` header value regardless of whether `auth_token` is set (previously only redacted when `auth_token` was present)
