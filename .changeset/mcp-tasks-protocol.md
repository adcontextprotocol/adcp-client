---
"@adcp/client": minor
---

Support MCP Tasks protocol for async tool calls

When connected to MCP servers that declare `capabilities.tasks.requests.tools.call`, the client now uses MCP Tasks protocol methods (`tasks/get`, `tasks/result`, `tasks/cancel`, `tasks/list`) instead of custom AdCP tool calls for async lifecycle management. This removes the LLM from the polling path and aligns with the MCP specification (2025-11-25 experimental).

Client-side: `ProtocolClient.callTool()` transparently uses `callToolStream()` when the server supports tasks, falling back to standard `callTool` otherwise. `TaskExecutor.getTaskStatus()` and `listTasks()` use protocol-level methods when available.

Server-side: New helpers for publishers to add MCP Tasks support — `createTaskCapableServer()`, `registerAdcpTaskTool()`, `taskToolResponse()`, plus re-exports of `InMemoryTaskStore`, `TaskStore`, and `isTerminal` from the MCP SDK.
