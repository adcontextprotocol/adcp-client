# DecisioningPlatform v1.0 — adopter questions answered

Questions raised by Scope3 (`agentic-adapters`) and Prebid (`salesagent`) teams during round-3 review of PR #1005. Answers below; substantive items also fold into the proposal docs and JSDoc.

## 1. Per-call context schemas (Scope3)

> How are TikTok `advertiser_id` / Google `login_customer_id` / Flashtalking `library_id` per-tool context shapes intended to flow under v1.0? Right now we Zod-validate them via `getContextSchema()`. The proposal's `Account.metadata: TMeta` covers resolved-once shape, not per-call shape.

**Answer**: under v1.0 these flow through `Account.metadata` after `accounts.resolve()`. Specifically:

- The buyer's authentication grants access to a set of platform sub-tenants (TikTok advertisers, Google login customers, Flashtalking libraries). `accounts.resolve()` fetches the full set and returns the `Account` with `metadata` carrying the resolved tuple.
- Per-tool calls reference the right sub-tenant via fields on the wire request itself (e.g., `account_id` resolves the correct advertiser_id; `package_id` carries enough context for Flashtalking library routing).

For platforms where the buyer needs to disambiguate at call time (e.g., one auth principal grants access to 5 TikTok advertisers and the buyer must pick one per request), today's options:

- (a) The buyer references a specific advertiser via `AccountReference.account_id` — your `accounts.resolve()` returns an `Account` scoped to that advertiser. This is the spec-clean path.
- (b) Until v1.1 ships per-call context schemas, platform-specific request fields (e.g., `tiktok_advertiser_id`) live in your wire request validators. You attach a Zod check in your platform's request preprocessing layer; the framework's request validation honors it.

**v1.1 plan**: a `getRequestContextSchema?<TTool>(tool: ToolName): ZodSchema<TToolContext>` optional method on `DecisioningPlatform` that lets the platform attach Zod schemas per tool; framework runs them after the spec's wire validation but before dispatch. Tracked as a v1.1 explicit deliverable in `docs/proposals/decisioning-platform-v1.md`.

## 2. Migration coexistence (Scope3)

> Can adopters run handler-style `createAdcpServer` AND `DecisioningPlatform`-style in the same process during transition? Or is it rip-and-replace at v6?

**Answer**: rip-and-replace per-server, but adopters running multiple servers in one process can stage. Two reasons:

- A single `createAdcpServer<P>()` call resolves to one platform shape. Mixing handler-style and DecisioningPlatform-style in one server means the framework would need to dispatch to two different layers per request, which loses the type-level guarantees.
- The framework itself ships v6.0 as a single semver bump. Adopters who pin `@adcp/client@5.18` keep handler-style; adopters who upgrade to `@adcp/client@6.0` use DecisioningPlatform. Mixed deployments work cross-server (one server on 5.x, another on 6.0) but not in-process.

**Migration path** for adopters with N servers:
1. Start with the easiest server (training-agent or a single-specialism adapter).
2. Migrate one server, validate against the comply storyboards.
3. Migrate the rest in a fleet sweep — by then the framework's behavior is well-characterized.

Adopters running the comply test harness can validate either shape during the transition; the storyboards are framework-agnostic.

## 3. comply_test_controller fit (Scope3)

> Does v6 close issue #1002 (controller read-path interception for proxy sellers) by default, or is that still a separate flag? If v6 owns more lifecycle state, they could plumb stateStore-first reads more naturally.

**Answer**: yes, v6 should close #1002 by default for the comply test controller surface. The framework already owns lifecycle state via `ctx.state.findByObject(...)` and `ctx.state.workflowSteps()`. When the comply controller is active, the framework consults `stateStore` first on every state-read tool (`get_media_buys`, `get_media_buy_delivery`, `list_creatives`, `get_audience_status`); only falls through to the platform when state is absent. Proxy sellers get correct fixture-replay semantics without the platform implementing controller-aware reads.

The wiring lives in the framework (the request pipeline) and is a single `consultStateStoreFirst` flag on `createAdcpServer({ comply: { enabled: true } })`. Platforms don't see this — they implement reads against their real platform; the framework decides whether to short-circuit.

Tracked for v6.0-rc.1 in the MCP+A2A unified serving design (`docs/proposals/mcp-a2a-unified-serving.md` § Implementation phases).

## 4. Wiring PR timing + early-adopter spike (Scope3 + Prebid)

> Once the wiring PR lands, we'd want to do a one-adapter spike (probably snap, our most-validated) before committing the full fleet.

