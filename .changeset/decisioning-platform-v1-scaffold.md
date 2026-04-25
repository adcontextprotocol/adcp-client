---
'@adcp/client': patch
---

**Preview: `DecisioningPlatform` v1.0 type scaffold** (`src/lib/server/decisioning/`). Lands the type surface for the v6.0 framework refactor — adopters describe their decisioning system once via per-specialism interfaces (`SalesPlatform`, `CreativeTemplatePlatform`, `CreativeGenerativePlatform`, `AudiencePlatform`) and the framework owns wire mapping, account resolution, async tasks, status normalization, and lifecycle state. No runtime wiring yet; types are not exported from any public subpath.

Validated against four real adapter codebases — Innovid training-agent, GAM, Scope3 `agentic-adapters` (13 platform adapters), and Prebid `salesagent` (6 platform adapters in Python). Migration sketches in `docs/proposals/decisioning-platform-{training-agent,gam,scope3,prebid}-migration.md`.

Validation surfaced convergent must-fixes that have been applied to the scaffold:

- `TargetingCapabilities` filled in (per-geo-system shape that Scope3 and Prebid independently shipped — `geo_metros`, `geo_postal_areas`, `geo_proximity`, `age_restriction`, keyword match types)
- `ReportingCapabilities.availableDimensions` typed enum
- `AccountStore.resolution: 'explicit' | 'implicit'` (LinkedIn pre-sync vs inline `account_id`)
- `AccountNotFoundError` throw-class with narrow-use semantics
- `supportedBillings` + `requireOperatorAuth` on `DecisioningCapabilities` (operator-billed retail media)
- JSDoc: `TaskUpdate` monotonicity / bounce-back semantics, `StatusMappers` decoder-vs-rollup boundary, `updateMediaBuy` patch-vs-verb local dispatch idiom, framework `dry_run` interception

Status: Preview / 6.0. Wiring lands in a follow-up PR with the framework refactor.
