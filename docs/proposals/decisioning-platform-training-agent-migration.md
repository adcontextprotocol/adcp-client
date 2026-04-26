# Training agent migration to DecisioningPlatform v3

The reference seller agent at `adcontextprotocol/adcp:server/src/training-agent/` has 10 documented blockers (per `FRAMEWORK_MIGRATION.md` in that directory) preventing migration to the current `createAdcpServer` handler-style API. This document walks through what each blocker becomes under the v3 DecisioningPlatform model.

**TL;DR**: 9 of 10 blockers dissolve because the framework now owns the surface they were leaking through. The one that remains (#5, AsyncLocalStorage session cache) is replaced by `ctx.state.workflowSteps()` which gives the same per-request scoping for free.

## Blocker-by-blocker

| # | v5.x blocker | v3 resolution |
|---|---|---|
| 1 | **Error-body wrap (training-agent emits non-AdCP error envelopes)** | Resolved. `AsyncOutcome.kind: 'rejected'` carries `AdcpStructuredError` with typed `code` + required `recovery`. Framework wraps as wire response; platform never hand-shapes the envelope. |
| 2 | **McpServer ESM/CJS friction** | Resolved at the framework layer (orthogonal to platform interface; CJS-by-default ships in 6.0). |
| 3 | **VERSION_UNSUPPORTED enforcement** | Resolved. Framework validates `adcp_major_version` against `capabilities.specialisms` declarations + the SDK's compiled-in version range. Platform never sees mismatched-version requests. |
| 4 | **dry_run short-circuit** | Resolved. Framework intercepts `dry_run: true` requests, validates schema + capability, returns the validated request shape without dispatching to the platform. Platform implementations don't see dry-run traffic. |
| 5 | **AsyncLocalStorage session cache (per-request memoization)** | Replaced. `ctx.state.workflowSteps()` returns the current request's audit trail; platforms read it (sync) for cross-method memoization within a single `createMediaBuy → reviewCreatives → ...` chain. ALS removed; explicit per-method `ctx` carries everything. |
| 6 | **Custom capabilities block (training-agent ships fields the framework doesn't model)** | Resolved. `DecisioningCapabilities<TConfig>` generic — platform-specific shape goes in `config: TConfig`. The training-agent's hand-rolled fields just become a typed `TrainingAgentConfig`. |
| 7 | **Hand-rolled idempotency replay** | Resolved at the framework layer. `createAdcpServer({ platform, idempotency })` wires identically; platform sees deduped/non-replayed traffic only. |
| 8 | **Inline creative path bypassing handler** | Resolved. v3's unified `syncCreatives` — framework normalizes both wire paths (sync_creatives push AND inline `creative_assignments[]`) and calls the platform's `syncCreatives` once per creative. |
| 9 | **Account resolution scattered across handlers** | Resolved. `accounts.resolve(ref)` is the single place tenant lookup happens; framework passes `ctx.account: Account<TMeta>` to every method afterwards. |
| 10 | **Mid-flight governance check threading** | Resolved. Framework calls `governance.checkGovernance` automatically when the account has registered governance agents; passes the verified `governance_context: GovernanceContextJWS` via `ctx.state.governanceContext()`. |

## Sketched implementation

```ts
import {
  type DecisioningPlatform,
  type SalesPlatform,
  type AccountStore,
  type Account,
  AdcpError,
} from '@adcp/client/server/decisioning';
import { TrainingAgentDB } from './db';

interface TrainingAgentConfig {
  /** The hand-rolled fields blocker #6 surfaced go here. */
  brand_pacing_threshold: number;
  default_floor_cpm: number;
  governance_required: boolean;
}

interface TrainingAgentMeta {
  /** Internal seller-side account hierarchy lives here. */
  network_id: string;
  advertiser_id: string;
}

class TrainingAgentPlatform
  implements DecisioningPlatform<TrainingAgentConfig, TrainingAgentMeta>
{
  capabilities = {
    specialisms: ['sales-non-guaranteed', 'audience-sync'] as const,
    creative_agents: [
      { agent_url: 'https://creative.adcontextprotocol.org/mcp' },
    ],
    channels: ['display', 'video'],
    pricingModels: ['cpm'],
    config: {
      brand_pacing_threshold: 0.85,
      default_floor_cpm: 1.5,
      governance_required: true,
    },
  };

  statusMappers = {
    mediaBuy: (native: string) =>
      ({
        DRAFT: 'pending_creatives',
        PENDING: 'pending_start',
        ACTIVE: 'active',
        PAUSED: 'paused',
        DONE: 'completed',
      })[native] ?? 'rejected',
  };

  constructor(private db: TrainingAgentDB) {}

  accounts: AccountStore<TrainingAgentMeta> = {
    resolve: async (ref) => {
      if ('account_id' in ref) {
        const row = await this.db.accounts.findById(ref.account_id);
        return row ? this.toAccount(row) : null;
      }
      const row = await this.db.accounts.findByDomain(
        ref.brand.domain,
        ref.operator
      );
      return row ? this.toAccount(row) : null;
    },
    upsert: async (refs) => {
      const rows = await this.db.accounts.upsertMany(refs);
      return ok(rows.map((r) => this.toResultRow(r)));
    },
    list: async (filter) => {
      const { items, nextCursor } = await this.db.accounts.list(filter);
      return { items: items.map((r) => this.toAccount(r)), nextCursor };
    },
  };

  sales: SalesPlatform = {
    getProducts: async (req, ctx) => {
      const products = await this.db.products.search(req.brief, ctx.account.metadata.advertiser_id);
      return { products };
    },

    createMediaBuy: async (req, ctx) => {
      // Governance is auto-threaded by the framework; we just consult result.
      // (See blocker #10.)
      try {
        const buy = await this.db.mediaBuys.create({
          ...req,
          advertiserId: ctx.account.metadata.advertiser_id,
        });
        return this.toMediaBuy(buy);
      } catch (e) {
        if (e instanceof TooLowBudgetError) {
          throw new AdcpError('BUDGET_TOO_LOW', {
            recovery: 'correctable',
            message: `Floor is $${this.capabilities.config.default_floor_cpm} CPM`,
          });
        }
        throw e;
      }
    },

    updateMediaBuy: async (id, patch, ctx) => {
      const updated = await this.db.mediaBuys.update(id, patch, ctx.account.metadata.advertiser_id);
      return this.toMediaBuy(updated);
    },

    syncCreatives: async (creatives, ctx) => {
      return Promise.all(
        creatives.map(async (c) => ({
          creative_id: c.creative_id,
          status: await this.db.creatives.review(c, ctx.account.metadata.advertiser_id),
        }))
      );
    },

    getMediaBuyDelivery: async (filter, ctx) => {
      return this.db.reporting.run(filter, ctx.account.metadata.network_id);
    },
  };

  // Helpers — internal mappers, no AdCP wiring.
  private toAccount(row: any): Account<TrainingAgentMeta> {
    return {
      id: row.account_id,
      brand: { domain: row.brand_domain },
      operator: row.operator,
      metadata: {
        network_id: row.network_id,
        advertiser_id: row.advertiser_id,
      },
      authInfo: row.authInfo,
    };
  }

  private toResultRow(row: any) {
    return {
      account_id: row.account_id,
      brand: { domain: row.brand_domain },
      operator: row.operator,
      action: row.was_new ? 'created' : ('updated' as const),
      status: 'active' as const,
    };
  }

  private toMediaBuy(row: any) {
    return {
      media_buy_id: row.id,
      status: this.statusMappers.mediaBuy?.(row.status) ?? 'pending_creatives',
      currency: row.currency,
      total_budget: row.total_budget,
      packages: row.packages,
    };
  }
}

// Wire-up:
// serve(createAdcpServer({ platform: new TrainingAgentPlatform(db) }));
```

## Estimate

| Metric | Current training-agent | v3 implementation |
|---|---|---|
| Lines of TypeScript | ~2000 (per FRAMEWORK_MIGRATION.md context) | **~400** (above sketch + the supporting db/types files) |
| Hand-rolled error envelopes | yes | none (framework wraps) |
| Hand-rolled idempotency | yes | none (framework wraps) |
| Hand-rolled session cache | AsyncLocalStorage layer | none (`ctx.state.workflowSteps()` provides) |
| Hand-rolled state-machine routing | yes | none (`AsyncOutcome` discriminator) |
| Custom capabilities block | hand-rolled | `config: TrainingAgentConfig` (typed) |
| Account hierarchy | scattered | `Account<TrainingAgentMeta>` |

5x line reduction for the training-agent specifically (its 2000 LOC includes hand-rolled idempotency, error envelopes, ALS, and state-machine routing — all of which dissolve into framework code). New adopters with full per-tool API translation (GAM ~2400 LOC, Meta ~1500 LOC) will see ~25-50% reduction — the platform-API boilerplate is irreducible. The right framing is **boilerplate dissolution**, not total LOC reduction. All 10 documented blockers resolved or replaced.

## What's NOT covered yet

- **Audience-sync surface**: `audiences: AudiencePlatform` — straightforward extension; another ~30 lines.
- **Mock platform unit tests**: replaces `bridgeFromTestControllerStore` calls. Separate work.
- **Compliance test seeding**: today's training-agent uses test-controller bridges; under v3, framework's MockDecisioningPlatform handles seeding via `accounts.upsert([...]) + sales.getProducts(...)` deterministic helpers.
