# Specialism: sales-guaranteed

Companion to [`../SKILL.md`](../SKILL.md). The SKILL.md baseline applies; this file covers only the deltas for `sales-guaranteed`.

**Fork target**: `examples/hello_seller_adapter_guaranteed.ts` is the worked, passing reference adapter for this specialism. It demonstrates the IO-signing handoff via `ctx.handoffToTask(fn)`, the `SalesCorePlatform & SalesIngestionPlatform` field-annotation pattern, and structured `MEDIA_BUY_NOT_FOUND` / `PACKAGE_NOT_FOUND` / `TERMS_REJECTED` error shapes. Replace the `// SWAP:` markers with calls to your real ad-server backend.

**Forecast surface**: `'availability'`. Guaranteed sellers don't quote spend curves — they confirm reserved inventory against a targeting + dates request. `Product.forecast` should be a single point with `metrics.impressions` / `metrics.audience_size` populated and `metrics.spend` expressing the seller's quoted cost; budget is omitted. Set `valid_until` to within 24 hours so buyers refresh their view. See [Delivery Forecasts § Availability Forecast](https://adcontextprotocol.org/docs/media-buy/product-discovery/media-products#availability-forecast) for the canonical worked example.

Storyboard: `sales_guaranteed`. `create_media_buy` has **three return shapes**. Route on request signals FIRST — the specialism's name is about IO signing, but the baseline `media_buy_seller` storyboard exercises all three in sequence.

| Request signal                                                         | Return                                                                                                                  | Why                                                                                                     |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| IO signing required before the MediaBuy exists                         | **Task envelope**: `{ status: 'submitted', task_id, message? }` — NO `media_buy_id`, NO `packages`                      | The MediaBuy doesn't exist yet; humans must sign first.                                                 |
| Packages have no `creative_assignments` (creatives to come)            | **MediaBuy**: `{ status: 'pending_creatives', media_buy_id, packages, valid_actions: ['sync_creatives'] }`              | The MediaBuy exists and is reserved; it just can't serve until creatives arrive. Respond synchronously. |
| Packages include `creative_assignments` AND buy is instant-confirmable | **MediaBuy**: `{ status: 'active', media_buy_id, packages, confirmed_at, valid_actions: ['get_delivery','pause',...] }` | Fully materialized.                                                                                     |

**Default routing logic:**

```typescript
createMediaBuy: async (params, ctx) => {
  // 1. IO-approval path: return task envelope (no MediaBuy yet).
  if (needsIoSigning(params)) {
    const taskId = `task_${randomUUID()}`;
    return taskToolResponse(
      { status: 'submitted', task_id: taskId, message: 'Awaiting IO signature' },
      'IO signature pending',
    );
  }
  // 2. Synchronous MediaBuy — pending_creatives or active.
  const hasCreatives = params.packages?.every((p) => (p.creative_assignments ?? []).length > 0);
  const mediaBuyId = `mb_${randomUUID()}`;
  const packages = (params.packages ?? []).map((pkg, i) => ({
    package_id: `pkg_${i}`,
    product_id: pkg.product_id,
    pricing_option_id: pkg.pricing_option_id,
    budget: pkg.budget,
    targeting_overlay: pkg.targeting_overlay, // persists property_list / collection_list verbatim
    creative_assignments: pkg.creative_assignments ?? [],
  }));
  const buy = {
    media_buy_id: mediaBuyId,
    status: hasCreatives ? 'active' as const : 'pending_creatives' as const,
    packages,
    ...(hasCreatives && { confirmed_at: new Date().toISOString() }),
  };
  await ctx.store.put('media_buys', mediaBuyId, buy);
  return buy;  // framework auto-wraps with mediaBuyResponse (revision, valid_actions auto-set)
},
```

**`get_media_buys` must echo `packages[].targeting_overlay.property_list` / `.collection_list`.** Per the AdCP types, `property_list` and `collection_list` live inside `TargetingOverlay`, not directly on `Package` (see `/schemas/latest/core/package.json` and `/schemas/latest/core/targeting.json`). The `inventory_list_targeting` baseline scenarios send list refs at `packages[].targeting_overlay.{property_list,collection_list}`; `get_media_buys` must echo them back at the same nested path. Persist the full `targeting_overlay` verbatim; echo verbatim. `update_media_buy` should merge new targeting overlays without dropping prior refs.

**State transition: `pending_creatives → pending_start / active`.** When `update_media_buy` attaches `creative_assignments` to a buy in `pending_creatives` status, the buy MUST advance: `pending_start` if `start_time` is in the future, `active` if `start_time` is now or past. See the `updateMediaBuy` state-machine logic in `../SKILL.md` § update_media_buy.

**Task envelope — when IO signing is required.** Use `registerAdcpTaskTool` from `@adcp/sdk/server` so `tasks/get` returns the completion artifact:

```typescript
import { taskToolResponse } from '@adcp/sdk/server';

return taskToolResponse(
  { status: 'submitted', task_id: taskId, message: 'Awaiting IO signature; typical turnaround 2-4 hours' },
  'IO signature pending'
);
```

When the task completes, emit the final `create_media_buy` result (carrying `media_buy_id` and `packages`) via `ctx.emitWebhook` to `push_notification_config.url`. See [§ Webhooks](#webhooks-async-completion-signed-outbound).

Declare `requires_io_approval` in your `capabilities.features` for this path. For deterministic compliance testing, implement `forceTaskStatus` (not `forceMediaBuyStatus`) in your `TestControllerStore` to drive the task from `submitted → completed` without waiting for a human.

**Governance denial (`GOVERNANCE_DENIED`).** Baseline `media_buy_seller/governance_denied*` scenarios exercise governance refusal. For sellers that compose with a governance agent, call `checkGovernance(...)` from `@adcp/sdk/server` at the top of `create_media_buy`. If the governance agent returns denial, surface with `governanceDeniedError(result)` so the error code is `GOVERNANCE_DENIED` and context echoes. Sellers that don't compose with governance will see these scenarios fail with `INVALID_REQUEST` — expected until upstream gates the scenarios behind a composition-claim specialism (tracked at adcontextprotocol/adcp#2521).

### Forecast (`Product.forecast`)

Drive `Product.forecast` from a per-query upstream call so the buyer sees deltas across targeting, dates, and budget. Static seed-data `availability` blobs are placeholder; real GAM/FreeWheel/Operative integrations spend most of their API time here. The mock-server exposes the upstream-shape used by the worked adapter — see [`../../../src/lib/mock-server/sales-guaranteed/openapi.yaml`](../../../src/lib/mock-server/sales-guaranteed/openapi.yaml):

| Mock endpoint                                                              | Returns                                              | When                                                       |
| -------------------------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------- |
| `GET /v1/products?targeting=&flight_start=&flight_end=&budget=`            | catalog + inline `forecast` per product              | single round-trip during `getProducts`                     |
| `POST /v1/forecast` (`{product_id, targeting?, flight_dates?, budget?}`)   | `DeliveryForecast` (availability or spend)           | per-product on demand (cheaper backends)                   |
| `POST /v1/availability` (`{items: [...], dry_run: true}`)                  | per-item forecast + tier_pricing + cross-item conflicts | pre-flight a multi-LI proposal                          |

The structured fields the buyer passes live on `req.filters` (`start_date`, `end_date`, `budget_range`) — `brief` is the free-text natural-language string per `GetProductsRequest`, not a structured payload. The worked `getProducts` projection lives in [`examples/hello_seller_adapter_guaranteed.ts`](../../../examples/hello_seller_adapter_guaranteed.ts).

**Cross-item supply contention is upstream-only.** `POST /v1/availability` mirrors GAM's `getCompetitiveForecast` — items are evaluated in order and earlier reservations reduce supply visible to later ones. AdCP `DeliveryForecast` is per-product, not per-package-set; adapters collapse the upstream contention model down to one `Product.forecast` per product. Multi-LI competitive math lives in the buyer's proposal logic, not the wire shape.
