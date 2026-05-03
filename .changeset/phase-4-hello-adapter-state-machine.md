---
"@adcp/sdk": patch
---

`hello_seller_adapter_guaranteed` now enforces the `MediaBuyStatus` state machine on `update_media_buy`. Closes the `media_buy_seller/invalid_transitions/second_cancel` storyboard gap that adcp-client#1416 had been tracking.

Three small changes:

1. New `localBuyStatus: Map<string, MediaBuyStatus>` tracker — production sellers swap this for a query against their order DB.
2. `createMediaBuy` records `pending_creatives` on success.
3. `updateMediaBuy` reads current status (preferring the local tracker for `canceled` / `paused` since the upstream mock doesn't model those, otherwise falling through to `mapMediaBuyStatus(order.status)`), calls `assertMediaBuyTransition` (newly imported from `@adcp/sdk/server`) when the patch sets `canceled: true` or `paused: true`, and updates the tracker on success. Re-cancel now throws `NOT_CANCELLABLE` per `core/state-machine.yaml`.

Allowlist in `test/examples/hello-seller-adapter-guaranteed.test.js` shrinks from three entries to two. Remaining entries (#1415, #1417) are upstream-fixture issues — the SDK already shipped both fixes (createMediaBuyStore in PR #1424, runner `task_completion.<path>` capture in PR #1426); the storyboards in `adcontextprotocol/adcp` need migration to consume them. Both entries' `reason` strings updated to spell out which side of the boundary closes them.

The other four hello adapters (`creative-template`, `seller-social`, `signals-marketplace`, `si-brand`) have no allowlist and already pass clean.
