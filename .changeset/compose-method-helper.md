---
"@adcp/sdk": minor
---

Added `composeMethod` for wrapping individual `DecisioningPlatform` methods with `before` / `after` hooks. Closes #1314.

Use to layer short-circuit + enrichment patterns on a typed platform without re-typing every method by hand:

```ts
import { composeMethod } from '@adcp/sdk/server';

const wrapped = {
  ...basePlatform,
  sales: {
    ...basePlatform.sales,
    getMediaBuyDelivery: composeMethod(basePlatform.sales.getMediaBuyDelivery, {
      // Short-circuit: skip the inner platform call on price-optimization paths.
      before: async (params) =>
        params.optimization === 'price'
          ? { shortCircuit: cachedPriceOpt }
          : undefined,
      // Enrich: decorate the response before it hits response-schema validation.
      after: async (result) => ({
        ...result,
        ext: { ...result.ext, carbon_grams_per_impression: await score(result) },
      }),
    }),
    getProducts: composeMethod(basePlatform.sales.getProducts, {
      after: async (result) => mergeBrandManifest(result, await brandCache.get()),
    }),
  },
};
createAdcpServerFromPlatform(wrapped, opts);
```

Semantics:

- `before` returning `undefined` (or no return) falls through to the wrapped method. Returning `{ shortCircuit: value }` short-circuits.
- `after` runs on the result whether it came from the inner method or from a `before` short-circuit, with the original `params` and `ctx` available.
- `after` runs BEFORE response-schema validation. Decorations must satisfy the wire schema — vendor-specific data belongs under `ext` (the spec's typed extension surface).
- `composeMethod` validates `inner` at wrap time, so referencing an optional method that wasn't implemented on the platform throws at module load rather than at first traffic.

The discriminated `{ shortCircuit: T } | undefined` wrapper avoids the `undefined`-as-sentinel footgun: adopters who omit the wrapper and return a bare value get a TypeScript error rather than silent short-circuit-with-undefined behavior at runtime.

Surfaced from the storefront-platform port in `scope3data/agentic-adapters#237`, which had to defer `getMediaBuyDelivery` price-optimization early-return + carbon enrichment and `getProducts` brand-manifest cache merging on the v6 path.
