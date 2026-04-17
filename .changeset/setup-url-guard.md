---
'@adcp/client': patch
---

Response builders now throw a descriptive error when `setup` is placed at the top level of a media buy response. The IO-signing setup URL belongs inside `account.setup` (a field on `Account`), not on the media buy itself. This was a silent trap because `DomainHandler` accepts `Record<string, unknown>` so the strict type wasn't catching it. Affects `mediaBuyResponse`, `updateMediaBuyResponse`, and `getMediaBuysResponse`.
