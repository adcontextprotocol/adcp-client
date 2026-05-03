---
"@adcp/sdk": minor
---

Export canonical MediaBuy and Creative status transition helpers from `@adcp/sdk/server`: `MEDIA_BUY_TRANSITIONS`, `CREATIVE_ASSET_TRANSITIONS`, `isLegalMediaBuyTransition`, `assertMediaBuyTransition`, `isLegalCreativeTransition`, `assertCreativeTransition`. The canonical graphs are now the single source of truth for both the conformance runner's `status.monotonic` invariant and seller adapter transition enforcement, eliminating copy-paste drift across adopter codebases.
