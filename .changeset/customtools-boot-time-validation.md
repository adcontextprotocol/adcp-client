---
"@adcp/sdk": patch
---

fix(server): validate `customTools` collisions at `createAdcpServer` construction time, before MCP server build. Previously the collision check ran after all framework tools were registered; now it fires immediately on `createAdcpServer(opts)` invocation. Tenant-registry adopters (who call `createAdcpServer` per-request for lazy tenant builds) will see the error at factory-call time rather than as an HTTP 500 HTML body on the first buyer MCP request.
