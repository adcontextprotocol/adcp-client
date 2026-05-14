---
"@adcp/sdk": minor
---

Extend `TestControllerBridge` with per-tool seeded callbacks for platform-proxy sellers.

Adds `getSeededCreatives`, `getSeededMediaBuys`, `getSeededAccounts`, `getSeededAccountFinancials`, and `getSeededCreativeFormats` to `TestControllerBridge<TAccount>`. Each callback follows the same post-handler merge pattern as the existing `getSeededProducts`: opt-in by presence, controller-gated, sandbox-only, with warn-and-drop validation on bad fixtures.

Extends `bridgeFromSessionStore` with matching `selectSeeded*` options so session-store adopters get all five bridges in one helper call.

Exports the new merge helpers (`mergeSeededCreativesIntoResponse`, `mergeSeededMediaBuysIntoResponse`, `mergeSeededAccountsIntoResponse`, `mergeSeededAccountFinancialsIntoResponse`, `mergeSeededCreativeFormatsIntoResponse`), filter helpers, and type aliases (`SeededCreative`, `SeededMediaBuy`) from `@adcp/sdk/server`.

Resolves the proxy-seller conformance gap: DSPs, walled gardens, and retail-media networks whose read path proxies an upstream API can now inject seeded fixtures into storyboard runs without live upstream OAuth or per-adapter stub code.
