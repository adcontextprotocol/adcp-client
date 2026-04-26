# GAM seller migration to DecisioningPlatform v3

Architectural validation of `DecisioningPlatform<TConfig, TMeta>` against Google Ad Manager — the boring, stable enterprise SSP. If the interface fits a generative ad network and a 20-year-old line-item-and-order system, it's not just generative-creative-flavored.

GAM is the load-bearing reference because it owns the patterns the spec calls "async": delivery reports run via `runReportJob`, line items pass through DRAFT to APPROVED gates, and inventory forecasting may take seconds to minutes. The handler-style adapter (companion `adapter-pattern.md`) handles these by hand-shaping responses and threading webhooks through `ctx.emitWebhook`. This sketch walks through what each surface becomes under the v3 platform interface.

## GAM's shape

- **Network → Company → Order → LineItem → Creative**. The Network is the tenant boundary. Company is the GAM advertiser/agency entity. Order is the booked deal. LineItem is the GAM equivalent of a package — has dates, targeting, goals, rate. Creative is associated to LineItems via `LineItemCreativeAssociation`.
- **Native APIs**: `OrderService`, `LineItemService`, `CreativeService`, `LineItemCreativeAssociationService`, `ReportService`, `ForecastService`, `InventoryService`. PQL (`Statement`) drives all reads.
- **Status models**: LineItem has `DRAFT`, `PENDING_APPROVAL`, `READY`, `DELIVERING`, `PAUSED`, `INACTIVE`, `COMPLETED`, `CANCELED`, `DISAPPROVED`, `PAUSED_INVENTORY_RELEASED`. Order has `DRAFT`, `PENDING_APPROVAL`, `APPROVED`, `DISAPPROVED`, `PAUSED`, `CANCELED`, `DELETED`. Two parallel state machines.
- **Async by construction**: report jobs are explicitly `runReportJob` then poll-until-`COMPLETED`. Approval workflows can take hours and may bounce a LineItem back to `DRAFT` if a trafficker rejects.

## Method-by-method mapping

| `SalesPlatform` method | GAM API |
|---|---|
| `getProducts` | `ProposalService.getProposalsByStatement` for proposal-line templates, OR `RateCardService.getRateCardsByStatement` plus `ProductTemplateService.getProductTemplatesByStatement` for the productized catalog (per-network configuration). Filter `status = ACTIVE`. Synchronous. |
| `createMediaBuy` | Two-call dance: `OrderService.createOrders` then `LineItemService.createLineItems` (one per requested package). If the network requires trafficker approval, returns LineItems in `PENDING_APPROVAL` — wraps as `submitted`. Otherwise immediate `READY` (no creatives) or `DELIVERING` (creatives already attached). |
| `updateMediaBuy` | `LineItemService.updateLineItems` for budget/dates/targeting patches; `LineItemService.performLineItemAction` (`PauseLineItems`, `ResumeLineItems`, `ArchiveLineItems`) for status transitions. Some patches (rate increases past credit-line) bounce back to `PENDING_APPROVAL` — wraps as `submitted`. |
| `syncCreatives` | `CreativeService.createCreatives` plus `LineItemCreativeAssociationService.createLineItemCreativeAssociations`. GAM's own creative review (`Creative.creativeStatus`: `ACTIVE`, `INACTIVE`, `NOT_CHECKED`, `APPROVED`, `DISAPPROVED`). Sync if the network is auto-approve; `submitted` for managed-review networks. |
| `getMediaBuyDelivery` | `ReportService.runReportJob` returns a `reportJobId` immediately; client polls `getReportJobStatus` until `COMPLETED`; then `getReportDownloadURL`. Always async on real GAM — almost never returns sync. |

The handler-style adapter (see `adapter-pattern.md` Concrete adapter 1) wraps these with seven `wrap*` functions plus inline `ctx.emitWebhook` calls. Under v3 it collapses to five `SalesPlatform` methods plus the cross-cutting `accounts` and `statusMappers`.

## Async story — the load-bearing test

Every GAM-async surface uses the `AsyncOutcome.kind: 'submitted'` path with `taskHandle.notify` for completion push. GAM has a built-in webhook ("Notification Service") that pushes order/line-item status changes — the platform wires that to `taskHandle.notify`, framework polls only as fallback for networks where notifications are off.

