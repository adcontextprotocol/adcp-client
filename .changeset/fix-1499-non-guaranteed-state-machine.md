---
'@adcp/sdk': patch
---

fix(examples): wire `assertMediaBuyTransition` into `hello_seller_adapter_non_guaranteed` (closes #1499)

The non-guaranteed worked-reference adapter previously had no
state-machine enforcement on `update_media_buy` — the cascade
scenario `media_buy_seller/invalid_transitions/second_cancel`
failed because the adapter accepted a re-cancel instead of
rejecting with `NOT_CANCELLABLE`. SDK-side helpers shipped in 6.7
(`MEDIA_BUY_TRANSITIONS` + `assertMediaBuyTransition`, closes #1416)
but the example didn't wire them.

This change adds a per-buy `localBuyStatus` Map for paused / canceled
states (the mock upstream models pending → active progression but
not these terminal/reversible states) and calls
`assertMediaBuyTransition` on every cancel/pause path. Matches the
pattern already in `hello_seller_adapter_guaranteed`.

Drops the `adcp-client#1416` mask from the non-guaranteed gate test;
the gate now passes the storyboard unfiltered against the full
cascade.

No SDK behavior change — example-only fix.
