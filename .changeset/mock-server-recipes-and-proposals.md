---
'@adcp/sdk': minor
---

**Mock-server recipes + proposal lifecycle** — publish canonical {@link Recipe} shapes per sales specialism, plus add the proposal lifecycle endpoints to the `sales-guaranteed` mock. First step toward validating the v1.5 ProposalManager design against real adopter shapes.

**New canonical recipes** (re-exported from `@adcp/sdk/mock-server`):

- `GAMLikeRecipe { recipe_kind: 'gam', network_code, ad_unit_ids[], line_item_priority, pricing, delivery_type, availability_window?, min_spend?, upstream_ids? }` — for hello adapters wrapping a GAM-style guaranteed-direct upstream. Plus `GAM_LIKE_OVERLAP` (canonical `CapabilityOverlap`) and `buildGAMLikeRecipe(mockProduct)` builder.
- `KevelLikeRecipe { recipe_kind: 'kevel', network_code, zone_ids[], weight, pricing: { floor_cpm, target_cpm? }, goal_type, min_spend?, upstream_ids? }` — for hello adapters wrapping a Kevel/OpenRTB-style auction-cleared remnant upstream. Plus `KEVEL_LIKE_OVERLAP` and `buildKevelLikeRecipe(mockProduct)` builder.

The recipes are the typed contract between the adapter's ProposalManager and DecisioningPlatform: hello agents project these onto `Product.implementation_config`, the framework persists them through the proposal lifecycle, and `ctx.recipes` carries them back to `sales.createMediaBuy` / `sales.updateMediaBuy` so adapter code can drive the upstream off recipe fields without re-fetching.

**New `sales-guaranteed` mock-server endpoints** (the lifecycle-aware specialism):

- `POST /v1/proposals` — create draft from a brief; auto-allocates across guaranteed products (or filters to supplied `product_ids`); returns indicative pricing + draft state.
- `GET /v1/proposals/{id}` — read state.
- `POST /v1/proposals/{id}/refine` — apply allocation overrides + free-text steering hints (e.g. `ask: "shift to ctv"`); rejected on committed proposals.
- `POST /v1/proposals/{id}/finalize` — promote `draft → committed`, lock pricing (`indicative_cpm → locked_cpm`), allocate `upstream_line_item_template_id` per allocation, and set a 24h `expires_at` inventory hold. Idempotent on re-finalize.

The hello adapter's `proposalManager` will wrap these endpoints; `getProducts` becomes "list catalog + create draft proposal", `refineProducts` becomes "POST /refine", `finalizeProposal` becomes "POST /finalize". `sales.createMediaBuy(proposal_id)` reads the recipes from `ctx.recipes` (hydrated by the v1.5 framework dispatch wiring) to drive the upstream order creation against the locked line-item template ids.

`sales-non-guaranteed` stays catalog-only — no draft → committed lifecycle, since auction-cleared remnant sells "right of first refusal at floor" without a finalize step. The Kevel-like recipe still applies (it captures how to flight a bid into the auction); just no proposal stages.

**Lesson surfaced by the validation play:** the recipe `capability_overlap.pricingModels` and `deliveryTypes` axes must be *derived per-product from the product's actual wire shape*, not pulled from a static "what the platform supports" constant. The framework's `validateOverlapSubsetOfWire` correctly rejects the latter — a CPM-only product can't carry an overlap that claims `cpv` and `cpcv` even if the upstream platform supports them on other products. The `buildGAMLikeRecipe` / `buildKevelLikeRecipe` helpers now derive overlap fields from `product.pricing.model` and `product.delivery_type`. Lowercase pricing-model literals (`'cpm'`, `'cpv'`) match the AdCP wire enum.
