# Prebid salesagent migration to DecisioningPlatform v3

The Prebid `salesagent` reference implementation (`prebid/salesagent` on GitHub — one word, not `sales-agent`) is a Python multi-tenant Flask + FastMCP server that implements the AdCP Media Buy protocol. Six platform adapters today: GAM, Kevel, Triton Digital, Xandr, Broadstreet, and a mock_ad_server for testing.

This validates `DecisioningPlatform` against (a) a different language — the design must be *spirit*-portable across SDK targets even though our types are TypeScript-only; (b) a *community* open-source reference implementation, the third independent peer interface after Scope3 and AudioStack; and (c) explicit multi-tenancy plus human-in-the-loop (HITL) workflows that the v1.0 type surface only covers via `AsyncOutcome.submitted`.

## Side-by-side: BaseAdapter vs DecisioningPlatform

Prebid's `BaseAdapter` (`src/adapters/base.py`) is a Python ABC with required `tenant_id` at init, a `Principal` auth context, an explicit `dry_run` flag, `manual_approval_required` config, and ~10 abstract methods. DecisioningPlatform splits the same surface across `accounts`, `sales`, optional `creative` / `audiences`, and a typed-data `capabilities` block.

| Concern | Prebid `BaseAdapter` | DecisioningPlatform v1.0 |
|---|---|---|
| Method grouping | flat ABC; ~10 abstract methods + ~5 helpers | per-specialism (`sales`, `creative`, `audiences`); only methods the platform claims |
| Capability declaration | dataclass-of-bools (`AdapterCapabilities`); per-method overrides (`get_supported_pricing_models()`, `get_targeting_capabilities()`) | typed `specialisms[]` + `RequiredPlatformsFor<S>` compile-time gate |
| Result type | direct return / Pydantic response object; raise on error | `Promise<AsyncOutcome<T>>` — sync / submitted / rejected discriminated union |
| Async / HITL | `manual_approval_required` config + `workflow_step_id` threaded through responses + separate `task_management.py` tool | `submitted({ taskHandle })` with `taskHandle.notify`; framework owns the task envelope |
| Multi-tenancy | `tenant_id: str` required at adapter `__init__` | `accounts.resolve(authPrincipal) → Account<TMeta>` once per request |
| Dry-run | `dry_run: bool` flag at adapter `__init__`; adapters log `(dry-run)` and skip platform writes | not modeled (gap) |
| Pre-validation | `validate_media_buy_request(...)` runs before adapter execution; returns list of error strings | not modeled (gap) |
| Inventory discovery for AI | `async get_available_inventory()` returning placements/ad-units/targeting/creative-specs | not modeled (gap — relevant if we ship AI product-config tooling) |
| Action-based update | `update_media_buy(action: str, ...)` — explicit verbs (`pause`, `resume`, `archive`); tool layer translates AdCP patches to verbs | `updateMediaBuy(buyId, patch: UpdateMediaBuyRequest, account)` — wire-shape patch |
| Snapshot vs full report | `get_packages_snapshot(...)` (optional) and `get_media_buy_delivery(...)` are separate methods | one `getMediaBuyDelivery` method; platform decides sync vs submitted by request scope |
| Targeting capabilities | `TargetingCapabilities` dataclass: per-geo-system bools, with `validate_geo_systems(targeting)` helper | `TargetingCapabilities` is a TODO placeholder in `capabilities.ts` |
| Pricing models | `get_supported_pricing_models() → set[str]`; default `{"cpm"}` | `pricingModels: PricingModel[]` typed enum in capabilities |
| Connection / product config | per-adapter `connection_config_class` + `product_config_class` (Pydantic) | `capabilities.config: TConfig` + `configSchema?: ZodSchema<TConfig>` |
| Audit logging | per-adapter audit logger initialized at `__init__` | adopter-internal (framework not opinionated) |

