---
"@adcp/client": patch
---

Fix: retry StreamableHTTP on session errors instead of falling back to SSE. When a server returns 404 "Session not found", the client now retries with a fresh StreamableHTTP connection rather than incorrectly falling back to SSE transport.
