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

After adopter feedback (Prebid `salesagent` + Scope3 `agentic-adapters` teams), additional fixes:

- `AsyncOutcomeSubmitted.partialResult?: TResult` — preserves the "buy created in PENDING_APPROVAL state, buyer should see it now" pattern. Framework projects to `structuredContent.partial_result` (MCP) and artifact data (A2A).
- `aggregateRejected(errors[], opts?)` helper — multi-error pre-flight rejection (Prebid's `validate_media_buy_request → list[str]` pattern). First error becomes the canonical envelope; rest land in `details.errors`. Adopters extract a `preflight()` method and call from each entry-method body, preserving DRY.
- `dry_run` framework-interception language removed. AdCP 3.0 expresses "validate against real platform without writing to production" via `AccountReference.sandbox: true` — framework resolves the buyer's sandbox account through `accounts.resolve()`; platform routes reads/writes to its sandbox backend. Tool-specific `dry_run` flags on `sync_catalogs` and `sync_creatives` remain wire fields the platform receives and honors locally.

Companion docs added:
- `docs/proposals/mcp-a2a-unified-serving.md` — locks how `serve(platform)` projects one DecisioningPlatform onto MCP and A2A transports
- `docs/proposals/decisioning-platform-python-port.md` — cross-language port plan (`__init_subclass__` runtime check + Pydantic generics ergonomics in lieu of TS compile-time gates)
- `docs/proposals/decisioning-platform-adopter-questions.md` — round-3 review answers (per-call context schemas → v1.1; migration coexistence → rip-and-replace per-server; comply_test_controller → framework-owned by default in v6; wiring PR phasing through alpha.2 → rc.1 → rc.2 → GA)

v6.0 alpha runtime spike (`src/lib/server/decisioning/runtime/`):

- `createAdcpServerFromPlatform(platform, opts)` — runtime entry that accepts a `DecisioningPlatform` impl and returns an `AdcpServer`. Implemented as a thin adapter over the existing `createAdcpServer()`: framework primitives (idempotency, RFC 9421 signing, governance, schema validation, state store, MCP/A2A wire mapping, sandbox boundary) apply unchanged; the new code is the translation shim, not a forked runtime.
- `validatePlatform(platform)` — runtime check that claimed `capabilities.specialisms[]` match implemented per-specialism interfaces. Mirrors the compile-time `RequiredPlatformsFor<S>` gate; throws `PlatformConfigError` with a "claimed X; missing Y" diagnostic. The substitute for the TS compile-time gate when the platform is constructed from JS or relaxed-tsconfig contexts.
- `buildRequestContext(handlerCtx)` — translates the framework's `HandlerContext` into the v6 `RequestContext` shape platform methods expect. v1.0 wires `account`; `state.*` and `resolve.*` are stubbed and arrive incrementally over subsequent commits.
- `projectAsyncOutcome(outcome, mapResult)` — `AsyncOutcome<T>` → existing handler return projection. v6.0 alpha implements `sync` + `rejected`; `submitted` lands with task-envelope wiring in the next commit.
- Wired surface (this commit): `getProducts` from `SalesPlatform`, plus `accounts.resolve()` (with `AccountNotFoundError` catch).
- Smoke tests pass: build server from platform, dispatch `get_products` end-to-end, ACCOUNT_NOT_FOUND envelope on AccountNotFoundError throw.

Status: Preview / 6.0. The runtime is not yet exported from `./server`; reach in via `@adcp/client/server/decisioning/runtime` for spike experimentation only. Subsequent commits expand the wired tool surface and ship the public export. Companion design doc at `docs/proposals/mcp-a2a-unified-serving.md`.