DecisioningPlatform wins on: type-level capability gating (Prebid's `set[str]` of pricing models can't enforce that the corresponding methods exist); type-level async (Prebid's HITL is paused-state-bookkeeping plus an external `task_management.py` — three runtime conventions where we have one type-level discriminator); specialism boundaries (Prebid's flat ABC requires every adapter to think about every method); wire-symmetric request shapes (Prebid's tool layer translates AdCP patches to action verbs — extra translation step we avoid).

Prebid wins on: `tenant_id` as a required init parameter (forces multi-tenancy thinking from day one); first-class `dry_run` flag (real workflow we don't model); `validate_media_buy_request` pre-flight hook (catches pricing-model mismatches before any platform call); `get_available_inventory` for AI-driven product config (interesting forward-looking surface); manual-approval-as-config (operator-tunable per tenant — we'd require platform-implemented `submitted()` instead).

## The HITL story — most important section

Prebid models human-in-loop approval workflows with three runtime conventions:

1. **`manual_approval_required: bool`** + `manual_approval_operations: set[str]` — tenant-level config flagging which operations need human approval.
2. **`workflow_step_id: str | None`** — threaded through `CreateMediaBuySuccess` and `update_media_buy`. Identifies a row in the workflow store.
3. **`src/core/tools/task_management.py`** — separate tool that the buyer (or operator) calls to advance/inspect workflow state.

DecisioningPlatform models the same workflow with one type-level decision:

```ts
sales: SalesPlatform = {
  createMediaBuy: async (req, account) => {
    if (this.requiresHumanApproval(req, account)) {
      const handle = this.workflowStore.create(account.id, req);
      return submitted(handle, {
        estimatedCompletion: new Date(Date.now() + 4 * 3600_000),
        message: 'pending operator approval',
      });
    }
    const buy = await this.platform.create(req, account);
    return ok(this.toMediaBuy(buy));
  },
  // ...
};
```

The framework receives the `submitted` outcome and emits the A2A Task envelope (or MCP polling response). The platform calls `taskHandle.notify({ kind: 'completed', result })` when the operator approves, or `notify({ kind: 'failed', error: { code: 'GOVERNANCE_DENIED', recovery: 'permanent', ... } })` on denial.

**What DecisioningPlatform gives up**: Prebid's flexibility to return `paused` MediaBuys with a `workflow_step_id` *outside* the submitted/sync/rejected axis. A Prebid adapter can return "the buy is created, paused, awaiting human review" as a synchronous response — buyer gets the buy back immediately and pings `task_management` separately. Under DecisioningPlatform that's just `submitted` — the buy isn't fully formed until approval.

**Whether that flexibility is needed**: probably not. The AdCP spec doesn't model "paused-pending-review" as a wire status; the closest is `pending_creatives` or `pending_start`. If a Prebid-style operator wants to surface a partially-formed buy to the buyer immediately, they can return `submitted` with `partialResult` in the task envelope — the framework already supports that on `TaskHandle`. Worth confirming this in the locked design doc.

## The action-based update gap

Prebid's `update_media_buy(media_buy_id, buyer_ref, action: str, package_id, budget, today)` accepts an action string — `pause`, `resume`, `archive`, etc. The MCP/A2A tool layer translates AdCP `UpdateMediaBuyRequest` patches into action calls.

DecisioningPlatform passes the patch directly: `updateMediaBuy(buyId, patch: UpdateMediaBuyRequest, account)`.

**Question reviewers will ask**: should we offer an action-based convenience hook (e.g., `updateMediaBuy.pause(buyId, account)`)?

**Answer (recommended)**: no. The patch is the wire shape. Adopters who prefer verbs can pattern-match locally:

```ts
updateMediaBuy: async (buyId, patch, account) => {
  if (patch.active === false) return this.pauseLineItems(buyId, account);
  if (patch.active === true)  return this.resumeLineItems(buyId, account);
  if (patch.packages?.some((p) => p.archived)) return this.archivePackages(...);
  return this.applyGenericPatch(buyId, patch, account);
}
```

Adding action-based convenience methods would (a) duplicate the wire surface (every patch field needs a verb), (b) drift over time as the spec evolves, (c) leak concrete platform verbs into the framework type. The patch is one method, deterministic, wire-symmetric. Document the local-dispatch idiom in JSDoc; resist the verb expansion.

## TypeScript skeleton

Sketch of the Prebid GAM adapter (`src/adapters/gam/`) under DecisioningPlatform:

```ts
import {
  type DecisioningPlatform,
  type SalesPlatform,
  type AccountStore,
  type StatusMappers,
  ok,
  submitted,
  rejected,
} from '@adcp/client/server/decisioning';
import { GamClient } from './gam-client';
import { WorkflowStore } from '../core/workflow-store';

interface PrebidGamConfig {
  networkId: string;
  apiVersion: string;
  manualApprovalOperations: ReadonlyArray<'create_media_buy' | 'update_media_buy' | 'add_creative_assets'>;
  defaultDeliveryMeasurement: { provider: string };
  dryRun: boolean;
}

interface PrebidGamMeta {
  tenantId: string;
  networkCode: string;
  companyId: string;
  principalId: string;
  adapterPrincipalId: string;
}

class PrebidGamPlatform implements DecisioningPlatform<PrebidGamConfig, PrebidGamMeta> {
  constructor(private gam: GamClient, private workflows: WorkflowStore) {}

  capabilities = {
    specialisms: ['sales-non-guaranteed', 'sales-guaranteed'] as const,
    creative_agents: [{ agent_url: 'https://creative.adcontextprotocol.org/mcp' }],
    channels: ['display', 'video'] as const,
    pricingModels: ['cpm', 'cpcv', 'cpp', 'cpc', 'cpv', 'flat_rate'] as const,
    targeting: {
      geo_countries: true,
      geo_regions: true,
      nielsen_dma: true,
      us_zip: true,
      // ... (see Scope3/Prebid TargetingCapabilities shape — should ship in v1.0)
    },
    config: {
      networkId: process.env.GAM_NETWORK_ID!,
      apiVersion: 'v202405',
      manualApprovalOperations: ['create_media_buy', 'update_media_buy'],
      defaultDeliveryMeasurement: { provider: 'publisher' },
      dryRun: false,
    },
  };

  statusMappers: StatusMappers = {
    mediaBuy: (native) =>
      ({
        DRAFT: 'pending_creatives',
        PENDING_APPROVAL: 'pending_start',
        READY: 'pending_start',
        DELIVERING: 'active',
        PAUSED: 'paused',
        COMPLETED: 'completed',
        CANCELED: 'canceled',
        DISAPPROVED: 'rejected',
      })[native] ?? 'rejected',
  };

  accounts: AccountStore<PrebidGamMeta> = {
    resolve: async (auth) => {
      // Multi-tenant resolution: auth.upstream_token → tenant → company.
      const tenant = await this.workflows.tenantFromAuth(auth);
      if (!tenant) return null;
      const company = await this.gam.companies.getById(tenant.companyId);
      if (!company) return null;
      return {
        id: `${tenant.networkCode}:${company.id}`,
        operator: 'prebid-salesagent',
        metadata: {
          tenantId: tenant.id,
          networkCode: tenant.networkCode,
          companyId: company.id,
          principalId: auth.principal_id,
          adapterPrincipalId: auth.principal_id, // map via principal.get_adapter_id('gam')
        },
        authInfo: auth,
      };
    },
    upsert: async (refs) => ok([]), // GAM accounts derive from auth
    list: async () => ({ items: [], nextCursor: null }),
  };

  sales: SalesPlatform = {
    getProducts: async (req, account) => {
      // Pre-validation — equivalent of validate_media_buy_request hook.
      // (See Gap 2 below: should this be a framework-level pre-flight?)
      const products = await this.gam.products.search(req.brief, account.metadata.companyId);
      return { products };
    },

    createMediaBuy: async (req, account) => {
      // Validate pricing models against capabilities first.
      const supported = this.capabilities.pricingModels;
      for (const pkg of req.packages ?? []) {
        if (pkg.pricing?.model && !supported.includes(pkg.pricing.model)) {
          return rejected({
            code: 'INVALID_REQUEST',
            recovery: 'correctable',
            message: `Pricing model '${pkg.pricing.model}' not supported. Supported: ${supported.join(', ')}.`,
          });
        }
      }

      // Manual approval gate — equivalent of Prebid's manual_approval_required.
      const opsRequiringApproval = this.capabilities.config.manualApprovalOperations;
      if (opsRequiringApproval.includes('create_media_buy')) {
        const handle = this.workflows.create({
          tenantId: account.metadata.tenantId,
          operation: 'create_media_buy',
          request: req,
        });
        return submitted(handle, {
          message: 'pending operator approval',
        });
      }

      // Direct path — no approval required.
      const order = await this.gam.orders.create({
        name: req.po_number ?? `adcp-${req.idempotency_key}`,
        advertiserId: account.metadata.companyId,
      });
      const lineItems = await this.gam.lineItems.createMany(
        req.packages.map((p) => this.toLineItemSpec(p, order.id, req))
      );
      return ok(this.toMediaBuy(order, lineItems));
    },

    updateMediaBuy: async (buyId, patch, account) => {
      // Local action dispatch — replaces Prebid's update_media_buy(action, ...).
      if (patch.active === false) {
        await this.gam.lineItems.performAction(`WHERE orderId = ${buyId}`, 'PauseLineItems');
      } else if (patch.active === true) {
        await this.gam.lineItems.performAction(`WHERE orderId = ${buyId}`, 'ResumeLineItems');
      }
      for (const pkg of patch.packages ?? []) {
        await this.gam.lineItems.update(pkg.package_id, this.toLineItemPatch(pkg));
      }
      const order = await this.gam.orders.getById(buyId);
      const lineItems = await this.gam.lineItems.getByOrder(buyId);
      return ok(this.toMediaBuy(order, lineItems));
    },

    syncCreatives: async (creatives, account) => {
      const created = await this.gam.creatives.createMany(
        creatives.map((c) => this.toGamCreative(c, account.metadata.companyId))
      );
      return ok(created.map((c) => ({
        creative_id: c.id,
        status: this.statusMappers.creative?.(c.creativeStatus) ?? 'pending_review',
      })));
    },

    getMediaBuyDelivery: async (filter, account) => {
      // GAM reports always async — runReportJob + poll.
      const reportJob = await this.gam.reports.runReportJob(this.toReportSpec(filter));
      const handle = this.gam.reports.taskHandleFor(reportJob.id);
      return submitted(handle, {
        estimatedCompletion: new Date(Date.now() + 5 * 60_000),
        message: `report job ${reportJob.id} queued`,
      });
    },
  };

  // --- Internal helpers (illustrative) -------------------------------------
  private toLineItemSpec(pkg: any, orderId: string, req: any) { /* ... */ }
  private toLineItemPatch(pkg: any) { /* ... */ }
  private toMediaBuy(order: any, lineItems: any[]) { /* ... */ }
  private toGamCreative(c: any, companyId: string) { /* ... */ }
  private toReportSpec(filter: any) { /* ... */ }
}
```

Roughly 200 lines. Compare to Prebid's GAM adapter today: ~600 lines abstract base + ~2400 LOC concrete GAM adapter (per `src/adapters/gam/`). DecisioningPlatform doesn't shrink the GAM-API translation layer (that's irreducible), but the framework owns: tenant resolution, principal-to-adapter-ID mapping, idempotency, audit logging hooks, MCP/A2A wire mapping, dry-run dispatch, policy check service, pre-validation orchestration. Conservative estimate: ~50% of the abstract `BaseAdapter` boilerplate and ~25% of the concrete adapter boilerplate dissolve into framework code.

## Gaps to fix in DecisioningPlatform v1.0

Citing Prebid as evidence:

1. **`TargetingCapabilities` placeholder must be filled in.** Prebid's `TargetingCapabilities` dataclass (`src/adapters/base.py`) and Scope3's `TargetingCapabilities` interface (`packages/shared/src/types/adapter.ts:180-235`) converged on the same shape: per-geo-system flags, plus a `validate_geo_systems(targeting)` helper. Two independent codebases shipped the same shape — strong signal. Port to TypeScript and ship in v1.0.

2. **Pre-validation hook.** Prebid's `validate_media_buy_request(request, packages, start, end, package_pricing_info)` runs before adapter execution and returns a `list[str]` of errors. Catches pricing-model mismatches and adapter-specific constraint violations early (before any platform write). Should `SalesPlatform` add an optional `validateRequest?(req): Promise<ValidationError[]>`?

   Recommendation: **no** — the same outcome is reachable with `createMediaBuy` returning `rejected` early (see the skeleton above). But document this idiom in JSDoc so adopters know the pattern. The cost of a separate validation method is two round-trips' worth of orchestration boilerplate that adds nothing the rejection path can't.

3. **`dry_run` propagation.** Framework needs to thread `dry_run: boolean` through `Account` or as a separate context field. Today `AsyncOutcome` doesn't carry dry-run intent. Two options: (a) framework intercepts `dry_run: true` requests, validates schema + capability, returns the validated request shape without dispatching to the platform (the v3 proposal's blocker #4 fix); (b) pass `dry_run` to the platform and let it decide. Recommend (a) for v1.0 — matches the proposal, no platform code change needed. Document that platforms never see `dry_run` traffic.

4. **Multi-tenant primitive in `AccountStore`.** Prebid's `tenant_id` is required at adapter init. Our `Account<TMeta>` covers this if `TMeta` carries tenant config — but the type design should explicitly note that `accounts.resolve()` is *the* tenant-resolution boundary. Add to `accounts.ts` JSDoc and link from the v3 proposal.

5. **Manual approval as platform-implemented.** Prebid's `manual_approval_required` is operator-config; under DecisioningPlatform, the platform implements `createMediaBuy` to return `submitted` when approval is needed (see the skeleton). The framework doesn't ship a built-in `requireManualApprovalFor(operations)` decorator. Recommendation: don't add one — `submitted()` is the right primitive, and per-operation bookkeeping is platform-specific. Document the idiom.

6. **Snapshot vs full reports.** Prebid splits delivery into two methods (`get_packages_snapshot` for fast pacing, `get_media_buy_delivery` for full reports). Ours is one. Recommend: keep one method (`getMediaBuyDelivery`); platform decides sync (small report) vs submitted (large report) by parsing the request scope. Adopters with snapshot-fast-paths return `ok` with cached data, full reports return `submitted`. Document.

7. **Pricing-model surface area**. Prebid defaults to `{"cpm"}`, accepts `{cpm, cpcv, cpp, cpc, cpv, flat_rate}`. AdCP enum has 9 values: `cpm | vcpm | cpc | cpcv | cpv | cpp | cpa | flat_rate | time`. Confirm all 9 are in our `PricingModel` type (`capabilities.ts`) and document each.

## Bottom line

DecisioningPlatform fits the Prebid salesagent. The interface boundaries are right (specialism split, AsyncOutcome subsumes paused-state + workflow_step_id, Account<TMeta> handles multi-tenancy). Adopting it would shrink ~50% of the abstract `BaseAdapter` boilerplate and ~25% of the concrete adapter LOC — the GAM-API translation is irreducible.

The strongest signal: **Prebid + Scope3 converging on the same shape (specialism boundaries, TargetingCapabilities dataclass, multi-tenant primitive, HITL workflow as submitted-state) is the strongest validation we can ask for**. DecisioningPlatform is essentially the formalized union of what these two teams already shipped — Prebid in Python, Scope3 in TypeScript, both arriving at the same answer independently.

Pre-6.0 must-haves: ship `TargetingCapabilities` (Gap 1), document `dry_run` framework interception (Gap 3), document multi-tenant boundary in JSDoc (Gap 4), confirm full pricing-model enum coverage (Gap 7). Everything else is documentation.
