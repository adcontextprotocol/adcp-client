# Specialism: sales-broadcast-tv

Companion to [`../SKILL.md`](../SKILL.md). The SKILL.md baseline applies; this file covers only the deltas for `sales-broadcast-tv`.

**Fork target**: [`examples/hello_seller_adapter_guaranteed.ts`](../../../examples/hello_seller_adapter_guaranteed.ts) — broadcast linear inventory is guaranteed by definition (spots are reserved against demo'd ratings). Inherit the IO-task envelope, three `create_media_buy` return shapes, and `targeting_overlay` echo pattern from [`sales-guaranteed.md`](sales-guaranteed.md). Replace the `// SWAP:` markers with calls to your traffic / ratings stack and apply the broadcast deltas below.

Storyboard: `media_buy_broadcast_seller`. See [SHAPE-GOTCHAS.md](../../SHAPE-GOTCHAS.md) for response-shape pitfalls.

## What's different from `sales-guaranteed`

Five protocol surfaces digital sellers don't use: GRP-based forecasting, DMA + daypart targeting overlays, agency estimate numbers, per-package measurement terms, and Ad-ID validation on creatives.

## Forecast surface — `'reach_freq'` or `'package'`

Broadcast plans aren't quoted in spend curves:

- **`reach_freq`** — unique reach + frequency at a planned weight. Each `Product.forecast.points[i].metrics` includes `reach_unique`, `frequency_avg`, `grps`, `spend`. Use when the buyer is exploring weight levels.
- **`package`** — fully-priced spot bundle. Add `metrics.package: { spots, dayparts }` per point.

See [Delivery Forecasts § CTV with GRP Demographics](https://adcontextprotocol.org/docs/media-buy/product-discovery/media-products#ctv-with-grp-demographics) for the worked example (it covers GRP-based linear too).

## DMA + daypart targeting

DMA codes (Designated Market Areas) ride on `targeting_overlay.geo`; daypart codes (`early_morning`, `daytime`, `prime_access`, `prime`, `late_news`, `overnight`) ride on `targeting_overlay.dayparts`. Echo on `get_media_buys` per the `sales-guaranteed` `targeting_overlay` echo rule — `createMediaBuyStore` handles persistence verbatim. The seller is responsible for collapsing DMA + daypart overlays into the correct station-and-time inventory upstream.

## Pricing — unit-based (cost per spot)

Until a `pricing_model: 'unit'` lands, express as CPM with a high `fixed_price` representing cost-per-thousand-spots equivalent, or use a custom `pricing_option_id` and clarify in `pricing_options[].description`.

## Agency estimate number

Top-level on `create_media_buy`. Echo on the response next to `media_buy_id` (e.g., `agency_estimate_number: "PNNL-NM-2026-Q4-0847"`).

## Measurement terms — per-package on the request

Buyers send `packages[].measurement_terms.billing_measurement` with `vendor`, `measurement_window` (`'live' | 'c3' | 'c7'`), and `max_variance_percent`. Echo on response package entries — the buyer uses `c7` as the guarantee basis for reconciliation.

## Ad-ID validation on `sync_creatives`

Reject spots without a valid Ad-ID in `industry_identifiers`:

```typescript
const adId = c.industry_identifiers?.find(x => x.type === 'ad_id')?.value;
if (!adId) {
  return {
    creative_id: c.creative_id,
    action: 'created',
    status: 'rejected',
    rejection_reason: 'Ad-ID required for broadcast spots',
  };
}
```

## Measurement windows — array of objects, not enum strings

`reporting_capabilities.measurement_windows` is an array of `MeasurementWindow` objects. Don't pass bare strings (`['live', 'c3', 'c7']`) — the schema rejects them:

```typescript
measurement_windows: [
  { window_id: 'live', duration_days: 0, expected_availability_days: 1, is_guarantee_basis: false },
  { window_id: 'c3', duration_days: 3, expected_availability_days: 4, is_guarantee_basis: false },
  { window_id: 'c7', duration_days: 7, expected_availability_days: 8, is_guarantee_basis: true },
];
```

Each delivery row tags `measurement_window`, `is_final`, and `supersedes_window` (for window upgrades). Live ratings mature in 24h, C3 in ~4d, C7 in ~8d. Final reconciliation lands ~15d after last air date.

## Window-update webhooks

Emit via `ctx.emitWebhook` with `operation_id: \`window_update.${media_buy_id}.${stage}\`` so C3 → C7 supersession retries share a stable idempotency key. See [`../../cross-cutting.md` § Webhooks](../../cross-cutting.md#webhooks-stable-operation_id-across-retries).
