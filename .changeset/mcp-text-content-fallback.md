---
"@adcp/client": patch
---

Fix TaskExecutor.extractResponseData() to retry unwrapping without schema validation when the initial call fails, preventing the raw MCP protocol envelope from leaking through as response data.
