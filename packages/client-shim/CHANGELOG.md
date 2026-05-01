# @adcp/client

## 6.0.0

### Minor Changes

- a1c144f: Thread `ResolveContext` into `AccountStore.getAccountFinancials` and `AccountStore.reportUsage`; add `refAccountId` helper.

  Platforms fronting upstream billing APIs (Snap, Meta, retail-media) need the OAuth principal when posting usage rows or reading spend data. `getAccountFinancials` and `reportUsage` now accept an optional `ctx?: ResolveContext` second parameter carrying `authInfo` and `toolName` — the same pattern already established by `accounts.resolve`.

  `refAccountId(ref?)` is a new exported helper that safely extracts `account_id` from the `AccountReference` discriminated union, eliminating per-adopter casting boilerplate in `accounts.resolve` implementations.

  Both changes are non-breaking: existing `AccountStore` implementations that omit the second parameter compile and run unchanged.

- a1c144f: **Server-side error helpers: `normalizeErrors` + `pickSafeDetails`** (`@adcp/client/server`).

  Two general-purpose helpers every server adopter needs, exposed at the top-level `@adcp/client/server` subpath (not just `@adcp/client/server/decisioning`) so v5 handler-style adopters and v6 platform adopters both benefit.

  **`normalizeErrors(input) / normalizeError(input)`** — wire-shape coercer for the AdCP `Error` row used in tool responses carrying per-row failures (`sync_creatives`, `sync_audiences`, `sync_accounts`, `report_usage`, `acquire_rights` error arm). Adopters return errors in whichever shape their codebase already speaks: bare strings, native `Error` instances, plain `{ code, message }` objects, `AdcpError` instances, upstream-platform error objects with vendor-specific fields. The helper coerces all of those into the canonical wire `Error` shape (`code`, `message`, optional `field` / `suggestion` / `retry_after` / `details` / `recovery`) so the response validator accepts the projected envelope without forcing every adopter to hand-shape the wire response. Coercion rules: string → `{ code: 'GENERIC_ERROR', message, recovery: 'terminal' }`; `Error` instance → same with `err.message`; `AdcpError`-shaped object → field-whitelisted to wire shape (vendor-specific fields dropped — use `details` for vendor extensions); `null`/`undefined` → `{ code: 'GENERIC_ERROR', message: 'Unknown error', recovery: 'terminal' }`. Clamps `retry_after` to `[1, 3600]` per spec. Drops invalid `recovery` values silently. Falls back `message` to `code` when message is missing or empty.

  **Applied at the v6 framework wire-projection seam.** `createAdcpServerFromPlatform` now calls `normalizeErrors` on every `sync_creatives` row (sales + creative dispatch) before the wire response validator runs. Adopter code that returns `errors: ['format unsupported']` (string array) now passes strict response validation — the framework coerces to the canonical wire shape. v5 handler-style adopters can call `normalizeErrors` directly when they construct their `sync_creatives` responses.

  **`pickSafeDetails(input, allowlist, opts?)`** — security primitive for the `details` field on `AdcpError` and the `Error` wire row. Adopters fronting upstream platforms (GAM, Snap, retail-media APIs, internal billing systems) often want to surface upstream error context to buyers — but raw upstream errors carry credentials, PII, internal stack traces, request IDs that leak tenant identity, and other liability surfaces that MUST NOT cross the wire boundary. `pickSafeDetails` is an explicit-allowlist sanitizer: only keys in the allowlist survive, with default caps on depth (`maxDepth: 2`, top + 1 nested object level) and serialized size (`maxSizeBytes: 2048`). Returns `undefined` (not `{}`) when the result is empty or exceeds the size cap so callers can spread the value into an optional `details` field without polluting it.

  Adopter pattern:

  ```ts
  import { pickSafeDetails } from '@adcp/client/server';

  try {
    await gamClient.createOrder(req);
  } catch (upstreamErr) {
    throw new AdcpError('UPSTREAM_REJECTED', {
      recovery: 'transient',
      message: 'Ad server rejected the order',
      details: pickSafeDetails(upstreamErr, ['http_status', 'request_id', 'gam_error_code']),
    });
  }
  ```

  What gets dropped silently: any key not in the allowlist; functions / Symbols / Date / RegExp / Map / Set / class instances (use string allowlist of primitive fields, or pre-shape the input); nested objects beyond `maxDepth`; results exceeding `maxSizeBytes`. Arrays don't count as a depth level (only plain objects do) — so an array-of-objects gets the same nesting budget as a bare object would.

  **Tests.** 33 unit tests covering the full coercion / sanitization matrix (strings, Error instances, AdcpError-shaped objects, vendor-specific fields, retry_after clamping, recovery validation, depth cap, size cap, arrays of primitives + objects, common upstream-API sanitization pattern). 4 framework-integration tests pin that `normalizeErrors` is actually applied at the `sync_creatives` projection seam — strict response validation passes when adopters return string/Error/partial-object errors.

  **SKILL.** New "Sanitizing error details" + "Wire-shape normalizer for `errors[]`" subsections under "Error code vocabulary" walking adopters through the two helpers with realistic GAM-rejection / partial-batch-failure examples.

### Patch Changes

