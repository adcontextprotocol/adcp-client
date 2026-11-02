---
'@adcp/sdk': minor
---

Reporting subscriptions (experimental, AdCP 3.3): a test kit, a managed reference seller, and fewer host inputs.

- New subpath `@adcp/sdk/testing/reporting`: `createReportingTestKit({ start, offerings, accounts, buys })` runs a managed reference seller over `memoryStorage()` on a virtual clock. It gives buyers bound to it (`kit.buyer(id).reporting`), `clock.advance`/`advanceTo` (running the seller's cycle at every boundary crossed), `grants.revoke`/`regrant`/`windDown`/`reduce`, `accounts.setTimezone`, `buys.add`/`cancel`/`complete`, and `assertAgreement(buyer)`, which checks the seller's frozen owed set against the buyer's `reconcile()` and names the first differing rule. Also `createReferenceReportingSeller`, `offerings.dailyAnalytics()`, `withReportingTestKit` and `reportingTestStart`.
- The reference seller (`examples/reporting-subscriptions-seller/seller.mjs`) is rewritten on the managed path: one `subscriptions` block, `accounts.list` and `getMediaBuys`, with a seeded buy that produces real obligations. `npx adcp reference-seller reporting [--port]` serves it.
- With `subscriptions.principal`, the service now pairs `notification_configs` with `sync_principal` and advertises `capability_changes` unless the platform does, and `principal.notifications` is optional with process-local storage (nothing is sent). Durable storage still requires it.
