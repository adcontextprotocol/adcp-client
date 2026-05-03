---
"@adcp/sdk": minor
---

`createMediaBuyStore` + `mediaBuyStore` option — opt-in framework support for the `packages[].targeting_overlay` echo contract on `get_media_buys`.

Per `schemas/cache/3.0.5/media-buy/get-media-buys-response.json`, sellers SHOULD echo persisted targeting overlays so buyers can verify what was stored without replaying their own request. Sellers claiming `property-lists` or `collection-lists` MUST include the persisted `PropertyListReference` / `CollectionListReference` inside the echoed `targeting_overlay`. Pre-this-release, satisfying the contract meant every adapter persisted + merged + echoed by hand — `examples/hello_seller_adapter_guaranteed.ts` shipped without the wiring and any fork inherited a silent storyboard failure on `media_buy_seller/inventory_list_targeting/get_after_create`.

```ts
import {
  createAdcpServerFromPlatform,
  createMediaBuyStore,
  InMemoryStateStore,
} from '@adcp/sdk/server';

const stateStore = new InMemoryStateStore();

createAdcpServerFromPlatform(myPlatform, {
  mediaBuyStore: createMediaBuyStore({ store: stateStore }),
});
```

When wired, the framework:

- Persists `packages[].targeting_overlay` from `create_media_buy` requests, joined with the seller-assigned `package_id` (or `buyer_ref` when supplied). Persistence runs in the createMediaBuy projection, so it covers both the sync arm and the HITL completion arm.
- On `get_media_buys`, backfills missing `packages[].targeting_overlay` from the store. Packages the seller already echoed are left untouched.
- On `update_media_buy`, deep-merges the patched overlay against the prior persisted overlay: omitted keys keep prior, non-null values replace, explicit `null` clears. `new_packages[]` are persisted as fresh entries.

Backed by any `AdcpStateStore` — `InMemoryStateStore` for development, `PostgresStateStore` for production. Account-scoped per-tenant via `scopedStore`. Failures are logged + swallowed: a successful seller response is never turned into an error by the auto-echo plumbing.

`hello_seller_adapter_guaranteed.ts` now wires `mediaBuyStore` by default — every fork inherits the echo contract for free.

Removes four stale `UPSTREAM_SCHEMA_DRIFT` suppressors in `test/lib/storyboard-drift.test.js`. The cited `adcontextprotocol/adcp#2488` was resolved by the AdCP 3.0 GA schema update — `PackageStatus.targeting_overlay` is present on the wire response shape, so the storyboard assertions are now valid and the SDK is positioned to satisfy them.

Closes #1415.