- a1c144f: Add account-mode capability gate in storyboard runner: `sync_accounts` and `list_accounts` steps now skip with `not_applicable` (instead of `missing_tool`) when the seller's declared `require_operator_auth` capability indicates the opposite account mode applies. Also threads `_profile` into `runStoryboardStep` so the gate fires on standalone step calls too.
- a1c144f: **Preview: `DecisioningPlatform` v1.0 type scaffold** (`src/lib/server/decisioning/`). Lands the type surface for the v6.0 framework refactor — adopters describe their decisioning system once via per-specialism interfaces (`SalesPlatform`, `CreativeTemplatePlatform`, `CreativeGenerativePlatform`, `AudiencePlatform`) and the framework owns wire mapping, account resolution, async tasks, status normalization, and lifecycle state. No runtime wiring yet; types are not exported from any public subpath.

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
  - Wired surface: full v1.0 specialism coverage. `SalesPlatform` all 5 methods (`getProducts`, `createMediaBuy`, `updateMediaBuy`, `syncCreatives`, `getMediaBuyDelivery`) with `submitted` projection where the wire spec supports it (`create_media_buy`, `sync_creatives`); `CreativeTemplatePlatform` / `CreativeGenerativePlatform` (`buildCreative`, `previewCreative`, `syncCreatives`); `AudiencePlatform.syncAudiences`; `accounts.resolve` / `upsert` / `list`. Tools without a wire Submitted arm (`update_media_buy`, `get_media_buy_delivery`, `build_creative`, `sync_audiences`, `sync_accounts`) translate platform-side submitted returns into `INVALID_STATE` envelopes with `task_id` in `details`.
  - 17/17 smoke tests pass: build server from platform, dispatch all 5 sales tools (sync + submitted + rejected projection), creative + audience tools dispatch, ACCOUNT_NOT_FOUND envelope on AccountNotFoundError throw, validatePlatform forward-compat, **task registry lifecycle (ctx.startTask issues handles, handle.notify writes records, terminal lock-out on completed/failed)**.

  `ctx.startTask()` + framework-managed task registry: `RequestContext.startTask({ partialResult? })` returns a `TaskHandle` whose `taskId` is a framework-issued UUID. The handle's `notify(update)` persists lifecycle into an in-memory registry (per-server-instance scope). `server.getTaskState(taskId)` reads back the current lifecycle record (status, result, error, partialResult, statusMessage, timestamps) — the read API the forthcoming `tasks/get` wire handler will plug into. Terminal-state lock-out: subsequent notifies after `completed` / `failed` are no-ops.

  After round-3 expert review (`javascript-protocol-expert` + `dx-expert` ran in parallel against the AsyncOutcome-as-default shape), refactored to **plain `Promise<T>` adopter shape with `AdcpError` for structured rejection** (round 5):
  - Specialism methods now return `Promise<T>` directly. `throw new AdcpError(code, opts)` for structured rejection — framework projects `code` / `recovery` / `field` / `suggestion` / `retry_after` / `details` to the wire `adcp_error` envelope. Generic thrown errors (`Error`, `TypeError`) fall through to the framework's `SERVICE_UNAVAILABLE` mapping.
  - `AsyncOutcome<T>` and its `ok` / `submitted` / `rejected` constructors are kept in the runtime as internal projection vocabulary; adopter code does not return them.
  - `unimplemented()` / `aggregateRejected()` removed from the adopter surface — direct `throw new AdcpError('UNSUPPORTED_FEATURE', ...)` is more idiomatic; multi-error pre-flight uses `details.errors`.
  - One canonical error path: `throw AdcpError`. Matches tRPC / Express / GraphQL idioms; eliminates the dual-shape return that confused agent-generated code.
  - Migration sketch updated to use the new shape (`docs/proposals/decisioning-platform-training-agent-migration.md`).

  Status: Preview / 6.0. The runtime is not yet exported from `./server`; reach in via `@adcp/client/server/decisioning/runtime` for spike experimentation only. Subsequent commits land `ctx.runAsync(opts, fn)` (in-process timeout-race + auto-defer), `tasks/get` wire integration (so buyers poll the registry over MCP / A2A), webhook emitter integration on `notify` push, per-tenant `getCapabilitiesFor` runtime, and "framework always calls `accounts.resolve(authPrincipal)`" behavior for `'derived'` / `'implicit'` resolution modes. Companion design doc at `docs/proposals/mcp-a2a-unified-serving.md`.

  After round-7 Emma sims (creative-ad-server, campaign-governance, property-lists, collection-lists at 4-5/5 each) + PR review feedback, additional fixes:
  - `server.statusChange: StatusChangeBus` exposed on the `DecisioningAdcpServer` returned by `createAdcpServerFromPlatform`. `server.statusChange.publish(...)` writes to this server's bus only — tests with multiple servers in one process no longer cross-contaminate via the module-level singleton. `opts.statusChangeBus` lets adopters pin a tenant-scoped channel at construction time. Module-level `publishStatusChange(...)` remains for non-handler code (webhook handlers, crons) that doesn't hold a server reference.
  - `StatusChangeResourceType` extended with `'property_list'` + `'collection_list'` (list-changed events for cache invalidation / fetch_token revoke).
  - `RequestContext<TAccount>` constraint relaxed to thread per-platform `TMeta` through every specialism interface — `SalesPlatform<TMeta>`, `CreativeTemplatePlatform<TMeta>`, `CreativeGenerativePlatform<TMeta>`, `CreativeAdServerPlatform<TMeta>`, `AudiencePlatform<TMeta>`, `SignalsPlatform<TMeta>`, `CampaignGovernancePlatform<TMeta>`, `PropertyListsPlatform<TMeta>`, `CollectionListsPlatform<TMeta>`. Adopters get typed `ctx.account.metadata` access in their method bodies without casting. `RequiredPlatformsFor<S>` accepts an optional `TMeta` so the compile-time intersection works for both default `Record<string, unknown>` and adopter-defined metadata interfaces.
  - Collection-list dispatch wired through the framework: `AdcpToolMap` entries for `create_collection_list` / `update_collection_list` / `get_collection_list` / `list_collection_lists` / `delete_collection_list`; matching `GovernanceHandlers` fields; `buildGovernanceHandlers` wires them onto `platform.collectionLists`. `GOVERNANCE_TOOLS` extended so capability auto-derivation includes them.
  - `buildListCreativesResponse({ request, creatives, pagination, totalMatching? })` helper. Builds the heavyweight `ListCreativesResponse` shape (`query_summary` with `total_matching` / `returned` / `filters_applied` / `sort_applied` + `pagination`) from a row array — adopters writing the wrapper by hand re-derived these fields per call.
  - Public `@adcp/client/types` re-exports for the full property-list + collection-list CRUD surface (`{Create,Update,Get,List,Delete}{Property,Collection}List{Request,Response}`). Governance adopters no longer reach into generated files.
  - `skills/build-decisioning-platform/SKILL.md` § "HITL-sometimes" — guidance on declaring `*Task` even when most calls resolve immediately, so the buyer experience stays uniform across fast-path and slow-path requests. Avoids the anti-pattern of conditionally choosing between `createMediaBuy` (sync) and `createMediaBuyTask` (HITL) based on the request.

  After downstream-adopter review (agentic-adapters 13-platform walkthrough + training-agent migration sketch):
  - **Custom-handler merge seam** (`createAdcpServerFromPlatform`): `mediaBuy` / `creative` / `accounts` / `eventTracking` / `signals` / `governance` / `brandRights` / `sponsoredIntelligence` are now passable as raw handler-style entries on `opts`, alongside the v6 platform interface. Platform-derived handlers WIN per-key; adopter handlers fill gaps for tools the platform doesn't yet model (`getMediaBuys`, `listCreativeFormats`, `providePerformanceFeedback`, `reportUsage`, `syncEventSources`, `logEvent`, `syncCatalogs`, `getAccountFinancials`, content-standards CRUD, `creative-review`, `brand-rights`, etc.). Unblocks incremental migration: adopters move sales / audiences / signals to the v6 shape today and keep custom handlers wired for tools whose specialism interfaces are deferred to v1.1+ / rc.1. Closes the migration blocker `agentic-adapters` and `training-agent` flagged independently.
  - Type discipline at the projection seam: dropped defensive `(params as { foo?: T }).foo` casts in `from-platform.ts` for `media_buy_id`, `creatives` (sales + creative dispatch), `audiences`, and `accounts`. Wire request schemas already typed these.
  - Stub errors louder: `ctx.resolve.{propertyList,collectionList,creativeFormat}` now throw with a uniform "not yet wired in v6.0 alpha — landing in rc.1, avoid touching ctx.resolve.\* in adopter code" diagnostic. `buildRequestContext`'s no-account error explains it's a framework invariant violation.
  - `DecisioningAdcpServer.statusChange` JSDoc adds the rc.1 projection-wiring contract: when MCP Resources subscription projection lands, the projector MUST fan-in from BOTH the per-server bus AND the module-level `activeBus` so neither call site silently becomes inert in production.
  - **Postgres-backed `TaskRegistry`** — `createPostgresTaskRegistry({ pool, tableName? })` + `getDecisioningTaskRegistryMigration()` ship a durable HITL task store. Cross-instance reads (`tasks/get` from any process), terminal-state idempotency enforced via SQL `WHERE status = 'submitted'`. Unblocks production HITL deployments today; the in-memory registry stays as the test/dev default.
  - `TaskRegistry` interface methods (`create`, `getTask`, `complete`, `fail`) made async to accommodate storage-backed implementations. The framework awaits each call; the in-memory impl resolves immediately. `DecisioningAdcpServer.getTaskState` becomes `Promise<TaskRecord | null>` — small breaking change to the preview surface.
  - **`accounts.resolve()` is mandatory — even for "no tenant" agents.** SKILL.md adds a section on the `resolution: 'derived'` posture for single-tenant agents (training-agent's migration concern): return a synthetic singleton account so the framework's tenant-scoped invariants (idempotency, status-change `account_id`, workflow steps, `getCapabilitiesFor`) all work. ~10 lines for adopters who skipped resolution previously.
  - **OAuth provider wiring docs.** SKILL.md § "OAuth provider wiring" — verifiers live on `serve({ authenticate })`, not on `DecisioningPlatform`. The platform sees the resolved principal via `ctx.account.authInfo` after `accounts.resolve(ref, { authInfo })`. No `auth?: AuthProvider` field on the platform interface; that boundary is intentionally on the surrounding `serve()` opts.
  - **v1.0 interface gap-fill** (preparing for rc.1): four optional methods added to `SalesPlatform` — `getMediaBuys`, `providePerformanceFeedback`, `listCreativeFormats`, `listCreatives` — and two to `AccountStore` — `reportUsage`, `getAccountFinancials`. These are the canonical wire tools every seller agent ships; previously they were only reachable via the merge seam, which was the workaround. Now first-class on the platform interface; merge-seam fallthrough still works for adopters who haven't migrated those specific tools yet. Closes the "3/9 sales tools missing from canonical interface" gap that agentic-adapters and training-agent flagged.
  - **Auth-derived account resolution.** New `AdcpServerConfig.resolveAccountFromAuth` opt — framework calls it for tools whose wire request doesn't carry an `account` field (`provide_performance_feedback`, `list_creative_formats`, the `tasks/get` polling path). Single-tenant agents (`resolution: 'derived'`) return their singleton; principal-keyed agents look up by `authInfo`. `AccountStore.resolve` signature widened to accept `AccountReference | undefined` for this path. `createAdcpServerFromPlatform` wires it automatically — adopter platforms with non-`account`-carrying tools work end-to-end.
  - **HITL push-notification webhooks.** `dispatchHitl` now reads `push_notification_config: { url, token? }` from the buyer's request and emits a signed RFC 9421 webhook to the URL on terminal task state (`completed` or `failed`) carrying the wire `task` payload. Buyers receive completion via push instead of polling; polling via `server.getTaskState(taskId)` continues to work. Webhook delivery uses `ctx.emitWebhook` (framework-provided when `webhooks` is wired on `serve()`) or an explicit `taskWebhookEmitter` opt for tests / dedicated task channels. Three tests pin: completed-emit-with-token, failed-emit-with-error, no-emit-when-config-missing.
  - **`ContentStandardsPlatform` specialism.** Adds the `content-standards` specialism (in AdCP 3.0 GA enum) — 6 required + 2 optional methods covering brand-safety policy CRUD, content calibration, delivery validation, and analyzer artifact reads. Wired through `GovernanceHandlers` in the framework. Closes one of the two specialism gaps training-agent flagged. (`creative-review` isn't a separate AdCP specialism — `CreativeAdServerPlatform.syncCreativesTask` HITL covers manual creative review.)
  - **`SalesPlatform` retail-media tools.** Three new optional methods — `syncCatalogs`, `logEvent`, `syncEventSources` — first-class on the platform interface. Routed through `EventTrackingHandlers` to match the wire-spec framework category. Unblocks `sales-catalog-driven` adopters (Amazon retail-media, Criteo, Citrusad, Walmart Connect, Shopify) without forcing the merge-seam workaround. Three tests pin dispatch.
  - **Merge-seam collision warning.** `mergeHandlers` now detects when an adopter's `opts.<domain>.<key>` is silently shadowed by a platform-derived handler — the failure mode where v6.x adds a tool to a specialism interface and the adopter's prior merge-seam override stops running on next deploy. Four modes: `'warn'` (default) logs every collision at construction, `'log-once'` logs the first time each `(domain, keys)` collision is seen in the process (right default for multi-tenant hosts running N constructions per process and hot-reload dev), `'strict'` throws `PlatformConfigError` (CI/new-deployment recommended), `'silent'` skips entirely. Four tests pin warn / log-once / strict / silent. Closes the rc.1 reviewer concern about silent migration regression.
  - **Push-notification webhook URL/token validation (B5/B6).** The buyer-supplied `push_notification_config.url` is now validated before delivery — closes the SSRF + signed-deputy primitive the security review flagged. Rejections: non-`https://` schemes (allowed in test/dev or via `ADCP_DECISIONING_ALLOW_HTTP_WEBHOOKS=1`), bare `localhost` / `0`, RFC 1918 ranges (10/8, 172.16/12, 192.168/16), loopback (127/8, ::1), link-local (169.254/16, fe80::/10 — covers AWS metadata), CGNAT (100.64/10), IPv6 unique-local (fc00::/7), multicast/reserved. `push_notification_config.token` rejects values >255 chars or with control characters. On rejection the framework logs at warn level and skips webhook delivery (does not fail the task). 13 tests pin scheme/IP/host/token rejections + the well-formed accept path.
  - **rc.1 buyer-side polling tool (`tasks_get`).** The framework now auto-registers a `tasks_get` custom tool when adopters call `createAdcpServerFromPlatform`. Buyers call it with `{ task_id, account? }` and receive the spec-flat lifecycle shape (`task_id`, `task_type`, `status`, `timestamp`, `protocol`, `result | { errors }`). Tenant-scoped — adopters in `'explicit'` mode pass `account` and the framework verifies the resolved account owns the task; mismatch returns `REFERENCE_NOT_FOUND` (not-found shape, no principal-enumeration). Snake-case name approximates the spec's `tasks/get` method (MCP tool names disallow `/`); native MCP `tasks/get` integration via the SDK's experimental `registerToolTask` lands in v6.1. Four tests pin: completed lifecycle, failed with structured error, cross-tenant probe rejection, unknown task_id.
  - **B13 deferred — spec inconsistency, not codegen bug.** The protocol reviewer flagged that the spec ships `Submitted` arms in `core/async-response-data.json` for SIX tools (`create_media_buy`, `sync_creatives`, `update_media_buy`, `build_creative`, `sync_catalogs`, `get_products`), yet the SDK's specialism interfaces only expose `*Task` variants for the first two. Investigation: only `create_media_buy` and `sync_creatives` roll the Submitted arm into their per-tool `xxx-response.json` `oneOf`; the other 4 have inconsistent response schemas — Submitted is in `async-response-data.json` only. SDK codegen faithfully reflects the per-tool wire schema (since wire validators check the per-tool `xxx-response.json`). Adding `*Task` methods without the spec fix would mean the SDK accepts a Submitted envelope that wire-validating receivers reject. Filed upstream as `adcontextprotocol/adcp#3392` proposing the spec consolidation. When that lands, SDK ships `*Task` methods for `update_media_buy`, `build_creative`, `sync_catalogs`, `get_products`. Until then, long-form flows on those tools surface via `publishStatusChange` on the appropriate `resource_type`. JSDoc on each interface points adopters to the upstream issue.
  - **rc.1 wire-conformance round (B1, B2, B4, B10, B11, B12).** Closes the deterministic correctness + spec-shape items from the expert red-team:
    - **B1 webhook payload spec-flat shape.** `emitTaskWebhook` now emits the `mcp-webhook-payload.json`-conformant envelope: top-level `idempotency_key` (cryptographically random UUIDv4), `task_id`, `task_type` (tool name), `status`, `timestamp`, `protocol` (`'media-buy'` / `'creative'` / `'signals'` / `'governance'` / `'brand'` / `'sponsored-intelligence'` derived from tool name), `message` on failed, `result` carrying the success-arm body for completed or `{ errors: [structuredError] }` for failed. Replaces the previous `{ task: { ... } }` nested shape that wouldn't validate against spec receivers.
    - **B2 task-status enum 9/9.** `TaskStatus` now matches `enums/task-status.json` — `submitted | working | input-required | completed | canceled | failed | rejected | auth-required | unknown`. Postgres CHECK constraint widened to match. The framework currently writes only `submitted` / `completed` / `failed`; the other six are reserved for adopter-emitted transitions via the v6.1 `taskRegistry.transition()` API.
    - **B4 `AccountStore.resolve(ref, ctx?)` two-arg signature.** Closes the SKILL/runtime drift the security review flagged. Adopters fronting upstream platform APIs translate `ctx.authInfo` (transport-level auth principal) into their tenant model on resolution. `ResolveContext.authInfo` matches the framework's `HandlerContext['authInfo']` shape (`{ token, clientId, scopes, ... }`); the runtime bridge passes both `authInfo` and `toolName` through.
    - **B10 `buildRequestContext` null-account tolerance.** No longer throws when `handlerCtx.account` is missing — auth-derived resolvers may legitimately return null for tools whose wire request lacks an `account` field. Adopter handlers for those tools either declare `resolution: 'derived'` (singleton always returned) or read `ctx.account` defensively and look up by request body.
    - **B11 at-least-one for dual-method pairs.** `dispatchHitl` call sites now check both `xxx` and `xxxTask` before dereferencing — adopters who wire a creative platform without either `syncCreatives` or `syncCreativesTask` get `UNSUPPORTED_FEATURE` instead of `TypeError: not a function`. Same for sales `createMediaBuy`/`createMediaBuyTask` and `syncCreatives`/`syncCreativesTask`.
    - **B12 Postgres `complete()` failure ordering.** Webhook delivery now gated on registry write succeeding. If `complete()` throws (DB outage), framework logs at error level and skips webhook — buyer's webhook view stays consistent with `getTaskState` reads. Three failure surfaces handled distinctly: taskFn-throws → fail+webhook; taskFn-succeeds-but-registry-fails → log only; taskFn-fails-and-registry-fails → log only.
  - **Account-scoped `getTaskState` (B7).** New optional `expectedAccountId` arg on `DecisioningAdcpServer.getTaskState(taskId, expectedAccountId?)`. When supplied, returns `null` for a task whose `accountId` doesn't match — adopters wrapping it as a `tasks/get` wire handler MUST pass `ctx.account.id` to scope reads. Without it any caller with a known `task_id` reads any tenant's task lifecycle including `result` and `error` payloads. Three tests pin: same-account read works, cross-tenant probe returns null, unscoped read (single-arg form for ops / test harnesses) still works.
  - **Lifecycle observability hooks (`DecisioningObservabilityHooks`).** Generic instrumentation surface so adopters can wire any telemetry backend (DataDog, Prometheus, OpenTelemetry, structured logger) without baking a specific SDK into the framework. v6.0 ships 5 hooks covering AdCP-specific events: `onAccountResolve` (wraps every `resolve()` call with `fromAuth` flag + duration), `onTaskCreate` + `onTaskTransition` (HITL task lifecycle with terminal-state errorCode), `onWebhookEmit` (push-notification delivery success/failure with timing), `onStatusChangePublish` (per-server bus + module-level singleton, both routes wrapped). All callbacks throw-safe — adopter telemetry mistakes are caught + logged via the framework logger and never break dispatch. Per-tool dispatch-latency hooks (`onDispatchStart` / `onDispatchEnd`) land in v6.1 when the per-handler instrumentation pass goes through; the ecosystem will get an opt-in `@adcp/client/telemetry/otel` peer-dep adapter that returns a pre-wired hook object with AdCP-aligned span / metric names. Seven tests pin hook firing, throw safety, and the auth-derived path's `fromAuth: true` flag.

  After round-2 expert red-team (security + protocol + DX in parallel), additional fixes:
  - **Cross-tenant `tasks_get` leak via missing authInfo.** The `tasks_get` custom-tool handler now receives MCP `RequestHandlerExtra` as its second arg and threads `extra.authInfo` into both `accounts.resolve(ref, ctx)` call sites — without this, an attacker passing `{ account: { account_id: 'tenant_B' } }` got tenant B's account back from a naive `findById(ref.account_id)` resolver and read tenant B's task. Same threading as the regular `resolveAccount` dispatch flow. Plus a defense-in-depth tenant-boundary check: if the caller's account doesn't resolve at all (unauthenticated probe path) but the task IS owned by an account, the framework refuses to leak — returns the same `REFERENCE_NOT_FOUND` shape it returns for unknown task_ids (no principal-enumeration). New regression test pins: omitting `account` arg with no auth-derived match returns not-found, not the task.
  - **SSRF guard tightening (IPv6 brackets + IPv4-mapped IPv6).** Node's WHATWG `URL.hostname` returns IPv6 literals WITH brackets — so `https://[::1]/` arrived at `validatePushNotificationUrl` as host `[::1]`, bypassing the unbracketed-prefix checks for `fc00::/7`, `fe80::/10`, etc. Now strips brackets before range checks. IPv4-mapped IPv6 (`::ffff:127.0.0.1` and the hex form `::ffff:7f00:1`) recursively re-validate via the dotted-decimal IPv4 path. Node already canonicalizes alternate IPv4 forms (integer, hex, octal) to dotted-decimal before parsing — those land in the existing range checks unchanged. Five new SSRF regression tests pin IPv6 bracketed loopback / unique-local / link-local + IPv4-mapped dotted + hex forms.
  - **Empty push-notification token rejection.** `validatePushNotificationToken` now rejects `length === 0` with reason `'token is empty'`. Previously a buyer-supplied empty string round-tripped onto the webhook payload, making downstream signature-validation logic ambiguous about whether the token was intentionally absent or buggy.
  - **Webhook payload field rename: `validation_token` → `token`.** Matches the `mcp-webhook-payload.json` spec, which names the field `token` to match the request-side `push_notification_config.token`. The previous `validation_token` was inherited from an earlier draft and would have been rejected by spec-conformant receivers. Three tests updated.
  - **Postgres `TaskRegistry` CHECK constraint narrowed back to 3 framework-written values.** Re-narrows the CHECK to `('submitted', 'completed', 'failed')` — matches what the framework actually writes today. The other 6 spec-defined states (`working`, `input-required`, `canceled`, `rejected`, `auth-required`, `unknown`) are reserved for adopter-emitted transitions via the v6.1 `taskRegistry.transition()` API. Without narrowing, an adopter writing `working` directly via SQL would pin a task in a non-terminal state that the framework's `complete()` / `fail()` no-op against (their `WHERE status = 'submitted'` predicates wouldn't match), creating an undetectable stuck-task class. The v6.1 migration widens the CHECK once `transition()` is the supported entry point.
  - **`safeFire` async-rejection catch.** Observability hooks accidentally written `async` (e.g. `onAccountResolve: async () => { throw }`) returned a rejected promise out-of-band. `safeFire` now `.catch()`es the returned value when callable's return is thenable, logging at warn level instead of bubbling to `process.on('unhandledRejection')`. Critical because `node --unhandled-rejections=strict` (common in production) would crash the process on a single async telemetry mistake. New regression test pins: async-throwing hook → dispatch succeeds, warning logged.
  - **`listAccounts` AdcpError projection.** The `list_accounts` framework handler now wraps the `accounts.list!(filter)` call in `projectSync`, so adopter code throwing `new AdcpError('PERMISSION_DENIED', ...)` projects to the structured wire envelope rather than falling through to the framework's `SERVICE_UNAVAILABLE` mapping. Brings parity with every other dispatch site in `from-platform.ts`.

  After round-3 expert red-team (DX + security + protocol + code-reviewer in parallel), additional fixes:

  **Protocol conformance:**
  - **`tasks_get` failure shape now spec-aligned.** Spec `tasks-get-response.json` requires top-level `error: { code, message, details? }` for failed tasks. SDK was writing `result.errors[0]` instead — strict spec receivers would have rejected the response. Top-level error projection lands; details carry the structured-error tail (`recovery`, `field`, `suggestion`, `retry_after`, adopter-supplied `details`).
  - **`completed_at` on terminal `tasks_get` responses.** Spec optional field per `tasks-get-response.json:35`; emitted on completed/failed/canceled tasks. Buyers can now distinguish "last touched" from "settled" without inferring from status.
  - **Webhook delivery gated to spec-listed task types.** Spec `enums/task-type.json` is a closed 20-value enum at AdCP 3.0 GA; spec-validating receivers reject envelopes with non-spec `task_type` values. The framework dispatches a wider tool surface than the closed enum (`build_creative`, `check_governance`, `sync_plans`, `si_*`, etc.). For those, the framework now skips webhook emission with an explanatory log and adopters surface long-running state via `publishStatusChange` instead. Tracking `adcontextprotocol/adcp` issue to widen the enum; until then this gate prevents silent reject by spec-conformant subscribers.
  - **`protocolForTool` extracted to its own module** with a typed `TOOL_PROTOCOL_MAP: Readonly<Record<string, AdcpProtocol>>` table replacing the 23-line if/elif chain. Returns `AdCPProtocol` (the 6-value closed enum) instead of bare `string`. New focused unit test covers every branch + `SPEC_WEBHOOK_TASK_TYPES` closed-enum gate (12 tests).
  - **`tasks_get` input schema tightened.** `account` now `.strict()` (was `.passthrough()`); `account_id` typed as `z.string().min(1).optional()` (was `z.string().optional()`). `task_id` capped at `.max(128)` so buyers can't probe with megabyte-sized strings.

  **Security hardening:**
  - **Push-notification URL/token validation now FAIL-FAST with `INVALID_REQUEST`.** Was silent skip — buyers who shipped bad config saw no webhook and had no signal. Now `INVALID_REQUEST` with `field: 'push_notification_config.url'` (or `.token`) at the request boundary so buyers fix their config before relying on webhook delivery. Buyers can still poll via `tasks_get` for the fallback path. SSRF + token tests updated to assert envelope shape.
  - **Postgres `complete()`/`fail()` cap result/error JSON at 4MB.** Adopter `*Task` methods returning oversized payloads (e.g., from a buggy upstream platform that stuffed a megabyte of HTML into the response) no longer OOM the Node process before pg complains. Throws a descriptive error; reconciliation surfaces the size violation in operator dashboards.
  - **`taskWebhookEmitter` opt now requires explicit signing-posture declaration.** Custom emitters wired without `unsigned: true` while platform claims `signed-requests` and `NODE_ENV=production` get a construction-time warn. Closes the silent "ships unsigned webhooks while claiming signed-requests" gap.
  - **DNS rebinding caveat documented.** The validator only inspects the literal hostname; a buyer can register `https://rebind.attacker.com/` with a TTL-0 A-record that returns `8.8.8.8` at validate time and `127.0.0.1` at fetch time. Adopters wiring custom emitters SHOULD pin the resolved IP at fetch time and connect to that specific IP. Tracked in JSDoc on `extractPushConfig`; framework-side pin-and-bind is a follow-up.
  - **`assertValidIdentifier` error message no longer interpolates the regex object.** Was `must match /^[a-z_][a-z0-9_]*$/`; now reads "must be lowercase letters, digits, or underscores, starting with a letter or underscore."

  **DX / observability:**
  - **`DecisioningObservabilityHooks` upgraded for OTel/Prom/DataDog.** `onAccountResolve` gains `accountId?: string`; `onTaskCreate` gains `durationMs: number`; `onWebhookEmit` replaces `errors: string[]` with `errorCode?: string` (bucketed: `TIMEOUT`/`CONNECTION_REFUSED`/`HTTP_4XX`/`HTTP_5XX`/`SIGNATURE_FAILURE`/`UNKNOWN`) plus `errorMessages?: string[]` for log adopters who need raw text. JSDoc warns about cardinality on `accountId` forwarding.
  - **`onTaskTransition` fires on registry-write-failed paths.** Synthetic `errorCode: 'REGISTRY_WRITE_FAILED'` so adopters wiring DD/Prom on `onTaskTransition` see the metric, not just the framework log line.
  - **`AdcpError.toString()` override** surfaces `code` and `recovery` in default `console.error(err)` / CloudWatch / structured-log output (was bare `AdcpError: <message>`). Operator triage gets the code without parsing the stack.
  - **`ResolvedAuthInfo` type extracted from `ResolveContext`** and exported from `@adcp/client/server/decisioning` so adopters import once instead of re-declaring the OAuth-style auth shape. Kept `ResolveContext.authInfo` shape backwards-compatible.
  - **`ErrorCode` runtime warn on misspelled codes.** The `code: ErrorCode | (string & {})` escape hatch defeats compile-time autocomplete on typos like `'BUDGET_TO_LOW'`. AdcpError ctor now warns once per unknown code at runtime; `ADCP_DECISIONING_ALLOW_CUSTOM_CODES=1` silences for adopters intentionally minting vendor-specific codes. `KNOWN_ERROR_CODES` exported as authoritative list.
  - **Type-checks regression for misspelled specialisms.** Adding `@ts-expect-error` to `decisioning.type-checks.ts` proves a typo like `'sales-non-guarenteed'` fails compile via `RequiredPlatformsFor` — was silently falling through to runtime `validatePlatform` throw.
  - **`safeFire` Promise coercion.** Replaced duck-typed `typeof .catch === 'function'` Promise detection with `Promise.resolve(result).catch(...)` — safer with user-land thenables that don't expose `.catch`.
  - **Inline `require('zod')` replaced with top-level `import`.** Was the only `require()` in `src/lib/server/decisioning/`; restored tree-shaking + ESM consistency.

  **SKILL fixes:**
  - Canonical example is now copy-paste-runnable. Single-tenant `'derived'` resolution, `satisfies`-typed sales/accounts blocks, no comment-only arrow bodies, no unresolved `this.*` refs.
  - Added "What the framework wires automatically" callout — `tasks_get` polling tool is auto-registered; adopters don't write a polling tool.
  - Removed contradiction: SKILL was telling adopters to wrap `getTaskState` in their own `tasks/get` tool; framework auto-registers `tasks_get` and the SKILL now says so. Removed stale "tasks/get next commit" entry from "What's not in v6.0 alpha".
  - `accounts.resolve` section now has a 3-row mode table + leads with "If you have one tenant, declare `resolution: 'derived'`" — was the silent-fail trap for single-tenant agents in `'explicit'` default.
  - New "Migrating from v5.x handler-style — the merge seam" section with a 4-mode `mergeSeam` table (warn / log-once / strict / silent + when to pick).
  - Observability example updated for the round-3 hook-signature changes (accountId, durationMs, errorCode bucketed) with cardinality-warning comments.

  **Code quality:**
  - `dispatchHitl` deduplicates 4× `safeFire(onTaskTransition)` call sites into a single closed-over `fireTransition(status, errorCode?)` helper. Net -55 lines from the inline IIFE.
  - Default framework logger pulled to module scope as `DEFAULT_FRAMEWORK_LOGGER` — single place for the no-op-debug/info, console-warn/error pattern.
  - `buildEventTrackingHandlers` no longer takes the unused `_taskRegistry` param.

  After round-4 expert red-team (DX + security + protocol in parallel), additional fixes:

  **Protocol:**
  - **`has_webhook` field on `tasks_get` response.** Spec `tasks-get-response.json:40-43` defines it; SDK now emits it. New `TaskRecord.hasWebhook?: boolean` field; `TaskRegistry.create({ hasWebhook })` param; framework sets it from `pushNotificationUrl` presence at dispatch time. Postgres migration adds `has_webhook BOOLEAN NOT NULL DEFAULT FALSE` column. Buyers can use it to decide between long-poll vs. single-shot polling.
  - **`tasks_get` description rewritten for LLM-driven buyers.** Was "Spec-aligned alternative to MCP-native `tasks/get`" (incomprehensible without spec context). Now leads with "Call this when you receive `{ status: 'submitted', task_id }` from create_media_buy or sync_creatives" — buyer agents reading `tools/list` understand it as the polling path on first read.

  **Security:**
  - **Sec-M-1 NODE_ENV gating inverted to allowlist.** The `taskWebhookEmitter.unsigned` posture warn was gated on `process.env.NODE_ENV === 'production'`, which fails open when `NODE_ENV` is unset (Node default), `'staging'`, `'live'`, or `'prod'` — common production deployments. Adopters wired a dev fake, deployed to a host with `NODE_ENV` unset, claimed `signed-requests`, and shipped unsigned webhooks silently. Now: warns when `NODE_ENV` ∉ `{test, development}` AND the explicit `ADCP_DECISIONING_ALLOW_UNSIGNED_TEST_EMITTER=1` ack env is unset. Matches the project rule "never `=== 'production'`."
  - **Sec-L-1 `bucketWebhookError` first-match → max-match.** Was scanning lower-cased message left-to-right and returning the first `4xx`/`5xx` token. Free-text errors like "upstream returned 502 (proxy received 401 from origin)" mis-bucketed as `HTTP_4XX`. Now collects ALL 3-digit status tokens and returns the largest — operator triage sees the most-severe code, not the leftmost.
  - **Sec-L-2 `safeStringify` wraps `JSON.stringify` with descriptive error.** Adopter `*Task` returning a value with circular references would throw `TypeError: Converting circular structure to JSON` from inside `complete()` — caught by registry-write-fail path but the operator log said "registry write failed" without pointing at the adopter return shape. New helper raises a clear "adopter \*Task return is not JSON-serializable: <err>" error.
  - **Sec-L-3 4MB cap JSDoc tightened.** `assertResultSize` JSDoc now explicitly notes "this cap protects the DB write path only" — adopters reading the JSDoc no longer assume `result`/`error` are bounded for log handlers (`logger.error(JSON.stringify(error))` is unbounded; cap that yourself).

  **DX:**
  - **SKILL canonical example now compiles.** Round-3 left it broken — `formats` (vs spec `format_ids`), `model` (vs `pricing_model`), `amount` (vs `rate`), missing `description` / `delivery_type` / `publisher_properties` / `reporting_capabilities`, `createMediaBuy` returning shape missing `packages`, `getMediaBuyDelivery` returning `media_buys` (vs `media_buy_deliveries`), and `updateMediaBuy.patch.active` (vs spec `paused`). Verified end-to-end: `tsc --noEmit` clean against the project tsconfig. Removed the explicit `: DecisioningPlatform` annotation so TS keeps the literal `specialisms: ['sales-non-guaranteed']` and `RequiredPlatformsFor` correctly narrows to "must provide `sales: SalesPlatform`."
  - **`*Task` JSDoc documents the 4MB Postgres cap.** `createMediaBuyTask` and `syncCreativesTask` return-value JSDoc now mentions the cap and points at `errorCode: 'REGISTRY_WRITE_FAILED'` as the operator-visible signal. Adopters returning oversized payloads see the production gotcha at the type-system level.
  - **SKILL "Custom webhook emitter" section.** Adopters wiring a non-default `taskWebhookEmitter` get explicit guidance: signing posture is your responsibility; default emitter signs; set `unsigned: true` to acknowledge test/dev fakes; `ADCP_DECISIONING_ALLOW_UNSIGNED_TEST_EMITTER=1` for staging where signing isn't yet wired.
  - **SKILL "Production task storage" section adds the 4MB cap callout.** Adopters now learn about the cap before hitting it in production logs.

  After salesagent round-2 hybrid-seller feedback on PR #1005, unified the dual-method shape into one method per tool:
  - **Replaced `createMediaBuy` / `createMediaBuyTask` (and `syncCreatives` / `syncCreativesTask`) with a single `createMediaBuy(req, ctx)` returning `Success | TaskHandoff<Success>`.** Adopters return the wire success arm directly for sync fast paths, or return `ctx.handoffToTask(fn)` for HITL slow paths. The framework detects the handoff marker, allocates `task_id`, projects the spec-defined `Submitted` envelope to the buyer, and runs `fn` in the background. Hybrid sellers (programmatic + guaranteed in one tenant) branch per call on whatever signal determines the path.
  - **Why.** The dual-method shape forced upfront sync-vs-HITL choice per tool — fine for pure-sync or pure-HITL adopters, broken for hybrid sellers (every broadcast network with programmatic remnant, every retail-media network with PMP + self-serve). Salesagent flagged it on PR #1005: a real publisher commonly sells both kinds of inventory through the same `create_media_buy` tool, and the buyer doesn't know which until they pick products. The dual-method shape pushed those adopters toward "always declare HITL, resolve immediately on the fast path" — which taxes the 99% programmatic case with `tasks_get` polling for state already in memory.
  - **Drops `createMediaBuyTask` / `syncCreativesTask` from the v6 specialism interfaces** (`SalesPlatform`, `CreativeTemplatePlatform`, `CreativeGenerativePlatform`, `CreativeAdServerPlatform`). Drops the `DUAL_METHOD_PAIRS` exactly-one enforcement from `validatePlatform`. Drops the `ctx.task: TaskHandle | undefined` field from `RequestContext` (replaced by `ctx.handoffToTask(fn)` constructor). `buildTaskHandle` helper renamed to `buildHandoffContext`.
  - **New `TaskHandoff<T>` type and `TaskHandoffContext`** in `async-outcome.ts`. Adopters never construct `TaskHandoff` directly — `ctx.handoffToTask(fn)` is the only sanctioned producer. The handoff function receives `TaskHandoffContext` carrying `id` (framework-issued task id), `update(progress)`, and `heartbeat()`.
  - **Compatible with the spec's wire shape on both arms.** Buyers pattern-match on the response: `media_buy_id` field → sync success; `task_id` + `status: 'submitted'` → poll `tasks_get` or webhook. Predictable per request (deterministic given the products selected), dynamic per call.
  - **Migration cost.** Preview-window: zero adopters in production. Test fixtures + MockHitlSeller example + SKILL examples updated mechanically (rename `createMediaBuyTask` → `createMediaBuy`, wrap body with `ctx.handoffToTask(async (taskCtx) => { ... })`). New hybrid test fixture (`hybrid createMediaBuy: returns Success directly OR ctx.handoffToTask per call`) demonstrates per-call branching end-to-end.
  - **165/165 decisioning tests + skill-example typecheck CI green.**

  After salesagent round-2 hybrid-seller feedback, unified the dual-method shape into one method per tool:
  - **Replaced / (and likewise for ) with a single `createMediaBuy(req, ctx)` returning `Success | TaskHandoff<Success>`.** Adopters return the wire success arm directly for sync fast paths, or return `ctx.handoffToTask(fn)` for HITL slow paths. The framework detects the handoff marker, allocates `task_id`, projects the spec-defined `Submitted` envelope to the buyer, and runs `fn` in the background. Hybrid sellers (programmatic + guaranteed in one tenant) branch per call on whatever signal determines the path.
  - **Why.** The dual-method shape forced upfront sync-vs-HITL choice per tool — fine for pure-sync or pure-HITL adopters, broken for hybrid sellers (every broadcast network with programmatic remnant, every retail-media network with PMP + self-serve). Salesagent flagged it on PR #1005: a real publisher commonly sells both kinds of inventory through the same `create_media_buy` tool, and the buyer doesn't know which until they pick products. The dual-method shape pushed those adopters toward always declare HITL, resolve immediately on the fast path — which taxes the 99% programmatic case with `tasks_get` polling for state already in memory.
  - **Drops `createMediaBuyTask` / `syncCreativesTask` from the v6 specialism interfaces** (`SalesPlatform`, `CreativeTemplatePlatform`, `CreativeGenerativePlatform`, `CreativeAdServerPlatform`). Drops the `DUAL_METHOD_PAIRS` exactly-one enforcement from `validatePlatform`. Drops the `ctx.task: TaskHandle | undefined` field from `RequestContext` (replaced by `ctx.handoffToTask(fn)` constructor). `buildTaskHandle` helper renamed to `buildHandoffContext`.
  - **New `TaskHandoff<T>` type and `TaskHandoffContext`** in `async-outcome.ts`. Adopters never construct `TaskHandoff` directly — `ctx.handoffToTask(fn)` is the only sanctioned producer. The handoff function receives `TaskHandoffContext` carrying `id` (framework-issued task id), `update(progress)`, and `heartbeat()`.
  - **Compatible with the spec's wire shape on both arms.** Buyers pattern-match on the response: `media_buy_id` field → sync success; `task_id` + `status: 'submitted'` → poll `tasks_get` or webhook. Predictable per request (deterministic given the products selected), dynamic per call.
  - **Migration cost.** Preview-window: zero adopters in production. Test fixtures + MockHitlSeller example + SKILL examples updated mechanically (rename `createMediaBuyTask` → `createMediaBuy`, wrap body with `ctx.handoffToTask(async (taskCtx) => { ... })`). New hybrid test fixture (`hybrid createMediaBuy: returns Success directly OR ctx.handoffToTask per call`) demonstrates per-call branching.
  - **165/165 decisioning tests + skill-example typecheck CI green.**

  After salesagent feedback #5 (proposal generation is not catalog lookup):
  - **`get_products` deliberately stays sync-only**, even after adcp#3392 lands consolidated `Submitted` arms for the OTHER 5 HITL tools. Catalog lookup (fast read) and proposal generation (brief-to-pitch creative workflow) are different verbs in the AdCP buyer's vocabulary; conflating them under one tool name fights the buyer-predictability story everywhere else in the v6 design. The unified hybrid shape is right when ONE verb has variable timing (`create_media_buy`: programmatic remnant sync, guaranteed inventory HITL); it's the wrong shape for `get_products` because catalog and proposal are TWO verbs. Filed [adcp#3407](https://github.com/adcontextprotocol/adcp/issues/3407) advocating a separate `request_proposal` wire tool with explicit Submitted-only semantics. Until that lands, proposal-mode adopters surface the eventual products via `publishStatusChange` on `resource_type: 'proposal'`. SKILL gains a "Proposal generation is NOT `get_products`" subsection; specialism interface JSDoc updated; migration doc reflects the carve-out.

  After salesagent feedback #3, #7 (TenantRegistry hardening) and protocol-M2 (status-change resource taxonomy):
  - **TenantRegistry — JWKS race window closed.** `register()` previously dropped tenants in `'unverified'` health (which `resolveByHost` treated as servable for graceful degradation). Result: a tenant registered with a wrong signing key would serve signed responses no buyer can verify for ~60s until the first refresh detected the mismatch. Now: new `'pending'` health state distinct from `'unverified'`; tenants land in `'pending'` until first validation succeeds; `resolveByHost` refuses traffic for `'pending'` tenants (host transport responds 503 + Retry-After). `'unverified'` is now reserved for tenants that were previously healthy and had a transient recheck failure — those still resolve (graceful degradation for known-good tenants). New `register({ awaitFirstValidation: true })` opt returns the resolved status synchronously so deploy scripts can gate on the validation outcome. `runValidation` now catches validator throws (Emma round-1 #16) — closes the stuck-pending failure mode where a thrown validator left the tenant unable to transition.
  - **TenantRegistry — admin-API auth guidance documented.** `register()` JSDoc now explicitly calls out that any caller invoking `register` can introduce a tenant that signs outbound webhooks; hosts wiring an HTTP/RPC endpoint in front MUST gate it with operator-level auth. Framework doesn't ship admin-HTTP scaffolding because the right auth shape varies by deployment.
  - **DNS-rebinding pin-and-bind documented; v6.1 ships built-in.** The framework's URL validator catches the obvious SSRF surfaces against the literal hostname, but DNS rebinding (A-record TTL flips to a private IP between validate and fetch) is wire-legal under that check. Production adopters MUST mitigate via egress proxy with allowlist (deployment-side) or pin-and-bind custom `fetch` (SDK-side via `createWebhookEmitter({ fetch })` opt). Tracking issue [adcp-client#1038](https://github.com/adcontextprotocol/adcp-client/issues/1038); v6.1 ships a built-in `createPinAndBindFetch` so SSRF protection is on out-of-the-box. SKILL "Custom webhook emitter" gains a "DNS rebinding — production hardening" subsection with the two mitigations.
  - **`StatusChangeResourceType` documented as SDK-canonical until spec consolidates.** Filed [adcp#3412](https://github.com/adcontextprotocol/adcp/issues/3412) proposing a normative `enums/status-change-resource-type.json`. SDK keeps current 10-value working set (`media_buy`, `creative`, `audience`, `signal`, `proposal`, `plan`, `rights_grant`, `delivery_report`, `property_list`, `collection_list`); type widened with `(string & {})` for forward-compat so adopters publishing custom categories (e.g., `'x-pcim_session'`) still typecheck. JSDoc documents the convention to `x-`-prefix custom values to reduce collision risk with the eventual normative enum.

  After round-6 expert red-team (DX + security + protocol + code-reviewer in parallel) on the unified-hybrid + TenantRegistry-path-routing landing, additional cleanup:
  - **DX-B1 worked example aligned with unified hybrid shape.** `examples/decisioning-platform-mock-seller.ts` previously shipped two separate classes — `MockSyncSeller` and `MockHitlSeller` — illustrating the dropped dual-method shape. The example now ships a single `MockHybridSeller` that branches per call: `isPreApprovedBuyer(req)` returns `Success` immediately; the slow path returns `ctx.handoffToTask(async taskCtx => { ... })`. Predicate-based branching is the canonical adopter pattern (any signal works — buyer trust score, product rules, channel mix, brand-safety category) so adopters reading the example see the shape they should write end-to-end. Corrected to spec wire shape: `media_buy_deliveries` (was `media_buys`), `patch.paused` (was `patch.active`), no `revision` field on the wire success arm.
  - **Sec-M1 JWKS fetch timeout.** `createDefaultJwksValidator({ uri, timeoutMs })` now defaults to `AbortSignal.timeout(timeoutMs ?? 10_000)` on the JWKS fetch. Previous behavior allowed a slow JWKS host to hold the validation timer's resolution promise indefinitely — under Emma's TenantRegistry health-check loop this became a head-of-line blocker against the rest of the validation queue when one tenant's IdP responded slowly. The default 10s budget fits well inside the registry's 60s revalidate cadence; adopters with strict SLOs override down. Returns the existing `transient` rejection on timeout so the registry stays in `'pending'`/`'unverified'` instead of disabling the tenant.
  - **CR-1 `routeIfHandoff` dispatch helper extracted.** Three near-identical `isTaskHandoff` branches in `from-platform.ts` (sales `createMediaBuy`, sales `syncCreatives`, creative `syncCreatives`) drifted across rounds — different error mappings, slight projection differences. Collapsed into one `routeIfHandoff(taskRegistry, opts, result, project)` helper that owns marker detection, `_extractTaskFn`, `dispatchHitl`, and the inner-result-to-wire `project` callback. Each call site now reads as `return routeIfHandoff(taskRegistry, opts, result, fn => projectedSuccess)`. Eliminates the drift surface for round-7+ refactors.
  - **CR-2 query-string and fragment stripping on path routing.** `TenantRegistry.resolveByRequest(host, pathname)` callers passing `req.url` directly (common pattern in Express middleware) previously fed query strings and fragments into `pathPrefixMatches` — a tenant registered at `/agent` would not match a request to `/agent?token=foo` because `/agent?token=foo` isn't a prefix of `/agent` and vice versa. Defensive `stripQueryAndFragment()` runs before prefix matching. JSDoc on `pathPrefixMatches` documents the caller contract: `resolveByRequest` callers can pass `req.url` directly; `pathPrefixMatches` callers should normalize first. New regression test pins the behavior.
  - **DX-2 SKILL "Multi-tenant hosting" section.** The TenantRegistry primitive shipped without SKILL coverage — adopters reading the SKILL had no entry point for the multi-tenant shape, even though the hooks (subdomain routing, path-prefix routing, `'pending'` health gate, JWKS validation cadence) were all wired. New section walks adopters through registry construction, `register({ host, pathPrefix?, ... })`, the `awaitFirstValidation` opt for deploy gating, the admin-auth contract on the `register` endpoint, and the shared-task-registry namespacing pattern (`tenant_${tenantId}_${accountId}` keys when one Postgres registry is shared across N tenants).
  - **CR-L1 `@internal` on framework-private context builders.** `to-context.ts`'s `buildRequestContext` and `buildHandoffContext` are framework-internal — adopters never call them — but they were leaking into the public `.d.ts` rollup as exported symbols, polluting the autocomplete surface and inviting adopters to construct `RequestContext` themselves (which would skip the dispatch-time `ctx.account` resolution). Added `@internal` block on the file header so API-Extractor strips them from the published rollup.
  - **CR-3 / Protocol-L2 `_taskFn` moved to module-private WeakMap.** The `TaskHandoff<T>` marker previously carried `_taskFn` as a public-typed field; even though `Object.freeze` prevented mutation, the type leaked into adopter autocomplete and a determined adopter could synthesize a marker by reading the `Symbol.for('@adcp/decisioning/task-handoff')` brand and attaching their own function. Closed: `_createTaskHandoff` stores the function in a module-private `WeakMap<object, taskFn>`; the marker carries only the brand symbol + a phantom `_taskResult?: TResult` field for type-system narrowing. Framework dispatch reads via `_extractTaskFn(handoff)` (an `@internal` getter that returns `undefined` when the marker isn't in the WeakMap). `isTaskHandoff` now also checks `taskHandoffFns.has(marker)` so an adopter manually shaping `{ [BRAND]: true }` doesn't get treated as a real handoff. Forgery-resistant by construction.
  - **Sec-L4 Postgres registry tenant-prefix JSDoc.** `createPostgresTaskRegistry` now JSDocs the multi-tenant deployment pattern: when one registry is shared across N tenants, callers SHOULD namespace task ids as `tenant_${tenantId}_${accountId}_${uuid}` (or use one registry per tenant) so cross-tenant `getTask(taskId)` probes return null even when the same UUID was minted for multiple tenants. The framework's tenant-scoped `getTaskState(taskId, expectedAccountId)` already enforces tenant isolation at read time, but a defense-in-depth note at the registry entry point prevents adopters from leaning on the shared store as a flat namespace.
  - **Bonus: identity-graph lifecycle test stabilization.** Pre-existing flake in `test/server-decisioning-identity-graph.test.js` (fixed-200ms-sleep waiting for `matched → activating → active` event chain) replaced with a polling `waitFor(predicate, { timeoutMs: 2000 })` helper. Test passed 8/8 reruns under round-6 build load; previous shape failed ~20% of runs.

  After Emma round-7 sample-platform sim flagged that the 5 worked examples in `examples/decisioning-platform-*.ts` had been silently drifting — none of them were in `tsconfig.examples.json`'s `include` list, so spec / SDK churn over rounds 1-6 left them with ~30 type errors collectively — gated and rewrote:
  - **Gated all 5 sample platforms in `tsconfig.examples.json`.** `mock-seller`, `broadcast-tv`, `identity-graph`, `multi-tenant`, and `programmatic` now run through `npm run typecheck:examples` (already wired in `.github/workflows/ci.yml`). Adopters who copy from these files no longer ship code that doesn't compile against the latest SDK; future regressions surface at PR-time.
  - **`broadcast-tv` rewritten to the unified hybrid shape.** The file had been left on the dropped `getProductsTask` / `createMediaBuyTask` / `syncCreativesTask` shape from before round-2 hybrid-seller pivot. Replaced with `getProducts` (sync catalog read; brief-based proposal generation deferred to adcp#3407 `request_proposal` per round-5 carve-out), `createMediaBuy(req, ctx) → ctx.handoffToTask(...)` for trafficker review + IO sign-off, and `syncCreatives(creatives, ctx) → ctx.handoffToTask(...)` for S&P review. Pre-flight runs sync regardless of path so bad budgets reject before allocating a task id.
  - **Wire field-name corrections across `broadcast-tv` and `programmatic`** (the round-7 wire-shape drift Emma flagged): `patch.active` → `patch.paused` (the wire field name; semantics are also inverted), `media_buys: []` → `media_buy_deliveries: []` on `GetMediaBuyDeliveryResponse`, `publisher_properties: { reportable: true }` (object) → `publisher_properties: [{ publisher_domain, selection_type: 'all' }]` (array of `PublisherPropertySelector`), `pricing_options: [{ rate, ... }]` → `[{ pricing_option_id, fixed_price, ... }]`. Also added the now-required `packages: []` field on `CreateMediaBuySuccess` and the `date_range_support` field on `ReportingCapabilities`. `available_dimensions` (a fictional field on `ReportingCapabilities`) replaced with the spec-required `available_reporting_frequencies` / `expected_delay_minutes` / `timezone` / `supports_webhooks` / `available_metrics`.
  - **`MediaChannel` enum corrections.** Samples were using `'video'` and `'native'` which aren't in the AdCP 3.0 GA enum (`display | olv | social | search | ctv | linear_tv | radio | streaming_audio | podcast | dooh | ooh | print | cinema | email`). `'video'` collapsed to `'olv'` (online video) for programmatic + mock-seller, `'linear_tv'` for broadcast-tv. `'native'` dropped (no spec equivalent — native is a creative format, not a channel).
  - **`AudienceStatus` collapse on `identity-graph`.** The wire enum is `'processing' | 'ready' | 'too_small'`. Sample's internal lifecycle (`matching` → `matched` → `activating` → `active` → `failed`) is richer; refactored so the rich stages flow through `publishStatusChange.payload` (freeform JSON — buyers subscribed to the bus see the full lifecycle) while `getAudienceStatus` returns the wire-flat enum via a `toWireStatus(stage)` collapse. New `IdentityGraphStage` type makes the internal-vs-wire boundary explicit.
  - **Metadata generic threading fixed across all 5 samples.** Per-platform `Meta` interfaces (`MockSellerMeta`, `BroadcastTvMeta`, `IdentityGraphMeta`, `ProgrammaticMeta`) now extend `Record<string, unknown>` via `[key: string]: unknown` index signature so they're assignable to the framework's `TMeta = Record<string, unknown>` default. Specialism-method blocks annotated with the per-platform meta (`SalesPlatform<MockSellerMeta>`, `AudiencePlatform<IdentityGraphMeta>`) so adopter-defined `ctx.account.metadata` access typechecks instead of silently widening to `Record<string, unknown>`.
  - **`identity-graph` ergonomic fix (Emma DX-3).** Dropped the `audiences_platform` private field + `get audiences()` getter indirection — `audiences: AudiencePlatform<IdentityGraphMeta> = { ... }` is declared directly on the class.
  - **Renamed audience-sync sample from `liveramp` to `identity-graph`.** The previous sample was named after a real company (LiveRamp), creating an implied endorsement / partnership / reverse-engineering signal that adopters could read as "this is the LiveRamp integration." The category covers many vendors (LiveRamp, Oracle Data Cloud, Salesforce CDP, Neustar) — `IdentityGraphProvider` is the neutral category name. File renamed (`examples/decisioning-platform-liveramp.ts` → `…-identity-graph.ts`); test file renamed; class/type names re-prefixed (`LiveRampAudienceProvider` → `IdentityGraphProvider`, `LiveRampMeta` → `IdentityGraphMeta`, `LiveRampStage` → `IdentityGraphStage`); metadata field `ramp_id` → `graph_id`. JSDoc still references "LiveRamp / Oracle Data Cloud / Salesforce CDP / Neustar" as industry examples in prose — that's category description, not branded integration.
  - **`multi-tenant` return type cleaned up.** Replaced `ReturnType<NonNullable<...>>['server']` gymnastics with a direct `DecisioningAdcpServer` import from `@adcp/client/server/decisioning`. Added a loud "🔴 PRODUCTION: REPLACE WITH KMS-BACKED LOADER" block above `TENANT_KEYS` so adopters who copy the file don't ship the placeholder modulus values.
  - **`mock-seller` `pricing_options.rate` → `fixed_price`.** Last surviving wire-name bug in the gold-standard sample.
  - **CI gate going forward.** `typecheck:examples` is invoked from `.github/workflows/ci.yml` line 73; sample regressions now break PRs instead of accumulating silently. The samples are exemplars — strictly typechecked is the right posture.

  After training-agent round-3 review surfaced two SDK gaps (F5 + comply-testing — F2 landed in parallel via [`resolve-context-billing-helpers`](./resolve-context-billing-helpers.md)), additional fixes:
  - **F5 — `pollAudienceStatuses(audienceIds[], ctx) -> Map<id, AudienceStatus>` replaces `getAudienceStatus(audienceId, ctx)`.** Real identity-graph upstream APIs return per-audience-id batches; v6's single-id shape forced every adapter to write a single-id wrapper over an N-call loop or build their own batch helper. Renamed to plural; returns a `Map` so missing audiences are absent keys rather than thrown errors. Single-id polling is `(await pollAudienceStatuses([id], ctx)).get(id)`. Identity-graph sample, identity-graph test fixture, and the from-platform test fixture all updated. Preview-window breaking rename — no SDK consumers in production.
  - **First-class `comply_test_controller` wiring on `createAdcpServerFromPlatform`.** The wire tool exists in the spec (`schemas/cache/3.0.0/bundled/protocol/comply-test-controller-*.json`), generated types are in place (`tools.generated.ts:14199`), and the building block (`createComplyController` in `src/lib/testing/comply-controller.ts`) was already shipped. The gap was that v6 adopters couldn't compose them through the framework — they had to construct the controller manually after `createAdcpServerFromPlatform` returned. Now: pass `opts.complyTest: ComplyControllerConfig` and the framework wires registration automatically.
    - **Discovery field on `DecisioningCapabilities`.** New `compliance_testing?: ComplianceTestingCapabilities` block (mirrors the wire `compliance_testing.scenarios` field on `core/get-adcp-capabilities-response.json`). Adopters declare `compliance_testing: {}` to opt in; the framework auto-derives `scenarios` from which `complyTest` adapters are supplied (or honors an explicit `scenarios: [...]` if the adopter wants to narrow / widen).
    - **Capability/adapter consistency check.** Two failure modes the framework refuses at construction (both throw `PlatformConfigError`):
      - Capability declared, adapter missing: discovery field would project but the wire tool has no implementation. Conformance harnesses would dispatch and crash.
      - Adapter wired, capability not declared: discovery field missing from `get_adcp_capabilities` so buyers / harnesses can't tell the agent supports compliance testing.
    - **Sandbox gating** is the adopter's responsibility — `complyTest.sandboxGate(input)` for per-request, plus the recommendation to gate construction on `process.env.ADCP_SANDBOX === '1'` so production builds never register the tool. The existing `createComplyController` ungated-warning fires unchanged.
    - **Closes the training-agent's most cited risk:** the storyboard suite depends on `comply_test_controller` parity with v5 handler-style behavior. v6 adopters can now declare adapters in one place; the framework owns registration, list_scenarios derivation, capability projection, and gate enforcement.
    - **6 new tests** in `test/server-decisioning-comply-test.test.js` pin: registration happens when `complyTest` is supplied; auto-derived `list_scenarios` matches declared adapters; tool isn't registered when `complyTest` is omitted; both consistency-check failure modes throw `PlatformConfigError`; `sandboxGate` denial returns `FORBIDDEN`.
    - **SKILL section** under "Compliance testing" walks adopters through the adapter shape, the capability declaration requirement, the three sandbox-gate layers, and the consistency-check failure modes.

  After training-agent round-3 review surfaced two more SDK gaps (capability projections + brand-rights), additional fixes:
  - **Capability projections (`audience_targeting`, `conversion_tracking`, `content_standards`).** Three discovery blocks live under `get_adcp_capabilities.media_buy.*` in the wire spec. v6 platforms had no clean way to declare them — adopters were either using the framework's `overrides.media_buy` escape hatch (which v6 strips via `Omit<AdcpServerConfig, 'capabilities'>`) or shipping a custom `get_adcp_capabilities` tool (which the framework refuses at construction). Closed by adding three optional fields to `DecisioningCapabilities` (typed against the wire shapes via `NonNullable<NonNullable<GetAdCPCapabilitiesResponse['media_buy']>['…']>`); when any are present, the framework projects them onto the inner `AdcpServerConfig.capabilities.overrides.media_buy.{…}` deep-merge seam. **Adopters declare what they support; framework projects to the wire — no custom tool, no escape hatch.** 5 new tests in `test/server-decisioning-capability-projections.test.js` pin per-block + multi-block projection + omission no-op behavior. SKILL gains a "Capability projections" section.
  - **`BrandRightsPlatform<TMeta>` specialism — 3 of 5 wire tools first-class.** `brand-rights` had been on the deferred list because two surfaces (`update_rights`, `creative_approval`) lack `AdcpToolMap` infrastructure. But three (`get_brand_identity`, `get_rights`, `acquire_rights`) HAVE schemas + dispatch — those didn't need to wait. New `BrandRightsPlatform<TMeta>` interface in `src/lib/server/decisioning/specialisms/brand-rights.ts`; new `brandRights?` field on `DecisioningPlatform`; `RequiredPlatformsFor<S>` extended to map `'brand-rights'` → `{ brandRights: BrandRightsPlatform<TMeta> }`; `validatePlatform` checks coverage; new `buildBrandRightsHandlers` in `from-platform.ts` wires the 3 dispatch sites. **`acquire_rights` uses its native wire-spec async shape** (`AcquireRightsAcquired | AcquireRightsPendingApproval | AcquireRightsRejected`) — NOT the framework task envelope. The spec defines its own approval-status polling mechanism; adopters return the spec arm directly. 6 new tests in `test/server-decisioning-brand-rights.test.js` pin: each of the 3 tools dispatches; `Acquired` vs `PendingApproval` arms branch correctly; `AdcpError` projects to wire envelope; missing `brandRights` field with `'brand-rights'` claimed throws `PlatformConfigError`. SKILL gains a "Brand rights" section. Cuts the merge-seam surface for brand-rights adopters from 5 handlers to 2 (`updateRights` + `creativeApproval` stay on the seam until v6.1 when their wire tools land in `AdcpToolMap`).
  - **Updated stale `validatePlatform` "future specialisms" test.** The previous test used `'brand-rights'` as a forward-compat example; now that brand-rights is a known specialism, the test uses `'signed-requests'` (genuinely cross-cutting / no platform field).

  Closes the training-agent's two persistent capability-override and merge-seam gaps. After this PR, the only remaining v6.0 gap is the 2-handler `update_rights` + `creative_approval` merge-seam — which is genuinely upstream-blocked (those wire tools aren't in `AdcpToolMap` yet).

  After the four-expert round-8 review (protocol / code-review / adopter-product / DX in parallel) of capability projections + `BrandRightsPlatform`, additional fixes — convergent must-fixes across all four reviews:
  - **Wire-shape correctness (must-fix from all 4 reviewers).** SKILL example, brand-rights interface JSDoc, and test fixtures all drifted from the actual wire types — `rights_grant_id` → `rights_id`, `offerings` → `rights`, `approval_workflow` → `detail` + `estimated_response_time`, `rejection_reason` → `reason`, `getBrandIdentity` returning a nested `{ brand, identity: {...} }` structure when the wire shape is `{ brand_id, house, names[], ... }` flat. Tests passed only because validation was `'off'`. Rewrote the brand-rights test fixtures with the actual wire shapes and flipped happy-path validation to `'strict'` — strict validation immediately caught a missing required `revocation_webhook` field on `acquire_rights` requests + an ISO date-vs-datetime format mismatch, exactly the kind of drift the off-mode tests would have shipped silently. SKILL example rewritten with fully-populated `AcquireRightsAcquired` / `PendingApproval` / `Rejected` arms typed against the re-exported wire types.
  - **Features-boolean flip (protocol must-fix M2).** When `platform.capabilities.audience_targeting` (or `conversion_tracking` / `content_standards`) is declared, the framework now ALSO forces `media_buy.features.<name>` to `true` in the projected `get_adcp_capabilities` response. The framework's auto-derivation defaulted these booleans to `false`; buyers gating on `features.audience_targeting === false` would have skipped the rich block sitting next to it. New test in `server-decisioning-capability-projections.test.js` pins this behavior.
  - **`acquire_rights` polling-mechanism JSDoc correction (protocol must-fix M1, all 4 reviewers).** Previous JSDoc claimed "buyers poll the spec's own approval-status mechanism, not `tasks_get`" — but the spec defines NO polling tool for `acquire_rights`. The async delivery path is the buyer's `push_notification_config` webhook (the response carries the eventual `Acquired` or `Rejected` outcome). JSDoc + SKILL rewritten to call out webhook-only delivery explicitly so adopters don't ship a non-spec polling endpoint.
  - **`mediaBuyOverrides` typed at declaration (code-review should-fix).** Replaced `Record<string, unknown>` + cast with `Partial<NonNullable<GetAdCPCapabilitiesResponse['media_buy']>>` from the start. Catches future field-name typos statically rather than at runtime; reads more directly via spread-conditional pattern (`...(at != null && { audience_targeting: at })`) instead of mutating an empty object.
  - **Wire types re-exported from `@adcp/client/server/decisioning` (DX should-fix).** Adopters typing their own helpers no longer have to import from the deep `@adcp/client/types/core.generated` path (the file CLAUDE.md tells agents not to read). New re-exports: `GetBrandIdentityRequest`, `GetBrandIdentitySuccess`, `GetRightsRequest`, `GetRightsSuccess`, `AcquireRightsRequest`, `AcquireRightsAcquired`, `AcquireRightsPendingApproval`, `AcquireRightsRejected`, `RightUse`, `RightType`, `RightsConstraint`, `RightsTerms`, `RightsPricingOption`, `GenerationCredential`.
  - **`AcquireRightsError` 4th-arm documented as `AdcpError` path (code-review should-fix).** The wire spec defines four `acquire_rights` response arms; the platform interface intentionally accepts only the 3 success arms because the framework's existing `BrandRightsHandlers['acquireRights']` type doesn't carry the 4th arm in its return union. Multi-error rejection is the canonical `AdcpError('INVALID_REQUEST', { details: { errors: [...] } })` path that other specialisms use; JSDoc now spells this out so adopters who need batch-error semantics aren't stuck on the missing arm.
  - **Import-path comment in `brand-rights.ts` (code-review nice-to-have).** Brand-rights is the only specialism whose wire types live in `core.generated` rather than `tools.generated`. Added a comment near the import block so a future "consistency" PR doesn't try to "fix" the import path and break the build.
  - **Merge-seam test for `opts.brandRights` (code-review nice-to-have).** New test pins that adopter-supplied `opts.brandRights.updateRights` (a v6.1 surface not yet in `AdcpToolMap`) wires alongside platform-derived handlers without shadowing them.

  After re-examining the three deferred items, two were not actually blocked by anything beyond scope-management instinct. Landing them now:
  - **Brand-protocol capability block** (protocol must-fix M3) — landed. New `BrandCapabilities` type on `DecisioningCapabilities` with a `brand?` field. Wire projection in `from-platform.ts` via `overrides.brand` (parallel to the existing `overrides.media_buy` projection). Auto-derives `rights: true` when `BrandRightsPlatform` is supplied; adopters declare `right_types`, `available_uses`, `generation_providers`, `description`. New regression test in `server-decisioning-capability-projections.test.js`.
  - **`RequiredCapabilitiesFor<S>` compile-time gate** (DX nice-to-have) — landed. New generic mirroring `RequiredPlatformsFor<S>` that maps specialism claims to required capability blocks. v1.0 mapping populated conservatively: `'brand-rights'` requires `capabilities.brand` (since the SKILL recommends declaring it for proper discovery projection); other specialisms have no required capability blocks today (`audience_targeting` is recommended for `audience-sync` but not enforced — anonymous-only sync platforms would trip the constraint without a real benefit). Applied as a second intersection on `createAdcpServerFromPlatform<P>`'s platform parameter alongside `RequiredPlatformsFor`. The fallthrough type is `{}` (not `Record<string, never>`) so unmapped specialisms intersect to identity. Two compile-time tests in `decisioning.type-checks.ts` pin behavior.
  - **`getBrandIdentity` discovery vs identity-resolution** — genuinely upstream-blocked; spec needs a `search_brands` wire tool. Filed [adcp#3480](https://github.com/adcontextprotocol/adcp/issues/3480) proposing the verb. SKILL "Brand rights" section documents the workaround (use `getRights` with a brand-agnostic query, project unique `brand_id` values, fan out `getBrandIdentity` per brand) until the spec lands.

  **Result:** the persistent training-agent gap list collapses to **one item** that is genuinely upstream-blocked (the `update_rights` + `creative_approval` merge-seam), with all other gaps either landed in this PR or filed upstream with documented workarounds.

  193/193 decisioning tests + `npm run typecheck:examples` + full lib build all green. **Strict-validation regression test now lives in `server-decisioning-brand-rights.test.js`** so future wire-shape drift on this surface fails CI.

- Updated dependencies [a1c144f]
- Updated dependencies [a1c144f]
- Updated dependencies [a1c144f]
- Updated dependencies [5d9a0a1]
- Updated dependencies [a1c144f]
- Updated dependencies [e28b982]
- Updated dependencies [6066a7a]
- Updated dependencies [a1c144f]
- Updated dependencies [a1c144f]
- Updated dependencies [a1c144f]
- Updated dependencies [a1c144f]
- Updated dependencies [c44cad8]
- Updated dependencies [3f82d6f]
- Updated dependencies [5223f9a]
- Updated dependencies [a1c144f]
- Updated dependencies [a1c144f]
- Updated dependencies [a1c144f]
- Updated dependencies [a1c144f]
- Updated dependencies [a1c144f]
- Updated dependencies [a1c144f]
- Updated dependencies [a1c144f]
- Updated dependencies [a1c144f]
- Updated dependencies [a1c144f]
- Updated dependencies [6066a7a]
- Updated dependencies [26de489]
- Updated dependencies [ea69989]
- Updated dependencies [54789c6]
- Updated dependencies [a1c144f]
- Updated dependencies [105d0a4]
- Updated dependencies [6066a7a]
- Updated dependencies [5f56f10]
- Updated dependencies [a1c144f]
- Updated dependencies [6066a7a]
- Updated dependencies [a1c144f]
- Updated dependencies [a1c144f]
- Updated dependencies [a1c144f]
- Updated dependencies [6066a7a]
- Updated dependencies [14afa67]
- Updated dependencies [a1c144f]
- Updated dependencies [a1c144f]
- Updated dependencies [a1c144f]
- Updated dependencies [a1c144f]
- Updated dependencies [7b28886]
- Updated dependencies [6c25e2d]
- Updated dependencies [03952a0]
  - @adcp/sdk@6.0.0

## 5.25.1

### Patch Changes

- d18ccd6: fix(protocols): caller-supplied `adcp_major_version` / `adcp_version` no longer overridden by SDK pin (#1072)

  **Behavior change for 5.24/5.25 users.** Restores the pre-5.24 caller-wins contract for the wire version envelope. If you pinned `@adcp/sdk` to 5.24 or 5.25 and were relying on the SDK to override stale `adcp_major_version` / `adcp_version` values in your `args` payload, those values now reach the seller verbatim. The 5.25 server-side field-disagreement check in `createAdcpServer` (per spec PR `adcontextprotocol/adcp#3493`) is the correct enforcement boundary for stale-config drift — a 3.1+ buyer carrying both fields with mismatched majors still gets `VERSION_UNSUPPORTED` from a compliant seller.

  **Why.** The 5.24 SDK-overrides-caller behavior made it impossible for conformance harnesses using `ProtocolClient` as buyer transport to probe seller version negotiation. The bundled `compliance/cache/3.0.1/universal/error-compliance.yaml` `unsupported_major_version` step (which sends `adcp_major_version: 99` to elicit `VERSION_UNSUPPORTED`) could not pass — the 99 was rewritten to the SDK pin before leaving the buyer.

  **Changes:**
  - All four wire-injection sites (in-process MCP, HTTP MCP, A2A, `createMCPClient`, `createA2AClient`) now route through a new `applyVersionEnvelope(args, envelope)` helper. Single chokepoint, single test surface, no future-refactor drift between branches. Helper is exported.
  - `adcp_version` added to `ADCP_ENVELOPE_FIELDS` so a caller-supplied 3.1+ release-precision string survives `SingleAgentClient`'s per-tool schema-strip path. Mirrors the existing `adcp_major_version` carve-out — and 3.1 sellers MUST accept `adcp_version` at the envelope layer per spec PR #3493, so strict-schema rejections were a seller bug regardless.

  No schema or wire changes — purely a buyer-side fix.

- 54790cf: feat(server): single-field VERSION_UNSUPPORTED check (#1075)

  Closes spec-conformance gap from PR #1073 review. `createAdcpServer`'s field-disagreement check (PR #1067) only fired when both `adcp_version` and `adcp_major_version` were present and the majors disagreed. A buyer sending only `adcp_major_version: 99` (or only `adcp_version: "99.0"`) bypassed the cross-check; the spec contract that "sellers validate against their supported `major_versions` and return VERSION_UNSUPPORTED if unsupported" was silently violated.

  **Server-side changes:**
  - New file-private helpers `getAdvertisedSupportedMajors` and `buildSupportedVersionsList`. They union the parsed majors from `capConfig.major_versions` (deprecated integer list) and `capConfig.supported_versions` (release-precision strings, AdCP 3.1+ per spec PR `adcontextprotocol/adcp#3493`), falling back to the server pin's major when both lists are absent.
  - New single-field rejection runs after the existing dual-field check. Resolves the effective major from whichever envelope field the buyer set, then returns `VERSION_UNSUPPORTED` with `details.supported_versions` populated when the major falls outside the seller's advertised window.
  - The dual-field check now also populates `details.supported_versions` so buyers can downgrade and retry after either kind of disagreement (previously message-only). **Additive behavior change:** buyers using `extractVersionUnsupportedDetails` (PR #1073) will now find `details.supported_versions` populated on dual-field disagreements where it was previously absent. Buyers that special-case `details.supported_versions === undefined` to distinguish dual-field from single-field failures will see a behavior change; the recommended pattern is to inspect the message text instead.
  - New `AdcpCapabilitiesConfig.supported_versions?: string[]` so 3.1+ sellers can declare release-precision strings the framework consults during the check and echoes in the error envelope.

  **Conformance-runner change (test isolation fix):**

  `runToolFuzz` now overwrites `adcp_major_version` on each generated sample before dispatch (pinned to `ADCP_MAJOR_VERSION` — no hardcoded string, tracks the bundle automatically). These are transport-layer envelope fields the buyer SDK fills automatically via `applyVersionEnvelope` (PR #1073); leaving fast-check's schema-driven values in place would trigger `VERSION_UNSUPPORTED` rejections on most samples (1-99 integer range vs. seller's `[3]` window), masking handler bugs the fuzzer is meant to catch. Pinning at the runner layer (rather than dropping the field from the arbitrary) keeps `schemaToArbitrary` pure and the existing schema-validity threshold tests stable. Version negotiation is exercised separately by storyboards.

  Combined with #1073, fully unblocks the storyboard skip in `adcontextprotocol/adcp#3626` — the framework's own seller fixture now passes the bundled `error_compliance/unsupported_major_version` step.

- Updated dependencies [d18ccd6]
- Updated dependencies [54790cf]
  - @adcp/sdk@5.25.1

## 5.25.0

### Minor Changes

- e66bfba: feat: implement AdCP 3.1 release-precision version envelope (spec PR adcontextprotocol/adcp#3493)

  Adds the buyer-side and server-side plumbing for AdCP 3.1's `adcp_version` (string, release-precision) envelope field, alongside continued support for the deprecated integer `adcp_major_version`. Activates automatically when a 3.1+ schema bundle ships and the client/server is pinned to it; 3.0-pinned callers see no behavior change.

  **Buyer-side wire emission.** New `buildVersionEnvelope` helper (in `protocols/index.ts`) builds the per-call wire envelope based on the caller's pin:
  - 3.0 pins → `{ adcp_major_version: 3 }` (matches 3.0 spec exactly; the string field doesn't exist in 3.0)
  - 3.1+ pins → `{ adcp_major_version: 3, adcp_version: '3.1' }` (or `'3.1.0-beta.1'` for prereleases — release-precision = bundle key, prereleases stay verbatim per spec rule 8)

  All four wire-injection sites (`ProtocolClient.callTool` in-process MCP, HTTP path, A2A path, plus `createMCPClient` / `createA2AClient` factories) use the helper. The gate is exported as `bundleSupportsAdcpVersionField(bundleKey)` for callers who need to make the same decision.

  **Capability parsing.** `AdcpCapabilities` gains optional `supportedVersions: string[]` (release-precision) and `buildVersion: string` (full semver) fields, populated when the seller advertises `adcp.supported_versions` and `adcp.build_version` per the new spec. `requireSupportedMajor` reads `supportedVersions` preferentially when present, matching by `resolveBundleKey(pin)`. Falls back to the deprecated `majorVersions` integer array for legacy 3.0 sellers — 3.x backward compat per the spec's SHOULD-only migration cadence. Pre-release pins match exactly per spec rule 8: `'3.1.0-beta.1'` matches only against an identical string in the seller's list, never `'3.1'` GA.

  **Server-side honor + echo.** `createAdcpServer` now:
  - **Detects field-disagreement** per spec rule 7 (must-reject when both fields present and majors disagree). Catches buyer drift before the request reaches the handler — returns `VERSION_UNSUPPORTED` immediately. Skipped when only one field is present.
  - **Echoes `adcp_version` on responses** when the seller pins to 3.1+. The new `injectVersionIntoResponse` helper writes both `structuredContent.adcp_version` and the L2 text-fallback JSON, mirroring `injectContextIntoResponse`'s dual-write pattern. The echoed value is the seller's `resolveBundleKey(adcpVersion)`. Note: this PR doesn't yet implement the spec's "release served" downshift (a 3.1 seller serving a 3.0 buyer at 3.0 echoes `'3.0'`); we always echo the seller's own pin. Single-version sellers are correct; multi-version downshift lands separately once the negotiation surface is designed.

  **`VERSION_UNSUPPORTED.error.data` parsing.** New `extractVersionUnsupportedDetails(input)` helper (exported from `@adcp/sdk`) reads the structured details a 3.1 seller carries on a `VERSION_UNSUPPORTED` rejection per `error-details/version-unsupported.json`:

  ```ts
  import { extractVersionUnsupportedDetails } from '@adcp/sdk';

  try {
    await client.createMediaBuy(...);
  } catch (err) {
    const details = extractVersionUnsupportedDetails(err.adcpError);
    if (details?.supported_versions) {
      // Pick a compatible version and retry with a downgraded pin
      const downgraded = details.supported_versions.find(v => v.startsWith('3.'));
      // ... reconstruct client with adcpVersion: downgraded
    }
  }
  ```

  Tolerates four wrapper shapes (raw `data`, `error.data`, `error.details`, `adcp_error.data`) since transport boundaries surface the structured payload at different nesting depths. Returns `undefined` when the envelope is missing or empty — callers should treat absence as "seller didn't tell me" and fall back to a fixed strategy.

  **What this PR does NOT yet do** — and why:
  - **Schema sync.** The new schemas live on `adcontextprotocol/adcp` main but no spec-repo release tag has been cut yet that includes the merged change. `npm run sync-schemas` will pull them when the tag exists; `dist/lib/schemas-data/3.1.0-beta.X/` ships with that build. Until then, 3.1 pins still throw `ConfigurationError` (no bundle) at construction. The wire/parse logic this PR adds works against fixture data and unit-tests; the end-to-end matrix activates the day the bundle ships.
  - **Multi-version "release served" downshift.** A 3.1 seller serving a 3.0 buyer at 3.0 should echo `'3.0'` per spec, not `'3.1'`. Today this PR always echoes the seller's own pin. Adding downshift requires deciding how the seller declares "I can serve at 3.0 too" (probably via `supported_versions: ['3.0', '3.1']` on capabilities) and threading that through the dispatch path. Tracked as a follow-up; today's emit is correct for single-version sellers and harmless overstatement for any 3.1+ seller serving its own pin.
  - **Buyer-side response-echo introspection.** The seller's `adcp_version` echo is in the response body but the SDK doesn't yet surface it as a typed signal on `TaskResult` for downgrade-detection instrumentation. Callers can read it directly from `result.data.adcp_version` for now.

  **What developers see:**
  - Default-version users: nothing changes. SDK pins to 3.0.1, no `adcp_version` emitted.
  - Forward-compat adopters (when 3.1 bundle ships): bump SDK, change `adcpVersion: '3.1.0-beta.1'`. `adcp_version` automatically emits on every call. `requireSupportedMajor` matches by release-precision against the seller's `supported_versions`. Field-disagreement protection catches buyer config drift.
  - Server adopters (sellers): same — pin to 3.1 in `createAdcpServer({ adcpVersion: '3.1...' })` and the echo + field-disagreement check activate automatically.

  **Spec migration alignment:**
  - 3.1 (this surface ships): SHOULD on both sides per spec migration table.
  - 3.2: AdCP compliance grader makes echo + `supported_versions` blocking.
  - 4.0: MUST on both sides; integer `adcp_major_version` removed; SDK ships a major bump that drops the integer.

  This SDK PR fully covers the "JS — `@adcp/client`" entry referenced in spec PR #3493's downstream conformance checklist. End-to-end tests against real 3.1 schemas land separately when the bundle is cut.

### Patch Changes

- 6a36db6: fix(conformance): enforce storyboard required_tools pre-flight gate in runner

  The `required_tools` field on `Storyboard` was declared and typed but never
  enforced on the normal execution path — only consulted in the degraded-auth
  bailout in `comply.ts`. This meant storyboards targeting media-buy tools (e.g.
  `past_start_enforcement`) ran against signals-only, creative, or governance
  agents that advertise none of those tools, producing misleading per-step
  failures instead of a clean skip.

  `executeStoryboardPass` now checks `storyboard.required_tools` immediately
  after profile discovery. If the storyboard declares required tools and the
  agent advertises none of them, the runner returns a synthetic
  `overall_passed: true` / `skip_reason: 'missing_tool'` result. Agents that
  advertise at least one required tool proceed normally.

- Updated dependencies [e66bfba]
- Updated dependencies [ef1aa17]
- Updated dependencies [587177f]
  - @adcp/sdk@5.25.0

## 5.24.0

### Minor Changes

- 81ac755: feat: wire `adcpVersion` per-instance through validators + protocol layer (Stage 3 Phase B + C)

  The per-instance `adcpVersion` constructor option now actually drives runtime behavior. Phase A built the per-version schema bundles; this PR plumbs `getAdcpVersion()` from the four constructor surfaces to every place version-keyed code runs:
  - **Validators** — `validateRequest` / `validateResponse` / `validateOutgoingRequest` / `validateIncomingResponse` accept the per-instance version. `SingleAgentClient` passes `resolvedAdcpVersion` to `TaskExecutor`, which forwards it to the validator hooks. `createAdcpServer` passes its `adcpVersion` to its server-side validation calls. A client pinned to `'3.0'` validates against `dist/lib/schemas-data/3.0/`; a future `'3.1.0-beta.1'` pin (once that bundle ships) validates against its own schemas.
  - **Wire-level `adcp_major_version`** — `ProtocolClient.callTool` derives the major per-call from a caller-supplied `adcpVersion` via `parseAdcpMajorVersion`. All four wire-injection sites (in-process MCP, HTTP MCP, A2A factory, MCP factory) use the per-instance major instead of the SDK-pinned `ADCP_MAJOR_VERSION` constant. Default fallback to the constant preserves behavior for callers that don't yet pass a version.
  - **`ProtocolClient.callTool` signature → options object.** Replaces the prior 9-positional-argument tail (`debugLogs?, webhookUrl?, webhookSecret?, webhookToken?, serverVersion?, session?`) with a single `CallToolOptions` object: `callTool(agent, toolName, args, { debugLogs?, webhookUrl?, webhookSecret?, webhookToken?, serverVersion?, session?, adcpVersion? })`. The 3-arg form is unchanged. Reviewers consistently flagged the positional sprawl as a readability cliff after this PR added the 10th slot; the migration lands here so adding any future call-level flag (signing context, governance binding, etc.) doesn't compound the problem. Internal call sites (`TaskExecutor`, `GovernanceMiddleware`, `GovernanceAdapter`, capability-priming recursion, the legacy `Agent` class) are updated alongside; external callers using only the 3-arg form are unaffected.
  - **`requireV3ForMutations`** — generalized from "seller advertises major 3" to "seller advertises the major matching the client's `getAdcpVersion()`". Function name is grandfathered. A 3.x client still expects major 3; a 4.x client (once supported) expects major 4.

  **Phase C — fence lifted.** `resolveAdcpVersion` no longer rejects cross-major pins. The new gate is "schema bundle exists for this version's resolved key" via the new `hasSchemaBundle(version)` helper exported from `@adcp/sdk`. Pinning a value with no shipped bundle (`'4.0.0'` today, `'3.1.0-beta.1'` before the spec repo ships that tag) throws `ConfigurationError` at construction with a clear pointer at `npm run sync-schemas` + `npm run build:lib`. The SDK default `ADCP_VERSION` short-circuits the bundle check (its bundle ships by construction), so no fs cost on the common path.

  Once a future SDK release adds a 3.1 beta or 4.x bundle, those pins start working with no code change here.

  This completes Stage 3's runtime-honest contract: `getAdcpVersion()` is now the single source of truth for both validator selection and wire-level major. Stage 3 Phase D (cross-version test harness — 3.0 client speaking to 3.1 server in one process, once 3.1 ships) lands separately.

  **Governance forwarding now works.** `GovernanceMiddleware` accepts the buyer's `adcpVersion` as a third constructor argument and forwards it to its `check_governance` / `report_plan_outcome` calls — `TaskExecutor` threads `config.adcpVersion` through. `GovernanceAdapter` (server-side) gains an optional `adcpVersion` field on `GovernanceAdapterConfig` that sellers should set to match their `createAdcpServer({ adcpVersion })` value. (Earlier framing was that governance is a separate endpoint with its own pin, so the buyer's pin shouldn't carry; reviewers correctly pushed back — `config.agent` carries no pin of its own, so silent fallback to the SDK constant was the same drift Stage 2 was designed to eliminate.)

  **Legacy `Agent` class now warns at construction.** Adds `@deprecated` JSDoc + a one-time `process.emitWarning` directing users to `SingleAgentClient` / `AgentClient` / `ADCPMultiAgentClient`. Agent does not honor per-instance pins and would silently drift on the wire — surfacing the deprecation rather than letting consumers stumble onto it. Codegen template (`scripts/generate-types.ts`) updated alongside the regenerated `src/lib/agents/index.generated.ts`.

  **`requireV3` renamed to `requireSupportedMajor`.** The function generalized in this PR to check the client's pinned major (3 today, 4 once that's bundled), and the v3-suffixed name is the temporal-context anti-pattern CLAUDE.md calls out. New name is the canonical method on both `SingleAgentClient` and `AgentClient`; the original `requireV3` stays as a `@deprecated` alias delegating to the new name (non-breaking). The config option `requireV3ForMutations` keeps its name — it's a public-config string consumers may persist in env files or config schemas.

  **Polish addressed in this PR:**
  - `resolveWireMajor` (the wire-major helper in `protocols/index.ts`) now throws `ConfigurationError` instead of plain `Error` so direct-call misuse surfaces with the same error class as the construction-time fence.
  - `resolveAdcpVersion`'s short-circuit compares bundle keys, not literal strings — `'3.0'`, `'3.0.0'`, `'3.0.1'` all skip the fs check when they resolve to the same bundle as `ADCP_VERSION`.
  - Imports reordered in `protocols/index.ts` (signing imports above the helper, not below).

  **Wider context:** AdCP spec PR `adcontextprotocol/adcp#3493` proposes a top-level `adcp_version` string field (release-precision, e.g. `'3.0'` / `'3.1'`) on every request and response, alongside the existing integer `adcp_major_version`. RECOMMENDED in 3.1, MUST in 4.0. This SDK PR doesn't yet emit the new field — the integer is sufficient for routing today, and dual-emit is one line once the spec PR merges. Tracking for a follow-up.

- 18ac48a: feat: per-AdCP-version schema loader (Stage 3 Phase A foundation)

  The bundled-schema validator now keeps state per AdCP version instead of a single module-global. The same SDK process can hold compiled validators for `3.0.0`, `3.0.1`, `3.1.0-beta.1`, and any future version side by side, picking the right bundle by the `version` argument that `getValidator` / `validateRequest` / `validateResponse` / `schemaAllowsTopLevelField` / `listValidatorKeys` now accept. All version arguments default to the SDK-pinned `ADCP_VERSION`, so existing call sites keep working unchanged — no runtime behavior changes for callers that don't yet pass a version.

  **Stable releases ship under MAJOR.MINOR keys, prereleases stay exact.** The build copies `schemas/cache/3.0.1/` (or whatever the highest 3.0 patch is) to `dist/lib/schemas-data/3.0/`. Consumer pins of `'3.0.0'`, `'3.0.1'`, or `'3.0'` all resolve to the same bundle via the new `resolveBundleKey` helper — patches are spec-promised non-breaking, so distinct exact-version directories holding the same wire shape would be misleading. Prereleases (`3.1.0-beta.1`, `3.1.0-rc.2`, …) keep full-version directories because pinning a beta is intentional and bit-fidelity matters for cross-version interop tests. The cache itself stays exact-version-named (mirrors the spec repo tag we synced from); only the dist layout collapses. The `latest` symlink and `*.previous` snapshots are skipped.

  Resolution rule (`resolveBundleKey`): stable `MAJOR.MINOR.PATCH` → `MAJOR.MINOR`, bare `MAJOR.MINOR` → unchanged, prerelease semver → unchanged, legacy `vN` → unchanged. Loader state is keyed by the resolved bundle, so `getValidator('foo', 'request', '3.0.0')` and `getValidator('foo', 'request', '3.0.1')` share a single compiled AJV instance — no double-compile cost when callers pass different patch pins for the same minor.

  Source-tree fallback (when `npm run build:lib` hasn't run) finds the highest-patch sibling in the requested minor, matching dist's collapse behavior.

  Sets up Stage 3 Phase B (wire-level plumbing where `SingleAgentClient` / `createAdcpServer` pass their per-instance `getAdcpVersion()` to the validators) and Phase C (lift the cross-major construction-time fence so a 3.0 client can speak to a 3.1 server in one process). No call sites adopted the per-version path yet — that lands in the follow-up. The current `adcpVersion` constructor option still rejects cross-major pins via `resolveAdcpVersion`'s fence; same Stage 2 contract.

  Asking for an unbundled version surfaces a clear `AdCP schema data for version "X" not found … run sync-schemas + build` error rather than silently falling back to the pinned default. New `_resetValidationLoader(version?)` test hook clears one version (or all if no argument).

### Patch Changes

- Updated dependencies [81ac755]
- Updated dependencies [18ac48a]
  - @adcp/sdk@5.24.0

## 5.23.0

### Minor Changes

- 88e3b02: feat: add `adcpVersion` constructor option on client + server surfaces

  `SingleAgentClient`, `AgentClient`, `ADCPMultiAgentClient`, and `createAdcpServer` now accept an `adcpVersion?: AdcpVersion | (string & {})` option that surfaces via a new `getAdcpVersion()` instance method. Typed as a union of `COMPATIBLE_ADCP_VERSIONS` literals plus an open-string escape hatch so editors autocomplete canonical values without forcing a closed enum.

  Defaults to the SDK's pinned `ADCP_VERSION` (currently `'3.0.1'`) when omitted. Pin to an older stable (`'3.0.0'`) or opt into a beta channel (`'3.1.0-beta.1'`) once the corresponding registry ships.

  Validated at construction time via `resolveAdcpVersion`: pins whose derived major differs from `ADCP_MAJOR_VERSION` throw `ConfigurationError` with a roadmap-aware message pointing at Stage 3. This fence keeps Stage 2's wire emission honest while the global `ADCP_MAJOR_VERSION` constant still drives the `adcp_major_version` request field — within major 3, every accepted pin agrees with the wire.

  Plumbing surface only — Stage 2 of the multi-version refactor. The configured value is exposed and propagated, but validators and schema selection still key off the global `ADCP_VERSION` constant. Stage 3 wires per-instance schema loading off this getter so cross-version testing (a 3.0 client speaking to a 3.1 server in the same process) works without npm aliases.

  `AdcpServerConfig.adcpVersion` is independent of `AdcpServerConfig.version`; the latter is the publisher's app version, the former is the AdCP protocol version on the wire.

- 88e3b02: feat: rename `@adcp/client` to `@adcp/sdk` + add `/client` and `/compliance` subpath umbrellas

  The library is now published as `@adcp/sdk` to reflect the three surfaces it ships — buyer-side client, server builder, and compliance harness. `@adcp/client` continues to publish from `packages/client-shim/` as a thin re-export of `@adcp/sdk` (including a CLI delegator so `npx @adcp/client@latest …` keeps working), so existing installs keep functioning without code changes. Replace `@adcp/client` with `@adcp/sdk` in your imports when convenient — APIs are identical.

  New subpath exports group the surfaces so `@adcp/sdk/client`, `@adcp/sdk/server`, and `@adcp/sdk/compliance` resolve to the right slice for each use case. The root export (`@adcp/sdk`) continues to re-export the client surface verbatim, so `import { AdcpClient } from '@adcp/sdk'` and `import { AdcpClient } from '@adcp/sdk/client'` are equivalent. The new `@adcp/sdk/compliance` umbrella re-exports `testing` + `conformance` + `compliance-fixtures` + `signing/testing` for compliance harnesses that want one import path; the individual subpaths still resolve directly so callers who only need fuzzing don't pay the bundle cost of test agents.

  Repo restructure: top-level `package.json` now declares an npm workspace covering `.` plus `packages/*`. The two packages stay version-linked via `.changeset/config.json` so they always release at the same number; the shim's `dependencies."@adcp/sdk"` covers the published range (`^5.22.0`) so npm dedupes consumers' trees that pull both names. (We tried `peerDependencies` first; changesets treats every minor bump on a peer as a major bump for the dependent, which would force `@adcp/client` to 6.0.0 every time `@adcp/sdk` released a feature.)

  Post-release maintainer task: run `npm deprecate '@adcp/client@5.23.0' 'Renamed to @adcp/sdk. Replace @adcp/client with @adcp/sdk in your imports — APIs are identical. https://www.npmjs.com/package/@adcp/sdk'` so the rename pointer surfaces at install time. Auto-deprecation in the release workflow is on the follow-up list — OIDC trusted-publishing tokens are package-scoped, so the token issued for `@adcp/sdk`'s publish can't deprecate `@adcp/client`. Lands back in `release.yml` once a maintainer-scoped `NPM_TOKEN` secret with deprecate rights on `@adcp/client` is provisioned.

### Patch Changes

- Updated dependencies [88e3b02]
- Updated dependencies [88e3b02]
  - @adcp/sdk@5.23.0

## 6.0.0

### Minor Changes

- 9de471e: feat: add `adcpVersion` constructor option on client + server surfaces

  `SingleAgentClient`, `AgentClient`, `ADCPMultiAgentClient`, and `createAdcpServer` now accept an `adcpVersion?: string` option that surfaces via a new `getAdcpVersion()` instance method. Defaults to the SDK's pinned `ADCP_VERSION` (currently `'3.0.0'`) when omitted. Pin to an older stable (`'3.0.0'`) or opt into a beta channel (`'3.1.0-beta.1'`) once the corresponding registry ships.

  Plumbing surface only — Stage 2 of the multi-version refactor. The configured value is exposed and propagated, but validators and schema selection still key off the global `ADCP_VERSION` constant. Stage 3 wires per-instance schema loading off this getter so cross-version testing (a 3.0 client speaking to a 3.1 server in the same process) works without npm aliases.

  `AdcpServerConfig.adcpVersion` is independent of `AdcpServerConfig.version`; the latter is the publisher's app version, the former is the AdCP protocol version on the wire.

- 9de471e: feat: rename `@adcp/client` to `@adcp/sdk` + add `/client` and `/compliance` subpath umbrellas

  The library is now published as `@adcp/sdk` to reflect the three surfaces it ships — buyer-side client, server builder, and compliance harness. `@adcp/client` continues to publish from `packages/client-shim/` as a thin re-export of `@adcp/sdk` (including a CLI delegator so `npx @adcp/client@latest …` keeps working), so existing installs keep functioning without code changes. Replace `@adcp/client` with `@adcp/sdk` in your imports when convenient — APIs are identical.

  New subpath exports group the surfaces so `@adcp/sdk/client`, `@adcp/sdk/server`, and `@adcp/sdk/compliance` resolve to the right slice for each use case. The root export (`@adcp/sdk`) continues to re-export the client surface verbatim, so `import { AdcpClient } from '@adcp/sdk'` and `import { AdcpClient } from '@adcp/sdk/client'` are equivalent. The new `@adcp/sdk/compliance` umbrella re-exports `testing` + `conformance` + `compliance-fixtures` + `signing/testing` for compliance harnesses that want one import path; the individual subpaths still resolve directly so callers who only need fuzzing don't pay the bundle cost of test agents.

  Repo restructure: top-level `package.json` now declares an npm workspace covering `.` plus `packages/*`. The two packages stay version-linked via `.changeset/config.json` so they always release at the same number; the shim's `dependencies."@adcp/sdk"` bumps automatically with each release.

### Patch Changes

- 5fb6729: fix(testing): signals governance advisory block now fires correctly

  The governance advisory check in `testSignalsFlow` was silently a no-op: it
  re-parsed `signalsStep.response_preview` (a pre-formatted summary string) looking
  for `.signals`/`.all_signals` keys that never exist in that format, so
  `withRestrictedAttrs` and `withPolicyCategories` were always empty arrays.

  `discoverSignals` now returns the raw `GetSignalsResponse.signals` array alongside
  the digested `AgentProfile.supported_signals` array. The advisory block uses the
  raw array directly and also evaluates signals discovered via the fallback-brief
  loop, so agents whose first `get_signals` call returns empty are still graded.
  The advisory hint now points operators at the spec-correct surface for declaring
  `restricted_attributes`/`policy_categories` (the `signal_catalog` in
  `adagents.json`).

- Updated dependencies [14623ee]
- Updated dependencies [9de471e]
- Updated dependencies [71df387]
- Updated dependencies [36d3c81]
- Updated dependencies [9de471e]
  - @adcp/sdk@6.0.0
