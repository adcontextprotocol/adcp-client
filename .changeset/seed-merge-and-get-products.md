---
'@adcp/client': minor
---

Add seed fixture merge helpers and a `get_products` test-controller bridge so Group A compliance storyboards can seed fixtures end-to-end without seller boilerplate.

**Seed merge helpers** (`@adcp/client/testing`):

- Generic `mergeSeed<T>(base, seed)` — permissive merge: `undefined`/`null` in seed preserves base; every other leaf (including `0`, `false`, `""`, `[]`) overrides. Arrays replace by default; `Map`/`Set` throw.
- Typed per-kind wrappers (`mergeSeedProduct`, `mergeSeedPricingOption`, `mergeSeedCreative`, `mergeSeedPlan`, `mergeSeedMediaBuy`) layer **by-id overlay** on well-known id-keyed arrays so seeding a single entry doesn't drop the rest: `pricing_options[]` by `pricing_option_id`, `publisher_properties[]` by `(publisher_domain, selection_type)`, `packages[]` by `package_id`, creative `assets[]` by `asset_id`, plan `findings[]` by `policy_id`, plan `checks[]` by `check_id`.
- Shared `overlayById(base, seed, identity)` helper so sellers can apply the same overlay rule to domain-specific fields.

**`get_products` bridge** (`@adcp/client`):

- `createAdcpServer({ testController: { getSeededProducts } })` — seeded products append to handler output on sandbox requests (`account.sandbox === true`, `context.sandbox === true`, and — when `resolveAccount` returns an account — `ctx.account.sandbox === true`). Production traffic or a resolved non-sandbox account skips the bridge entirely. `product_id` collisions resolve with the seeded entry winning. Returns that are non-arrays or entries missing `product_id` are logged and dropped rather than thrown. Handler-declared `sandbox: false` stays authoritative (the bridge does not overwrite it).
- `bridgeFromTestControllerStore(store, productDefaults)` — one-liner that wraps any `Map<string, unknown>` seed store into a `TestControllerBridge`; each stored fixture is merged onto `productDefaults` via `mergeSeedProduct`.
- Opt-in via presence of `getSeededProducts`; the previous `augmentGetProducts` flag is dropped (one-rule opt-in).
