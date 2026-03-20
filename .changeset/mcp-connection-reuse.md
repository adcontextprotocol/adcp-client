---
"@adcp/client": patch
---

Fix MCP connection exhaustion during comply/test runs by reusing cached connections instead of creating a new TCP connection per tool call. Adds auth-aware cache keying, LRU eviction, and transport-error-only retry logic.
