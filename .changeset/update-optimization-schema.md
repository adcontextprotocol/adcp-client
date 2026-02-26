---
"@adcp/client": major
---

Sync upstream schema changes (breaking):

- `OptimizationGoal` redesigned as discriminated union with `metric` (seller-tracked delivery metrics: clicks, views, etc.) and `event` (advertiser-tracked conversions with multiple event sources) kinds; both support `target` and `priority`
- `Package.optimization_goal` renamed to `optimization_goals` (array)
- `supported_optimization_strategies` enum updated: `maximize_conversions|target_cpa|target_roas` → `target_cost_per|target_threshold_rate|target_per_ad_spend`
- `account_id?: string` replaced by `account: AccountReference` (required) on `CreateMediaBuyRequest`, `GetMediaBuysRequest`, `SyncCreativesRequest`, `SyncEventSourcesRequest`, `SyncAudiencesRequest`, `SyncCatalogsRequest`, and `GetAccountFinancialsRequest`; `AccountReference` is a `oneOf` supporting `{ account_id }` or `{ brand, operator }` natural key. `GetProductsRequest` gains an optional `account?: AccountReference` field.
- `Account.house` and `Account.brand_id` removed; replaced by `Account.brand?: BrandReference`
- `billing` enum: `'brand'` value removed
- `MediaBuy.campaign_ref` renamed to `buyer_campaign_ref`

New additions:

- `get_account_financials` tool with request/response types
- `BrandID`, `BrandReference`, `AccountReference` types
