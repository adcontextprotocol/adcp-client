---
'@adcp/sdk': minor
---

feat(mock-server, sales-guaranteed): forecast and availability endpoints (closes #1375)

Adds `POST /v1/forecast` and `POST /v1/availability` to the sales-guaranteed mock so the worked adapter for guaranteed sellers exercises `Product.forecast` instead of returning the seed's static `availability` field. Real GAM/FreeWheel/Operative integrations spend most of their API time on forecast/availability calls; the prior mock surface was order/lineitem-only, so adopters who forked the example hit "where's the forecast call?" with no example to follow.

**New endpoints**

- `POST /v1/forecast` — per-query `DeliveryForecast` for one product. Returns `forecast_range_unit: 'availability'` when budget is omitted (the GAM availability check), `'spend'` when budget is supplied (a budget→outcome curve). Deterministic-seeded on `(product_id, targeting, dates)` so storyboard graders can assert exact numbers.
- `POST /v1/availability` — multi-item dry-run that mirrors GAM's `getCompetitiveForecast` semantics: items are evaluated in order and earlier reservations reduce the supply visible to later ones. Returns per-item `forecast`, three-tier `tier_pricing` rate cards, and a `conflicts` array when supply is exhausted.
- `GET /v1/products` — accepts `targeting`, `flight_start`, `flight_end`, `budget` query params and embeds a per-query `forecast` field on each returned product when any are present (back-compat: omit the params, get the static catalog).

The response shapes match `/schemas/3.0.4/core/delivery-forecast.json` field-for-field so adapters project to `Product.forecast` with no field renaming. `forecast.method` is `'guaranteed'` for availability checks (matching the AdCP enum description: "Contractually committed delivery levels backed by reserved inventory") and `'modeled'` for spend curves. The seller-skill specialism doc (`skills/build-seller-agent/specialisms/sales-guaranteed.md`) gains a worked `getProducts` snippet that compiles under `npm run typecheck:skill-examples` (CI-gated; was previously fragment-shape and skipped).

Also fixes a determinism bug in the targeting hash: `serializeTargeting` now uses a recursive deterministic stringifier instead of `JSON.stringify(t, Object.keys(t).sort())`, which was using arg 2 as a key allowlist and silently dropping every nested object's contents (two targeting specs differing only in nested fields hashed identically). Adds NaN/Infinity guards on `?budget=` / `?flight_start=` query params so garbage input falls back to the no-forecast path instead of poisoning the response with `null`s.
