# Proxy Seller Snap Example

This is the fork target for a seller whose AdCP read path proxies an upstream ads platform: Snap, Meta, TikTok, Pinterest, LinkedIn, Google, Amazon, Reddit, Spotify, Criteo, CitrusAd, FlashTalking, UniversalAds, and similar DSP or walled-garden adapters.

## Diagnostic

If `get_products`, `list_creatives`, `list_property_lists`, or another read tool calls the upstream platform API directly, `comply_test_controller.seed_product` and `seed_creative` are otherwise dead writes. The seed lands in your local test controller, but your read handler asks Snap for products or creatives and never sees it.

Wire `TestControllerBridge` for storyboard conformance. The handler still runs first; the SDK merges seeded fixtures into sandbox responses after the upstream call succeeds. That proves AdCP wire conformance, not live Snap adapter health.

## What This Example Wires

- `TestControllerBridge<SnapAccount>` through `bridgeFromSessionStore`.
- Resolved-account session loading: `loadSession: (_input, ctx) => sessionStore.loadForAccount(ctx.account)`.
- Seed selectors for `get_products`, `list_creatives`, and property-list governance reads.
- `resolveAccount` as the trust boundary. The bridge keys on the resolved `ctx.account`, not on caller-supplied request fields.
- Optional `comply_test_controller` registration gated by `ADCP_SANDBOX=1`.

## Verification Scope

Bridge-augmented storyboard passes are wire-conformance evidence. They do not prove your Snap OAuth token, account lookup, product catalog, or creative library calls are healthy. Pair this with a live-OAuth sandbox runner that disables or records bridge participation and asserts real upstream traffic.

Run:

```bash
ADCP_SANDBOX=1 npx tsx examples/proxy-seller-snap/index.ts
```

Then seed and read with a sandbox account:

```bash
adcp call http://127.0.0.1:3018/mcp comply_test_controller \
  '{"scenario":"seed_product","params":{"product_id":"snap-storyboard-product","fixture":{"name":"Seeded product"}},"account":{"account_id":"snap_sandbox_acme","sandbox":true}}' \
  --auth sk_snap_proxy_harness_do_not_use_in_prod

adcp call http://127.0.0.1:3018/mcp get_products \
  '{"buying_mode":"brief","brief":"outdoor apparel","account":{"account_id":"snap_sandbox_acme","sandbox":true}}' \
  --auth sk_snap_proxy_harness_do_not_use_in_prod
```

Forking checklist:

1. Replace `emptySnapClient` with real Snap OAuth and Marketing API calls.
2. Replace `resolveSnapAccount` with your production account resolver.
3. Keep bridge registration limited to sandbox or conformance deployments.
4. Keep bridge session reads keyed on the resolved account.
5. Add a live-OAuth test that exercises the adapter without relying on `_bridge`-augmented fixtures.
