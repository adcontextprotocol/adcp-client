---
"@adcp/sdk": patch
---

The `signed_requests` storyboard's vector dispatch now defaults to `transport: 'mcp'` — wrapping each conformance vector in a `tools/call` envelope re-signed against the agent's actual MCP endpoint — instead of replaying the fixtures' recorded REST-binding targets verbatim, which routed to nonexistent per-task paths and graded every vector as a 404 against MCP-transport agents (adcontextprotocol/adcp#6548). REST-binding agents opt back in with `request_signing.transport: 'raw'`.
