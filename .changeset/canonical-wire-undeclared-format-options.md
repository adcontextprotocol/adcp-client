---
'@adcp/sdk': patch
---

Stop sending format option ids a seller never declared on the canonical creative wire. When a 3.x seller returns products with only legacy `format_ids`, `getProducts()` still mints `format_option_id`s for the buyer, but `format_option_refs` must match an entry in the seller's own `format_options[]`. `createMediaBuy`, `updateMediaBuy`, and `syncCreatives` now send a package that selects such options as the equivalent `format_kind` + `params` selector and drop creative `format_option_ref` pins to them. A selection that one direct selector cannot express is rejected with `ADCP_CREATIVE_FORMAT_PROJECTION_FAILED` before dispatch. Options the seller declared, including SDK-minted ids served by SDK-built sellers, are still sent as `format_option_refs`. Undeclared options are recognized from this client's `getProducts()` discovery.
