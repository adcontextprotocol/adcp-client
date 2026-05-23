---
'@adcp/sdk': patch
---

fix(storyboard): align `schemaAllowsTopLevelField` with `additionalProperties: true` requests (#1955 sub-piece 1)

AdCP 3.1.0-beta.3 set `additionalProperties: true` on mutating request schemas (vendor-extension friendly). Before that flip, `schemaAllowsTopLevelField` used `additionalProperties: false` as the gate: "if the schema is strict, only `properties` keys are allowed". Now that requests are universally permissive at the schema level, the old gate said `true` for any field on any request — defeating the storyboard runner's intent ("only inject envelope fields the tool's schema declares it expects to see").

The helper now checks `field in properties` directly. The question we actually care about is **"does the schema declare this field at top level?"**, not "does the schema permit this field at top level?" (it permits everything since 3.1.0-beta.3).

Concrete impact: the storyboard runner's `applyBrandInvariant` now correctly skips top-level `brand` injection on tools that don't declare it (e.g. `sync_plans`, `list_creatives`, `list_property_lists` carry brand inside `account.brand`), while still injecting on tools that DO declare it (e.g. `get_products`). Same logic governs the synthetic `account` injection and `ext` propagation.

Test fixture update: the `runStoryboard: brand invariant on the wire` test's assertion is broadened from "every step carries top-level `brand`" to "the configured BRAND is reachable from the wire request — either at top level OR via `account.brand`". This matches the actual invariant the runner enforces post-3.1-beta-3, where many tools carry brand only via the account ref.

22/22 tests in `storyboard-brand-invariant.test.js` now pass. No regressions in `storyboard-drift.test.js` (still 700/712 — those are the 6 YAML drift items tracked separately in #1955) or `storyboard-security.test.js` (97/98 — the `comply()` degraded-profile item tracked in #1955). Sub-pieces 2 (YAML drift), 3 (completeness builders), and 4 (security fallback) remain.
