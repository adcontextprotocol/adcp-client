---
"@adcp/client": minor
---

Sync AdCP schemas and implement get_media_buys tool

- Add `get_media_buys` request validation via `GetMediaBuysRequestSchema`
- Add `GetMediaBuysRequest` / `GetMediaBuysResponse` types and Zod schemas (generated)
- Add `getMediaBuys()` method to `Agent` and `AgentCollection`
- Add `get_creative_features` types and agent methods
- Rename `campaign_ref` to `buyer_campaign_ref` across create/update media buy
- Add `max_bid` boolean to CPM/VCPM/CPC/CPCV/CPV pricing options
