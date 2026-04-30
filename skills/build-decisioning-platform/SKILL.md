---
name: build-decisioning-platform
description: Build an AdCP sales agent (publisher / SSP / retail-media network). Implement 5 functions, throw 8 typed errors, run it. Framework handles idempotency, HITL, signing, multi-tenant, schema validation.
---

# Build a sales agent

Implement 6 functions. The framework does the rest.

## What you're building

A `DecisioningPlatform` for the `sales-non-guaranteed` (or `sales-guaranteed`) specialism. Buyers call your AdCP server to discover products, create media buys, push creatives, update buys, and pull delivery reports. You translate those calls to your platform (GAM, FreeWheel, Kevel, your own ad server, whatever).

## The 5 functions

```ts
import {
  createAdcpServerFromPlatform,
  createCtxMetadataStore, memoryCtxMetadataStore,
  PackageNotFoundError, MediaBuyNotFoundError, ProductNotFoundError,
  BudgetTooLowError, BackwardsTimeRangeError, InvalidStateError,
  type DecisioningPlatform, type SalesPlatform,
} from '@adcp/sdk/server';

class MyPlatform implements DecisioningPlatform {
  capabilities = {
    adcp_version: '3.0.0',
    specialisms: ['sales-non-guaranteed'] as const,
    pricingModels: ['cpm'] as const,
    channels: ['display', 'video'] as const,                  // strict literal-union — TS catches typos
    formats: [{ format_id: 'display_300x250' }],
    idempotency: { replay_ttl_seconds: 86400 },
  };

  accounts = {
    resolution: 'derived' as const,                            // single tenant; framework returns the same Account every call
    resolve: async () => ({ id: 'pub_main', operator: 'mypub', ctx_metadata: {} }),
    upsert: async () => ({ ok: true, items: [] }),
    list: async () => ({ items: [], nextCursor: null }),
  };

  sales: SalesPlatform = {
    // 1. Catalog lookup. Brief in, products out.
    getProducts: async (req, ctx) => {
      const products = await this.platform.searchInventory(req.brief, req.promoted_offering);
      return {
        products: products.map(p => ({
          product_id: p.id,
          name: p.name,
          format_ids: p.formatIds.map(id => ({ id })),
          delivery_type: 'non_guaranteed',
          pricing_options: [{ pricing_option_id: `${p.id}-cpm`, model: 'cpm', floor: { amount: p.floor, currency: 'USD' } }],
          ctx_metadata: { gam: { ad_unit_ids: p.adUnitIds } },  // stashed; framework round-trips
        })),
      };
    },

    // 2. Create a buy. Sync path; HITL is `ctx.handoffToTask` (see advanced/HITL.md).
    //    SDK auto-hydrates each pkg.product with the resolved Product (incl. ctx_metadata)
    //    from the prior getProducts call — no separate lookup needed.
    createMediaBuy: async (req, ctx) => {
      if (new Date(req.start_time) >= new Date(req.end_time)) throw new BackwardsTimeRangeError();
      if (req.total_budget?.amount < 1000) throw new BudgetTooLowError({ floor: 1000, currency: 'USD' });

      const lineItems = [];
      for (const pkg of req.packages) {
        // pkg.product is the full Product from getProducts, with adapter-internal config attached:
        const adUnits = pkg.product.ctx_metadata?.gam?.ad_unit_ids ?? [];
        const formats = pkg.product.format_ids;
        lineItems.push(await this.platform.createLineItem(pkg, { adUnits, formats }));
      }
      const order = await this.platform.createOrder(req, lineItems);

      // Stash your platform's IDs so subsequent updateMediaBuy can hydrate them too.
      return {
        media_buy_id: order.id,
        status: 'pending_creatives',                           // creative state machine — see advanced/STATE-MACHINE.md
        ctx_metadata: { gam_order_id: order.gamOrderId },     // SDK persists; subsequent updateMediaBuy gets req.ctx_metadata.gam_order_id
        packages: order.lineItems.map(li => ({
          package_id: li.id,
          status: 'pending_creatives',
          buyer_ref: li.buyerRef,
          ctx_metadata: { gam_line_item_id: li.gamLineItemId },
        })),
      };
    },

    // 3. Update a buy. SDK auto-hydrates the resolved MediaBuy (and its packages,
    //    each with ctx_metadata) at req.mediaBuy when present in the store from a
    //    prior createMediaBuy / getMediaBuys call. Falls back gracefully if absent
    //    (publisher uses their own DB).
    //    (6.2 will pre-read state + decompose into atomic verbs; track adcp-client#1071.)
    updateMediaBuy: async (mediaBuyId, patch, ctx) => {
      const orderMeta = await ctx.ctxMetadata?.mediaBuy(mediaBuyId);
      if (!orderMeta) throw new MediaBuyNotFoundError(mediaBuyId);

      for (const pkg of patch.packages ?? []) {
        const pkgMeta = await ctx.ctxMetadata?.package(pkg.package_id);
        if (!pkgMeta) throw new PackageNotFoundError(pkg.package_id);
        await this.platform.updateLineItem(pkgMeta.gam_line_item_id, pkg);
      }
      const order = await this.platform.getOrder(orderMeta.gam_order_id);
      return this.toMediaBuy(order);
    },

    // 4. Push creatives. Returns one row per creative with action + status.
    syncCreatives: async (creatives, ctx) => {
      const out = [];
      for (const c of creatives) {
        const native = await this.platform.upsertCreative(c);
        await ctx.ctxMetadata?.set('creative', c.creative_id, { gam_creative_id: native.id });
        out.push({ creative_id: c.creative_id, action: 'created', status: 'approved' });
      }
      return out;
    },

    // 5. List buys this account owns. REQUIRED — every seller needs to support
    //    reading back what they created. SDK auto-stores returned buys for hydration
    //    on subsequent updateMediaBuy calls.
    getMediaBuys: async (req, ctx) => {
      const buys = await this.platform.listOrders({ accountId: ctx.account.id, status: req.status });
      return {
        media_buys: buys.map(buy => ({
          media_buy_id: buy.id,
          status: this.statusMappers.mediaBuy(buy.nativeStatus),
          buyer_ref: buy.buyerRef,
          total_budget: { amount: buy.budgetAmount, currency: buy.currency },  // REQUIRED on the wire shape
          start_time: buy.startTime,
          end_time: buy.endTime,
          packages: buy.lineItems.map(li => ({
            package_id: li.id,
            status: this.statusMappers.mediaBuy(li.nativeStatus),
            buyer_ref: li.buyerRef,
            ctx_metadata: { gam_line_item_id: li.gamLineItemId },               // round-trip publisher state
          })),
          ctx_metadata: { gam_order_id: buy.gamOrderId },
        })),
      };
    },

    // 6. Delivery report.
    getMediaBuyDelivery: async (filter, ctx) => ({ deliveries: await this.platform.fetchReports(filter) }),
  };

  constructor(private platform: MyAdServer) {}
}
```

