---
'@adcp/sdk': patch
---

Use the seller-authored index pairing between equally sized `format_options` and `format_ids` lists when projecting canonical creatives to a legacy wire. Preserve these routes through canonical product discovery and serialized route sidecars so selected options work for creative sync and inline media-buy delivery. Existing declaration routes take precedence, and mismatched lists retain the previous behavior. Wire-mode negotiation is unchanged.