| GAM async pattern | AsyncOutcome shape |
|---|---|
| `runReportJob` for `getMediaBuyDelivery` | `submitted({ taskHandle, estimatedCompletion: +5min })`. Platform polls GAM's report-status; on `COMPLETED`, calls `taskHandle.notify({ kind: 'completed', result: actuals })`. Framework owns the buyer-side wire surface. |
| Trafficker approval on `createMediaBuy` | `submitted({ taskHandle, estimatedCompletion: +4h, message: 'pending GAM trafficker approval' })`. GAM's notification on Order status change feeds the platform's webhook handler, which calls `taskHandle.notify`. |
| **Bounce-back to DRAFT** (trafficker rejects, then later re-approves) | This is where the contract gets interesting. GAM moves LineItem `PENDING_APPROVAL` → `DRAFT` (rejection) → `PENDING_APPROVAL` (re-submission) → `READY` (approval). Today's `AsyncOutcome` assumes `submitted` is monotonic. See Gaps. |
| `ForecastService.getAvailabilityForecast` for richer `getProducts` | Async-eligible. v3 has `getProducts` typed sync (`Promise<GetProductsResponse>`). See Gaps. |
| Creative review (`Creative.creativeStatus = NOT_CHECKED → APPROVED/DISAPPROVED`) | `submitted` from `syncCreatives`. Per-batch completion via `taskHandle.notify({ kind: 'completed', result: [...reviewResults] })`. Matches the spec's Innovid 4-72h SLA call-out. |

## Status mapping

GAM's LineItem status is the closest analog to AdCP's `MediaBuyStatus`. The `Order` status sits one level above; per-LineItem rollups vary.

```ts
const gamLineItemToAdcp: Record<string, AdcpMediaBuyStatus> = {
  DRAFT:                       'pending_creatives',
  PENDING_APPROVAL:            'pending_start',      // note 1
  READY:                       'pending_start',      // note 3
  DELIVERING:                  'active',
  PAUSED:                      'paused',
  PAUSED_INVENTORY_RELEASED:   'paused',
  INACTIVE:                    'paused',             // note 2
  COMPLETED:                   'completed',
  CANCELED:                    'canceled',
  DISAPPROVED:                 'rejected',
};

statusMappers: StatusMappers = {
  mediaBuy: (native) => gamLineItemToAdcp[native] ?? 'rejected',
};
```

**Note 1** — `PENDING_APPROVAL` maps to `pending_start` because the buy *is* a buy; status of the approval workflow is carried in the AsyncOutcome, not the wire status enum. Conflating "the approval is in flight" with "the buy is non-existent" loses information.

**Note 2** — `INACTIVE` is a GAM-internal release, not a buyer-driven pause. Mapping to `paused` is approximate; some adopters may prefer `rejected`. The kind of ambiguity StatusMappers exists to encode per-platform.

**Note 3 (READY)** — `READY` is GAM's "approved + scheduled, awaiting start_date." Unambiguously `pending_start` because creatives are already attached (otherwise GAM would refuse the transition out of `DRAFT`). If creatives aren't attached, GAM holds the line item in `DRAFT`, which maps to `pending_creatives`.

## TypeScript skeleton