That's the agent. Five functions. The framework wires the wire protocol around it (MCP tools, A2A skill manifest, idempotency, schema validation, HITL task envelopes, RFC 9421 webhook signing, multi-tenant routing).

## Errors you throw — pick from the import list

```ts
import {
  PackageNotFoundError,        // wrong package_id on update
  MediaBuyNotFoundError,       // wrong media_buy_id
  ProductNotFoundError,        // wrong product_id on create
  ProductUnavailableError,     // product exists but sold out
  CreativeNotFoundError,       // wrong creative_id
  CreativeRejectedError,       // brand-safety failed, etc.
  BudgetTooLowError,           // under floor (correctable — buyer raises)
  BudgetExhaustedError,        // pacing burst hit cap
  IdempotencyConflictError,    // same key, different payload
  InvalidRequestError,         // generic field-level bad input
  InvalidStateError,           // illegal transition (paused → archived violations)
  BackwardsTimeRangeError,     // start_time >= end_time
  AuthRequiredError,           // need auth, then retry
  PermissionDeniedError,       // auth present, lacks scope
  RateLimitedError,            // throttled (clamps retry_after to [1, 3600])
  UnsupportedFeatureError,     // tool unimplemented
  ComplianceUnsatisfiedError,  // brand-safety attestation missing
  GovernanceDeniedError,       // spending authority revoked
  PolicyViolationError,        // categorical content rejection
} from '@adcp/sdk/server';
```

