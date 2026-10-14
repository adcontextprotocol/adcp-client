---
'@adcp/sdk': minor
---

`legacyRoutesForProduct()` accepts an optional `{ sellerProduct }`: the product exactly as the seller returned it from `get_products`. With it, each route records `seller_declared` (and `canonical_selector` for options the seller did not declare) from whether the seller's own `format_options[]` names the option, instead of from in-memory discovery metadata. A buyer that stored a seller's raw products can now rebuild routes in another process that make canonical-wire writes address undeclared options by `format_kind` + `params`, without having run discovery there. Exports the `LegacyRoutesForProductOptions` type. Without the option, behaviour is unchanged.
