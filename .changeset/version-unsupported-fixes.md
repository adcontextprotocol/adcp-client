---
'@adcp/client': patch
---

Preserve `adcp_major_version` through per-tool field filtering and handle synchronous error responses from MCP Tasks servers. Version-negotiation probes (e.g. intentionally unsupported major versions) now reach sellers intact, and `VERSION_UNSUPPORTED` errors returned synchronously by MCP servers are surfaced to callers rather than being masked by a Tasks SDK validation error.
