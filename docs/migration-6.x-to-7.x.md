# Migrating from `@adcp/sdk` 6.x to 7.0

> **Status: STUB.** JS Phase 2 (mock-mode upstream URL routing) has not
> landed. This file commits ahead of the SDK code so adopters have
> something to read before the breaking change ships — and so PRs that
> introduce the breaking change can't merge without the guide being in
> place. Sections marked **[planned]** describe the contract Phase 2
> will ship; sections without that marker describe shipped behavior.
>
> Tracking: [adcp-client#1494](https://github.com/adcontextprotocol/adcp-client/issues/1494)
> · proposal: [`docs/proposals/lifecycle-state-and-sandbox-authority.md`](./proposals/lifecycle-state-and-sandbox-authority.md)

## tl;dr — what's changing

`@adcp/sdk` 7.0 promotes the three-mode `Account.mode: 'live' | 'sandbox' | 'mock'` taxonomy from advisory to load-bearing. The framework now routes the **upstream URL** an adapter targets based on the resolved account's mode:

```
account.mode === 'live'    → adapter → production upstream (GAM, FreeWheel, Kevel, …)
account.mode === 'sandbox' → adapter → adopter's test upstream (their test infra)
account.mode === 'mock'    → adapter → bin/adcp.js mock-server <specialism>
```

In 6.x, mode is informational — the framework gates `comply_test_controller` on it but adapters wire their own upstream URL however they like. In 7.0, the framework hands the adapter `ctx.upstream` per request, and adapters MUST honor it.

**Adopters who don't change anything**: keep working unchanged for `'live'` and `'sandbox'` modes (the framework defers to the adapter's own URL when `ctx.upstream` is absent). Only adopters who want their adapter to grade against the SDK's built-in mock-server need to restructure.

## What ships in 7.0 [planned]

1. **`ctx.upstream` on `HandlerContext`** — the framework resolves the per-request upstream URL from the resolved account's mode and threads it through every adapter call.
2. **Adapter contract**: every `SalesPlatform` / `SignalsPlatform` / `CreativePlatform` method receives `ctx.upstream` as the source of truth for the URL its outbound HTTP calls should target. Adapters that ignore it (and hard-code their own URL) work for `'live'` mode but fail conformance in `'mock'` mode.
3. **`mock-server` URL contract**: `bin/adcp.js mock-server <specialism>` exposes a stable URL that the framework hands to adapters for `mock`-mode requests. The framework boots / supervises the mock-server when configured to.
4. **`account.mode` persistence across async-task lifecycle** — `tasks/get` polls and webhook emissions read the resolved `mode` from the original request's account, not from the polling caller's auth. A buy created on a `'sandbox'` account stays sandbox-routed for its whole lifecycle.

## Migration paths

Three shapes for handing the upstream URL into the adapter's HTTP layer. Pick whichever matches how the adapter is structured today; all three pass conformance.

### Shape A: resolver method (Python-friendly, simplest TS)

```ts
class GamSalesPlatform implements SalesPlatform {
  async getProducts(req, ctx) {
    const client = new GamClient({ baseUrl: ctx.upstream });
    return client.products.search(req.brief);
  }
  // … one constructor per request; adopter pays a small allocation cost
}
```

Best for: adopters whose upstream SDK takes the URL on the constructor. Allocation cost is negligible compared to the upstream HTTP round-trip.

### Shape B: constructor injection per request (TS idiom)

```ts
class GamSalesPlatform implements SalesPlatform {
  constructor(private readonly gam: GamClient) {}
  async getProducts(req, ctx) {
    return this.gam.withBaseUrl(ctx.upstream).products.search(req.brief);
  }
}
```

Best for: adopters whose upstream SDK has a `.withBaseUrl(url)` (or equivalent) that returns a per-call client without re-running the auth handshake.

### Shape C: middleware-rewrite (vendor SDKs that bake URL into the constructor)

Some vendor SDKs (older GAM bindings, FreeWheel, Kevel, Celtra) read the URL from `process.env` or a constructor-time config that can't change per-request. For those:

```ts
const clientsByUpstream = new WeakMap<HandlerContext, GamClient>();

class GamSalesPlatform implements SalesPlatform {
  private clientFor(ctx: HandlerContext): GamClient {
    let client = clientsByUpstream.get(ctx);
    if (!client) {
      client = new GamClient({ baseUrl: ctx.upstream });
      clientsByUpstream.set(ctx, client);
    }
    return client;
  }
  async getProducts(req, ctx) {
    return this.clientFor(ctx).products.search(req.brief);
  }
}
```

The `WeakMap<HandlerContext, …>` keyed off the per-request context object lets the GC reclaim each client when the request completes, without forcing the vendor SDK to expose a per-call URL.

Best for: vendor SDKs you don't own. The framework's per-request `HandlerContext` is GC-stable and unique per request, so the WeakMap is collision-free.

## `complyTest:` block stays first-class

Adopters who don't want to restructure their adapter for mock-mode routing can keep using the existing `complyTest:` block on `serverOptions`. The framework's compliance gate (`createAdcpServerFromPlatform`'s `complyTest` plumbing, shipped in 6.7) continues to work — `mock`-mode storyboards that need controller-driven setup hit `complyTest` adapters first, falling through to live upstream only for tools the controller doesn't seed. The 7.0 `ctx.upstream` contract is additive on top.

## `account.mode` persistence across async tasks [planned]

A buy created on a `'sandbox'` account stays sandbox-routed for its whole lifecycle. Specifically:

- **`tasks/get` polls** — the runner authenticates as the original buyer; the framework re-resolves the account and the resolver's stamped `mode` flows back into `ctx.upstream` for every follow-up call the adapter makes (delivery polling, task completion fetches).
- **Webhook emissions** — when the adapter emits a webhook for a sandbox buy, the framework stamps the request URL as `mock`-shaped or `sandbox`-shaped per the original account; the webhook receiver (test runner or adopter) sees a consistent mode-stamp.

This is what makes the three-mode model work end-to-end: a single request's mode is permanent on its tail.

## Mock-server scenario state [planned]

Tracked at [adcp-client#1495](https://github.com/adcontextprotocol/adcp-client/issues/1495). The `bin/adcp.js mock-server` today serves static request/response shapes; Phase 2 needs scriptable per-specialism state machines so storyboards can drive `'mock'`-mode lifecycle transitions end-to-end without the adopter wiring `complyTest:` themselves. Until that lands, `'mock'` mode is best-effort for adapters that don't pair it with their own controller seeds.

## Self-grade checklist

When 7.0 ships, run through:

- [ ] Adapter receives `ctx.upstream` on every `SalesPlatform` / `SignalsPlatform` / `CreativePlatform` method.
- [ ] Adapter routes its outbound HTTP to `ctx.upstream`, not a hardcoded value.
- [ ] `accounts.resolve` returns the correct `mode` for every credential the seller honors.
- [ ] Storyboard run with `--mode mock` (or equivalent CLI flag, name TBD) grades green against your adapter without any `complyTest:` plumbing.
- [ ] Webhook emissions for sandbox buys stamp `mock`/`sandbox` consistently across the buy's lifetime.

## Refs

- `docs/proposals/lifecycle-state-and-sandbox-authority.md` — the design proposal
- adcp-client#1495 — mock-server fixture scaffolding (companion track)
- adcp-client#1647 — derived resolution mode rework (companion track for upstream-managed rosters)
- `adcp mock-server --help` — CLI surface for the per-specialism mock fixtures
