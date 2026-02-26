---
"@adcp/client": major
---

Sync upstream schema changes (breaking):

- `OptimizationGoal` redesigned as discriminated union with `metric` (seller-tracked delivery metrics: clicks, views, etc.) and `event` (advertiser-tracked conversions with multiple event sources) kinds; both support `target` and `priority`
- `Package.optimization_goal` renamed to `optimization_goals` (array)
- `Product.conversion_tracking.supported_optimization_strategies` renamed to `supported_targets` with updated values: `target_cost_per|target_threshold_rate|target_per_ad_spend` → `cost_per|per_ad_spend|maximize_value`
- `account_id?: string` replaced by `account: AccountReference` (required) on `CreateMediaBuyRequest`, `GetMediaBuysRequest`, `SyncCreativesRequest`, `SyncEventSourcesRequest`, `SyncAudiencesRequest`, `SyncCatalogsRequest`, and `GetAccountFinancialsRequest`; `AccountReference` is a `oneOf` supporting `{ account_id }` or `{ brand, operator }` natural key. `GetProductsRequest` gains an optional `account?: AccountReference` field.
- `Account.house` and `Account.brand_id` removed; replaced by `Account.brand?: BrandReference`
- `billing` enum: `'brand'` value removed
- `MediaBuy.campaign_ref` renamed to `buyer_campaign_ref`
- `Signal.pricing` replaced by `Signal.pricing_options: PricingOption[]`
- `LogEventRequest` usage records: `operator_id` field removed; `pricing_option_id` field added for billing verification; `kind` field removed
- `PostalCodeSystem`: added `ch_plz` (Swiss) and `at_plz` (Austrian) postal code systems

New additions:

- `OptimizationGoal` metric kind: added `engagements`, `follows`, `saves`, `profile_visits` metrics and optional `view_duration_seconds` for `completed_views` threshold
- `OptimizationGoal` event kind: added `maximize_value` target kind
- `Product.metric_optimization` capability object (`supported_metrics`, `supported_view_durations`, `supported_targets`)
- `Product.max_optimization_goals` field
- `DeliveryMetrics`: added `engagements`, `follows`, `saves`, `profile_visits` fields
- `GetAdCPCapabilitiesResponse.conversion_tracking.multi_source_event_dedup` capability flag
- `get_account_financials` tool with request/response types
- `BrandID`, `BrandReference`, `AccountReference` types
