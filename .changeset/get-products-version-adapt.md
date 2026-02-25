---
"@adcp/client": minor
---

feat: adapt get_products requests for v2 servers

- Add `adaptGetProductsRequestForV2` to convert v3 request fields to v2 equivalents:
  - `brand` (BrandReference) → `brand_manifest` (string URL)
  - `catalog` → `promoted_offerings` (type='offering') or `promoted_offerings.product_selectors` (type='product')
  - v3 channel names mapped to v2 equivalents (olv/ctv → video, streaming_audio → audio, retail_media → retail)
  - Strip v3-only fields: `buying_mode`, `buyer_campaign_ref`, `property_list`, `account_id`, `pagination`
  - Strip v3-only filter fields: `required_features`, `required_axe_integrations`, `required_geo_targeting`, `signal_targeting`, `regions`, `metros`
- Add `normalizeProductChannels` to expand v2 channel names to v3 on response products (video → [olv, ctv], audio → streaming_audio, native → display, retail → retail_media)
- Wire `get_products` into `adaptRequestForServerVersion` switch in `SingleAgentClient`
- Normalize `brand_manifest` and `product_selectors` in `normalizeRequestParams` before Zod validation for backwards compatibility
- Strip v3-only package fields (`optimization_goal`) and top-level fields (`account_id`, `proposal_id`, `total_budget`, `artifact_webhook`, `reporting_webhook`) when adapting `create_media_buy`/`update_media_buy` for v2 servers
