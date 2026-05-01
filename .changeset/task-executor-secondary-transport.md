---
"@adcp/sdk": patch
---

`getTaskStatus`, `pollTaskCompletion`, and `continueTaskWithInput` now forward the per-call `transport.maxResponseBytes` cap instead of silently falling back to the constructor-level cap. Callers using `transport.maxResponseBytes` on a `TaskOptions`-shaped argument can now tighten the cap on the polling and resume paths. Also adds a loopback-HTTP integration test that exercises `wrapFetchWithSizeLimit` through `ProtocolClient.callTool` on the MCP non-OAuth path.
