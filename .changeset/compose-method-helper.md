---
"@adcp/sdk": minor
---

Added `composeMethod` and the `PASS` sentinel for wrapping individual `DecisioningPlatform` methods with `before` / `after` hooks. Closes #1314.

Use to layer short-circuit + enrichment patterns on a typed platform without re-typing every method by hand:

```ts
import { composeMethod, PASS } from '@adcp/sdk/server';

const wrapped = {
  ...basePlatform,
  sales: {
    ...basePlatform.sales,
    getMediaBuyDelivery: composeMethod(basePlatform.sales.getMediaBuyDelivery, {
      // Short-circuit: skip the inner platform call on price-optimization paths.
      before: async (params) =>
        params.optimization === 'price' ? cachedPriceOpt : PASS,
      // Enrich: decorate the response with carbon emissions data.
      after: async (result) => ({ ...result, ext: { ...result.ext, carbon: await score(result) } }),
    }),
    getProducts: composeMethod(basePlatform.sales.getProducts, {
      after: async (result) => mergeBrandManifest(result, await brandCache.get()),
    }),
  },
};
createAdcpServerFromPlatform(wrapped, opts);
```

Semantics:

- `before` returning `PASS` falls through to the wrapped method. Returning any other value short-circuits the inner call.
- `after` runs on the result whether it came from the inner method or from a `before` short-circuit, with the original `params` and `ctx` available.
- `PASS` is registered via `Symbol.for(...)` so reference-equality holds across CJS/ESM dual-package boundaries.

Surfaced from the storefront-platform port in `scope3data/agentic-adapters#237`, which had to defer `getMediaBuyDelivery` price-optimization early-return + carbon enrichment and `getProducts` brand-manifest cache merging on the v6 path.
