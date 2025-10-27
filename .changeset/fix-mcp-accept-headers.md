---
"@adcp/client": patch
---

Fix MCP endpoint discovery Accept header handling and send both auth headers

The `discoverMCPEndpoint()` and `getAgentInfo()` methods had issues with header handling:

1. **Lost Accept headers**: Didn't preserve the MCP SDK's required `Accept: application/json, text/event-stream` header
2. **Missing Authorization header**: Only sent `x-adcp-auth` but some servers expect both headers

Changes:
- Updated `discoverMCPEndpoint()` to use the same header-preserving pattern as `callMCPTool()`
- Updated `getAgentInfo()` to properly handle Headers objects without losing SDK defaults
- Both methods now correctly extract and merge headers from Headers objects, arrays, and plain objects
- Now sends **both** `Authorization: Bearer <token>` and `x-adcp-auth: <token>` for maximum compatibility
- Added TypeScript type annotations for Headers.forEach callbacks

Impact:
- MCP endpoint discovery now works correctly with FastMCP SSE servers
- Authentication works with servers expecting either `Authorization` or `x-adcp-auth` headers
- Accept headers are properly preserved (fixes "406 Not Acceptable" errors)
