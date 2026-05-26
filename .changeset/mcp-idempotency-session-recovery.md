---
'@adcp/sdk': patch
---

Fix idempotency storyboard grading for MCP sellers by keeping missing-field vectors on the initialized SDK transport, and allow standard `recovery` metadata on `IDEMPOTENCY_CONFLICT` error envelopes.
