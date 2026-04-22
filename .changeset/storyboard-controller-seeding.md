---
'@adcp/client': minor
---

Storyboard runner auto-fires `comply_test_controller` seed scenarios from the `fixtures:` block (adcp-client#778).

When a storyboard declares `prerequisites.controller_seeding: true` and carries a top-level `fixtures:` block, the runner now issues a `comply_test_controller` call per fixture entry before phase 1:

- `fixtures.products[]` → `seed_product`
- `fixtures.pricing_options[]` → `seed_pricing_option`
- `fixtures.creatives[]` → `seed_creative`
- `fixtures.plans[]` → `seed_plan`
- `fixtures.media_buys[]` → `seed_media_buy`

Each entry's id field(s) ride on `params`; every other field is forwarded verbatim as `params.fixture`. The seed pass surfaces as a synthetic `__controller_seeding__` phase in `StoryboardResult.phases[]` so compliance reports distinguish pre-flight setup from per-step buyer behavior.

**Grading semantics:**

- Seed failure cascade-skips remaining phases with **detailed** `skip_reason: 'controller_seeding_failed'` and **canonical** `skip.reason: 'prerequisite_failed'` — respects the runner-output-contract's six canonical skip reasons (`controller_seeding_failed` is a new `RunnerDetailedSkipReason`, not a new canonical value).
- Agent not advertising `comply_test_controller` → cascade-skips with canonical `skip.reason: 'missing_test_controller'`, implementing the spec's `fixture_seed_unsupported` not_applicable grade. No wire calls are issued.
- Multi-pass mode seeds exactly once at the run level (inside `runMultiPass`) instead of N times inside each pass — avoids inflating `failed_count` / `skipped_count` by N when a fixture breaks.

**Closes the spec-side/seller-side gap.** The `fixtures:` block (adcontextprotocol/adcp#2585, rolled out in adcontextprotocol/adcp#2743) and the `seed_*` scenarios (adcontextprotocol/adcp#2584, implemented here as `SEED_SCENARIOS` + `createSeedFixtureCache`) shipped without runner glue. Storyboards like `sales_non_guaranteed`, `creative_ad_server`, `governance_delivery_monitor`, `media_buy_governance_escalation`, and `governance_spend_authority` go from red to green against sellers that implement the matching `seed*` adapters.

**New `StoryboardRunOptions.skip_controller_seeding`.** Opt out of the pre-flight for agents that load fixtures via a non-MCP path (HTTP admin, test bootstrap, inline Node state) — the runner then skips the seed loop even when the storyboard declares it.

**Types.** `Storyboard.prerequisites.controller_seeding?: boolean`, `Storyboard.fixtures?: StoryboardFixtures`, and `StoryboardFixtures` are now part of the public type. `RunnerDetailedSkipReason` gains `'controller_seeding_failed'` mapped to canonical `'prerequisite_failed'` via `DETAILED_SKIP_TO_CANONICAL`.
