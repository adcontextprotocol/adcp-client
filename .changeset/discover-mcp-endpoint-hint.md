---
"@adcp/sdk": patch
---

fix(client): discovery error message hints at wrong-path registration

`SingleAgentClient.discoverMCPEndpoint`'s generic "Failed to discover MCP endpoint" error now includes a hint that the most common cause is `agent_uri` pointing at the host root when the MCP endpoint lives at a non-standard path. The SDK only auto-probes `/`, `/mcp`, and `/mcp/`; servers exposing MCP at `/api/mcp`, `/v1/mcp`, or similar custom paths need that exact path registered as `agent_uri`.

No behavior change — operators get a more actionable error. Helps downstream tools (dashboard probes, registration flows) surface the actual issue instead of "agent offline".

Closes #1234.
