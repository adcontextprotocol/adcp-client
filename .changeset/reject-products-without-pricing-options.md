---
'@adcp/sdk': minor
---

Reject products without pricing options from `get_products` responses

`pricing_options` is a required, non-empty field in AdCP 3.1 — a product that
advertises no pricing model is non-transactable. The client now drops such
products from completed `get_products` responses before callers and completion
handlers see them, on every completion path (sync, polling, `track`, webhook)
and independent of the response `validation` mode. The rejection is recorded in
`result.metadata.productPricingPolicy` and surfaced as a
`product_missing_pricing_options` debug-log notice.

This is on by default. Set `validation.rejectProductsWithoutPricingOptions: false`
to pass unpriced products through untouched (e.g. when deliberately inspecting
malformed seller responses).
