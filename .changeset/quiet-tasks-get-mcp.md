---
'@adcp/sdk': patch
---

Avoid advertising the slash-based `tasks/get` compatibility alias as an MCP tool and poll MCP agents through the `tasks_get` alias. A2A callers and agent cards keep the spec `tasks/get` skill; the A2A adapter maps it to the server's `tasks_get` handler at lookup time.
