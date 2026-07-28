---
'@adcp/sdk': patch
---

Treat ERA_NEGOTIATION_FAILED as a legacy-era signal in probeModernMCPConnection, attemptModernCall, and tryListModernMCPTools. Servers that respond to the server/discover probe with a malformed envelope (e.g. id: null) now fall back to the v1 transport path instead of surfacing "None responded to MCP protocol."
