---
'@adcp/sdk': minor
---

Add `@adcp/sdk/webhooks` with `verifyWebhookRequest`, a standalone verifier for legacy HMAC-SHA256 webhook deliveries. The helper verifies exact raw body bytes, normalizes `x-adcp-*` header casing, enforces timestamp skew, uses constant-time comparison, and returns structured failure reasons for receiver endpoints that need diagnostic responses.