```ts
import {
  type DecisioningPlatform,
  type SalesPlatform,
  type AccountStore,
  type Account,
  type StatusMappers,
  ok,
  submitted,
  rejected,
} from '@adcp/client/server/decisioning';
import { GamClient, GamLineItem, GamReportJob } from './gam-client';

interface GamConfig {
  networkId: string;
  apiVersion: 'v202402' | 'v202405';
  networkCurrency: string;
}

interface GamAccountMeta {
  /** GAM Network — the tenant. */
  networkCode: string;
  /** GAM Company.id — the advertiser within the network. */
  companyId: string;
  teamId?: string;
}

class GamPlatform implements DecisioningPlatform<GamConfig, GamAccountMeta> {
  constructor(private gam: GamClient) {}

  capabilities = {
    specialisms: ['sales-non-guaranteed', 'sales-guaranteed'] as const,
    creative_agents: [{ agent_url: 'https://creative.adcontextprotocol.org/mcp' }],
    channels: ['display', 'video'] as const,
    pricingModels: ['cpm'] as const,
    reporting: {
      frequencies: ['hourly', 'daily'] as const,
      expected_delay_minutes: 30,
      timezone: 'UTC',
      metrics: ['impressions', 'clicks', 'revenue', 'viewable_impressions'],
      date_range_support: 'date_range' as const,
      supports_webhooks: true,
    },
    config: {
      networkId: process.env.GAM_NETWORK_ID!,
      apiVersion: 'v202405' as const,
      networkCurrency: 'USD',
    },
  };

  statusMappers: StatusMappers = {
    mediaBuy: (native) => gamLineItemToAdcp[native] ?? 'rejected',
    creative: (native) =>
      ({
        NOT_CHECKED: 'pending_review',
        APPROVED: 'approved',
        DISAPPROVED: 'rejected',
        ACTIVE: 'approved',
        INACTIVE: 'archived',
      })[native] ?? 'pending_review',
    account: (native) =>
      ({ ACTIVE: 'active', INACTIVE: 'suspended', DELETED: 'closed' })[native] ?? 'active',
  };

  accounts: AccountStore<GamAccountMeta> = {
    resolve: async (ref) => {
      const network = await this.gam.networks.getCurrent();
      const company = 'account_id' in ref
        ? await this.gam.companies.getById(ref.account_id)
        : await this.gam.companies.findByExternalId(ref.brand.domain);
      if (!company) return null;
      return {
        id: `${network.networkCode}:${company.id}`,
        brand: ref.brand,
        operator: ref.operator,
        metadata: { networkCode: network.networkCode, companyId: company.id },
        authInfo: ref.authInfo,
      };
    },
    upsert: async (refs) => {
      const rows = await Promise.all(refs.map(async (r) => {
        const existing = await this.gam.companies.findByExternalId(r.brand!.domain);
        const company = existing
          ? await this.gam.companies.update(existing.id, { name: r.brand!.name })
          : await this.gam.companies.create({ name: r.brand!.name, type: 'ADVERTISER' });
        return {
          account_id: company.id,
          brand: r.brand!,
          operator: r.operator!,
          action: existing ? ('updated' as const) : ('created' as const),
          status: 'active' as const,
        };
      }));
      return ok(rows);
    },
    list: async (filter) => {
      const page = await this.gam.companies.getByStatement(this.toStatement(filter));
      return { items: page.results.map((c) => this.toAccount(c)), nextCursor: page.nextCursor };
    },
  };

  sales: SalesPlatform = {
    getProducts: async (req, account) => {
      const rateCards = await this.gam.rateCards.getByStatement(
        `WHERE companyId = ${account.metadata.companyId} AND status = 'ACTIVE'`
      );
      return { products: rateCards.map((rc) => this.toProduct(rc)) };
    },

    createMediaBuy: async (req, account) => {
      try {
        const order = await this.gam.orders.create({
          name: req.po_number ?? `adcp-${req.idempotency_key}`,
          advertiserId: account.metadata.companyId,
          totalBudget: {
            microAmount: req.total_budget!.amount * 1_000_000,
            currencyCode: req.total_budget!.currency,
          },
        });
        const lineItems = await this.gam.lineItems.createMany(
          req.packages.map((p) => this.toLineItemSpec(p, order.id, req))
        );

        const pending = lineItems.filter((li) => li.status === 'PENDING_APPROVAL');
        if (pending.length > 0) {
          const handle = this.gam.notifications.subscribeOrder(order.id);
          handle.on('lineItemStatusChange', (li) => {
            if (li.status === 'READY' || li.status === 'DELIVERING') {
              handle.notify({ kind: 'completed', result: this.toMediaBuy(order, lineItems) });
            } else if (li.status === 'DISAPPROVED') {
              handle.notify({
                kind: 'failed',
                error: { code: 'TERMS_REJECTED', recovery: 'correctable', message: li.disapprovalReason },
              });
            }
            // DRAFT bounce-back falls through silently today. See Gaps.
          });
          return submitted(handle, {
            estimatedCompletion: new Date(Date.now() + 4 * 3600_000),
            message: `${pending.length} of ${lineItems.length} line items pending GAM trafficker approval`,
          });
        }
        return ok(this.toMediaBuy(order, lineItems));
      } catch (e) {
        if (e instanceof GamForecastUnavailableError) {
          return rejected({ code: 'PRODUCT_UNAVAILABLE', recovery: 'terminal', message: e.message });
        }
        if (e instanceof GamCreditLimitError) {
          return rejected({ code: 'BUDGET_EXCEEDED', recovery: 'correctable', message: e.message });
        }
        throw e; // framework wraps as SERVICE_UNAVAILABLE
      }
    },

    updateMediaBuy: async (orderId, patch, account) => {
      if (patch.active === false) {
        await this.gam.lineItems.performAction(`WHERE orderId = ${orderId}`, 'PauseLineItems');
      } else if (patch.active === true) {
        await this.gam.lineItems.performAction(`WHERE orderId = ${orderId}`, 'ResumeLineItems');
      }
      for (const pkg of patch.packages ?? []) {
        await this.gam.lineItems.update(pkg.package_id, this.toLineItemPatch(pkg));
      }
      const order = await this.gam.orders.getById(orderId);
      const lineItems = await this.gam.lineItems.getByOrder(orderId);
      const reapprovalPending = lineItems.some((li) => li.status === 'PENDING_APPROVAL');
      if (reapprovalPending) {
        const handle = this.gam.notifications.subscribeOrder(orderId);
        return submitted(handle, { message: 'patch triggered re-approval workflow' });
      }
      return ok(this.toMediaBuy(order, lineItems));
    },

    syncCreatives: async (creatives, account) => {
      const created = await this.gam.creatives.createMany(
        creatives.map((c) => this.toGamCreative(c, account.metadata.companyId))
      );
      const allApproved = created.every(
        (c) => c.creativeStatus === 'APPROVED' || c.creativeStatus === 'ACTIVE'
      );
      if (allApproved) return ok(created.map((c) => this.toReviewResult(c)));

      const handle = this.gam.notifications.subscribeCreatives(created.map((c) => c.id));
      handle.on('creativeStatusChange', () => {
        if (created.every((c) => c.creativeStatus !== 'NOT_CHECKED')) {
          handle.notify({ kind: 'completed', result: created.map((c) => this.toReviewResult(c)) });
        }
      });
      return submitted(handle, { estimatedCompletion: new Date(Date.now() + 24 * 3600_000) });
    },

    getMediaBuyDelivery: async (filter, account) => {
      const reportJob = await this.gam.reports.runReportJob({
        dimensions: ['ORDER_ID', 'LINE_ITEM_ID', 'DATE'],
        columns: ['AD_SERVER_IMPRESSIONS', 'AD_SERVER_CLICKS', 'AD_SERVER_CPM_AND_CPC_REVENUE'],
        statement: `WHERE ORDER_ID IN (${filter.media_buy_ids?.join(',')})`,
        dateRangeType: 'CUSTOM_DATE',
        startDate: filter.start_date!,
        endDate: filter.end_date!,
      });
      const handle = this.gam.reports.taskHandleFor(reportJob.id);
      return submitted(handle, {
        estimatedCompletion: new Date(Date.now() + 5 * 60_000),
        message: `report job ${reportJob.id} queued`,
      });
    },
  };

  // --- Internal mappers (illustrative; not exhaustive) ----------------------
  private toAccount(c: GamCompany): Account<GamAccountMeta> { /* ... */ }
  private toProduct(rc: GamRateCard) { /* ... */ }
  private toLineItemSpec(pkg: Package, orderId: string, req: CreateMediaBuyRequest) { /* ... */ }
  private toLineItemPatch(pkg: PackagePatch) { /* ... */ }
  private toMediaBuy(order: GamOrder, lineItems: GamLineItem[]): MediaBuy { /* ... */ }
  private toGamCreative(c: Creative, companyId: string) { /* ... */ }
  private toReviewResult(c: GamCreative): CreativeReviewResult { /* ... */ }
  private toStatement(filter: AccountFilter): string { /* PQL builder */ }
}
```

