---
"@adcp/client": patch
---

Fix schema validation for MCP responses using `content[0].text` instead of `structuredContent`. ResponseValidator now parses JSON from text content when `structuredContent` is absent. TaskExecutor retries unwrapping without schema validation before falling back to the raw envelope.
