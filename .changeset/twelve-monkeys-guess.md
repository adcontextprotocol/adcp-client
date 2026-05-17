---
'@adcp/sdk': patch
---

fix(client): `SingleAgentClient.getAgentInfo()` now wraps `mcpClient.listTools()` and A2A `fromCardUrl` in `withResponseSizeLimit`

Prior to this fix, `getAgentInfo()` opened `transport.maxResponseBytes` dormant on the discovery path: the MCP `tools/list` body and the A2A `/.well-known/agent.json` fetch bypassed the ALS slot, so a hostile vendor could return arbitrarily large discovery payloads against a size-capped client. The cap now extends to:

- `mcpClient.listTools()` calls (both in-process and out-of-process paths) — wrapped in `withResponseSizeLimit` so the existing `connectMCP` size-limiter sees the active slot.
- `A2AClient.fromCardUrl` + the deferred `agentCardPromise` read — wrapped in `withResponseSizeLimit`. The auth-stamping fetchImpl is now composed through `wrapFetchWithSizeLimit` so the slot fires on the actual card fetch.

Regression test at `test/unit/get-agent-info-size-limit.test.js` aborts an oversized A2A card discovery with `ResponseTooLargeError`. Closes #1799.
