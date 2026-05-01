---
"@adcp/sdk": patch
---

fix(client): getAgentInfo() now uses SSE fallback for SSE-only MCP servers

Previously, `SingleAgentClient.getAgentInfo()` called `connectMCP()` directly,
which is StreamableHTTP-only. Every other production path (`callMCPTool`,
`mcp-tasks.ts`) goes through `connectMCPWithFallback`, which retries
StreamableHTTP on session errors and falls back to SSE for non-401 failures.

The asymmetry caused `getAgentInfo()` to fail for SSE-only servers (e.g.
FastMCP/Python) even when `discoverMCPEndpoint` succeeded via SSE at the same
URL. `getAgentInfo()` now routes through `connectMCPWithFallback`, matching
every other MCP code path. `connectMCPWithFallback` gains an optional
`authProvider` parameter so OAuth-issued tokens work through the fallback path
alongside static bearer tokens.
