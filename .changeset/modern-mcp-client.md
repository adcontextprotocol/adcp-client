---
'@adcp/sdk': major
---

Add MCP 2026-07-28 client negotiation and dual-era HTTP serving through the official v2 SDK while retaining the v1 path for legacy peers and 2025 Tasks compatibility. High-level endpoint discovery, tool listing, and OAuth calls now negotiate the modern era; modern requests reject cross-origin redirects, do not replay failed tool calls, and fail closed on malformed JSON. Host/Origin validation now protects framework-owned AdCP servers before era classification, so it applies to legacy and modern traffic: public deployments must configure `publicUrl` or explicit `allowedHosts`/`allowedOrigins`, including an upstream hostname when a reverse proxy rewrites `Host`. Raw v1 `McpServer` instances remain legacy-only so resources, prompts, and Tasks extras are preserved. Raise the minimum supported Node.js version to 20, as required by MCP SDK v2.
