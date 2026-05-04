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

**Breaking change**: removes the pre-v6 stub `ProposalManager` / `AIProposalManager` / `defaultProposalManager` exports under `src/lib/adapters/`. The stub had no observable behavior (`isSupported() === false` everywhere) and would have collided with the new sibling-platform shape. Adopters with code referencing the stub names should remove those imports — the new `ProposalManager` interface lives at `@adcp/sdk/server`.
