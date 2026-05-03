---
"@adcp/sdk": patch
---

fix(security): extend `transport.maxResponseBytes` cap to OAuth token endpoint and authorization-server metadata discovery. `exchangeClientCredentials` and `discoverOAuthMetadata` now wrap their `fetch` with the same size-limit guard that protects MCP/A2A response paths, closing a buffer-bomb surface where a hostile token endpoint or `.well-known` metadata response could exceed the configured cap. Pass-through when no `withResponseSizeLimit` slot is active. Closes #1175.
