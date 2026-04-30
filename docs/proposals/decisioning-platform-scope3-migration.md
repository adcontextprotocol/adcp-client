# Scope3 agentic-adapters migration to DecisioningPlatform v3

The `scope3data/agentic-adapters` repo is a pnpm monorepo with 13 platform adapters (`adapter-amazon`, `adapter-citrusad`, `adapter-criteo`, `adapter-flashtalking`, `adapter-google`, `adapter-linkedin`, `adapter-meta`, `adapter-pinterest`, `adapter-reddit`, `adapter-snap`, `adapter-spotify`, `adapter-tiktok`, `adapter-universalads`) plus a `shared/` package. Each adapter has `src/adapter.ts` (orchestrator), `src/client.ts` (per-request platform client), `src/oauth.ts`, `src/formats.ts`, `src/types.ts`, plus `src/tasks/` containing per-tool implementations grouped by domain (`account/`, `conversion-tracking/`, `creative/`, `media-buy/`).

This validates `DecisioningPlatform` against an *independently-evolved peer interface*. Scope3's `PlatformAdapter` (`packages/shared/src/types/adapter.ts`) and our `DecisioningPlatform` arrived at structurally similar shapes — interface + per-task files + capability declaration — without coordination. Where they diverge tells us where each got it right.

## Side-by-side: PlatformAdapter vs DecisioningPlatform

| Concern | Scope3 `PlatformAdapter` | DecisioningPlatform v1.0 |
|---|---|---|
| Tool grouping | flat single interface; ~25 methods | per-specialism (`sales`, `creative`, `audiences`); only the methods the platform claims |
| Capability flags | runtime booleans (`supportsMediaBuy`, `supportsConversionTracking`, `supportsLogEvent`, ...) | typed `specialisms[]` + `RequiredPlatformsFor<S>` compile-time gate |
| Result type | `Result<T, PlatformError>` (neverthrow) — sync only | `Promise<AsyncOutcome<T>>` — sync / submitted / rejected |
| Async / long-running | not modeled at the type level — separate `pollAudienceStatus` task | `submitted({ taskHandle })` with `taskHandle.notify` |
| Error envelopes | `PlatformError { status, code?, message, details? }` ad-hoc | `AdcpStructuredError` with typed `code: ErrorCode` + required `recovery` |
| Account-not-found signal | `class AccountNotFoundError extends Error`; framework maps to `ACCOUNT_NOT_FOUND` envelope | currently expected via `rejected({ code: 'ACCOUNT_NOT_FOUND', ... })` — see gap below |
| Auth context | `extractContext(args, sessionToken?, requireAuth?) → TContext` per-call | `accounts.resolve(authPrincipal) → Account<TMeta>` once per request |
| Per-call context schema | `getContextSchema(): z.ZodObject` validates per-tool `context` arg | not modeled — `capabilities.configSchema` covers config, not per-call extras |
| Targeting capabilities | rich nested shape: per-geo-system bools, age verification methods, keyword match types, proximity (`packages/shared/src/types/adapter.ts:180-235`) | `TargetingCapabilities` is a TODO placeholder in `capabilities.ts` |
| Reporting dimensions | `availableDimensions: ReadonlyArray<'geo'\|'device_type'\|'audience'\|...>` | `ReportingCapabilities` is a TODO placeholder |
| Account resolution model | `accountResolution: 'explicit_account_id' \| 'implicit_from_sync'` | not modeled — every adopter implements `accounts.resolve` the same way |
| Operator / billing | `requireOperatorAuth?`, `supportedBillings: ['operator' \| 'agent']` | not modeled |
| Get-products signature | `getProducts(ctx, brief, contextId?, brand?, sourceChain?)` — separate params | `getProducts(req: GetProductsRequest, account)` — wire-symmetric |
| Composition with creative agent | `creativeAgentUrl` field | `capabilities.creative_agents: [{ agent_url, format_ids? }]` |

