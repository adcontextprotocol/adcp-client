---
'@adcp/sdk': minor
---

feat(mock-server): `sales-non-guaranteed` — programmatic auction with sync confirmation + spend-only forecast. Closes #1457 (sub-issue of #1381).

Sixth mock-server in the matrix v2 family. Programmatic-auction shape closest to DSP-side sellers, retail-media remnant, header-bidding inventory, and any non-walled-garden seller that doesn't run HITL approval. Companion to the `hello_seller_adapter_non_guaranteed.ts` worked adapter (sub-issue #1458) which wraps it.

**Pattern modeled on `sales-guaranteed/`** with these auction-specific deltas:

- **Order confirmation is sync.** `POST /v1/orders` returns `status: 'confirmed'` immediately. No `pending_approval` task; no `approval_task_id`; no `/v1/tasks/{id}` polling endpoint.
- **Pricing is floor-based.** `MockProduct.pricing.min_cpm` (floor) + optional `target_cpm` (typical clearing CPM). Effective CPM at the requested budget = `target_cpm` if set, saturating toward `2 × min_cpm` at high budgets via an auction-pressure curve.
- **Forecast is spend-only.** `forecast_range_unit: 'spend'`, `method: 'modeled'`. No `availability` unit — auction mocks don't pre-commit inventory. `min_budget_warning` surfaces when the requested budget is below the product's `min_spend` learning-phase floor.
- **Delivery scales with `(budget × elapsed_pct × pacing_curve)`.** Three pacing modes: `even` (linear), `asap` (3× front-load capped at 100%), `front_loaded` (sqrt curve). CTR baselines per channel (display 0.1%, video 0.5%, ctv/audio 0.1%).
- **No CAPI / conversions surface.** Out of scope per #1457 — programmatic remnant rarely round-trips conversions to seller.

**Headline routes:**

```
GET    /_lookup/network?adcp_publisher=...    # blind-LLM operator routing (no auth)
GET    /_debug/traffic                         # façade-detection counters (no auth)
GET    /v1/inventory                           # network-scoped ad units
GET    /v1/products                            # productized inventory (floor pricing)
GET    /v1/products?targeting=&...&budget=     # products with per-query inline forecast
POST   /v1/forecast                            # spend-only forecast curve
GET    /v1/orders                              # list orders
POST   /v1/orders                              # create — sync confirmed (no HITL)
GET    /v1/orders/{id}                         # read
PATCH  /v1/orders/{id}                         # update budget / pacing / status
POST   /v1/orders/{id}/lineitems               # add line items
GET    /v1/orders/{id}/delivery                # synth (budget × pacing curve)
GET    /v1/creatives                           # list creatives
POST   /v1/creatives                           # upload creative
```

**Multi-tenancy** via `X-Network-Code` header (mirrors `sales-guaranteed`). Default static API key; OpenAPI spec deferred to follow-up. Storyboard-fixture-aligned networks seeded (`acmeoutdoor.example`, `pinnacle-agency.example`) so blind agents pass the lookup gate without contradicting the skill's "fail-closed-on-404" advice.

**17 smoke tests** in `test/lib/mock-server/sales-non-guaranteed.test.js` covering Bearer + X-Network-Code gating, lookup endpoint hit/miss, network-scoped products with floor-pricing assertion, per-query forecast embedding, deterministic-seeded forecast curves, `min_budget_warning` for sub-floor budgets, sync order confirmation (no `approval_task_id`), `budget_too_low` rejection, idempotency replay + 409 on body mismatch, delivery synthesis with pacing-curve differentiation, cross-network isolation, and traffic-counter façade detection.

Wire into `src/lib/mock-server/index.ts` via `case 'sales-non-guaranteed'`. Sixth specialism in the family.

Sub-issue #1458 (the worked adapter) blocks on this; #1461 (wire-up — README, hello-cluster live entry, skill-prose collapse) blocks on both.

**What's deferred** to follow-up PRs (not in scope for #1457 per the issue carve-out):

- `openapi.yaml` formal spec — pattern is straightforward to fill in once the route surface stabilizes.
- Storyboard CI gate — wired by sub-issue #1458 (the adapter PR) since the storyboard runner needs the adapter to drive it.