**Answer**: yes, that's the recommended sequence and what the framework refactor PR will explicitly support.

**Phase 1 (v6.0-alpha.1)** — types-only scaffold (this PR, #1005). Reviewable, not yet runtime.

**Phase 2 (v6.0-alpha.2)** — first runtime: `createAdcpServer<P>` accepts `DecisioningPlatform` and dispatches via the new path. Old handler-style API remains intact in v5.x; v6.0-alpha lets early adopters spike against the new shape.

**Phase 3 (v6.0-rc.1)** — full wire mapping for both transports; per-tool overrides; full async lifecycle; sandbox boundary plumbed through `accounts.resolve()`.

**Phase 4 (v6.0-rc.2)** — comply storyboard parity verified end-to-end across a representative adopter set (training-agent + GAM + one Scope3 adapter (Snap) + one Prebid adapter (GAM-via-Prebid)). Anyone who doesn't pass storyboards in alpha.2 has a chance to surface gaps.

**Phase 5 (v6.0 GA)** — `@adcp/client@6.0` published; v5.x enters maintenance mode.

The Snap spike from Scope3 should land in alpha.2 — that's the right amount of validation against a real adapter before fleet migration.

## 5. Multi-error pre-flight ergonomics (Prebid)

> Pushing all validation into `createMediaBuy` returning rejected early means every entry point duplicates the same checks. DRY says extract a method on the platform; that's fine, but the framework can't introspect those checks for `get_adcp_capabilities` consistency.

**Answer**: addressed via `aggregateRejected(errors)` helper (shipped in this PR — see `src/lib/server/decisioning/async-outcome.ts`). Adopters extract a `preflight(req)` method on the platform that returns `ReadonlyArray<AdcpStructuredError>`; entry-method bodies start with:

```ts
const errors = this.preflight(req);
if (errors.length > 0) return aggregateRejected(errors);
```

Multi-error pre-flight is preserved (the helper folds the array into one envelope with `details.errors: [...]` for the buyer to consume); platform-level DRY is preserved (one `preflight()` method, called from each entry).

The "framework can't introspect checks for `get_adcp_capabilities` consistency" concern remains valid for cases where validation rules ARE the capability declaration (e.g., "this platform validates `pricing.model === 'cpm'`"). Recommendation: declare those rules in `capabilities` (e.g., `pricingModels: ['cpm']`); the framework auto-validates against the declaration before the platform sees the request. Platform-internal validation is for rules NOT expressible in the capability surface.

## 6. "Buy created, paused, awaiting review" pattern (Prebid)

> Today salesagent can return a synchronous MediaBuy with `workflow_step_id` and `status: paused`. Under the new design that's just `submitted` — buyer doesn't see the buy until approval. The PR's answer (`partialResult` in the task envelope) is plausible but `partialResult` isn't on `AsyncOutcomeSubmitted` in the types as written.

**Answer**: fixed. `AsyncOutcomeSubmitted` now carries `partialResult?: TResult`. Updated `submitted(handle, opts)` accepts `opts.partialResult`. Framework projects this onto the wire so MCP buyers see `structuredContent.partial_result` and A2A buyers see it in the artifact data alongside `adcp_task_id`. The terminal value flows through `taskHandle.notify({ kind: 'completed', result })` as before. Type-level test added in `decisioning.type-checks.ts`.

## 7. `dry_run` debugging mode (Prebid)

> salesagent's adapters use dry-run as a "validate-against-real-platform-but-don't-write" debugging mode — that's a different semantic the framework interception throws away.

**Answer**: AdCP 3.0 expresses this through `AccountReference.sandbox: true` instead. Sandbox subsumes the framework-level "don't write to production" mode. Tool-specific `dry_run` flags on `sync_catalogs` and `sync_creatives` remain wire fields (the platform receives and honors them locally — useful for catalog/creative validation without committing to platform state).

Updated in `platform.ts` JSDoc + `mcp-a2a-unified-serving.md` § Idempotency, signing, validation, sandbox.

## 8. Python port (Prebid)

> A Python port mostly works, with two real costs: compile-time capability gating becomes runtime validation, and generics ergonomics get weaker. Both are survivable, neither is free.

**Answer**: full Python port plan in `docs/proposals/decisioning-platform-python-port.md`. Core bits:
- `AsyncOutcome` ports as a Pydantic discriminated union.
- `RequiredPlatformsFor<S>` becomes a runtime `validate_platform()` check at server boot.
- Generics ergonomics weaker; default to `metadata: dict[str, Any]` with a documented upgrade path to typed Pydantic submodels.
- `mypy --strict` is the supported development experience.
