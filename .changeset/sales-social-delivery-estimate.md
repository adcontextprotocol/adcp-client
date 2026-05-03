---
'@adcp/sdk': minor
---

feat(mock-server, sales-social): planning surface — delivery_estimate, audience_reach_estimate, lookalike (closes #1378)

Adds the Meta/TikTok/Snap/LinkedIn-style planning surface to the `sales-social` mock so adopters can wire `Product.forecast` from real walled-garden Marketing APIs instead of returning `forecast: undefined`. Per the issue's accepted framing, AdCP 3.0.4 already covers the surface — `forecast_range_unit: 'spend' | 'conversions' | 'reach_freq' | 'clicks'` was on the spec the whole time. The gap was that no example demonstrated the projection.

**New endpoints**

- `POST /v1.3/advertiser/{id}/delivery_estimate` — forward forecast (`budget` provided → reach/impressions/clicks/conversions/CPM/bid recommendation/delivery curve), or reverse forecast (`target_outcome` provided → `required_budget`, the Meta-style "tell me your goal, I'll tell you the budget" surface). CPM band varies by `optimization_goal` so the curve reflects auction realism (reach < clicks < conversions).
- `POST /v1.3/advertiser/{id}/audience_reach_estimate` — total audience size + platform-matchable subset for a targeting spec. Adopters use this to populate `Product.targeting_options` previews before the buyer commits.
- `POST /v1.3/advertiser/{id}/audience/{audience_id}/lookalike` — size + activation ETA estimate for a lookalike built from a seed audience, scaled by `similarity_pct` (1 = closest, 10 = broadest) and country. Mirrors Meta `customaudiences` lookalike subtype, TikTok `dmp/audience/save_lookalike`, Snap `lookalikes`.

All three are deterministic-seeded on the inputs (advertiser_id + targeting hash + goal/audience), so storyboards remain reproducible while different targeting hashes still produce visibly different curves.

CPM bands are calibrated to 2024-2026 walled-garden benchmarks: reach=$5, video_views=$8, engagement=$6, clicks=$11, conversions=$18 (was previously inverted — video < reach). CTR and conversion rate vary per `optimization_goal` so reach-goal reverse forecasts use saturating-curve inversion rather than back-deriving from conversion rate. The reverse-forecast budget is clamped to platform learning-phase floors ($5/day reach, $10/day clicks, $40/day conversions) and surfaces a `min_budget_warning` when the inferred budget falls below — the #1 surprise adopters hit when wiring real Meta/TikTok APIs. Lookalike sizing is now country-population-aware: `min(country_pop × similarity_pct/100, seed × multiplier)`, so a 1M-member seed in the US doesn't produce a 19M lookalike (Meta caps at country_pop × similarity_pct).

The seller-skill specialism doc (`skills/build-seller-agent/specialisms/sales-social.md`) gains a `### Planning surface` section with a field-map table (upstream `min/max` → AdCP `low/mid/high`, `daily_budget` → `points[].budget`, etc.) and a worked `getProducts` snippet that compiles under `npm run typecheck:skill-examples`.
