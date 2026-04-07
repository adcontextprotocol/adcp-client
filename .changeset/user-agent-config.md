---
"@adcp/client": minor
---

Add `userAgent` config to `PropertyCrawlerConfig` and `TestOptions`, threaded through to all outbound HTTP requests via both MCP and A2A transports. Wire the existing but unused `SingleAgentClientConfig.userAgent` field into protocol headers. Export `PropertyCrawlerConfig` type from public API.
