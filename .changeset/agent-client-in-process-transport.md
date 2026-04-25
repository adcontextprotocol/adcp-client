---
'@adcp/client': minor
---

feat(AgentClient): add `AgentClient.fromMCPClient()` factory for in-process MCP transport

Adds a new static factory method that accepts a pre-connected `@modelcontextprotocol/sdk` `Client` instance instead of a URL-based agent config. This enables compliance test fleets to wire up a full `AgentClient` against an `InMemoryTransport` pair without an HTTP loopback server.

**MCP only.** This factory wraps an MCP `Client` from `@modelcontextprotocol/sdk`. There is no equivalent in-process bridge for A2A today — for A2A agents, run them on a loopback HTTP server and use the standard `AgentClient` constructor with the agent's `agent_uri`.

Key behaviors preserved over the in-process path:
- `adcp_major_version` is injected on every tool call
- `idempotency_key` is auto-generated for mutating tasks
- `isError` envelopes surface as `TaskResult<{ success: false }>`
- HTTP-only methods (`resolveCanonicalUrl`, `getWebhookUrl`, `registerWebhook`, `unregisterWebhook`) throw descriptive `in-process` guard errors
- Endpoint discovery and SSRF validation are bypassed for the sentinel URI

Exports the new `InProcessAgentClientConfig` type for typed factory usage.
