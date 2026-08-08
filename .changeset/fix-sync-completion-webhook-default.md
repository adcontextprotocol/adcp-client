---
'@adcp/sdk': major
---

Stop emitting completion webhooks for synchronous terminal responses by default, as required by AdCP. Existing adopters can temporarily restore the previous duplicate-delivery behavior with the explicit, non-conformant `autoEmitCompletionWebhooks: true` compatibility option.
