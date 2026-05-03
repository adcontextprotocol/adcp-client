---
'@adcp/sdk': patch
---

feat(server): dev-mode warning when `getMediaBuyDelivery` / `getMediaBuys` returns fewer rows than the buyer requested. Catches the canonical `media_buy_ids[0]`-truncation bug class at adapter-development time. Quiet in production (where legitimate misses are routine) and suppressible via `ADCP_SUPPRESS_MULTI_ID_WARN=1` for adopters whose legitimate-miss rate is high. Closes #1399.
