---
'@adcp/sdk': patch
---

Persist buy and package creation context in `createMediaBuyStore` and backfill missing resource context on `get_media_buys`. Preserve opaque null values, empty objects and creation context through targeting updates without replacing seller echoes or the read request's context.
