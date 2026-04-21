---
'@adcp/client': patch
---

Extract the protocol transport-suffix regex (`/mcp`, `/a2a`, `/sse`) to a single source in `utils/a2a-discovery` and share it between `SingleAgentClient.computeBaseUrl` and the storyboard `canonicalizeAgentUrlForScope`. Adding a new transport now only requires updating one regex. Closes #719.