Roughly 250 lines. Compare to the handler-style adapter (`adapter-pattern.md` Concrete adapter 1): seven hand-shaped `wrap*` handlers, inline `ctx.emitWebhook` for async, no compile-time enforcement that the right handlers exist for the claimed `specialisms`. The DecisioningPlatform shape gets to the same place with five methods, framework-owned task envelopes, and `RequiredPlatformsFor<S>` ensuring `sales-guaranteed` claims always include a `sales: SalesPlatform`.

## Gaps and pain points

GAM exercises five corners of the interface that look thin in v3 today.

### Gap 1 — `AsyncOutcome` assumes monotonic submitted → completed/failed

GAM's `PENDING_APPROVAL → DRAFT` bounce (trafficker rejects, advertiser revises, re-submits) is a real workflow. Today `TaskUpdate` is `progress | completed | failed`. There's no way to express "task is alive but moved backward, awaiting buyer correction." Options:

- **Option A**: add `TaskUpdateRejected<TError>` (non-terminal — buyer can retry the same `taskId` after correcting). Distinct from `failed` (terminal).
- **Option B**: model bounce-back as `failed` with `recovery: 'correctable'`; buyer issues a *new* `createMediaBuy` with a corrected payload. Simpler shape but loses GAM-side correlation (the bounce keeps the same Order).

