# Specialism: sales-non-guaranteed

Companion to [`../SKILL.md`](../SKILL.md). The SKILL.md baseline applies; this file covers only the deltas for `sales-non-guaranteed`.

Storyboard: `sales_non_guaranteed`. The specialism hinges on `bid_price` and `update_media_buy`, neither of which the baseline example shows.

**Fork target**: [`examples/hello_seller_adapter_non_guaranteed.ts`](../../../examples/hello_seller_adapter_non_guaranteed.ts) is the worked, passing reference adapter for this specialism. It demonstrates **sync confirmation** (no IO handoff — `createMediaBuy` returns `media_buy_id` immediately), floor pricing via `pricing_options[].fixed_price` from upstream `min_cpm`, spend-only forecast surfacing, and pacing propagation (`even` / `asap` / `front_loaded`). Auction mode is the deletion-fork of the guaranteed sibling — if your backend has HITL approval, fork [`hello_seller_adapter_guaranteed.ts`](../../../examples/hello_seller_adapter_guaranteed.ts) instead. Replace the `// SWAP:` markers with calls to your real backend.

**Forecast surface**: `'spend'` (the default). Programmatic forward forecast — points at ascending budget levels show how impressions and clicks scale with spend. This is the planning surface every non-guaranteed buyer expects. Project your forecaster's spend curves directly onto `Product.forecast` points where each point is `{ budget: { mid }, metrics: { impressions: { low, mid, high }, clicks: { mid } } }`. See [Delivery Forecasts § Budget Curve](https://adcontextprotocol.org/docs/media-buy/product-discovery/media-products#budget-curve) for the canonical worked example.

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
