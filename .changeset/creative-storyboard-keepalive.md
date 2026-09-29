---
'@adcp/sdk': patch
---

Keep `serve()` connections open while a client validates schemas between MCP calls, avoiding half-closed sockets in multi-step flows.
