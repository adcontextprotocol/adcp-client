---
'@adcp/sdk': patch
---

Use the advertised `get_task_status` tool for all SDK task polling, including submitted continuations and persisted task tracking. Preserve `tasks_get` (MCP) and `tasks/get` (A2A) for sellers that do not advertise the protocol tool.
