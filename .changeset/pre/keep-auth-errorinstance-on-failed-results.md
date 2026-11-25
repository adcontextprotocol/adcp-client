---
'@adcp/sdk': patch
---

Keep the typed authentication error on `result.errorInstance` in two places that dropped it.

- **Failed task results.** A failed task now carries `AuthenticationCredentialsRejectedError` when the agent rejects a configured static credential. It also carries the `AuthenticationRequiredError` an unsigned A2A call raises on HTTP 401. Before, the executor kept only signed-request rejections and validated `NeedsAuthorizationError`, and `errorInstance` was left undefined.
- **Multi-agent collections.** Results from `ADCPMultiAgentClient` collections (`client.allAgents()`/`client.agents([...])`) now carry the `ADCPError` an agent's call threw as `errorInstance`, instead of a message-only failure.

In both places a `NeedsAuthorizationError` is kept only when its MCP OAuth requirements are validated. Seller-supplied fields on these errors, such as `challenge` and `oauthMetadata`, are untrusted.