Each class encodes the right `code` / `recovery` / `field` shape. **Don't throw generic `Error`** — the framework catches that and maps to `SERVICE_UNAVAILABLE`, which the buyer can't pattern-match.

## Persisting platform state — `ctx.ctxMetadata`

Your platform has IDs (GAM order_id, line_item_id) that AdCP doesn't model. Stash them once, read them on subsequent calls. The framework round-trips per `(account.id, kind, id)` and strips from buyer-facing wire payloads.

```ts
// Wire a store at server construction:
import { createCtxMetadataStore, memoryCtxMetadataStore, pgCtxMetadataStore, getCtxMetadataMigration } from '@adcp/sdk/server';

await pool.query(getCtxMetadataMigration());                                  // Postgres only
const ctxMetadata = createCtxMetadataStore({ backend: pgCtxMetadataStore(pool) });

// Stash in any handler return:
await ctx.ctxMetadata?.set('product', productId, { gam: { ad_unit_ids: [...] } });

// Read in a later handler:
const meta = await ctx.ctxMetadata?.product(productId);
```

**Memory backend:** fine for dev; use Postgres in cluster — silent loss after rolling restart produces "package not found" errors that look like publisher bugs and run for weeks.

**Account scoping is automatic.** `ctx.ctxMetadata` binds to `ctx.account.id` per request. No-account tools (`provide_performance_feedback`, `list_creative_formats`) get `ctx.ctxMetadata = undefined` — branch defensively.

## Run it

```ts
import { Pool } from 'pg';
import {
  createAdcpServerFromPlatform,
  getAllAdcpMigrations,
  serve,
} from '@adcp/sdk/server';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
await pool.query(getAllAdcpMigrations());                                 // one DDL call, all 3 tables

const platform = new MyPlatform(myAdServer);
const server = createAdcpServerFromPlatform(platform, {
  name: 'My Sales Agent',
  version: '1.0.0',
  pool,                                                                    // wires idempotency + ctxMetadata + taskRegistry
});

serve(() => server, { port: process.env.PORT });
```

That's the whole bootstrap. **One pool, one migration, three persistence concerns wired by the framework.**

For dev / single-process: omit `pool` entirely. Framework defaults to in-memory backends. Don't ship that to production — silent state loss after rolling restart produces "package not found" errors that look like publisher bugs and run for weeks.

## Operator checklist

Things you set up once at deploy time:

- [ ] `DATABASE_URL` env var pointing at your Postgres instance
- [ ] Run `getAllAdcpMigrations()` once per database (idempotent — safe to re-run)
- [ ] OAuth provider config — see `advanced/OAUTH.md` if buyers authenticate via OIDC
- [ ] `ADCP_VERSION` env (default `3.0.0`) if pinning a specific spec version

## See also

- `advanced/HITL.md` — long-running tools (creative review, manual approval). Use `ctx.handoffToTask(fn)`.
- `advanced/MULTI-TENANT.md` — `TenantRegistry` for one-process-many-publishers.
- `advanced/OAUTH.md` — auth providers (OIDC client_credentials, etc.).
- `advanced/SANDBOX.md` — test-mode routing via `AccountReference.sandbox`.
- `advanced/COMPLIANCE.md` — `comply_test_controller` for storyboard-driven QA.
- `advanced/GOVERNANCE.md` — `campaign-governance` specialism.
- `advanced/BRAND-RIGHTS.md` — `brand-rights` specialism.
- `advanced/IDEMPOTENCY.md` — replay TTL / principal resolver tuning.
- `advanced/STATE-MACHINE.md` — `pending_creatives` → `pending_start` → `active` transitions.
- `advanced/REFERENCE.md` — full reference (everything above + edge cases + design rationale).
