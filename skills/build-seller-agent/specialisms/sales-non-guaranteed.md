# Specialism: sales-non-guaranteed

Companion to [`../SKILL.md`](../SKILL.md). The SKILL.md baseline applies; this file covers only the deltas for `sales-non-guaranteed`.

Storyboard: `media_buy_non_guaranteed`. The specialism hinges on `bid_price` and `update_media_buy`, neither of which the baseline example shows.

**Forecast surface**: `'spend'` (the default). Programmatic forward forecast — points at ascending budget levels show how impressions and clicks scale with spend. This is the planning surface every non-guaranteed buyer expects. Project your forecaster's spend curves directly onto `Product.forecast` points where each point is `{ budget: { mid }, metrics: { impressions: { low, mid, high }, clicks: { mid } } }`. See [`../../docs/guides/FORECASTING.md`](../../../docs/guides/FORECASTING.md) § Forward forecast for the canonical projection.

Packages on `create_media_buy` carry `bid_price`. Validate it against the product's `floor_price`:

```typescript
createMediaBuy: async (params, ctx) => {
  for (const pkg of params.packages ?? []) {
    const product = PRODUCTS.find((p) => p.product_id === pkg.product_id);
    const floor = product?.pricing_options[0].floor_price;
    if (floor && pkg.bid_price != null && pkg.bid_price < floor) {
      return adcpError('INVALID_REQUEST', {
        message: `bid_price ${pkg.bid_price} below floor_price ${floor}`,
      });
    }
  }
  return {
    media_buy_id: `mb_${randomUUID()}`,
    status: 'active' as const,   // instant — no IO
    packages: /* ... */,
  };
},

updateMediaBuy: async (params, ctx) => {
  const existing = await ctx.store.get('media_buys', params.media_buy_id);
  if (!existing) return adcpError('NOT_FOUND', { message: `Media buy ${params.media_buy_id} not found` });
  // Apply bid/budget updates from params.packages
  const updated = { ...existing, packages: /* merged */ };
  await ctx.store.put('media_buys', params.media_buy_id, updated);
  return updated;
},
```

`valid_actions` on an active non-guaranteed buy should include `pause`, `update_bid`, `get_delivery`. The framework auto-populates this when `createMediaBuy`/`updateMediaBuy` return with `status: 'active'`.
