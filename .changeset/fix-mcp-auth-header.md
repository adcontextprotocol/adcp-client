---
"@adcp/client": patch
---

Fix MCP authentication bug where x-adcp-auth header was not being sent to servers. The client now properly includes authentication headers in all MCP requests using the SDK's requestInit.headers option instead of a custom fetch function. This fixes authentication failures with MCP servers that require the x-adcp-auth header.
