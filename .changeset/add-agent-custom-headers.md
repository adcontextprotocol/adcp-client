---
'@adcp/client': minor
---

Add `headers` field to `AgentConfig` for per-agent custom HTTP headers

Enables sending additional HTTP headers (API keys, org IDs, etc.) alongside the standard bearer token on every request to a specific agent. Auth headers always take precedence over custom headers.
