---
"@adcp/client": patch
---

Fix MCP discovery probe and A2A canonical URL fetch dropping agent.headers

Custom headers (e.g. Basic auth) set on an agent config were forwarded to
callMCPTool correctly but were missing from the initial MCP endpoint discovery
probe and the A2A canonical URL fetch. Both paths now include agent.headers in
the same merge order used by the protocol layer: custom headers first, then
auth_token auth headers on top.
