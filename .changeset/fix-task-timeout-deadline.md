---
'@adcp/sdk': patch
---

Enforce `TaskOptions.timeout` as an absolute wall-clock deadline across discovery, capability preflight, and MCP/A2A tool execution. The SDK now composes the deadline with caller cancellation, aborts in-flight protocol work, surfaces `TaskTimeoutError`, and keeps `workingTimeout` as a separate resettable progress timeout.
