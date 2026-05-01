---
"@adcp/sdk": patch
---

fix(client): getAgentInfo() now uses the same StreamableHTTP-then-SSE fallback as every other code path

`SingleAgentClient.getAgentInfo()` previously routed its post-discovery `listTools` connection through `connectMCP`, which has no retry on `StreamableHTTPError` and no SSE fallback. Every other production path (`callMCPTool`, `mcp-tasks`) goes through `connectMCPWithFallback`, which retries once on transient session errors and falls back to `SSEClientTransport` for non-401 failures.

The asymmetry surfaced as `getAgentInfo()` failing on flaky StreamableHTTP servers where the comply suite kept working. After this change, both code paths behave identically.

- Extends `connectMCPWithFallback` with an optional `authProvider` parameter, forwarded to both StreamableHTTP and SSE transports so OAuth-protected agents still work through the fallback.
- Rewires `getAgentInfo()` to use `connectMCPWithFallback` for both bearer-token and saved-OAuth-token cases.
- `discoverMCPEndpoint`'s "Failed to discover MCP endpoint" error now includes a hint that the most common cause is `agent_uri` pointing at the host root when the MCP endpoint lives at a non-standard path (e.g. `/api/mcp`, `/adcp/mcp`).

Closes #1233, #1234.
