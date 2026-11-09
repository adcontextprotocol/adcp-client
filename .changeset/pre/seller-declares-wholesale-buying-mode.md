---
'@adcp/sdk': minor
---

A seller built with `createAdcpServerFromPlatform` can now say it sells a wholesale catalogue in `get_adcp_capabilities.media_buy.buying_modes` (#3629). Before, the framework wrote `['brief']` or `['brief', 'refine']` from proposal support alone and overwrote anything the seller put in `capabilities.overrides.media_buy.buying_modes`, so a wholesale-only seller was unrepresentable and the SDK's own buyer client refused to send it a wholesale request (`UnsupportedBuyingModeError`).

- **Derived from handlers.** Registering `mediaBuyLifecycle.listProducts` adds `wholesale`. A platform that registers it and has no brief path (no `sales.getProducts`, `proposalManager`, `requestProposals` or `refineProposals`) advertises `['wholesale']` alone. A platform without a catalogue handler advertises exactly what it did before.
- **Declared by the seller.** `capabilities.buyingModes` states the list explicitly, for a `sales.getProducts` handler that answers `buying_mode: 'wholesale'` (the handlers cannot say so) or to leave out a mode they imply. It is checked against the registered handlers, and `createAdcpServerFromPlatform` throws a `PlatformConfigError` (`configField: 'capabilities.buyingModes'`) for an empty list, a value that is not a buying mode, or a mode with no handler to serve it: `brief` and `refine` need `sales.getProducts` or a proposal path, `wholesale` needs `sales.getProducts` or `mediaBuyLifecycle.listProducts`. `overrides.media_buy.buying_modes` is unchanged: the framework value still overwrites it.
- **Wholesale feed blocks.** `capabilities.overrides` (and `createAdcpServer`'s `capabilities.overrides`) now accept `wholesale_feed_versioning` and `wholesale_feed_webhooks`. The SDK does not derive them.

**Who is affected.** A platform that registers `mediaBuyLifecycle.listProducts` now gains `wholesale`; if it has no brief path it also stops advertising `brief`, which AdCP treats as implicit and the SDK buyer client treats as always supported. Declare `capabilities.buyingModes` to keep a different list.
