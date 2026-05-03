---
"@adcp/sdk": patch
---

fix(mcp): restore SSE fallback for loopback/private-address MCP servers

The 6.7.0 `isPrivateAddress` gate assumed all private/loopback servers support
StreamableHTTP and skipped SSE fallback for them. This broke discovery against
locally-running SSE-only servers (e.g. training-agent endpoints at 127.0.0.1).
The `knownStreamableHTTPUrls` guard already handles the "we know this URL speaks
StreamableHTTP" case correctly; the address-based gate is removed.
