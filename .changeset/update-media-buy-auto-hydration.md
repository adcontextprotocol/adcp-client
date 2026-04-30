---
"@adcp/sdk": minor
---

feat(server): auto-hydrate `patch.mediaBuy` in `updateMediaBuy` from prior `getMediaBuys`/`createMediaBuy`

Extends the auto-hydration mechanism (introduced for `createMediaBuy` in 6.1) to `update_media_buy`. The SDK now attaches the full `MediaBuy` wire object — including `ctx_metadata` — at `patch.mediaBuy` before invoking the publisher's `updateMediaBuy` handler. Keyed by `media_buy_id`; silently no-ops when the store has no record (publisher falls back to its own DB). The `getMediaBuys` store-write already existed; this PR adds the read/hydrate side.
