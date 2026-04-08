---
"@adcp/client": patch
---

serve() now creates a shared task store and passes it to the agent factory via ServeContext, fixing MCP Tasks protocol (tasks/get) failures over stateless HTTP where each request previously got its own empty task store.
