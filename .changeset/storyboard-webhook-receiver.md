---
'@adcp/client': minor
---

Storyboard runner now hosts an ephemeral webhook receiver when `webhook_receiver.enabled` is set on `runStoryboard` / `runStoryboardStep` options. The bound URL is exposed as `$context.webhook_receiver_url` so storyboards can inject it into `push_notification_config.url`.

Adds the `expect_webhook` step validation: waits up to `timeout_ms` (default 5000) for a webhook matching an optional `filter.body` (dotted-path → value) and asserts the received payload carries a non-empty `idempotency_key` — the AdCP 3.0 requirement from #2417.

First slice of adcontextprotocol/adcp#2426. Signature verification (`expect_webhook_signature_valid`) and retry-stability (`expect_webhook_retry_keys_stable`) are follow-ups.
