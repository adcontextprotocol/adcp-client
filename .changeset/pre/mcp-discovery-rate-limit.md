---
'@adcp/sdk': patch
---

Report rate limiting during MCP endpoint discovery instead of a wrong-path error. When a probe answers HTTP 429, or 503 with `Retry-After`, discovery stops at that URL and throws the new `AgentRateLimitedError` (`code: 'RATE_LIMITED'`) with the status, the probed URL, and `retryAfter` / `retryAfterMs` when the agent sent a well-formed `Retry-After`. It no longer probes the remaining candidate URLs, which only spent more of the seller's request budget, and no longer adds the "agent_uri does not include the MCP endpoint path" hint. Other discovery failures, 401 handling, and successful discovery are unchanged.
