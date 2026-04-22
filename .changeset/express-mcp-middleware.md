---
'@adcp/client': minor
---

Add `@adcp/client/express-mcp` middleware that rewrites JSON-only `Accept` headers so they pass the MCP SDK's `StreamableHTTPServerTransport` check when `enableJsonResponse: true`. Local escape hatch pending upstream SDK fix (https://github.com/modelcontextprotocol/typescript-sdk/issues/1944).
