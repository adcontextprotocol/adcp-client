---
"@adcp/sdk": patch
---

In `mcp` transport mode, the `signed_requests` grader now auto-initializes an MCP session via the `initialize` handshake before dispatching conformance vectors. The `Mcp-Session-Id` response header is attached to each subsequent probe request *after* signing — `Mcp-Session-Id` is not a covered component per RFC 9421, so signatures remain valid. Negative vectors still reach the verifier before MCP session dispatch (the signature check fires at the HTTP middleware layer, ahead of session routing). A new `initializeMcpSession` helper is exported from `@adcp/sdk/testing/storyboard/request-signing` for callers that pre-initialize once and reuse the session ID across many vectors. The `GradeOptions.mcpSessionId` / `StoryboardRunOptions.request_signing.mcpSessionId` field lets callers pass a pre-acquired session ID to avoid per-vector round-trips; pass `''` to opt out of auto-initialization for stateless streamable-HTTP agents.
