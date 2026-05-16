---
'@adcp/sdk': patch
---

fix(bridge): `mergeSeededProductsIntoResponse` short-circuits on the Submitted arm

`get_products` formally permits an async Submitted arm in the AdCP 3.0.11 spec (`schemas/cache/3.0.11/media-buy/get-products-async-response-submitted.json`) for queued custom / bespoke product curation. When a handler returns `{ status: 'submitted', task_id, message? }`, the dispatcher's `isSubmittedEnvelope` predicate routes the response through `wrapSubmittedEnvelope` rather than the success-arm builder — but the `TestControllerBridge` merge runs after that wrap step, and without a guard `mergeSeededProductsIntoResponse` would spread `products: [...]` into the Submitted envelope, producing a `{ status: 'submitted', task_id, products: [...], sandbox: true }` hybrid that violates the wire schema (no Submitted arm carries a `products` field, and `sandbox: true` shouldn't stamp onto a tasking acknowledgement).

Detect the Submitted shape (`{ status: 'submitted', task_id: string }`) in the merge helper and return the handler response reference-equal so the dispatcher's existing skip-on-reference-equality wrap-avoidance kicks in. No other behavior change; sync success-arm responses merge exactly as before.

Scope is `get_products`-specific by design — none of the other 12 bridged read tools (`list_creatives`, `get_media_buys`, `get_media_buy_delivery`, `list_accounts`, `get_account_financials`, `list_creative_formats`, `list_property_lists`, `get_property_list`, `list_collection_lists`, `get_collection_list`, `list_content_standards`, `get_content_standards`, `get_signals`, `get_creative_delivery`, `get_creative_features`) have a formal Submitted arm in 3.0.11, so applying the same guard uniformly would defend against a spec violation the SDK should surface via response validation rather than silently route around.

Regression test in `test/lib/seed-get-products-wiring.test.js` verifies the bridge leaves a `{ status: 'submitted', task_id, message }` envelope unmodified — no `products` spread, no `sandbox` stamp.
