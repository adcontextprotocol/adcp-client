---
"@adcp/sdk": patch
---

Preserve the authored create_media_buy brand when the storyboard runner has no
explicit run-brand override. The fixture-aware buyer enricher previously replaced
that brand with test.example even when the account correctly named the fixture's
advertiser, causing strict sellers to refuse an otherwise valid auction buy.
An explicit run-brand option continues to override the request and account together.
