---
"@adcp/sdk": patch
---

Add dev-mode warning when getMediaBuyDelivery / getMediaBuys returns fewer rows than requested media_buy_ids. Fires in NODE_ENV=test|development only; silent in production and when NODE_ENV is unset. Suppressible via ADCP_DECISIONING_ALLOW_MULTI_ID_TRUNCATION=1. Catches the truncate-to-media_buy_ids[0] footgun at adapter-development time (#1399, follow-up to #1342).
