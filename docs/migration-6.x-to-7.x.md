# Migrating from `@adcp/sdk` 6.x to 7.0

> ⚠️ **Not yet shipped.** This guide describes contracts that land in
> 7.0. Adopters on 6.x should NOT restructure adapters yet — `ctx.upstream`
> does not exist in 6.x. The file exists so PRs introducing the breaking
> change can't merge without a migration guide in place; sections marked
> **[planned]** describe the contract Phase 2 will ship.
>
> Tracking: [adcp-client#1494](https://github.com/adcontextprotocol/adcp-client/issues/1494)
> · proposal: [`docs/proposals/lifecycle-state-and-sandbox-authority.md`](./proposals/lifecycle-state-and-sandbox-authority.md)

## tl;dr — the one diff you need to make

| Today (6.x) | 7.0 |
|---|---|
| Adapter hardcodes upstream URL (`process.env.GAM_URL`, constructor literal, etc.) | Adapter reads `ctx.upstream` per request |
| `account.mode` is informational (gates `comply_test_controller`) | `account.mode` drives the URL the framework hands the adapter |
| Mock-mode requires `complyTest:` plumbing to satisfy storyboards | Mock-mode routes the adapter at `bin/adcp.js mock-server <specialism>`; `complyTest:` stays for adopters who want it |

Restructure with Shape A (per-request client construction), B (per-call `.withBaseUrl()`), or C (URL-keyed cache for vendor SDKs that bake URL into the constructor) — full details below.

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

1. **`ctx.upstream` on `HandlerContext`** — the framework resolves the per-request upstream URL from the resolved account's mode and threads it through every adapter call. Lives at [`src/lib/server/create-adcp-server.ts`](../src/lib/server/create-adcp-server.ts) — today `HandlerContext` is allocated fresh per tool-handler invocation; Phase 2 stamps `upstream` on the same allocation.
2. **Adapter contract**: every `SalesPlatform` / `SignalsPlatform` / `CreativePlatform` method receives `ctx.upstream` as the source of truth for the URL its outbound HTTP calls should target. Adapters that ignore it (and hard-code their own URL) work for `'live'` mode but fail conformance in `'mock'` mode.
3. **`mock-server` URL contract**: [`bin/adcp.js mock-server <specialism>`](../bin/adcp.js) exposes a stable URL that the framework hands to adapters for `mock`-mode requests. The framework boots / supervises the mock-server when configured to.
4. **`account.mode` persistence across async-task lifecycle** — `tasks/get` polls and webhook emissions read the resolved `mode` from the original request's account, not from the polling caller's auth. A buy created on a `'sandbox'` account stays sandbox-routed for its whole lifecycle.

## Migration paths

Three shapes for handing the upstream URL into the adapter's HTTP layer. Pick whichever matches how the adapter is structured today; all three pass conformance.

### Shape A: per-request client construction (your SDK takes baseUrl in the constructor)

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

### Shape B: per-call `.withBaseUrl()` (your SDK exposes a per-call URL hook)

```ts
class GamSalesPlatform implements SalesPlatform {
  constructor(private readonly gam: GamClient) {}
  async getProducts(req, ctx) {
    return this.gam.withBaseUrl(ctx.upstream).products.search(req.brief);
  }
}
```

Best for: adopters whose upstream SDK has a `.withBaseUrl(url)` (or equivalent) that returns a per-call client without re-running the auth handshake.

### Shape C: URL-keyed client cache (your SDK bakes URL into the constructor and you want client reuse across requests)

Some vendor SDKs (older GAM bindings, FreeWheel, Kevel, Celtra) read the URL from `process.env` or a constructor-time config that can't change per-request. Shape A handles this fine if you don't mind allocating a fresh client per request. If your vendor SDK has an expensive constructor (auth handshake, connection pool warmup), key the cache off the upstream URL itself so all requests sharing the same `ctx.upstream` reuse the same client:

```ts
class GamSalesPlatform implements SalesPlatform {
  private readonly clientsByUpstream = new Map<string, GamClient>();
  private clientFor(upstream: string): GamClient {
    let client = this.clientsByUpstream.get(upstream);
    if (!client) {
      client = new GamClient({ baseUrl: upstream });
      this.clientsByUpstream.set(upstream, client);
    }
    return client;
  }
  async getProducts(req, ctx) {
    return this.clientFor(ctx.upstream).products.search(req.brief);
  }
}
```

The cache key is the URL string, not the request context — so client reuse spans every request that resolves to the same upstream (production for all live-mode requests, sandbox for all sandbox-mode requests, mock-server for all mock-mode requests). The cardinality of `ctx.upstream` is bounded by the number of distinct modes × tenants, so the cache stays small.

Best for: vendor SDKs you don't own AND whose construction is expensive enough to want to amortize across requests. If your vendor SDK is cheap to construct, Shape A is simpler and equivalent.

## `complyTest:` block stays first-class

Adopters who don't want to restructure their adapter for mock-mode routing can keep using the existing `complyTest:` block on `serverOptions`. The framework's compliance gate (`createAdcpServerFromPlatform`'s `complyTest` plumbing, shipped in 6.7) continues to work — `mock`-mode storyboards that need controller-driven setup hit `complyTest` adapters first, falling through to live upstream only for tools the controller doesn't seed. The 7.0 `ctx.upstream` contract is additive on top.

## `account.mode` persistence across async tasks [planned]

A buy created on a `'sandbox'` account stays sandbox-routed for its whole lifecycle. Specifically:

- **`tasks/get` polls** — the runner authenticates as the original buyer; the framework re-resolves the account and the resolver's stamped `mode` flows back into `ctx.upstream` for every follow-up call the adapter makes (delivery polling, task completion fetches).
- **Webhook emissions** — when the adapter emits a webhook for a sandbox buy, the framework stamps the request URL as `mock`-shaped or `sandbox`-shaped per the original account; the webhook receiver (test runner or adopter) sees a consistent mode-stamp.

This is what makes the three-mode model work end-to-end: a single request's mode is permanent on its tail.

## Mock-server scenario state

Tracked at [adcp-client#1495](https://github.com/adcontextprotocol/adcp-client/issues/1495). The `bin/adcp.js mock-server` now exposes shared scenario scaffolding on every specialism fixture: HTTP `/_scenario/*` routes, protected by the generated `X-Mock-Control-Token`, plus a programmatic `handle.scenario` object from `bootMockServer()`. Storyboard harnesses can reset fixture state between runs, inspect per-specialism state snapshots, inject one-shot scripted responses for fault tests, emit/capture loopback-only webhook stubs, and rely on exact `idempotency_key` replay handling on state-creation fixture routes. The per-specialism fixtures still own domain lifecycles (orders, activations, renders, conversations, etc.), but storyboards no longer need adopter-side maps just to drive or clear the common scenario surface.

## Self-grade checklist

When 7.0 ships, run through:

- [ ] Adapter receives `ctx.upstream` on every `SalesPlatform` / `SignalsPlatform` / `CreativePlatform` method.
- [ ] Adapter routes its outbound HTTP to `ctx.upstream`, not a hardcoded value. Audit with: `grep -rEn 'baseUrl|BASE_URL|process\.env\.[A-Z_]*_URL' src/adapters/` — every hit needs to be either `ctx.upstream` or a sandbox-bound URL the resolver opted in to.
- [ ] `accounts.resolve` returns the correct `mode` for every credential the seller honors.
- [ ] Storyboard run with `--mode mock` (or equivalent CLI flag, name TBD) grades green against your adapter without any `complyTest:` plumbing.
- [ ] Webhook emissions for sandbox buys stamp `mock`/`sandbox` consistently across the buy's lifetime.

## Refs

- `docs/proposals/lifecycle-state-and-sandbox-authority.md` — the design proposal
- adcp-client#1495 — mock-server fixture scaffolding (companion track)
- adcp-client#1647 — derived resolution mode rework (companion track for upstream-managed rosters)
- `adcp mock-server --help` — CLI surface for the per-specialism mock fixtures
