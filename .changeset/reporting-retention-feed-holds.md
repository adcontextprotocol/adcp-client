---
'@adcp/sdk': minor
---

Reporting retention now holds for unread change-feed consumers. `retireExpiredPeriods` skips a period while any live registered feed consumer (cursor saved within `maxFeedHoldDays`, default 7, new input option) has not passed that period's change rows, using the same per-consumer feed order as `pruneChanges`. A silent consumer stops holding after `maxFeedHoldDays`, so retention is never blocked forever. The production service passes `changeFeed.maxFeedHoldDays` through to retention. The BigQuery warehouse sink's `runOnce()` now returns `missing: string[]`: revision IDs the feed announced that were retired before the batch ran (the sink fell behind retention); previously they were dropped silently. The cursor still advances. Alert on a non-empty `missing`.
