---
'@adcp/sdk': minor
---

Expose every manifest tool through typed AgentClient and SingleAgentClient methods and executeTask request/response maps. Add non-deprecated methods and usable public request/response types for supported creative, content-standards, and rights tools while keeping their Legacy aliases. Typed getTaskStatus({ task_id }) and listTasks({}) overloads query the seller without changing existing string-status and local-task-list APIs. Preserve existing executeCustomTask workarounds for newly typed tools.

Direct SingleAgentClient governance methods use a configured governance agent, or require the client's own agent to advertise the requested governance tool. Generic preview_creative execution follows the canonical preview method; callers requiring raw named-format payloads can use previewCreativeLegacy().
