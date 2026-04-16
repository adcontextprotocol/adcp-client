---
"@adcp/client": major
---

BREAKING: TaskResult is now a discriminated union. Failed tasks use status:'failed' instead of 'completed'. MCP isError responses preserve structured data (adcp_error, context, ext) instead of throwing. Adds adcpError, correlationId, retryAfterMs convenience accessors and isRetryable()/getRetryDelay() utilities.