Recommend Option B for v1.0 (pragmatic) and revisit if other platforms (broadcast TV, DOOH) report the same bounce-back idiom. Document the decision in `AsyncOutcome` JSDoc — quietly assuming monotonic completion is the bug, not the workflow.

### Gap 2 — `getProducts` is sync-only; GAM forecasting is async

The interface today: `getProducts(req, account): Promise<GetProductsResponse>`. GAM's `ForecastService.getAvailabilityForecast` can take 5–30 seconds for complex targeting. Sellers that want forecast-aware product responses (impressions-available, sell-through estimates) need an async path.

- **Cheap fix**: leave `getProducts` sync; sellers run forecasting out-of-band and cache.
- **Proper fix**: widen to `Promise<AsyncOutcome<GetProductsResponse>>`. Costs every adopter `kind: 'sync'` boilerplate but unlocks forecast-driven discovery.

Recommend: ship v1.0 sync (matches training-agent), add a TODO in `sales.ts` JSDoc, revisit at v1.1. Cheap to widen later; expensive to widen pre-emptively.

### Gap 3 — `Account` doesn't model GAM's Network/Company split cleanly

GAM has Network → Company → Order → LineItem. Network is the tenant boundary (auth → networkCode); Company is the advertiser/agency entity. Today `Account.metadata: TMeta` carries `{ networkCode, companyId }`. This works, but every `SalesPlatform` method dereferences `account.metadata.companyId` — there's no place to express "this Account *is* the Company; the Network is implicit from the auth principal." Multi-Company per Network (a holding company with subsidiaries) is harder than it should be.

Not a blocker. The generic `TMeta` is the right escape hatch. Worth mentioning in adopter docs ("model your tenant boundary in `accounts.resolve`; model your sub-tenant entities in `metadata`") but not worth changing the type.

### Gap 4 — `StatusMappers.mediaBuy` is single-resolution; GAM has Order *and* LineItem statuses

`StatusMappers.mediaBuy: (native: string) => AdcpMediaBuyStatus` assumes one platform-native status per AdCP MediaBuy. GAM has *two* native states (Order.status and LineItem[].status). The AdCP MediaBuy is closer to LineItem — but Order-level signals need to roll up.

Today the adapter encodes this rollup in `toMediaBuy(order, lineItems)`, *not* via `statusMappers`. The mapper is reduced to "give me LineItem.status → AdcpMediaBuyStatus." The actual rollup policy ("if any LineItem is DISAPPROVED, the buy is `rejected`; if all are DELIVERING, the buy is `active`; mixed → take the most pessimistic") lives in the mapper's caller.

- **Option 1 (recommend)**: `StatusMappers` is the wire-status decoder; rollup logic is platform-specific and lives in adapter code. Document this in JSDoc.
- **Option 2**: add `StatusMappers.mediaBuyRollup?(states: { native: string; weight: number }[]): AdcpMediaBuyStatus`. Premature for v1.0.

### Gap 5 — `creative` mapper is too coarse for GAM's `LineItemCreativeAssociation` review

GAM has *two* review states: Creative.creativeStatus AND LineItemCreativeAssociation.status. A creative can be APPROVED globally but DISAPPROVED on a specific LineItem (e.g., trafficker doesn't want this creative on a sensitive section). The current `AdcpCreativeStatus` enum (`pending_review | approved | rejected | archived`) collapses both. `syncCreatives` returns one decision per creative.

Not a blocker for v1.0 — the spec assumes one review per creative — but worth flagging. If GAM adopters need per-association review surfaces, they'll need either a richer wire shape or platform-side "always merge to most-restrictive" semantics.

## Bottom line

The interface fits GAM, with two small JSDoc clarifications and one open-question tag.

- **Ship as-is**: 4 of 5 specialism methods map cleanly; `AsyncOutcome` covers report jobs, approval workflows, and creative review; `Account<TMeta>` handles the Network/Company split via metadata.
- **Document**: bounce-back semantics (Gap 1, Option B) and the StatusMappers/rollup boundary (Gap 4, Option 1) belong in JSDoc on `async-outcome.ts` and `status-mappers.ts`.
- **Tag for v1.1 review**: forecast-aware `getProducts` (Gap 2). Cheap to widen later; expensive to widen pre-emptively.
- **Defer**: per-association creative review (Gap 5) — wire-shape concern, not interface concern.

Five SalesPlatform methods + StatusMappers + Account<GamAccountMeta> handle the boring enterprise SSP. The interface isn't generative-creative-flavored; it's just async-by-default — what every real ad system needs.
