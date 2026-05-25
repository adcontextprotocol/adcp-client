---
'@adcp/sdk': patch
---

Normalize legacy media-buy lifecycle status responses during validation and storyboard capture, and export `getAuthoritativeMediaBuyStatus` / `isMediaBuyStatus` helpers for reading authoritative media-buy status from mixed-version payloads. The normalized return shape preserves seller-provided legacy `status` values while adding canonical `media_buy_status` where the lifecycle status is unambiguous.
