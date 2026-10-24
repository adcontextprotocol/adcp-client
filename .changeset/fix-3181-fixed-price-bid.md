---
'@adcp/sdk': patch
---

Storyboard runner: stop sending `bid_price` to fixed-price options. The `create_media_buy` request builder added a floor-based `bid_price` to any `cpm` option the fixture didn't bid on, including options carrying `fixed_price`, so a fixed-price CPM seller was sent a bid it should never receive. It now adds a bid only for a `cpm` option without `fixed_price`. It judges the option the package actually sends, not just the discovery pick. And it adds none when the request or the first package carries `bidding`, which AdCP 3.2 sellers must reject alongside a legacy `bid_price` (`AMBIGUOUS_BIDDING_POLICY`). Pricing-option selection now prefers options with `fixed_price` instead of matching `pricing_model` against `cpm` and the non-existent `flat`.
