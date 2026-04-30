---
'@adcp/sdk': minor
---

Extend auto-hydration to `update_media_buy`, `activate_signal`, and `acquire_rights`.

**New hydration sites (requires `ctxMetadata` store to be wired):**
- `update_media_buy`: `patch.media_buy` populated from the store after a prior `createMediaBuy` (sync arm) or `getMediaBuys` call. Publisher reads `patch.media_buy.ctx_metadata?.gam_order_id` directly.
- `activate_signal`: `req.signal` populated from the store after a prior `getSignals` call, keyed by `signal_agent_segment_id`.
- `acquire_rights`: `req.brand` populated from the store after a prior `getBrandIdentity` call, keyed by `buyer.brand_id`.

**Store additions:**
- `getSignals` now auto-stores each returned signal (kind `signal`, id `signal_agent_segment_id`).
- `getBrandIdentity` now auto-stores the returned brand identity (kind `brand`, id `brand_id`).
- `createMediaBuy` (sync arm) now auto-stores the created media_buy so `updateMediaBuy` can hydrate it without a prior `getMediaBuys` call.

**`ResourceKind` updated:** added `'brand'` to the closed enum.

**`provide_performance_feedback` intentionally excluded:** this tool carries no `account` field; the ctx-metadata store (scoped per account) cannot be used. See `skills/build-decisioning-platform/SKILL.md` § SDK auto-hydration contract for the documented rationale.

**All hydration is graceful-fallback:** when the SDK has no stored record, the field is `undefined` — the publisher falls back to its own DB. No exception thrown.
