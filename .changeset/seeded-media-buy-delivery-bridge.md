---
'@adcp/sdk': minor
---

feat(testing): `getSeededMediaBuyDelivery` bridge callback + nit-test coverage on existing bridges (closes #1755 phase 1)

Adds a sixth opt-in callback to `TestControllerBridge<TAccount>` for the `get_media_buy_delivery` read path so platform-proxy sellers can seed delivery-snapshot fixtures into conformance storyboards without driving real measurement through the upstream adapter:

- `getSeededMediaBuyDelivery(ctx)` → appended into `get_media_buy_delivery` response (dedup by `media_buy_id`, **handler wins on collision** — measurement stays authoritative on the handler; the bridge supplements). Same sandbox + resolved-account + controller-present gating as the other bridges. `BridgeFromSessionStoreOptions` gains a matching `selectSeededMediaBuyDelivery` selector.

After the merge, `aggregated_totals` is recomputed from the merged per-delivery `totals` so `media_buy_count` / `impressions` / `spend` reflect the merged set (otherwise the response would be wire-incorrect). Policy:

- **Required sums** (`impressions`, `spend`, `media_buy_count`) always recompute.
- **Optional sums** (`clicks`, `completed_views`, `views`, `conversions`, `conversion_value`) recompute only when every merged delivery populates the field; partial population falls back to the handler's value (no silent under-counting).
- **Derived ratios** (`roas`, `completion_rate`, `cost_per_acquisition`) recompute only when both inputs recomputed AND divisor is non-zero (no `Infinity` / `NaN`).
- **Pass-through** (`reach`, `reach_unit`, `frequency`, `new_to_brand_rate`) keep the handler's value verbatim — not derivable from per-delivery `totals`.

Also adds regression coverage on the bridges that landed in `7.3.0`:

- `getSeededAccountFinancials` now has an explicit assertion that the resolved `ctx.account.account_id` wins over the request's `account.account_id` when both are present (so fixtures are interchangeable across `AccountReference` variants).
- `list_creatives` mixed-collision math has explicit coverage: when handler and bridge overlap partially, `query_summary.total_matching` grows only by the non-colliding subset (`+= newCount`, not `+= seededCount`).
