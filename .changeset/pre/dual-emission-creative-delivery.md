---
'@adcp/sdk': patch
---

Use the seller-authored index pairing between equally sized `format_options` and `format_ids` lists when projecting canonical creatives to a legacy wire. Preserve these routes through canonical product discovery and serialized route sidecars so selected options work for creative sync and inline media-buy delivery. Explicit declaration and resolver routes take precedence, including restored sidecars. Skip index inference for the entire product when kinds, known dimensions, explicit routes, or canonical-only options contradict the alignment; keep unmapped-reference diagnostics visible. Linked references no longer produce duplicate bare candidates, so canonical package normalization can address the corresponding seller option; stale SDK-generated pins against seller-declared options fail closed. Wire-mode negotiation is unchanged.

Keep buyer-only inferred routes out of seller response assembly, preserving the seller's authored nested format references and unmapped-reference diagnostics.
