---
'@adcp/client': minor
---

Add seed fixture merge helpers (`mergeSeedAccount` is not modeled — the five seed kinds are `product`, `pricing_option`, `creative`, `plan`, and `media_buy`, matching the `seed_*` scenarios dispatched by `comply_test_controller`). `mergeSeedProduct`, `mergeSeedPricingOption`, `mergeSeedCreative`, `mergeSeedPlan`, `mergeSeedMediaBuy` all delegate to a generic `mergeSeed<T>` that implements the permissive-merge-over-defaults pattern — `undefined` / `null` seed fields leave base defaults intact, arrays replace rather than concat, and `Map` / `Set` inputs throw to flag design mistakes early.

Wire `seedProduct` into `get_products` responses when `createAdcpServer` is configured with a test controller: pass `testController: { getSeededProducts }` and seeded products append to handler output on sandbox requests (account.sandbox === true or context.sandbox === true). `product_id` collisions resolve with the seeded entry winning, enabling Group A compliance storyboard fixture support end-to-end. Production traffic without a sandbox marker skips the bridge entirely. Set `augmentGetProducts: false` to register the bridge without changing response shape.
