---
'@adcp/sdk': patch
---

`createMediaBuy` and `updateMediaBuy` now send a package's `format_option_refs` to an AdCP 3.1 seller when the selected options have no legacy `format_ids` representation (#3665). Before, the client threw `CreativeFormatProjectionError` ("canonical format_option_refs have no complete legacy representation") and never sent the buy, so a buyer could not select a canonical-only format option from a 3.1 seller. Leaving the selector off was no workaround: AdCP 3.1 activates every product format when a package has no selector, and the seller held the buy for creatives it would never get.

AdCP 3.1 defines `format_option_refs` on the package request (`media-buy/package-request.json`), so the seller resolves the selection itself. The client sends the refs when the seller's `supported_versions` prove a mutually served 3.1 release. Selections with a complete legacy mapping are still rewritten to `format_ids`, as before. AdCP 3.0 sellers, and sellers whose release cannot be proven, still get the error: 3.0 does not define the field, and dropping it would activate every format. AdCP 3.2+ sellers are unchanged.

`projectMediaBuyCreativesForDelivery` takes an optional trailing `formatOptionRefsOnWire` argument for the same behavior in pure projection, and `releaseCarriesPackageFormatOptionRefs(capabilities, version)` from `@adcp/sdk/v2/projection` computes it.
