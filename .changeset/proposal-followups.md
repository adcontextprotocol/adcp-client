---
'@adcp/sdk': minor
---

**ProposalManager v1.5 follow-ups** — addresses every actionable concern from the parallel expert review on PR #1557 (code-reviewer / ad-tech-protocol-expert / security-reviewer / adtech-product-expert).

### Wire-leak prevention: strip `Product.implementation_config`

Recipe data (`network_code`, `ad_unit_ids`, `line_item_template_id`, GAM line-item priority) rides on `Product.implementation_config` server-side as the typed contract between `ProposalManager` and `DecisioningPlatform`. The wire schema is `additionalProperties: true` so the field is technically legal on the wire — but emitting it leaks publisher topology to buyers. The framework now runs `stripImplementationConfig` at the dispatcher response-boundary chokepoint right after `stripCtxMetadata`, parallel pattern. New helpers `stripImplementationConfig` + `hasImplementationConfig` re-exported from `@adcp/sdk/server`. Test coverage in `test/lib/proposal-implementation-config-strip.test.js`.

**Also fixes a pre-existing latent leak surfaced by security review on this PR:** `dispatchHitl` (the framework's task-handoff completion path used by `createMediaBuy` HITL, `syncCreatives` HITL, and now `finalizeProposal` HITL) wrote the projected handoff result directly to `taskRegistry.complete` and `emitTaskWebhook` without running the wire-strip chokepoint. `tasks/get` polling and webhook delivery emitted server-only fields verbatim. Both strips (`stripCtxMetadata` + `stripImplementationConfig`) now run inside `dispatchHitl` before the registry write, so every downstream consumer inherits clean state. Companion regression test in `test/lib/proposal-manager-e2e.test.js` exercises the full HITL → tasks/get round-trip and asserts no leak.

**And one carrier alignment**: extended `CARRIER_KEYS` (the shared list both strips walk) to include `proposal` / `proposals`. Without it, `ctx_metadata` and `implementation_config` on `proposals[].products[]` survived the strip — proposal-mode-specific carrier the existing carrier list didn't anticipate. The implementation_config strip now reuses the shared `CARRIER_KEYS` constant rather than maintaining its own list, so future spec additions can't silently extend one strip and not the other.

### Recipe rename: `KevelLikeRecipe` → `AuctionLikeRecipe`

Conflating a decision-engine (Kevel) with a wire protocol (OpenRTB) under one `recipe_kind: 'kevel'` was a category error per product-expert review. Renamed to `AuctionLikeRecipe` (generic across auction-cleared remnant backends) with `recipe_kind: 'auction'`. Adopters who want sharper-typed shapes declare their own `recipe_kind: 'kevel' | 'openrtb' | 'beeswax' | ...` subtype on top.

Breaking but pre-release (this is the first v1.5 release going out): adopters updating from a build of this branch's earlier commits replace `KevelLikeRecipe` → `AuctionLikeRecipe`, `buildKevelLikeRecipe` → `buildAuctionLikeRecipe`, `KEVEL_LIKE_OVERLAP` → `AUCTION_LIKE_OVERLAP`, and `recipe_kind: 'kevel'` → `recipe_kind: 'auction'` in their recipe shapes.

### Recipe extensibility: `extensions` slot

Both `GAMLikeRecipe` and `AuctionLikeRecipe` gain an optional `extensions?: Record<string, unknown>` field. Adopters carrying richer upstream payloads (GAM `creative_placeholders`, Kevel `frequency_caps`, OpenRTB `private_auction`, FreeWheel `placement_types`, Operative `revenue_type`) use this slot rather than forking `recipe_kind` into N variants. Adopters with stricter shape requirements declare a typed subtype literal on top.

### HITL finalize cancel-race documentation

Inline comment in `runtime/from-platform.ts` at the finalize-intercept site documents the known gap: if the buyer calls `tasks/cancel` while the adopter's HITL `finalizeProposal` handoff is still mid-run, the framework marks the task cancelled but `intercept.project` (which fires when the handoff resolves) still runs `store.commit`. Same gap exists for `createMediaBuy` HITL today. Mitigations: 7-day eviction window in `InMemoryProposalStore`, optional sweep against the task registry by production durable stores. End-to-end fix requires AbortSignal propagation into projection callbacks — framework-level, not finalize-specific.

### `projectFinalizeResponse` products echo: explicit decision

Inline comment documents the `products: []` choice. Echoing on finalize would either re-emit from the persisted draft (extra wire bytes the buyer already has from the prior `brief_with_proposals` step) or call back into the adopter (extra round-trip). Buyers who explicitly want products on the finalize response fetch via `get_products({ product_ids: [...] })` keyed off `proposals[0].allocations[].product_id`.

### Spec issue filed

`adcp#4107` — clarifies `refine[]` mixed-action semantics when `finalize` is one of multiple entries. The spec is silent today; `adcp-client` and `adcp-client-python` both implement first-finalize-only by convention. Once the spec picks one of the recommended contracts, both SDKs align.
