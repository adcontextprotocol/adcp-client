---
'@adcp/sdk': major
---

**Two-platform composition primitives** — port of `adcp-client-python` PRs #504 (v1) + #550 (v1.5). Splits proposal assembly (`get_products`, refine, finalize) from media-buy execution (`create_media_buy`, lifecycle), so either side can be mock-backed independently. New surface under `@adcp/sdk/server`:

- `ProposalManager<TRecipe, TCtxMeta>` interface — `getProducts` (required) + optional capability-gated `refineProducts` and `finalizeProposal`. Wired as a sibling on `DecisioningPlatform.proposalManager`.
- `ProposalCapabilities` — sales-axis-scoped (`sales-guaranteed | sales-non-guaranteed`) + flags (`refine`, `finalize`, `expiresAtGraceSeconds`, `dynamicProducts`, `rateCardPricing`, `availabilityReservations`).
- `Recipe` — typed `recipe_kind`-discriminated base. Adopters declare subtypes carrying their internal-config schema; the recipe rides on `Product.implementation_config` (opaque to buyers, persisted by the framework through the proposal lifecycle).
- `CapabilityOverlap` — typed declaration of which wire capabilities the buyer can configure on a product (`pricingModels`, `targetingDimensions`, `deliveryTypes`, `signalTypes`). Each axis is `ReadonlySet<string> | undefined`.
- `ProposalStore` interface + `InMemoryProposalStore` reference impl — single ledger across the lifecycle states `DRAFT → COMMITTED → CONSUMING → CONSUMED`, with reverse-index by `mediaBuyId`. Two-phase consume (`tryReserveConsumption` + `finalizeConsumption` / `releaseConsumption`) prevents the inventory double-spend race; cross-tenant probes return `null` to defeat principal enumeration.
- `MockProposalManager` — fetch-based forwarder that POSTs `getProducts` / `refineProducts` to a running `bin/adcp.js mock-server <specialism>`. Adopters who don't yet have proposal logic point this at the appropriate mock-server and ship a working seller agent with zero adopter code on the proposal side.
- `FinalizeProposalRequest` / `FinalizeProposalSuccess` — framework-internal shapes for the finalize lifecycle (commit hook).

**Status**: primitives only. Framework dispatch wiring (the five seams that intercept `getProducts`, `createMediaBuy`, `updateMediaBuy`, `getMediaBuyDelivery` to persist drafts, hydrate recipes, and commit on finalize) lands in a follow-up release.

**Breaking change — migration guide**: removes the pre-v6 stub `ProposalManager` class, `AIProposalManager` subclass, `defaultProposalManager` singleton, `IProposalManager` interface, `ProposalContext` shape, and `ProposalErrorCodes` constant from `@adcp/sdk` (previously exported under `src/lib/adapters/proposal-manager.ts`).

The stub had no observable behavior — `isSupported()` returned `false` everywhere, `generateProposals()` and `refineProposal()` returned `[]` / `null` regardless of input. No path inside the SDK invoked it. Adopters who imported it were holding a placeholder.

**If your code imports any of these names**, search-replace and migrate to the new surface:

```diff
- import { ProposalManager, AIProposalManager, defaultProposalManager, type IProposalManager } from '@adcp/sdk';
+ import {
+   type ProposalManager,
+   type ProposalCapabilities,
+   type Recipe,
+   InMemoryProposalStore,
+   MockProposalManager,
+ } from '@adcp/sdk/server';
```

The new `ProposalManager` is an *interface* (typed contract), not a class to extend. Adopters write a plain object that satisfies it:

```ts
const myProposalManager: ProposalManager<MyRecipe, MyTenantMeta> = {
  capabilities: { salesSpecialism: 'sales-guaranteed', refine: true, finalize: true },
  async getProducts(req, ctx) { /* ... */ },
  async refineProducts(req, ctx) { /* ... */ },
  async finalizeProposal(req, ctx) { /* ... */ },
};
// Wire on the platform:
const platform = { capabilities: { ... }, accounts: ..., proposalManager: myProposalManager, sales: ... };
```

`MockProposalManager` is a concrete class (the only one in the new surface) — fetch-based forwarder for adopters wrapping a running `bin/adcp.js mock-server <specialism>`. Replaces the old `defaultProposalManager` singleton's role as a "no-op default."

The old `ProposalErrorCodes` constants map onto AdCP standard codes the framework now emits directly (`PROPOSAL_NOT_FOUND`, `PROPOSAL_NOT_COMMITTED`, `PROPOSAL_EXPIRED`, `INVALID_REQUEST`, `UNSUPPORTED_FEATURE`). Adopters throwing `AdcpError` with these codes get the same wire envelopes; no separate constant is needed.
