---
"@adcp/sdk": patch
---

fix(client): `getAgentInfo()` retries on StreamableHTTP 400 session errors (FastMCP compatibility)

`AdCPClient.getAgentInfo()` now recovers from 400 "Missing session ID" responses
returned by FastMCP and other stateful StreamableHTTP servers. When `listTools()`
fails with `StreamableHTTPError`, the client re-initializes with a fresh connection
and retries once — matching the session-retry logic already present in the
standard `callMCPTool` path via `withCachedConnection`.

Also:
- `getAgentInfo()` now propagates `customHeaders` and `debugLogs` into the
  underlying `connectMCP()` call (previously silently dropped)
- `connectMCP()` now calls `trackStreamableHTTPUrl()` on a successful connection
  so subsequent `callMCPTool` calls for the same URL skip the SSE fallback probe
- New `mcp_transport?: 'streamable_http' | 'sse'` field on `AgentConfig` for
  future caller-side transport hints (matches the `mcp_transport` registry field
  from adcp#3066 Option B); active wiring in the `callMCPTool` path is a follow-up
