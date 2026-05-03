---
"@adcp/sdk": minor
---

Add `examples/hello_seller_adapter_non_guaranteed.ts` — worked starting point for an AdCP non-guaranteed sales agent. Closes #1458 (sub-issue of #1381 hello-adapter-family completion).

Pattern modeled on `hello_seller_adapter_guaranteed.ts` with auction-specific deltas:

- **Sync confirmation** — `create_media_buy` returns `media_buy_id` immediately; no IO-review handoff. Auction inventory clears at request time.
- **Floor pricing** — `pricing_options[].fixed_price` projected from upstream `min_cpm`; `min_spend` and `target_cpm` flow through to the wire when the upstream sets them.
- **Spend-only forecast** — `forecast_range_unit: 'spend'`; no `availability` unit because non-guaranteed inventory isn't pre-committed.
- **Pacing propagation** — `even` / `asap` / `front_loaded` forwarded to upstream order; reflected in delivery curve.
- **Looser product-validation at order creation** — the upstream mock no longer 404s when `line_items[].product_id` references a product not in the seed catalog. Cascade scenarios under `media_buy_seller/*` seed product fixtures via `comply_test_controller` independent of the seller's static catalog; min_spend is enforced only when the product IS known on the network.

Three-gate CI test (`test/examples/hello-seller-adapter-non-guaranteed.test.js`) lands alongside: strict tsc / storyboard runner / upstream-traffic façade. Two SDK-side gaps deferred (#1415 `targeting_overlay` echo, #1416 `NOT_CANCELLABLE` state-machine export) — same allowlist as the guaranteed gate.
