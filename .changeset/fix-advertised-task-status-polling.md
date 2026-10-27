---
'@adcp/sdk': patch
---

Use the advertised `get_task_status` tool for all SDK task polling, including submitted continuations and persisted task tracking. Preserve `tasks_get` (MCP) and `tasks/get` (A2A) for sellers that do not advertise the protocol tool.

Resolve the tool once per polling session and preserve the existing supported-seller request-signing rule for the new polling name on both MCP and A2A.
