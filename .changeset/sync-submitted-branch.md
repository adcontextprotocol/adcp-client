---
'@adcp/client': minor
---

Regenerated types from latest AdCP schemas.

- `CreateMediaBuyResponse` union gains `CreateMediaBuySubmitted` — async task envelope with `status: 'submitted'` and `task_id`, returned when a media buy cannot be confirmed synchronously (IO signing, governance review, batched processing). The `media_buy_id` and `packages` land on the completion artifact, not this envelope.
- `PushNotificationConfig.authentication` is now optional and deprecated. Omitting it opts in to the RFC 9421 webhook profile (the default in 4.0); Bearer and HMAC-SHA256 remain for legacy compatibility only.
- `RightUse` adds `ai_generated_image`.

Consumers of `CreateMediaBuyResponse` that exhaustively discriminate on the union must handle the new `'submitted'` branch.
