---
"@adcp/client": patch
---

Fix webhook HMAC signature verification to use raw HTTP body bytes instead of re-serialized JSON. `verifyWebhookSignature()` now accepts a raw body string (preferred) or parsed object (backward compat). This fixes cross-language interop where different JSON serializers produce different byte representations.
