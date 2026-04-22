---
'@adcp/client': patch
---

Skill pitfalls for Cycle C — seller-side response-row drift surfaced by matrix v14:

- `get_media_buy_delivery /media_buy_deliveries[i]/by_package[j]` rows require the billing quintet: `package_id`, `spend`, `pricing_model`, `rate`, `currency`. Matrix v14 caught 4 failures on mock handlers that returned `{package_id, impressions, clicks}` without the billing fields. Added to seller + retail-media + generative-seller pitfall callouts.
- `get_media_buys /media_buys[i]` rows require `media_buy_id`, `status`, `currency`, `total_budget`, `packages`. Matrix v14 caught 2 failures on persist/reconstruct paths. Pitfall callouts now explicitly say: persist `currency` + `total_budget` at `create_media_buy` time, echo verbatim.

No SDK code change. This closes the last two non-specialism-specific drift classes; residual failures after matrix v15 will be storyboard-specific step expectations (generative quality, governance denial shape).
