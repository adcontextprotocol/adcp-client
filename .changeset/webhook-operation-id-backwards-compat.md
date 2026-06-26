---
"@adcp/sdk": patch
---

Fix webhook receiver rejecting AdCP 3.0 envelopes that omit `operation_id`. `operation_id` became a required webhook field in AdCP 3.1, but `verifyAndParseWebhook` enforced it against all senders, breaking backwards compatibility with spec-compliant 3.0 servers. It is no longer part of the hard-required MCP webhook envelope set; when absent, the receiver falls back to the routing-context `operationId` as before.
