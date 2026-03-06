---
"@adcp/client": patch
---

fix: add SSE transport fallback to MCP endpoint discovery

discoverMCPEndpoint() was only probing candidate URLs with StreamableHTTPClientTransport. Agents that exclusively support the older SSE transport were rejected at the discovery gate, even though callMCPTool() would have handled them correctly. The testEndpoint() helper now mirrors the StreamableHTTP → SSE fallback already present in the tool-call path, so SSE-only agents pass discovery and reach the tool call successfully.
