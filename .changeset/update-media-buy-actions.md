---
'@adcp/sdk': minor
---

Add first-class helpers for decomposing and enforcing `update_media_buy` action requests. `decomposeUpdateMediaBuy()` exposes concrete requested mutations with action, path, scope, package IDs, and best-effort before/after values, while `assertUpdateMediaBuyAllowed()` lets server adopters throw canonical `ACTION_NOT_ALLOWED` errors from per-buy `available_actions[]`.