DecisioningPlatform wins on: type-level capability gating (Scope3's bool flags don't compile-check against missing methods), type-level async (Scope3 has separate `pollAudienceStatus` plus task-state files; we collapse to `AsyncOutcome.submitted`), wire-symmetric request shapes (Scope3's `getProducts` reshuffles fields out of the wire object), specialism boundaries (Scope3's flat interface forces every adopter to think about every tool).

Scope3 wins on: targeting-capability declarations (their nested shape is far more useful than our placeholder), per-call context Zod schemas (we have nothing), `accountResolution` flag (real distinction we don't model), `AccountNotFoundError` as a typed throw-class (cleaner than asking adopters to construct `rejected(...)` for a single not-found case), `requireOperatorAuth` / `supportedBillings` flags (operator-billed retail-media platforms need this).

## Per-adapter mapping

Mapping each Scope3 adapter to the AdCP specialism it would claim under DecisioningPlatform:

- **`adapter-google`** → `sales-non-guaranteed` + (probably) `audience-sync`. Google Ads programmatic. The largest concrete adapter (`packages/adapter-google/src/tasks/media-buy/create-media-buy.ts` is 773 lines with full Google Ads hierarchy: Campaign → Ad Group → Ad → Performance Max). Audience-sync via Customer Match.
- **`adapter-meta`, `adapter-snap`, `adapter-tiktok`, `adapter-pinterest`, `adapter-reddit`, `adapter-linkedin`** → `sales-social`. Each wraps the platform's marketing API. LinkedIn declares `accountResolution: 'implicit_from_sync'` (account must be pre-synced before transacting); the others use explicit account IDs. **Gap**: we don't model this distinction.
- **`adapter-amazon`, `adapter-criteo`, `adapter-citrusad`** → `sales-retail-media` (preview) or `sales-catalog-driven`. Catalog sync + retail-media specifics.
- **`adapter-spotify`** → `sales-streaming-tv` (preview) or `sales-non-guaranteed`. Audio-specific creative formats.
- **`adapter-flashtalking`** → `creative-ad-server`. Creative library + tags. Different specialism axis.
- **`adapter-universalads`** → likely `sales-non-guaranteed`. Generic OEM-style adapter.

The 13-adapter test bed exercises 5+ specialisms. DecisioningPlatform's specialism split lets the LinkedIn adapter declare only `sales: SalesPlatform`, while the Flashtalking adapter declares only `creative: CreativeAdServerPlatform` — neither implements interfaces it doesn't need.

## TypeScript skeleton

Sketch of `adapter-google` under DecisioningPlatform:

```ts
import {
  type DecisioningPlatform,
  type SalesPlatform,
  type AudiencePlatform,
  type AccountStore,
  ok,
  submitted,
  rejected,
} from '@adcp/client/server/decisioning';
import { googleClient } from './client.js';
import { GOOGLE_FORMATS, CREATIVE_AGENT_URL } from './formats.js';
import { GoogleOAuthProvider } from './oauth.js';

interface GoogleAdsConfig {
  defaultCustomerId?: string;
  apiVersion: string;
}

interface GoogleAdsMeta {
  google_login_customer_id: string;
  google_access_token: string;
  saactx?: string;
}

class GoogleAdsPlatform
  implements DecisioningPlatform<GoogleAdsConfig, GoogleAdsMeta>
{
  capabilities = {
    specialisms: ['sales-non-guaranteed', 'audience-sync'] as const,
    creative_agents: [{ agent_url: CREATIVE_AGENT_URL, format_ids: GOOGLE_FORMATS.map((f) => f.format_id) }],
    channels: ['display', 'video', 'search'],
    pricingModels: ['cpm', 'cpc', 'cpa'],
    config: { apiVersion: 'v17' },
  };

  statusMappers = {
    mediaBuy: (native: string) =>
      ({
        ENABLED: 'active',
        PAUSED: 'paused',
        REMOVED: 'canceled',
        ENDED: 'completed',
      })[native] ?? 'pending_creatives',
  };

  accounts: AccountStore<GoogleAdsMeta> = {
    resolve: async (auth) => {
      const customer = await googleClient(auth).customers.get(auth.upstream_token);
      if (!customer) return null; // framework maps to ACCOUNT_NOT_FOUND
      return {
        id: customer.id,
        operator: 'google-ads',
        metadata: {
          google_login_customer_id: customer.id,
          google_access_token: auth.upstream_token!,
        },
        authInfo: auth,
      };
    },
    upsert: async () => rejected({ code: 'NOT_SUPPORTED', recovery: 'permanent', message: 'Google Ads accounts are auth-derived' }),
    list: async (filter) => ({ items: [], nextCursor: null }),
  };

  sales: SalesPlatform = {
    getProducts: async (req, account) => {
      const products = await googleClient(account).products.search(req.brief, account.metadata.google_login_customer_id);
      return { products };
    },

    createMediaBuy: async (req, account) => {
      const client = googleClient(account);
      try {
        const campaign = await client.campaigns.create(this.toCampaignRequest(req));
        const adGroup = await client.adGroups.create(campaign.id, this.toAdGroupRequest(req));
        // Inline sync — Google Ads creates synchronously; no approval workflow.
        return ok(this.toMediaBuy(campaign, adGroup));
      } catch (e) {
        if (isPolicyViolation(e)) {
          return rejected({
            code: 'POLICY_VIOLATION',
            recovery: 'correctable',
            message: e.message,
          });
        }
        throw e;
      }
    },

    updateMediaBuy: async (id, patch, account) => {
      const updated = await googleClient(account).campaigns.update(id, patch);
      return ok(this.toMediaBuy(updated));
    },

    syncCreatives: async (creatives, account) => {
      const results = await Promise.all(
        creatives.map(async (c) => ({
          creative_id: c.creative_id,
          status: 'approved' as const, // Google Ads validates synchronously
        }))
      );
      return ok(results);
    },

    getMediaBuyDelivery: async (filter, account) => {
      // Google Ads reports are sync for small windows, async (BigQuery export) for large.
      if (this.isLargeReport(filter)) {
        return submitted({
          taskHandle: this.client(account).reports.runJob(filter),
          message: 'Generating BigQuery export',
        });
      }
      const actuals = await googleClient(account).reports.run(filter);
      return ok(actuals);
    },
  };

  audiences: AudiencePlatform = {
    syncAudiences: async (audiences, account) => {
      const job = googleClient(account).customerMatch.uploadAndProcess(audiences);
      return submitted({
        taskHandle: job, // Customer Match identity-graph match takes minutes
        message: 'Customer Match list activation in progress',
      });
    },
    getAudienceStatus: async (audienceId, account) => {
      const list = await googleClient(account).customerMatch.get(audienceId);
      return list.status; // platform-typed → AdcpAudienceStatus via mapper
    },
  };
}
```

Compare to today: `packages/adapter-google/src/adapter.ts` reshuffles task imports and threads `Result<T, PlatformError>` through every method. Per-task files are 100-800 lines each. Under DecisioningPlatform, the per-task files become method bodies on the `sales` / `audiences` interface, dropping the orchestrator boilerplate and the manual `Result` lifting. Conservative estimate: ~30-40% reduction in adapter boilerplate, with framework owning OAuth-provider wiring, context extraction, idempotency, and async polling.

## PR #100 / AudioStack as compile-time test

The AudioStack adapter (referenced in PR #100, not in the current `main` adapter listing — likely on a fork or separate branch) had three documented bugs on `@adcp/client 4.16.2`:

1. **No context echo**. Framework requires `context` to round-trip on every response; AudioStack's adapter didn't echo it.
   - Under DecisioningPlatform: framework owns context echoing entirely. Adopter never touches it. Bug becomes structurally impossible.

2. **`build_creative` returns wrong shape**. Adapter returned a free-form object instead of `CreativeManifest`.
   - Under DecisioningPlatform: `CreativeTemplatePlatform.buildCreative(req): Promise<AsyncOutcome<CreativeManifest>>` — returning anything else is a TypeScript compile error.

3. **Maps to `creative-template` specialism**. Required AudioStack to declare `'creative-template'` in capabilities and implement `CreativeTemplatePlatform`.
   - Under DecisioningPlatform: `RequiredPlatformsFor<'creative-template'>` forces `creative: CreativeTemplatePlatform`. Claim the specialism and omit the implementation → compile error. Implement it without claiming → unreachable interface, dead code.

All three would have been caught at `tsc --noEmit` time. This is the design-test for capability-as-types.

## Gaps to fix in DecisioningPlatform v1.0

Citing Scope3 as evidence (independently-arrived peer design):

1. **`TargetingCapabilities` placeholder must be filled in.** `src/lib/server/decisioning/capabilities.ts` has `TargetingCapabilities` as a TODO. Scope3 ships a working shape (`packages/shared/src/types/adapter.ts:180-235`): per-geo-system flags (`us_zip`, `gb_outward`, `nielsen_dma`, `eurostat_nuts2`, ...), age-restriction with verification methods, keyword match types (`broad | phrase | exact`), proximity (`radius | travel_time | geometry`, `transport_modes`). Recommend porting their shape close to verbatim — they've battle-tested it across 13 adapters.

2. **`ReportingCapabilities.availableDimensions`** should be a typed enum: `'geo' | 'device_type' | 'device_platform' | 'audience' | 'placement' | 'creative' | 'keyword' | 'catalog_item'`. Scope3's enum.

3. **`accountResolution`** at the `AccountStore` level. Two real shapes — `'explicit_account_id'` (Snap, Meta — buyer passes account_id) vs `'implicit_from_sync'` (LinkedIn — account must be pre-synced via `sync_accounts` before transacting). Framework needs to know which to dispatch correctly. Add to `AccountStore<TMeta>` as a `readonly resolution: 'explicit' | 'implicit'` field.

4. **`AccountStore.resolve` typed not-found signal**. Scope3 throws `AccountNotFoundError` (narrow class); framework catches and emits `ACCOUNT_NOT_FOUND` envelope. Cleaner than asking adopters to construct `rejected({ code: 'ACCOUNT_NOT_FOUND', ... })` for a single common case. Either accept the same throw-class pattern (export `AccountNotFoundError` from `@adcp/client/server`) or document that `resolve` returning `null` is the canonical not-found signal.

5. **`requireOperatorAuth` / `supportedBillings: ['operator' | 'agent']`** — operator-billed retail-media platforms (Criteo, Amazon) need this. Add to `DecisioningCapabilities`.

6. **Per-call context Zod schemas (deferred to v1.1)**. Scope3's `getContextSchema(): z.ZodObject` validates the per-tool `context` arg shape (e.g., `google_login_customer_id`). Our `Account.metadata: TMeta` covers the resolved shape but not per-call adopter-specific extras. Document this gap; punt to v1.1 if it doesn't surface in seller/creative skill matrix runs.

## Bottom line

DecisioningPlatform fits the agentic-adapters codebase. The interface boundaries are right (specialism split, AsyncOutcome, Account.resolve), and adopting it would shrink each adapter's boilerplate by ~30-40%. The five gaps above are pre-6.0 must-fixes — without them, every Scope3 adapter would have to maintain the missing capability declarations side-by-side with our types, which is the regression we're trying to avoid.

Strongest signal: Scope3 and DecisioningPlatform converged on (a) interface + per-task files, (b) per-request platform client created from auth context, (c) capability declarations as a single source of truth, (d) framework-owned wire mapping. The two designs evolved in parallel. That convergence is the validation; the deltas are the punch list.
