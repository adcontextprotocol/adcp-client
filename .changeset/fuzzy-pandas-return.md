---
'@adcp/sdk': minor
---

Allow `create_media_buy` server handlers to return the protocol's structured multi-error payload arm without unsafe casts.

BREAKING NOTE: Code that reads success-only fields from `CreateMediaBuyPayload` must first narrow out the `errors` arm.
