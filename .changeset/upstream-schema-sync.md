---
"@adcp/client": minor
---

Sync upstream AdCP v3 schema changes

**Breaking changes:**

- `PackageRequest.optimization_goal` (scalar) renamed to `optimization_goals` (array). The seller now optimizes toward goals in priority order. Update all `create_media_buy` callers to pass an array inside each package.
- `PackageRequest.catalog` (scalar) renamed to `catalogs` (array). Each catalog should have a distinct type. The v2 downgrade adapter uses `catalogs[0]`; multi-catalog support requires v3 servers.
- `Measurement` type renamed to `OutcomeMeasurement` on `Product.outcome_measurement`.
- `SyncAccountsRequest` restructured: `house` account type removed; `brand` and `operator` (both required) replace the old free-form structure; billing enum values changed.
- `SyncAccountsResponse`: `account_id` removed; `parent_account_id` replaced by `account_scope` enum.
- `ActivateSignalRequest`: `deployments` renamed to `destinations`; new optional `action: 'activate' | 'deactivate'` field added (defaults to `'activate'`).
- `GetProductsRequest`: `feedback`, `product_ids`, and `proposal_id` fields removed; `refine` buying mode added.
- `AudienceMember.external_id` is now a required field (was absent). All `sync_audiences` callers must supply a stable buyer-assigned ID per member.
- `'external_id'` removed from `UIDType` union. Use the top-level `AudienceMember.external_id` field instead.
- `FrequencyCap.suppress_minutes` is now optional (was required). The type now supports two independent capping modes: recency gate (`suppress_minutes`) and volumetric cap (`max_impressions` + `per` + `window`). At least one must be set.
- `MediaBuyStatus` now includes `'rejected'` as a terminal state.

**New features:**

- `reach` added as an `OptimizationGoal` kind with `reach_unit` and `target_frequency` fields
- Keyword targeting via `TargetingOverlay.keyword_targets` and `negative_keywords` (search/retail media)
- Keyword management on `UpdateMediaBuyRequest`: `keyword_targets_add/remove`, `negative_keywords_add/remove`
- `by_keyword` delivery breakdown in `GetMediaBuyDeliveryResponse`
- Signal pricing restructured into typed `CpmPricing | PercentOfMediaPricing | FlatFeePricing` models
- `GetSignalsRequest` updated: `deliver_to` replaced by top-level `destinations?` and `countries?`
- `ActivateSignalRequest` gains `account_id` and `buyer_campaign_ref`
- `SignalFilters.max_percent` for filtering percent-of-media signals
- `buying_mode: 'refine'` for iterative product selection workflows
- `supports_keyword_breakdown` added to `ReportingCapabilities`
- Keyword targeting capability flags (`keyword_targets`, `negative_keywords`) in `GetAdCPCapabilitiesResponse`
- New exports: `OptimizationGoal`, `ReachUnit`, `TargetingOverlay`, `OutcomeMeasurement`, `SignalPricingOption`, `SignalPricing`, `CpmPricing`, `PercentOfMediaPricing`, `FlatFeePricing`
- New exports: `CreativeBrief`, `CreativeManifest`, `BuildCreativeRequest`, `BuildCreativeResponse`, `PreviewCreativeRequest`, `PreviewCreativeResponse`, `GetMediaBuysRequest`, `GetMediaBuysResponse`
- New exports: `ImageAsset`, `VideoAsset`, `AudioAsset`, `TextAsset`, `URLAsset`, `HTMLAsset`, `BriefAsset`, `ReferenceAsset`, `EventCustomData`
- New exports: `Duration`, `DeviceType`, `DigitalSourceType`, `FrequencyCap`, `GeographicBreakdownSupport`
- New exports: `StandardErrorCode`, `ErrorRecovery`, `TaskErrorDetail`, `STANDARD_ERROR_CODES`, `isStandardErrorCode`, `getErrorRecovery` — standard error code vocabulary for programmatic agent recovery

**Migration guide: account_id → AccountReference**

All account-scoped tools now use `account: AccountReference` (a typed discriminated union) instead of the bare `account_id: string`. The `AccountReference` type is exported from `@adcp/client`.

```typescript
// Before
{ account_id: 'acct_123', media_buy_ids: [...] }

// After
{ account: { account_id: 'acct_123' }, media_buy_ids: [...] }
```

`AccountReference` is a union: `{ account_id: string } | { brand: BrandReference; operator: string }`. Use `account_id` after receiving a seller-assigned ID from `sync_accounts` or `list_accounts`.

**Automatic backward-compat conversions:**

The client library auto-converts these deprecated fields with a one-time console warning:

| Legacy field | Converted to | Scope |
|---|---|---|
| `account_id: string` | `account: { account_id }` | All tools |
| `campaign_ref` | `buyer_campaign_ref` | All tools |
| `deployments` | `destinations` | activate_signal |
| `deliver_to` | `destinations` | get_signals |
| `PackageRequest.optimization_goal` | `optimization_goals: [goal]` | create/update_media_buy packages |
| `PackageRequest.catalog` | `catalogs: [catalog]` | create/update_media_buy packages |

Additionally, the following conversions from earlier releases continue to apply:

| Legacy field | Converted to | Scope |
|---|---|---|
| `brand_manifest` (string or object) | `brand: { domain }` | get_products, create_media_buy |
| `product_selectors` | `catalog` | get_products |

These shims ease migration but will be removed in a future major version. Update your code to use the new field names.
