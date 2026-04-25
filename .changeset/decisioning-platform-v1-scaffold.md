---
'@adcp/client': patch
---

**Preview: `DecisioningPlatform` v1.0 type scaffold** (`src/lib/server/decisioning/`). Lands the type surface for the v6.0 framework refactor — adopters describe their decisioning system once via per-specialism interfaces (`SalesPlatform`, `CreativeTemplatePlatform`, `CreativeGenerativePlatform`, `AudiencePlatform`) and the framework owns wire mapping, account resolution, async tasks, status normalization, and lifecycle state. No runtime wiring yet; types are not exported from any public subpath.

Validated against four real adapter codebases — Innovid training-agent, GAM, Scope3 `agentic-adapters` (13 platform adapters), and Prebid `salesagent` (6 platform adapters in Python). Migration sketches in `docs/proposals/decisioning-platform-{training-agent,gam,scope3,prebid}-migration.md`.

Validation surfaced convergent must-fixes that have been applied to the scaffold:

- `TargetingCapabilities` filled in (per-geo-system shape that Scope3 and Prebid independently shipped — `geo_metros`, `geo_postal_areas`, `geo_proximity`, `age_restriction`, keyword match types)
- `ReportingCapabilities.availableDimensions` typed enum
- `AccountStore.resolution: 'explicit' | 'implicit' | 'derived'` (LinkedIn pre-sync vs inline `account_id` vs single-tenant derived-from-auth)
- `AccountNotFoundError` throw-class with narrow-use semantics ("throwable only from `AccountStore.resolve()`")
- `supportedBillings` + `requireOperatorAuth` on `DecisioningCapabilities` (operator-billed retail media)
- `Account.billing?: { invoicedTo: 'agent' | 'operator' | BrandReference }` for operator-billed settlement boundary
- JSDoc: `TaskUpdate` monotonicity / bounce-back semantics, `StatusMappers` decoder-vs-rollup boundary, `updateMediaBuy` patch-vs-verb local dispatch idiom, framework `dry_run` interception

After expert review (round 3 — protocol, product, DX, code-reviewer in parallel), additional fixes:

- `RequestContext` wired into every specialism method signature — `(req, ctx)` instead of `(req, account)`. Adopters access `ctx.account`, `ctx.state.workflowSteps()`, `ctx.resolve.creativeFormat()`. Closes the DX gap where the training-agent migration sketch promised `ctx.state.*` but methods only received `Account`.
- `RequiredPlatformsFor<S>` refactored to nested conditionals so missing-specialism produces a legible "Property 'sales' is missing" error rather than the unactionable "does not satisfy constraint 'never'."
- `ErrorCode` expanded from 30 to 45 codes to match `schemas/cache/3.0.0/enums/error-code.json`. Added: `INVALID_STATE`, `MEDIA_BUY_NOT_FOUND`, `NOT_CANCELLABLE`, `PACKAGE_NOT_FOUND`, `CREATIVE_NOT_FOUND`, `SIGNAL_NOT_FOUND`, `SESSION_NOT_FOUND`, `PLAN_NOT_FOUND`, `REFERENCE_NOT_FOUND`, `SESSION_TERMINATED`, `PRODUCT_EXPIRED`, `PROPOSAL_NOT_COMMITTED`, `IO_REQUIRED`, `REQUOTE_REQUIRED`, `CAMPAIGN_SUSPENDED`, `GOVERNANCE_UNAVAILABLE`, `CREATIVE_DEADLINE_EXCEEDED`. `ErrorCode` now exported from `index.ts`.
- `AdcpStructuredError` carries spec-required `field?`, `suggestion?`, `retry_after?` fields (matching `schemas/cache/3.0.0/core/error.json`).
- `getCapabilitiesFor?(account)` per-tenant capability override on `DecisioningPlatform`. Multi-tenant SaaS adopters scope capabilities per resolved Account.
- Helpers shipped: `unimplemented<T>()` for stubbing methods (returns `rejected({ code: 'UNSUPPORTED_FEATURE', recovery: 'terminal' })`); `identityStatusMappers` for platforms whose native statuses already match AdCP enums.
- `platform.ts` JSDoc clarifies the "framework owns X" claims are forward-looking design intent for v6.0 wiring, not current behavior.

Status: Preview / 6.0. Wiring lands in a follow-up PR with the framework refactor. Companion design doc for MCP+A2A unified serving in `docs/proposals/mcp-a2a-unified-serving.md`.
