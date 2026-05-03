# Changelog

## 6.9.0

### Minor Changes

- ee63e0d: feat(server): `ConformanceClient` — outbound-WebSocket Socket Mode primitive that lets adopter dev/staging MCP servers connect to a remote AdCP runner (today, Addie at agenticadvertising.org) without public DNS or inbound exposure. Three-line integration: `new ConformanceClient({ url, token, server }).start()`. Reverse-RPC at the TCP level only — MCP semantics unchanged. Dev/staging only by design (per AdCP #3986 deployment-scoped controller rule). Exposed from `@adcp/sdk/server`.

### Patch Changes

- e680866: Add audio creative-template support to the mock-server and hello adapter (Path 3 from the PR #1496 follow-up).

  The fork-matrix collapse claimed audio creative-template patterns but didn't ship runnable code for them. This patch fills that gap end-to-end without forking a separate adapter:
  - `src/lib/mock-server/creative-template/seed-data.ts` — extended `output_kind` union with `'audio_url'`; seeded `tpl_audiostack_spot_30s_v1` modeling the TTS / mix / master pipeline (text script → optional voice + music_bed → 30s mastered MP3). No dimensions; the existing `queued → running → complete` state machine already simulates the multi-minute render time real audio platforms (AudioStack, ElevenLabs, Resemble) take.
  - `src/lib/mock-server/creative-template/server.ts` — added an `audio_url` branch to `synthesizeOutput` that returns `{ audio_url: '<previewBase>.mp3', preview_url, assets: [{ kind: 'audio_url', mime_type: 'audio/mpeg' }] }`.
  - `examples/hello_creative_adapter_template.ts` — extended `UpstreamTemplate.output_kind` and `UpstreamRender.output` to include the audio shape; added `else if (out.audio_url)` branch in `projectRenderToManifest` that wraps the URL with `audioAsset({ url })` (the framework injects the `asset_type: 'audio'` discriminator into the creative-manifest oneOf).
  - `skills/build-creative-agent/SKILL.md` — replaced the "audio templates" paragraph with a worked-reference one citing the seeded audio template plus the `audioAsset()` projection. Notes that storyboard coverage for audio is not yet upstream (filed as adcontextprotocol/adcp#4015).

  Adopters integrating an audio creative platform now have a runnable round-trip path from `npx adcp mock-server creative-template` through the adapter to a complete creative-manifest with an audio asset. Validated via:

  ```ts
  const handle = await bootMockServer({ specialism: 'creative-template', port: 0 });
  const r = await fetch(handle.url + '/v3/workspaces/ws_acme_studio/renders', {
    method: 'POST',
    body: JSON.stringify({
      template_id: 'tpl_audiostack_spot_30s_v1',
      mode: 'build',
      inputs: [{ slot_id: 'script', value: '...' }],
      client_request_id: '1',
    }),
  });
  // queued → running → complete with { audio_url, preview_url, assets: [{ kind: 'audio_url' }] }
  ```

  Storyboard-grader coverage for audio is tracked at adcontextprotocol/adcp#4015 — the existing `creative_template` storyboard's `build_creative` step is hardcoded to display assets (image + headline + click_url), so audio adopters can't pass it today. Until that ships, audio adopters validate via `npm run compliance:fork-matrix -- --test-name-pattern="hello-creative-adapter-template"` (display + video gate inherited) plus the manual round-trip above.

  Pure additive — no breaking changes. Existing display + video templates unchanged; fork-matrix 23/23 still green.

- 4f822e8: fix(testing/storyboard): symmetric account resolution on `update_media_buy` enricher (closes #1505)

  The storyboard runner's `update_media_buy` enricher was not in
  `FIXTURE_AWARE_ENRICHERS`, so the generic `{ ...enriched, ...fixture }`
  merge let storyboard `sample_request.account` override the harness-
  resolved account. When create_media_buy used a runner-synthesized
  sandbox account (e.g. `{ brand: 'test.example', operator: 'test.example', sandbox: true }`)
  and the storyboard's update step authored `account: { brand: 'real.example', operator: '...' }`,
  the update wrote to the prod partition while create wrote to the
  sandbox partition. A subsequent `get_media_buys` reading from the
  sandbox partition (via `context.account`) saw stale create-time
  targeting_overlay — exactly the failure surfaced by the
  `media_buy_seller/inventory_list_targeting/get_after_update` cascade
  step.

  This change adds `update_media_buy` to `FIXTURE_AWARE_ENRICHERS` and
  rewrites the enricher to spread fixture fields first then force-override
  `account` to `context.account ?? resolveAccount(options)` — symmetric
  with the `get_media_buys` / `get_media_buy_delivery` fix in #1487.

  Legacy storyboards without a `sample_request` still fall back to the
  keyword-based pause / resume / cancel inference; only the fixture-
  authored path changes.

- 91c1ff8: Pivot from skill-matrix to fork-matrix; collapse `build-*-agent/SKILL.md` files.

  The skill-matrix harness (`scripts/manual-testing/run-skill-matrix.ts` + `agent-skill-storyboard.ts` + `skill-matrix.json`) graded "can a fresh Claude session build an AdCP server from prose in SKILL.md." That's not the workflow real adopters use now that every production specialism has a worked, CI-tested fork target in `examples/hello_*_adapter_*.ts`.

  The fork-matrix is the canonical compliance gate going forward. Each `test/examples/hello-*.test.js` boots the matching reference adapter against a mock-server upstream, runs the storyboard grader, and verifies upstream traffic — the three-gate contract from `docs/guides/EXAMPLE-TEST-CONTRACT.md`. Empirical comparison: skill-matrix v18 ran 1/8 in ~50min with 6 timeouts; fork-matrix runs 23/23 in ~10s.

  **Changes:**
  - New: `npm run compliance:fork-matrix` — runs every `test/examples/hello-*.test.js` gate.
  - New: `skills/cross-cutting.md` — shared rules every `build-*` skill points at (idempotency, resolve-then-authorize, auth, signed-requests, ctx_metadata safety, account-resolution presets, webhook operation_id stability).
  - Collapsed all 8 `build-*-agent/SKILL.md` to fork-target pointers + cross-cutting reference. Net: 6,916 lines deleted across `seller` (1835→83), `creative` (798→80), `signals` (578→70), `governance` (1006→84), `brand-rights` (640→83), `generative-seller` (621→78), `retail-media` (515→78), `si` (410→86); `holdco` light-touched.
  - Removed: `npm run compliance:skill-matrix`, `npm run compliance:agent-skill`, plus `scripts/manual-testing/run-skill-matrix.ts`, `agent-skill-storyboard.ts`, `skill-matrix.json`.
  - Updated: `docs/guides/VALIDATE-YOUR-AGENT.md` and `CLAUDE.md` reference fork-matrix.

  **Adopter impact:** If you were running `npm run compliance:skill-matrix`, switch to `npm run compliance:fork-matrix`. The fork-matrix is faster, deterministic, and tests the same compliance question against the workflow adopters actually use (fork → swap upstream → ship).

  **Additive type exports:** `RightUse` and `RightType` are now re-exported from `@adcp/sdk/types` (previously available only via `@adcp/sdk/types/core.generated`, which was not in the package exports map). Pure additive — existing imports keep working.

  **Multi-tenant adapter fixes:** `examples/hello_seller_adapter_multi_tenant.ts` had pre-existing strict-tsc drift — fixed the import path, two `exactOptionalPropertyTypes` mismatches, and added stub `updateRights` / `reviewCreativeApproval` methods to satisfy the `BrandRightsPlatform` interface that grew in #1349. Adapter now passes the strict-tsc gate (`npm run compliance:fork-matrix` 23/23). Governance and brand-rights skills repointed at it as the canonical fork target.

  Tracked at adcp-client#595 (closed by this change). The original "full vs reference-linked vs rules-only" experiment was the right question for the world where Claude built from scratch; in a fork-target world it's measuring noise.

- 0c8008f: fix(conformance): get_media_buys and get_media_buy_delivery enrichers now resolve account via resolveAccount(options)

  Adds both enrichers to FIXTURE_AWARE_ENRICHERS and uses `context.account ?? resolveAccount(options)` for account resolution, matching the pattern already used by create_media_buy. Previously, the generic fixture-authoritative merge let the fixture's raw account block (which may lack sandbox:true) override the harness-resolved account, causing namespace mismatches on the create→get round-trip and resulting in targeting_overlay store misses.

  Fixture fields other than account are preserved via an explicit spread, so storyboards that author filters, status, or pagination fields continue to work.

  Fixes #1487.

## 6.8.0

### Minor Changes

- 0dd3ca7: Add `Account.mode` convention + sandbox-authority helpers from `@adcp/sdk/server`.

  Phase 1 of the three-account-mode rollout (see `docs/proposals/lifecycle-state-and-sandbox-authority.md`). Establishes the type and the gate primitive; auto-wiring into the comply controller dispatch lands alongside mock-mode routing in Phase 2 (#1435).

  New surface:
  - `AccountMode` type — `'live' | 'sandbox' | 'mock'`. Resolved-account convention; default `'live'` when unspecified (fail-closed).
  - `getAccountMode(account)` — reads `mode` off any account-shaped value, with back-compat for legacy `sandbox: boolean`.
  - `isSandboxOrMockAccount(account)` — predicate: is the account non-production?
  - `assertSandboxAccount(account, opts?)` — throws `AdcpError('PERMISSION_DENIED')` (with `details: { scope: 'sandbox-gate' }`) for live-mode or missing accounts. Use to gate test-only surfaces.

  Pure additive: existing `account.sandbox === true` adopters keep working — the helpers infer `mode: 'sandbox'` from the legacy flag automatically. No behavior change for shipped code.

  Adopters who want stronger gating today can wire `assertSandboxAccount(ctx.account, { tool: 'comply_test_controller' })` inside their `sandboxGate(input)` (after resolving the account). Phase 2 ships SDK-side auto-wiring so this becomes invisible.

- d359c70: feat(server): `createAdcpServer.instructions` accepts an async function (#1393)

  The function form of `instructions` now supports returning a `Promise<string | undefined>`. The framework awaits the result during the MCP `initialize` handshake — the session does not proceed until the promise settles. This enables per-session prose fetched from an async source (brand-manifest registries, KV stores, real-time policy docs) without blocking server construction.

  ```ts
  createAdcpServer({
    // Async function — resolved at MCP initialize time, not at factory construction.
    instructions: async ctx => {
      const manifest = await brandManifests.get(ctx.tenant);
      return manifest?.intro ?? defaultProse;
    },
    onInstructionsError: 'skip', // or 'fail' for load-bearing policy
  });
  ```

  `onInstructionsError: 'skip' | 'fail'` governs async rejections identically to sync throws. Existing string-form and sync-function-form adopters are unaffected.

  New export: `MaybePromise<T>` type alias (`T | Promise<T>`) for use in async-optional callback signatures.

- 54d2537: BuyerAgentRegistry: surface authenticator-stamped `extra` to `resolveByCredential` (issue #1484)

  `BuyerAgentRegistry.bearerOnly` and `.mixed` now forward `authInfo.extra` as a second
  optional argument to `resolveByCredential`. Adopters using prefix-based bearer conventions
  (e.g. demo tokens, tenant-encoded keys) can stamp extension data in their `verifyApiKey.verify`
  callback and recover it in the resolver without a pre-registered hash lookup.

  `attachAuthInfo` in `serve.ts` is also updated to propagate `principal.extra` from the
  `AuthPrincipal` returned by `authenticate()` into `info.extra`, closing the forwarding gap
  at the authenticator boundary.

  `ResolveBuyerAgentByCredential` gains an optional second parameter
  `extra?: Record<string, unknown>`. Existing single-argument implementations continue to
  satisfy the widened type without changes.

- a6c71fb: Extend `ComplyControllerConfig.force` with `create_media_buy_arm` and `task_completion` slots, closing the gap between the low-level dispatcher and the structured-config façade.

  **What was missing.** `ComplyControllerConfig.force` (the typed config surface for `createComplyController` and `createAdcpServerFromPlatform({ complyTest })`) previously only exposed four slots — `creative_status`, `account_status`, `media_buy_status`, `session_status`. The dispatcher in `test-controller.ts` already handled `force_create_media_buy_arm` and `force_task_completion` (they are in `CONTROLLER_SCENARIOS`, `SCENARIO_MAP`, and the `switch` dispatch), but `buildStore` and `advertisedScenarios` had no bridge from the typed config to those store methods. Adopters on the structured config who implemented the underlying logic still hit `UNKNOWN_SCENARIO` every time.

  **What's new.**
  - `ForceCreateMediaBuyArmParams` — `{ arm: 'submitted' | 'input-required'; task_id?: string; message?: string }`
  - `ForceTaskCompletionParams` — `{ task_id: string; result: Record<string, unknown> }`
  - `DirectiveAdapter<P>` — adapter type returning `ForcedDirectiveSuccess` (distinct from `ForceAdapter<P>` which returns `StateTransitionSuccess`; `create_media_buy_arm` registers a pre-call directive, not a state transition)
  - `ComplyControllerConfig.force.create_media_buy_arm?: DirectiveAdapter<ForceCreateMediaBuyArmParams>`
  - `ComplyControllerConfig.force.task_completion?: ForceAdapter<ForceTaskCompletionParams>`
  - `buildStore` wires both adapters to `store.forceCreateMediaBuyArm` / `store.forceTaskCompletion`
  - `advertisedScenarios` pushes `FORCE_CREATE_MEDIA_BUY_ARM` / `FORCE_TASK_COMPLETION` when the corresponding adapter is present
  - `testing/test-controller.ts` client-side `ControllerScenario` union extended with `'force_create_media_buy_arm'` and `'force_task_completion'`

  All changes are additive (new optional slots, new exported types). No existing API is modified.

  Fixes #1472. Unblocks the `media_buy_seller/create_media_buy_async` storyboard and any other storyboard that drives `force_create_media_buy_arm` or `force_task_completion` through `createComplyController`.

- 5fd83f1: Auto-wire the framework-side sandbox-authority gate inside `createAdcpServerFromPlatform`. Phase 2 of #1435.

  The framework now bypasses `controller.register(server)` for `comply_test_controller` and registers the tool itself, threading `extra.authInfo` through `platform.accounts.resolve` BEFORE dispatching. Under no circumstances does the controller operate on a `live`-mode account, regardless of what the caller claims on the wire — the resolved account is the trust boundary, not buyer-supplied flags like `account.sandbox === true`.

  What the gate does, in order:
  1. **`list_scenarios` is exempt** — capability probe, no state mutation.
  2. **Resolve the account** through `platform.accounts.resolve(ref, { authInfo, toolName })`. Reads the ref from top-level `account` (extended shape) or `context.account` (canonical AdCP routing).
  3. **Admit when** the resolved account's `mode` is `'sandbox'` or `'mock'` (legacy `sandbox: true` honored).
  4. **Admit when** no account resolves AND `context.sandbox === true` (migration window).
  5. **Admit when** `process.env.ADCP_SANDBOX === '1'` (deprecated env-fallback for back-compat).
  6. **Otherwise refuse** with a `FORBIDDEN` controller envelope.

  **Fail-closed guard on the env fallback.** `ADCP_SANDBOX=1` was never meant to coexist with a resolver that names live accounts. The framework tracks every explicit `mode` value returned from `platform.accounts.resolve` in this process; if `ADCP_SANDBOX=1` is set AND any live-mode account has been resolved, the gate THROWS loudly so operators notice in their logs. Remove `ADCP_SANDBOX` from your prod env and gate via `mode: 'sandbox'` on resolved accounts instead.

  **Back-compat.** Existing test platforms relying on `process.env.ADCP_SANDBOX === '1'` continue to work without modification — the env-fallback admits when the resolver doesn't stamp an explicit mode. Implicit-default-to-live (legacy adopter shape) does NOT trip the fail-closed guard; only deliberate `mode: 'live'` from the resolver does.

  **Migration path.** Stop setting `ADCP_SANDBOX` in production. Stamp `mode: 'sandbox'` (or `'live'`) on accounts your `accounts.resolve` returns; the gate then enforces strictly without the env fallback. The fallback emits no warning yet — a future minor will warn on each gate-permission grant; a future major will remove it entirely.

  Non-MCP transports (rare) keep the v5 behavior: when `getSdkServer(server)` returns null, the controller's own `register(server)` runs and the gate is a no-op for that surface. The gate is an MCP-side concern; A2A and other transports are wired separately.

- d7c5767: feat(server): variadic `composeMethod(inner, ...hooks)` overload for stacking multiple guards without nesting

  Adds a variadic form of `composeMethod` so adopters can write `composeMethod(inner, hookA, hookB, hookC)` instead of `composeMethod(composeMethod(composeMethod(inner, hookC), hookB), hookA)`. Semantics are identical to right-to-left manual nesting: `before` hooks run left-to-right, `after` hooks run right-to-left. The two-argument form is unchanged.

  Also adds a "When to use which approach" decision matrix to `docs/recipes/composeMethod-testing.md` covering preset-vs-inline tradeoffs, the `requireOrgScope` undefined-org gotcha, and `onDeny` evaluation-order implications.

  Closes #1444.

- de0becf: Add `creative-ad-server` upstream-shape mock-server. Closes #1459 (sub-issue of #1381 hello-adapter-family completion).

  Pattern: GAM-creative / Innovid / Flashtalking / CM360 model — stateful creative library, format auto-detection, tag generation with macro substitution, real `/serve/{id}` HTML preview, synth delivery reporting with format-specific CTR baselines.

  Routes:
  - `GET /_lookup/network` — operator-from-domain routing (auth-free).
  - `GET /_debug/traffic` — façade-detection counters (auth-free).
  - `GET /v1/formats` — per-network format catalog.
  - `POST /v1/creatives` — write to library; format auto-detected from `upload_mime` + dimensions when `format_id` omitted; `client_request_id` idempotency with conflict-on-body-mismatch.
  - `GET /v1/creatives` — list with filters (`advertiser_id`, `format_id`, `status`, `created_after`, `creative_ids`); cursor pagination.
  - `GET /v1/creatives/{id}` — single fetch.
  - `PATCH /v1/creatives/{id}` — update snippet/status/click_url/name.
  - `POST /v1/creatives/{id}/render` — tag generation; substitutes `{click_url}`, `{impression_pixel}`, `{cb}`, `{advertiser_id}`, `{creative_id}`, `{asset_url}`, `{width}`, `{height}`, `{duration_seconds}` macros into the stored or format-template snippet; returns `tag_html` + `tag_url`.
  - `GET /serve/{id}?ctx=<json>` — real iframe-embeddable HTML response (no bearer auth — capability-by-id, mirrors how real ad servers expose serve URLs to publisher iframes).
  - `GET /v1/creatives/{id}/delivery?start=&end=` — synth impressions/clicks scaled by days-active; deterministic-seeded `(creative_id, date)`; CTR baselines per channel (display ~0.10%, video ~1.5%, ctv ~3%, audio ~0.5%).

  Auth: static Bearer + `X-Network-Code` header on every `/v1` route. Multi-tenancy by network header (mirrors `sales-guaranteed`). Three networks seeded (US, ACME outdoor, Pinnacle agency) with replicated 6-format catalog and 3 seed library entries.

  Wired into `src/lib/mock-server/index.ts` dispatcher with `formatCreativeAdServerSummary` for boot-log printing. Worked adapter (sub-issue #1460) lands in a follow-up PR.

- 6c47db5: Framework-side refusal of inline `account_id` for `resolution: 'derived'`
  agents (closes adcp-client#1468). Mirrors the long-standing `'implicit'`
  enforcement (#1364): the framework now throws
  `AdcpError('INVALID_REQUEST', { field: 'account.account_id' })` _before_
  reaching `accounts.resolve` whenever a `'derived'`-mode platform receives
  a buyer-supplied `account_id` on the wire.

  Single-tenant agents (audiostack, flashtalking, single-namespace
  retail-media) declare `account_id` is meaningless on the wire; previously
  the framework silently dropped buyer-supplied ids and the resolver
  returned the singleton anyway, leaving cargo-culted requests undetectable.
  The refusal makes the wire-contract violation surface cleanly to the
  buyer with a single-tenant message (no `sync_accounts`-first guidance,
  since that step does not exist in derived mode).

  Hand-rolled `'derived'` stores get the enforcement automatically — not
  just users of `createDerivedAccountStore`. The brand+operator union arm
  is still permitted.

  Implementation: `refuseImplicitAccountId` (closed #1364) renamed to
  `refuseInlineAccountIdWhenForbidden` and extended to fire on both
  `'implicit'` and `'derived'` resolution modes with mode-specific error
  messaging.

- 0ee3ef2: Add `createDerivedAccountStore` — Shape D `AccountStore` factory for
  single-tenant `resolution: 'derived'` agents (no `account_id` on the
  wire; auth principal alone identifies the tenant). Replaces the ~25–30
  LOC of bearer-extract + throw-`AUTH_REQUIRED` + return-singleton
  boilerplate that audiostack, flashtalking, single-namespace
  retail-media adapters re-derive by hand, and standardizes the correct
  `'derived'` declaration (many such adapters today claim `'explicit'`
  even though they ignore the wire field).

  Closes adcp-client#1462. Completes the four-shape factory family
  alongside `InMemoryImplicitAccountStore` (A), `createOAuthPassthroughResolver`
  (B), and `createRosterAccountStore` (C). Exported from `@adcp/sdk`,
  `@adcp/sdk/server`, and `@adcp/sdk/adapters`.

- cb638f8: feat(cli+harness): `adcp mock-server sponsored-intelligence` — fifth specialism (brand-agent platform shape)

  Adds the SI mock-server. Brand-agent-platform-shaped upstream (Salesforce
  Agentforce / OpenAI Assistants / custom-brand-chat family) that hosts
  conversational brand offerings and exposes them via a stateful HTTP API.
  Adapter wraps it to project AdCP `si_get_offering`, `si_initiate_session`,
  `si_send_message`, `si_terminate_session`.

  This is the first matrix-v2 fixture for SI. Lets adopters dogfood SI ahead
  of `adcontextprotocol.org` standing up a reference SI tenant — and lets
  the SDK exercise the four SI tools end-to-end against a deterministic
  fixture.

  **Why a mock now (and not a v6 platform shape):** SI is currently a
  _protocol_ in AdCP 3.0 (`supported_protocols: ['sponsored_intelligence']`)
  but not a _specialism_ — `sponsored-intelligence` is absent from
  `AdCPSpecialism`. That blocks a v6 `SponsoredIntelligencePlatform`
  interface with parity to the other specialism platforms; adopters wire SI
  through the v5 `createAdcpServer` handler bag
  (`SponsoredIntelligenceHandlers`). The mock server is independent of that
  decision — it represents the upstream brand platform an adapter wraps,
  regardless of which SDK shape the AdCP-side handler uses. Filed as
  adcontextprotocol/adcp#3961.

  **Routes** (path-scoped multi-tenancy, parallel to creative-template):
  - `GET /_lookup/brand?adcp_brand=<value>` — discovery (no auth)
  - `GET /_debug/traffic` — façade-detection traffic counters
  - `GET /v1/brands/{brand}/offerings/{offering_id}` — `si_get_offering`
  - `POST /v1/brands/{brand}/conversations` — `si_initiate_session`
  - `GET /v1/brands/{brand}/conversations/{conv_id}` — read state
  - `POST /v1/brands/{brand}/conversations/{conv_id}/turns` — `si_send_message`
  - `POST /v1/brands/{brand}/conversations/{conv_id}/close` — `si_terminate_session`

  Conversation lifecycle: `active` → `closed` (terminal). Re-closing
  returns the same payload — naturally idempotent on `conversation_id`,
  mirroring AdCP's decision to omit `idempotency_key` on
  `si_terminate_session`. POST `/conversations` and POST `/turns` each
  accept `client_request_id` (the upstream-side translation of AdCP
  `idempotency_key`) for at-most-once execution; mismatched body with
  reused key → `409 idempotency_conflict`.

  **Brand-agent canned responses** (deterministic, keyword-routed):
  - `buy` / `purchase` / `checkout` / `order` → response with
    `close_recommended: { type: 'transaction', payload }` — adapter
    surfaces as AdCP `session_status: 'pending_handoff'` + populated
    `handoff` block.
  - `thanks` / `bye` / `done` → `close_recommended: { type: 'complete' }`
  - `second` / `next` / `other one` → swap product card to next product
  - otherwise → product card from the configured offering

  When `close` is called with `reason=transaction`, the response includes
  a `transaction_handoff` block with `checkout_url`, `checkout_token`, and
  `expires_at` — adapter projects to AdCP `acp_handoff` on
  `SITerminateSessionResponse`.

  **Two seeded brands** (multi-tenancy assertion): `brand_acme_outdoor`
  (running shoes, single offering with two products) and
  `brand_summit_books` (independent bookstore, single offering with one
  product). Cross-brand offering access returns
  `404 offering_not_in_brand`.

  **Upstream/AdCP rename pattern** is intentional throughout (exercises
  the adapter's projection):

  | upstream field                      | AdCP field                                                          |
  | ----------------------------------- | ------------------------------------------------------------------- |
  | `conversation_id`                   | `session_id`                                                        |
  | `assistant_message`                 | `response.message`                                                  |
  | `components[].kind`                 | `ui_elements[].type`                                                |
  | `client_request_id`                 | `idempotency_key`                                                   |
  | `offering_query_id`                 | `offering_token`                                                    |
  | `transaction_handoff`               | `acp_handoff`                                                       |
  | `close_recommended.type: txn_ready` | `session_status: 'pending_handoff'` + `handoff.type: 'transaction'` |
  | `close_recommended.type: done`      | `session_status: 'pending_handoff'` + `handoff.type: 'complete'`    |
  | `close.reason: txn_ready`           | `SITerminateSessionRequest.reason: 'handoff_transaction'`           |
  | `close.reason: done`                | `'handoff_complete'`                                                |
  | `close.reason: user_left`           | `'user_exit'`                                                       |
  | `close.reason: idle_timeout`        | `'session_timeout'`                                                 |
  | `close.reason: host_closed`         | `'host_terminated'`                                                 |
  | `sku`                               | `product_id`                                                        |
  | `hero_image_url`, `thumbnail_url`   | `image_url`                                                         |
  | `landing_page_url`                  | `landing_url`                                                       |
  | `pdp_url`                           | `url`                                                               |
  | `inventory_status`                  | `availability_summary`                                              |

  The close-reason vocabulary is deliberately distinct from AdCP's enum
  (rather than identity-mapping `complete` to `complete`) so the adapter's
  translation is loud — sending an AdCP reason value to the upstream close
  endpoint returns `400 invalid_close_reason`, forcing the adapter to
  implement the projection rather than accidentally pass-through.

  **Offering token correlation** (`offering_query_id`): the brand mints a
  token on every `GET /offerings/{id}` and stores the products-shown
  record keyed on it. A subsequent `POST /conversations` with the same
  token resolves "the second one" against what the user actually saw,
  not the full catalog. Mirrors the AdCP `SIGetOfferingResponse.offering_token`
  → `SIInitiateSessionRequest.offering_token` correlation primitive.

  Run with:

  ```bash
  npx @adcp/sdk mock-server sponsored-intelligence --port 4500
  ```

  **23 smoke tests** in
  `test/lib/mock-server/sponsored-intelligence.test.js` cover: auth
  gating, brand lookup, cross-brand offering and conversation isolation,
  conversation start with idempotent replay and idempotency-conflict
  rejection (POST /conversations and POST /turns symmetric), turn keyword
  routing (txn_ready/done close hints), close with txn_ready returning a
  transaction_handoff, AdCP-vocabulary reason rejection (400
  `invalid_close_reason`), idempotent re-close, post-close turn
  rejection, GET-after-close, offering_query_id round-trip from GET
  /offerings into POST /conversations, unknown-token rejection, cross-brand
  token rejection, and traffic counter recording.

  **Deferred to follow-up branches** (acknowledged limitations of this v1
  fixture): A2UI surface support (`SISendMessageResponse.response.surface`),
  streaming turns (real Agentforce / Assistants emit SSE), consent-version
  gate (a brand with `requires_identity: true`), anonymous_session_id
  assertion, multi-brand catalog overlap (one customer fronting many
  brands with shared products), ACP handoff failure mode, eager
  `pending_handoff` mid-turn path (mock currently surfaces close hints
  lazily — adapter chooses whether to project as eager handoff).

  Refs adcontextprotocol/adcp#3961.

- 864eb15: feat(examples): hello_si_adapter_brand — worked SI adapter driving the SI mock through the v6 platform

  Adds the SI reference adapter that wraps the upstream brand-agent
  mock platform (`mock-server sponsored-intelligence`, #1441) and
  exposes AdCP's four SI tools through the v6
  `SponsoredIntelligencePlatform` shape (#1454).

  Demonstrates the full upstream/AdCP rename gap an integrator faces
  when wrapping a Salesforce Agentforce / OpenAI Assistants / custom
  brand-chat platform: `conversation_id` ↔ `session_id`,
  `assistant_message` ↔ `response.message`, `components.kind` ↔
  `ui_elements.type`, `offering_query_id` ↔ `offering_token`,
  `transaction_handoff` ↔ `acp_handoff`, `sku` ↔ `product_id`,
  `hero_image_url` ↔ `image_url`, `pdp_url` ↔ `url`, and the loud
  close-reason rename (`txn_ready` ↔ `handoff_transaction`, `done` ↔
  `handoff_complete`, `user_left` ↔ `user_exit`, `idle_timeout` ↔
  `session_timeout`, `host_closed` ↔ `host_terminated`).

  Per-component-type projection — AdCP `SIUIElement.product_card`
  requires `data.title` + `data.price`; upstream emits `name` +
  `display_price`. The example projects per-type so wire validation
  passes. The same gotcha applies to `action_button` (needs
  `label` + `action`).

  Eager close-hint projection: upstream `close_recommended.type:
'txn_ready'` becomes AdCP `session_status: 'pending_handoff'` +
  `handoff: { type: 'transaction', intent: { action: 'purchase', product, price } }`
  on the `si_send_message` response. The host then formally closes
  via `si_terminate_session` to receive the ACP `acp_handoff`
  payload.

  **New SDK surface this example uses:**
  - `defineSponsoredIntelligencePlatform<TCtxMeta>` — type-level
    identity helper, parallel to `defineSignalsPlatform` /
    `defineCreativeBuilderPlatform`. Exported from
    `@adcp/sdk/server`.

  **Bug fix in `RequiredPlatformsFor<S>`** that this example surfaced:
  the fall-through used `Record<string, never>` (rejects any platform
  with handler fields). Distributive conditional over an empty union
  also collapsed to `never`. Both branches now resolve to `{}` (the
  empty-requirements identity, sister-to `RequiredCapabilitiesFor`'s
  fall-through). Adopters with empty `specialisms: []` (legitimate
  when the agent's only declared surface is a _protocol_, like SI
  pre-3.1) now get a working type. Documented inline at the
  fall-through with reasoning.

  **Tests** — `test/examples/hello-si-adapter-brand.test.js`. SI is
  preview-only (no compliance storyboard yet), so the test rolls its
  own runtime gates rather than using the shared three-gate helper:
  1. **Strict tsc** — `--strict --noUncheckedIndexedAccess
--exactOptionalPropertyTypes
--noPropertyAccessFromIndexSignature`. Parallel to peer
     adapter tests.
  2. **End-to-end MCP smoke** — boots mock + adapter, drives all
     four SI tools through the MCP wire (`StreamableHTTPClientTransport`
     - `Client.callTool`), verifies upstream→AdCP renames project
       correctly (offering_query_id round-trip, conversation_id →
       session_id, transaction_handoff → acp_handoff, txn_ready →
       pending_handoff projection on send_message).
  3. **Façade gate** — every expected upstream route shows ≥1 hit
     at `/_debug/traffic`. (`/_lookup/brand` excluded — SI tool
     schemas don't carry `account` on the wire, so
     `accounts.resolve(undefined)` falls back to
     `DEFAULT_LISTING_BRAND` without exercising lookup. That route
     fires only on production paths binding `account.brand.domain`
     from `ctx.authInfo`.)

  6 tests, all passing.

  Run the demo:

  ```bash
  npx @adcp/sdk@latest mock-server sponsored-intelligence --port 4504
  UPSTREAM_URL=http://127.0.0.1:4504 \
    npx tsx examples/hello_si_adapter_brand.ts
  curl http://127.0.0.1:4504/_debug/traffic
  ```

  Refs adcontextprotocol/adcp#3961, #1441, #1454.

- 0dfbf3c: feat(mock-server+examples): SI storyboard passes — Nova Motors fixture + standard three-gate runner

  Wires `examples/hello_si_adapter_brand.ts` (#1464) into the canonical
  `adcp storyboard run si_baseline` compliance harness. The
  `si_baseline` storyboard at
  `compliance/cache/latest/protocols/sponsored-intelligence/index.yaml`
  now reports **3/3 scenarios pass** end-to-end against the SI mock
  server (#1441) wrapped by the v6 SI platform adapter (#1454).

  **Three changes:**
  1. **Nova Motors fixture in the SI mock** (`brand_nova_motors`,
     `novamotors.example`, offering `novamotors_conversational_v1`).
     Matches the canonical compliance test-kit at
     `compliance/cache/latest/test-kits/nova-motors.yaml`. The SI mock
     now seeds three brands (Acme Outdoor, Summit Books, Nova Motors)
     so it's the canonical fixture for SI compliance runs without
     requiring a separate test-only mock.
  2. **Adapter default switched to Nova Motors.** SI tool requests
     don't carry `account` on the wire (the schema omits it — session
     continuity flows through `session_id`), so
     `accounts.resolve(undefined)` falls back to a default brand.
     Previously `brand_acme_outdoor`; now `brand_nova_motors` to match
     the compliance fixture. Production agents are typically
     single-brand per deployment, so a hardcoded default is the right
     shape; multi-brand deployments derive from `ctx.authInfo`
     per-API-key binding.
  3. **Top-level `offering_id` mirror on `SIGetOfferingResponse`.**
     The `si_baseline` storyboard's `context_outputs` capture uses
     `path: 'offering_id'` at the top level, but the canonical AdCP
     schema puts the id at `offering.offering_id`. Schema allows
     `additionalProperties: true` at the response root, so the
     adapter emits a top-level mirror to satisfy the storyboard's
     capture pattern. Filed upstream — once the storyboard's path is
     corrected to `offering.offering_id`, this mirror can be dropped.

  **Test refactor.** `test/examples/hello-si-adapter-brand.test.js`
  now uses `runHelloAdapterGates` (the standard three-gate helper used
  by every other `hello_*_adapter_*.ts`) instead of its previous
  hand-rolled MCP smoke test:
  1. Strict tsc (`--strict --noUncheckedIndexedAccess
--exactOptionalPropertyTypes
--noPropertyAccessFromIndexSignature`)
  2. `adcp storyboard run si_baseline` reports zero failed steps
  3. Façade gate — every expected upstream route shows ≥1 hit at
     `/_debug/traffic`

  This brings SI to parity with the four other `hello_*_adapter_*.ts`
  examples — same gating shape, same regression contract.

  **Mock-server tests** stay green (23/23) — the seed-data tests
  assert mapping shape, not specific brand counts. The full server
  suite remains green at 1158 tests; SI v6 platform tests at 7/7.

  Refs adcontextprotocol/adcp#3961, #1441, #1454, #1464.

- 7a24fc5: feat(server): SponsoredIntelligencePlatform — v6 protocol-keyed dispatch shape for SI

  Adds `SponsoredIntelligencePlatform<TCtxMeta>` to the v6
  `DecisioningPlatform` config — adopters now wire SI through the v6
  platform shape with auto-hydrated session state, parity with how every
  other specialism (signals, sales, creative, governance, brand-rights)
  already works. Replaces the v5 `SponsoredIntelligenceHandlers` handler-
  bag as the recommended path, but keeps the v5 escape hatch working for
  in-flight adopters.

  **Why protocol-keyed and not specialism-keyed.** AdCP 3.0 declares SI as a
  _protocol_ (`supported_protocols: ['sponsored_intelligence']`), not a
  _specialism_ — `'sponsored-intelligence'` is absent from
  `AdCPSpecialism`. Tracked upstream at adcontextprotocol/adcp#3961
  (targeted at 3.1). Rather than wait or invent local-only behavior, this
  release dispatches off the SDK's `platform.sponsoredIntelligence` field
  itself: presence triggers SI tool registration, which the existing
  `detectProtocols` derivation picks up to emit `'sponsored_intelligence'`
  in the wire-side `supported_protocols`. When 3.1 promotes SI to a
  specialism, dispatch becomes additive — adopters can claim either form
  without code changes.

  **The four method surface** (`src/lib/server/decisioning/specialisms/sponsored-intelligence.ts`):

  ```ts
  interface SponsoredIntelligencePlatform<TCtxMeta = Record<string, unknown>> {
    getOffering(req: SIGetOfferingRequest, ctx): Promise<SIGetOfferingResponse>;
    initiateSession(req: SIInitiateSessionRequest, ctx): Promise<SIInitiateSessionResponse>;
    sendMessage(req: SISendMessageRequest, ctx): Promise<SISendMessageResponse>;
    terminateSession(req: SITerminateSessionRequest, ctx): Promise<SITerminateSessionResponse>;
  }
  ```

  **Auto-hydrated session state.** `initiateSession` returns trigger an
  auto-store under `ResourceKind: 'si_session'` keyed on the response's
  `session_id`. Subsequent `sendMessage` / `terminateSession` calls hit the
  schema-driven hydrator (already declared in `entity-hydration.generated.ts`
  for `si_send_message.session_id` and `si_terminate_session.session_id`)
  which attaches the stored record at `req.session`. Platform implementations
  read transcript context from `req.session` rather than threading manual
  `ctx.store.get` calls — same ergonomics as `req.media_buy` /
  `req.signal` / `req.rights_grant` on the other specialisms.

  The stored payload preserves the bits a brand engine needs to resume
  context across turns: request-side scoping (`intent`, `offering_id`,
  `offering_token`, `placement`, `media_buy_id`, `identity` consent
  state, `supported_capabilities`) and response-side state
  (`negotiated_capabilities`, `session_status`, `session_ttl_seconds`).
  On `terminateSession`, the framework also persists `acp_handoff`,
  `session_status: 'terminated'`, `follow_up`, and `terminated` onto
  the same record so the spec's "re-terminating a closed session
  returns the same payload" idempotency contract is honored without
  adopters having to write through manually.

  **Important caveat on `req.session`.** The auto-store + hydration
  covers the small fixture / mock case and the lookup-the-original-
  context case (e.g., "what offering did this session resolve to?").
  Production brand engines almost always own full transcript state in
  their own backend (Postgres, Redis, vector store) — full transcripts,
  RAG embeddings, tool-call logs are too rich for `ctx_metadata` and
  easily exceed the 16KB blob cap. Treat `req.session` as a
  convenience, not authoritative state — resolve full transcript state
  from your own session store keyed by `req.session_id`. Documented
  explicitly in the platform interface JSDoc.

  **Type-level helper for forward compat.**
  `RequiredPlatformsForProtocols<P>` parallels the existing
  `RequiredPlatformsFor<S>`. Currently kept `@internal` (not exported) —
  there is no constraint site consuming it today (no `supported_protocols`
  field on `DecisioningCapabilities`, no wired
  `createAdcpServer<P>` signature). Lands now so the type sits next to
  the platform field for future wiring; promotion to public happens when
  either AdCP 3.1 adds SI to `AdCPSpecialism` (at which point this folds
  into `RequiredPlatformsFor`) or `DecisioningCapabilities` grows an
  explicit `supported_protocols` declaration field. Adopters needing
  compile-time gating today can constrain `platform: P & {
sponsoredIntelligence: SponsoredIntelligencePlatform }` directly at
  the call site.

  **Wire changes:**
  - `ResourceKind` gains `'si_session'`. `'si_session'` removed from
    `INTENTIONALLY_UNHYDRATED_ENTITIES` since the framework now hydrates
    it. `ENTITY_TO_RESOURCE_KIND` gains `si_session: 'si_session'`.
  - `'offering'` stays in `INTENTIONALLY_UNHYDRATED_ENTITIES` — the SI
    spec uses `offering_token` (a brand-side correlation primitive) for
    offering→session continuity, which doesn't map cleanly to the
    framework's resource-kind hydration.

  **v5 path unchanged.** The existing v5 `SponsoredIntelligenceHandlers`
  handler-bag (`src/lib/server/create-adcp-server.ts:855`) keeps working
  exactly as before; adopters using `createAdcpServer({
sponsoredIntelligence: { getOffering, initiateSession, sendMessage,
terminateSession } })` see no behavior change. The v6 platform path
  adapts onto the same dispatcher slot via `buildSponsoredIntelligenceHandlers`
  in `from-platform.ts`, mirroring how `buildSignalsHandlers` adapts
  `SignalsPlatform` onto `SignalsHandlers`.

  **Tests.** New `test/server-si-platform.test.js` covers the v6 surface
  end-to-end:
  - All four SI tools register when `platform.sponsoredIntelligence` is
    present
  - `'sponsored_intelligence'` appears in `get_adcp_capabilities.supported_protocols`
  - `initiateSession` auto-stores session record; `sendMessage` receives
    hydrated `req.session` with original intent / offering_id /
    negotiated_capabilities / session_status / session_ttl_seconds
  - `terminateSession` receives the same hydrated `req.session`
  - No SI tools register when the platform field is absent

  5 tests, all passing. Full `test/server-*.test.js` suite remains green
  (1171 tests).

  **Tool-name reconciliation.** Stale tool names in
  `protocol-for-tool.ts:30-33` (`si_end_session` / `si_get_session` —
  which never matched the spec) corrected to the canonical
  `si_terminate_session` / `si_get_offering`, and `si_get_offering`
  added (it was missing from the protocol-routing map). Cosmetic for
  v6 dispatch (which keys off platform field, not this map) but
  load-bearing for any telemetry / diagnostics that look up
  protocol-by-tool-name.

  **Tracking.** Refs adcontextprotocol/adcp#3961 (spec — `sponsored-intelligence`
  in `AdCPSpecialism` for 3.1).

  **Follow-up release blocker.** `examples/hello_si_adapter_brand.ts`
  driving the `mock-server sponsored-intelligence` fixture through this
  v6 platform lands separately and ships in the same release window —
  not a slip-able item. SI is the most foreign specialism in the
  catalog (host↔brand handoff, ACP checkout, surface/ui_elements,
  identity consent gating), so the surface without a worked example
  will get adopted incorrectly.

- 21f9c07: Add `examples/hello_creative_adapter_ad_server.ts` — worked starting point for an AdCP creative agent (specialism `creative-ad-server`). Closes #1460 (sub-issue of #1381 hello-adapter-family completion).

  Pattern: GAM-creative / Innovid / Flashtalking / CM360 model — stateful library + tag generation. The structural delta from `hello_creative_adapter_template.ts` is additive: promotes `CreativeBuilderPlatform` → `CreativeAdServerPlatform`, adds `listCreatives` + `getCreativeDelivery` + stateful `syncCreatives` library, replaces template-driven `buildCreative` with macro-substitution flow against a stored snippet template.

  Implements all 6 `CreativeAdServerPlatform` methods:
  - `buildCreative` — pulls stored snippet from `GET /v1/creatives/{id}`, calls upstream `POST /v1/creatives/{id}/render` for macro substitution, returns `BuildCreativeSuccess` with `creative_manifest.assets` carrying the rendered HTML tag.
  - `previewCreative` — `NoAccountCtx` no-account tool; returns a real iframe-embeddable URL pointing at the mock's `/serve/{id}` endpoint.
  - `listCreativeFormats` — `NoAccountCtx`; projects upstream catalog to closed-shape `Format.renders[]` (display fixed dimensions, video/CTV 1080p baseline, parameterized 1×1 placeholder).
  - `syncCreatives` — wraps `POST /v1/creatives`. Library write. `creative_id` round-tripped to upstream `client_request_id`. Typed `CREATIVE_REJECTED` errors when format auto-detection fails.
  - `listCreatives` — wraps `GET /v1/creatives` with cursor pagination. `filter.creative_ids[]` multi-id pass-through (#1410). Projects to `query_summary` + `pagination` + `creatives[]` per `tools.generated.ListCreativesResponse`.
  - `getCreativeDelivery` — wraps `GET /v1/creatives/{id}/delivery`. Multi-id fan-out per `filter.creative_ids[]`. Returns currency + reporting_period + per-creative impressions/clicks rows.

  Auth + multi-tenant routing: static Bearer; `accounts.resolve` translates `ref.brand.domain` → `X-Network-Code` via `GET /_lookup/network`. No-account tools fall back to `KNOWN_PUBLISHERS[0]` so `previewCreative` / `listCreativeFormats` resolve cleanly. Sandbox arm in `accounts.resolve` stamps `mode: 'sandbox'` (#1435 phase 3 posture); `account_id` arm routes any opaque id to the ACME network so storyboard fixtures referencing seeded ids resolve cleanly.

  `comply_test_controller` wired via `complyTest:` config — `seed.creative` adapter forwards storyboard fixture entries (`controller_seeding: true`) to the upstream library via `POST /v1/creatives` with the caller-supplied `creative_id` override (test-only path on the mock).

  Three-gate CI test (`test/examples/hello-creative-adapter-ad-server.test.js`) lands alongside: strict tsc / `creative_ad_server` storyboard / upstream-traffic façade. All seven storyboard steps pass on first build (no SDK gaps deferred).

  The mock's `POST /v1/creatives` gains a TEST-ONLY `creative_id` override field so cascade fixtures can reference seeded creatives by their declared alias instead of resolving server-assigned ids. Production-shipped servers should reject this field; the override is gated by being optional + undocumented in the public OpenAPI surface.

- a8a62dd: Add `examples/hello_seller_adapter_non_guaranteed.ts` — worked starting point for an AdCP non-guaranteed sales agent. Closes #1458 (sub-issue of #1381 hello-adapter-family completion).

  Pattern modeled on `hello_seller_adapter_guaranteed.ts` with auction-specific deltas:
  - **Sync confirmation** — `create_media_buy` returns `media_buy_id` immediately; no IO-review handoff. Auction inventory clears at request time.
  - **Floor pricing** — `pricing_options[].fixed_price` projected from upstream `min_cpm`; `min_spend` and `target_cpm` flow through to the wire when the upstream sets them.
  - **Spend-only forecast** — `forecast_range_unit: 'spend'`; no `availability` unit because non-guaranteed inventory isn't pre-committed.
  - **Pacing propagation** — `even` / `asap` / `front_loaded` forwarded to upstream order; reflected in delivery curve.
  - **Looser product-validation at order creation** — the upstream mock no longer 404s when `line_items[].product_id` references a product not in the seed catalog. Cascade scenarios under `media_buy_seller/*` seed product fixtures via `comply_test_controller` independent of the seller's static catalog; min_spend is enforced only when the product IS known on the network.

  Three-gate CI test (`test/examples/hello-seller-adapter-non-guaranteed.test.js`) lands alongside: strict tsc / storyboard runner / upstream-traffic façade. Two SDK-side gaps deferred (#1415 `targeting_overlay` echo, #1416 `NOT_CANCELLABLE` state-machine export) — same allowlist as the guaranteed gate.

- 6fd796c: Add `resolveWithoutRef` option to `RosterAccountStoreOptions`. When set, ref-less `accounts.resolve(undefined, ctx)` calls (from `list_creative_formats`, `provide_performance_feedback`, `preview_creative`, and discovery-phase tools) are routed through the hook then through `toAccount`, enabling a synthetic publisher-wide singleton without overriding `resolve` on the returned store. When omitted, existing behavior is unchanged (`null` returned for ref-less calls). Also adds a `## Ref-less resolution` section to `docs/guides/account-resolution.md`.
- 88125da: feat(mock-server): `sales-non-guaranteed` — programmatic auction with sync confirmation + spend-only forecast. Closes #1457 (sub-issue of #1381).

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

### Patch Changes

- 3a6c853: ci(codegen): regression guard for `{ [k: string]: unknown | undefined }` leaking back into generated `oneOf` arms. Closes #1380.

  `tightenMutualExclusionOneOf` (`scripts/generate-types.ts`, shipped via #1325) inlines parent `properties` into each arm of an `oneOf` with `required + not.required` clauses, so adopters' typed builders compose with `Format['renders']` and similar fields under `--strict --noUncheckedIndexedAccess`. The new `scripts/check-no-loose-oneof.ts` walks `core.generated.ts` and `tools.generated.ts` after codegen and fails the build if any union variant is exactly the bare blob shape — the canonical signal that the preprocessor missed a future `oneOf` regression.

  Wired as `npm run ci:codegen-strict`, runs in CI between the schema-sync check and the skill-sync check, and is included in `ci:pre-push`. The check passes against current generated types (regression baseline). Five unit tests in `test/check-no-loose-oneof.test.js` lock the bug-pattern recognition: union arm flagged, freeform-blob alias allowed, nested property allowed, typed index signature allowed, interface property union flagged.

  Allowlist mechanism present (currently empty) for cases where a bare-blob union arm is intentional — populate per-PR with rationale if any spec change ever genuinely needs it.

- 47bd209: fix(server): echo input.context into comply_test_controller response envelopes

  `handleTestControllerRequest` and `createComplyController.handleRaw` now propagate `input.context` into every response branch (`ListScenariosSuccess`, `StateTransitionSuccess`, `SimulationSuccess`, `ForcedDirectiveSuccess`, `SeedSuccess`, `ControllerError`), matching the `comply-test-controller-response.json` schema. Previously, storyboards asserting `context` echo (e.g. `deterministic_testing`'s correlation_id round-trip) failed with "Field not found at path: context". Fixes #1455.

- f4bb1cd: `createAdcpServer` collision-check error now points at the platform handler that supersedes a colliding `customTools` entry (for example, `BrandRightsPlatform.updateRights` for `customTools["update_rights"]`, which was promoted to a framework-registered first-class tool in 6.7.0). The previous "rename the custom tool or remove the handler from the conflicting domain group" advice was misleading for adopters carrying a pre-6.7 customTool registration across the version boundary — the throw surfaces as HTTP 500 HTML on every MCP probe in lazily-built tenant servers, masquerading as a client-side discovery regression. The hint now names the migration so the next adopter who hits this lands on the right fix.

  `docs/migration-6.6-to-6.7.md` adds recipe **#16** with the audit recipe (`grep -rn 'customTools.*update_rights'`) and the platform-handler swap, and the breaking-changes preamble now lists this alongside #10 and #11.

- b0e3c00: docs(skills): rewrite build-si-agent SKILL.md against the v6 platform

  The SI skill was scaffolded against the v5 handler-bag escape hatch
  because the v6 `SponsoredIntelligencePlatform` interface didn't exist
  when the skill landed. v6.7 shipped that interface (#1454) plus the
  worked example (#1464) and storyboard fixtures (#1471). The skill is
  now stale — adopters reading it would route through `createAdcpServer`
  from `@adcp/sdk/server/legacy/v5` and miss auto-hydrated `req.session`,
  typed dispatch parity with every other specialism, and the
  storyboard-ready reference adapter.

  This rewrite brings the skill in line with the shipped state:
  - **SDK Quick Reference** lists `createAdcpServerFromPlatform`,
    `definePlatform`, and `defineSponsoredIntelligencePlatform`. Drops
    the `v5 escape hatch` callout (still works but no longer
    recommended).
  - **Implementation skeleton** uses the v6 platform shape — single
    `definePlatform({ capabilities, accounts, sponsoredIntelligence })`
    literal with `defineSponsoredIntelligencePlatform<BrandMeta>({...})`.
    Matches the structure of `examples/hello_si_adapter_brand.ts`.
  - **`req.session` documented** with explicit production caveat:
    framework auto-hydrates a small record (intent, offering scoping,
    identity consent, negotiated capabilities, ttl) for the fixture /
    mock case and the "what was the original scope?" lookup. Production
    brand engines almost always own full transcript state in their own
    Postgres / Redis / vector store — modeling full transcripts in
    `ctx_metadata` will hit the 16KB blob cap.
  - **Storyboard validation step** points at `si_baseline` (
    `compliance/cache/latest/protocols/sponsored-intelligence/index.yaml`)
    with the reference adapter's `3/3 scenarios pass` baseline.
  - **Specialism vs. protocol** framing clarified: SI is a _protocol_
    in AdCP 3.0 (`'sponsored_intelligence'` in `supported_protocols`),
    not yet a specialism (adcp#3961 for 3.1). The platform field's
    presence is the declaration; framework auto-derives the protocol
    claim from the four registered SI tools. When 3.1 lands, declaring
    `specialisms: ['sponsored-intelligence'] as const` becomes additive
    — both forms work.
  - **Common Mistakes table** updated: drops "use the v5 path" guidance,
    adds new gotchas (`product_card.data.title` + `data.price` strict-
    schema requirements, the "don't model full transcripts in
    ctx_metadata" trap, the "don't declare the SI specialism yet" trap).
  - **Tracking** section ties to adcp#3961 + adcp#3981 so adopters can
    follow upstream movement.

  The skill matrix entry (`scripts/manual-testing/skill-matrix.json`)
  already maps `build-si-agent/SKILL.md` to the `si_baseline` storyboard
  — that pairing now passes 3/3 with the rewritten skill driving the v6
  example.

  Refs adcontextprotocol/adcp#3961, #3981, adcp-client#1441, #1454,
  #1464, #1471.

- 0932a60: fix(mcp): restore SSE fallback for loopback/private-address MCP servers

  The 6.7.0 `isPrivateAddress` gate assumed all private/loopback servers support
  StreamableHTTP and skipped SSE fallback for them. This broke discovery against
  locally-running SSE-only servers (e.g. training-agent endpoints at 127.0.0.1).
  The `knownStreamableHTTPUrls` guard already handles the "we know this URL speaks
  StreamableHTTP" case correctly; the address-based gate is removed.

- ff77b65: Wire up `examples/hello-cluster.ts` to boot all 7 hello-adapter specialisms + multi-tenant. Closes #1461 (final sub-issue of #1381 hello-adapter-family completion).

  Cluster manifest now lists 8 live entries (signals 3001, creative-template 3002, sales-social 3003, sales-guaranteed 3004, sales-non-guaranteed 3005, creative-ad-server 3006, sponsored-intelligence 3007, multi-tenant 3008) plus 3 pending placeholders (governance / brand-rights / retail-media — auto-skipped until those examples land). Universal `/_debug/traffic` probe replaces per-specialism lookup paths; every mock-server already exposes it. `npm run hello-cluster` boots 8 adapters in ~2.2s with mocks running.

  Skill prose collapsed onto fork-target pointers per the #1385 collapse pattern:
  - `skills/build-seller-agent/specialisms/sales-non-guaranteed.md` reduced from 41 → 17 lines; inline code samples removed (the worked adapter is the canonical reference).
  - `skills/build-creative-agent/SKILL.md` § creative-ad-server reduced from ~100 → ~25 lines; same shape.

  Closes #1381 with all five sub-issues (#1457, #1458, #1459, #1460, #1461) merged.

- 1240099: feat(decisioning): extend multi-id truncation dev-mode warn to `listCreatives`, `getCreativeDelivery`, and `getSignals`. Closes #1410.

  The warn shipped in 6.7 for `getMediaBuyDelivery` and `getMediaBuys` (`media_buy_ids[]`); the same `<id_field>[0]`-truncation hazard applies to every read-by-id surface. The extension fires when adopters' platforms return fewer rows than the buyer's `creative_ids[]` / `signal_ids[]` filter requested, with the same gates: silent in `NODE_ENV=production`, suppressible via `ADCP_SUPPRESS_MULTI_ID_WARN=1`, no-op when the id-array filter is omitted (paginated-list mode).

  Wired at four new dispatch sites in `from-platform.ts`:
  - `listCreatives` — both the sales-side dispatch (when `SalesPlatform` provides it) and the creative-side ad-server dispatch.
  - `getCreativeDelivery` — creative-side ad-server only.
  - `getSignals` — note `signal_ids` is `SignalID[]` (`{source, data_provider_domain, id}` objects), not bare strings; the helper compares on length only so the element type is irrelevant.

  The helper signature gains a typed `idFieldName` parameter so the warn message names the right id field (`media_buy_ids` / `creative_ids` / `signal_ids`); the existing two call sites pass `'media_buy_ids'` explicitly.

  Sync / upsert surfaces (`syncCreatives`, `syncCatalogs`, `syncPlans`) remain out of scope per the issue carve-out — those have a different shape where pass-through is the obvious pattern and "did all rows roundtrip?" isn't a clean question.

  The 6 existing tests in `test/server-decisioning-multi-id-truncation-warn.test.js` still pass; one new test pins the `getSignals` wiring (the distinctive `SignalID[]` object-array shape).

- 5836ad7: test(validation): broad-sweep regression coverage for the `oneOf`-`not`-keyword exclusion shipped via #1337. Closes #1383.

  `compactUnionErrors` (`src/lib/validation/schema-validator.ts`) excludes `oneOf` variants whose only residual is a `not`-keyword failure when picking the "best surviving variant." The fix landed for `get_account_financials` per #1337; the same heuristic applies to every Success/Error response union in AdCP 3.x, but the prior test suite covered the canonical case only.

  This change locks the universal invariant as a parameterized regression suite: for every response schema with a `not` clause in its bundled cache (25 schemas in 3.0.4), an empty-payload response surfaces zero `not`-keyword issues. Pre-#1337, those payloads would surface "must NOT be valid" diagnostics — unactionable for adopters debugging from the wire envelope.

  `get_signals` and `tasks_get` are intentionally absent from the sweep — their response shapes don't use the Success/Error oneOf-with-not pattern.

  Future response unions inherit the coverage automatically when added to the schema cache; the fixture list at the top of the new `describe` block is the single update point.

- 796fa5d: Collapse `examples/hello_seller_adapter_guaranteed.ts` onto the framework-side comply gate (Phase 3 of #1435).

  The Hello seller-guaranteed adapter no longer carries any in-adapter `comply_test_controller` gate logic — it's a worked example of the zero-boilerplate posture Phase 2 made possible.

  Three changes:
  1. **`accounts.resolve` synthesis branch** — the `if (ref.sandbox === true && process.env.ADCP_SANDBOX === '1')` cascade-scenario synthesis now gates only on `ref.sandbox === true` (the spec-defined `AccountReference.sandbox` flag) and stamps `mode: 'sandbox'` on the returned `Account`. The framework gate's resolver-path admit fires on that mode; no env var is consulted.
  2. **HITL bypass** — `ctx.account.id.startsWith(SANDBOX_ID_PREFIX) && process.env.ADCP_SANDBOX === '1'` is now `getAccountMode(ctx.account) === 'sandbox'`. Same trust signal, no env var, more robust against any production account whose id happens to share the sandbox prefix.
  3. **`complyTest:` opts** — dropped `sandboxGate: () => process.env.ADCP_SANDBOX === '1'`. Phase 2's framework gate is strictly stronger; the in-adapter callback was redundant.

  `test/examples/hello-seller-adapter-guaranteed.test.js` no longer sets `ADCP_SANDBOX: '1'` in `extraEnv`. The storyboard now passes purely on the resolver-stamped mode.

  **Other Hello adapters were already clean.** `hello_seller_adapter_social.ts`, `hello_seller_adapter_multi_tenant.ts`, and `hello_creative_adapter_template.ts` did not wire the controller. `hello_signals_adapter_marketplace.ts` uses the lower-level `registerTestController` (which Phase 2's gate doesn't intercept) and is left on the legacy path; migration to `complyTest:` opts is non-mechanical because the recorder integration would need a comply-adapter shape upstream.

  **Mock-server is unchanged.** Account synthesis happens inside the Hello adapter's `resolve`; the mock-server is only the upstream HTTP backend (returns `network_code` / `operator_id`). Stamping `mode: 'sandbox'` lives in the resolver, where it belongs.

  **Existing legacy-path coverage retained.** `test/server-decisioning-comply-test.test.js` continues to exercise the `process.env.ADCP_SANDBOX === '1'` admit path so the deprecated env-fallback bridge stays tested through its life.

- b51c0ab: `hello_seller_adapter_guaranteed` now enforces the `MediaBuyStatus` state machine on `update_media_buy`. Closes the `media_buy_seller/invalid_transitions/second_cancel` storyboard gap that adcp-client#1416 had been tracking.

  Three small changes:
  1. New `localBuyStatus: Map<string, MediaBuyStatus>` tracker — production sellers swap this for a query against their order DB.
  2. `createMediaBuy` records `pending_creatives` on success.
  3. `updateMediaBuy` reads current status (preferring the local tracker for `canceled` / `paused` since the upstream mock doesn't model those, otherwise falling through to `mapMediaBuyStatus(order.status)`), calls `assertMediaBuyTransition` (newly imported from `@adcp/sdk/server`) when the patch sets `canceled: true` or `paused: true`, and updates the tracker on success. Re-cancel now throws `NOT_CANCELLABLE` per `core/state-machine.yaml`.

  Allowlist in `test/examples/hello-seller-adapter-guaranteed.test.js` shrinks from three entries to two. Remaining entries (#1415, #1417) are upstream-fixture issues — the SDK already shipped both fixes (createMediaBuyStore in PR #1424, runner `task_completion.<path>` capture in PR #1426); the storyboards in `adcontextprotocol/adcp` need migration to consume them. Both entries' `reason` strings updated to spell out which side of the boundary closes them.

  The other four hello adapters (`creative-template`, `seller-social`, `signals-marketplace`, `si-brand`) have no allowlist and already pass clean.

- e4af84c: fix(runner): align with adcp#3987 — non-JSON `payload_must_contain` modes grade `not_applicable` (no terminal-key fallback)

  Closes the runner-side gap that adcp#3845 surfaced and adcp#3987 (merged) ratified.

  **Before:** `match: present` against non-JSON `content_type` (form-urlencoded, multipart, plain text) fell back to a terminal-key substring search — extract `hashed_email` from `users[*].hashed_email`, substring-match against the raw payload string. That created false positives (a payload mentioning `hashed_email` in any context — URL fragment, comment, unrelated metadata field — would pass), exactly the loophole the anti-façade contract exists to close.

  **After:** ALL `payload_must_contain` match modes (`present` / `equals` / `contains_any`) grade `not_applicable` against non-JSON content types, consistent with the `equals` / `contains_any` behavior that already shipped. Storyboards needing a non-JSON value-carried signal use `identifier_paths` — substring-searches storyboard-supplied VALUES (not path-derived strings), which is encoding-agnostic and doesn't suffer the false-positive surface.

  **Side effects:**
  - `terminalPathKey` helper deleted (no remaining callers).
  - Existing test asserting the substring-fallback behavior updated to assert `not_applicable: true` (matches the equals-mode test already in the suite).
  - `isJsonContentType` doc updated to reference RFC 6839 §3.1 explicitly — newline-delimited JSON formats (`application/json-seq`, `application/jsonl`) take the non-JSON path; the JSON detection itself was already correct (`application/json` or `*/*+json` suffix).
  - `globToRegExp` doc updated to note adcp#3987 ratified the wildcard grammar (was previously documented as "candidate semantics filed against the spec at adcp#3845") and added the no-escape-mechanism clarification per the merged spec.

- 91e789d: fix(sync-schemas): preserve SDK-local `call-adcp-agent/SKILL.md` across protocol bundle syncs

  `syncSkillsFromBundle` previously overwrote `skills/call-adcp-agent/` from the upstream protocol tarball whenever the bundle's `manifest.contents.skills` listed it. Because the SDK-maintained copy carries SDK-version-specific addenda (e.g. `SDK ≥6.7` `discriminator`/`schemaId`, `SDK ≥6.8` `hint`), every `npm run sync-schemas` (and every `prepublishOnly`) silently rolled those sections off — letting them ship in the npm package only when the spec bundle happened to include them.

  Add a `SDK_LOCAL_SKILLS` allowlist so `call-adcp-agent` is treated like `build-seller-agent/` and friends: present in `skills/`, but never replaced by the protocol bundle. Per-protocol skills (`adcp-{brand,creative,governance,media-buy,si,signals}`) continue to sync normally.

  Also synchronizes `package-lock.json` to the committed `package.json` 6.7.0 so workspace setup no longer regenerates it on every `npm install`.

- 4f59334: Re-export SI and signals helper types from `@adcp/sdk/types`: `SICapabilities`, `SIIdentity`, `SISessionStatus`, `SIUIElement`, `SignalFilters`, `SignalTargeting`. Adopters typing handler internals no longer need to reach into `tools.generated`. `AssetVariant` is intentionally excluded — it is a narrower generated union (omits `AudioAsset`); prefer the curated `AssetInstance` union already exported from `@adcp/sdk/types`.

## 6.7.0

### Minor Changes

- 610b952: `Account.authInfo` is now optional. Closes #1286.

  Adopters who don't authorize against the principal in resource handlers can omit `authInfo` from the returned `Account` and pass strict typecheck. The field stays for adopters who _do_ persist a principal — typically OAuth-style sellers who derive a tenant-scoped sub-principal from `ctx.authInfo` (`ResolvedAuthInfo`) and store it as `AuthPrincipal` on the Account.

  Why optional rather than auto-attached: `Account.authInfo` is `AuthPrincipal` (the resolver's chosen persistence shape, with a `kind` discriminator), not `ResolvedAuthInfo` (the raw transport-level auth `serve({ authenticate })` extracts). The two types are intentionally distinct — the resolver decides which fields to keep / drop / re-shape. The framework can't cleanly auto-project one to the other. Adopters who want the principal threaded through set it explicitly:

  ```ts
  accounts: {
    resolve: async (ref, ctx) => ({
      id: 'acct_123',
      name: 'Acme',
      status: 'active',
      ctx_metadata: { /* ... */ },
      // Optional. Set when handlers downstream need the principal:
      authInfo: ctx?.authInfo ? { kind: 'oauth', clientId: ctx.authInfo.clientId, ... } : undefined,
    }),
  }
  ```

  Backwards-compatible: existing adapters that already populate `authInfo` keep working; new/forked adapters omitting it now compile cleanly.

- 461e85c: `AccountStore.syncGovernance` — typed `sync_governance` surface promoted to v6 platform. Closes one of the items tracked in #1387.

  Buyers register governance agent endpoints per-account via `sync_governance`; the seller persists the binding and consults the registered agents during media buy lifecycle events via `check_governance`. Pre-this-release, adopters wired this through the v5 escape-hatch (`opts.accounts.syncGovernance`), which forced `as any` casts to satisfy the framework's merge-seam types. Now it's a typed method on `AccountStore` symmetric with `upsert` / `list`:

  ```ts
  accounts: AccountStore<TenantMeta> = {
    resolve: async (ref, ctx) => { /* ... */ },
    upsert: async (refs, ctx) => { /* sync_accounts */ },
    syncGovernance: async (entries, ctx) => {
      // Per-entry tenant-isolation gate. ctx.agent is the auth-resolved
      // BuyerAgent — assert each entry's account.operator maps to the same
      // tenant before persisting. Per-entry rejection (vs. operation-level
      // throw) so a single bad entry doesn't fail the whole batch.
      const homeTenantId = ctx?.agent ? BUYER_HOME_TENANT.get(ctx.agent.agent_url) : undefined;
      return entries.map(entry => {
        const tenantId = OPERATOR_TO_TENANT.get(entry.account.operator);
        if (!homeTenantId || tenantId !== homeTenantId) {
          return {
            account: entry.account,
            status: 'failed',
            errors: [{ code: 'PERMISSION_DENIED', message: '...' }],
          };
        }
        // persist binding...
        return { account: entry.account, status: 'synced', governance_agents: [...] };
      });
    },
  };
  ```

  The signature takes the wire entries (`SyncGovernanceRequest['accounts']`) directly — each entry pairs an `AccountReference` with its `governance_agents[]`. Framework strips `idempotency_key` / `adcp_major_version` / `context` / `ext` (already deduped) and wraps the returned rows in `{ accounts: rows }` for the wire response.

  **Security: write-only credentials are stripped at the wire boundary.** Per spec, each `governance_agents[i].authentication.credentials` is the bearer the seller will present on outbound `check_governance` calls — the buyer sends it, the seller persists it, but it MUST NOT echo back. The framework now strips `authentication` from every `governance_agents[i]` of every row before serialization, in both `syncGovernanceResponse` (the wire-emit boundary that covers v5 escape-hatch adopters) and the v6 dispatcher (`toWireSyncGovernanceRow`). Adopters can return loosely-typed rows or spread the input agent without leaking credentials over the wire OR into the idempotency replay cache. Defense-in-depth — TypeScript narrowing alone is insufficient because excess-property checks don't fire on assigned variables and the response Zod schema uses `.passthrough()`.

  Backwards-compatible: `syncGovernance` is optional on `AccountStore`. Adopters using the v5 escape-hatch (`opts.accounts.syncGovernance`) keep working unchanged — the v6 typed surface takes precedence when both are set. Adopters who haven't wired `sync_governance` at all continue to see the framework's `UNSUPPORTED_FEATURE` envelope.

- c1537e1: `AccountStore.upsert` and `AccountStore.list` now receive an optional `ResolveContext` second argument. Closes #1310.

  The framework forwards `authInfo`, `toolName`, and `agent` (when an `agentRegistry` is configured) — the same shape already threaded to `accounts.resolve`, `reportUsage`, and `getAccountFinancials`. Adopters can implement principal-keyed gates on `sync_accounts` / `list_accounts` (e.g. the spec's `BILLING_NOT_PERMITTED_FOR_AGENT` per-buyer-agent gate from adcontextprotocol/adcp#3851) without re-deriving identity from the request.

  ```ts
  accounts: {
    upsert: async (refs, ctx) => {
      if (!agentMayBillVia(ctx?.agent, refs[0].billing)) {
        throw new AdcpError('BILLING_NOT_PERMITTED_FOR_AGENT', { recovery: 'terminal' });
      }
      // ...
    },
    list: async (filter, ctx) => {
      // Scope the listing to the calling agent's accounts.
      return db.accounts(filter, { agentUrl: ctx?.agent?.agent_url });
    },
  }
  ```

  Backwards-compatible at the type level: `ctx` is optional on the platform side, so existing implementations that don't accept the second arg keep compiling.

  **Security-relevant migration note for multi-tenant adopters.** Pre-this-release, adopters had no way to scope `accounts.list` per-principal — implementations either returned all accounts (over-disclosure) or rejected the operation. Post-this-release, scoping becomes possible. **This is opt-in, not automatic.** Multi-tenant adopters should add principal scoping in the upgrade:

  ```ts
  list: async (filter, ctx) => {
    // Scope to the calling agent's accounts. Without this, every authenticated
    // caller sees every account.
    return db.listAccounts(filter, { agentUrl: ctx?.agent?.agent_url });
  },
  ```

- 37f1b2b: feat(server): Account v3 wire alignment — billing_entity, lifecycle and reporting fields

  The framework's `Account<TCtxMeta>` interface and `toWireAccount` projection lagged the AdCP 3.0 wire schema. Adopters returning `Account<TCtxMeta>` from `accounts.resolve` / `accounts.list` could not populate spec-required commercial fields, and the framework silently dropped them on emit — most visibly, the `setup` payload that drives the `pending_approval` → `active` lifecycle was lost between adopter and buyer.

  `Account<TCtxMeta>` now carries the wire-aligned optional fields:
  - `billing_entity` — business entity for B2B invoicing (`legal_name`, `vat_id`, `tax_id`, `registration_number`, `address`, `contacts`, write-only `bank`)
  - `rate_card` — applied rate-card identifier
  - `payment_terms` — `net_15` / `net_30` / `net_45` / `net_60` / `net_90` / `prepay`
  - `credit_limit` — `{ amount, currency }`
  - `setup` — `{ url?, message, expires_at? }` for `pending_approval` accounts
  - `account_scope` — `operator` / `brand` / `operator_brand` / `agent`
  - `governance_agents` — registered governance agent endpoints
  - `reporting_bucket` — offline reporting delivery configuration

  `toWireAccount` projects each field unchanged, with one exception: `billing_entity.bank` is stripped on emit. The wire schema marks bank coordinates as MUST NOT be echoed in responses (`BusinessEntity.bank` is write-only — included in `sync_accounts` requests, omitted from any response payload). Adopters who load and return a full entity from their store no longer leak bank details to buyers.

  `SyncAccountsResultRow` (returned by adopter `accounts.upsert` implementations) is extended in parallel with the same wire-aligned fields and projected through `toWireSyncAccountRow` before emit. The same `billing_entity.bank` strip applies on this path — adopters returning a row literal that spreads a DB record carrying bank coordinates (e.g., `{ ...db.findByBrand(r.brand), action: 'updated' }`) no longer leak bank details to buyers.

  `Account.governance_agents` elements are projected to `{ url, categories }` only on emit. The schema notes governance auth credentials are write-only and the codegen'd type already excludes them, but TS is erased at runtime — explicit projection prevents adopters using JS or `as any` from smuggling a `credentials` field straight to the wire.

  When `billing_entity` carries only `bank` (no other fields), the projection omits the entire entity rather than emitting an empty object — `BusinessEntity` requires `legal_name` per the wire schema, so the empty case would fail downstream validation.

  All additions are optional — adopters who don't set the new fields see no behavior change. Closes #1256.

- e2038be: Add `createTranslationMap` and `createUpstreamHttpClient` to `@adcp/sdk/server`. `createTranslationMap` provides a bidirectional, type-safe key mapping (AdCP wire values ↔ upstream platform values) with `toUpstream`, `toAdcp`, `hasAdcp`, and `hasUpstream` methods. `createUpstreamHttpClient` wraps `fetch` with auth injection (`static_bearer`, `dynamic_bearer`, `api_key`, `none`), query-string serialization, 404→null translation, and typed `get/post/put/delete` methods, replacing the per-adapter `httpJson` boilerplate. `dynamic_bearer.getToken` accepts an optional `AuthContext` forwarded from a per-call `authContext` option, so the same client supports single-key tenant fan-out, per-operator credential lookup, and pass-through of the caller's principal without per-operator client construction.
- 66b59c7: Add `resolveAgent`, `getAgentJwks`, `createAgentJwksSet`, and the `adcp resolve` CLI — bootstrap from an agent URL to its signing keys via the 8-step `identity.brand_json_url` discovery chain defined in security.mdx (added by spec PR adcontextprotocol/adcp#3690).

  ```ts
  import { resolveAgent, createAgentJwksSet } from '@adcp/sdk/signing/server';

  // Full chain + per-step trace.
  const r = await resolveAgent('https://buyer.example.com/mcp');
  // r.agentUrl, r.brandJsonUrl, r.agentEntry, r.jwksUri, r.jwks,
  // r.identityPosture, r.consistency, r.freshness, r.trace

  // JOSE adapter — required allowedAlgs at construction time + verify time
  // (defense-in-depth against alg-confusion).
  const getKey = createAgentJwksSet('https://buyer.example.com/mcp', {
    allowedAlgs: ['EdDSA', 'ES256'],
  });
  await jwtVerify(jwt, getKey, { algorithms: ['EdDSA', 'ES256'] });
  ```

  CLI: `npx @adcp/sdk resolve <agent-url> [--json] [--quiet]` — prints which step rejected when triaging `request_signature_brand_*` failures.

  The implementation:
  - Steps 1 (capabilities) goes through `ProtocolClient` (`createMCPClient` / `createA2AClient`) — never a raw HTTP `GET` against the agent URL.
  - Steps 4 / 8 (brand.json / JWKS) go through `ssrfSafeFetch` with no redirects, body caps (256 KiB / 64 KiB), and a strict-JSON parser that rejects duplicate keys + `__proto__` / `constructor` pollution.
  - Step 3 eTLD+1 binding uses a pinned PSL via `tldts` with ICANN+PRIVATE both in scope (so `vercel.app` is treated as a suffix). Runtime PSL fetches are explicitly disabled.
  - All wire-shape rejections surface as `AgentResolverError` with a `request_signature_*` code. The 9 spec-defined codes (`brand_json_url_missing`, `capabilities_unreachable`, `brand_json_unreachable`, `brand_json_malformed`, `brand_origin_mismatch`, `agent_not_in_brand_json`, `brand_json_ambiguous`, `key_origin_mismatch`, `key_origin_missing`) are joined by two SDK-side codes (`jwks_unreachable`, `jwks_alg_disallowed`) for distinct trust failures the spec hands to the verifier checklist post-bootstrap. Counterparty-controlled detail fields (`brand_json_url`, `jwks_uri`, `matched_entries[]`, `parse_error`) carry the `[ATTACKER_INFLUENCED]` symbol marker so admin-UI rendering downstream can detect and HTML-escape; SSRF refusals translate to a coarse `dns_error` classification rather than leaking the resolved IP.
  - `allowPrivateIp: true` is gated by `NODE_ENV in {test, development}` plus an explicit `ADCP_RESOLVER_ALLOW_PRIVATE_IP=1` ack, matching the existing pattern around `createAdcpServer`'s in-memory state — a security-critical entry point should fail closed when the carve-out gets wired from a misconfigured env var.
  - The field is forward-compat: 3.0-conformant operators can populate `identity.brand_json_url` today (the schema bump lands in 3.x's next minor; this SDK reads the field via a narrow accessor that codegen will catch up to on the next schema pin). No version bump required to adopt.

  **Schema pin: 3.0.4 → 3.0.5.** Picks up the `identity.additionalProperties: true` relaxation (upstream changeset `a4bd513`) so a 3.0-pinned seller emitting `identity.brand_json_url` on its `get_adcp_capabilities` response passes our strict response-validation gate. Without 3.0.5, the spec's "3.0 implementers can adopt the field today" narrative would have contradicted the SDK's default validator. Test `test/agent-resolver-publisher-side.test.js` asserts the publisher-side path; would have failed on 3.0.4 and earlier.

  Closes #1268.

- 522015d: feat(brand-rights): wire `update_rights` as a first-class mutating tool and add `creative_approval` webhook builders. The brand-rights domain group in `createAdcpServer` and the `BrandRightsPlatform` v6 typed-platform interface both gain the deferred surfaces from #552.

  `update_rights` (MCP/A2A tool):
  - Full `AdcpToolMap` entry → request schema validates `idempotency_key` requirement, response auto-wraps via `updateRightsResponse`.
  - `BrandRightsHandlers.updateRights?` for v5 raw-handler adopters.
  - `BrandRightsPlatform.updateRights` for v6 typed-platform adopters.
  - Auto-hydrates the underlying grant from `req.rights_id` (parallel to `acquire_rights`'s `req.rights` pattern); handlers read the resolved grant from `ctx.store`.
  - Picked up by `MUTATING_TASKS` automatically (Zod-derived) and by `BRAND_RIGHTS_TOOLS` for protocol detection.

  `creative_approval` (webhook-only):
  - Type re-exports (`CreativeApprovalRequest`, `CreativeApprovalResponse`, `CreativeApproved`, `CreativeRejected`, `CreativePendingReview`, `CreativeApprovalError`) reachable via `@adcp/sdk/types`.
  - Per-arm builders (`creativeApproved`, `creativeApprovalRejected`, `creativeApprovalPendingReview`, `creativeApprovalError`) on `@adcp/sdk/server` inject the status discriminator. Webhooks have no MCP envelope, so these return raw JSON-serializable payloads, not `McpToolResponse`.
  - `BrandRightsPlatform.reviewCreativeApproval` types the receiver method; adopters mount their own HTTP route at the URL they returned in `acquire_rights.approval_webhook` and dispatch through it.
  - Intentionally NOT in `BRAND_RIGHTS_TOOLS` or `MUTATING_TASKS` — webhook payloads carry their own `idempotency_key` validated by adopters at the receiver.

  Skill (`skills/build-brand-rights-agent/SKILL.md`) updated with the `update_rights` response shape (success + pending + error arms) and the `creative_approval` webhook receiver pattern.

  Closes #551.

- 5f45c64: feat: bump AdCP spec to 3.0.4

  `ADCP_VERSION` 3.0.1 → 3.0.4. Picks up three patch releases on the 3.0.x maintenance line. All changes are additive — no wire breaks for 3.0-conformant agents — but several close out items the SDK had been carrying as deferred follow-ups.

  What lands wire-side (44 schema deltas, 0 potentially breaking per `npm run schema-diff`):
  - **`core/error.json` gains optional `issues[]`** (adcp#3562 — closes adcp#3059). Standardizes the `VALIDATION_ERROR` issues-list shape that several response schemas had been re-declaring inline. Propagates through 41 response-schema sites, all additive. Existing handlers compile unchanged; new handlers can populate `issues[]` for structured field-level diagnostics.
  - **`core/assets/asset-union.json` added** (adcp#3462). Canonical home for the asset-variant `oneOf` union that previously inlined into `creative-asset.json` and `creative-manifest.json`. The spec-side change is byte-identical to the prior inline shape. SDK codegen still emits the `VASTAsset1` / `DAASTAsset1` / `BriefAsset1` / `CatalogAsset1` numbered duplicates; converging the codegen pipeline onto the canonical `$ref` is tracked separately and not blocked by this bump.
  - **`manifest.json` + `manifest.schema.json` published** (adcp#3738 — closes adcp#3725). New `/schemas/{version}/manifest.json` artifact carries 57 tools (with `protocol`, `mutating`, request/response schema refs, async response schemas, specialism mappings) and 45 error codes (`recovery`, `description`, `suggestion`, `default_unknown_recovery: "transient"` policy block). The `tools/list` MCP-exposed count is 51 — manifest covers tmp/protocol/compliance tools the SDK doesn't surface there. `enums/error-code.json` gains a structured `enumMetadata` block alongside the existing `enumDescriptions` prose. SDK consumption is tracked in #1192; this bump makes the artifact available for the codegen rewire to start.
  - **`AUTH_REQUIRED` prose tightened** (3.0.4, prose-only backport of adcp#3739). The wire code stays `AUTH_REQUIRED` with `recovery: correctable` — the 3.0.x line cannot add the `AUTH_MISSING` / `AUTH_INVALID` enum split — but the description and `enumMetadata.suggestion` now spell out the two operational sub-cases (credentials missing vs. credentials presented but rejected) and the SHOULD-NOT-auto-retry rule for the rejected case. The `BuyerRetryPolicy` callout in `skills/call-adcp-agent/SKILL.md` follows. Issue #1193 stays open against the structural 3.1 split.
  - **Storyboard `provides_state_for` field** (3.0.3 — adcp#3734). Spec-side field is now in the compliance cache (`compliance/cache/3.0.4/universal/storyboard-schema.yaml`). The SDK runner does not yet consume it — `sales-social` explicit-mode platforms continue to grade against the generic cascade-skip path until runner support lands. Tracked in #1267.
  - **`url_type` channel-doc cleanup** (3.0.3 step 1 + 3.0.4 step 2 — adcp#2986 / adcp#3671). Replaces invalid `"url_type": "tracker"` with `"tracker_pixel"` and adds role-based fallback. Wire enum was already correct; this aligns the prose.
  - **Compliance fixes** (3.0.4): audience-sync `discover_account` `stateful: false → true` (adcp#3710).

  Generated regen via `npm run sync-schemas`, `sync-version --force`, `generate-types`, `generate-wellknown-schemas`, `generate-agent-docs`. `tools/list` still 51, error codes 45 (was 28; `enumMetadata` exposed the full set), storyboards 63, test scenarios 24.

  Cosign verification: the regex in `scripts/sync-schemas.ts` now allows the `3.0.x` release branch alongside `main` and `2.6.x`, matching the upstream `release.yml` `on.push.branches` for the maintenance line.

  `COMPATIBLE_ADCP_VERSIONS` extended to include `3.0.2`, `3.0.3`, `3.0.4`.

- e170008: feat(server): BuyerAgentRegistry — Phase 1 Stage 1 (types + factories)

  Phase 1 Stage 1 of #1269: durable buyer-agent identity surface, ships in 3.0.x with no wire-emission.

  Adds `BuyerAgent`, `BuyerAgentRegistry`, `AdcpCredential`, `BuyerAgentStatus`, and `BuyerAgentBillingMode` exported from `@adcp/sdk/server`. Three factory functions encode the implementer posture at construction:
  - `BuyerAgentRegistry.signingOnly({ resolveByAgentUrl })` — production target. Bearer/API-key/OAuth credentials resolve to `null`; only `kind: 'http_sig'` credentials route through `resolveByAgentUrl`.
  - `BuyerAgentRegistry.bearerOnly({ resolveByCredential })` — pre-trust beta. All credentials route through the adopter's mapping; signed credentials are not pre-filtered.
  - `BuyerAgentRegistry.mixed({ resolveByAgentUrl, resolveByCredential })` — transition posture. `kind: 'http_sig'` routes to `resolveByAgentUrl`; bearer/OAuth/api-key routes to `resolveByCredential`. Signed path is preferred when both are present.

  `BuyerAgent` carries `readonly` fields for `agent_url`, `display_name`, `status`, set-valued `billing_capabilities`, optional `default_account_terms`, optional `allowed_brands`, and optional `aliases` (rotation grace-period reservation, no special framework behavior in v1).

  This stage adds the types and factory functions only. Framework integration (resolve seam, `ctx.agent` threading), the `ResolvedAuthInfo` migration shim, status enforcement, multi-credential conflict resolution, credential redaction, and the caching decorator land in subsequent stages of #1269.

  Phase 2 (#1292) — framework-level `billing_capability` enforcement and emission of the `BILLING_NOT_PERMITTED_FOR_AGENT` / `BILLING_NOT_SUPPORTED` codes registered in adcontextprotocol/adcp#3831 — is gated on the SDK's 3.1 cutover.

- 33f2ff4: feat(server): BuyerAgentRegistry — Phase 1 Stage 2 (resolve seam + ctx threading)

  Phase 1 Stage 2 of #1269 — wires the `BuyerAgentRegistry` into the dispatcher between authentication and account resolution. The resolved `BuyerAgent` is threaded through `ctx.agent` to `resolveAccount`, `resolveAccountFromAuth`, `resolveSessionKey`, the v6 `RequestContext`, and the v6 `AccountStore.resolve` ctx.

  Strict opt-in: when `agentRegistry` is unset on `AdcpServerConfig` (or `DecisioningPlatform.agentRegistry` for v6 adopters), `ctx.agent` stays `undefined` and the framework's request flow is unchanged.

  Behavior:
  - Registry returns a `BuyerAgent` → framework freezes the record (and its `billing_capabilities` Set's own properties) and sets `ctx.agent`. Note: `Object.freeze` on a `Set` does NOT protect the internal `[[SetData]]` slot — `.add()` / `.delete()` / `.clear()` still mutate. `ReadonlySet` is a TypeScript-only contract; adopters MUST NOT rely on freeze preventing membership changes at runtime.
  - Registry returns `null` → `ctx.agent` stays undefined; dispatch continues. Status enforcement (`suspended` / `blocked`) and per-agent billing rejection are Stage 4 / Phase 2 (#1292) work.
  - Registry throws → framework returns `SERVICE_UNAVAILABLE`. Inner error logged server-side.

  The resolve seam runs **before** account resolution and the idempotency-key shape gate, so:
  - `resolveAccount(ref, { agent })` and `resolveAccountFromAuth({ agent })` see the resolved buyer agent.
  - `accounts.resolve(ref, { agent })` on the v6 `AccountStore` receives it through `ResolveContext.agent`.
  - `resolveSessionKey({ agent })` sees it.
  - The v6 `RequestContext.agent` is populated for specialism handlers via `buildRequestContext`.

  Stage 3 will populate `ResolvedAuthInfo.credential` (kind-discriminated variant) so the factory functions (`signingOnly` / `bearerOnly` / `mixed` from Stage 1) actually route. Until then, the seam is structurally present but factories return `null` for `credential === undefined`, so Stage 2 alone is functionally inert for adopters who haven't synthesized credentials themselves.

- 0ea8127: feat(server): BuyerAgentRegistry — Phase 1 Stage 3 (credential synthesis + ResolvedAuthInfo migration)

  Phase 1 Stage 3 of #1269 — wires the kind-discriminated `AdcpCredential` from Stage 1 through the auth pipeline so `BuyerAgentRegistry` factory functions actually route on real credentials.

  **Authenticators stamp `credential` on `AuthPrincipal`:**
  - `verifyApiKey` → `{ kind: 'api_key', key_id: token }` (preserves an adopter-provided credential when present)
  - `verifyBearer` → `{ kind: 'oauth', client_id, scopes, expires_at }`
  - `verifySignatureAsAuthenticator` → `{ kind: 'http_sig', keyid, agent_url, verified_at }` when the verifier resolved an `agent_url` from the keyid; otherwise omitted

  `serve.ts:attachAuthInfo` propagates `credential` into `info.extra.credential` so it round-trips through MCP's `AuthInfo` shape. The dispatcher hoists `extra.credential` onto top-level `ctx.authInfo.credential` and passes it to `agentRegistry.resolve` — `signingOnly`, `bearerOnly`, and `mixed` factories now route on actual credentials instead of returning `null` for every request.

  **`ResolvedAuthInfo` migration shim** — additive, two-minor cycle:
  - N (this release): `credential?: AdcpCredential`, `agent_url?: string` (informational, post-resolution), `operator?: string` added alongside legacy `token` / `clientId` / `scopes`. Legacy fields tagged `@deprecated` in JSDoc; framework continues to populate them for adopter compatibility.
  - N+1: framework warns once per process when adopter `authenticate` returns the legacy shape without `credential`.
  - N+2: legacy fields removed.

  Adopters with custom `authenticate` callbacks can stamp `credential` directly on the returned `AuthPrincipal` to opt in. Custom callbacks that don't migrate see `BuyerAgentRegistry.resolve` return `null` (no credential = no known agent) — preserving the strict-opt-in invariant from Stage 2.

  When `BuyerAgentRegistry` resolves an agent, the framework also stamps the informational top-level `ctx.authInfo.agent_url` so adopters reading it see the registry's canonical view. Security-relevant decisions MUST still read from `credential.agent_url` (verified, `http_sig`-only) — the top-level field is informational per the spec semantics in adcontextprotocol/adcp#3831.

  `HandlerContext.authInfo` (v5 surface) and `ResolveContext.authInfo` (v6) both extended with the new fields. v6 `RequestContext` does not expose `authInfo` directly — handlers see `ctx.account` and `ctx.agent`; per-request credential identity flows to `accounts.resolve` and registry resolution.

  9 new tests cover: each authenticator's credential synthesis (verifyApiKey static + dynamic + adopter-credential preservation); dispatcher hoist; live registry routing for signingOnly / bearerOnly / mixed; legacy shape continues to work without `credential`. Full suite: 7299 pass, 0 fail.

  Phase 2 (#1292) — framework-level billing-capability enforcement and AdCP-3.1 error-code emission — is still gated on the SDK's 3.1 cutover.

- 3e86313: feat(server): BuyerAgentRegistry — Phase 1 Stage 4 (status enforcement + credential redaction)

  Phase 1 Stage 4 of #1269. Wires the durable identity surface from Stages 1-3 into request gating + closes the credential-leak surface in error projections.

  **Status enforcement.** Resolved `BuyerAgent.status === 'suspended' | 'blocked'` triggers framework-level rejection on new requests:
  - `PERMISSION_DENIED` envelope with `error.details.scope: 'agent'` and `error.details.status: <status>`.
  - Status check runs in the dispatcher seam right after registry resolution, BEFORE `accounts.resolve` — no tenant lookup wasted on rejected requests.
  - `'active'` agents pass through unchanged.
  - `null` registry returns (unrecognized agent) do NOT trigger status enforcement — Phase 2 (#1292) handles per-agent billing rejection separately.

  In-flight protection: the seam runs once per synchronous request, not on `tasks_get` polls or background webhook deliveries. A task started under an `'active'` agent and continued after status flips to `'suspended'` is NOT retroactively cancelled. Sellers who need hard cutoff implement that in their platform method via `BuyerAgent.status` checks (the resolved record is on `ctx.agent`).

  **Credential pattern redaction.** New `redactCredentialPatterns(message)` helper (`@adcp/sdk/server/redact`, internal) scrubs known credential shapes from any string projected to `error.details.reason` on the wire. Applied to all six dispatcher sites where `err.message → details.reason`:
  - Buyer-agent registry resolution failures
  - `resolveAccount` failures
  - `resolveAccountFromAuth` failures
  - `resolveSessionKey` failures
  - Idempotency principal resolution failures
  - Tool handler throws

  Patterns scrubbed:
  - `Bearer <token>` headers
  - JSON-quoted credential fields: `"token":"..."`, `"client_secret":"..."`, etc.
  - Unquoted credential fields: `token=...`, `client_id: ...`, `key=...`, etc.
  - Long token-shaped strings (≥ 32 chars of base64/hex/url-safe, word-bounded)

  The redactor is conservative — false positives (legitimate IDs that match a pattern) get redacted; false negatives are minimized. Adopters who need the unredacted error log it server-side; production-default `exposeErrorDetails: false` already gates the wire path.

  13 new tests across status enforcement (active passes, suspended/blocked rejected with structured details, runs before accounts.resolve, null doesn't trigger), redactor unit tests (Bearer headers, labeled patterns, JSON-quoted shapes, long-token detection, prose preserved, edge cases), and registry-throw / handler-throw end-to-end redaction. Full suite: 7353 pass, 0 fail.

  Phase 2 (#1292) — framework-level billing-capability enforcement and the AdCP-3.1 error-code emission — is still gated on the SDK's 3.1 cutover.

- 9847387: feat(server): BuyerAgentRegistry — Phase 1 Stage 5 (caching decorator)

  Phase 1 Stage 5 of #1269. Adds `BuyerAgentRegistry.cached(inner, options)` — a TTL-based caching decorator with concurrent-resolve coalescing and LRU eviction.

  **Usage:**

  ```ts
  const registry = BuyerAgentRegistry.cached(
    BuyerAgentRegistry.signingOnly({
      resolveByAgentUrl: async url => db.findBuyerAgent(url),
    }),
    { ttlSeconds: 60 }
  );
  ```

  **Properties:**
  - **TTL-bounded.** Successful resolutions cached for `ttlSeconds` (default 60). Negative cache (null returns) is OPT-IN via `cacheNullsTtlSeconds` (default 0 — freshly onboarded agents are recognized within one request).
  - **LRU-evicted.** Bounded to `maxSize` entries (default 10000). Map-iteration-order gives LRU-on-access for free; touch on hit re-inserts the entry as most-recent.
  - **Concurrent-resolve coalesced.** N parallel `resolve()` calls on the same credential produce ONE upstream invocation; subsequent callers await the in-flight promise.
  - **Per-kind cache keys.** Keys are namespaced (`http_sig:`, `api_key:`, `oauth:`) so a string colliding across credential kinds (e.g., an `agent_url` matching an `api_key.key_id` value) cannot leak an agent from one resolution path to another.
  - **Skips uncacheable inputs.** When `credential === undefined`, `resolve()` falls through to the inner registry on each call — adopters with custom auth that hasn't migrated to credential synthesis (Stage 3) see no behavior change.

  Mirrors the `AsyncCachingJwksResolver` over `JwksResolver` pattern already in `src/lib/signing/`.

  16 new tests cover: TTL hit/miss, expiration, null caching opt-in, pass-through for undefined credential, per-kind key isolation, concurrent-resolve coalescing (10 parallel resolves → 1 upstream call, all see same result reference), LRU eviction with touch-on-hit, option validation. Full suite: 7412 pass, 0 fail.

  This is the final stage of Phase 1's planned implementation. Phase 2 (#1292) — framework-level billing-capability enforcement and AdCP-3.1 error-code emission — remains gated on the SDK's 3.1 cutover.

- 7ebc3fe: feat(server): BuyerAgent.sandbox_only — defense-in-depth for test-only agents

  Phase 1.5 of #1269 (proposed during review on PR #1320). Adds a `sandbox_only?: boolean` field to `BuyerAgent` plus a framework-level gate.

  When `sandbox_only === true`, the framework rejects any request whose resolved `Account.sandbox !== true` with `PERMISSION_DENIED`, `error.details.scope: 'agent'`, `error.details.reason: 'sandbox-only'`, `recovery: 'terminal'`. Composes naturally with `Account.sandbox` from #1256 — same axis at the agent level.

  **When to use it.** CI runners, internal QA agents, partner pre-prod environments. If the test agent's credential leaks, blast radius is bounded to sandbox accounts. Production agents leave the field unset (or `false`).

  **Gate placement.** Runs after `accounts.resolve` so the framework can compare `agent.sandbox_only` against `account.sandbox`. Runs after Stage 4's status enforcement, so a suspended sandbox-only agent fails with status (not sandbox). Account-less tools (`provide_performance_feedback`, `list_creative_formats`, etc.) pass the gate — the sandbox/production axis doesn't apply when there's no account in scope.

  New tests cover: sandbox→sandbox succeeds, sandbox→prod rejected with structured envelope (and the explicit `sandbox: false` variant rejecting the same way as unset), undefined/false `sandbox_only` permissive on both account types (production-agent-on-prod-account explicit), account-less tools pass, status enforcement fires before sandbox-only enforcement, null registry result skips the gate. Full suite green.

  Phase 2 (#1292) — framework-level billing-capability enforcement and AdCP-3.1 error-code emission — is still gated on the SDK's 3.1 cutover.

- f951b0f: feat(server): compile-time invariant for complyTest / compliance_testing pairing

  Adds two mechanisms that catch the cap/adapter mismatch earlier than runtime:
  - `RequiredOptsFor<P>` — conditional type on `createAdcpServerFromPlatform`'s
    `opts` parameter. When `P` carries a non-optional `compliance_testing` block
    (e.g. from `definePlatformWithCompliance`), `complyTest` becomes required in
    opts at compile time. Previously both directions were runtime-only
    `PlatformConfigError` throws that were invisible to the harness.
  - `definePlatformWithCompliance<TConfig, TCtxMeta>()` — identity helper (same
    pattern as `defineSalesPlatform` etc.) that enforces `capabilities.compliance_testing`
    non-optional at the platform definition site. Pairing it with
    `createAdcpServerFromPlatform` gives full bidirectional enforcement without
    any API changes to existing call sites.

  The runtime check (`PlatformConfigError`) is preserved as defense-in-depth for
  untyped callers.

  Closes #1261

- 0016696: Added `composeMethod` for wrapping individual `DecisioningPlatform` methods with `before` / `after` hooks. Closes #1314.

  Use to layer short-circuit + enrichment patterns on a typed platform without re-typing every method by hand:

  ```ts
  import { composeMethod } from '@adcp/sdk/server';

  const wrapped = {
    ...basePlatform,
    sales: {
      ...basePlatform.sales,
      getMediaBuyDelivery: composeMethod(basePlatform.sales.getMediaBuyDelivery, {
        // Short-circuit: skip the inner platform call on price-optimization paths.
        before: async params => (params.optimization === 'price' ? { shortCircuit: cachedPriceOpt } : undefined),
        // Enrich: decorate the response before it hits response-schema validation.
        after: async result => ({
          ...result,
          ext: { ...result.ext, carbon_grams_per_impression: await score(result) },
        }),
      }),
      getProducts: composeMethod(basePlatform.sales.getProducts, {
        after: async result => mergeBrandManifest(result, await brandCache.get()),
      }),
    },
  };
  createAdcpServerFromPlatform(wrapped, opts);
  ```

  Semantics:
  - `before` returning `undefined` (or no return) falls through to the wrapped method. Returning `{ shortCircuit: value }` short-circuits.
  - `after` runs on the result whether it came from the inner method or from a `before` short-circuit, with the original `params` and `ctx` available.
  - `after` runs BEFORE response-schema validation. Decorations must satisfy the wire schema — vendor-specific data belongs under `ext` (the spec's typed extension surface).
  - `composeMethod` validates `inner` at wrap time, so referencing an optional method that wasn't implemented on the platform throws at module load rather than at first traffic.

  The discriminated `{ shortCircuit: T } | undefined` wrapper avoids the `undefined`-as-sentinel footgun: adopters who omit the wrapper and return a bare value get a TypeScript error rather than silent short-circuit-with-undefined behavior at runtime.

  Surfaced from the storefront-platform port in `scope3data/agentic-adapters#237`, which had to defer `getMediaBuyDelivery` price-optimization early-return + carbon enrichment and `getProducts` brand-manifest cache merging on the v6 path.

- cddfbf4: `createTenantStore<TTenant, TCtxMeta>` — opinionated `AccountStore` builder for multi-tenant adapters. Closes the last library-side item tracked in #1387.

  Canonicalizes the two-path resolution shape every multi-tenant adapter writes by hand (operator-routed for tools that carry `account` on the wire; auth-derived for no-account tools like `get_brand_identity` / `get_rights`) AND bakes in the per-entry tenant-isolation gate that adopters historically had to write — and silently fail to write — on `accounts.upsert` / `accounts.syncGovernance`.

  ```ts
  const accounts = createTenantStore<TenantState, TenantMeta>({
    resolveByRef(ref)                       => TenantState | null,  // wire ref → tenant
    resolveFromAuth(ctx)                    => TenantState | null,  // auth principal → tenant
    tenantId(tenant)                        => string,              // stable id for equality
    tenantToAccount(tenant, ref, ctx)       => Account<TenantMeta>, // sandbox lives here
    upsertRow?(tenant, ref, ctx)            => SyncAccountsResultRow,
    syncGovernanceRow?(tenant, entry, ctx)  => SyncGovernanceResponseRow,
  });
  ```

  The helper produces a regular `AccountStore<TCtxMeta>`. `accounts.list` / `accounts.reportUsage` / `accounts.getAccountFinancials` are NOT generated — those tools have shapes (cursor pagination; per-row account refs spanning multiple tenants) that don't fit the per-entry-then-row pattern. Adopters who claim those capabilities wire them on top of the returned store.

  **Security: the per-entry gate is built in, not opt-in.** On `upsert` / `syncGovernance`, the helper resolves the auth principal's tenant once via `resolveFromAuth(ctx)`, then for each entry resolves the entry's tenant via `resolveByRef(ref)`. Entries whose tenant differs (or whose tenant ref is unknown) are emitted as `'failed'` rows with `code: 'PERMISSION_DENIED'` (cross-tenant) or `code: 'ACCOUNT_NOT_FOUND'` (unknown ref) BEFORE invoking the adopter's `upsertRow` / `syncGovernanceRow` callbacks. **Cross-tenant entries never reach adopter code.** Fail-closed when `resolveFromAuth` returns null: every entry fails `PERMISSION_DENIED` regardless of operator. The original B1 finding from the multi-tenant adapter's security review (where adopters routing by wire-supplied operator without cross-checking the auth principal could write across tenants) is now mitigated by the SDK, not by adopter discipline.

  **Sandbox routing lives in `tenantToAccount`.** `AccountReference.sandbox?: boolean` flows through to the projector, where adopters either (a) flag the resolved Account so per-handler code routes reads/writes to a sandbox backend, or (b) resolve to a separate sandbox tenant via `resolveByRef(ref)` reading `ref.sandbox`. No new `sandbox?` parameter on the helper API — the projector subsumes both patterns.

  **Gate methods are non-writable.** `accounts.upsert` and `accounts.syncGovernance` on the returned store are defined with `writable: false` so an adopter who writes `accounts.upsert = customHandler` after construction gets a `TypeError` in strict mode instead of silently bypassing the tenant gate. To extend the store with `list` / `reportUsage` / `getAccountFinancials`, use `Object.assign(createTenantStore({...}), { list: ... })` rather than direct mutation. (Adopters who genuinely need a custom `upsert` should write a plain `AccountStore` and own the security surface — the helper's invariant is "use it or don't.")

  **Per-entry callbacks run sequentially**, not via `Promise.all`. Adopter `upsertRow` / `syncGovernanceRow` callbacks commonly mutate shared tenant state (`tenant.accounts.set(...)`); the helper preserves the prior code's accidental sequential semantics rather than introducing concurrent invocations against the same tenant. Adopters who want parallel writes can fan out inside their callback against an upstream that tolerates it.

  **Behavioral drift vs the prior inlined adapter:** `INVALID_REQUEST` is no longer surfaced for malformed refs (operator/brand missing) — wire schema validation upstream catches this before the adopter sees the request. The helper emits `ACCOUNT_NOT_FOUND` for unknown refs that survive validation and `PERMISSION_DENIED` for cross-tenant entries.

  `examples/hello_seller_adapter_multi_tenant.ts` migrated to use the helper. The 200+ lines of inlined `accounts.resolve` / `upsert` / `syncGovernance` collapsed to a single `createTenantStore({...})` call. Cross-tenant attack still rejected with `PERMISSION_DENIED`; credentials still stripped from `sync_governance` echo (5.13's `toWireSyncGovernanceRow`). `skills/build-holdco-agent/SKILL.md` updated to lead with `createTenantStore`; the prior inlined-gate documentation is superseded.

- 2459665: `CreativeBuilderPlatform.listCreativeFormats?` and `CreativeAdServerPlatform.listCreativeFormats?` are now modeled on the typed v6 platform interfaces and dispatched through `buildCreativeHandlers`. Closes adcp-client#1324 — pre-fix, every `creative-template` / `creative-generative` / `creative-ad-server` adopter that owned a format catalog had to drop down to the v5 escape hatch (`opts.creative.listCreativeFormats`) because the typed-platform path didn't carry the surface.

  The dispatch is no-account: the framework calls `accounts.resolve(undefined)` for the request (the wire schema doesn't carry an `account` field), so the typed signature uses `NoAccountCtx<TCtxMeta>` (see the #1327 changeset) — adopters who read `ctx.account.ctx_metadata` get a compile-time error and must narrow.

  Adopters who delegate format definitions via `capabilities.creative_agents` continue to omit the method; the framework returns `UNSUPPORTED_FEATURE` to buyers, same as before.

- 3efacca: feat(cli+harness): `adcp mock-server sales-guaranteed` — fourth specialism (GAM-flavored, IO approval state machine + CAPI for delivery validation)

  Adds the fourth and final mock-server in the matrix v2 family. Stresses two SDK surfaces the existing mocks don't cover:
  1. **Multi-step approval state machine.** Orders progress through `draft → pending_approval → approved → delivering → completed` via an async IO-signing task (`POST /orders` returns `pending_approval` + `approval_task_id`; buyer polls `/tasks/{id}` or `/orders/{id}` until human review completes). The mock auto-promotes `submitted → working → completed` over two polls so adapters exercise the polling pattern without dragging the matrix run. State transitions are monotonic — invalid transitions return `422 invalid_state_transition`.
  2. **CAPI for delivery validation, not audience activation.** Distinct from sales-social's CAPI which ingests conversion events for targeting. Here CAPI ingests delivery measurements (impressions, clicks, viewable %, video completions, conversions) that the publisher uses to validate billing. Different flow, different semantics. Conversions are deduped by `dedup_key` per order.

  Plus: **inventory-list targeting** (publisher-defined ad units the buyer can target by id), **delivery reporting** (synthesized totals from order state), **line-item lifecycle** (pending_creatives → ready → delivering on creative attach + order approval).

  Multi-tenancy via header (`X-Network-Code`) — matches GAM's network-id pattern. Distinct from sales-social's path-based scoping.

  The fixture covers most of what the `sales_guaranteed` storyboard exercises: products, orders, line items, creatives, delivery reporting, conversions, async approval tasks. Out-of-scope (handled adapter-side, not in upstream): measurement_terms_rejected, inventory_list_no_match (those are AdCP error-shape tests, not upstream API tests).

  Run with:

  ```bash
  npx @adcp/sdk mock-server sales-guaranteed --port 4503
  # or as part of the skill-matrix:
  npm run compliance:skill-matrix -- --filter sales_guaranteed
  ```

  **12 new smoke tests** in `test/lib/mock-server/sales-guaranteed.test.js` cover Bearer + X-Network-Code gating, inventory + product listing with filtering, full order approval flow (create → poll task → state transitions), line item creation, idempotency conflict on body mismatch, delivery report synthesis, CAPI conversion ingestion + dedup_key dedup.

  After this lands, matrix v2 has full coverage of the major upstream-shape patterns:

  | Pattern                                | Tested by                                                  |
  | -------------------------------------- | ---------------------------------------------------------- |
  | API key Bearer                         | signals, creative-template, sales-guaranteed               |
  | OAuth 2.0 client_credentials + refresh | sales-social                                               |
  | Multi-tenant via header                | signals (X-Operator-Id), sales-guaranteed (X-Network-Code) |
  | Multi-tenant via path                  | creative-template, sales-social                            |
  | Sync API                               | signals                                                    |
  | Async polling lifecycle                | creative-template (renders), sales-guaranteed (orders)     |
  | Hashed-PII upload (sync_audiences)     | sales-social                                               |
  | CAPI for audience activation           | sales-social                                               |
  | CAPI for delivery validation           | sales-guaranteed                                           |
  | Catalog sync (sync_catalogs)           | sales-social                                               |
  | Multi-step approval state machine      | sales-guaranteed                                           |
  | Inventory-list targeting               | sales-guaranteed                                           |

  Refs adcontextprotocol/adcp-client#1155.

- acc8868: feat(cli+harness): `adcp mock-server sales-social` — third specialism (TikTok-flavored, OAuth + sync_audiences + CAPI)

  Adds the third mock-server in the matrix v2 family. Stresses three SDK surfaces the existing mocks (signal-marketplace, creative-template) don't touch:
  1. **OAuth 2.0 client_credentials with refresh-token rotation.** Adapters exchange `client_id` + `client_secret` for an `access_token` at `POST /oauth/token`, attach the bearer on every API call, and refresh via the same endpoint with `grant_type=refresh_token` when the token expires. Refresh tokens rotate on use (single-use). This is the first matrix-v2 test of the SDK's OAuth code path that shipped in 5.9.0.
  2. **Hashed-PII audience uploads.** Custom audiences accept members as SHA-256-hashed lowercase identifiers (`hashed_email_sha256`, `hashed_phone_sha256`, etc.). Uploading raw PII or wrong-cased hex is rejected with `400 invalid_hash_format`. Mirrors how Meta Custom Audiences, TikTok DMP, LinkedIn Matched Audiences all work.
  3. **CAPI / Conversion API event ingestion.** Server-to-server conversion events arrive at `POST /event/track` with a hashed identifier (`email_sha256`, `phone_sha256`, or `external_id_sha256`) and event metadata. Events without a matchable identifier are dropped (counted in `events_dropped`); a batch of all-unmatchable events returns `400 no_matchable_events`.

  Plus the supporting upstream surface required by the `sales_social` storyboard:
  - Advertiser profile (`GET /v1.3/advertiser/{id}/info`)
  - Catalog CRUD + bulk upload (sync_catalogs mapping)
  - Creative portfolio CRUD (sync_creatives mapping)
  - Pixel CRUD (sync_event_sources mapping)

  **Multi-tenancy via path** (`/v1.3/advertiser/{advertiser_id}/...`). Two seeded advertisers with overlapping access. Single OAuth client authorized for both — matches the standard walled-garden model where one app credential serves multiple seats.

  **Refactor**: `MockServerHandle.apiKey: string` is replaced by a polymorphic `MockServerHandle.auth: MockServerAuth` discriminated union (`{ kind: 'static_bearer', apiKey } | { kind: 'oauth_client_credentials', clientId, clientSecret, tokenPath }`). The matrix harness branches on `auth.kind` when building the adapter prompt — different flows produce different adapter wiring.

  Run with:

  ```bash
  npx @adcp/sdk mock-server sales-social --port 4502
  # or as part of the skill-matrix:
  npm run compliance:skill-matrix -- --filter sales_social
  ```

  **21 new smoke tests** in `test/lib/mock-server/sales-social.test.js` cover OAuth handshake (success, bad client_secret, refresh-token rotation, old-token-invalidation), bearer-required API gating, audience create + hashed-PII upload + raw-PII rejection + idempotency conflict, CAPI event ingest with matchable/unmatchable identifiers + unknown pixel, catalog + creative flows, and the unified principal-mapping handle shape.

  Refs adcontextprotocol/adcp-client#1155.

- 6967470: feat(storyboard): `field_contains` validation check — closes adcontextprotocol/adcp#3803 item 2

  Adds a wildcard-aware membership check to the storyboard validator. `path` may include `[*]` segments (resolved via the existing `resolvePathAll`), and the check passes when ANY resolved value matches `value` or any of `allowed_values`.

  Lets storyboards write:

  ```yaml
  - check: field_contains
    path: creatives[0].errors[*].code
    value: PROVENANCE_VERIFIER_NOT_ACCEPTED
  ```

  instead of the brittle positional form `creatives[0].errors[0].code value: PROVENANCE_VERIFIER_NOT_ACCEPTED`, which breaks when a future seller emits multiple errors per creative or reorders the cascade. When the path has no wildcard segments the check reduces to scalar equality.

  Symmetric to `field_value` for missing-value/missing-path errors and JSON pointer emission. 8 new test cases in `test/lib/storyboard-validations.test.js`.

- a8cd3a5: feat(server): enforce documented `accounts.resolution: 'implicit'` refusal of inline `account_id` references. Previously aspirational — the docstring at `AccountStore.resolution` claimed the framework would refuse, but enforcement wasn't wired. The framework now emits `AdcpError('INVALID_REQUEST', { field: 'account.account_id' })` before reaching the adopter's `accounts.resolve` when an `'implicit'`-resolution platform receives an `{ account_id: ... }` reference. The brand+operator union arm is permitted (used during the initial `sync_accounts` flow). Adopters no longer need to reimplement the same `if (ref?.account_id) return null` branch in every Shape A platform.

  Same change additionally improves the dispatcher's `resolveAccount` / `resolveAccountFromAuth` error projection: thrown `AdcpError` instances now propagate verbatim to the wire envelope (matching the existing tool-handler unwrap), instead of being coerced to `SERVICE_UNAVAILABLE`. Generic exceptions still map to `SERVICE_UNAVAILABLE` to keep upstream-leak protection intact. Closes #1364.

- 6f5d616: Add `InMemoryImplicitAccountStore` reference adapter for `resolution: 'implicit'` platforms. Closes #1340 (partial — Postgres adapter and storyboard phases deferred; see issue for remaining scope).

  Platforms where buyers call `sync_accounts` before any tool no longer need to hand-roll the `authPrincipal → accounts` map. `InMemoryImplicitAccountStore` implements both `upsert()` and `resolve()` with a configurable `keyFn` (defaults to `credential.client_id` / `credential.key_id` / `credential.agent_url`) and a configurable `ttlMs` (default 24h).

  Also ships:
  - `docs/guides/account-resolution.md` — key-derivation rationale, `ACCOUNT_NOT_FOUND` vs `AUTH_REQUIRED` error contract, TTL guidance for durable stores
  - `examples/decisioning-platform-implicit-accounts.ts` — runnable wiring example
  - Fix deprecated `authInfo.clientId` reference in `AccountStore.resolve()` JSDoc (use `credential.client_id` / `credential.key_id`)

- 8737300: feat(server): `instructions` accepts a function form (lazy / per-session)

  `createAdcpServer` and `DecisioningPlatform.instructions` now accept either a static `string` (the historical form) or a `(ctx: SessionContext) => string | undefined` function. Under the canonical `serve({ reuseAgent: false })` flow (the default) the factory runs per HTTP request, so the function fires per session — adopters can surface tenant-shaped prose (per-buyer brand manifests, storefront-platform copy, "premium vs standard" partner guidance) without hand-rolling a `Map` shim outside the SDK.

  Closes #1347.

  **Surface:**

  ```ts
  import { createAdcpServer, type SessionContext, type OnInstructionsError } from '@adcp/sdk/server';

  createAdcpServer({
    // existing string form still works
    instructions: 'Publisher-wide brand safety: alcohol disallowed.',

    // or function form — re-evaluated per createAdcpServer invocation
    instructions: (ctx: SessionContext) => brandManifests.get(currentTenant)?.intro,

    // throw semantics — default 'skip' (best-effort prose; throws resolve to no instructions)
    onInstructionsError: 'skip', // or 'fail' (rethrow → MCP initialize transport-level failure)
  });
  ```

  **Three guardrails:**
  1. **`reuseAgent: true` + function-form is refused.** The function would only fire once for the lifetime of the shared agent — silently degrading to "instructions are a constant after all" is worse than failing loud. `serve()` returns 500 with a message naming the workaround (drop `reuseAgent: true` or pass a static string).
  2. **Async return is not yet supported.** A function returning a `Promise` throws `ConfigurationError` at construction; pre-resolve before invoking `createAdcpServer` if you need to fetch.
  3. **`SessionContext` is reserved.** `authInfo` and `agent` are typed for forward compatibility but currently always `undefined` — the framework does not yet plumb auth/registry state into the factory before MCP `initialize`. Use closures captured in your factory's HTTP-scoped state for tenant identity today; the function body picks up populated fields when the framework wires them through.

  **Throw semantics:**
  - `'skip'` (default) — log server-side, treat as `undefined` (no instructions). Right for prose-of-flavor (brand manifests, marketing copy) where a registry fetch failure must not kill the buyer's session.
  - `'fail'` — rethrow. The MCP `initialize` handshake then fails at the transport layer (this is NOT an `adcp_error` envelope — it kills the session). Right for adopters whose instructions carry load-bearing policy where stale/missing guidance is worse than a connection retry.

  **New exports** from `@adcp/sdk/server`:
  - `SessionContext` — slim `{ authInfo?, agent? }`, both reserved for now.
  - `OnInstructionsError` — `'skip' | 'fail'`.
  - `ADCP_INSTRUCTIONS_FN` — symbol marker `serve()` reads to refuse the `reuseAgent: true` combination.

  Plumbed through `DecisioningPlatform.instructions` (v6 surface) and `createAdcpServer.instructions` (v5 escape hatch); platform wins when both are set, same precedence pattern as `agentRegistry`.

- dda2a77: `createMediaBuyStore` + `mediaBuyStore` option — opt-in framework support for the `packages[].targeting_overlay` echo contract on `get_media_buys`.

  Per `schemas/cache/3.0.5/media-buy/get-media-buys-response.json`, sellers SHOULD echo persisted targeting overlays so buyers can verify what was stored without replaying their own request. Sellers claiming `property-lists` or `collection-lists` MUST include the persisted `PropertyListReference` / `CollectionListReference` inside the echoed `targeting_overlay`. Pre-this-release, satisfying the contract meant every adapter persisted + merged + echoed by hand — `examples/hello_seller_adapter_guaranteed.ts` shipped without the wiring and any fork inherited a silent storyboard failure on `media_buy_seller/inventory_list_targeting/get_after_create`.

  ```ts
  import { createAdcpServerFromPlatform, createMediaBuyStore, InMemoryStateStore } from '@adcp/sdk/server';

  const stateStore = new InMemoryStateStore();

  createAdcpServerFromPlatform(myPlatform, {
    mediaBuyStore: createMediaBuyStore({ store: stateStore }),
  });
  ```

  When wired, the framework:
  - Persists `packages[].targeting_overlay` from `create_media_buy` requests, joined with the seller-assigned `package_id` (or `buyer_ref` when supplied). Persistence runs in the createMediaBuy projection, so it covers both the sync arm and the HITL completion arm.
  - On `get_media_buys`, backfills missing `packages[].targeting_overlay` from the store. Packages the seller already echoed are left untouched.
  - On `update_media_buy`, deep-merges the patched overlay against the prior persisted overlay: omitted keys keep prior, non-null values replace, explicit `null` clears. `new_packages[]` are persisted as fresh entries.

  Backed by any `AdcpStateStore` — `InMemoryStateStore` for development, `PostgresStateStore` for production. Account-scoped per-tenant via `scopedStore`. Failures are logged + swallowed: a successful seller response is never turned into an error by the auto-echo plumbing.

  `hello_seller_adapter_guaranteed.ts` now wires `mediaBuyStore` by default — every fork inherits the echo contract for free.

  Removes four stale `UPSTREAM_SCHEMA_DRIFT` suppressors in `test/lib/storyboard-drift.test.js`. The cited `adcontextprotocol/adcp#2488` was resolved by the AdCP 3.0 GA schema update — `PackageStatus.targeting_overlay` is present on the wire response shape, so the storyboard assertions are now valid and the SDK is positioned to satisfy them.

  Closes #1415.

- 048716a: Add `mintEphemeralEd25519Key()` to `@adcp/sdk/signing/testing`.

  Exports `mintEphemeralEd25519Key(opts?)` and `EphemeralEd25519Key` from
  `@adcp/sdk/signing/testing`. The helper generates an ephemeral Ed25519
  keypair and returns both halves as fully-shaped `AdcpJsonWebKey` values
  (with `kid`, `alg: 'EdDSA'`, `use: 'sig'`, `adcp_use`, and `key_ops` set
  correctly) — eliminating the manual Node `JsonWebKey.kty?: string` →
  `AdcpJsonWebKey.kty: string` reshape that every dev/test agent had to write
  by hand. Defaults to `adcp_use: 'webhook-signing'`; pass
  `{ adcp_use: 'request-signing' }` for buyer-to-seller test keys.

  Also fixes a dangling `testJwk` reference in `SIGNING-GUIDE.md` §Testing
  that left callers without a concrete key-generation example.

- 2459665: Tools whose wire request doesn't carry an `account` field — `preview_creative`, `list_creative_formats`, `provide_performance_feedback` — now use a new `NoAccountCtx<TCtxMeta>` request-context type whose `account` is `Account<TCtxMeta> | undefined`. Closes adcp-client#1327 — pre-fix, the typed handler signature claimed `ctx.account: Account<TCtxMeta>` (non-optional) while the framework dispatched these tools with `ctx.account === undefined` whenever `accounts.resolve(undefined)` returned null, producing runtime crashes (`Cannot read properties of undefined`) deep in adopter code. The narrow converts the runtime gate into a compile-time invariant — same shape as the `definePlatformWithCompliance` fix in #1262.

  Affected interfaces:
  - `CreativeBuilderPlatform.previewCreative?(req, ctx: NoAccountCtx<TCtxMeta>)`
  - `CreativeBuilderPlatform.listCreativeFormats?(req, ctx: NoAccountCtx<TCtxMeta>)` (new in #1324)
  - `CreativeAdServerPlatform.previewCreative(req, ctx: NoAccountCtx<TCtxMeta>)`
  - `CreativeAdServerPlatform.listCreativeFormats?(req, ctx: NoAccountCtx<TCtxMeta>)` (new in #1324)
  - `SalesPlatform.providePerformanceFeedback?(req, ctx: NoAccountCtx<TCtxMeta>)`
  - `SalesPlatform.listCreativeFormats?(req, ctx: NoAccountCtx<TCtxMeta>)`

  Migration for adopters: in handlers for these tools, narrow `ctx.account` before reading `ctx_metadata` / `id`. Three patterns:

  ```ts
  // 1. Singleton fallback — return a non-null Account from accounts.resolve(undefined).
  //    `ctx.account` is always defined; no narrow needed.

  // 2. Auth-derived lookup — accounts.resolve(undefined, ctx) reads ctx.authInfo.clientId.

  // 3. Defensive narrow inside the handler:
  previewCreative: async (req, ctx) => {
    if (ctx.account == null) {
      throw new AdcpError('ACCOUNT_NOT_FOUND', { recovery: 'correctable', message: '...' });
    }
    const ws = ctx.account.ctx_metadata.workspace_id;
    // ...
  };
  ```

  This is a TypeScript-level breaking change for adopters who were dereferencing `ctx.account` unconditionally — the runtime behavior is unchanged. Adopters of `'derived'`-resolution stores that always return a singleton are unaffected at runtime, but the compiler will now require the narrow.

- 00b52f3: feat(adapters): `createOAuthPassthroughResolver` — factory for the canonical "Shape B" `accounts.resolve` pattern. Standardizes the `extract bearer → GET /me/adaccounts → match by id → return tenant with ctx_metadata` flow that every adapter wrapping a vendor OAuth + ad-account API (Snap, Meta, TikTok, LinkedIn, Reddit, Pinterest, etc.) re-derives by hand. Composes with `createUpstreamHttpClient`'s `dynamic_bearer.getToken` for per-buyer credential injection. Configurable `idField`, `rowsPath`, `getAuthContext`, and opt-in TTL cache (auth-context keyed so different buyers don't share entries). Closes #1363.
- 69d93a3: Make `DecisioningCapabilities.creative_agents`, `channels`, and `pricingModels` optional. Signals-only platforms (`signal-marketplace`, `signal-owned`) sell audience data access, not media inventory — they don't compose with creative agents, don't sell media channels, and don't use channel-level pricing models. Forcing empty-array declarations was surprise friction for adopters building signals adapters.

  `validatePlatform` (called by `createAdcpServerFromPlatform`) now throws `PlatformConfigError` when any `sales-*` specialism is claimed and `channels` or `pricingModels` is absent — platforms that previously passed without these fields will fail at construction time.

- 217d43c: feat(testing): per-specialism storyboard routing — `runStoryboard({ agents })` (#1066)

  Storyboards that span specialisms (e.g. `sync_governance` then `activate_signal` in a `signal_marketplace/governance_denied` flow) can now route each step to the tenant that actually owns that tool, instead of fanning every step at one URL and relying on cross-tenant comply seeds. Maps directly to the prod test-agent topology (`/sales`, `/signals`, `/governance`, `/creative`, `/creative-builder`, `/brand`) and to local Hello-cluster setups.

  **API**:

  ```ts
  runStoryboard('', storyboard, {
    auth: { type: 'bearer', token: '...' },
    agents: {
      sales: { url: 'https://test-agent.adcontextprotocol.org/sales/mcp' },
      signals: { url: 'https://test-agent.adcontextprotocol.org/signals/mcp' },
      governance: { url: 'https://test-agent.adcontextprotocol.org/governance/mcp' },
    },
    default_agent: 'sales',
  });
  ```

  Per-step `agent: <key>` override for cross-domain tools (`sync_creatives`, `list_creative_formats`) when the same protocol is claimed by multiple tenants. Per-agent auth and transport overrides supported via `AgentEntry.auth` / `AgentEntry.transport`.

  **Routing**: tool → `TASK_FEATURE_MAP` → first protocol → unique agent in the map that claims it via `get_adcp_capabilities`. Multi-claim conflicts fail-fast at storyboard-build time **for affected steps lacking a `step.agent` override** — the override is the per-step disambiguator and resolves the conflict cleanly. Tools with no specialism mapping fall back to `default_agent`, or fail-fast as `unroutable_task` when no default is set.

  **Discovery**: parallel per-agent `get_adcp_capabilities` at storyboard start. Any tenant's discovery failure surfaces as a hard storyboard failure, not a per-step skip — a broken tenant in a multi-tenant flow is a topology bug, not a coverage gap.

  **CLI**: `adcp storyboard run --agents-map ./agents.yaml <storyboard_id>`. Repeatable `--agent <key>=<url>` for inline maps. `--default-agent <key>` for fallback. URL validation matches existing `--url` (HTTPS in prod, HTTP only with `--allow-http`).

  **Result shape**: new `StoryboardResult.agent_map?: Record<string, string>` echoes the resolved `key → url` so JUnit/CI consumers and bug reports show which agent served which tool. Per-step `agent_url` and `agent_index` are populated in routed mode (previously only in multi-instance replica mode).

  **Mutually exclusive** with `multi_instance_strategy` (replica round-robin, different concept), `_client` (single client cannot serve multiple agents), and a positional URL alongside the map (ambiguous routing intent). All three combinations throw at `runStoryboard()` entry.

  Closes #1066. Hello-cluster adapters for governance/creative/brand and a one-command cluster orchestrator are tracked separately as #1332/#1333/#1334/#1335.

- 194c1c9: feat(server): add `definePlatform` / `defineSalesPlatform` / `defineAudiencePlatform` (and one per remaining specialism) identity helpers

  Fixes the TypeScript contextual-typing gap that caused handler method parameters to
  resolve as `req: unknown` when a `DecisioningPlatform` (or sub-interface) was built as
  an object literal and passed directly to `createAdcpServerFromPlatform`.

  Root cause: `createAdcpServerFromPlatform<P extends DecisioningPlatform<any,any>>(platform: P & ...)`
  infers `P` from the argument rather than using the constraint for contextual typing, so
  nested method parameters (`req`, `ctx`) can't be contextually typed from the interface.

  The helpers are pure identity functions that force a concrete `DecisioningPlatform<TConfig, TCtxMeta>`
  (or per-specialism sub-interface) as the declared parameter type, giving TypeScript the
  annotation it needs:

  ```ts
  // Before — req: unknown, 16 manual casts
  createAdcpServerFromPlatform({
    sales: {
      syncEventSources: async (req, ctx) => {
        const sources = ((req as { event_sources?: unknown[] }).event_sources ?? [])...
      }
    }
  }, opts);

  // After — req: SyncEventSourcesRequest ✓, ctx.account.ctx_metadata: SocialMeta ✓
  createAdcpServerFromPlatform({
    sales: defineSalesPlatform<SocialMeta>({
      syncEventSources: async (req, ctx) => {
        const sources = req.event_sources ?? [];  // no cast
      }
    })
  }, opts);
  ```

  The class pattern with explicit property-type annotations (`sales: SalesPlatform<Meta> = {...}`)
  continues to work without any helper. The helpers are the object-literal escape hatch.

  Also fixes a misleading note in `skills/build-seller-agent/specialisms/sales-social.md` that
  described handler-bag grouping for the legacy `createAdcpServer` path, which steered LLM
  adopters toward `req: unknown` handlers instead of the typed platform interface. Replaced
  with the `createAdcpServerFromPlatform` method-mapping table.

- 0016696: `createAdcpServerFromPlatform` now threads server-level `instructions` to the underlying MCP server, surfacing it on the `initialize` response. Closes #1312.

  The new `DecisioningPlatform.instructions?: string` field is the v6 surface — declare platform facts, decision policy, and trends colocated with the rest of the platform definition. The pre-existing `opts.instructions` continues to work as the v5-style escape hatch; when both are set, `platform.instructions` wins (same precedence pattern as `agentRegistry`).

  ```ts
  const platform: DecisioningPlatform = {
    capabilities: { specialisms: ['sales-non-guaranteed'] /* ... */ },
    accounts: {
      /* ... */
    },
    sales: {
      /* ... */
    },
    instructions:
      'Publisher-wide brand safety: alcohol disallowed. ' +
      'Carbon-aware pricing applies to display impressions only. ' +
      'Weekly cutoff: Thursday 17:00 UTC.',
  };
  const server = createAdcpServerFromPlatform(platform, opts);
  ```

  Surfaced from the storefront-platform port in `scope3data/agentic-adapters#237`, which had to defer publishing v5 `instructions` on the v6 path.

- 353b99d: feat(runner): honor `provides_state_for` storyboard field with `peer_substituted` skip reason

  AdCP 3.0.3 (adcp#3734) introduced an optional `provides_state_for: <step_id> | <step_id>[]` field on storyboard steps, declaring that a stateful step's pass establishes equivalent state for the named peer step(s) in the same phase. When the rescue fires, the spec mandates that the rescued target be graded with `skip_reason: 'peer_substituted'` and the detail string `"<target_step_id> state provided by <phase_id>.<substitute_step_id>"` per `runner-output-contract.yaml`.

  The SDK already implemented the rescue mechanism in 6.4.1 (#1144) under the field name `peer_substitutes_for`. This change aligns with the spec:
  - **Type alias**: `provides_state_for` is now the canonical field on `StoryboardStep`. `peer_substitutes_for` is retained as a `@deprecated` synonym for one minor cycle so existing storyboards keep parsing. Both fields normalize at parse time; the runner reads `provides_state_for ?? peer_substitutes_for`.
  - **Loader validation**: works on whichever field is declared. If both are declared, the loader rejects mismatching values (the deprecation contract is "synonym for", not "additive with"). All same-phase / both-stateful / acyclic / no-self-reference rules apply identically.
  - **Skip reason**: new `peer_substituted` value on `RunnerSkipReason`, distinct from `peer_branch_taken` (branch-set routing) and `not_applicable` (coverage gap). Detail format matches the spec contract.
  - **Runner re-grading**: when a deferred `missing_tool` / `missing_test_controller` skip is rescued by a passing same-phase substitute, the runner re-grades the target's step result from the original hard-missing-state reason to `peer_substituted` with the spec detail string. Without this, the target kept its original `missing_tool` grade — misleading because state DID materialize via the substitute path.

  Closes #1267.

  Operational impact: `sales-social` explicit-mode platforms (Snap, Meta, TikTok) that pre-provision advertiser accounts out-of-band — and declare `provides_state_for: sync_accounts` on their `list_accounts` step per the 3.0.3 storyboard — graduate from `1/9/0` to `9/10` once their compliance cache refreshes against AdCP 3.0.3+.

- cfaaf67: Add `@adcp/sdk/mock-server` as a public sub-export.

  Adopters can now `import { bootMockServer } from '@adcp/sdk/mock-server'` for in-process integration tests, instead of spawning the published CLI as a child process or reaching into `dist/lib/mock-server/index.js`. Closes #1287.

  Same shape as the existing CLI: `bootMockServer({ specialism, port, apiKey? })` returns a `MockServerHandle` with `{ url, auth, close, summary, principalScope, principalMapping }`. Boots in-process so test harnesses can iterate on adapter integration without subprocess overhead.

  Examples in `docs/guides/VALIDATE-WITH-MOCK-FIXTURES.md` (when adcp#3826 lands) point at this for the test-side recipe.

- a45bec6: feat(server): `accounts.resolve` security presets — `requireAccountMatch`, `requireAdvertiserMatch`, `requireOrgScope`. Standardize the post-resolve authorization pattern multi-tenant adopters reach for ("the inner resolver found the account, but is the calling principal authorized for it?") so each adopter doesn't roll their own. Compose with `composeMethod` over `accounts.resolve`; default deny is `null` (avoids principal enumeration) with opt-in `onDeny: 'throw'` for `PermissionDeniedError`. Closes #1339.
- eda2648: Add `createRosterAccountStore` — Shape C `AccountStore` factory for `resolution: 'explicit'` publisher-curated platforms.

  Pairs with the existing reference adapters:
  - `InMemoryImplicitAccountStore` — Shape A, `resolution: 'implicit'`, buyer-driven write path via `sync_accounts`. Framework owns persistence.
  - `createOAuthPassthroughResolver` — Shape B, `resolution: 'explicit'`, returns just the `resolve` function for adapters fronting an upstream OAuth listing API (Snap, Meta, TikTok). Adopter composes into AccountStore.
  - `createRosterAccountStore` (new) — Shape C, `resolution: 'explicit'`, returns a complete AccountStore for adopters who own the roster (storefront table, admin-UI-managed JSON, in-memory map). The adopter keeps the persistence layer; the SDK provides the AccountStore plumbing.

  Replaces ~150 LOC of boilerplate per adopter (extract id from `AccountReference`, point-lookup, build `Account<TCtxMeta>`, optional list pagination, ctx threading) with a ~50 LOC factory. No persistence opinion — the adopter brings a `lookup(id, ctx)` function backed by whatever roster source they have (Postgres SELECT, Map, JSON column, file).

  ```ts
  import { createRosterAccountStore } from '@adcp/sdk/server';

  const accounts = createRosterAccountStore({
    lookup: async (id, ctx) => {
      const tenantId = deriveTenant(ctx?.authInfo);
      return await db.oneOrNone('SELECT * FROM storefront_accounts WHERE id = $1 AND tenant = $2', [id, tenantId]);
    },
    toAccount: row => ({
      id: row.id,
      name: row.name,
      status: row.status,
      ctx_metadata: { tenant: row.tenant, upstreamRef: row.upstream_ref },
    }),
    list: async (filter, ctx) => {
      const rows = await db.any(buildListQuery(filter, deriveTenant(ctx?.authInfo)));
      return { items: rows, nextCursor: nextCursorFor(rows, filter) };
    },
  });
  ```

  Design choices:
  - **Point-lookup, not roster getter.** Adopters with thousands of accounts per tenant in Postgres issue `SELECT WHERE id = $1` instead of materializing the full array on every request.
  - **`list` is opt-in.** Omit it and the framework emits `UNSUPPORTED_FEATURE` for `list_accounts` calls. Provide it and the adopter pushes filter+page down to whatever index they have — the helper does NOT post-filter.
  - **No `upsert` / `reportUsage` / `getAccountFinancials` / `refreshToken`.** Buyer-driven writes don't apply to publisher-curated rosters. Adopters who need those compose with a spread: `{ ...createRosterAccountStore(...), refreshToken: async (a) => { ... } }`.
  - **No ref-less hatch.** `accounts.resolve(undefined, ctx)` (called by `provide_performance_feedback`, `list_creative_formats`, `preview_creative`) returns `null` by default. The spec lists three legitimate paths for ref-less calls — singleton fallback, auth-derived lookup, error out — with structurally different return types. Rather than ship a hatch that picks one shape, the helper does id-arm dispatch only. Adopters who want a synth tenant or auth-derived lookup wrap `resolve` (the JSDoc shows both patterns); adopters who want the error-out path keep the default null return and narrow on `ctx.account === undefined`. Same "compose, don't extend" precedent as `createOAuthPassthroughResolver`.

- c446936: feat(storyboard): runner-output-contract v2.0.0 — forward-compat default, capture/substitution synthesized checks, `upstream_traffic` (adcp-client#1253, spec adcp#3816)

  Implements the runner-side of the unified anti-façade + cascade-attribution contract landing in the spec. Three additive features, all backwards-compatible for storyboards that don't opt in.

  **Forward-compat default for unknown check kinds.** When the runner encounters an authored `check` value it does not implement (e.g. a storyboard declares a check added in a later spec minor version), it now grades the validation as `passed: true, not_applicable: true` with a `note` describing the coverage gap, instead of failing the step with `Unknown validation check: …`. New per-run counter `validations_not_applicable` surfaces the count on `StoryboardResult`, `StoryboardPassResult`, and the compliance `summary` so dashboards can distinguish "runner is older than the storyboard" from clean passes. Independently valuable — unblocks any future additive check-type extension from breaking older runners.

  **`capture_path_not_resolvable` synthesized checks.** When a step's `context_outputs.path` resolves to absent, `null`, or `""`, the runner now synthesizes a failed `validation_result` on the _capturing_ step (check: `capture_path_not_resolvable`, `expected`: declared path, `actual`: resolved value, `json_pointer`: RFC 6901 form of the path). Previously the runner silently skipped the capture and the failure surfaced — confusingly — on the downstream consumer. Fixes the cascade-attribution gap from adcp#3796. `applyContextOutputsWithProvenance` now also returns the failures on `ContextWriteResult.failures` for callers using the lower-level surface.

  **`unresolved_substitution` synthesized checks.** When a downstream step is skipped because a `$context.<key>` token can't resolve, the skipped step's `validations[]` now carries an `unresolved_substitution` validation result per missing token (`expected`: the token string; `actual` / `json_pointer` / `request` / `response` all `null` because no request was sent). `skip_result.reason` remains `prerequisite_failed`. Lets dashboards attribute the cascade origin without parsing skip messages.

  **`upstream_traffic` check — load-bearing anti-façade contract.** New authored check that asserts side-effects against the adopter's `comply_test_controller`'s `query_upstream_traffic` scenario. Adopters who advertise the scenario in `list_scenarios` opt in; adopters who don't grade `not_applicable`. Adopters who do but observed zero recorded calls in the assertion window grade `failed` (the façade signal). Supports:
  - `min_count` — minimum matching calls.
  - `endpoint_pattern` — glob over `<METHOD> <URL>`.
  - `payload_must_contain` — array of `{path, match: present | equals | contains_any}`. JSONPath-lite (`foo.bar`, `users[*].hashed_email`) — RFC 9535 descendant operator (`$..foo`) is NOT supported per the spec's pin to `parsePathWithWildcards`. Per-call `content_type` gating: JSON payloads use path-based matching; non-JSON payloads fall back to substring-search-the-terminal-key for `match: present` and grade `not_applicable` for `match: equals` / `contains_any`. The whole assertion grades `not_applicable` only when EVERY declared path landed in the non-JSON-skip bucket.
  - `identifier_paths: string[]` — paths into the storyboard's `sample_request`. The runner extracts every value at each path and asserts ALL resolved values appear at any depth in some matched call's payload (single-placeholder fabrication is the threat). Replaces the earlier `buyer_identifier_echo` boolean shorthand the spec PR retracted.
  - `since: prior_step_id` — bounds the lookup window to traffic recorded since the named prior step's request start. Unknown step ids grade `failed` loudly (not silent fallback). Runner subtracts a 250 ms clock-skew tolerance before sending the bound to the controller (spec's recommended value, 50 ms minimum).

  The runner pre-fetches once per unique `since_timestamp` window so the synchronous validator stays sync. Validator helpers (`walkLitePath`, `containsValueAnyDepth`) are bounded against hostile / buggy `recorded_calls[].payload` — fan-out capped at 10 000 terminal values; recursion depth capped at 256. Controller-error strings inlined into `validation_result.error` truncate at 2 000 chars to match the runner's existing posture.

  **Surface details.** `ValidationResult` gains optional `not_applicable` and `note` fields. `StoryboardValidationCheck` gains `upstream_traffic`. `StoryboardValidation` gains `min_count` / `endpoint_pattern` / `payload_must_contain` / `identifier_paths` / `since` for upstream_traffic. `RecordedCall` gains required `content_type` (mirrors the spec). `ControllerScenario` gains `query_upstream_traffic`. New `isJsonContentType` helper + `RecordedCall` / `UpstreamTrafficSuccess` / `UpstreamTrafficQueryParams` types exported from `testing/test-controller`. `UpstreamTrafficPayloadMatch` exported from `testing/storyboard`. `ValidationContext` gains `upstreamTraffic` (with `unresolvedSinceRefs`) and `storyboardStep` fields populated by the runner's pre-fetch.

- bd3d98d: feat(mock-server, sales-guaranteed): forecast and availability endpoints (closes #1375)

  Adds `POST /v1/forecast` and `POST /v1/availability` to the sales-guaranteed mock so the worked adapter for guaranteed sellers exercises `Product.forecast` instead of returning the seed's static `availability` field. Real GAM/FreeWheel/Operative integrations spend most of their API time on forecast/availability calls; the prior mock surface was order/lineitem-only, so adopters who forked the example hit "where's the forecast call?" with no example to follow.

  **New endpoints**
  - `POST /v1/forecast` — per-query `DeliveryForecast` for one product. Returns `forecast_range_unit: 'availability'` when budget is omitted (the GAM availability check), `'spend'` when budget is supplied (a budget→outcome curve). Deterministic-seeded on `(product_id, targeting, dates)` so storyboard graders can assert exact numbers.
  - `POST /v1/availability` — multi-item dry-run that mirrors GAM's `getCompetitiveForecast` semantics: items are evaluated in order and earlier reservations reduce the supply visible to later ones. Returns per-item `forecast`, three-tier `tier_pricing` rate cards, and a `conflicts` array when supply is exhausted.
  - `GET /v1/products` — accepts `targeting`, `flight_start`, `flight_end`, `budget` query params and embeds a per-query `forecast` field on each returned product when any are present (back-compat: omit the params, get the static catalog).

  The response shapes match `/schemas/3.0.4/core/delivery-forecast.json` field-for-field so adapters project to `Product.forecast` with no field renaming. `forecast.method` is `'guaranteed'` for availability checks (matching the AdCP enum description: "Contractually committed delivery levels backed by reserved inventory") and `'modeled'` for spend curves. The seller-skill specialism doc (`skills/build-seller-agent/specialisms/sales-guaranteed.md`) gains a worked `getProducts` snippet that compiles under `npm run typecheck:skill-examples` (CI-gated; was previously fragment-shape and skipped).

  Also fixes a determinism bug in the targeting hash: `serializeTargeting` now uses a recursive deterministic stringifier instead of `JSON.stringify(t, Object.keys(t).sort())`, which was using arg 2 as a key allowlist and silently dropping every nested object's contents (two targeting specs differing only in nested fields hashed identically). Adds NaN/Infinity guards on `?budget=` / `?flight_start=` query params so garbage input falls back to the no-forecast path instead of poisoning the response with `null`s.

- e7f8e22: `SalesPlatform` methods are now optional individually; per-specialism enforcement of the core media-buy lifecycle moves up to `RequiredPlatformsFor<S>`. Two new named subset types:
  - **`SalesCorePlatform<TCtxMeta>`** — bidding + media-buy lifecycle (`getProducts`, `createMediaBuy`, `updateMediaBuy`, `getMediaBuyDelivery`, `getMediaBuys`). Required for `sales-non-guaranteed` / `sales-guaranteed` / `sales-broadcast-tv` / `sales-catalog-driven`.
  - **`SalesIngestionPlatform<TCtxMeta>`** — asset ingestion (`syncCreatives`, `syncCatalogs`, `syncEventSources`, `logEvent`, `listCreativeFormats`, `listCreatives`, `providePerformanceFeedback`). Required for `sales-social`. Optional individually.

  `SalesPlatform = SalesCorePlatform & SalesIngestionPlatform` is preserved as a structural-compatibility alias. `RequiredPlatformsFor<'sales-social'>` now requires only `SalesIngestionPlatform`, dropping ~40 lines of stub-throw boilerplate from walled-garden adopters that don't accept inbound media buys (Meta CAPI, Snap CAPI, TikTok Events, etc.). `RequiredPlatformsFor<'sales-proposal-mode'>` requires only `getProducts` plus optional ingestion. Closes #1341.

  Two new helpers in `@adcp/sdk/server`: `defineSalesCorePlatform<TCtxMeta>(platform)` and `defineSalesIngestionPlatform<TCtxMeta>(platform)` — companions to the existing `defineSalesPlatform` for adopters wiring core or ingestion in isolation.

  **Migration: adopters claiming a sales specialism with required core methods.** If you currently write:

  ```ts
  sales: SalesPlatform<Meta> = defineSalesPlatform<Meta>({
    /* all 5 core methods */
  });
  ```

  …the explicit `: SalesPlatform<Meta>` field annotation now widens the inferred shape to all-optional after the split, so `RequiredPlatformsFor<'sales-guaranteed'>` (etc.) rejects the platform with "Property 'getProducts' is optional in type 'SalesPlatform<Meta>' but required in type 'Required<Pick<SalesPlatform<any>, …>>'". Two clean migrations:

  ```ts
  // Pattern A — explicit field annotation (recommended; shortest)
  sales: SalesCorePlatform<Meta> & SalesIngestionPlatform<Meta> = {
    getProducts: async (req, ctx) => { … },
    createMediaBuy: async (req, ctx) => { … },
    updateMediaBuy: async (id, patch, ctx) => { … },
    getMediaBuyDelivery: async (filter, ctx) => { … },
    getMediaBuys: async (req, ctx) => { … },
    // …optional ingestion methods (syncCreatives, etc.)…
  };

  // Pattern B — spread the new sub-helpers (when you want the methods grouped)
  sales = {
    ...defineSalesCorePlatform<Meta>({ getProducts, createMediaBuy, updateMediaBuy, getMediaBuyDelivery, getMediaBuys }),
    ...defineSalesIngestionPlatform<Meta>({ syncCreatives, syncCatalogs, logEvent }),
  };
  ```

  Both patterns are exercised as type-only regression tests in `decisioning.type-checks.ts` (`_sales_guaranteed_field_annotation_pattern`, `_sales_guaranteed_spread_helpers_pattern`) so future helper changes can't silently break the migration path. The `defineSalesPlatform` helper is preserved for source compat — it still returns `SalesPlatform<TCtxMeta>` (now all-optional) and is appropriate for `sales-social` adopters and similar specialisms whose `RequiredPlatformsFor<S>` doesn't enforce core-method presence. The `examples/hello_seller_adapter_guaranteed.ts` reference adapter demonstrates Pattern A.

  Runtime: the dispatcher in `from-platform.ts` now conditionally registers core handlers based on method presence, so omitting `getProducts` from a `sales-social` platform doesn't crash; the buyer receives `METHOD_NOT_FOUND` for unsupported tools (or the merge-seam handler fills in via `opts.mediaBuy.X`). The runtime `validateSpecialismRequiredTools` check still warns / throws when a claimed specialism's required tools aren't implemented anywhere on the platform.

- bd3d98d: feat(mock-server, sales-social): planning surface — delivery_estimate, audience_reach_estimate, lookalike (closes #1378)

  Adds the Meta/TikTok/Snap/LinkedIn-style planning surface to the `sales-social` mock so adopters can wire `Product.forecast` from real walled-garden Marketing APIs instead of returning `forecast: undefined`. Per the issue's accepted framing, AdCP 3.0.4 already covers the surface — `forecast_range_unit: 'spend' | 'conversions' | 'reach_freq' | 'clicks'` was on the spec the whole time. The gap was that no example demonstrated the projection.

  **New endpoints**
  - `POST /v1.3/advertiser/{id}/delivery_estimate` — forward forecast (`budget` provided → reach/impressions/clicks/conversions/CPM/bid recommendation/delivery curve), or reverse forecast (`target_outcome` provided → `required_budget`, the Meta-style "tell me your goal, I'll tell you the budget" surface). CPM band varies by `optimization_goal` so the curve reflects auction realism (reach < clicks < conversions).
  - `POST /v1.3/advertiser/{id}/audience_reach_estimate` — total audience size + platform-matchable subset for a targeting spec. Adopters use this to populate `Product.targeting_options` previews before the buyer commits.
  - `POST /v1.3/advertiser/{id}/audience/{audience_id}/lookalike` — size + activation ETA estimate for a lookalike built from a seed audience, scaled by `similarity_pct` (1 = closest, 10 = broadest) and country. Mirrors Meta `customaudiences` lookalike subtype, TikTok `dmp/audience/save_lookalike`, Snap `lookalikes`.

  All three are deterministic-seeded on the inputs (advertiser_id + targeting hash + goal/audience), so storyboards remain reproducible while different targeting hashes still produce visibly different curves.

  CPM bands are calibrated to 2024-2026 walled-garden benchmarks: reach=$5, video_views=$8, engagement=$6, clicks=$11, conversions=$18 (was previously inverted — video < reach). CTR and conversion rate vary per `optimization_goal` so reach-goal reverse forecasts use saturating-curve inversion rather than back-deriving from conversion rate. The reverse-forecast budget is clamped to platform learning-phase floors ($5/day reach, $10/day clicks, $40/day conversions) and surfaces a `min_budget_warning` when the inferred budget falls below — the #1 surprise adopters hit when wiring real Meta/TikTok APIs. Lookalike sizing is now country-population-aware: `min(country_pop × similarity_pct/100, seed × multiplier)`, so a 1M-member seed in the US doesn't produce a 19M lookalike (Meta caps at country_pop × similarity_pct).

  The seller-skill specialism doc (`skills/build-seller-agent/specialisms/sales-social.md`) gains a `### Planning surface` section with a field-map table (upstream `min/max` → AdCP `low/mid/high`, `daily_budget` → `points[].budget`, etc.) and a worked `getProducts` snippet that compiles under `npm run typecheck:skill-examples`.

- d7439de: feat(server): runtime validation for specialism→required-tools coverage

  Stage 3 of #1192 (manifest adoption). When an adopter declares a specialism in `capabilities.specialisms[]`, the AdCP spec implies the agent supports every tool in that specialism's required-tool list (`SPECIALISM_REQUIRED_TOOLS` derived from manifest). This change adds a construction-time check in `createAdcpServerFromPlatform` that walks the platform object and warns (or throws under strict mode) when a required method is missing.

  What lands:
  - `src/lib/server/decisioning/validate-specialisms.ts` — `validateSpecialismRequiredTools(platform, specialisms)` and `formatSpecialismIssue(issue)` helpers. Walks every top-level field on the platform and checks for a function-typed property matching `snakeToCamelCase(tool)`. "Method-presence-anywhere" rather than "method-on-specific-field" because required tools span platform fields (`sync_accounts` lives on `accounts`, not on the specialism's primary `sales`) and pinning ownership upfront would either need a per-tool field map or false-positive on legitimate alternative layouts.
  - `createAdcpServerFromPlatform`: after `validatePlatform`, runs the specialism check. Default behavior is `console.warn` for each missing method (with specialism + tool + method name). New `strictSpecialismValidation: true` opt opts into `PlatformConfigError` on missing methods — recommended for production CI builds.
  - `scripts/generate-manifest-derived.ts`: now populates `SPECIALISM_REQUIRED_TOOLS` via reverse-mapping from `manifest.tools[*].specialisms[]` (the manifest's direct `specialisms[*].required_tools` is empty in 3.0.4). Filters universal tools (`get_adcp_capabilities` and other `protocol`-protocol tools) and normalizes specialism keys to kebab-case to match the spec's `AdCPSpecialism` enum.

  What's deferred (was originally option C of #1299):

  The build-time type fixture asserting `RequiredPlatformsFor<S>` collectively exposes every required tool method was scoped out after implementation revealed too many false-positives from cross-cutting tools (e.g., `sync_accounts` is required by `sales-non-guaranteed` but lives on `AccountsPlatform`, not `RequiredPlatformsFor<'sales-non-guaranteed'> = { sales: SalesPlatform }`). Rescoping this to a "platform-interface family collectively covers every required-tool method" assertion (without per-specialism mapping) is tracked as a follow-up on #1299.

  Closes #1299 (option B portion).

- 38331d8: Export canonical `MediaBuy` / `Creative` lifecycle graphs from `@adcp/sdk/server`.

  New surface:
  - `MEDIA_BUY_TRANSITIONS: ReadonlyMap<MediaBuyStatus, ReadonlySet<MediaBuyStatus>>`
  - `CREATIVE_ASSET_TRANSITIONS: ReadonlyMap<CreativeStatus, ReadonlySet<CreativeStatus>>`
  - `isLegalMediaBuyTransition(from, to)` / `isLegalCreativeTransition(from, to)` — boolean predicates
  - `assertMediaBuyTransition(from, to)` / `assertCreativeTransition(from, to)` — throw `AdcpError` with the spec-correct code (`NOT_CANCELLABLE` for the cancel-idempotency path, `INVALID_STATE` everywhere else)

  These maps are the same source the storyboard runner's `status.monotonic` invariant uses — production sellers that enforce transitions with these helpers cannot drift from conformance enforcement. Previously sellers had to copy the graph into their own code (three example files were doing this); spec-version bumps to the lifecycle would silently desync them. Closes #1416.

  The two test-controller examples (`examples/seller-test-controller.ts`, `examples/comply-controller-seller.ts`) now consume the SDK predicates instead of redefining the table.

- 3b21a15: Storyboard runner — `task_completion.<path>` prefix on `context_outputs.path`.

  When a step's immediate response is a submitted-arm task envelope (HITL / async-signed-IO flows), the seller-assigned IDs only exist on the eventual completion artifact, not the immediate response. Pre-this-release, storyboard authors who tried to capture from the artifact got `capture_path_not_resolvable` for a value the seller correctly produced — just on a later message. The workaround was to author a redundant follow-up `get_*` step purely to expose the field.

  The `task_completion.<path>` prefix is an explicit author opt-in: when the runner sees this prefix, it polls `tasks/get` until terminal and resolves the rest of the path against the artifact's `data`.

  ```yaml
  context_outputs:
    - name: media_buy_id
      path: 'task_completion.media_buy_id'
  ```

  The prefix triggers polling on any non-terminal status that carries a `task_id` — `submitted`, `working`, and `input-required`, per the AdCP `tasks-get-response.json` enum. Storyboards with intentional non-terminal-arm assertions are unaffected because the prefix is the only opt-in (no shape inference).

  Polling is bounded (default 30s, override with `STORYBOARD_TASK_POLL_TIMEOUT_MS`); per-poll cadence default 1.5s (override with `STORYBOARD_TASK_POLL_INTERVAL_MS`). `task_id` is validated (length cap + control-char rejection) before reaching the SDK's `tasks/get` call.

  Failures map to three distinct validation checks so compliance reports surface the right diagnostic:
  - `capture_poll_timeout` — task didn't reach terminal state within the timeout
  - `capture_task_failed` — task reached terminal `failed` / `canceled` / `rejected`
  - `capture_path_not_resolvable` — task succeeded but the artifact's data didn't carry the requested field

  This applies to any HITL flow where artifact-only fields land in `context_outputs`: `create_media_buy` (the originally-reported case), `sync_creatives` async approval (`creative_id`), `acquire_rights` (`rights_grant_id`), `si_initiate_session` / `si_send_message`, and any future tool routed through async-signed-IO.

  Closes #1417 (Option 1 from the issue's three options; protocol-expert and code-reviewer triage notes converged on this surface as the cleanest fix).

- 2026325: Storyboard runner — `task_completion.<path>` resolution now races `tasks/get` polling against the active webhook receiver, whichever arrives first.

  Per `tasks-get-response.json:75-85`, sellers MAY use webhook-only HITL completion (the spec's `submitted` enumDescription explicitly says _"Client should poll with tasks/get **or provide webhook_url at protocol level**"_). Pre-this-release, `task_completion.<path>` captures fail-closed against webhook-only sellers because the runner only polled. With this release, when `--webhook-receiver` is active, the runner waits for either (a) terminal `tasks/get` response, or (b) a webhook payload whose body's `task_id` matches the originating step. The first to resolve provides the artifact data; the runner extracts the captured field from there.

  The `task_completion.` syntax is unchanged — adoption is forward-compatible. Storyboard authors don't need to declare their preferred resolution source; runner picks whatever arrives.

  Failure modes preserved from the prior `task_completion.` implementation:
  - `capture_poll_timeout` — neither poll nor webhook resolved within the bounded timeout
  - `capture_task_failed` — poll returned a terminal failure OR webhook delivered a non-completed terminal status (`failed` / `canceled` / `rejected`)
  - `capture_path_not_resolvable` — task succeeded but the artifact (from poll OR webhook) didn't carry the requested field

  Closes #1431.

- 018f9cd: Three follow-ups to `createTenantStore` (#1387 post-DX review):
  - **Export `narrowAccountRef(ref)`** from `@adcp/sdk/server`. The framework already used this internally to read `AccountReference` fields without per-arm narrowing (the wire type is a discriminated union `{account_id} | {brand, operator}` plus optional `sandbox`); adopters writing `tenantToAccount` were cargo-culting `(ref as { operator?: string })` casts at four call sites in the worked example. Single typed accessor consolidates the pattern.

    ```ts
    tenantToAccount: (tenant, ref, ctx) => {
      const r = narrowAccountRef(ref);
      return {
        id: tenant.id,
        operator: r?.operator ?? ctx?.agent?.agent_url ?? 'derived',
        ...(r?.brand?.domain && { brand: { domain: r.brand.domain } }),
        sandbox: r?.sandbox ?? false,
        // ...
      };
    };
    ```

    Returns `undefined` on `undefined` input (the no-account-tool path), so adopters can use the same accessor in `tenantToAccount` and in `resolveByRef` without branching.

  - **Default sandbox to `false` in the multi-tenant adapter example.** The post-DX review caught an inconsistency: the adapter set `sandbox: ref?.sandbox ?? true` while the skill snippet used `?? false`. Production adopters route reads/writes to a sandbox backend on this flag — defaulting to `true` would silently land buyer requests in sandbox when they didn't ask. Aligned both to `?? false` with an explicit SWAP comment that frames it as an adopter decision.
  - **Warn on overwritten governance bindings** in the multi-tenant adapter. The hello-adapter shortcut keys `governanceBindings` by `(tenant, brand_domain)` because `acquire_rights` doesn't carry an operator on the wire (tracked upstream as adcontextprotocol/adcp#3918). Two operators in the same tenant hitting the same brand share one binding — silently. The example now logs a `console.warn` on overwrite that names the symptom and links the upstream issue, so adopters notice the limitation before it bites in production.

  Plus a SKILL cross-link in `tenant-store.ts` JSDoc so the helper's IDE hover surfaces the holdco walkthrough.

- a2abcd7: feat(types): re-export all spec-defined request/response types from `@adcp/sdk/types`

  `@adcp/sdk/types` previously re-exported only a curated subset of wire types, leaving
  `GetMediaBuysRequest`, `ListCreativeFormatsRequest/Response`, and ~50 other operation
  types accessible only via `@adcp/sdk/tools.generated` — a generated file CLAUDE.md
  explicitly tells adopters not to reach into.

  This change completes the barrel so all spec-defined operation `*Request`, `*Response`,
  `*Success`, `*Error`, and `*Submitted` types are importable from `@adcp/sdk/types`.
  The single large block is replaced with per-domain named sections (accounts,
  capabilities, media buy, audiences/catalogs/events, signals, creative, governance,
  sponsored intelligence) for maintainability.

  Intentionally excluded: comply-runner internals (`ComplyTestControllerRequest/Response`,
  `SeedSuccess`, `SimulationSuccess`, `ControllerError`), sub-shapes accessible
  transitively (`PaginationRequest/Response`, `PackageRequest`), and types whose names
  conflict with legacy `adcp.ts` shapes already in the public surface
  (`SyncCreativesRequest`, `ListCreativesRequest/Response`).

- c3bd4f0: feat(upstream-recorder): producer-side reference middleware for `query_upstream_traffic` adopters (closes adcp-client#1290)

  New public sub-export `@adcp/sdk/upstream-recorder` — a small, sandbox-only-by-default helper adopters drop into their HTTP layer to populate the `comply_test_controller`'s `query_upstream_traffic` buffer that the runner-output-contract v2.0.0 `upstream_traffic` storyboard check (PR #1289, spec adcontextprotocol/adcp#3816) reads from.

  The runner-side consumer landed in #1289. This is the producer-side companion: turns "instrument my outbound HTTP layer with a session/principal-scoped ring buffer + redaction + sandbox gating + multi-tenant isolation" — a 1-2 sprint engineering ask for a DSP/SSP-scale codebase — into "wire `recorder.wrapFetch(globalThis.fetch)` and pass the query result through your controller handler."

  ```ts
  import { createUpstreamRecorder } from '@adcp/sdk/upstream-recorder';

  const recorder = createUpstreamRecorder({
    enabled: process.env.NODE_ENV !== 'production',
  });

  // Wrap your HTTP layer
  const fetch = recorder.wrapFetch(globalThis.fetch);

  // Scope every outbound call inside a request handler to the resolving principal
  await recorder.runWithPrincipal(account.id, async () => {
    await syncAudienceUpstream(/* ... */);
  });

  // In your `comply_test_controller` `query_upstream_traffic` handler:
  const { items, total, truncated, since_timestamp } = recorder.query({
    principal: account.id,
    sinceTimestamp: req.params.since_timestamp,
    endpointPattern: req.params.endpoint_pattern,
    limit: req.params.limit,
  });
  return { success: true, recorded_calls: items, total_count: total, truncated, since_timestamp };
  ```

  **Key behaviors** (all from the spec PR's three-expert review plus this PR's own multi-expert pass):
  - **Per-principal isolation** (security HIGH from spec review). `query({ principal })` returns only calls bound to the same principal — multi-tenant sandboxes can't leak traffic across tenants. Adopters thread principal via `runWithPrincipal(p, fn)` (an AsyncLocalStorage scope that propagates across `await` boundaries) or pass it explicitly to `record()`. Empty / non-string principal at record-time or query-time throws `UpstreamRecorderScopeError` rather than silently matching nothing.
  - **Record-time redaction**. The canonical secret-key pattern from `runner-output-contract.yaml`'s `payload_redaction` is applied at recording time, not query time. JSON bodies walk through `redactSecrets`; **form-urlencoded bodies are parsed + key-redacted + re-stringified** so `access_token=xxx` is caught without the adopter pre-redacting; binary bodies (Buffer / Blob / ArrayBuffer / TypedArray) are replaced with a `[binary <n> bytes]` marker so the buffer never holds raw bytes.
  - **Sandbox-only gating**. `enabled: false` returns a no-op recorder — zero per-call overhead. When `enabled: true` and `NODE_ENV=production`, the factory emits a one-time `console.warn` so accidental ship is loud (suppress with `ADCP_RECORDER_PRODUCTION_ACK=1`).
  - **`strict: true` debug mode**. Calls outside `runWithPrincipal` scope throw `UpstreamRecorderScopeError` instead of silently dropping. Adopters set this in integration tests so forgotten scope wrappers surface as a stack trace pointing at the unwrapped call site, not as mysterious "controller present, observed nothing" storyboard failures (a HIGH adopter-facing footgun the DX review flagged).
  - **`recorder.debug()` introspection**. Returns `{enabled, bufferSize, bufferedEntries, principals, lastRecordedAt, activePrincipal, strict}` — log it from inside a handler to pinpoint missing scope wrappers or record-time / query-time principal mismatches.
  - **`onError` observability hook**. Surfaces classifier-throws, URL-parse-failures, payload-build failures, and unscoped-record events. Adopters wire to their logger; previously-invisible classifier bugs become debuggable.
  - **Buffer + TTL eviction**. Default `bufferSize: 1000`, `ttlMs: 1h`. Out-of-range option values (zero / negative / above ceiling / NaN) revert to defaults rather than silently saturating — a typo'd `bufferSize: -10` saturating to `1` would drop nearly everything.
  - **Per-entry payload byte cap**. Default `maxPayloadBytes: 65_536` (mirrors the spec's `recorded_calls[].payload.maxLength`). JSON payloads exceeding the cap replaced with `[truncated <n> bytes]`. Bounds memory ceiling under accidental hot-loop recording.
  - **`endpointPattern` glob filter** with ReDoS guard. `*` → `.*` (greedy, `/`-crossing); all other regex metas escape literally. Pathological `**********` patterns coalesce to a single `*` to defeat catastrophic backtracking. Implementation lives in `src/lib/utils/glob.ts` — shared with the runner's `validations.ts` so producer + consumer can't drift.
  - **`purpose` classifier hook**. Optional callback invoked at record time with redacted-headers view. Returning a string stamps `RecordedCall.purpose` — forward-compat for adcp#3830 item 3.
  - **Manual `record()` escape hatch** for adopters on axios / got / native `node:http`. Auto-fills timestamp, host/path, content_type, applies redaction, runs the classifier — same wire shape as `wrapFetch`. SKILL.md documents the axios + got integration patterns.

  **`toQueryUpstreamTrafficResponse(queryResult)` helper**: also exported. Projects `recorder.query()`'s adopter-ergonomic shape (`{ items, total, ... }`) onto the spec wire shape (`{ recorded_calls, total_count, ... }`) so adopters return it verbatim from their `comply_test_controller` handler instead of reinventing the field renames.

  **`registerTestController` extended**: `TestControllerStore.queryUpstreamTraffic?` is a new optional method. When present, the SDK auto-advertises `query_upstream_traffic` via `list_scenarios` (open-extension scenario, accepted by the dispatcher under the `TOOL_INPUT_SHAPE.scenario: z.string()` open contract). The capability block (`compliance_testing.scenarios` on `get_adcp_capabilities`) keeps the canonical typed enum — extension scenarios live in `list_scenarios` only, since the cached 3.0.4 schema's enum predates spec PR #3816 and would reject the unknown value at validation time. Once a 3.0.5+ release ships the schema, `query_upstream_traffic` gets promoted to a first-class `CONTROLLER_SCENARIOS` constant.

  **End-to-end integration**: the SDK's `examples/hello_signals_adapter_marketplace.ts` reference adapter wires the recorder against the published `signal-marketplace` mock. CI gates the example via `test/examples/hello-signals-adapter-marketplace.test.js` — type-checks under strictest tsc (`--strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes + noPropertyAccessFromIndexSignature`), runs the storyboard with zero failed steps, asserts every expected upstream route hit on the mock's `/_debug/traffic` (the existing façade gate). Adopters fork this example as the copy-pasteable starting point.

  **Two anti-façade traffic surfaces — documented explicitly in the SKILL**: adopter-side `query_upstream_traffic` (this PR; full payloads, per-principal, JSONPath assertions) is complementary to mock-side `/_debug/traffic` (pre-existing; per-route hit counts on the mock platform itself). Mocks shouldn't wire the recorder internally — they ARE the upstream. The SKILL's new "Two traffic surfaces" diagram pins this so adopters don't conflate them.

  **Refactor under the hood**: `redactSecrets` and `SECRET_KEY_PATTERN` lifted from the runner into a shared `src/lib/utils/redact-secrets.ts` so the new recorder reuses the same redaction floor as the runner consumes — adopter-emitted recorded payloads land in the runner's compliance report unchanged. `globToRegExp` similarly lifted to `src/lib/utils/glob.ts` so producer-side `endpointPattern` filtering and runner-side `endpoint_pattern` matching share one implementation and can't drift. No behavior change for the runner; `__redactSecretsForTest` still works.

  **53 tests across four files** pin the integration end-to-end:
  - `test/lib/upstream-recorder.test.js` (41 unit) — enabled-false short-circuit, cross-principal isolation (the security HIGH), record-time JSON + header + form-urlencoded redaction with custom-pattern extension, buffer FIFO eviction, TTL eviction, endpointPattern + sinceTimestamp + limit/truncated query filters, wrapFetch end-to-end (incl. status_code capture and recording on fetch error), purpose classifier including the catches-throws-MUST-NOT-crash invariant, clear() cleanup helper, query() principal validation (empty / non-string throws), runWithPrincipal validation, strict-mode throws on unscoped record / fetch, onError observability for all swallow sites, debug() introspection, Buffer / TypedArray binary handling, payload byte cap (truncation + disable), bufferSize clamping (zero / Infinity / negative reverts to default), and the ReDoS guard against pathological `**********` patterns.
  - `test/lib/upstream-recorder-spec-shape.test.js` (5 Ajv) — validates a representative `RecordedCall` against the inline `UpstreamTrafficSuccess.recorded_calls` subschema from spec PR adcp#3816 (TODO: switch to cached schema when 3.0.5 ships). Pins `toQueryUpstreamTrafficResponse` projection — `items → recorded_calls` / `total → total_count` field renames are the load-bearing claim and asserted explicitly.
  - `test/lib/upstream-recorder-e2e.test.js` (4 round-trip) — drives `runStoryboardStep` against a one-step `upstream_traffic` fixture storyboard with a stub MCP client whose `comply_test_controller` handler routes through the real recorder via `toQueryUpstreamTrafficResponse`. Cases: happy path, façade (zero calls), principal mismatch (cross-tenant isolation), `identifier_paths` missing vector. Test-fixture storyboard at `test/fixtures/storyboards/upstream-traffic-fixture.yaml`.
  - `test/examples/hello-signals-adapter-marketplace.test.js` (3 example-adapter integration, pre-existing — now exercises the recorder) — strictest-tsc + storyboard zero-failed + façade gate against the `signal-marketplace` mock-server.

  **Sequencing note** — adcp#3830 item 4 in the deferred-extensions tracking issue, sequencing dependency from issue #1290: "land #1253 first (runner + forward-compat default) so storyboards can declare `upstream_traffic` validations and have them grade not_applicable on adopters who haven't yet implemented." That's now landed (PR #1289 merged at `c446936c`). This middleware unblocks the long tail of adopters who want to opt in but don't want to write the recorder from scratch.

  Sibling Python issue: `adcp.testing.upstream_recorder` mirrors this for the Python SDK — to be filed as a paired issue in `adcontextprotocol/adcp-client-python`.

- f815d51: `ValidationIssue` now carries a curated `hint` field for known shape gotchas. Closes #1309 (follow-up to #1283).

  A small table at `src/lib/validation/hints.ts` maps recognized failure patterns to one-sentence recipes. When a pattern matches, the hint rides on the structured `issues[].hint` and is mirrored into the prose `adcp_error.message` — so adopter LLMs reading the wire envelope alone resolve the gotcha one-shot.

  Patterns shipped (all sourced from real adopter pain — matrix-blind-fixtures lineage, `skills/SHAPE-GOTCHAS.md`, and the `skills/call-adcp-agent/SKILL.md` "Gotchas I keep seeing" section):
  - `activation_key.type='key_value'` missing `key` or `value` — top-level, not nested under `key_value`
  - `activation_key.type='segment_id'` missing `segment_id` — same flatness
  - `account` discriminator merging — pick `{account_id}` or `{brand, operator}`, not both
  - `budget` as object — it's a number; currency comes from the referenced `pricing_option`
  - `brand.brand_id` instead of `brand.domain` — spec uses `domain`
  - `format_id` as string — always `{agent_url, id}` (sometimes plus dimensions)
  - `signal_ids[]` as bare strings — array of provenance objects
  - VAST/DAAST `delivery_type` missing — pair `inline` with `content` or `redirect` with `vast_url`/`daast_url`
  - mutating tools missing `idempotency_key` — required UUID, reused on retries

  Empirical example post-PR:

  ```
  create_media_buy request failed schema validation at /idempotency_key:
    must have required property 'idempotency_key'
    (hint: Mutating tools require `idempotency_key` (UUID) on every request. Generate fresh per logical operation, reuse the same value on retries.)
  ```

  The rule table is internal — adopters can't currently register custom hints. New patterns get added by PR when at least three adopters or blind-LLM matrix runs hit the same shape and lose ≥1 iteration to "what does this error actually want?". The `hint` field is absent on the long tail; structured `pointer` + `keyword` + `discriminator` + `variants` already cover those cases.

  `skills/call-adcp-agent/SKILL.md` updated: recovery order now starts with `hint` when present, then `discriminator`, then `variants`, then leaf fields.

- 3d894cc: Validation errors now name the rejecting schema and the discriminator the payload was inferred to be targeting. Closes #1283.

  `ValidationIssue` carries two new optional fields:
  - **`schemaId`** — `$id` of the rejecting schema, resolved by finding the longest registered AJV `$id` that prefixes the issue's `schemaPath`. For tools served from the flat schema tree (e.g. `governance/`, `brand/`) where `$ref`s are followed at runtime, this lands on the deeper sub-schema. For tools served from the pre-resolved `bundled/` tree (most of the catalog — signals, media-buy, creative), inner `$id`s are stripped at bundle time so `schemaId` resolves to the response root. Either way, the field names exactly the schema the validator looked at.
  - **`discriminator`** — array of `{field, value}` pairs identifying the variant the payload was inferred to be targeting. Populated when `compactUnionErrors`' const-discriminator collapse picks a "best surviving variant" (the user matched the discriminator but missed required fields or other constraints inside it). Compound discriminators like `audience-selector`'s `(type, value_type)` produce multi-entry arrays. Names align with OpenAPI 3.x `discriminator.propertyName`.

  Both fields ride on every `VALIDATION_ERROR` envelope by default — same precedent as `variants[]` and `allowedValues`, which already ship always-on with the rationale "PUBLIC spec data, not internal handler shape." The `exposeSchemaPath` gate stays in place for `schemaPath` itself.

  The prose `adcp_error.message` mirrors the new fields so adopters debugging from a wire envelope alone don't need to walk `issues[]`. The `(schema: …)` half is suppressed when the issue's `schemaId` equals the validator's root (bundled-tree default — restating the tool name doesn't help). New `ValidationOutcome.schemaId` exposes the root for callers building their own envelopes:

  ```
  activate_signal response failed schema validation at /deployments/0/activation_key/key:
    must have required property 'key' (discriminator: type='key_value')
  ```

  Empirically every example built during the matrix-blind-fixtures lineage took 1–3 iterations to resolve a discriminated-union error that's now one-shot once the adopter reads the `discriminator` tag.

  **Known limitations** (follow-ups filed separately):
  - Bundled tools strip inner `$id`s — `schemaId` lands on the response root, not the deeper sub-schema referenced by `$ref`. A spec companion issue covers `$id` retention during bundling.
  - Synthetic union-root errors in nested unions can carry the outer discriminator (e.g. `type='platform'`) while leaf errors carry the inner (`type='key_value'`). The leaf is the actionable one; the root is contextual. Spec companion covers de-duplication.
  - The optional `hint` field from issue #1283's "Proposed change" #3 (curated prose like "type='key_value' requires top-level `key` and `value`") is deferred — requires per-tool curation and ships separately.

### Patch Changes

- 5cb6d10: `AccountStore.reportUsage` and `AccountStore.getAccountFinancials` now receive `ctx.agent` (the registry-resolved `BuyerAgent`) in addition to `authInfo` and `toolName` — matching the threading already wired for `resolve`, `upsert`, and `list`. Closes the symmetric gap noted in PR #1315 review.

  All four `AccountStore` handlers now route through a single internal `toResolveCtx` helper so future additions to `ResolveContext` land on every method automatically. Adopters implementing principal-keyed gates (e.g. `BILLING_NOT_PERMITTED_FOR_AGENT` from adcontextprotocol/adcp#3851, or per-agent financial-read authorization) get the resolved buyer-agent identity on every account-store surface, not just three of five.

  No behavior change for adopters that didn't already read `ctx.agent` — the field was simply missing on `reportUsage` / `getAccountFinancials` before.

- c123fb8: Pin to AdCP 3.0.5. Picks up the brand-rights storyboard fix
  (adcontextprotocol/adcp#3892, shipped as part of 3.0.5): `acquire_rights`
  step's `context_outputs` now reads `path: rights_id` (was the non-existent
  `rights_grant_id`), unblocking the `rights_acquisition` and
  `rights_enforcement` scenarios for spec-conformant brand-rights agents.
  Also picks up the optional storyboard-level `default_agent` field
  (adcontextprotocol/adcp#3894) for multi-agent storyboard runners — strictly
  additive, no SDK behavior change.
- dc58bf1: fix(server): auto-seed adapters use resolved account id (symmetric with bridge)

  The catalog-backed auto-seed adapters introduced in #1100 wrote fixtures keyed by raw `input.account.account_id`, while the bridge read from `ctx.account?.id` (the resolved id set by the framework's `resolveAccount`). On a platform whose resolver maps `account_id` to a distinct internal id (e.g., a tenant-prefixed shape), the asymmetry caused silent fixture loss — `seed_product` succeeded but `get_products` couldn't find the seeded product because the namespace key on read didn't match the one on write.

  Auto-seed adapters now run `platform.accounts.resolve` on the request's `account` reference and use the resolved `id` as the namespace key, matching what the bridge reads. Adopters with identity resolvers (the common case) see no behavior change.

  Also: when the auto-seed adapter fires without a resolvable account (typically a misconfigured `sandboxGate` that lets account-less requests through), it now logs a warn-level diagnostic and drops the write, instead of silently returning. Misconfigurations that previously caused "seeds vanish without explanation" now surface as a single actionable log line.

  Closes #1216.

- 44f82c0: Fix four `@internal`-leak bugs that broke adopter `tsc --noEmit` (#1236).

  `stripInternal: true` deleted these declarations from the published `.d.ts`
  while consumers (the public `AdcpServer` interface, the main `index.d.ts`
  re-exports) kept referencing them, producing TS2304/TS2305 errors on every
  adopter without `skipLibCheck`:
  - `ADCP_SERVER_BRAND` (`server/adcp-server.ts`) — also converted from
    `declare const` to a real `Symbol(...)` const so the binding survives
    emit. Brand is `never`-typed and never set on the runtime object.
  - `extractAdcpErrorFromMcp`, `extractAdcpErrorFromTransport`
    (`utils/error-extraction.ts`) — re-exported from `@adcp/sdk`, not
    internal.
  - `createSingleAgentClient` (`core/SingleAgentClient.ts`) — re-exported
    from `@adcp/sdk`, not internal.

  Adds `npm run check:adopter-types` (wired into CI) which packs the SDK,
  scaffolds a minimal adopter, and runs `tsc --noEmit` against the
  published types so this class of leak fails CI instead of shipping.

- 27bd383: fix(codegen): alias 6 jsts under-resolution artifacts after AdCP 3.0.4 asset-union landing

  AdCP 3.0.2 introduced `core/assets/asset-union.json` (adcp#3462) as the canonical home for the asset-variant `oneOf`. The bundler still inlines the union at both `creative-asset.json` and `creative-manifest.json` call sites, and `json-schema-to-typescript` under-resolves the second compile pass — dropping the `asset_type` discriminator that the first pass preserved. Six survivors of `removeNumberedTypeDuplicates`'s byte-identity check:

  | Type                                                          | First pass (correct)                                    | Second pass (under-resolved)         |
  | ------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------ |
  | `VASTAsset`                                                   | `{ asset_type: 'vast'; …metadata… } & (delivery_union)` | `(delivery_union)` — lost wrapper    |
  | `BriefAsset`                                                  | `CreativeBrief & { asset_type: 'brief' }`               | `CreativeBrief` — lost discriminator |
  | `DAASTAsset`, `CatalogAsset`, `AssetVariant`, `CreativeAsset` | …                                                       | …                                    |

  `applyKnownJstsAliases` runs after the byte-identity dedupe pass and rewrites each known artifact as `type Foo1 = Foo` with a `@deprecated` JSDoc. Type-level safe: the bundled response carries `asset_type` correctly at runtime, so the under-resolved type was strictly weaker than the wire format. The alias gives consumers the correctly-discriminated shape that matches what they receive on the wire. Zod codegen consumes the aliased types and emits matching schema aliases automatically.

  Closes #1264.

- 655280e: Added `docs/recipes/composeMethod-testing.md` with six test patterns for `composeMethod`-wrapped handlers: mocking the base method, short-circuit assertion (including the `{ shortCircuit: undefined }` gotcha), layering two `composeMethod` calls, `after`-hook enrichment, typed-error propagation, and `requireAdvertiserMatch` with `composeMethod`. Every pattern has a corresponding running test in `test/server-decisioning-compose-recipes.test.js`. Added a `composeMethod` cookbook entry and table row to `docs/llms.txt` so agents building decisioning platforms can discover the primitive and its test patterns. Closes #1345.
- bc12c3c: Broaden cosign keyless verify regex in `scripts/sync-schemas.ts` to allow signatures from any release branch (not just `main` and `2.6.x`). Aligns with adcp-client-python and adcp-go, which both use a `refs/(heads|tags)/.*` wildcard.

  **The bug**: v3.0.1, v3.0.2, v3.0.3 were released from `refs/heads/3.0.x` (the maintenance branch); the prior regex `^...refs/heads/(main|2\.6\.x)$` silently rejected them with `cosign verify-blob failed for v3.0.1: none of the expected identities matched what was in the certificate, got subjects [...refs/heads/3.0.x]`. SDK adopters bumping past v3.0.0 hit this on every sync.

  **The fix**: switch to `^...refs/(heads|tags)/.*$`. The trust gate is upstream `release.yml`'s `on.push.branches` allowlist (currently `main`, `3.0.x`, `2.6.x`) — that's what determines which refs can produce a signature. Mirroring the list here added no defense and broke every time a new release line was added. The wildcard delegates branch-allowlist enforcement to the workflow itself, where it belongs. `refs/tags/*` is forward-compat for any future post-tag re-signing flow.

  Closes the verify-failure on v3.0.1+ that adopters reported when bumping past 3.0.0.

- e8fdbfd: fix(codegen): honor schema title in gap-schemas dedupe (emit CreativeRejectedDetails)

  `schemas/cache/3.0.4/error-details/creative-rejected.json` has title "Creative Rejected Details" but the gap-schemas pass derived its dedupe key from the filename (`creative-rejected` → `CreativeRejected`). That collided with the brand-domain `CreativeRejected` interface (different schema, from `creative-approval-response.json`) already in the `generatedTypes` set, so the file was silently skipped before `json-schema-to-typescript` could produce its actual title-derived `CreativeRejectedDetails`.

  Six other error-details files (`account-setup-required`, `audience-too-small`, `budget-too-low`, `conflict`, `policy-violation`, `rate-limited`) emit fine because their kebab-name doesn't collide. Only `creative-rejected` was affected; the gap predates 3.0.4.

  Fix: peek at the schema's `title` (when present) and use the title-derived name for both the dedupe check and the `compile()` argument. `CreativeRejectedDetails` now emits as a standalone interface. Brand-domain `CreativeRejected` is unaffected.

  Closes #1271.

- 3c87198: Documentation: cross-specialism dispatch on `DecisioningPlatform`. JSDoc on the platform interface and an expanded `skills/build-holdco-agent/SKILL.md § Cross-specialism dispatch` section now make explicit that there is no `ctx.platform.<specialism>` accessor — the canonical patterns are class instance + `this` (used by `examples/hello_seller_adapter_multi_tenant.ts`) or closure capture (for adopters using `define<X>Platform({...})` factories standalone). Both forward the same `RequestContext` so the resolved account / agent / authInfo carry through, and both bypass wire-side validation + idempotency dedup (correct for in-process calls but worth knowing). One of the items tracked in #1387.
- a9ddd45: fix(client): discovery error message hints at wrong-path registration

  `SingleAgentClient.discoverMCPEndpoint`'s generic "Failed to discover MCP endpoint" error now includes a hint that the most common cause is `agent_uri` pointing at the host root when the MCP endpoint lives at a non-standard path. The SDK only auto-probes `/`, `/mcp`, and `/mcp/`; servers exposing MCP at `/api/mcp`, `/v1/mcp`, or similar custom paths need that exact path registered as `agent_uri`.

  No behavior change — operators get a more actionable error. Helps downstream tools (dashboard probes, registration flows) surface the actual issue instead of "agent offline".

  Closes #1234.

- 85812c1: feat(types): add `@deprecated` aliases for error-details schemas renamed in AdCP 3.0.x

  adcp#3149 (`rate-limited.json`) and adcp#3566 (five other error-details files) canonicalized SCREAMING_SNAKE titles like `RATE_LIMITED Details` and `ACCOUNT_SETUP_REQUIRED Details` into Title Case. The previous SDK release emitted `RATE_LIMITEDDetails`, `ACCOUNT_SETUP_REQUIREDDetails`, etc.; post-3.0.4 the canonical names are `RateLimitedDetails`, `AccountSetupRequiredDetails`, etc.

  Hand-authored aliases in `src/lib/types/error-details.aliases.ts` preserve the old names for one minor cycle so consumers' imports keep compiling. Each alias is `@deprecated` so editor tooling surfaces the canonical replacement; slated for removal in the next major.

  Aliases shipped (covers both type and Schema export pairs):
  - `ACCOUNT_SETUP_REQUIREDDetails` / `…Schema` → `AccountSetupRequiredDetails` / `…Schema`
  - `AUDIENCE_TOO_SMALLDetails` / `…Schema` → `AudienceTooSmallDetails` / `…Schema`
  - `BUDGET_TOO_LOWDetails` / `…Schema` → `BudgetTooLowDetails` / `…Schema`
  - `CONFLICTDetails` / `…Schema` → `ConflictDetails` / `…Schema`
  - `POLICY_VIOLATIONDetails` / `…Schema` → `PolicyViolationDetails` / `…Schema`
  - `RATE_LIMITEDDetails` / `…Schema` → `RateLimitedDetails` / `…Schema` (3.0.1 rename)

  `creative-rejected.json` is intentionally absent — codegen never emitted a standalone `CreativeRejectedDetails` (or its prior SCREAMING_SNAKE form) because the brand-domain `CreativeRejected` interface lays claim to the namespace first. Tracked as #1271.

  Closes #1065.

- 2f69bf2: Test-infrastructure: `runHelloAdapterGates` (the shared CI test runner for `examples/hello_*_adapter_*.ts`) picks free TCP ports per-run instead of taking hardcoded numbers from each test file's config.

  Closes the EADDRINUSE-on-41504 + agent-port-timeout-on-35004 flakes hit on adcp-client#1361 CI runs 25266540111 / 25266762789 / 25266848405 — concurrent `node --test` workers were racing on the same hardcoded port across reruns when the previous run left TCP sockets in TIME_WAIT after `--test-force-exit`.

  Mock server gets `port: 0` directly (its boot helper surfaces the bound port via `mockHandle.url`); the spawned agent reads `PORT` from env, so the harness uses a small `pickFreePort()` helper that asks the kernel for a free number and hands it to the child process. `agentPort` and `upstreamPort` are gone from the `runHelloAdapterGates` config — every test file using the harness now opts in automatically.

  No library/CLI behavior change; this is a `patch` only because the changeset gate doesn't have a "tests-only" semver level today.

- d0218df: fix(client): extend v3 fallback to cover capabilities-call throws and empty-data cases

  #1201 tightened the v2-fallback heuristic in `SingleAgentClient.getCapabilities()` so that v3 agents with wire-shape bugs (returning `success: false` with v3-shaped `result.data`) are no longer mis-classified as v2. But the fix only covered one failure mode. Two residual paths still fell back to v2 synthetic capabilities, cascading into "AdCP schema data for version v2.5 not found" errors:
  - `executeTask` throws (transport error, parse error, OAuth flow failure)
  - `success: false` AND `result.data` is empty / not v3-shaped (so the `looksLikeV3Capabilities` heuristic doesn't catch it)

  In both cases the agent still has the v3-only `get_adcp_capabilities` tool in its `tools/list` — affirmative evidence that it's v3 even though we couldn't read details. Falling back to v2 synthetic causes `parseAdcpVersion` to ask for v2.5 schemas (not bundled, by design — they're optional) and every subsequent step fails.

  This patch:
  - Adds `buildSyntheticV3Capabilities(tools)` to `@adcp/sdk/utils/capabilities` (mirrors `buildSyntheticCapabilities` but emits `version: 'v3'`, `majorVersions: [3]`, `_synthetic: true`).
  - `SingleAgentClient.getCapabilities` returns synthetic v3 caps when `get_adcp_capabilities` is in the tool list but the call fails (any reason).
  - `requireSupportedMajor` skips the version + idempotency-TTL detail checks for synthetic v3 (we know the agent is v3 but couldn't confirm specifics until the caps endpoint is fixed).

  Closes #1217.

- ea18eb1: fix(testing): matrix harness `runGrader` accepts `overall_status: partial` when zero steps/tracks failed

  Closes adcontextprotocol/adcp-client#1209.

  Pre-fix, `scripts/manual-testing/agent-skill-storyboard.ts` `runGrader` treated `overall_status === 'partial'` as failure, even when the storyboard runner reported `steps_failed: 0` and `tracks_failed: 0`. This produced false negatives when the runner classified a track as "silent" (no specialism-level criteria definitively scored) — every assertion passed but the harness flagged the pair as failed.

  Surfaced empirically by the matrix v2 run on adcontextprotocol/adcp-client#1207. Both creative-template pairs (`build-creative-agent × creative_template`, `build-decisioning-creative-template × creative_template`) ran cleanly: Claude built valid agents, all 6 storyboard steps passed, mocks worked correctly. Harness reported 0/3 because `overall_status` wasn't literally `"passing"`.

  Fix: pass when `overall_status === 'passing'` OR when `overall_status === 'partial'` AND `steps_failed === 0` AND `tracks_failed === 0`. Logs a one-line note when the partial-but-clean path triggers so the rationale isn't silent.

  This is a dev/test surface fix only — no impact on published runtime code. The matrix harness lives in `scripts/manual-testing/` and is invoked via `npm run compliance:skill-matrix`; adopters' storyboard pipelines use `bin/adcp.js storyboard run` directly and aren't affected.

- 3efacca: fix(matrix): blind-fixture testing + façade detection in matrix v2 harness

  Closes adcontextprotocol/adcp-client#1225.

  The matrix v2 harness was leaking the answer key to Claude — the prompt inlined specific principal-mapping values (e.g., `account.advertiser: "acmeoutdoor.example" → upstream advertiser_id: adv_acme_us`), letting Claude hardcode the entire round-trip without ever calling the upstream. Surfaced empirically on PR #1220's sales-social run: Claude's generated `server.ts` defined an OAuth client but never invoked it from any handler, with this comment:

  ```ts
  // Touch the upstream client at boot so the import isn't tree-shaken in dev,
  // and so the OAuth path is exercised even when handlers don't call it.
  void fetchUpstreamToken;
  ```

  Storyboard graded `passing` because it only validates AdCP response shape, not whether the agent actually wrapped the upstream.

  Two changes to make the test honest:
  1. **Strip specific values from the harness prompt.** Adapters now receive the _names_ of AdCP fields they'll see (`account.advertiser`, `account.operator`, etc.) but not the _values_. The harness uses values Claude's prompt does not contain. Hardcoding a mapping table won't work.
  2. **Discovery + traffic counters on the mock-server.** Each mock exposes:
     - `GET /_lookup/<resource>?<adcp_field>=<value>` — runtime resolution from AdCP-side identifiers to upstream IDs. Replaces the hardcoded mapping table the prompt used to inline.
     - `GET /_debug/traffic` — per-endpoint hit counters. The harness queries this after the storyboard run and asserts headline endpoints (`POST /event/track`, `POST /custom_audience/upload`, etc.) were called ≥ 1 time. Façade adapters that return shape-valid AdCP responses without calling these endpoints fail this check regardless of storyboard pass.

  All four specialisms (sales-social, signal-marketplace, creative-template, sales-guaranteed) ship with `/_lookup/<resource>` discovery, `/_debug/traffic` counters, and `bump()` calls on every routed handler. Each carries a per-specialism `expectedHitsForSpecialism()` list in the harness — empty list means no traffic assertion (back-compat for un-instrumented mocks).

  Boot summaries also stripped of specific advertiser/operator values so adapters can't read them from the CLI banner.

  Refs:
  - PR #1220 (sales-social) — the matrix run that surfaced the façade pattern
  - Issue #1225 — full design rationale and follow-up scope across all 4 mocks

- 9fed989: fix(skill): build-creative-agent SKILL.md surfaces strict-mode `Format.renders[]` + `Format.assets[]` shapes prominently

  Closes adcontextprotocol/adcp-client#1210.

  Pre-fix, the skill mentioned the strict-shape requirement only in a table-cell gotcha (`renders[]` MUST have `role` + `dimensions`) and showed a worked example deep in the implementation section. The matrix v2 run on PR #1207 confirmed this isn't enough — Claude built creative-template agents that emitted `renders: [{ width, height }]` (the exact shorthand the gotcha warns against) and `assets: [{ asset_id, asset_role, required }]` missing the `asset_type` discriminator. Lenient validation passed; strict validation flagged both.

  Empirical evidence (from `.context/matrix-mock-run-3.log`, the ✗ run):

  ```
  strict JSON-schema missing required at /formats/0/renders/0/dimensions: dimensions
  strict JSON-schema missing required at /formats/0/renders/0/role: role
  strict JSON-schema missing required at /formats/0/assets/0/asset_type: asset_type
  strict JSON-schema rejected /formats/0/renders/0: must match exactly one schema in oneOf
  ```

  Fix: promote the strict-shape requirement into the **cross-cutting pitfalls callout** at the top of the "Tools and Required Response Shapes" section, with explicit ✗-WRONG / ✓-RIGHT side-by-side. Also tightens the table-cell gotcha to mention the asset discriminator quartet (`item_type` + `asset_id` + `asset_type` + `required`).

  Skills are bundled with the npm package (`files: ["skills/**/*"]`), so this is a publishable change.

  Verification path: re-run `npm run compliance:skill-matrix -- --filter creative_template` against the new skill; strict-mode warnings should disappear.

- 8a970ae: docs(forecasting): surface `Product.forecast` / `forecast_range_unit` across the seller skill — adds `docs/guides/FORECASTING.md` plus per-specialism deltas (sales-non-guaranteed, sales-guaranteed, sales-broadcast-tv, sales-social). Documentation-only, no library or CLI behavior changes.
- 2459665: `Format.renders[]` codegen now extracts each `oneOf` branch as a closed shape — `{ role; dimensions; ... }` and `{ role; parameters_from_format_id: true }` — instead of collapsing the first branch to `{ [k: string]: unknown }`. Closes adcp-client#1325. The SDK's typed render factories (`displayRender`, `parameterizedRender`, `templateRender`) now compose cleanly with `Format['renders']` under `--strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes`.

  Implementation: a new `flattenMutualExclusiveOneOf` preprocess in `scripts/generate-types.ts` detects the JSON Schema "X xor Y" idiom (`oneOf` branches with `{ required: [X], not: { required: [Y] } }` and no other keys) and inlines the parent's `properties` into each branch with the excluded fields removed. The mutual-exclusivity constraint stays enforced at runtime by Ajv against the unstripped schema; the codegen pass only widens what TypeScript can express. Same fix applied to `sync_plans` plan budget (`reallocation_threshold` xor `reallocation_unlimited`), which had the identical loose-arm shape.

  `RenderDimensions.unit` is now `DimensionUnit` (the schema enum: `'px' | 'dp' | 'inches' | 'cm' | 'mm' | 'pt'`) instead of an open `string` — adopters who passed `unit: 'feet'` or other off-spec strings will now see a TS error. Closes adcp-client#1325.

- 956ac97: fix(harness): convert matrix harness `runGrader` from `spawnSync` to async `spawn`

  The matrix harness (`scripts/manual-testing/agent-skill-storyboard.ts`) is dev-only and not shipped in the npm package. Tagging this `patch` to satisfy the changeset gate; no published code changes.

  Background: the harness boots the mock upstream HTTP server in the same Node process. `spawnSync` blocked the event loop while the grader child waited on agent responses → in-process upstream couldn't tick → agent's upstream calls hung → 120s timeout. Same-process deadlock that #1241 didn't catch (its stdin-close fix was correct but only addressed half the failure path).

  Fix: async `spawn` + Promise on whichever of `'error'` or `'close'` fires first. Event loop stays live, upstream serves alongside the grader. Verified: signal_marketplace verify-mode log went from 22 lines (timeout) to 632 lines (full grader JSON) at 1.5s wall.

  Resolves the residual hang from #1237.

- c626f75: Rename `examples/hello_*_adapter_*.ts` reference adapters by AdCP role and strip redundant family prefixes. Two motivations: (1) signal-marketplace agents are signals/data agents (not sellers — they don't sell media), and creative-template agents are stateless transforms (no inventory); the inherited `hello_seller_adapter_` prefix was wrong for both. (2) The specialism portion was redundant when the role already implies the family — `hello_creative_adapter_creative_template.ts` repeats `creative` twice; same for the sales variants.

  New convention: `hello_<role>_adapter_<specialism>.ts` where `<specialism>` is the part of the specialism name AFTER the family-implied prefix is stripped. Concretely:

  | Before                                       | After                                  |
  | -------------------------------------------- | -------------------------------------- |
  | `hello_seller_adapter_signal_marketplace.ts` | `hello_signals_adapter_marketplace.ts` |
  | `hello_seller_adapter_creative_template.ts`  | `hello_creative_adapter_template.ts`   |
  | `hello_seller_adapter_sales_social.ts`       | `hello_seller_adapter_social.ts`       |
  | `hello_seller_adapter_sales_guaranteed.ts`   | `hello_seller_adapter_guaranteed.ts`   |

  Roles map to AdCP protocol layers: `seller` for `media-buy`, `creative` for `creative`, `signals` for `signals`, with `governance` / `brand` reserved for the corresponding agent kinds. Test files, changesets, and cross-references in `docs/`, `skills/`, `examples/hello-cluster.ts`, and `scripts/` rewritten correspondingly. Aspirational `hello-cluster.ts` entrypoints for adapters not yet shipped (governance, brand, additional creative variants, sales-non-guaranteed) updated to follow the same convention so future PRs land at the right path. No behavioral change.

- f7741e5: feat(example): hello-cluster orchestrator boots all hello-\* adapters with one command

  `examples/hello-cluster.ts` (and `npm run hello-cluster`) spawns each per-specialism hello adapter on its declared port (signals 3001, sales 3002, governance 3003, creative 3004, brand 3005, retail-media 3006), preflights each adapter's upstream backend, health-checks each via MCP `tools/list`, and emits a YAML routing manifest the storyboard runner (#1066, landing as #1355) can consume via `--agents-map`. Manifest shape locked against `parseAgentsMapArgs` in PR #1355: top-level `default_agent` (omitted when `sales` is pending so storyboards expecting it fail loud), `agents.<key>.{ url, auth }` matching `TestOptions['auth']`'s bearer variant, plus a top-level `pending: [{ name, specialism, entrypoint, tracking }]` sibling that the runner ignores but tooling can surface.

  Closes the local test loop for #1066 — adopters can stand up a multi-agent topology with one command instead of opening six terminals.

  Pending hello adapters (#1332 governance, #1333 creative, #1334 brand, plus sales / retail-media) are listed in a `# pending:` block at the top of the manifest and skipped silently. Drop a file in at the documented path and the cluster picks it up next run — no edits to the orchestrator. Today only the signals adapter exists, so the cluster boots one agent and notes the rest as pending.

  Behavior:
  - Boots every present adapter in parallel; ready in ~2s for the current single-adapter set, well under the 5s budget.
  - SIGINT/SIGTERM reap children cleanly (SIGTERM with 3s grace, then SIGKILL). A `tearingDown` guard prevents N concurrent reap cycles when a sibling crash fires every other child's exit handler.
  - A child crash tears down the rest of the cluster and exits non-zero, surfacing the last 10 lines of the dying adapter's stderr in the cluster's error message — adopters see WHY the child died (e.g. EADDRINUSE), not just "fetch failed".
  - `HELLO_CLUSTER_PORT_BASE=40000` shifts the whole range when 3001–3006 are busy or when running side-by-side clusters.
  - Defaults `NODE_ENV=development` for spawned children so the in-memory task registry boots without the production-safety refusal. The cluster itself refuses to boot under a production parent unless `HELLO_CLUSTER_I_KNOW_NOT_PROD=1` is set — defense in depth so an LLM scaffolding from this file or an adopter copy-pasting into staging can't accidentally rewrite NODE_ENV on a real deployment.
  - Manifest leads with a routing-key comment so first-time readers don't have to chase #1066 to understand what `agents.<name>` means. `default_agent` is omitted when its target (`sales`) is in the pending list — storyboards expecting `sales` fail loud rather than silently retargeting to whichever adapter sorted first.

  Upstream preflight: each `AdapterConfig` declares the env var (e.g. `UPSTREAM_URL`), default URL, and probe path of the backend it proxies. Before spawning, the cluster fetches every distinct upstream URL once with a 1.5s timeout. Network refusal or 5xx → exit 1 with a copy-pasteable command (`run 'npx @adcp/sdk@latest mock-server <specialism> --port <inferred>' first`). The port in the hint is parsed from the supplied URL, so a user pointing `UPSTREAM_URL` at `:55555` gets a hint matching their port. Any 2xx/3xx/4xx is treated as "listener up" since the failure mode we care about is "process not running," not "request rejected."

  Deferred:
  - `HELLO_CLUSTER_HOST` for binding `0.0.0.0` so peer containers can reach the cluster (product expert's QA-env feedback).
  - `HELLO_CLUSTER_STRICT=1` so CI fails when the expected adapter set isn't fully present (post-#1334 concern).

  Out of scope: TLS termination, production-style supervision, upstream mock-server boot. Adopters wanting the full stack run docker-compose / foreman; this is the minimal one-command demo.

- c626f75: Add `examples/hello_creative_adapter_template.ts` — a worked, passing reference adapter for the `creative-template` specialism that wraps an upstream creative-template platform via HTTP. Companion to `hello_signals_adapter_marketplace`. Demonstrates the typed-platform `CreativeBuilderPlatform` shape (`buildCreative` + `previewCreative`), the v5 escape hatch for `list_creative_formats` (still pending on the v6 typed surface), the `accounts.resolve(undefined)` fallback for no-account tools, and the discriminated-union shape gotchas (`PreviewCreativeResponse` single-mode `previews[].renders[]` array, `Format.renders[]` `dimensions` object, `BuildCreativeReturn` 4-arm dispatch). Shipped with the same three-gate CI test (strict tsc / storyboard / upstream-traffic) as the signal-marketplace example.
- c626f75: Add `examples/hello_seller_adapter_guaranteed.ts` — a worked, passing reference adapter for the `sales-guaranteed` specialism that wraps an upstream GAM-style ad-server with HITL IO approval over static Bearer auth. Completes the `hello_seller_adapter_*` family alongside `signal_marketplace`, `creative_template`, and `sales_social`. Demonstrates the headline `ctx.handoffToTask(fn)` pattern for guaranteed buys: `create_media_buy` returns an A2A task envelope (`status: 'submitted'`) immediately, the handoff function polls the upstream IO-review task to terminal state, then returns the final `CreateMediaBuySuccess` with `media_buy_id` as the task's terminal artifact. Also covers per-request `X-Network-Code` header injection (the buyer→tenant translation pattern for header-scoped APIs), publisher_properties projection (required minItems: 1 — the example uses the `selection_type: 'all'` catch-all selector), and structured error code surfacing for `MEDIA_BUY_NOT_FOUND` / `PACKAGE_NOT_FOUND` / `TERMS_REJECTED`. The main `sales_guaranteed` storyboard passes 9/9 main steps; the cascade scenarios under `media_buy_seller/*` (driven by the storyboard's `requires_scenarios` block) require a `comply_test_controller` wiring that this worked example intentionally omits to keep focus on the HITL pattern — adopters who need full scenario coverage wire `createComplyController` separately. Shipped with the same three-gate CI test (strict tsc / main-storyboard pass / upstream-traffic) plus a documented allowance for cascade-scenario failures.
- c626f75: Add `examples/hello_seller_adapter_social.ts` — a worked, passing reference adapter for the `sales-social` specialism that wraps an upstream walled-garden social platform (Snap, Meta, TikTok shape) over OAuth2 client_credentials. Companion to `hello_signals_adapter_marketplace` and `hello_creative_adapter_template`. Demonstrates the typed-platform `SalesPlatform` + `AudiencePlatform` composition; OAuth token caching via `dynamic_bearer.getToken`; the buyer→upstream id translation pattern (`event_source_id` → upstream pixel_id); the no-account-tool fallback for `log_event` (single-tenant resolver fallback when the wire request omits `account`); the `audience_targeting` + `conversion_tracking` capability declarations that gate the audience and event-source phases on the storyboard runner; and walled-garden CAPI shape (hashed identifier requirement, ISO→UNIX timestamp projection). 10 storyboard steps pass with `overall_status: passing`. Shipped with the same three-gate CI test (strict tsc / storyboard / upstream-traffic) as the signal-marketplace example.
- cb6a942: docs(example): wire BuyerAgentRegistry into hello_signals_adapter_marketplace

  Every seller needs a buyer-agent registry. Updated the worked reference adapter at `examples/hello_signals_adapter_marketplace.ts` to demonstrate the Phase 1 surface (#1269) end-to-end so adopters cloning the example get the full identity story by default rather than a partial scaffold.

  Added:
  - An in-memory `ONBOARDING_LEDGER` (replaces with a Postgres-backed query in production) keyed by `credential.key_id` (the sha256 hash prefix `verifyApiKey` stamps).
  - `BuyerAgentRegistry.cached(BuyerAgentRegistry.bearerOnly({...}))` wired to the platform's `agentRegistry` field — framework runs `resolve()` once per request, status enforcement (`suspended` / `blocked` → 403) fires before any handler.
  - Demonstration site in `accounts.resolve` showing where adopters route tenant resolution against `ctx.agent` (operator-vs-agent gating, allowed_brands cross-checks).

  Test additions to `test/examples/hello-signals-adapter-marketplace.test.js`:
  - Gate 4 asserts unknown api-key tokens are rejected at the auth layer before the registry runs (locks the auth-before-registry order).

  The existing three gates (strict typecheck, storyboard pass, façade traffic) still pass — the registry wiring is implicitly exercised by every storyboard step that authenticates.

- cdfab62: fix(server): auto-seed adapter no longer calls platform.accounts.resolve without authInfo

  PR #1219 had the auto-seed adapter call `platform.accounts.resolve` to derive the namespace key, intending to keep it symmetric with the bridge's `ctx.account?.id` read. Triage flagged the security gap: the comply-controller's `ComplyControllerContext` doesn't expose `authInfo`, so the adapter calls `resolve(ref, { toolName })` with attacker-supplied `account_id` and no auth context. A resolver that maps `account_id` to an internal id without validating `authInfo` would let a caller spoof `account.account_id: 'victim'` and have seeds written into the victim's resolved namespace. That namespace is then visible to the victim's `get_products` (which reads through the framework-authenticated `ctx.account.id`).

  This patch reverts to writing under raw `account.account_id`. The architectural fix — widening `ComplyControllerContext` to expose the framework-resolved account so the adapter can match the bridge's read namespace — remains tracked at #1216.

  **Trade-off**: adopters whose resolver maps `account_id` to a distinct internal id (e.g., `acc_1` → `tenant_a:acc_1`) hit a documented limitation: the adapter writes to `acc_1` but the bridge reads from `tenant_a:acc_1`, so seeded fixtures don't appear in `get_products`. Silent test loss, not cross-tenant pollution. Mapping-resolver adopters can wire explicit seed adapters today (escape hatch unchanged).

  Multi-tenant correctness for identity resolvers (the common case) is preserved — same behavior as before #1219.

- cf631bc: fix(codegen): dedupe inline-enum exports with byte-identical literal sets to a single canonical export, with `@deprecated` aliases for the parent-prefixed variants. Keeps adopters from having to know which parent's copy to import when the spec emits the same enum under multiple object schemas (e.g. `GetBrandIdentityRequest_FieldsValues` ≡ `GetBrandIdentitySuccess_AvailableFieldsValues`). Aliases re-export the canonical's array reference so identity holds; a new test asserts no two distinct array references share a literal set. Closes #941.
- 9f43f5d: feat(codegen): derive `STANDARD_ERROR_CODES` from `manifest.json`

  AdCP 3.0.4 ships `/schemas/{version}/manifest.json` (adcp#3738, closes adcp#3725) — a single canonical artifact carrying 51+ tools with `protocol`/`mutating`/specialism mappings, 45 error codes with structured `recovery`/`description`/`suggestion`, and an `error_code_policy.default_unknown_recovery` block.

  This is the first stage of #1192 (manifest adoption). Replaces the hand-curated `STANDARD_ERROR_CODES` table in `src/lib/types/error-codes.ts` (45 entries, condensed from prose) with one derived directly from the manifest. Drift between SDK and spec is now impossible by construction — re-running `npm run generate-manifest-derived` regenerates the table from the cache.

  What landed:
  - New `scripts/generate-manifest-derived.ts` reads `schemas/cache/{version}/manifest.json` and emits `src/lib/types/manifest.generated.ts` with `STANDARD_ERROR_CODES_FROM_MANIFEST`, per-protocol `*_TOOLS_FROM_MANIFEST` arrays, `SPECIALISM_REQUIRED_TOOLS`, and `DEFAULT_UNKNOWN_RECOVERY`. Wired into `npm run generate-types`.
  - `src/lib/types/error-codes.ts` now imports from the generated file. Public API unchanged: `STANDARD_ERROR_CODES`, `StandardErrorCode`, `ErrorRecovery`, `ErrorCodeInfo`, `isStandardErrorCode`, `getErrorRecovery` all retain their previous shape. New export: `DEFAULT_UNKNOWN_ERROR_RECOVERY`.
  - The `satisfies Record<StandardErrorCode, ErrorCodeInfo>` assertion is preserved; CI catches any drift at typecheck.
  - Pre-existing drift test (`test/lib/standard-error-codes-drift.test.js`) continues to pass.

  Cross-checked: the manifest's 45 codes match the previous hand-curated 45 exactly (no missing codes, no recovery mismatches). Every entry now also exposes `suggestion` where the spec provides one — surfaced through `STANDARD_ERROR_CODES[code].suggestion`.

  What's NOT in this stage (tracked in #1192):
  - Migrating `*_TOOLS` arrays in `src/lib/utils/capabilities.ts` to manifest-derived. The hand-curated arrays cross-list multi-protocol tools (e.g., `list_creative_formats` in both `MEDIA_BUY_TOOLS` and `CREATIVE_TOOLS`); the manifest assigns each tool a single primary `protocol`. Stage 2 needs a design pass on whether to derive cross-listing from `specialisms` or keep manual.
  - Compile-time `RequiredPlatformsFor<S>` extension for specialism→required-tools enforcement.

- e58609a: feat(server): dev-mode warning when `getMediaBuyDelivery` / `getMediaBuys` returns fewer rows than the buyer requested. Catches the canonical `media_buy_ids[0]`-truncation bug class at adapter-development time. Quiet in production (where legitimate misses are routine) and suppressible via `ADCP_SUPPRESS_MULTI_ID_WARN=1` for adopters whose legitimate-miss rate is high. Closes #1399.
- 4a68482: feat(cli): `adcp storyboard run --no-sandbox` now signals adopters to bypass internal sandbox routing

  Closes #841. The existing `--no-sandbox` flag set `account.sandbox: false` (a value), but agents that branch on env vars, brand-domain heuristics, or fixture substitutes still routed sandbox-shaped responses despite the production flag. Compliance passes against the sandbox path; buyer agents break against prod. (Surfaced empirically by `scope3data/agentic-adapters#100`.)

  `--no-sandbox` now ALSO stamps `ext.adcp.disable_sandbox: true` on every outgoing request. Adopters that read this field bypass internal sandbox routing and exercise their real adapter path. Agents that don't recognize the field ignore it (`ext` is accepted-without-error per AdCP 3.0 spec).

  Programmatic callers of `runStoryboard` can pass `disable_sandbox: true` in `StoryboardRunOptions` to get the same behavior without the flag. The pair (`sandbox: false` + `disable_sandbox: true`) is the strongest "production path only" signal the SDK can send.

  The agent-side disclosure piece (surfacing "sandbox-masked: test did not exercise real handler" in reports when the agent's own heuristic still fires) is intentionally scoped out — a separate design discussion.

- ff9ff8d: chore(server): re-export `createOAuthPassthroughResolver` from `@adcp/sdk/server`. Aligns with the other decisioning-platform adopter helpers (`composeMethod`, `definePlatform*`, `resolve` presets, `InMemoryImplicitAccountStore`) so adopters writing a Shape B `accounts.resolve` don't have to remember the split between root and `/server`. Root export from `@adcp/sdk` remains for backwards compatibility.
- 6ce1bd6: fix(security): extend `transport.maxResponseBytes` cap to OAuth token endpoint and authorization-server metadata discovery. `exchangeClientCredentials` and `discoverOAuthMetadata` now wrap their `fetch` with the same size-limit guard that protects MCP/A2A response paths, closing a buffer-bomb surface where a hostile token endpoint or `.well-known` metadata response could exceed the configured cap. Pass-through when no `withResponseSizeLimit` slot is active. Closes #1175.
- e7f8e22: `compactUnionErrors` now excludes `oneOf` variants that emitted a `not` keyword failure when picking the "best surviving variant." A variant that failed via `not: { required: [...] }` rejected the payload by design — the adopter's actionable lever is the OTHER variant's residuals (missing required they need to add), not the path the `not` clause closed. Closes #1337.

  Concretely: for `get_account_financials` Success-vs-Error oneOf where the payload populates the Success-only fields but is missing `currency` / `timezone`, the validator now surfaces "missing required property `currency`" pointing at the Success variant (`#/oneOf/0/required`) instead of the unactionable "must NOT be valid" (`#/oneOf/1/not`) plus "must have required property `errors`" from the Error variant. Same diagnostic shape applies to every Success/Error response oneOf in AdCP 3.x (which is most of them).

  If every variant has a `not` failure (contrived schema), the picker falls back to the existing fewest-residuals heuristic so degenerate cases still produce a diagnostic.

- 53bc98a: fix(server): per-account SeedFixtureCache scoping for multi-tenant servers

  The comply-controller's `SeedFixtureCache` previously keyed by `seed_<scenario>:${id}` (process-wide). Two sandbox accounts on one server (e.g., a single-tenant server with multiple sandbox accounts, or a multi-tenant host that doesn't shard servers per tenant) couldn't seed the same `id` with divergent fixtures — the second seed returned `INVALID_PARAMS` ("Seed replays must carry an equivalent fixture") even though each account's fixture was internally consistent.

  `handleTestControllerRequest` now extracts `account.account_id` from the input envelope and prefixes the cache key with it. Same-account replays still hit the equivalent-fixture path (returns `Fixture re-seeded (equivalent)`); cross-account same-id divergent fixtures now succeed cleanly.

  Backward-compatible: requests without `account.account_id` still use unscoped keys, preserving existing behavior for adopters who don't pass account refs into seed calls.

  Closes #1215.

- b5e62a4: fix(seller skill + sales-guaranteed mock seed): align with `sales_guaranteed` storyboard fixtures.

  **Mock seed** (`src/lib/mock-server/sales-guaranteed/seed-data.ts`) — adds `acmeoutdoor.example` and `pinnacle-agency.example` networks (with ad units + products). The `sales_guaranteed` storyboard sends fixtures with these publisher domains; the prior seed only had `premium-sports.example`, so blind agents saw 404 on every `_lookup/network` and were forced into a fallback that contradicted the skill's "fail closed on 404" advice. Adapter authors who fork the published mock now resolve cleanly.

  **Seller skill row** (`skills/build-seller-agent/SKILL.md`) — collapses the `sales-guaranteed` specialism row to a one-sentence summary that points at the companion file. The prior wording said "Do NOT return media_buy_id or packages yet" without the qualifier "for the IO-approval path"; blind agents read this as universal advice and returned task envelopes for every `create_media_buy`, failing 5 storyboard steps on the synchronous branches. The companion file (`specialisms/sales-guaranteed.md`) already had the correct three-path table; this just stops the SKILL.md row from contradicting it.

  Tracked at adcontextprotocol/adcp#3821 (skill ↔ storyboard contradiction) and adcontextprotocol/adcp#3822 (fixture seed misalignment).

- a983d83: docs(skills): add `skills/SHAPE-GOTCHAS.md` covering the five discriminated-union and embedded-shape patterns adopters consistently get wrong on first pass (ActivationKey, SignalID, VASTAsset, PreviewCreativeResponse, BuildCreativeReturn). Linked from `build-seller-agent`, `build-creative-agent`, `build-signals-agent` SKILL.md preambles. No code change; documentation lives under `skills/**/*` which ships in the npm package, hence the patch bump.
- 866cb63: fix(server): specialism validator uses authoritative manifest data only (no reverse-mapping)

  Follow-up to #1306. The original `generate-manifest-derived.ts` reverse-mapped from `manifest.tools[*].specialisms[]` when the spec's direct `manifest.specialisms[id].required_tools` was empty. That triggered false warnings on legitimate adopters: the `hello_signals_adapter_marketplace` example (a pure signal-marketplace seller exposing only `get_signals` / `activate_signal`) emitted three "missing method" warnings for `sync_accounts` / `sync_governance` / `sync_plans` — tools associated with the `signal_marketplace` specialism in the manifest's tool→specialism mapping but not actually required to claim the specialism.

  The semantic distinction matters: `manifest.tools[*].specialisms[]` captures "tool associated with specialism" (e.g., the spec mentions sync_accounts in signal-marketplace context), while `manifest.specialisms[*].required_tools` captures "tool required to claim specialism." Reverse-mapping conflated the two.

  Changes:
  - `scripts/generate-manifest-derived.ts`: drop reverse-mapping. `SPECIALISM_REQUIRED_TOOLS` is now sourced ONLY from `manifest.specialisms[*].required_tools` (authoritative spec field). 3.0.4 ships every specialism with `required_tools: []`, so the table is empty — the validator becomes a no-op until the spec authors populate authoritative lists in a future release.
  - `src/lib/server/decisioning/validate-specialisms.ts`: add an optional `requiredToolsLookup` parameter to `validateSpecialismRequiredTools` so tests can inject synthetic data without depending on manifest state. Production callers omit it and get the manifest-derived (currently empty) lookup.
  - `test/lib/validate-specialisms.test.js`: tests now use a `SYNTHETIC_REQUIREMENTS` map injected via the new parameter, so coverage isn't tied to whether the manifest happens to have populated `required_tools` for any specialism. Added a sanity test asserting the default lookup is no-op in 3.0.4 — when the spec populates the field, that test will fail and prompt a refresh.
  - `CLAUDE.md`: add the `governance-aware-seller` specialism row that was missing from the table (flagged in #1306 review).

  This finalizes #1192's stage 3 infrastructure. The runtime check is wired through `createAdcpServerFromPlatform`; the data source is conservative (only fires on what the spec authoritatively says is required); the activation path is automatic on next manifest sync after the spec populates `required_tools`. Closes the manifest-adoption umbrella issue #1192.

- 03a2bdb: Storyboard runner: ensure synthetic `AccountReference` natural-key refs always carry `operator` so a strict-validating seller can't reject them. Closes #1419.

  The natural-key arm of `AccountReference` requires `operator` per `core/account-ref.json`. Three runner-side synthesis sites could previously produce `{brand, sandbox}` without `operator` — the SDK's loose runtime decoder hid the gap, but a spec-conformant seller running schema-strict validation would reject the ref:
  - `applyBrandInvariant` (`runner.ts`) — when merging brand into a fixture's natural-key account, default `operator` to `brand.domain` if absent.
  - `comply_test_controller` enricher (`request-builder.ts`) — when `context.account` was a natural-key ref missing `operator`, default to `brand.domain` before forcing `sandbox: true`.
  - `sync_accounts` context extractor (`context.ts`) — drop `operator` from the propagated account ref when the response leaves it undefined, instead of writing `operator: undefined` (which `JSON.stringify` silently strips on the wire). The `{account_id}` arm and adopter-supplied operators are unaffected.

- 797cdae: `tasks_get` now resolves the calling `BuyerAgent` (when an `agentRegistry` is configured) and threads it to `accounts.resolve` as `ctx.agent` — same contract as every other AccountStore call site after #1315 + #1321.

  The custom-tool path historically bypassed `BuyerAgentRegistry.resolve` because it sits outside the dispatcher's main handler-dispatch flow, leaving adopters' resolve impls to see `ctx.agent: undefined` on `tasks_get` calls but populated on every other tool. That asymmetry quietly broke the "use `ctx.agent` for principal-keyed gates" guidance the JSDoc on `upsert?` / `reportUsage?` / `getAccountFinancials?` adopted in the prior two releases.

  **Status enforcement is deliberately NOT replicated.** A buyer agent suspended _after_ kicking off an HITL task must still be able to poll for terminal state — refusing the poll would strand work with no visibility. Sellers who need hard cutoff implement that policy inside their own `accounts.resolve` (read `ctx.agent.status`, throw `AdcpError`). The dispatcher's main path enforces status at request entry; the polling path does not. Tests pin both behaviors.

  Registry failures during a poll fall through to `agent: undefined` rather than breaking the poll — same defensive shape as the dispatcher.

  No behavior change for adopters who don't read `ctx.agent` from inside their resolver.

- d292fe5: Add DB-driven multi-tenant registry worked example with CI tests for concurrent recheck and unregister semantics; fix stale `MULTI-TENANT.md` skill doc constructor API.

  New exports in `examples/decisioning-platform-multi-tenant-db.ts`:
  - `buildDbMultiTenantRegistry()` — seeds from a DB-shaped async loader; compatible with pg, Prisma, or any async source
  - `adminRegisterTenant()` — register without restart
  - `adminRecheckTenant()` — zero-traffic-gap JWKS recheck after key rotation
  - `adminUpdateTenant()` — unregister + re-register for platform-config updates (brief 503 window documented)
  - `adminUnregisterTenant()` — immediate tenant removal

  `test/examples/decisioning-platform-multi-tenant-db.test.js` CI test covers: strict typecheck gate, startup seeding, concurrent-recheck deduplication, unregister null-return, re-register restore, and the update-gap contract.

  `skills/build-decisioning-platform/advanced/MULTI-TENANT.md` corrected: the previous version showed a non-existent `resolveTenant`/`buildPlatform` callback constructor that never matched the real `createTenantRegistry` API; updated to show `register()` call pattern and health state table.

- 2cb70d6: fix(server): apply credential redactor to tenant-registry wire-projected reasons (closes #1330)

  Stage 4 of #1269 introduced `redactCredentialPatterns` and applied it to the dispatcher's `err.message → details.reason` projections. Code-reviewer flagged additional sites in `tenant-registry.ts` that bypass the redactor — the `TenantStatus.reason` field flows to the wire via the admin router (`GET /tenants/:id`, `POST /tenants/:id/recheck`), and three sites projected upstream `err.message` into the reason without scrubbing.

  Fixes four sites:
  - `src/lib/server/decisioning/tenant-registry.ts:399` — JWKS fetch failure (network errors can echo basic-auth-bearing URLs).
  - `src/lib/server/decisioning/tenant-registry.ts:416` — JSON parse failure on JWKS body.
  - `src/lib/server/decisioning/tenant-registry.ts:834` — adopter validator throw (custom validators may include credential bytes in their error messages).
  - `src/lib/server/decisioning/admin-router.ts:94` — `recheck` route's catch-all 500 handler.

  The redactor scrubs Bearer tokens, JSON-quoted credential properties, unquoted credential properties, URL-embedded basic-auth, and long token-shaped strings. Already-redacted strings pass through unchanged (idempotent), so propagation paths that concatenate upstream reasons (`tenant-registry.ts:850, 856`) are safe automatically.

  4 new tests at `test/server-decisioning-tenant-registry-redaction.test.js` cover Bearer-token redaction, labeled-credential redaction, URL-embedded credential redaction, and benign-error pass-through.

  No behavior change for adopters whose validators don't carry credentials in error messages.

- bd3d98d: chore(typecheck-skill-examples): treat `defineSalesPlatform` / `defineSalesCorePlatform` / `defineAudiencePlatform` / `defineSalesIngestionPlatform` calls as full-module anchors

  Skill snippets that demonstrate platform handler shapes (e.g. `defineSalesPlatform<Meta>({ getProducts: async (req, ctx) => {...} })`) compile standalone with full type inference, but the typecheck harness's `FULL_MODULE_ANCHORS` regex didn't recognize them. Result: those blocks were classified as fragments and skipped — exactly the drift class the harness exists to catch.

  Adding the four `define*Platform` regexes lifts ~2 blocks today (sales-guaranteed and sales-social Forecast / Planning-surface sections) into the compiled set, and gives future doc authors a way to write fragment-shaped snippets that still get typechecked. No baseline churn.

- 4d389a5: fix(client): widen connectMCPWithFallback retry predicate to cover generic transient errors

  Previously the single-retry gate was gated on `instanceof StreamableHTTPError`, which only matched the canonical "Session not found" 400. Network blips, JSON parse errors on half-buffered responses, and mid-handshake proxy disconnects (Cloudflare, Fastly) all surface as generic `Error` or `McpError` and were silently skipped. The predicate is now `!is401Error(error)` — retry on any first-connect failure except auth, where a second attempt is pointless.

- e6e308d: fix(server): drive auto-hydration off spec `x-entity` annotations instead of hardcoded field names. The framework's five hand-rolled per-tool hydration call sites in `from-platform.ts` (`update_media_buy`, `provide_performance_feedback`, `activate_signal`, `acquire_rights`, `update_rights`) collapsed onto a single `hydrateForTool(toolName, params)` helper that walks a codegen-derived `TOOL_ENTITY_FIELDS` map plus a hand-curated `x-entity → ResourceKind` table.

  The annotation acts as a renaming-firewall: if a future spec rename moves `media_buy_id` → `mediabuy_id`, the `x-entity: "media_buy"` tag travels with the field; the codegen step picks up the new field name automatically. The hardcoded `(field_name, ResourceKind)` literals at each call site previously made this scenario silent breakage, flagged by protocol-expert review of #1086.

  `provide_performance_feedback` now also hydrates `req.package` when the buyer scoped feedback to a package (additive — silent no-op until publishers seed `package` records). Other destination field names (`req.media_buy`, `req.creative`, `req.signal`, `req.rights`, `req.rights_grant`) preserved via an explicit override table.

  `creative_approval` (webhook-only payload from #551) is filtered out of the codegen — it's not a dispatchable tool. A regression test asserts every `x-entity` value in `TOOL_ENTITY_FIELDS` is either mapped to a `ResourceKind` or in the documented `INTENTIONALLY_UNHYDRATED_ENTITIES` allowlist, so a future spec entity tag can't silently bypass hydration.

  Closes #1109.

## 6.6.0

### Minor Changes

- a5da93e: feat(cli): `adcp mock-server creative-template` — second specialism in the matrix v2 family

  Adds a Celtra/Innovid/AudioStack-shaped creative platform mock alongside the existing `signal-marketplace` mock. Different multi-tenant pattern (URL-path workspace scoping vs the signals mock's `X-Operator-Id` header), different gotcha (async render lifecycle: `queued → running → complete` via polling).

  Headline characteristics:
  - **Workspace-scoped paths**: `/v3/workspaces/{workspace_id}/...`. Two seeded workspaces (`ws_acme_studio` for `acmeoutdoor.example`, `ws_summit_studio` for `summit-media.example`) with overlapping template visibility — Acme has 4 templates including video preroll; Summit has 3 display-only templates.
  - **Async render pipeline**: `POST /renders` returns 202 with `status: queued`; subsequent GETs progress through `running` → `complete` (or `failed`). Adapters have to poll, not assume sync. Idempotent on `client_request_id` per workspace, with 409 on body mismatch.
  - **Templates as upstream-flavored format catalog**: 4 seeded templates (300x250 medrec, 728x90 leaderboard, 320x50 mobile banner, 15s video preroll). Slot definitions use upstream vocabulary (`slot_id`) rather than AdCP's `asset_role` so the adapter does the projection.
  - **Synthetic output**: rendered HTML / JavaScript / VAST XML by `output_kind`. Plausible-looking but not real — the matrix tests adapter projection, not actual creative rendering.

  Refactors `MockServerHandle` to expose a unified `principalMapping` + `principalScope` shape so the matrix harness can build prompts for either specialism without specialism-specific seed-data introspection. Both signals (`account.operator` → `X-Operator-Id`) and creative-template (`account.advertiser` → `path /v3/workspaces/...`) flow through the same adapter prompt template.

  The matrix harness's `bootUpstreamForHarness` now consumes the unified handle shape; `skill-matrix.json` adds `upstream: "creative-template"` to the build-creative-agent × creative_template pair.

  Run with:

  ```bash
  npx @adcp/sdk mock-server creative-template --port 4501
  # or as part of the skill-matrix:
  npm run compliance:skill-matrix -- --filter creative_template
  ```

  12 new smoke tests in `test/lib/mock-server/creative-template.test.js` cover auth gating, workspace scoping, channel filtering, render lifecycle, idempotency replay, 409 on body mismatch, cross-workspace isolation, malformed JSON / unknown template error paths, VAST output for video templates, and the unified principal-mapping handle shape.

  Refs adcontextprotocol/adcp-client#1155.

- ec19514: feat(cli): `adcp mock-server <specialism>` boots a fake upstream platform fixture for skill-matrix testing

  Adds `npx @adcp/sdk mock-server signal-marketplace` (currently the only specialism), which boots a CDP/DMP-shaped HTTP server modeled on LiveRamp / Lotame / Oracle Data Cloud. The mock represents the _upstream platform an adopter wraps_, not an AdCP-shaped agent — it has its own native API (cohorts/destinations/activations rather than signals/deployments) so skill-matrix runs test whether Claude can map an unfamiliar upstream to AdCP using the SDK + skill, not whether Claude can invent a decisioning platform from scratch.

  Headline characteristics of the `signal-marketplace` mock:
  - **Multi-operator API key pattern** — single `Authorization: Bearer <api_key>` shared across operator seats; per-request `X-Operator-Id` header determines cohort visibility, pricing, and activation scope. Real signal marketplaces all work this way; the mock surfaces the question "where does the SDK want me to put the principal-to-operator mapping?" as a real adopter would surface it.
  - **Two seeded operators** with overlapping cohort visibility — `op_pinnacle` (4 cohorts, all data providers) vs `op_summit` (2 Trident cohorts, +$1 CPM premium rate card). Forces the adapter to genuinely thread the operator from the AdCP `account.operator` field through to the upstream API or fail with empty/wrong data.
  - **Activation lifecycle state machine** — DSP/CTV destinations start `pending`, advance through `in_progress` → `active` on poll; agent destinations are synchronously `active` on create. Idempotent on `client_request_id` per operator (different operators using the same key are independent).
  - **Cross-operator isolation** — fetching another operator's activation returns 403 instead of 404 to prevent existence-oracle probing.

  The matrix harness (`scripts/manual-testing/agent-skill-storyboard.ts`, `run-skill-matrix.ts`) now accepts an optional `upstream` field per pair in `skill-matrix.json`. When set, it boots the mock-server before handing the workspace to Claude and surfaces the OpenAPI spec path + operator mapping table to Claude in the build prompt.

  Run with:

  ```bash
  npx @adcp/sdk mock-server signal-marketplace --port 4500
  # or as part of the skill-matrix:
  npm run compliance:skill-matrix -- --filter signal-marketplace
  ```

  Files added:
  - `src/lib/mock-server/index.ts` — specialism dispatcher
  - `src/lib/mock-server/signal-marketplace/openapi.yaml` — upstream API spec
  - `src/lib/mock-server/signal-marketplace/seed-data.ts` — operators, cohorts, destinations
  - `src/lib/mock-server/signal-marketplace/server.ts` — HTTP handlers
  - `test/lib/mock-server/signal-marketplace.test.js` — 8 smoke tests covering auth, operator scoping, pricing overrides, activation lifecycle, cross-operator isolation
  - `bin/adcp.js` — `mock-server` subcommand routing

  Background and design rationale: adcontextprotocol/adcp-client#1155.

- 245089d: Storyboard runner: per-phase cascade scoping via `phase.depends_on` (#1161).

  Stateful cascade is now scoped per-phase rather than per-storyboard. Phases declare which prior phases they actually depend on for state; only those phases tripping their cascade gates the current phase's stateful steps. Independent phases run normally even when other phases tripped.

  **Field shape**: `phase.depends_on?: string[]` on `StoryboardPhase`. Default semantics (field absent) preserves the storyboard-scope behavior — implicit "depends on all prior phases." Backward-compatible with every existing storyboard, including the F6 round-2 cross-phase pattern (`signal_marketplace/governance_denied`).

  **Two new modes**:
  - `depends_on: []` declares the phase independent. Runs even if every prior phase tripped its cascade. Use for phases whose state derives from the request body alone (e.g., `audience_sync` carrying its own account ref via `brand`+`operator`) rather than from prior-phase state.
  - `depends_on: ['phase_id', ...]` declares targeted dependencies. Only the named phases gate this phase's cascade; other tripped phases are irrelevant.

  **Within-phase cascade preserved**: stateful steps later in a phase still cascade-skip when an earlier stateful step in the same phase trips. Intra-phase state dependency is a storyboard authoring intent that `depends_on` (which scopes inter-phase cascade) doesn't override.

  **Loader validation**: forward references, self-references, and unknown phase IDs in `depends_on` fail loud at parse time. Empty list (`[]`) is legal.

  **Companion spec issue**: needs to be filed at `adcontextprotocol/adcp` to add the field to the storyboard schema and audit each specialism storyboard for which phases are functionally independent (notably `sales-social` where `audience_sync` / `creative_push` / `event_setup` / `event_logging` / `financials` are arguably independent of `account_setup` for explicit-mode platforms — the citrusad-shape 1/9/0 case).

  Diagnostic improvement: cascade-detail messages now reference the trigger from the specific dependency phase rather than a storyboard-scope first-trip, so reports show which dependency actually gated the skip.

### Patch Changes

- 84e25f1: fix(types): add `'advertiser'` to `DecisioningCapabilities.supportedBillings`

  The `billing-party` schema enum allows `'operator' | 'agent' | 'advertiser'`, but the TypeScript type only declared the first two. Adopters building platforms that bill advertisers directly (Google Ads direct, Meta direct, retail-media-adjacent) could not declare this billing model via the typed interface. The runtime projection (`from-platform.ts`) already passes the value through verbatim, so this is a type-only fix.

- 49747d5: feat(server): catalog-backed auto-seed for comply_test_controller

  When `createAdcpServerFromPlatform` is called with `complyTest` and a sales
  platform that wires `getProducts`, but without explicit `seed.product` or
  `seed.pricing_option` adapters, the framework now auto-derives those adapters
  from an in-memory store and wires a `testController` bridge so seeded products
  appear in `get_products` responses on sandbox requests.

  This removes the footgun where LLM-generated platforms fail comply storyboards
  because the slim skill guide doesn't mention that `seed_product` requires an
  explicit adapter. Publishers wiring `getProducts` now get free comply-sandbox
  seeding without writing any seed adapter code.

  The store is keyed by `account.account_id` so two sandbox accounts on the
  same server (multi-tenant TenantRegistry hosts, or single-tenant servers with
  multiple sandbox accounts) never share a seed namespace. Adopters who need
  tighter scoping (per-session, per-brand) wire `bridgeFromSessionStore`
  explicitly.

  Explicit `seed.product` / `seed.pricing_option` adapters and explicit
  `testController` bridges always take priority — the auto-seed is only applied
  when neither is present.

- 14f011c: fix(server): default `account.supported_billing` to `['agent']` in `createAdcpServerFromPlatform`

  When the v6 framework emits the `account` block in `get_adcp_capabilities` (because the platform declares `requireOperatorAuth: true` or `accounts.resolution: 'explicit'`), the schema requires `account.supported_billing` to be present with `minItems: 1`. The framework was spreading the field conditionally (`...(supportedBillings?.length && { supported_billing: [...] })`), which dropped the field entirely when adopters didn't declare `supportedBillings`. The capabilities response then failed schema validation.

  Worse, downstream tooling (storyboard runner) auto-downgrades agents to "v2 synthetic capabilities" when capabilities probe fails, which cascades into every subsequent step erroring with "AdCP schema data for version v2.5 not found." One missing field collapsed entire storyboard runs.

  Fix: when emitting the `account` block, always include `supported_billing`, defaulting to `['agent']` when adopters don't declare. `'agent'` (agent consolidates billing) matches the platform-interface contract documented at `src/lib/server/decisioning/capabilities.ts:130` ("Defaults to `['agent']` when omitted") and is the least-surprising default for non-media-buy specialisms (signals/creative/governance/etc.).

  Surfaced empirically by the matrix v2 mock-server run on adcontextprotocol/adcp-client#1185. Closes adcontextprotocol/adcp-client#1186.

  Adopters declaring `supportedBillings: ['operator', 'agent']` (or any non-empty subset) are unaffected — the projection still flows their declared values. Only adopters who omitted the field were exposed to the schema-validation regression; those will now pass with the spec-correct `['agent']` default.

  Related upstream issue: adcontextprotocol/adcp#3746 (make `supported_billing` conditional on `supported_protocols.includes('media_buy')` at the schema level — the principled fix). This SDK change is the defensive default until the spec change lands.

- 27bd79d: fix(client): don't downgrade obvious v3 agents to v2 on a single capabilities-validation failure

  `SingleAgentClient.getCapabilities()` had a coarse v2-fallback heuristic: if `get_adcp_capabilities` was advertised but the call returned `success: false` for any reason, fall back to v2 synthetic capabilities. That's wrong when the agent is clearly a v3 agent that just has a wire-shape bug (e.g., a single missing required field that fails strict schema validation but otherwise returns a fully v3-shaped response).

  When the fallback fired, the SDK marked the agent as v2.5, downstream tooling asked for v2.5 schemas (not shipped — only 3.0.x is bundled), and every subsequent step errored with `"AdCP schema data for version v2.5 not found"`. One missing field cascaded into total storyboard failure with errors that had nothing to do with the original problem.

  Fix: tighten the fallback heuristic. When `result.success === false` but `result.data` is **structurally v3-shaped**, parse it anyway, surface the validation failure loudly, and continue with v3 capabilities. The agent has a wire-shape bug to fix; downgrading to v2 hides that.

  The new `looksLikeV3Capabilities()` helper (exported from `@adcp/sdk` via `src/lib/utils/capabilities.ts`) checks for affirmative v3 signals:
  - Presence of the `adcp` envelope block
  - Presence of `supported_protocols` (v3-only top-level field)
  - Presence of any v3 protocol-level capability block (`account`, `media_buy`, `signals`, `creative`, `brand`, `governance`, `sponsored_intelligence`, `compliance_testing`)

  Empty / null / non-object responses still fall back to v2 (the existing heuristic — preserved). v2 agents that genuinely don't have any v3 surface in their response continue to be detected correctly.

  Surfaced empirically by the matrix v2 mock-server run on adcontextprotocol/adcp-client#1185, where Claude built a v3 signals agent with a single missing field (`account.supported_billing`) that the runner's old fallback turned into a cascade of confusing v2.5 errors. Closes adcontextprotocol/adcp-client#1189.

  Pairs with the related v6 framework default fix (#1198 / #1186 — default `supported_billing: ['agent']`). With both fixes, the most common cause of the cascade is gone (#1198), and the runner stops compounding any remaining cause into a confusing v2.5 failure (#1189). Each change stands alone; together they remove one of the gnarliest brittleness patterns in the matrix harness.

- 53adf51: Decisioning: `RefreshConfig` propagates `TCtxMeta` to refresh hooks (#1168).

  `AccountStore.refreshToken` is documented as receiving `Account<TCtxMeta>`, but the framework's internal `RefreshConfig` boxed the account through `Account<unknown>`, collapsing the parameterization at the `runWithTokenRefresh` boundary. Adopter hooks reading `account.ctx_metadata.upstreamRefreshToken` (etc.) saw `unknown` instead of their typed shape — the access compiled, but typo protection didn't surface.

  Parameterized `RefreshConfig<TCtxMeta>` and threaded the generic through `runWithTokenRefresh<TCtxMeta, T>` and `projectSync<TResult, TWire, TCtxMeta>`. TypeScript now infers `TCtxMeta` from the dispatch site (`accounts.refreshToken.bind(accounts)` carries the AccountStore generic through), so adopter `refreshToken` impls receive a properly-typed Account.

  Defaults to `unknown` for call sites that don't thread the generic — backward-compatible. Surfaced by code-reviewer on adcp-client#1165's review pass.

## 6.5.0

### Minor Changes

- e114e3a: Reverts #1142, removing `storyboardContext?: StoryboardContext` from `AssertionContext` and the per-step / final-step shallow-copy threading in the runner.

  The field was preemptive surface with no consumer. None of the bundled invariants (`status.monotonic`, `idempotency.conflict_no_payload_leak`, `context.no_secret_echo`, `governance.denial_blocks_mutation`) read it; programmatic assertions already accumulate cross-step state through `ctx.state` (which is exactly how `status.monotonic`'s `history` works). Issue #1140 was about YAML validators (the `check:` clause), not assertion handlers — that scope is fully covered by #1141 (`field_less_than` / `field_equals_context` reading from `ValidationContext.storyboardContext`). The asymmetry is correct: declarative validators need context exposure, imperative assertions don't.

  Custom invariants that need cross-step state should continue using `ctx.state` (set in `onStart`, mutated in `onStep`, read in `onEnd`).

  Breaking-shape change to a public optional field, shipped as minor while 6.x is still in its breaking phase. Window-of-removal is hours old — the field landed in 6.4.0, no docs advertised it, no third-party consumer has had time to depend on it.

## 6.4.1

### Patch Changes

- 4fada67: `executeTask` now returns a structured `TaskResult` instead of throwing for pre-flight errors (fixes #1148).

  **Symptom:** `agent.executeTask('list_authorized_properties', {})` against a v2.5 MCP seller threw `TypeError: Cannot read properties of undefined (reading 'status')` instead of returning `{ success: false, status: 'failed', error: '...' }`.

  **Root cause:** `SingleAgentClient.executeTask` (the public generic path used for tasks without a named wrapper) had no top-level try/catch. Pre-flight steps — feature validation, endpoint discovery, schema validation, version detection, and request adaptation — could escape as raw exceptions. The internal `TaskExecutor.executeTask` already wraps network-layer errors; `SingleAgentClient` had no matching safety net for the steps it runs before delegating to the executor.

  `list_authorized_properties` is the common trigger because it has no named helper method on `AgentClient` (deprecated in favour of `get_adcp_capabilities`) so all callers go through `executeTask`. On a v2.5 MCP seller, the response shape is unexpected and a TypeError escapes during pre-flight processing.

  **Fix:** Wrap the full `SingleAgentClient.executeTask` body in a try/catch. Structured protocol errors that carry typed fields callers use for recovery decisions are rethrown: `AuthenticationRequiredError` (and its subclass `NeedsAuthorizationError`), `TaskTimeoutError`, `VersionUnsupportedError`, and `FeatureUnsupportedError`. Unexpected errors (TypeErrors, schema-parser panics, etc.) are converted to `{ success: false, status: 'failed', error: message }` envelopes matching the declared return type `Promise<TaskResult<T>>`. The fluent `.match()` method works correctly on error envelopes via `attachMatch`.

  Callers that followed the TypeScript return type and checked `result.success` / `result.status` are unaffected. Callers that relied on `executeTask` throwing for non-protocol pre-flight errors will now receive a structured failure envelope instead — which is the correct behaviour per the declared type.

- 49a6ec3: Fix storyboard runner cascade over-firing for sole-stateful-step phases (adcp-client#1144).

  The F6 cascade-skip fix (6.1.0) deferred `not_applicable` cascade decisions to phase end, checking whether any peer stateful step established substitute state. This worked for snap (`sync_accounts: not_applicable` + `list_accounts: passes`) but still cascaded for adapters with a single stateful step in the phase and no peer-substitute (citrusad, amazon, criteo, google showing `1/9/0` on `sales_social`).

  The cascade now only fires when the phase contained **other stateful peer steps** that could have established substitute state but didn't. When the `not_applicable` step is the sole stateful step in the phase, no cascade fires — the platform manages state implicitly through a different model, which is valid per AdCP protocol semantics.

- f397f9e: Fix v2.5 response validator spuriously rejecting null on optional envelope fields.

  v2.5 sellers built on Pydantic commonly emit `errors: null`, `context: null`, and `ext: null` to signal "nothing here" rather than omitting the key. After #1137 pinned `validateResponseSchema` to the detected server version, Ajv correctly validated these responses against the v2.5 schema — but the v2.5 schemas declare those fields as `type: 'array'` or `type: 'object'` without a `null` union, so every such response failed with `/errors: must be array; /context: must be object; /ext: must be object`.

  The fix adds a `stripEnvelopeNulls` pre-processing step inside `validateResponse` that strips top-level optional fields whose value is `null` but whose declared schema type is not nullable. Gated to v2.x schema bundles only — in v3, `errors` is a required field on failure branches and must not be silently dropped.

  Surfaced against Wonderstruck (v2.5 MCP) by `scripts/smoke-wonderstruck-v2-5.ts` (issue #1149).

## 6.4.0

### Minor Changes

- e76ab7d: Add `field_less_than` and `field_equals_context` cross-step comparison validators to the storyboard runner.

  These two new `StoryboardValidationCheck` kinds let storyboard authors assert relationships between a current-step response field and a value captured from an earlier step via `context_outputs`. The runtime accumulator is the existing `storyboardContext` (option 2 / context-outputs style), consistent with the `refs_resolve` validator precedent.
  - **`field_less_than`** — asserts a numeric field is strictly less than a comparand. The comparand is either a runtime context value (`context_key`) or a literal (`value`). Emits a type error if either operand is non-numeric; passes with a `context_key_absent` observation if the referenced context key was never populated (prior step may have been legitimately skipped on a branch-set path).
  - **`field_equals_context`** — asserts a field deep-equals a context-captured runtime value. Requires `context_key`. Same skip-with-observation behavior when the key is absent.

  Both validators require `path`. Both add `context_key?: string` to `StoryboardValidation` (ignored by all other check types).

  Enables the runner side of adcp#2642, which adds these check kinds to the universal storyboard schema enum once this lands.

- 7b804ea: feat(conformance): expose per-step accumulated context in AssertionContext for cross-step comparison validators

  Adds `storyboardContext?: StoryboardContext` to `AssertionContext`. The runner
  now threads the accumulated context (all prior steps' `context_outputs` and
  convention-extracted values) into every assertion's context object before each
  `onStep` call, using the Option 2 / context-outputs style (same key namespace
  as `$context.*` placeholders and `context_outputs` entries).

  Assertion implementations can now read `ctx.storyboardContext?.['my_key']` to
  compare values from a prior step against the current step's result. Missing
  keys return `undefined`; individual assertion handlers decide whether to skip
  or fail on absence.

  Implements the runner side of adcp-client#1140 / adcontextprotocol/adcp#2642.

### Patch Changes

- 5d98910: Fix storyboard runner cascade over-applying `prerequisite_failed` to steps independently `not_applicable` or `missing_tool` (adcp-client#1169).

  When an upstream stateful step trips the cascade, the runner now evaluates each downstream stateful step's intrinsic skip-eligibility **before** applying the cascade reason. If the agent never advertised the step's tool, the step is classified as `missing_tool` (`passed: true`) rather than `prerequisite_failed` (`passed: false`). This makes the storyboard report honest for agents with reduced specialism surfaces: `missing_tool` means "this agent doesn't claim this surface, by design", while `prerequisite_failed` means "this agent has a real setup bug affecting state that should have materialized."

- b8c0872: Use `DEFAULT_REPORTING_CAPABILITIES` in decisioning-platform worked examples and SKILL.md quickstart. Updates `broadcast-tv`, `mock-seller`, and `programmatic` examples to import and reference the exported constant rather than hand-rolling `reporting_capabilities` inline. Adds the constant to the `build-decisioning-platform` imports cheat sheet and `getProducts` product literal so codegen agents produce schema-valid products on first try.
- 2e0cb46: Cross-link the merged spec decision (adcp#3742, "synchronous response bodies are not signed — by design") in `TenantConfig.signingKey`'s JSDoc, and add a "Self-signed dev path" recipe to `docs/guides/SIGNING-GUIDE.md`.

  The field's prior doc described the signing scope as "RFC 9421 response signing" — that wording predated the spec decision and didn't match what the SDK actually does. Updated to reflect: scope is webhook-signing only; the synchronous tools/call reply is not signed at the body level by deliberate design (TLS for sync, signed webhooks for async); adopters needing attestable artifacts for synchronous flows use the request-the-webhook pattern. Doc points at `docs/building/understanding/security-model.mdx` § "What gets signed — and what doesn't" for the canonical reasoning.

  The signing guide now carries the worked recipe for the multi-tenant self-signed dev loop: `createTenantRegistry` + `createSelfSignedTenantKey()` + `createNoopJwksValidator()` (gated to `NODE_ENV` ∈ {test, development} unless `ADCP_NOOP_JWKS_ACK=1`). Production promotion path covered (publish JWK to brand.json, swap in-memory key for KMS-backed `SigningProvider`). Plus the omit-key path for adopters who aren't ready to sign yet.

  No behavior change.

- 3a9b7fe: Fix `adaptSyncCreativesRequestForV2` to pass the role-keyed `assets` manifest through unchanged.

  PR #1118 introduced a flatten step that extracted the first role's asset from the manifest and passed it as a flat payload (`{ asset_type, url, … }`). This was incorrect: the v2.5 `creative-asset.json` schema declares `assets` using `patternProperties` keyed by role string — the same manifest shape v3 uses — so the flat output failed v2.5 schema validation on every field. The adapter now passes `assets` through verbatim, and the `sync_creatives` conformance fixture in `adapter-v2-5-conformance.test.js` has been updated from an `expected_failures` pin to a standard passing assertion.

- 9cf9f9a: transport.maxResponseBytes hygiene: thread per-call override through TaskExecutor secondary call sites, rename ResponseTooLargeError field, add MCP integration test. Closes #1177.
  - `TaskExecutor.getTaskStatus`, `listTasksForAgent`, `listTasks`, `getTaskList`, `continueTaskWithInput`, and
    `pollTaskCompletion` now accept a per-call `transport?` override that beats the constructor-level cap.
    `SubmittedContinuation.track` exposes the per-call override; `waitForCompletion` inherits the
    transport cap from task-submission time (intentional — polling loops run an indefinite number of
    requests and a per-loop override would be a footgun).
  - `ResponseTooLargeError.declaredContentLength` renamed to `contentLengthHeader` (pre-release fix;
    the field was introduced in the same release cycle and has zero published consumer surface).
  - `test/unit/mcp-tool-size-limit.test.js` — end-to-end integration test proving the cap fires through
    `ProtocolClient.callTool` → `connectMCPWithFallbackImpl` → `wrapFetchWithSizeLimit` for the
    non-OAuth MCP path.

## 6.3.0

### Minor Changes

- 89af100: Make `TenantConfig.signingKey` optional + auto-wire it into webhook signing.

  The SDK was stricter than the AdCP 3.x spec: `signed-requests` is a preview specialism and CLAUDE.md § Protocol-Wide Requirements explicitly classifies RFC 9421 HTTP Signatures as "optional but recommended." Adopters were forced to fabricate a `TenantSigningKey` (and stand up a published `/.well-known/brand.json`) before they could even register a tenant — and even then, the field's privateJwk wasn't auto-plumbed into the actual webhook signing pipeline, so adopters had to wire the same key TWICE (once on `TenantConfig.signingKey` for JWKS validation, once on `serverOptions.webhooks.signerKey` for outbound signatures).

  This change does two things:

  **1. `signingKey` is now optional.** When omitted, `runValidation` skips the JWKS roundtrip entirely and the tenant transitions straight from `pending` to `healthy` with `reason: 'unsigned (no signingKey)'`. AdCP 3.x treats request signing as optional, so adopters spiking the SDK before standing up KMS or publishing brand.json can ship without signing material. AdCP 4.0 will flip this back to required.

  **2. When `signingKey` IS set, the registry auto-wires it into outbound webhook signing.** The privateJwk now flows into `serverOptions.webhooks.signerKey` automatically. Set the key once on `TenantConfig`, get JWKS validation + signed webhooks. Strict on `adcp_use`: the JWK MUST carry `adcp_use: "webhook-signing"` per AdCP key-purpose discriminator (adcp#2423). Adopters who wire their own webhook signer on `serverOptions.webhooks` (KMS-backed, distinct keys per tenant, etc.) pass through unaffected — explicit config wins and auto-wiring is skipped.

  Supported JWK shapes for the auto-wire path: Ed25519 (`kty=OKP, crv=Ed25519`) and ECDSA P-256 (`kty=EC, crv=P-256`). RSA / EC P-384 throw with a remediation hint at register time.

  Two helpers ship alongside:
  - **`createSelfSignedTenantKey({ keyId? })`** — generates an Ed25519 keypair via `jose` and returns a `TenantSigningKey` already tagged with `adcp_use: "webhook-signing"` so it passes the auto-wire assertion out of the box. No env gating; generating a keypair isn't dangerous.
  - **`createNoopJwksValidator()`** — validator that always returns `{ ok: true }`. Refuses to construct outside `NODE_ENV` ∈ {`'test'`, `'development'`} unless the operator sets `ADCP_NOOP_JWKS_ACK=1`. Mirrors the `idempotency: 'disabled'` allowlist gate — `NODE_ENV` defaults to unset in raw Lambda / custom containers / many K8s deployments, so a `=== 'production'` check would no-op in exactly the environments where a silent skip-validation start is most dangerous. The ack value must be the literal string `'1'`; `'true'` / `'yes'` lookalikes intentionally don't satisfy.

  Migration: existing adopters who pass an Ed25519 / EC P-256 `signingKey` need to add `adcp_use: "webhook-signing"` to both `publicJwk` and `privateJwk`. Adopters with RSA keys must rotate to Ed25519 / EC P-256 (RSA isn't in the AdCP signing-algorithm set) OR wire their webhook signer explicitly on `serverOptions.webhooks` to bypass the auto-wire.

  Migration note added to `docs/migration-5.x-to-6.x.md` § Common gotchas. New describe blocks in `test/server-decisioning-tenant-registry.test.js`: "unsigned tenants" (3.x optional path), "createSelfSignedTenantKey", "createNoopJwksValidator — NODE_ENV allowlist", "webhook-signing auto-wire" (auto-wire happy path + adcp_use enforcement + explicit-override bypass).

- d0e2fe6: Storyboard runner: declared peer substitution + AccountStore: ctx.account threading + refreshToken hook.

  **AccountStore — `AccountToolContext<TCtxMeta>` (#1145 Gap 1).** New strict-superset of `ResolveContext` carrying the resolved `Account<TCtxMeta>`. `getAccountFinancials` now receives `(req, ctx: AccountToolContext<TCtxMeta>)` so adopters fronting an upstream platform can read tokens / upstream IDs from `ctx.account.ctx_metadata` without re-resolving. Resolves the 7-adapter pain point where `getAccountFinancials` was stubbed to `UNSUPPORTED_FEATURE` solely because the v6 surface didn't thread the resolved account through. Breaking change for v6.x adopters who already implemented `getAccountFinancials` — update the second arg type to `AccountToolContext<TCtxMeta>` and read `ctx.account.ctx_metadata` directly. Resolve-step null surfaces `ACCOUNT_NOT_FOUND` (terminal) before the platform method runs.

  **AccountStore — `refreshToken` hook (#1145 Gap 2).** Optional `refreshToken(account, reason: 'auth_required'): Promise<{ token; expiresAt? }>`. When defined and a platform method throws `AdcpError({ code: 'AUTH_REQUIRED' })`, the framework refreshes via this hook, mutates `account.authInfo.token`, and retries the platform method exactly once. In-flight scope only — refreshed tokens are not echoed back to the buyer. Refresh-hook failure surfaces correctable `AUTH_REQUIRED` so the buyer re-links via their UI flow. Resolves UniversalAds' v5-OAuth-provider workaround. Wired into `getAccountFinancials` dispatch; broader call-site wiring (sales / creative / audience methods) is incremental work — adopters can request additional sites as they hit the issue.

  **Storyboard runner — `peer_substitutes_for` (#1144).** Stateful steps can opt into substitute-aware cascade deferral by declaring `peer_substitutes_for: <step_id> | <step_id>[]` on the substitute step. When a stateful step skips with `missing_tool` / `missing_test_controller` AND a peer in the same phase declares it as a substitute, the runner defers the cascade decision to phase end and waives it iff the declared substitute passes. Cascade-detail messages now name the declared substitute that didn't pass when the substitution chain fails, so adopters reading skip reports see the substitution chain rather than a bare `missing_tool` cascade origin. Loader rejects cross-phase references, self-references, and non-stateful targets at parse time.

  This is **contract hygiene + diagnostic improvement** rather than a fix for any specific failing adopter — it tightens the implicit "phase membership = substitutability" rule that the F6 fix relied on, replacing it with explicit declaration so future storyboards with multi-stateful-step phases can't silently rescue non-substitutes. The legacy `not_applicable` any-peer rescue is unchanged for backward compat. Without a `peer_substitutes_for` declaration, missing reasons keep tripping the cascade immediately.

  The companion spec change at `adcontextprotocol/adcp` (storyboard schema field + `sales-social/index.yaml` edit) is required before any storyboard exercises the new path.

- e0b08d2: Adds `'silent'` to `TrackStatus` so the compliance grader can distinguish a track that observed real lifecycle transitions from one that ran with zero observations. Closes #1139, paired with adcontextprotocol/adcp#2834 on the grader-side rendering.

  `status.monotonic` (and other observation-based invariants) today report `passed: true` whether they validated three transitions or none. That collapses two different states behind one icon: real protection vs. wired-but-not-exercised. Tracks like `property-lists`, `collection-lists`, and `content-standards` — where the invariant is wired eagerly but no current phase exercises a lifecycle-bearing resource — render as green checks even though no protection was actually asserted.

  Three changes land together:
  - `TrackStatus` widens to `'pass' | 'fail' | 'skip' | 'partial' | 'silent'`. A track is silent when every observation-bearing assertion record reports `observation_count: 0` and nothing failed. Skip/fail/partial precedence is preserved — silent only triggers on otherwise-clean runs.
  - `AssertionResult.observation_count?: number` carries the run-level count from observation-based invariants. `status.monotonic` now defines an `onEnd` hook that emits a single record with `observation_count: history.size`, giving the rollup a deterministic signal whether to demote.
  - `ComplianceSummary.tracks_silent` and an updated `formatComplianceResults` render silent rows distinctly (`🔇`, "no lifecycle observed") instead of the green check.

  `computeOverallStatus` treats silent tracks as `attempted` (they ran) but never as unambiguously `passing` — a run with any silent track surfaces as `partial`. `computeOverallStatus` tolerates summaries serialized before this release (registry cache, fixtures) by defaulting `tracks_silent` to `0` when absent.

  Why widen the union instead of adding `observable: boolean` on `AssertionResult` (the alternative the triage proposals settled on): a non-breaking optional field lets every grader keep mapping `{ passed: true, observation_count: 0 }` to a green check forever — exactly the bug we're fixing. The widened union forces consumers with exhaustive switches to make a deliberate decision about silent vs. pass, which is the protocol-correct outcome. Spec-side, adcontextprotocol/adcp#2834 can now adopt the same vocabulary verbatim.

## 6.2.0

### Minor Changes

- 3ba9466: Ship `BuyerRetryPolicy` + `decideRetry` — operator-grade per-code retry semantics for buyer agents. Closes #1152.

  The 6.3.0 recovery-classification fix corrected 12 typed-error classes from `terminal` → `correctable` per the AdCP spec. That's spec-correct, but it surfaced a real adoption gap: a naive buyer agent that just reads `error.recovery === 'correctable'` and retries-with-tweaks will spin on `POLICY_VIOLATION` (looks like governance evasion), hammer SSO endpoints on `AUTH_REQUIRED` (revoked vs missing creds), and re-call with the same `idempotency_key` after correcting the payload (which makes the seller's replay window dedupe ignore the new request).

  `decideRetry(error, ctx?)` translates an `AdcpStructuredError` into a `RetryDecision` discriminated by `action`:
  - **`retry`** — server-side transients (`RATE_LIMITED`, `SERVICE_UNAVAILABLE`, `CONFLICT`). Caller replays with the SAME `idempotency_key` after `delayMs` (honors `error.retry_after` when present, else exponential backoff).
  - **`mutate-and-retry`** — buyer-fixable (`*_NOT_FOUND` re-discover, `BUDGET_TOO_LOW` adjust, `TERMS_REJECTED` re-quote, `UNSUPPORTED_FEATURE` drop the field). Caller applies the correction then mints a FRESH `idempotency_key`.
  - **`escalate`** — surface to a human. Includes the four spec-`correctable`-but-operator-human-escalate codes (`POLICY_VIOLATION`, `COMPLIANCE_UNSATISFIED`, `GOVERNANCE_DENIED`, `AUTH_REQUIRED`), out-of-band transients (`GOVERNANCE_UNAVAILABLE`, `CAMPAIGN_SUSPENDED`), terminal codes, attempt-cap exhaustion, and unknown vendor codes.

  ```ts
  import { decideRetry } from '@adcp/sdk';

  const decision = decideRetry(error, { attempt });

  if (decision.action === 'retry') {
    await sleep(decision.delayMs);
    return callAgent({ idempotency_key: previousKey, ... }); // SAME key
  }
  if (decision.action === 'mutate-and-retry') {
    // Apply seller correction (decision.field, decision.suggestion)
    // and mint a fresh idempotency_key.
    return callAgent({ idempotency_key: crypto.randomUUID(), ...corrected });
  }
  throw new EscalationRequired(decision.reason, decision.message);
  ```

  For per-code overrides, instantiate `BuyerRetryPolicy` directly:

  ```ts
  const policy = new BuyerRetryPolicy({
    overrides: {
      POLICY_VIOLATION: () => ({ action: 'mutate-and-retry', ... }), // verticals where auto-tweak IS appropriate
    },
    unknownCode: 'mutate', // non-standard codes mutate-and-retry instead of escalating (default: escalate)
  });
  ```

  Default policy diverges from the spec's `recovery` field for the codes called out in #1153 — operator-grade defaults, not just a 3-class enum reflection.

  **Safety guards baked into the defaults:**
  - **`IDEMPOTENCY_EXPIRED` → escalate (`idempotency_check_required`)**, NOT auto-retry. The spec explicitly warns: if the prior call may have succeeded, the buyer MUST do a natural-key check before minting a new key. Otherwise this is exactly how double-creation happens. This is a financial-liability default — adopters with a registered natural-key resolver can override per-code.
  - **Exponential backoff capped at 3600s.** Without it, attempt 10 with a 1s base would sleep ~17 minutes (longer than most agent task budgets); attempt 30 → ~16 days. The cap mirrors the spec's `retry_after` range.
  - **Mutate-and-retry includes a 125–250ms jitter** (50–100% of a 250ms base). Without it, fleet operators running thousands of campaigns all hit the seller in lockstep after a correlated storm (e.g., `PROPOSAL_EXPIRED` across the fleet at midnight UTC). The jitter de-correlates without changing semantics.
  - **Compile-time coverage** — `DEFAULT_CODE_POLICY: Record<ErrorCode, CodePolicy>` (not `Partial`), so adding a code to the spec's `ErrorCodeValues` without a policy entry fails typecheck. The runtime drift test is belt-and-suspenders.
  - **`overrides` accepts both `Partial<Record<ErrorCode, ...>>` (typo-safe for standard codes) and `Record<string, ...>` (for vendor codes)** — the union catches misspellings on standard codes at compile time without locking out vendor extensions.

  `attemptCap` raised to 3 for the `*_NOT_FOUND` redirect family and `TERMS_REJECTED` / `REQUOTE_REQUIRED` requote family — most buyers cache one stale ID and need one re-discovery, but ramped-pacing scenarios can cycle 2–3 times as the catalog rotates.

  `ACCOUNT_AMBIGUOUS` is `escalate (auth)` — spec says "pass explicit account_id" but the agent typically doesn't have the right ID cached without going back to `list_accounts`; escalating with the seller's hint is more honest than burning a guaranteed-wrong replay.

  Adopters using the existing `isRetryable()` / `getRetryDelay()` helpers in `@adcp/sdk` continue to work — `decideRetry` is additive.

- 07ebd34: **Behavior change for `getErrorRecovery()` callers and adopters using typed-error classes.** Three error codes had wrong recovery classifications in the SDK; this release corrects them to match the AdCP 3.0 spec. If you wired retry/escalation logic on the buggy classifications, your branches will fire differently after this lands. See "Recovery-classification bugs" below.

  Fix `StandardErrorCode` drift against the AdCP error-code enum.

  `StandardErrorCode` (in `src/lib/types/error-codes.ts`) was hand-maintained and had drifted to 28 codes against the spec's 45. Codegen produces the full set in `enums.generated.ts` `ErrorCodeValues`, but nothing tied that to the hand-rolled union. Each PR added the codes it personally needed and walked away — when AdCP 3.0 GA added 17 new codes (`TERMS_REJECTED`, `GOVERNANCE_DENIED`, `PERMISSION_DENIED`, `CREATIVE_DEADLINE_EXCEEDED`, `IO_REQUIRED`, `REQUOTE_REQUIRED`, `CAMPAIGN_SUSPENDED`, `GOVERNANCE_UNAVAILABLE`, `SESSION_NOT_FOUND`, `SESSION_TERMINATED`, `PLAN_NOT_FOUND`, `PROPOSAL_NOT_COMMITTED`, `CREATIVE_NOT_FOUND`, `SIGNAL_NOT_FOUND`, `REFERENCE_NOT_FOUND`, `PRODUCT_EXPIRED`, `VERSION_UNSUPPORTED`), they never landed in the SDK's strongly-typed handle.

  Three layers of defense, applied in order:
  1. **Type derivation.** `StandardErrorCode` is now `(typeof ErrorCodeValues)[number]` — physically tied to the generated enum. The hand-rolled string-literal union is gone.
  2. **Compile-time completeness.** `STANDARD_ERROR_CODES satisfies Record<StandardErrorCode, ErrorCodeInfo>` — adding a code to the spec without filling in a description and recovery row will fail typecheck.
  3. **Runtime drift guard.** A new test (`test/lib/standard-error-codes-drift.test.js`) asserts `Object.keys(STANDARD_ERROR_CODES).sort()` deep-equals `[...ErrorCodeValues].sort()` and that every entry has a valid `transient | correctable | terminal` classification. Belt-and-suspenders for the type derivation: if someone ever breaks the derivation by re-hand-typing the union, the test still fires.

  **Recovery-classification bugs surfaced by the audit and corrected to match the spec:**

  | Code                  | Was           | Now (spec-correct) | Buyer impact                                                                                                           |
  | --------------------- | ------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------- |
  | `CONFLICT`            | `correctable` | `transient`        | Concurrent-modification retry was being treated as a buyer-correctable error; should retry with current state instead. |
  | `PRODUCT_UNAVAILABLE` | `transient`   | `correctable`      | Sold-out / no-longer-available was being retried in a loop; should pick a different product instead.                   |
  | `UNSUPPORTED_FEATURE` | `terminal`    | `correctable`      | Unsupported field was treated as fatal; should check `get_adcp_capabilities` and remove the unsupported field instead. |

  `ProductUnavailableError` and `UnsupportedFeatureError` (in `src/lib/server/decisioning/errors-typed.ts`) are also updated from `terminal` → `correctable` to match. The `CONFLICT` change is `STANDARD_ERROR_CODES`-only — no typed-error class for that code yet.

  Adopters using `getErrorRecovery()` to drive retry logic will now branch correctly per the spec. If you were depending on the buggy classifications you'll need to update — the new behavior is what the spec required all along. Spec source: `schemas/cache/3.0.0/enums/error-code.json` `enumDescriptions`.

  **Known scope gap (follow-up):** the broader typed-error class hierarchy in `errors-typed.ts` has additional recovery-classification drift beyond these three codes (e.g., `MediaBuyNotFoundError` is `terminal` but spec says `correctable`). Tracked at adcontextprotocol/adcp-client#1136 — those classes will be aligned once a forcing function is added (likely defaulting `recovery` from `getErrorRecovery(code)` when not specified).

  Bumps `STANDARD_ERROR_CODES` from 28 → 45 entries with descriptions condensed from the spec's `enumDescriptions` block. Agents using `getErrorRecovery(code)` now classify the 17 previously-unknown codes correctly instead of returning `undefined`.

  No breaking change: existing call sites that passed standard codes to `adcpError(...)` continue to compile (the union widened, didn't narrow). Call sites that passed non-standard codes still go through the `(string & {})` overload.

- cee3450: Add `transport.maxResponseBytes` for hostile-vendor protection. Closes adcontextprotocol/adcp-client#1167.

  `@adcp/sdk` builds the underlying MCP / A2A transport's `fetch` internally, so callers had no seam to inject a size-bounded fetch. That's a real DoS surface against any code crawling untrusted agents (registries, federated discovery, monitoring tools): a hostile vendor publishing a 200 MB JSON-RPC reply gets fully buffered before any application-layer schema validation runs. The 10s default timeout doesn't mitigate — 200 MB at datacenter speeds arrives well under the limit.

  ```ts
  const client = new ADCPMultiAgentClient([{ id: 'vendor', agent_uri, protocol: 'mcp' }], {
    userAgent: 'AAO-Discovery/1.0',
    transport: { maxResponseBytes: 1_048_576 }, // 1 MB cap on every call
  });

  // Per-call override beats the constructor default — for agents that
  // legitimately publish large catalogs (`list_creative_formats` on a
  // generative seller, `list_properties` on a publisher with 50K URLs).
  const formats = await client.agent('vendor').listCreativeFormats(
    {
      /* ... */
    },
    undefined,
    { transport: { maxResponseBytes: 16 * 1_048_576 } }
  );
  ```

  When the cap is exceeded, the SDK throws `ResponseTooLargeError` (code `RESPONSE_TOO_LARGE`, extends `ADCPError`). The error carries `limit`, `bytesRead`, `url`, and — when the cap was tripped on a `Content-Length` pre-check — `declaredContentLength`. Recovery is `terminal` from the SDK's view: replaying against the same agent will hit the same cap. The buyer's options are to widen the cap per-call when the agent's payload is legitimately large, or to flag the agent as misbehaving.

  **Why a typed knob, not a `fetchOverride`.** Callers composing their own size cap with the SDK's existing `wrapFetchWithCapture`, RFC 9421 signing fetch, and OAuth fetch wrappers is a footgun — the wrap order matters and isn't obvious from the public API. `maxResponseBytes` is a single-purpose ergonomic with a clear contract; future hardening (DNS-rebind defense, scheme allow-list) can add similar typed knobs without callers rewriting their fetch.

  **How it works.** `wrapFetchWithSizeLimit` is installed as the innermost transport wrapper for both MCP and A2A — closer to the network than capture / signing — so the diagnostic capture wrapper reads a size-limited body and can't blow memory through `Response.clone()`. Pre-cancels when `Content-Length` exceeds the cap; otherwise streams through a counting `TransformStream` that errors at the cap boundary. The active cap is read from `responseSizeLimitStorage` (AsyncLocalStorage), so cached MCP / A2A connections don't need to rebuild — the cap lives on the request, not on the transport.

  **Default is no cap.** Buyers in trusted relationships keep their existing payload sizes; only the registry-crawl / federated-discovery use cases need to set this. When set, per-call `transport.maxResponseBytes` (in `TaskOptions`) overrides the constructor's `transport.maxResponseBytes` (in `SingleAgentClientConfig`).

  **Surface area.** New exports: `TransportOptions`, `ResponseTooLargeError`. New fields: `SingleAgentClientConfig.transport`, `TaskOptions.transport`, `CallToolOptions.transport`, `transport` argument on `createMCPClient` / `createA2AClient` factories. No breaking changes to existing fields.

  **Defense detail (post-review hardening).**
  - **Forces `Accept-Encoding: identity` when the cap is active** so a hostile vendor can't ship a 5 KB gzip blob that decompresses to GBs and burn asymmetric CPU before the streaming counter trips. Without this, undici's default `Accept-Encoding: gzip, deflate, br` lets the cap count post-decompression bytes only. Forcing identity moves the bomb to the network where the `Content-Length` pre-check catches it. The header is only set when no caller value is present — signing fetches that need a stable signed-bytes shape can override.
  - **Strips the search component from `ResponseTooLargeError.url`.** Some agents publish manifests with auth tokens in the query string (`?api_key=…`); without redaction those land in `err.message`, `err.details.url`, and any downstream log sinks. The error stores the path-only form for diagnostics.
  - **`createMCPClient` / `createA2AClient` factory exports honor the same cap.** They accept a `transport` argument and wrap with `withResponseSizeLimit`, matching the contract the public `TransportOptions` type implies. Without this, callers reaching the factory exports would silently bypass the cap.

  **Known gaps tracked as follow-ups (not blocking this ship).**
  - OAuth client-credentials token endpoint (`exchangeClientCredentials`) uses raw fetch and bypasses the cap. Pre-existing surface, not a regression from this change. Tracked separately.
  - The cap applies to MCP's long-lived side-channel `GET` for server-initiated messages; the doc warning ("leave unset for long-lived buyer sessions") is the current mitigation. A finer-grained per-response scope is a follow-up.
  - OAuth metadata discovery (`/.well-known/oauth-authorization-server`) doesn't flow through the wrapped fetch — `discoverOAuthMetadata` uses raw fetch. Same DoS surface, separate fix.

- ec58c8f: **Behavior change for `getErrorRecovery()` callers and adopters using typed-error classes.** Closes #1136.

  Recovery classifications across the typed-error class hierarchy in `src/lib/server/decisioning/errors-typed.ts` were hardcoded and had drifted from the AdCP 3.0 spec. The 6.2.0 release fixed three classifications in `STANDARD_ERROR_CODES` (`CONFLICT`, `PRODUCT_UNAVAILABLE`, `UNSUPPORTED_FEATURE`); the remaining ~12 typed-error classes still hardcoded wrong recovery values. This release:
  1. **Makes `AdcpError.recovery` optional.** The constructor now defaults `recovery` from `getErrorRecovery(code)` when omitted (and to `'correctable'` for non-standard `(string & {})` codes). Adopters who want to override per-instance still pass `recovery` explicitly.
  2. **Drops the hardcoded `recovery` field from every typed-error class.** All ~20 classes inherit recovery from the spec via the new default. Same for the `validationError` and `upstreamError` factory helpers.
  3. **Adds a drift guard test.** `every typed-error class recovery matches getErrorRecovery(code)` — if anyone re-introduces a hardcoded `recovery` that diverges from the spec, this fires.

  **Recovery values that change as a result** (these were the spec-conformant values all along; the typed classes were wrong):

  | Class / code                                            | Was        | Now (spec-correct) |
  | ------------------------------------------------------- | ---------- | ------------------ |
  | `PackageNotFoundError` (`PACKAGE_NOT_FOUND`)            | `terminal` | `correctable`      |
  | `MediaBuyNotFoundError` (`MEDIA_BUY_NOT_FOUND`)         | `terminal` | `correctable`      |
  | `ProductNotFoundError` (`PRODUCT_NOT_FOUND`)            | `terminal` | `correctable`      |
  | `CreativeNotFoundError` (`CREATIVE_NOT_FOUND`)          | `terminal` | `correctable`      |
  | `CreativeRejectedError` (`CREATIVE_REJECTED`)           | `terminal` | `correctable`      |
  | `IdempotencyConflictError` (`IDEMPOTENCY_CONFLICT`)     | `terminal` | `correctable`      |
  | `InvalidStateError` (`INVALID_STATE`)                   | `terminal` | `correctable`      |
  | `AuthRequiredError` (`AUTH_REQUIRED`)                   | `terminal` | `correctable`      |
  | `PermissionDeniedError` (`PERMISSION_DENIED`)           | `terminal` | `correctable`      |
  | `ComplianceUnsatisfiedError` (`COMPLIANCE_UNSATISFIED`) | `terminal` | `correctable`      |
  | `GovernanceDeniedError` (`GOVERNANCE_DENIED`)           | `terminal` | `correctable`      |
  | `PolicyViolationError` (`POLICY_VIOLATION`)             | `terminal` | `correctable`      |

  `BudgetTooLowError` (`correctable`), `BudgetExhaustedError` (`terminal`), `RateLimitedError` (`transient`), `ServiceUnavailableError` (`transient`), `ProductUnavailableError` and `UnsupportedFeatureError` (both `correctable` after 6.2.0), `InvalidRequestError` and `BackwardsTimeRangeError` (both `correctable`) were already spec-correct and continue to behave the same.

  **Architectural payoff:** there's now exactly one source of truth for recovery semantics — `STANDARD_ERROR_CODES`, which derives from the generated `ErrorCodeValues`. Adding a code to the spec lights up everywhere; changing a recovery value lights up everywhere. The drift mechanism that produced 6.2.0's three corrections (and this release's twelve) is closed.

  **No source-compatibility break:** existing call sites that pass `recovery` explicitly continue to compile and behave the same. Adopters using `getErrorRecovery()` to drive retry logic will see corrected branch behavior — buyers should retry / pick alternative products / check capabilities for these correctable errors instead of giving up.

- 73fd41c: Adds TypeScript request/response interfaces for the AdCP v2.5 wire shape, importable via `@adcp/sdk/types/v2-5`. This unlocks compile-time type safety on adapter code that maps between v3 and v2.5 — a v3→v2 wire-format bug that previously surfaced only at runtime via the warn-only validation pass now becomes a TypeScript error at the adapter signature.

  `scripts/generate-v2-5-types.ts` (`npm run generate-types:v2.5`) compiles every v2.5 tool's request and response schema as a single mega-schema with shared `definitions`, then runs `json-schema-to-typescript` once. The mega-schema approach naturally deduplicates shared types (e.g. `BrandID`, `FormatID`, `AssetContentType`) instead of producing per-tool copies that collide at the type level.

  Output lands at `src/lib/types/v2-5/tools.generated.ts` and is checked in (parallel to `src/lib/types/tools.generated.ts` for v3). CI's "Validate generated files in sync" step runs both v3 and v2.5 generation, so a forgotten regeneration after a schema refresh fails the build before it ships. The generator pulls from `schemas/cache/v2.5/`, populated by `npm run sync-schemas:v2.5`.

  Consumers can import the v2.5 surface as a namespace:

  ```ts
  import * as V25 from '@adcp/sdk/types/v2-5';
  const req: V25.CreateMediaBuyRequest = ...;
  ```

  Or by name:

  ```ts
  import type { CreateMediaBuyRequest } from '@adcp/sdk/types/v2-5';
  ```

  13 tools across the media-buy, creative, and signals protocols ship with both Request and Response interfaces (26 entry-point types). Foundation for the upcoming adapter-registry refactor where adapter signatures become `(req: V3Request) => V25Request` and the buyer_ref-shaped bug becomes a compile error.

  The `enforceStrictSchema` helper from the existing v3 generator is now exported so the v2.5 generator can apply the same JSON-Schema preprocessing (strip `additionalProperties: true`, drop `if/then/else` conditionals, recurse into combinators). No v3 behavior change.

- 73e722a: Consolidates the v2.5 wire-compat dispatch into a typed registry pattern. Each AdCP tool that needs translation between the SDK's v3 surface and a v2.5 seller now has a per-tool `AdapterPair<V3Req, V25Req, V25Res, V3Res>` module under `src/lib/adapters/legacy/v2-5/`. `SingleAgentClient.adaptRequestForServerVersion` and `normalizeResponseToV3` dispatch through `getV25Adapter(taskName)` instead of carrying tool-specific switch arms.

  Six pairs land in this PR: `get_products`, `create_media_buy`, `update_media_buy`, `sync_creatives`, `list_creative_formats`, `preview_creative`. The pairs wrap the existing scattered helpers (`adaptGetProductsRequestForV2`, `adaptCreateMediaBuyRequestForV2`, `normalizeMediaBuyResponse`, etc.) unchanged — wire-level behavior is identical and pinned by a regression suite that diffs registry output vs direct-helper output for every pair. The underlying logic stays in `utils/*-adapter.ts` files until each pair gets a focused per-tool refactor (e.g. `#1116` for sync_creatives).

  Naming intentionally matches `legacy/<seller-version>/`, NOT `<sdk-version>-to-<seller-version>/`. Real ad-tech compat layers carry **N=1 active legacy shim with a deprecation runway** (OpenRTB, Prebid, GAM all behave this way). Encoding a `v3-to-v2-5/` matrix would commit the codebase to a layout nobody will staff. When the SDK pin moves from v3 to v4 in the future, `legacy/v2-5/` continues to hold the v2.5 compat shim and a sibling `legacy/v3/` joins for v3 sellers — the directory tree expresses "exceptional, time-boxed compat" rather than encoding a buyer-version axis.

  No public API change. The existing `adaptGetProductsRequestForV2` / etc. functions are still exported from `utils/*-adapter.ts` (no rename, no signature change) for any downstream caller using them directly. The registry is purely a centralized dispatch wrapper, not a migration of the helper code.

- df91b27: Client-side response validation now defaults to `warn` everywhere — previously `strict` in dev/test, `warn` only in production. Drift surfaces through `result.debug_logs` and the response payload reaches the caller; the task no longer fails just because a seller's response missed an optional schema constraint.

  **Why.** With #1137's version-pinned validator, a v2.5 seller's perfectly valid v2.5-shaped response is now correctly validated against the v2.5 schema — but v2.5 schemas have wider drift tolerance (envelope nulls, optional-but-required-in-schema fields like `pricing_options`, enum mismatches) than the modern v3 spec. Strict-by-default in dev/test meant integration tests against legitimate v2.5 sellers turned every minor schema gap into a hard failure with `result.data` thrown away — leaving callers staring at "0 products" with no useful signal. `warn` keeps the data flowing and surfaces the drift through the existing `debug_logs` channel that #1133 wired up.

  **Server-side unchanged.** `createAdcpServer` still defaults its handler-side validation to `strict` in dev/test/CI. That catches our own handler-output bugs, which strict mode is genuinely good at — distinct from the client-side concern of "seller wrote a slightly off-spec response."

  **Opt back in.** Buyers who want hard-stop response validation (conformance harnesses, third-party validators, paranoid CI runs) pass `validation: { responses: 'strict' }` explicitly:

  ```ts
  new AgentClient({
    agent_uri: '...',
    validation: { responses: 'strict' },
  });
  ```

  Closes adcontextprotocol/adcp-client#1150.

### Patch Changes

- df6f509: `skills/call-adcp-agent/SKILL.md` — worked example for `decideRetry`.

  Closes the documentation gap left over from #1156 (the `BuyerRetryPolicy` helper). The skill now shows adopters end-to-end how to wire `decideRetry` into a buyer agent retry loop — including the same-vs-fresh `idempotency_key` rule, jitter on mutate-and-retry, and per-vertical overrides via `BuyerRetryPolicy`.

  Two code blocks added:
  1. **Default usage** — `decideRetry(error, { attempt })` with `switch`-style branching on the discriminated `RetryDecision`. Shows TypeScript narrowing each branch (delay only on retry, field/suggestion only on mutate-and-retry, message only on escalate) so adopters can't accidentally hold the same `idempotency_key` after a payload mutation.
  2. **Per-vertical override** — `BuyerRetryPolicy` instantiation pattern with a `CREATIVE_REJECTED` override demonstrating how a creative-template platform can convert format-mismatch rejections to in-loop mutate-and-retry while keeping brand-safety rejections as escalate.

  Skills are bundled with the npm package, so this is a publishable change.

- c68231a: Stop trying to publish `@adcp/client` (the deprecated compat shim).

  Background: `@adcp/client` was the legacy package name; v6.0 renamed it to `@adcp/sdk` and the shim re-exported the new package. The 6.0.0 publish attempt left `@adcp/client@6.0.0`'s npm version slot in a "burned" state (visibility removed but slot reserved), so every subsequent release workflow fails with `Cannot publish over previously published version "6.0.0"` — even though the SDK publish succeeds. The release workflow then exits with code 1 because of the shim failure, even on otherwise-clean releases.

  Two surgical changes to stop the bleeding:
  1. **`packages/client-shim/package.json` → `private: true`.** Source stays in-tree for historical reference; npm publish flow now ignores the package entirely.
  2. **`.changeset/config.json`**: removed the `@adcp/sdk ↔ @adcp/client` linked-version pair (forced lock-step bumps that the npm registry rejected) and added `@adcp/client` to the `ignore` list so changesets stops generating release entries for it.

  Operator action (not part of this PR): run `npm deprecate @adcp/client "Renamed to @adcp/sdk in v6.0. Install @adcp/sdk@^6.1.0 instead."` to land a deprecation banner on the existing `@adcp/client` versions still on npm. Adopters with stale lockfiles get a one-line nudge to migrate.

  After this lands, the next release-PR's workflow run will publish `@adcp/sdk` cleanly without trying to touch `@adcp/client`.

- 6f324de: Collapse the second hand-rolled error-code source.

  `KNOWN_ERROR_CODES` in `src/lib/server/decisioning/async-outcome.ts` was a parallel hand-maintained array of error codes — same shape of bug as the `StandardErrorCode` drift fixed in 6.2.0, just one file over. The author had even left a `TODO(6.0): generate this from schemas/cache/<version>/enums/error-code.json` flag for future-self.

  Now derived from the generated `ErrorCodeValues` (and `ErrorCode` aliases `StandardErrorCode`), so:
  - New codes added to the spec light up everywhere downstream — typo warn, autocomplete, the `ErrorCode` union — without a hand-edit.
  - The two error-code "sources of truth" are now one source.
  - Warn message reports the count from the array rather than a stale hardcoded "45".

  No behavior change at the type or runtime layer; the array contains the same 45 codes it did before, just sourced from codegen now.

- 3770916: Seller skill (`skills/build-seller-agent/SKILL.md` and `specialisms/sales-guaranteed.md`) — behavioral coverage gaps surfaced by the v4 storyboard matrix run (#1120):
  1. **Minimum tool surface callout.** Documents the exact set of tools `sales-guaranteed` storyboards expect — adopters who skipped `list_accounts` or `list_creative_formats` were getting cascade-skips with `skip_reason: missing_tool` instead of useful diagnostics.
  2. **Error-code matrix on `create_media_buy` / `update_media_buy`.** Spec-defined rejections (`TERMS_REJECTED`, `PRODUCT_NOT_FOUND`, `BUDGET_TOO_LOW`, `INVALID_REQUEST`, `MEDIA_BUY_NOT_FOUND`, `PACKAGE_NOT_FOUND`) now appear in one place with the wire-correct `adcpError(...)` shape.
  3. **State-machine logic in the `update_media_buy` example.** `pending_creatives` is a transient state — when `creative_assignments` arrive the buy advances to `pending_start` (start_time in future) or `active` (start_time now/past). The pre-fix example only handled `paused ↔ active`, so storyboards depending on creative-attachment transitions failed.
  4. **`property_list` / `collection_list` live inside `targeting_overlay`.** Per `/schemas/latest/core/package.json`, these are nested under `targeting_overlay`, not flat on `Package`. The skill now teaches the spec-correct path and flags the known storyboard discrepancy (some grader checks the flat path) so adopters don't chase a phantom bug.

  Skills are bundled with the npm package (`files: ["skills/**/*"]`), so this is a publishable change.

- cf7654b: `skills/call-adcp-agent/SKILL.md` and `docs/guides/BUILD-AN-AGENT.md` — callout block for the four spec-`correctable`-but-operator-human-escalate codes.

  Surfaced during the recovery-classification audit closing #1136 and shipping in 6.3.0. Spec recovery is `correctable` for `POLICY_VIOLATION`, `COMPLIANCE_UNSATISFIED`, `GOVERNANCE_DENIED`, and `AUTH_REQUIRED`, but the operator semantic is human-in-loop:
  - `POLICY_VIOLATION` / `COMPLIANCE_UNSATISFIED` / `GOVERNANCE_DENIED` are commercial-relationship signals. Auto-mutating creative, targeting, or budget and resubmitting looks like evasion to a seller's governance reviewer. Naive LLM agent loops that read `error.recovery === 'correctable'` and retry-with-tweaks will produce bad outcomes (and potentially get the buyer flagged).
  - `AUTH_REQUIRED` conflates missing creds (genuinely correctable — re-handshake) with revoked / expired creds (operator must rotate). Until [adcontextprotocol/adcp#3730](https://github.com/adcontextprotocol/adcp/issues/3730) splits this into `auth_missing` + `auth_invalid`, treat as escalate-after-one-attempt to avoid retry storms on revoked keys.

  The skill now teaches: spec recovery is `correctable`, operator behavior is human-in-loop. Read `error.message` + `error.suggestion`, surface to the user, don't loop.

  Closes #1153. Companion to #1152 (the future `BuyerRetryPolicy` helper which will operationalize these defaults in code rather than docs).

  Skills are bundled with the npm package (`files: ["skills/**/*"]`), so this is a publishable change.

- a6865c3: Fix `adaptSyncCreativesRequestForV2` to flatten v3 manifest assets to v2.5 single-asset payload.

  `adaptSyncCreativesRequestForV2` previously leaked the v3 `assets` manifest shape (`{ role: { asset_type, url, … } }`) through to v2.5 servers unchanged. v2.5's `creative-asset.json` schema expects a single asset payload discriminated by `asset_type`; every adapted creative therefore failed the `oneOf` check and was rejected by strict v2.5 sellers.

  The adapter now detects manifest-shaped `assets` (a role-keyed object whose values carry `asset_type`) and extracts the primary (first) role's payload as the v2 asset. Multi-role manifests emit a `console.warn` naming the dropped roles; single-role manifests are silently flattened. Already-flat assets (top-level `asset_type` present) pass through unchanged.

  Covers image, video, audio, VAST, text, and HTML asset variants per the v2.5 test plan.

- 73fd41c: Drift from the warn-only post-adapter v2.5 validation pass now surfaces via `result.debug_logs` instead of dropping silently on the floor. Before this change, `validateAdaptedRequestAgainstV2` ran on every v2-detected request but the `SingleAgentClient` call sites passed no `debugLogs` array — the warning entries had nowhere to go and adapter regressions could land in production unnoticed until a v2 seller reported a wire-shape rejection.

  `SingleAgentClient.executeAndHandle` and `SingleAgentClient.executeTask` now collect drift entries into a local array, then merge them into `result.debug_logs` after `executor.executeTask` returns. Adopters reading `result.debug_logs` see post-adapter v2.5 warnings alongside the executor's own logs, so a malformed adapted shape becomes a debuggable signal instead of an invisible bug.

  No public API change. The `executor.validateAdaptedRequestAgainstV2(taskName, params, debugLogs?)` seam already accepted an optional `debugLogs` parameter — only the call sites changed.

  **Drop-on-error semantics.** Drift is merged into `result.debug_logs` only after `executor.executeTask` returns. If the executor throws before producing a result, drift collected pre-call is dropped — the executor owns the result envelope and the merge happens once we have one in hand. This matches the executor's own debug-log behavior, which is also tied to a successful return.

  Closes the observability hole the v2.5-foundation PR (`#1121`) deliberately deferred. Lays the groundwork for the broader compatibility-matrix work that needs reliable drift signal across version pairs.

- 995de01: Two bugs that silently broke every v3 buyer calling a v2.5 seller, surfaced by smoke-testing against the live Wonderstruck v2.5 sales agent.

  **1. `brand_manifest` → `brand` aliasing dropped a string into an object slot.** `SingleAgentClient`'s field-stripping path renamed `brand_manifest` (URL string from the v2 adapter) back to `brand` whenever the agent's tool schema declared `brand` — without checking the destination's declared type. v2.5 sellers declare `brand` as a `BrandReference` object (`anyOf [object_with_required_domain, null]`). The string landed in the object slot and Wonderstruck rejected with `Input should be a valid dictionary or instance of BrandReference [type=model_type, input_value='https://wonderstruck.fm', input_type=str]`.

  The fix adds a `valueMatchesSchemaType` helper that introspects the destination's declared shape (recursing into `anyOf` / `oneOf`) and only applies the alias when the value's runtime type is compatible. Legacy v2 sellers that declared `brand` as `type: 'string'` still get the URL routed correctly; v2.5 sellers with object-typed `brand` slots get the v3 brand object passed through unchanged (or stripped, depending on the rest of the schema).

  **2. Response validation pinned to v3 even when targeting v2 sellers.** `TaskExecutor.validateResponseSchema` always passed `this.config.adcpVersion` (the SDK-pinned v3) to `validateIncomingResponse`. v2.5 sellers correctly returned v2.5-shaped responses; the SDK falsely rejected them as malformed v3 with errors like `pricing_options must NOT have fewer than 1 items` and `reporting_capabilities required`. The seller wasn't broken — the SDK was validating against the wrong schema.

  The fix derives the validation version from `lastKnownServerVersion`: when the agent is v2-detected, validate against `'v2.5'`; otherwise the SDK-pinned default. Symmetric to the post-adapter request pass added in #1121.

  Together these unblock real-world traffic to v2.5 sellers. Without them, every v3 buyer using `getProducts` against a v2.5 agent failed at one of the two points: the request was rejected (bug 1), or the response was reported as malformed (bug 2). Drift between v2.5 spec and seller behavior still surfaces via `result.debug_logs` (per #1133), so adopters can see real seller deviations without the SDK conflating them with version-mismatch artifacts.

  Surfaced by `scripts/smoke-wonderstruck-v2-5.ts`. Five additional issues filed for follow-up: capability-detection against v2.5 returning a non-v3 shape (#23 in tracker), `supported_macros` `oneOf` cascade in `list_creative_formats` (#24), `list_authorized_properties` undefined-return (#25).

## 6.1.0

### Minor Changes

- e6481ad: Adds a warn-only post-adapter validation pass against the v2.5 schema bundle. After `adaptRequestForServerVersion` rewrites a v3 request into v2 wire format for a v2-detected agent, `SingleAgentClient` calls `executor.validateAdaptedRequestAgainstV2(taskName, adaptedParams)` which validates the adapted shape against the cached v2.5 schemas in warn mode. Symmetric counterpart to the existing pre-adapter v3 pass: that one catches "user wrote bad v3", this one catches "adapter produced bad v2.5".

  Always warn-only — adapter bugs shouldn't break user requests, and the v3 pre-send pass already vouched for the user-facing input shape. The pass surfaces drift via `debugLogs` (when callers pass an array; SDK-internal call sites currently don't, so warnings are silent in production until the upcoming adapter-conformance test suite consumes them as CI signal).

  Skips silently for tasks without a v2.5 schema (custom tools, tasks added since 2.5.3) and when the v2.5 bundle isn't cached. Caller in `SingleAgentClient` gates on `serverVersion === 'v2'` so v3-targeted traffic doesn't pay the validation cost.

  Initial baseline against the canonical adapter outputs surfaced two real drift items worth tracking separately: `adaptCreateMediaBuyRequestForV2` doesn't emit `buyer_ref` (v2.5 requires it top-level + per-package), and `adaptSyncCreativesRequestForV2`'s `assets.video` shape fails a `oneOf` in v2.5. These will be addressed alongside the adapter-conformance test suite.

  `TaskExecutor.validateAdaptedRequestAgainstV2(taskName, adaptedParams, debugLogs?)` is the public seam; mirrors the shape of `validateRequest`.

- e6481ad: Adds v2.5 schema bundle support so the SDK can validate against the actually-shipping AdCP 2.5.3 contract, not just v3.

  `scripts/sync-v2-5-schemas.ts` (`npm run sync-schemas:v2.5`) pulls the v2.5.3 schema bundle from `adcontextprotocol/adcp@2.5-maintenance` at a pinned commit and drops it at `schemas/cache/v2.5/`. The pinned-SHA approach is necessary because the upstream `v2.5.2` and `v2.5.3` releases were never tagged or published as GitHub releases despite shipping in `package.json` and `CHANGELOG.md` (filed at `adcontextprotocol/adcp#3689`); pulling from the published spec site would silently regress to v2.5.1, missing the `additionalProperties: true` forward-compat relaxation, the `error.json` `details` typing fix, and the `impressions` / `paused` package-request fields.

  The existing `resolveBundleKey('v2.5')` legacy alias and `copy-schemas-to-dist.ts` legacy-prerelease path both already routed `v2.5` correctly without resolver changes — the bundle ships at `dist/lib/schemas-data/v2.5/` alongside `dist/lib/schemas-data/3.0/`.

  `schema-loader.ts`'s `ensureCoreLoaded` now registers request tool files in addition to fragments. v2.5's source tree ships flat (no pre-bundled `bundled/` subtree) with cross-fragment `$ref`s like `media-buy/create-media-buy-request.json` referencing `/schemas/media-buy/package-request.json`. The filename-suffix heuristic in `buildFileIndex` misclassifies fragments like `package-request.json` as tools (`package::request`), so the previous "skip everything in fileIndex" rule left them unregistered and AJV emitted `MissingRefError` on the cross-fragment lookup. The narrowed rule now skips only response tool files (which need `relaxResponseRoot` lazy-applied via `getValidator`); request tool files and fragments are pre-registered, so cross-fragment `$ref`s resolve at compile time. v3's bundled-schemas path is unaffected (refs were already inlined).

  No buyer-facing API surface change. Internal-only — the v2.5 bundle is reachable via `getValidator(toolName, direction, 'v2.5')` for upcoming adapter-conformance work.

### Patch Changes

- e6481ad: Adds an adapter-conformance test suite that pins the v3→v2 wire adapters against the cached v2.5 schema bundle. CI signal for "the v2 wire adapters produce v2.5-conformant output."

  Each canonical v3 fixture runs through `adaptRequestForServerVersion`; the adapted output must validate against `schemas/cache/v2.5/`. Tools with known drift have explicit `expected_failures` entries pointing at the tracking issue and pinning the failure-mode pointers — so a fix that closes the gap surfaces as an unexpected pass and prompts the entry to be removed. A "every v2-adapted tool has a fixture" guard test ensures new adapters can't ship without conformance coverage.

  Initial state: `get_products` and `update_media_buy` conform clean. `create_media_buy` has known drift on `/buyer_ref` (top-level + per-package), tracked at adcontextprotocol/adcp-client#1115. `sync_creatives` has known drift on `/creatives/0/assets/video` (v3 manifest shape vs v2.5 single-asset-payload `oneOf`), tracked at adcontextprotocol/adcp-client#1116.

  No source changes. Test-only — but a changeset because the suite is the binding contract for v2 wire conformance going forward.

- 16ad465: `adaptCreateMediaBuyRequestForV2` now derives `buyer_ref` (top-level + per-package) from the v3 `idempotency_key`, fixing v2.5 wire-validation failures for v3 buyers calling v2 sellers (adcontextprotocol/adcp-client#1115).

  v2.5's `create_media_buy` schema requires `buyer_ref` top-level and per-package as the buyer's reference for THIS media buy. v3 doesn't model `buyer_ref` directly, but `idempotency_key` carries the same client-controlled-unique-identity contract. Reusing it preserves the seller-side dedupe contract on replays — the same v3 input always produces the same v2.5 `buyer_ref` values.

  Derivation precedence:
  - **Top-level `buyer_ref`**: caller-supplied wins → else `idempotency_key` → else omitted (v3 pre-send validation should already have rejected the missing required field; on warn-mode passthrough the v2.5 validator surfaces it).
  - **Per-package `buyer_ref`**: caller-supplied wins → else `package.idempotency_key` → else `${parent_buyer_ref}-${index}`. Position-based composition is stable across replays of the same package list.

  `adaptPackageRequestForV2` gains an optional second argument `PackageAdapterContext` (`{ parentBuyerRef?, index? }`) so callers threading per-package derivation supply the parent's reference + index. Backward-compatible: the existing single-argument signature continues to work for callers that don't need derivation (e.g., the existing `update_media_buy` adapter, which passes packages by `package_id`).

  Conformance state: the v2.5 adapter-conformance test suite (added in #1121) flips `create_media_buy` from a known-drift `expected_failures` fixture to a passing fixture. Future regressions surface as test failures.

- ee02cf2: v6.0.1: F6 cascade-skip respects same-phase substitutes for `not_applicable` skips, plus a migration-doc note on the `Format['assets']` cast tightening.

  **F6 cascade refinement (high-severity adopter regression).** F6's first cut treated `not_applicable` skips on stateful steps as equivalent to `missing_tool` / `missing_test_controller` — every downstream stateful step cascade-skipped with `prerequisite_failed`. That's correct when state genuinely couldn't materialize, but it collapses the `sync_accounts` ↔ `list_accounts` substitution that the spec defines as canonical for explicit-mode sellers (`account.require_operator_auth: true`). Adopters running 12 storyboards on the new SDK saw every storyboard collapse to 1/N steps passing because `list_accounts` — the substitute path that WOULD have established account state — was itself cascade-skipped before it could run.

  The runner now defers the cascade decision for `not_applicable` skips to phase end. If any stateful peer in the same phase passes (e.g., `list_accounts` after a not-applicable `sync_accounts`), the substitute is treated as having established state and the cascade does not fire. If no peer establishes state, the cascade promotes to `statefulFailed` at phase end and downstream phases skip cleanly with `prerequisite_failed` — the prior contract for the no-substitute case is preserved. `missing_tool` and `missing_test_controller` continue to trip the cascade immediately (state genuinely never materialized; nothing in the same phase can substitute for an absent tool).

  Order-independent: the substitute can run before or after the not-applicable step in the phase. Five new/updated tests cover (1) cascade fires when no peer establishes state, (2) substitute runs and cascade is canceled when the not-applicable step is first, (3) same with substitute first, (4) non-stateful peer that passes does NOT cancel the cascade — the storyboard's own `stateful: true` declaration gates whether a step counts as state-establishing, (5) a real failure later in the same phase wins the cascade-detail message over an earlier not-applicable trigger (failures are the worse signal).

  **Storyboard-side caveat.** `compliance/cache/3.0.1/specialisms/audience-sync/index.yaml` declares `list_accounts: stateful: false`, so adopters running that storyboard against an explicit-mode agent will see `list_accounts` itself run again (no longer cascade-skipped) but the deferred trigger still fires at phase end because no stateful peer established state. Tracked as a follow-up upstream-spec fix (`adcontextprotocol/adcp` storyboard yaml — flip the flag, since the step does establish account state for downstream `sync_audiences`). Adopters running `sales-social` and other storyboards where `list_accounts` is correctly `stateful: true` get full restoration on 6.0.1 bump without changes.

  **Migration doc — `Format['assets']` cast tightening (low-severity adopter paper cut).** v6 narrowed `Format['assets']` from a permissive shape to `(BaseIndividualAsset | RepeatableGroupAsset)[]`, which means v5-era adopter helpers that erased their assets to `Record<string, unknown>[]` no longer compile with a bare `as Format['assets']`. Added a migration-doc bullet under "Common gotchas" pointing at two fixes: refactor the converter to build into the typed shape (preferred) or mechanically change the cast to `as unknown as Format['assets']` (works, only meaningful if your converter has been correct on shape all along — wire shape didn't change between 5.x and 6.0). Only adopters with their own v4/v5-era asset-converter helpers hit this; SDK-typed call sites already use the narrowed shape.

  Triage source: adcontextprotocol/adcp-client#1005 round-9 review (workspace migration to `@adcp/sdk@6.0.0` across 13 adapters).

- 112b10d: v6.0.1: production gate the default `stateStore` + zod floor bump + missing-peer-dep doc.

  **Production gate.** The 6.0 default `InMemoryStateStore` was a process-shared module singleton — correct for dev and single-tenant agents (closes the Pattern 3 SI session-loss bug at the documented `serve(() => createAdcpServer({...}))` factory pattern), but a multi-tenant production deployment that mints one `createAdcpServer` per resolved tenant would silently share state across tenants. 6.0 shipped this as a one-time `logger.warn`; 6.0.1 promotes it to a hard refusal mirroring `buildDefaultTaskRegistry`'s task-registry policy. Outside `{NODE_ENV=test, NODE_ENV=development}` the default in-memory store throws with a three-line explicit recovery path: pass `PostgresStateStore` (recommended), pass `new InMemoryStateStore()` explicitly (acknowledged), or set `ADCP_DECISIONING_ALLOW_INMEMORY_STATE=1` (ops escape hatch). Single-tenant adopters and dev/test deployments are unaffected.

  **Gate ordering.** The new state-store gate fires AFTER the existing `idempotency: 'disabled'` gate so adopters who hit both surface the higher-severity error first (idempotency-disabled silently double-executes mutations on retry; state-store sharing leaks tenant data — both bad, idempotency goes first because the recovery is "wire a store" while state-store recovery is "pass your own").

  **zod floor bump.** Peer-dep range tightened from `^4.1.0` to `^4.1.5` to match `json-schema-to-zod` (peers `^4.1.3`) and `ts-to-zod` (peers `^4.1.5`) — the SDK's own codegen-tool floors. Removes a build-vs-runtime range mismatch where adopters on `zod@4.1.0`–`4.1.4` would technically fall below the codegen tools' floors.

  **Missing-peer-dep troubleshooting doc.** Added a sub-bullet to the migration doc explaining the `Cannot find module 'zod'` symptom (package manager didn't auto-install the peer) and the explicit-install fix. The SDK can't catch this at runtime — `import { z } from 'zod'` resolves at module load, before any SDK code runs — so a documentation pointer is the right shape.

  **Test command env.** `npm test` and `npm run test:lib` now set `NODE_ENV=test` so the production gate doesn't refuse on test runs that don't already set the env. Existing tests that flip NODE_ENV mid-run to exercise production paths now also set `ADCP_DECISIONING_ALLOW_INMEMORY_STATE=1` alongside the existing task-registry ack.

  897/897 server-side tests pass. The new state-store gate has 6 dedicated tests in `test/server-state-store-extensions.test.js` covering: production-throw, production+ack→allow, production+explicit-store→allow, development→allow, test→allow, undef-NODE_ENV→throw.

## 6.0.0

### Major Changes

- a1c144f: **BREAKING (pre-GA):** rename `Account.metadata` → `Account.ctx_metadata` for naming consistency across DecisioningPlatform resources.

  Account is now consistent with Product / MediaBuy / Package / Creative / Audience / Signal / RightsGrant: every resource uses `ctx_metadata` for adapter-internal state. The TMeta generic still flows through `DecisioningPlatform<TConfig, TMeta>` — only the field name on Account changes.

  ```ts
  // Before:
  accounts: {
    resolve: async () => ({
      id: 'pub_main',
      operator: 'mypub',
      metadata: { networkId: '12345', advertiserId: 'adv_xyz' },
      authInfo,
    }),
  }
  async createMediaBuy(req, ctx) {
    const networkId = ctx.account.metadata.networkId;
  }

  // After:
  accounts: {
    resolve: async () => ({
      id: 'pub_main',
      operator: 'mypub',
      ctx_metadata: { networkId: '12345', advertiserId: 'adv_xyz' },
      authInfo,
    }),
  }
  async createMediaBuy(req, ctx) {
    const networkId = ctx.account.ctx_metadata.networkId;
  }
  ```

  **Operational difference vs other resources still applies:** Account `ctx_metadata` is NOT round-tripped through the SDK store — `accounts.resolve()` is called per-request, so the publisher is the canonical source of truth on every call. The SDK only round-trips `ctx_metadata` for resources where there's a producer/consumer split (Product attached on getProducts, hydrated on createMediaBuy). Naming is consistent; semantics still differ. Documented in `Account.ctx_metadata` JSDoc.

  Migration: search-replace `metadata:` → `ctx_metadata:` inside Account literals (typically alongside `operator:`), and `account.metadata` → `account.ctx_metadata` in handler bodies. Pre-GA window — adopters in the field today are a small handful of training/spike codebases.

  223 tests passing on focused suite (no regressions from rename).

- 6066a7a: **BREAKING**: `createAdcpServer` is no longer exported from `@adcp/sdk/server` or `@adcp/sdk` (top-level). It now lives only at `@adcp/sdk/server/legacy/v5`. Update imports:

  ```diff
  -import { createAdcpServer } from '@adcp/sdk/server';
  +import { createAdcpServer } from '@adcp/sdk/server/legacy/v5';
  ```

  Or — better — migrate to `createAdcpServerFromPlatform` and the typed `DecisioningPlatform` shape.

  ## Why this breaks

  Empirical Emma matrix evidence: even with the `@deprecated` JSDoc tag and v6 examples in every skill, LLMs scaffolding agents from skill content **still pick `createAdcpServer`** as the canonical entry point. The deprecation tag is invisible to the prompt corpus; the symbol's presence at the top-level export is what teaches the LLM it's canonical. Removing the top-level export forces v6 selection: a fresh `npm install` adopter who reaches for `createAdcpServer` from the obvious path gets a hard import error, and the only path that resolves is the one explicitly named "legacy."

  The `legacy/v5` subpath re-exports the full `@adcp/sdk/server` surface plus `createAdcpServer`, so v5 adopters migrate by changing one import path — destructured imports keep working without splitting:

  ```diff
  -const { createAdcpServer, serve, verifyApiKey } = require('@adcp/sdk/server');
  +const { createAdcpServer, serve, verifyApiKey } = require('@adcp/sdk/server/legacy/v5');
  ```

  `docs/migration-5.x-to-6.x.md` already documented this in the cheatsheet (#3 of the five breaking changes); this PR makes the change actually breaking.

### Minor Changes

- a1c144f: Consolidate Account state, deprecate v5 entry, ship assembly helpers, audit spec for state-management opportunities.

  **Account consolidation:** drop `ctx_metadata` from `Account`. The previously-added field duplicated the existing `metadata: TMeta` (publisher-typed shape, framework-stripped from wire). Account is special among DecisioningPlatform resources because `accounts.resolve()` runs per-request — the publisher is the canonical source of truth on every call, no SDK round-trip cache needed (unlike Product/MediaBuy/Package/Creative where the SDK bridges between `getProducts` and `createMediaBuy`). Use `metadata` for adapter state on accounts.

  **`createAdcpServer` deprecation:** marked `@deprecated` in JSDoc. v6 platform adopters scaffolding from skills should use `createAdcpServerFromPlatform` exclusively. Empirical baseline (Emma matrix v18 round 3) showed LLM-generated platforms picking the v5 `createAdcpServer` handler-bag entry over the v6 platform shape, bypassing `ctx_metadata` + auto-hydration. `@deprecated` flags the v5 entry in IDE / LLM scaffolds without breaking adopters mid-migration.

  **Assembly helpers:** new `buildProduct` / `buildPricingOption` / `buildPackage` factories. Emit wire-correct shapes (passes AdCP 3.0.1 schema validation) from intent-shaped input — eliminates ~30 lines of boilerplate per Product. Required fields the LLM keeps missing (`publisher_properties[].publisher_domain`, `format_ids[].agent_url`, `reporting_capabilities`) get sensible defaults or loud "missing publisher_domain" errors with explicit recovery hints.

  ```ts
  import { buildProduct, buildPricingOption } from '@adcp/sdk/server';

  const product = buildProduct({
    id: 'sports_display_auction',
    name: 'Sports Display Auction',
    formats: ['display_300x250'],
    delivery_type: 'non_guaranteed',
    pricing: { model: 'cpm', floor: 5.0, currency: 'USD' },
    publisher_domain: 'sports.example',
    agentUrl: 'http://127.0.0.1:4200/mcp',
    ctx_metadata: { gam: { ad_unit_ids: ['au_123'] } },
  });
  ```

  **Spec audit RFC:** new `docs/proposals/decisioning-platform-state-audit.md` walks every AdCP wire tool, identifies which fields reference an id from a prior tool's output, and ranks state-management opportunities by leverage. Six multi-call workflows surface (media-buy lifecycle, creative refinement, proposal flow, brand rights, signals, performance feedback). Implementation priority order with LOC estimates per workflow. Informs 6.2 + 6.3 work.

  **6.2 RFC clarification:** `docs/proposals/decisioning-platform-v6-2-state-management.md` updated — proposal flow split (`generateProposal/refineProposal/finalizeProposal`) is SDK ergonomics over the existing `get_products` wire verb, dispatched by claimed specialism. No `adcontextprotocol/adcp` spec coordination needed.

  211 tests passing on focused suite (added 16 for assembly helpers).

- 5d9a0a1: feat(server): `TenantConfig.agentUrls: string[]` — accept traffic on multiple URLs simultaneously for DNS-cutover and vanity-domain deployments. Single-URL `agentUrl` keeps working unchanged; `agentUrls` is the new multi-URL form (first element is canonical for JWKS validation and status reporting; the rest are aliases). Setting both is a register error.

  Closes #1087.

- a1c144f: Ship Option B auto-hydration: SDK pre-fetches `Product` objects (with `ctx_metadata` attached) and exposes them on `req.packages[i].product` for `createMediaBuy`. Make `getMediaBuys` required on `SalesPlatform` (with merge-seam fallback).

  **Auto-hydration substrate:**
  - `CtxMetadataEntry` extended with optional `resource` field (SDK-attached wire object) alongside `value` (publisher-attached blob).
  - Two new framework-only store methods: `setEntry(account, kind, id, entry)` writes both fields atomically; `setResource(account, kind, id, resource, publisherCtxMetadata?)` updates the resource while preserving the publisher's prior `value` (so adopter `ctx.ctxMetadata.set()` is never clobbered by auto-store).
  - `getEntry` / `bulkGetEntries` framework-only readers return both fields for the dispatch hydration path.

  **Dispatch wiring:**
  - After `getProducts` returns, framework iterates `result.products` and persists each Product's wire shape (minus `ctx_metadata`) as the `resource` field, with the publisher's `ctx_metadata` (when present) as the `value` field. Failures are logged + swallowed — auto-store never breaks a successful response.
  - Before `createMediaBuy` invokes the publisher, framework walks `req.packages`, bulkGets each `product_id`, and attaches `pkg.product = { ...resource, ctx_metadata: value }` so the publisher reads `pkg.product.format_ids` / `pkg.product.ctx_metadata?.gam?.ad_unit_ids` directly. Falls back gracefully when the SDK has no record (publisher uses its own DB).
  - After `getMediaBuys` returns, framework auto-stores each `media_buy` shape so subsequent `updateMediaBuy` can hydrate them.

  **`getMediaBuys` made required:**
  - Type-level required on `SalesPlatform` — every seller needs to support reading back what they created. Idempotent retries depend on it; the 6.2 patch-decomposition redesign needs single-id reads as foundation.
  - Runtime keeps the merge-seam fallback path: legacy adopters wiring `getMediaBuys` via `opts.mediaBuy.getMediaBuys` continue to work; framework's platform-derived handler is omitted at runtime when the platform method is absent.

  **Skill update:**
  - `skills/build-decisioning-platform/SKILL.md` example updated: 6 functions (was 5), `createMediaBuy` reads `pkg.product.ctx_metadata?.gam?.ad_unit_ids` directly (no separate lookup), `getMediaBuys` shown as required with the full wire shape including `total_budget` (closes Emma round 2 failure cluster).

  **Tests:**
  - `test/server-auto-hydration.test.js`: 4 tests covering round-trip via `createMediaBuy`, no-store fallback, unseen-product fallback, `getMediaBuys` auto-store path.
  - 195 total tests passing across the focused suite.

  Closes Emma matrix v18 round 2 cascading failures from `update_media_buy` returning `SERVICE_UNAVAILABLE` and `get_media_buys` shape errors.

- e28b982: feat(server): auto-hydration on `update_media_buy`, `provide_performance_feedback`, `activate_signal`, `acquire_rights`. Each mutating verb now auto-hydrates its primary resource(s) from the ctx_metadata store — handlers receive `req.media_buy`, `req.creative`, `req.signal`, `req.rights` populated with the wire shape + `ctx_metadata` blob from the prior discovery call (`get_media_buys`, `get_signals`, `get_rights`). Misses are silent; publishers fall back to their own DB.

  Adds auto-store on `get_signals` (kind: `signal`) and `get_rights` (kind: `rights_grant`) returns to feed the hydration path.

  Closes #1086.

- a1c144f: `buildCreative` on both `CreativeBuilderPlatform` and `CreativeAdServerPlatform` now accepts a discriminated return shape: `CreativeManifest | CreativeManifest[] | BuildCreativeSuccess | BuildCreativeMultiSuccess`. Previously the return was `Promise<CreativeManifest>` (single only), so multi-format storyboards (`target_format_ids: [...]`) hit double-wrapped responses that failed schema validation against the spec's `BuildCreativeMultiSuccess` arm. The framework projector now branches on shape:
  - Plain `CreativeManifest` → wrap as `{ creative_manifest: <obj> }` (single, no metadata)
  - `CreativeManifest[]` → wrap as `{ creative_manifests: <array> }` (multi, no metadata)
  - Already-shaped `BuildCreativeSuccess` (has `creative_manifest` field) → passthrough — adopter set `sandbox` / `expires_at` / `preview` themselves
  - Already-shaped `BuildCreativeMultiSuccess` (has `creative_manifests` field) → passthrough

  Adopters route on `req.target_format_id` (single) vs `req.target_format_ids` (multi) and return the matching arm. Returning an array for a single-format request, or a bare manifest for a multi-format request, is an adopter contract violation that surfaces as schema-validation failure on the wire response. New `BuildCreativeReturn` type alias exported from `@adcp/sdk/server/decisioning`. Surfaced by training-agent v6 spike (F16) on `creative_template/build_multi_format` and `creative_generative/build_multi_format` storyboards.

  Also documents `brand` field in the `TOOL_INPUT_SHAPE` and `ComplyControllerConfig.inputSchema` extension examples — both `account` and `brand` are stripped by the spec-canonical comply controller shape and need extending when storyboard fixtures send them at the top level (F17).

- a1c144f: Close-out batch part 1: deprecate v5 response builders, type idempotency principal params, ship principal-fallback footgun warn, slim skill polish.

  **Deprecate v5 response builders.** All 29 response-builder functions in `src/lib/server/responses.ts` (`productsResponse`, `mediaBuyResponse`, etc.) marked `@deprecated`. They're for v5 raw-handler adopters mid-migration; v6 adopters using `createAdcpServerFromPlatform` never touch them. IDE strikethrough + LLM scaffolding signal. Same lightweight intervention as `createAdcpServer` itself.

  **`IdempotencyPrincipalParams` typed (TA1).** Replaces `params: Record<string, unknown>` with a typed shape that surfaces `account?: AccountReference` and `brand?: BrandReference` — the most-common scoping fields. Adopters scoping by `params.account?.account_id` or `params.brand?.domain` get autocomplete + type narrowing without `as { account?: ... }`. Tool-specific scoping retains the open `Record<string, unknown>` index signature for everything else.

  **Construction-time warn for principal fallback (multi-tenant safety).** When `opts.resolveIdempotencyPrincipal` is not explicitly wired, the default falls through `authInfo.clientId → sessionKey → account.id → undefined`. The `account.id` fallback collapses unauthenticated buyers into one shared idempotency namespace per account — fine for single-tenant deployments where every buyer authenticates, dangerous for multi-tenant hosts serving unauthenticated traffic over a shared `account_id`. Framework now warns at construction (NODE_ENV-allowlist gated, ack via `ADCP_DECISIONING_ALLOW_ACCOUNT_ID_PRINCIPAL=1`). Same shape as the unsigned-emitter / private-webhook-URL footgun guards.

  **Slim skill polish:**
  - New "Imports cheat sheet" section: 95% of sales agents need ~10 imports. Listed at the top so LLMs scaffolding the skill see the canonical subset before encountering the 100+ namespace exports.
  - New "When you need..." trigger index: HITL → `advanced/HITL.md`, multi-tenant → `advanced/MULTI-TENANT.md`, etc. 11 triggers covering the full advanced/ surface plus the Postgres ops guide.
  - Auto-hydration contract documented on `createMediaBuy` example: `pkg.product` undefined means SDK store has no record, NOT authoritative "doesn't exist." Decision tree shown for own-DB vs pure-SDK adopters.
  - `getMediaBuys` empty-array pattern documented: write-only adopters return `{ media_buys: [] }`. Never lie; empty array is truthful "no buys to enumerate."

  221 tests passing on focused suite.

- a1c144f: `ComplyControllerConfig.seed.creative_format` slot. The `seed_creative_format` scenario already existed in the wire enum + `SEED_SCENARIOS` constants + `TestControllerStore.seedCreativeFormat`; the domain-grouped façade `ComplyControllerConfig.seed` was the only surface that didn't expose it. Adopters with v5 `seed_creative_format` adapters wired through `registerTestController` directly had no path through `createAdcpServerFromPlatform({ complyTest })` and were forced to drop to the lower-level surface. New `creative_format?: SeedAdapter<SeedCreativeFormatParams>` slot closes the gap; `SeedCreativeFormatParams` re-exported from `@adcp/sdk/testing`. Surfaced by training-agent v6 spike (F14).
- a1c144f: `ComplyControllerConfig.inputSchema` extension point. Adopters who route comply-test wiring through `createAdcpServerFromPlatform({ complyTest })` can now extend the canonical `TOOL_INPUT_SHAPE` with vendor fields (e.g., a top-level `account` field used for sandbox gating or tenant scoping) — matching the documented `{ ...TOOL_INPUT_SHAPE, account: ... }` pattern that was previously only reachable when wiring `registerTestController` directly. Storyboard fixtures sending top-level `account` (rather than `context.account`) are the canonical case. Adopter-supplied keys win on collision with canonical fields. Surfaced by training-agent v6 spike round 5 (Issue 5 / F10).
- a1c144f: Merge `CreativeTemplatePlatform` and `CreativeGenerativePlatform` into a single `CreativeBuilderPlatform` interface. The two v6 preview archetypes had no meaningful interface distinction — `buildCreative` had identical signatures, and the only difference was whether `refineCreative` was supported. The merged shape makes both `previewCreative` and `refineCreative` optional, reflecting the actual implementation surface across template-driven (Bannerflow, Celtra) and brief-to-creative AI (Pencil, Omneky, AdCreative.ai) platforms.

  **Both `creative-template` and `creative-generative` specialism IDs now map to `CreativeBuilderPlatform`** in `RequiredPlatformsFor<S>`. Buyer-side discovery distinction is preserved (the IDs remain separate for buyer filtering), but adopters implement one interface regardless of which IDs they claim.

  `CreativeAdServerPlatform` is unchanged — library + tag generation + delivery reporting remain a distinct archetype with `listCreatives` + `getCreativeDelivery` that builders don't have. Multi-archetype omni agents (rare in practice — most "AI-native ad platforms" are builders that hand off to traditional ad servers) front each archetype as a separate tenant via `TenantRegistry`.

  **Source compatibility**: `CreativeTemplatePlatform` and `CreativeGenerativePlatform` remain as `@deprecated` type aliases pointing at `CreativeBuilderPlatform` for one-release migration. Both still resolve and adopter code that imported them continues to compile. Will be removed in a future release.

  Surfaced by training-agent v6 spike (F13).

- a1c144f: Ship `ctx_metadata` opaque-blob round-trip for adapter-internal state. Publishers attach platform-specific blobs (GAM `ad_unit_ids` per product, `gam_order_id` per media_buy, line_item_id per package) to any returned resource via `ctx.ctxMetadata.set('product', id, value)`; the framework persists by `(account.id, kind, id)` and threads back into the publisher's request context on subsequent calls referencing the same resource ID.

  `@adcp/sdk/server` adds:
  - `createCtxMetadataStore({ backend })` — store with 16KB blob cap (`CTX_METADATA_TOO_LARGE`), 30-day max TTL, hard-fail on null/undefined `account_id`.
  - `memoryCtxMetadataStore()` — single-process default (boot warns when `NODE_ENV=production` arrives in a follow-up; today the precedent matches `memoryBackend` for idempotency).
  - `pgCtxMetadataStore(pool)` + `getCtxMetadataMigration()` + `cleanupExpiredCtxMetadata(pool)` — cluster path mirroring the idempotency PG layout. Composite PK on `scoped_key` flattened from `(account_id, kind, id)`; `bulkGet` uses `ANY($1::text[])` (no IN-list expansion).
  - `stripCtxMetadata` / `WireShape<T>` — runtime + compile-time defense; closes the leak surface for adopters who include the field in handler returns.
  - `ctx.ctxMetadata` accessor on `RequestContext` — auto-bound to `ctx.account.id`. Methods: `get(kind, id)`, `bulkGet(refs)`, `set(kind, id, value, ttl?)`, `delete(kind, id)`, plus per-kind shortcuts (`product(id)`, `mediaBuy(id)`, `package(id)`, `creative(id)`, `audience(id)`, `signal(id)`).
  - Retrieved blobs carry a non-enumerable `[ADCP_INTERNAL_TAG]: true` symbol — won't survive `JSON.stringify`, automatic defense against accidental serialization in error envelopes / log lines.
  - `createAdcpServerFromPlatform({ ctxMetadata })` opt — pass the store; framework threads the per-account accessor into every handler's `ctx.ctxMetadata`.

  Closes the gap LLM-generated platforms hit when re-deriving per-product GAM config on every `create_media_buy`. Designed against Prebid `salesagent`'s `implementation_config` pattern — ship the SDK-side cache so adopters don't have to write the side-DB themselves.

  The downstream-discoverability layer (replace `product_id` with hydrated `product: Product & { ctx_metadata }` in `SellerCreateMediaBuyRequest`) lands in 6.2 — design captured in `docs/proposals/decisioning-platform-v6-1-ctx-metadata.md`. 6.1 ships the store + ctx accessor; 6.2 will replace the request-shape ID with the resolved object so LLMs see ctx_metadata in the function signature, not via a side accessor.

  Backed by 5-expert review (ad-tech-protocol, security, dx, agentic-product, javascript-protocol). Field name `ctx_metadata` confirmed not colliding with any AdCP 3.0 wire field; spec note to be filed on `adcontextprotocol/adcp` reserving the convention before Python SDK locks the name.

- a1c144f: `CreateAdcpServerFromPlatformOptions.allowPrivateWebhookUrls?: boolean` opt for sandbox / local-testing flows. The framework's request-ingest validator rejects loopback / RFC 1918 / link-local destinations on `push_notification_config.url` by default — accepting them in production is a SSRF / cloud-metadata exfiltration path. Setting the flag to `true` bypasses ONLY the private-IP branch; malformed-URL, non-http(s) scheme, and the `http://` reject (separately gated by NODE_ENV / `ADCP_DECISIONING_ALLOW_HTTP_WEBHOOKS`) all still fire. Construction emits a one-shot footgun warn when the flag is `true` AND `NODE_ENV` is not `test` / `development` (and `ADCP_DECISIONING_ALLOW_PRIVATE_WEBHOOK_URLS` isn't set as ack), so accidental production toggles are visible. Adopters typically scope the flag on their own `NODE_ENV !== 'production'` check. Surfaced by training-agent v6 spike round 5 (Issue 6 / F11).
- a1c144f: `createAdcpServerFromPlatform` now auto-emits a completion webhook on the sync-success arm of mutating tools when the buyer supplied `push_notification_config.url`. v6 framework previously fired only on HITL task completion; sync `create_media_buy` / `update_media_buy` / `sync_creatives` left buyers polling unless the adopter manually called `ctx.emitWebhook` from each handler — invisible breakage compared to v5 storyboard expectations (the broadcast-tv storyboard's `expect_window_update_webhook` step relied on this). Webhook payload mirrors the HITL completion shape (`task_type`, `status: 'completed'`, `result`); `task_id` is synthesized per call (`sync-{uuid}`) since sync responses don't allocate a registry task — buyers correlate via the resource IDs (`media_buy_id`, `creative_id`, etc.) on `result`. Same `SPEC_WEBHOOK_TASK_TYPES` gate as the HITL path: tools outside the closed wire enum skip delivery (use `publishStatusChange`). Webhook delivery failures are logged-and-swallowed so the sync response always succeeds. Adopters who emit webhooks manually inside their handlers can suppress the auto-emit with `autoEmitCompletionWebhooks: false` to avoid duplicate delivery. Surfaced by training-agent v6 spike during F11 verification (Issue 7 / F12).
- a1c144f: Add `batchPoll`, `validationError`, `upstreamError`, and `RequestShape` helpers to `@adcp/sdk/server/decisioning`.

  These lift boilerplate patterns that every v6 adopter writes identically in their adapter layer: the `pollAudienceStatuses` Map-collection loop, buyer-correctable validation error construction, upstream 5xx/rate-limit projection, and the index-signature-stripping cast for v5-era task fn back-compat.

- a1c144f: `createAdcpServerFromPlatform` now synthesizes a default `resolveIdempotencyPrincipal` when the adopter doesn't wire one explicitly. The v5 `createAdcpServer` surface treats this as a hard requirement and returns `SERVICE_UNAVAILABLE` on every mutating call when unwired — brutal first-30-minutes experience for v6 platform adopters who declared a typed platform but skipped the principal hook.

  Default falls back through `ctx.authInfo?.clientId` (multi-tenant: each authenticated buyer gets its own idempotency namespace) → `ctx.sessionKey` → `ctx.account?.id` (single-tenant fallback). Adopters override by passing `resolveIdempotencyPrincipal` in opts; the spread keeps explicit values winning so adopters who want strict v5 semantics can opt back in.

  Surfaced by Emma matrix v2 — first run after the path consolidation that actually got LLM-driven adopters reaching for `createAdcpServerFromPlatform`. Every mutating call returned `SERVICE_UNAVAILABLE` because Claude (correctly) didn't wire the principal hook. The framework should provide sane defaults for the common case.

- 26de489: Round-1 expert feedback on 6.0 close-out: hydration safety + tenant security + skill phase-2 partial.

  ## Hydration safety (security + protocol experts)
  - `hydrateSingleResource` and `hydratePackagesWithProducts` now attach the hydrated field as **non-enumerable** so accidental serialization (`JSON.stringify(req)`, spread `{...req}`, `Object.entries(req)`) does NOT carry the publisher's `ctx_metadata` blob into request-side audit / log sinks. Direct property access (`req.media_buy.ctx_metadata`) still works.
  - Hydrated objects carry a non-enumerable `__adcp_hydrated__: true` marker so middleware and handler authors can disambiguate "publisher passed it" from "framework attached it".
  - New leak-prevention test asserts `JSON.stringify` and `Object.keys` do not surface hydrated fields.

  ## TenantRegistry security (security expert mediums)
  - **Per-alias JWKS validation**: `runValidation` now hits every URL in `agentUrls[]` independently. Aliases share the signing key but had no separate brand.json check before — DNS hijack on an alias could serve responses no buyer can verify. First permanent failure short-circuits and disables the tenant.
  - **Register-time collision check**: `register()` rejects when a tenant's `(host, pathPrefix)` route overlaps with an already-registered tenant. Without this two tenants could silently claim the same alias; the first-inserted would win, dependent on Map iteration order.
  - **`TenantStatus.agentUrls`**: status now exposes the full URL list (not just canonical) so ops dashboards can detect aliases and distinguish multi-URL tenants from single-URL ones.

  ## Seller skill phase-2 partial (DX + product + prompt-engineer)
  - Five v5 code blocks in `skills/build-seller-agent/SKILL.md` now carry `> **LEGACY (v5)**` blockquote prefixes flagging the inconsistency between the v6 canonical opening example and the deeper v5 examples that #1088 phase 2 will migrate. The Implementation worked example (line 866 — the highest-LLM-target deep block per prompt-engineer review) gets a stronger callout pointing scaffolders at the v6 skeleton.
  - `createAdcpServer`'s top-level JSDoc adds `@see` breadcrumbs pointing at `createAdcpServerFromPlatform` and the `@adcp/sdk/server/legacy/v5` subpath.

  Closes round-1 expert feedback. Refs #1086 #1087 #1088.

- ea69989: feat(server): `@adcp/sdk/server/legacy/v5` subpath for the v5 handler-bag constructor. Adopters mid-migration or pinning to v5 long-term (custom `tools[]`, `mergeSeam`, `preTransport` middleware) import `createAdcpServer` from the subpath; new code keeps reaching for `createAdcpServerFromPlatform` from `@adcp/sdk/server`. Top-level re-export keeps working with its existing `@deprecated` JSDoc tag.

  Closes #1081.

- a1c144f: Pool shortcut on `createAdcpServerFromPlatform`, real ctx_metadata strip-on-wire chokepoint, Postgres operations guide.

  **`opts.pool` shortcut.** Pass a `pg.Pool` (or any `PgQueryable`) and the framework wires `idempotency` + `ctxMetadata` + `taskRegistry` internally with sensible defaults. Explicit per-store opts still win — pool fills only the unset ones. New `getAllAdcpMigrations()` returns combined DDL for all three tables.

  ```ts
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query(getAllAdcpMigrations());

  createAdcpServerFromPlatform(myPlatform, {
    name: '...',
    version: '...',
    pool, // wires all three persistence stores
  });
  ```

  Slim skill `Run it` section updated to use the shortcut as the canonical bootstrap.

  **Strip-on-wire chokepoint actually runs now.** Previous shipping (6.1.0) added `WireShape<T>` compile-time enforcement + `stripCtxMetadata` helper, but the runtime walk wasn't wired into the dispatch path — handler returns containing `ctx_metadata` flowed straight to the wire. Fix: `projectSync` (the single async-handler chokepoint every framework-derived tool dispatches through) now calls `stripCtxMetadata` after `mapResult` and before idempotency cache write. Mutates the response object in place; every handler builds a fresh response per call so this is safe.

  Defense surfaces now covered:
  - Compile-time: `WireShape<T>` strips at the type level
  - Runtime: `stripCtxMetadata` shape-aware walk runs at the `projectSync` chokepoint
  - Idempotency cache replay: strip runs BEFORE the cache write, so cached responses stay clean
  - Symbol tag: retrieved blobs carry `[ADCP_INTERNAL_TAG]` (won't survive `JSON.stringify`)

  New comprehensive negative test (`test/server-ctx-metadata-leak-paranoia.test.js`): builds a hostile platform that returns `ctx_metadata` on every resource at every nesting level, dispatches every wire tool, asserts no buyer-facing payload contains `LEAK_CANARY` or `ctx_metadata` anywhere. 9 tools × 3 leak detectors per tool. **This regression-blocks any future strip-bypass.**

  **Postgres operations guide** at `docs/guides/POSTGRES.md`: schema + index rationale per table, sizing guidance, connection pool sizing, statement timeout recommendations, vacuum/autovacuum guidance, monitoring queries, cleanup cadence, multi-tenant deployment notes, backup/DR risk model. Closes the "how do implementors think about the database we ship?" gap.

  223 tests passing on focused suite (added 9 leak paranoia + 3 pool shortcut).

- a1c144f: Consolidate v6 platform surface into `@adcp/sdk/server`. The `./server/decisioning` subpath is removed; everything previously under it (`createAdcpServerFromPlatform`, `DecisioningPlatform`, `SalesPlatform`, `CreativeBuilderPlatform`, `AccountStore`, `TenantRegistry`, `publishStatusChange`, `AdcpError`, etc.) now exports from `@adcp/sdk/server` alongside `createAdcpServer` and the rest of the v5 handler-bag API.

  **Motivation.** The v6 path is internally a wrapper around `createAdcpServer` — it builds an `AdcpServerConfig` and calls v5 underneath. Hiding that under a separate subpath was misleading: LLM-driven adopters (and humans skimming docs) consistently landed on `@adcp/sdk/server` and missed the platform surface entirely. Putting both functions in one path makes the choice "which function shape do I want?" rather than "which import path is the real one?" and matches the actual dependency relationship.

  **Migration.** Anywhere you imported from `@adcp/sdk/server/decisioning`, change to `@adcp/sdk/server`. The exports are identical; only the path changes.

  ```ts
  // Before:
  import { createAdcpServerFromPlatform, type DecisioningPlatform } from '@adcp/sdk/server/decisioning';

  // After:
  import { createAdcpServerFromPlatform, type DecisioningPlatform } from '@adcp/sdk/server';
  ```

  No compat alias is shipped — `@adcp/sdk/server/decisioning` was preview-only and never published as GA. Only adopters who linked the in-flight 5.x branches need to update.

- a1c144f: Two TenantRegistry refinements surfaced by training-agent v6 spike:
  - **`TenantConfig.jwksUrl`** (F8) — explicit override for the JWKS fetch URL when a single host serves multiple agents under path prefixes (e.g., `https://shared.example.com/api/training-agent/{signals,sales,creative}`). The default validator's `new URL('/.well-known/brand.json', agentUrl)` resolution collapses every sub-routed agent onto host root, conflating their brand identities. Setting `jwksUrl` lets sub-routed deployments point each tenant at its own brand.json. Spec convention is host-root, so the override is only needed for sub-routed multi-tenant hosts; standard single-brand-per-host deployments keep working unchanged. `JwksValidator.validate` signature gains the optional `jwksUrl` argument so custom validators can read it too.
  - **`autoValidate: false` footgun guard** (F7) — `createTenantRegistry({ autoValidate: false })` now emits a one-shot `console.warn` at construction explaining that tenants will stay in `'pending'` health and `resolveByRequest` will refuse all traffic until the operator calls `recheck()` for each tenant. Previous behavior was silent — developers reaching for the flag expecting "skip the validation cost" got "block all traffic" with no signal. JSDoc tightened to call out the intent (tests driving validation manually).

- a1c144f: Add canonical buyer-persona library at `@adcp/sdk/testing/personas`. Four typed `BuyerPersona` fixtures (DTC skincare, luxury auto, B2B SaaS, restaurant local) carry brand identity + account ID + brief + budget + channels — enough to drive `get_products` / `create_media_buy` against any seller without rolling per-adopter buyer fixtures. Three builder helpers (`buildAccountReference`, `buildBrandReference`, `buildGetProductsRequest`) construct wire-shaped requests in one line. Surfaces a `getPersonaById` lookup for storyboard fixture selection. Adopters extending the set should keep brand domains on `.example.com` (enforced by the test suite to prevent real-world branding leak). Surfaced by Snap migration spike round-6 — every adopter was rewriting buyer-persona fixtures locally.
- a1c144f: Address training-agent team's final feedback before 6.0.1 GA. Three SDK-side gaps surfaced during their final integration pass:
  - **`TenantRegistry.get(tenantId)`** — direct tenant lookup by ID without URL parsing. Path-routed adopters who bind tenantId at their own route layer no longer have to call `resolveByRequest(canonicalHost, '/<id>/mcp')` purely as a tenantId-lookup workaround. Same `pending` / `disabled` health gate as the `resolveByXxx` helpers; `unverified` (post-healthy transient) tenants resolve normally.
  - **NODE_ENV in-memory-task-registry error message** — now suggests `taskRegistry: createInMemoryTaskRegistry()` as the explicit pass-in path (recommended over the `ADCP_DECISIONING_ALLOW_INMEMORY_TASKS=1` env-flag workaround). Adopter code that says "yes I want in-memory in production" in TypeScript is the right shape.
  - **`WebhooksConfig` named type export** — the `webhooks?:` option on `AdcpServerConfig` was an inline `Pick<WebhookEmitterOptions, ...>` with no public alias, forcing adopters into `as any` casts when the shape was settled. New `WebhooksConfig` named type exported from `@adcp/sdk/server` closes the gap.

  Migration doc gains gotchas for the JWKS host-root resolution (with the `TenantConfig.jwksUrl` override recipe for path-routed brand identities) and the new `get(tenantId)` lookup pattern.

  `agentUrls: string[]` for cutover scenarios (canonical + legacy URLs both resolving to the same tenant) deferred to a follow-up — `TenantRegistry.get(tenantId)` + adopter-side route layer is the recommended workaround for now.

- a1c144f: Ship 20 typed `AdcpError` subclasses + slim `build-decisioning-platform` skill from 947 → 205 lines + enrich enum-validation errors with allowed values.

  **Empirical baseline:** Emma matrix v18 (2026-04-30) surfaced two cascading failure classes for LLM-generated sellers:
  1. `get_products` returns a `channels` value not in the spec enum → wire response fails schema validation → all subsequent storyboard steps cascade-skip with "unresolved context variables: product_id". The validation error said "must be equal to one of the allowed values" but didn't enumerate them — LLMs (and humans) couldn't self-correct without fetching the schema.
  2. `update_media_buy` with bogus `package_id` returned `SERVICE_UNAVAILABLE` instead of `PACKAGE_NOT_FOUND`. The LLM threw a generic exception because the `AdcpError` code catalog wasn't visible at the throw site.

  Both failures collapse to "the LLM doesn't know what's in the closed enum at codegen time." This change makes the closed enums visible.

  **Typed error classes** (in `@adcp/sdk/server`):

  ```ts
  import {
    PackageNotFoundError,
    MediaBuyNotFoundError,
    ProductNotFoundError,
    ProductUnavailableError,
    CreativeNotFoundError,
    CreativeRejectedError,
    BudgetTooLowError,
    BudgetExhaustedError,
    IdempotencyConflictError,
    InvalidRequestError,
    InvalidStateError,
    BackwardsTimeRangeError,
    AuthRequiredError,
    PermissionDeniedError,
    RateLimitedError,
    ServiceUnavailableError,
    UnsupportedFeatureError,
    ComplianceUnsatisfiedError,
    GovernanceDeniedError,
    PolicyViolationError,
  } from '@adcp/sdk/server';

  throw new PackageNotFoundError('pkg_123'); // code, recovery, field set automatically
  throw new BudgetTooLowError({ floor: 5000, currency: 'USD' }); // floor + currency in details
  throw new RateLimitedError(60); // retry_after clamped to spec [1, 3600]
  ```

  Each class encodes the canonical `code` / `recovery` / `field` / `suggestion` shape — adopters pick from a closed set of class imports rather than memorizing 44 string codes plus their recovery semantics.

  **Skill slim:** `skills/build-decisioning-platform/SKILL.md` rewritten to 205 lines from 947 (78% reduction). Structure: 5 functions + typed-error catalog + ctx_metadata + serve() + operator checklist + pointers to advanced/. Advanced concerns (HITL, multi-tenant, OAuth, sandbox, compliance, governance, brand-rights, idempotency tuning, state machine) moved to `skills/build-decisioning-platform/advanced/*.md`. Original full content preserved as `advanced/REFERENCE.md`. Empirical hypothesis: LLMs scaffolding from the slim skill build a working agent without reading anything else.

  **Validation error enrichment:** `keyword: 'enum'` failures now project `allowedValues: [...]` on the wire envelope's `adcp_error.issues[]` AND replace the opaque "must be equal to one of the allowed values" message with the actual list (e.g., "must be one of: \"display\", \"video\", \"audio\""). Buyers (and LLMs) self-correct on first response without needing the schema.

  Backwards-compatible. Adopters using `AdcpError` directly continue to work; typed classes are convenience wrappers. Validation enrichment adds an optional `allowedValues` field; no callers required to read it.

  Closes recurring matrix failures from Emma v18.

### Patch Changes

- a1c144f: **Fix: `AccountStore` merge-seam shadow** (`createAdcpServerFromPlatform`).

  `buildAccountHandlers` previously emitted UNSUPPORTED_FEATURE stubs for `syncAccounts` / `listAccounts` whenever `platform.accounts.upsert` / `accounts.list` were undefined. Under the merge seam (platform-derived wins per-key), those stubs shadowed adopter-supplied `opts.accounts.{syncAccounts,listAccounts}` fillers — every mutating `sync_accounts` / `list_accounts` call returned UNSUPPORTED_FEATURE even though the adopter had wired a working v5-style handler.

  Fixed by gating the platform-derived handler on whether `accounts.upsert` / `accounts.list` are actually defined (matching the existing `reportUsage` / `getAccountFinancials` pattern). Adopters who claim those tools without implementing the platform method AND without supplying a merge-seam override get the framework's "tool not registered" path — closer to the truth than a fabricated UNSUPPORTED_FEATURE envelope.

  Two regression tests pin the behavior: `opts.accounts.syncAccounts runs when platform.accounts.upsert is undefined` and `opts.accounts.listAccounts runs when platform.accounts.list is undefined`.

  Migration-doc additions:
  - **`resolveIdempotencyPrincipal` MUST be forwarded.** v5.x adopters who passed it to `createAdcpServer` need to pass it to `createAdcpServerFromPlatform` too — the framework doesn't synthesize one. Without it, every mutating tool returns `SERVICE_UNAVAILABLE: Idempotency principal could not be resolved`. Symptoms look like a transient outage at first run; same call consistently fails the second time.
  - **`ctx.account.authInfo` (specialism methods) vs `ctx.authInfo` (`ResolveContext` only).** Inside `accounts.resolve(ref, ctx)`, the second arg is `ResolveContext` and exposes `ctx.authInfo`. Inside a `SalesPlatform` / `AudiencePlatform` / etc. method, the second arg is `RequestContext` and the auth principal lives at `ctx.account.authInfo` — distinct shapes, same field, different paths.
  - **`mergeSeam: 'strict'` from day 1.** Promoted from a tradeoff table to the recommended default for new deployments + migrations. With `strict`, the AccountStore-shadow bug above would have surfaced as `PlatformConfigError` at construction time instead of as a silent runtime UNSUPPORTED_FEATURE response — substantial DX improvement that's worth the back-compat hit during migration.

- c44cad8: docs: corpus migration phase 1 — seller skill v5 → v6 prose + canonical example

  Migrates the highest-LLM-target file (`skills/build-seller-agent/SKILL.md`) from v5 `createAdcpServer` patterns to v6 `createAdcpServerFromPlatform`. Phase 1 covers:
  - Canonical opening platform skeleton (replaces the v5 handler-bag example with a typed `DecisioningPlatform<TConfig, TCtxMeta>` class)
  - SDK Quick Reference table (v6 first; v5 marked legacy + pointing at `@adcp/sdk/server/legacy/v5`)
  - Common Mistakes table (call out v5-in-new-code as a misuse)
  - 13 narrative prose mentions (idempotency, webhooks, context echo, response builders, generics, cross-refs)

  Phase 2 (tracked separately on #1088) covers the deeper code-block rewrites in this file (~6 multi-line examples) plus the other 8 skill files, `BUILD-AN-AGENT.md`, and the `.claude/skills/` mirror.

  Closes part of #1088 (phase 1 only).

- 3f82d6f: docs: corpus migration phase 2A — seller skill deep-block migration + .claude mirror surface migration

  Continues #1088 corpus migration. Phase 2A delivers:
  - **`skills/build-seller-agent/SKILL.md` deep blocks fully migrated** to v6 — all 5 v5 code examples (signed-requests resolveIdempotencyPrincipal, webhook emission, bridgeFromTestControllerStore, full Implementation worked example, HITL with `taskToolResponse`) are now `class MyClass implements DecisioningPlatform<>` with `createAdcpServerFromPlatform(...)`. Only 3 `createAdcpServer` mentions remain — all intentional callouts to the `@adcp/sdk/server/legacy/v5` subpath.
  - **`.claude/skills/build-seller-agent/SKILL.md` mirror surface migration** — Quick Reference table, Implementation prose (with LEGACY callout pointing at the canonical v6 in `skills/build-seller-agent/`), Common Mistakes table, Idempotency wire-up prose, Production-wiring LEGACY callout, cross-references all updated. The deep code blocks remain at v5 with LEGACY callouts (phase 2B).
  - **typecheck-skill-examples baseline updated** to absorb new illustrative-only blocks.

  Phase 2B (still on #1088) covers the remaining sibling skills (governance, generative-seller, retail-media, signals, si, creative), `BUILD-AN-AGENT.md`, and the .claude mirror's deep code blocks. **Subagent attempt blocked**: 5 parallel docs-expert agents all hit `Edit/Write permission denied` from the harness sandbox; phase 2B needs an unsandboxed session OR sandbox config update.

  Refs #1088.

- 5223f9a: docs: corpus migration phase 2B — 6 sibling skills migrated v5 → v6

  Continues #1088. The remaining 6 sibling skill files migrate from v5 `createAdcpServer` patterns to v6 `createAdcpServerFromPlatform` + typed `DecisioningPlatform` class:
  - `skills/build-generative-seller-agent/SKILL.md` — 12 → 2 v5 mentions (legacy callouts only)
  - `skills/build-governance-agent/SKILL.md` — 12 → 1
  - `skills/build-retail-media-agent/SKILL.md` — 12 → 3
  - `skills/build-si-agent/SKILL.md` — 9 → 1
  - `skills/build-creative-agent/SKILL.md` — 12 → 2
  - `skills/build-signals-agent/SKILL.md` — 13 → 2

  Total 70 → 11 mentions (84% reduction). The remaining 11 are all intentional callouts in SDK Quick Reference tables ("`createAdcpServer(config)` _(legacy)_") and Common Mistakes table rows that point adopters at the `@adcp/sdk/server/legacy/v5` subpath for mid-migration / escape-hatch use only.

  Each skill's canonical Implementation worked example is now a typed `class implements DecisioningPlatform<>` skeleton with the appropriate sub-platform interfaces (`SalesPlatform`, `SignalsPlatform`, `CreativeBuilderPlatform` / `CreativeAdServerPlatform`, `CampaignGovernancePlatform` + `PropertyListsPlatform`, `SponsoredIntelligencePlatform`). All imports moved from `@adcp/sdk` to `@adcp/sdk/server` for server-side surface.

  The matrix-failing skills (governance, generative-seller, retail-media, si, creative_ad_server) should now scaffold to v6 cleanly. Re-running the Emma matrix is the next validation step — expected uplift from 3/16 to a meaningful improvement.

  Refs #1088. Closes phase 2B. Phase 2 of #1088 is now complete; full corpus migration done apart from `BUILD-AN-AGENT.md` (high-traffic doc, deferred to phase 2C).

  Subagent attempt during phase 2 was sandbox-blocked — these files were migrated manually in the parent session.

- a1c144f: `createAdcpServerFromPlatform` now projects `accounts.resolution: 'explicit'` (or the explicit `capabilities.requireOperatorAuth: true` flag) onto the wire `get_adcp_capabilities.account.require_operator_auth` block. Without this, the storyboard runner's account-mode capability gate never fired for v6 platforms — explicit-mode adopters who correctly didn't implement `sync_accounts` saw a `'missing_tool'` skip on every storyboard run instead of `'not_applicable'`. Surfaced by Snap migration spike (F9).
- a1c144f: `createAdcpServerFromPlatform` now projects `compliance_testing.scenarios` onto `get_adcp_capabilities`. Previously the framework validated capability/adapter consistency (refusing the `complyTest`-without-capability or capability-without-`complyTest` shapes at construction) but never wrote the wire response — buyers calling `get_adcp_capabilities` saw an empty `compliance_testing: {}` block and the comply-track runner fired a warning on every call. Auto-derives scenarios from the wired adapter set (force + simulate; seeds deliberately not advertised, per the spec's narrowed wire enum). An explicit `capabilities.compliance_testing.scenarios` overrides auto-derivation when adopters want to advertise a subset. Internal `ComplianceTestingCapabilities.scenarios` type tightened to the wire's force-plus-simulate enum to match. Surfaced by training-agent v6 spike round 5 (Issue 4).
- a1c144f: `createAdcpServerFromPlatform` now projects `capabilities.supportedBillings` onto the wire `get_adcp_capabilities.account.supported_billing` block. Without this, retail-media adopters that declared `['operator']` saw their buyers default-route through agent-billed pass-through flows. Same projection seam as the F9 `require_operator_auth` fix. Surfaced by training-agent v6 spike (F5).
- 6066a7a: Fix `ctx.store` losing state across requests when adopters use the documented `serve(() => createAdcpServer({...}))` factory pattern.

  **Root cause:** `createAdcpServer({stateStore = new InMemoryStateStore()})` evaluated the destructuring default per call. Since `serve()` invokes the factory on every incoming request, each request got a brand-new in-memory store — silently dropping every prior `ctx.store.put(...)`.

  **Empirical evidence:** matrix run reproduced an LLM-built SI agent that put session state in `ctx.store.put('session', ...)` on `si_initiate_session` and got `RESOURCE_NOT_FOUND: Session not found` on the next request's `si_send_message`. The agent code was textbook-correct per the skill — the framework default was the bug.

  **Fix:** the default `InMemoryStateStore` is now a module-singleton. Adopters who write the obvious code get cross-request persistence as the skills (creative, SI, etc.) explicitly promise. Multi-tenant adopters and production deployments still pass their own `stateStore` (Postgres, Redis, etc.) and are unaffected. Existing tests that need isolation already opt into a fresh store explicitly.

  Also hardens the matrix harness's `killPort()` to sweep orphaned `tsx adcp-agent-*` zombies that survived a parent `pkill` against the matrix runner — needed to prevent cross-run port contamination.

  Regression test added at `test/server-state-store-extensions.test.js`: two `createAdcpServer` factory invocations must share `ctx.store`, and a value put through one must be readable through the other.

- 54789c6: Schema validator now compacts `oneOf` / `anyOf` error cascades into a single actionable issue. With Ajv `allErrors: true`, a malformed value at a discriminated-union field (e.g., a typo'd `pricing_model` against the 9-variant `pricing_options` union) previously produced one `const` mismatch error per non-matching variant, plus per-variant `required` errors, plus a synthetic "must match exactly one schema" root — 14+ issues for a single caller mistake.

  The new post-processor inspects each variant's schema for `const`-constrained properties and treats any path where ≥2 variants assert `const` as a candidate discriminator. That covers single-field discriminators (`pricing_options.pricing_model`) and composite ones (`audience-selector` `(type, value_type)`). A candidate path collapses iff _every_ variant that asserts `const` there emitted a `const` error — so a value the caller already satisfied isn't surreptitiously flipped into the "must be one of" list. Each collapse becomes a synthetic `enum`-keyword issue carrying the union of allowed const values; `formatIssue`'s existing enrichment renders "must be one of: A, B, ...". After collapse, if any variant had zero residual errors, the discriminator collapse fully explains the failure and the synthetic union root is dropped along with sibling residuals; otherwise the validator picks the variant with fewest residuals (tie-breaking by fewest residual `const` errors so the variant whose discriminator the caller actually picked wins).

  `ValidationIssue.allowedValues` is already on the wire for `enum` keyword issues, so naive LLM clients self-correcting from the `adcp_error.issues[]` projection see one actionable line ("`pricing_model` must be one of: `cpm`, `cpc`, `cpcv`, ...") instead of a 14-line cascade. Independent unions in the same response (e.g., `products[0]` and `products[1]` both failing) stay independent via instancePath scoping. Nested unions are processed deepest-first so an inner cascade doesn't poison its outer parent's variant-residual count.

  Note: the upstream issue (adcontextprotocol/adcp-client#1111) that motivated this work was ultimately diagnosed as a downstream fixture bug in `adcp-client-python`'s `seed_product` — the validator was correctly flagging real missing fields, not over-reporting from non-matching variants. The cascade-compaction work stands on its own merits: any caller who hits a real bad-discriminator value in any oneOf-discriminated field now gets a focused error instead of variant noise.

- 105d0a4: Pre-ship round 2: auto-hydration error contract + 6.0 migration cheatsheet.

  ## Auto-hydration error contract (ask #1)

  Pinned the documented contract for stale/missing references in `hydrateSingleResource` JSDoc and the migration guide:
  - Hydration miss does NOT cause `MEDIA_BUY_NOT_FOUND` / `PRODUCT_NOT_FOUND` etc. The framework cache is a hint, not a source-of-truth check.
  - On a miss the handler runs anyway with `target[attachField]` undefined.
  - Adopters who want strict existence checks implement them in the handler (with the typed error classes — `MediaBuyNotFoundError`, etc.).

  New contract test in `test/server-auto-hydration-extended.test.js` pins the behavior: handler IS called on miss, framework does NOT synthesize an error response.

  ## 6.0 migration cheatsheet (ask #3)

  `docs/migration-5.x-to-6.x.md` gains a top-level "tl;dr — five breaking changes to search-replace" table covering:
  1. `Account.metadata` → `Account.ctx_metadata`
  2. `@adcp/sdk/server/decisioning` → `@adcp/sdk/server`
  3. `createAdcpServer` → `createAdcpServerFromPlatform` (or `@adcp/sdk/server/legacy/v5`)
  4. `TMeta` → `TCtxMeta` generic param
  5. `getMediaBuys` required on `SalesPlatform`

  Plus a one-shot search-replace recipe block for adopters who skipped rounds 11–14 and face the cumulative diff at GA.

  ## Note on ask #2 (already shipped)

  `resolveIdempotencyPrincipal` already takes `IdempotencyPrincipalParams` — a typed shape with `account?: { account_id?, brand?, sandbox? }` and `brand?: { domain? }` extending `Record<string, unknown>`. Adopters scoping by `params.account?.account_id` or `params.brand?.domain` get autocomplete + narrowing without a cast. See `src/lib/server/create-adcp-server.ts:681-686` and the signature at line 1230.

- 6066a7a: Pre-ship deep fixes from Emma matrix run 2 — three skill corrections + two framework guards driven by patterns LLMs scaffolded incorrectly when building agents from skills.
  - **Signals skill**: typed the `signals` array as `GetSignalsResponse['signals']` so the LLM-scaffolded `signal_agent_segment_id` field can't be silently omitted. Strict response validation already rejects malformed signals at runtime in dev/test; this surfaces the contract at the LLM's first touchpoint.
  - **`autoStoreResources`**: log a warning when records are skipped because the required id field (`signal_agent_segment_id`, `product_id`, etc.) is missing — silently skipping leaves buyers unable to reference the resource on a downstream mutating call, and is a strong indicator the publisher returned a misshaped response.
  - **SI skill**: removed the phantom `SponsoredIntelligencePlatform` import and the invalid `'sponsored-intelligence'` specialism declaration (`AdCPSpecialism` does not include SI — it's a _protocol_, declared via `supported_protocols`). Skill now points adopters at the v5 `createAdcpServer` from `@adcp/sdk/server/legacy/v5` (the only path that ships SI dispatch today) with explicit `ctx.store.put('session', ...)` / `ctx.store.get('session', ...)` for session state. SI specialism + auto-hydration of `req.session` is a v6.x follow-up.
  - **`call-adcp-agent` skill**: documented the upstream MCP transport quirk — `Accept: application/json, text/event-stream` is required by `@modelcontextprotocol/sdk`'s Streamable HTTP transport. A naive `fetch()` with only `Accept: application/json` gets `406 Not Acceptable` before any AdCP framing runs. Added a Symptom→Fix row pointing at the official client.
  - **`createMediaBuy` HITL guard**: framework now rejects hand-rolled `{status: 'submitted', task_id}` returns from the sales/creative specialism handlers with a clear error pointing at `ctx.handoffToTask(fn)`. The framework owns the submitted envelope; bare submitted-shape returns skipped the task registry, leaving buyers polling task_ids the framework never registered.

- 5f56f10: Pre-ship cleanup driven by adopter feedback on the v6.0 RC. Two surface tightenings + one doc consolidation.

  **Auto-hydration error contract surfaced in the migration doc.** With auto-hydration on for four mutating verbs (`createMediaBuy`, `updateMediaBuy`, `activateSignal`, `acquireRights`), the contract for stale or missing references multiplies. The framework's behavior on a hydration miss has been documented in source JSDoc since the auto-hydration extension landed, but adopters reading the skill see only the happy path. New "Auto-hydration error contract" block in `docs/migration-5.x-to-6.x.md` walks the three possible meanings of a miss (cold start, eviction, unknown id), explains why the framework does NOT throw `PRODUCT_NOT_FOUND` / `MEDIA_BUY_NOT_FOUND` (cache is a hint, not source-of-truth), shows the handler-side existence-check pattern with a `MediaBuyNotFoundError` example, and describes the `__adcp_hydrated__` non-enumerable marker for handler authors who want to disambiguate "publisher passed it" from "framework attached it." Adopters can drop their pre-flight existence-check round-trip on hits; misses still flow through the publisher's DB the same way they did in 5.x.

  **`IdempotencyPrincipalParams.account` / `.brand` now use canonical wire types.** Previously inline-typed as a flat shape with everything optional. Adopters scoping by `params.account?.account_id` (the public-token-shared-across-tenants pattern) had to live with the loose shape; replaced with `AccountReference` / `BrandReference` from the generated wire types so the discriminated union is exposed end-to-end. Adopters get autocomplete + narrowing on both variants. JSDoc updated with the recommended `if ('account_id' in params.account)` discriminating pattern.

  **Migration doc consolidation verified.** The cumulative breaking-changes table in `docs/migration-5.x-to-6.x.md` covers all five round-by-round breaking changes (`Account.metadata` rename, server-subpath consolidation, `createAdcpServer` removal, `TMeta` → `TCtxMeta`, `getMediaBuys` required) with one-liner search-replace recipes — already lands cleanly for the round-skipping adopter view; no edits needed.

- 6066a7a: Two follow-ups to the state-store singleton fix:

  **Signals skill example fully typechecks.** The previous baseline accepted 5 type errors masked by a syntax error: `accounts.upsert/list` signatures (now omitted — they're optional on `AccountStore`), `activateSignal` returning `adcpError(...)` (replaced with `throw new AdcpError(...)` matching the success-arm-only return type), `ctx.store.put` (replaced with a publisher-internal `Map` — v6 `RequestContext` has no `store` field; persistence is the publisher's responsibility unless they wire a `CtxMetadataStore`). LLMs reading this skill now scaffold v6-correct code on first try. Baseline tightened (207 → 202 entries).

  **Multi-tenant footgun warning on default `stateStore`.** `createAdcpServer` now emits a one-time `logger.warn` when the module-singleton default in-memory store is used. Single-tenant adopters (everything the skills demonstrate) see the message once at process start and ignore it; multi-tenant deployments see the warning and either pin an explicit per-tenant store or wire `PostgresStateStore`. Process-scoped guard so `serve(() => createAdcpServer({...}))` doesn't spam logs every request.

  v6.0.1 will upgrade the warning to a `NODE_ENV=production` hard refusal, mirroring `buildDefaultTaskRegistry`'s task-registry policy — adopters set `ADCP_DECISIONING_ALLOW_INMEMORY_STATE=1` to opt in explicitly. Tracked separately.

- a1c144f: Storyboard runner's stateful-cascade flag now lives at storyboard scope, not phase scope. Cross-phase storyboards (e.g., `signal_marketplace/governance_denied`: governance setup in phase 1, signal-activation assertion in phase 3) reset the cascade at every phase boundary in the previous implementation, so a stateful step that skipped in phase 1 didn't gate stateful consumers in phase 3 — they ran against absent state and surfaced misleading assertion failures. Lifting `statefulFailed` + `statefulSkipTrigger` out of the per-phase loop closes this gap. Adopter-confirmed against the training-agent `/signals` tenant: round-7 was 4/5 storyboards passing for this reason; round-8 should be 5/5.
- a1c144f: Storyboard runner now cascade-skips stateful steps when a prior stateful step skipped for a missing-state reason (`missing_tool`, `missing_test_controller`, `not_applicable`). Previously the cascade tripped only on FAILED stateful steps, so a setup step that skipped because the agent didn't advertise the required tool left subsequent stateful steps to run against absent state — surfacing as misleading "X didn't match" assertion failures instead of the cleaner `prerequisite_failed` skip. Benign skips (`peer_branch_taken`, `oauth_not_advertised`, `controller_seeding_failed`) deliberately don't trip the cascade because state DID materialize via another path. The cascade detail message distinguishes a skip-trigger (`prior stateful step "X" skipped (reason); state never materialized.`) from a fail-trigger (`prior stateful step failed.`) so the diagnostic is truthful in both directions. Surfaced by training-agent v6 spike (F6) on cross-specialism `signal_marketplace/governance_denied`.

  **Heads-up: pass-rate shift.** Storyboards that previously failed for single-specialism agents because a downstream stateful step asserted against absent state now grade as cleanly skipped (`prerequisite_failed`). The agent isn't being graded differently — the storyboard is correctly identifying that it's out of scope for the agent. Cross-specialism storyboards historically counted toward "fail" totals for adopters who legitimately don't implement every specialism; expect those numbers to drop. `phasePassed` only flips on hard failures, so cascade-skipped steps don't count as failed in the comply-track rollup either.

- a1c144f: **Fix: storyboard runner now fails loudly on discovery errors** (`runStoryboard`).

  When agent capability discovery (`get_agent_info` / MCP `tools/list`) failed — typically due to MCP transport setup / auth misconfiguration / network policy issues against localhost agents — the runner used to silently emit `agentTools: []` and let every step skip with `skip_reason: 'missing_tool'`. The result was an "X/X clean" CI summary with 100% skipped: indistinguishable from "agent legitimately doesn't claim those tools" and **invisible in pipelines**.

  The v6 training-agent migration spike surfaced this when storyboards reported "4/4 clean" with 20 skipped steps because `connectMCPWithFallback`'s StreamableHTTP attempt was failing and the SSE fallback got 405 — discovery threw, was caught silently, every subsequent step skipped.

  Fixed at the runner layer (which is also Layer 1 of the [upstream draft's two-layer recommendation](#)):
  - `runStoryboard` now checks `discovered.step.passed` after `getOrDiscoverProfile` and returns a hard-failure `StoryboardResult` (`overall_passed: false`, `failed_count: 1`, no skipped-step masquerade) when discovery failed.
  - New exported helper `buildDiscoveryFailedResult(agentUrls, storyboard, discoveryStep)` constructs the synthetic phase + step. The underlying transport error is preserved verbatim in `step.error` so operator triage sees the original cause (e.g. `SSE error: Non-200 status code (405)`).

  This catches the failure mode immediately in CI rather than after someone notices "everything is skipped" weeks later. Layer 2 (the StreamableHTTP-vs-SSE transport-selection bug under non-`{test,development}` `NODE_ENV`) is a separate investigation; this fix ensures whatever discovery error surfaces, it surfaces loudly.

  2 unit tests pin the result shape: full transport-error preservation, plus the no-error-string fallback.

- 6066a7a: Repo-wide sweep of `createAdcpServer` imports after the v6.0 breaking change. Every adopter-facing surface (skills, docs, examples, test agents) now points at `@adcp/sdk/server/legacy/v5` (the only path that still exports it) and every internal JSDoc `@example` shows the same path so IDE hover help stays correct.
  - 5 docs (`docs/guides/BUILD-AN-AGENT.md`, `CONCURRENCY.md`, `VALIDATE-LOCALLY.md`, `VALIDATE-YOUR-AGENT.md`, `docs/llms.txt`)
  - 3 skill files (`skills/build-brand-rights-agent/SKILL.md`, `skills/build-seller-agent/deployment.md`, `skills/build-si-agent/SKILL.md`)
  - 1 migration doc (`docs/migration-5.x-to-6.x.md`) — updated to reflect the actual hard-removal (was previously documented as `@deprecated` deferred-removal)
  - 9 internal JSDoc blocks across `src/lib/server/*` and `src/lib/schemas/index.ts` / `src/lib/compliance-fixtures/index.ts`
  - 3 examples + test agents (`examples/signals-agent.ts`, `test-agents/seller-agent.ts`, `test-agents/seller-agent-signed-mcp.ts`, `test-agents/signals-agent.ts`)
  - 1 matrix harness prompt (`scripts/manual-testing/agent-skill-storyboard.ts`) — now lets the skill drive the import path instead of forcing a single broken one
  - 1 tsconfig update (`test-agents/tsconfig.json`) — added subpath aliases for `@adcp/sdk/server`, `@adcp/sdk/server/legacy/v5`, `@adcp/sdk/signing` so local typecheck resolves the new paths

  Test-agents typecheck clean. 888/888 server tests pass.

- 14afa67: refactor(server): rename `TMeta` → `TCtxMeta` generic parameter across `DecisioningPlatform`, `SalesPlatform`, `AccountStore`, and per-specialism interfaces.

  Type-only rename. The new name reads as "the type of the ctx_metadata blob" and aligns with the `Account.metadata → Account.ctx_metadata` rename that landed earlier in the 6.0 batch. No runtime impact; TypeScript inference at the call site (`class FooSeller implements DecisioningPlatform<Config, MyMeta>`) keeps working.

  Closes #1083

- 7b28886: docs: slim v6.2 RFC to a tombstone pointing at the 3 open follow-on issues (#1091, #1092, #1093). Two of the original five workstreams (Account ctx_metadata flow, buildProduct helpers) shipped in 6.0; the remaining three are now tracked as focused issues so each can be triaged independently.

  Closes #1089.

- 6c25e2d: Run pre-send AJV schema validation on the unadapted v3 request shape, before `adaptRequestForServerVersion` rewrites it for v2 wire format.

  Previously the check ran inside `TaskExecutor.executeTask` against the post-adaptation params. The v2 adapters (`adaptGetProductsRequestForV2`, `adaptCreateMediaBuyRequestForV2`, `adaptUpdateMediaBuyRequestForV2`, `adaptSyncCreativesRequestForV2`) strip v3-only required fields like `buying_mode` and `account` so the request matches the v2 wire contract. The bundled schemas are v3, so strict mode was throwing `ValidationError: Validation failed for field '/buying_mode'` (and similar) on every v2-detected agent, even though the user wrote a valid v3 request.

  The check now runs on `SingleAgentClient` (both `executeTaskWithHandler` and `executeTask` paths) against the user-facing v3 shape before any wire-format adaptation. Validation coverage is preserved for v2 traffic — including tasks like `update_media_buy` that have no Zod schema in `SingleAgentClient.validateRequest` and previously relied entirely on the AJV pass.

  `TaskExecutor.validateRequest(taskName, params, debugLogs?)` is now the public seam; the inline call inside `executeTask` is gone.

- 03952a0: Declare `zod` as a required peer dependency (`^4.1.0`).

  Adopter-reported issue against the v6.0 RC: `pnpm link` (and `npm link`) against a locally checked-out SDK produced 48 TypeScript errors and a 4 GB tsc OOM, because the linked SDK's nested `node_modules/zod` (4.3.6) competed with the consumer's `zod@4.1.12`. Zod 4's `version.minor` literal type tag made the two copies nominally incompatible — `ZodSchema` from the SDK didn't unify with the consumer's `ZodSchema`.

  Without a peer-dep declaration, npm hoisting was the only thing keeping the npm-tarball install path working. The fix:
  - Move `zod` to `peerDependencies` with range `^4.1.0` so the consumer's resolution is authoritative.
  - Keep `zod` in `devDependencies` for the SDK's own build/test.
  - npm 7+ installs peer deps automatically — most consumers see no migration step.
  - `npm link` / `pnpm link` users may need `pnpm dedupe` (or removal of the linked SDK's nested `node_modules/zod`) so the consumer's `zod` resolves at the workspace root.

  Migration doc updated with the link-mode workaround and a separate note about the zod 4.3.0 `.partial()` regression on `.refine()` schemas (not an SDK bug; SDK builds against 4.1.x to avoid silently bumping consumers into the hazard).

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

- ef1aa17: fix(conformance): remove incorrect get_products gate from error_handling, validation, schema_compliance scenarios

  Signals-only agents were skipped entirely for three cross-cutting conformance
  scenarios because SCENARIO_REQUIREMENTS listed get_products as a required tool.
  All three scenarios apply to any agent regardless of tool family:
  - error_handling and validation already use per-tool conditional guards
    internally; removing the outer gate lets them run for signals, creative,
    and governance agents with whatever steps apply to their toolset.
  - schema_compliance gains a signals path: calls get_signals, validates
    GetSignalsResponse via Zod, and checks required field presence
    (signal_agent_segment_id, name, signal_type). Agents with neither
    get_products nor get_signals receive a graceful pass-with-warning.

- 587177f: fix(mcp): skip SSE fallback for private/loopback addresses in connectMCPWithFallback

  Private-IP and localhost agents always support StreamableHTTP POST; the SSE GET probe returns 405 (correct server behavior) which previously masked the real StreamableHTTP failure and caused misleading errors. The new gate surfaces the root-cause StreamableHTTP error directly for private/loopback URLs.

  Also improves StreamableHTTP failure logging: error class name and HTTP status code (from StreamableHTTPError.code) are now included in the debug log entry, making "for reasons not yet pinned down" first-attempt failures diagnosable. The SSE-fallback debug log level changes from info to warning.

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

## 5.22.0

### Minor Changes

- 14623ee: Bump AdCP spec to 3.0.1; expose new sandbox conformance scenarios.

  `ADCP_VERSION` advances from `3.0.0` to `3.0.1`. Per the spec release notes, 3.0.1 is a stable-surface no-op for 3.0-conformant agents — no wire-format changes, no field renames on stable schemas. Adopters whose handlers compile against 3.0.0 keep working unchanged.

  **New test-controller scenarios** (sandbox-only, opt-in via store methods on `TestControllerStore`). Sellers wanting compliance coverage for the AdCP 3.0.1 submitted-arm storyboard, async task completion path, or creative-format storyboards opt in by implementing the matching method — no breaking change for existing stores:
  - `force_create_media_buy_arm` — register a directive shaping the next `create_media_buy` call from this authenticated sandbox account into the requested arm (`submitted` / `input-required`). Returns `ForcedDirectiveSuccess` with the registered arm + optional `task_id` echo. Implement `forceCreateMediaBuyArm({ arm, task_id?, message? })` to advertise. Param validation rejects `task_id` on the `input-required` arm (spec: present only when `submitted`).
  - `force_task_completion` — transition an in-flight task to `completed` and record the supplied completion payload (delivered verbatim to the buyer's `push_notification_config.url`). Returns `StateTransitionSuccess`. Implement `forceTaskCompletion(taskId, result)` to advertise. Param validation rejects array values for `result` (spec: object that validates against `async-response-data.json`).
  - `seed_creative_format` — pre-populate a creative-format fixture so storyboards can reference it by stable ID. Returns `StateTransitionSuccess` (`previous_state` / `current_state` per the existing seed envelope). Implement `seedCreativeFormat(formatId, fixture)` to advertise.

  `expectControllerSuccess` now narrows on `'forced'` and `'seed'` kinds in addition to `'list' | 'transition' | 'simulation'`. The `'seed'` overload is in place for inter-op with sellers that emit the new `SeedSuccess` arm; the SDK's own `dispatchSeed` continues to return `StateTransitionSuccess` (a follow-up will migrate it).

  **Codegen rename — `FormatID` → `FormatReferenceStructuredObject`**: AdCP 3.0.1 changed the `format-id.json` schema title from `"Format ID"` to `"Format Reference (Structured Object)"` (purely documentation; wire shape is identical). The generated TypeScript type follows. The historical `FormatID` name remains exported as an `@deprecated` alias from `@adcp/client` and `@adcp/client/types`, so consumer imports keep working across the bump while editor tooling surfaces the rename. Slated for removal in the next major.

  **Codegen rename — `RATE_LIMITEDDetails` → `RateLimitedDetails`**: 3.0.1 added an explicit `title` to the rate-limited error-details schema so `json-schema-to-typescript` produces PascalCase. The previously-shipped `RATE_LIMITEDDetails_ScopeValues` export is preserved as `@deprecated` pointing at the canonical `RateLimitedDetails_ScopeValues`.

  **Inline-enum count drop** is expected — adcp#3148 + adcp#3174 hoisted ~20 byte-identical inline string-literal unions into shared `enums/*.json` files (e.g. `payment-terms`, `audio-channel-layout`, `match-type`, `governance-decision`). The corresponding per-parent `Foo_BarValues` exports collapse into single canonical names (`PaymentTermsValues`, `AudioChannelLayoutValues`, `MatchTypeValues`, `GovernanceDecisionValues`, …); `inline-enums.generated.ts` now ships 78 entries (was ~100).

  **Back-compat aliases for the 26 collapsed/renamed `Foo_BarValues` exports** ship in `@adcp/client/types` for one minor cycle so existing consumer imports keep compiling. Each is `@deprecated` with a JSDoc pointing at the canonical name. Slated for removal in the next major.

  **Bundler-side enum hoist** (adcp#3170) deduplicates the `Foo` / `Foo1` numbered-suffix codegen artifact at the bundle stage. `core.generated.ts` no longer ships `AgeVerificationMethod1` and similar duplicates.

- 49849f8: feat(testing): add envelope-scoped storyboard validation checks

  Storyboards that assert v3 envelope-level fields (`status`, `task_id`, `message`, `replayed`, `governance_context`, `timestamp`, `context_id`, `push_notification_config`) need a way to tell static drift detection to walk `protocol-envelope.json` instead of the per-tool response schema. The previous un-prefixed checks pointed at the inner response schema, which doesn't contain envelope fields, so the `v3-envelope-integrity.yaml` storyboard required a `VERIFIER_UNREACHABLE` exemption.

  Adds five new `StoryboardValidationCheck` values:
  - `field_absent` — passes when the path is absent; fails when present (companion to `field_present`)
  - `envelope_field_absent` — envelope-scoped companion to `field_absent`; signals drift detection to walk `protocol-envelope.json`; absence checks skip reachability assertions by design
  - `envelope_field_present` — companion to `field_present`
  - `envelope_field_value` — companion to `field_value`
  - `envelope_field_value_or_absent` — companion to `field_value_or_absent`

  **Runtime**: identical semantics to the un-prefixed checks — `TaskResult` already exposes envelope fields at its surface (`data.status`, `data.task_id`, etc.), so the dispatcher passes through to the existing handlers. Result objects report the original check name verbatim so reporters can distinguish. The same passthrough lands in `scripts/conformance-replay.ts` so storyboard replay grades the new checks.

  **Drift detection**: walks `ProtocolEnvelopeSchema` (from `core/protocol-envelope.json`) instead of `TOOL_RESPONSE_SCHEMAS[task]` for envelope-scoped entries. `field_absent` and `envelope_field_absent` are collected by the drift detector but skip reachability assertions — absence checks have no schema target by design.

  **Not envelope fields**: `errors` lives inside `payload` (per the per-tool response schema), and `adcp_version` / `adcp_major_version` are request-side only — these stay on the un-prefixed checks.

  Forward-compatible with the current 3.0.1 storyboards. Lights up when the upstream PR migrates `v3-envelope-integrity.yaml` from `field_present: status` to `envelope_field_present: status` (the `VERIFIER_UNREACHABLE` exemption gets dropped after the next `npm run sync-schemas` post-3.0.2). The `task_status` / `response_status` MUST-NOT assertions in `v3-envelope-integrity.yaml` can now land using `field_absent` / `envelope_field_absent` without a further SDK release.

  Refs adcp#3429.

- 302bb12: feat(server): `dispatchSeed` emits `SeedSuccess` (3.0.1's seed-specific arm)

  AdCP 3.0.1 added a dedicated `SeedSuccess` arm to `comply-test-controller-response.json` for `seed_*` scenarios:

  ```json
  { "success": true, "message": "Fixture seeded" }
  ```

  The schema's `oneOf` excludes `previous_state`/`current_state` from this branch via `not.anyOf` — seeds are pre-population, not entity transitions. The SDK previously borrowed `StateTransitionSuccess`'s shape (`{ success: true, previous_state: 'none' | 'existing', current_state: 'seeded' | 'existing' }`) which wire-validated as the transition arm under the open `oneOf` but didn't realize the storyboard ergonomics 3.0.1 designed for.

  `createComplyController` / `handleTestControllerRequest` now return `SeedSuccess` from every `seed_*` scenario:
  - Fresh seed → `{ success: true, message: 'Fixture seeded' }`
  - Idempotent replay (same id + equivalent fixture) → `{ success: true, message: 'Fixture re-seeded (equivalent)' }`
  - Divergent fixture → unchanged (`INVALID_PARAMS`)

  Affects all six seed scenarios: `seed_product`, `seed_pricing_option`, `seed_creative`, `seed_plan`, `seed_media_buy`, `seed_creative_format`. `force_*` scenarios continue to return `StateTransitionSuccess`.

  ### Migration
  - Callers narrowing seed responses with `expectControllerSuccess(result, 'transition')` switch to `expectControllerSuccess(result, 'seed')`. The narrowing falls through to the new arm via the existing `'seed'` overload.
  - Adopters consuming raw `comply_test_controller` responses for seed scenarios stop reading `previous_state`/`current_state` on those responses (the spec's `not.anyOf` forbids them on `SeedSuccess`).
  - Idempotent-replay detection: the SDK now exports `SEED_MESSAGES.replay` (`'Fixture re-seeded (equivalent)'`) and `SEED_MESSAGES.fresh` (`'Fixture seeded'`) for adopters that want to match the SDK's own emission. **Note**: `message` is not a portable replay protocol — third-party sellers MAY emit any string the spec allows (only `success: true` is required), so cross-implementation buyers should not rely on `message` strings. For SDK-emitted responses the constants give a non-magic-string contract.

- 3f7dcbb: feat(server): `createPinAndBindFetch` — DNS-rebinding-resistant fetch for outbound webhook delivery

  Adopters who pass `createPinAndBindFetch()` as the `fetch` option to `createWebhookEmitter` (or `createAdcpServer({ webhooks: { fetch } })`) now get pin-and-bind SSRF defense for free: DNS is resolved at request time, every resolved IP is validated against the webhook SSRF policy (RFC 1918, loopback, link-local, CGNAT, IPv6 ULA, IPv4-mapped IPv6, cloud metadata), and the TCP/TLS connection is pinned to the validated address. TLS SNI and the `Host:` header are preserved so HTTPS routing still works.

  This closes the gap where validating only the literal hostname at `push_notification_config.url` registration time leaves the SDK vulnerable to a DNS-rebinding attack that flips the A record between validation and delivery — the literal-host check passes, then the connection routes to `169.254.169.254` (cloud metadata) or `127.0.0.1` (loopback) at fire time.

  The default `fetch` for `createWebhookEmitter` remains `globalThis.fetch` in this release for backwards compatibility — pin-and-bind would block the storyboard runner's loopback http receiver and break in-process storyboard tests without a migration. The default flips to `createPinAndBindFetch()` in v6.

  The webhook emitter also now walks `Error.cause` chains when reporting transport errors in `result.errors[]`, so operators see the actual blocked rule (e.g. `EADCP_SSRF_BLOCKED: hosts_denied_ipv4_cidrs:169.254.0.0/16`) instead of the opaque outer "fetch failed". Pin-and-bind SSRF blocks are treated as terminal — no retries — because the policy violation won't change on the next attempt.

  Public API:
  - `createPinAndBindFetch(options?: PinAndBindFetchOptions): typeof fetch` — re-exported from `@adcp/client/server`.
  - `WEBHOOK_SSRF_POLICY` — the default strict policy (https-only, all common private ranges denied, IP literals allowed subject to CIDR rules).
  - `LOOPBACK_OK_WEBHOOK_SSRF_POLICY` — pre-built relaxation that allows http and IPv4/IPv6 loopback for storyboard / in-process tests; every other deny range is preserved. Safer than swapping in `globalThis.fetch` as a test escape hatch because the rest of the SSRF policy still applies.
  - `PinAndBindFetchOptions` — accepts a `policy` override and a `lookup` override (for tests / custom resolvers).

  See `docs/guides/SIGNING-GUIDE.md` § Webhook SSRF defense for usage and the v6 default-flip migration plan.

- a2124b6: feat(cli): `adcp storyboard run --no-sandbox` forces production routing on every request

  Adds an opt-in `--no-sandbox` flag to `adcp storyboard run` (single-storyboard, multi-instance, full-assessment, and `--local-agent` paths). When set, every request the runner builds carries `account.sandbox: false` explicitly, signaling to the agent: "route to the production code path, not the sandbox stub."

  The default behavior is unchanged — `account.sandbox` stays unset (spec-equivalent to `false`), so existing storyboard runs keep working without modification. The flag is for adopters whose agents have BOTH a real adapter and a sandbox handler and where the sandbox heuristic (env var, brand domain) might otherwise mask non-conformance in the real path. Spec-compliant agents key sandbox routing on the `account.sandbox` field; this flag makes the production intent explicit on the wire so well-behaved agents are forced to exercise their real handler.

  The `comply_test_controller` scenario continues to force `account.sandbox: true` regardless of the flag — that's the spec contract for the test controller and the runner's seeding works against sandbox accounts only.

  The dry-run header and live-run header now show "Run mode: production accounts (--no-sandbox: account.sandbox=false)" when the flag is set, so operators have a visible signal that production routing was requested.

  Skill docs in `skills/build-*-agent/` will be updated in a follow-up to recommend that adopters key their real-vs-sandbox routing on `ctx.account.sandbox` rather than env vars or brand-domain heuristics.

  Filed against #841.

- 36d3c81: fix(grader): make neg/016 replay-window detection deterministic against multi-instance verifiers and add cross-instance diagnostic

  Vector neg/016-replayed-nonce previously sent one (probe1, probe2) pair. Against multi-instance deployments (Fly, AWS ALB, k8s replicas > 1) with per-process `InMemoryReplayStore`, the two probes could land on different instances — each with its own replay state — causing the vector to fail non-deterministically and emit a "got 200, expected 401" diagnostic that pointed at the verifier code rather than the deployment topology.

  The grader now runs K probe pairs (default 10, configurable via `replayProbePairs` / `--replay-probe-pairs`). Each pair uses a fresh nonce on a new TCP connection. On a single-instance or properly-distributed verifier, all K pairs are rejected and the vector passes. When some pairs accept the replayed nonce, the diagnostic surfaces the count and points directly at the multi-instance replay-store topology, with guidance to use `PostgresReplayStore` or a Redis-backed `ReplayStore`.

  New `VectorGradeResult` fields `replay_pairs_tried` and `replay_pairs_rejected` are emitted for neg/016 results.

- c807ca6: feat(testing): version-staleness suffix on shape-drift hints when agent reports old SDK version

  When a storyboard drift hint recommends a server-side helper (e.g. `buildCreativeResponse()`)
  and the agent's `get_adcp_capabilities` response reports a `library_version` below the
  minimum release that shipped that helper, the hint message is now suffixed with an upgrade
  note: "Note: your agent reports @adcp/client@X.Y.Z — helperFn() ships in @adcp/client ≥N.N.N.
  Upgrade your SDK dep."

  The `createAdcpServer` capabilities handler now stamps `library_version: "@adcp/client@X.Y.Z"` in
  the `get_adcp_capabilities` response so agents built on this SDK surface the version automatically.
  Agents that don't emit `library_version` are unaffected — the suffix is silently omitted.

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

- 71df387: fix(grader): add agentContentDigestPolicy option + --covers-content-digest CLI flag to auto-skip neg/007 and neg/018 when verifier advertises covers_content_digest='either'
- 108ad8e: fix(crawler): skip properties with missing or non-array `identifiers` instead of crashing the crawl. PropertyCrawler now drops malformed entries at parse time and surfaces a per-domain warning; PropertyIndex.addProperty is also defensive so any other caller path stays safe.

## 5.21.1

### Patch Changes

- 5ff8aa8: fix(grader): repair undici lookup callback shape in request-signing probe

  `adcp grade request-signing` failed with "Invalid IP address: undefined" against any endpoint behind Cloudflare or an anycast load balancer. On Node 22+ with HTTPS targets, undici calls the `connect.lookup` function with `{ all: true }` and expects the array form of the callback (`cb(null, [{address, family}])`), but the probe was using the single-value form (`cb(null, address, family)`). The fix aligns the callback with the pattern already used in `ssrf-fetch.ts` and preserves DNS-rebinding protection.

## 5.21.0

### Minor Changes

- 602d0a3: Address SigningProvider first-adopter friction (#1022 from #3283 KMS integration)

  Six small additions surfaced by the first KMS-backed SigningProvider deployment. All additive — no breaking changes, no wire-format changes.
  - **`pemToAdcpJwk(pem, { kid, algorithm, adcp_use })`** — new export from `@adcp/client/signing` (via `src/lib/signing/jwks-helpers.ts`). Converts a public-key PEM to an AdCP JWK with the fields that matter for publication at `/.well-known/jwks.json`: `alg` uses the JOSE name (`"EdDSA"` / `"ES256"`), not the AdCP wire identifier — confusing the two is the most common footgun and silently produces `request_signature_key_purpose_invalid` at step 8. `adcp_use` is required by AdCP verifiers at step 8 (hard gate). `key_ops: ["verify"]` because the published JWK is the public half. Throws `TypeError` on private-key PEM input (credential leak guard) and on unsupported algorithm values.
  - **`createGcpKmsSigningProviderLazy`** (example) — synchronous variant of the eager factory. Defers `getPublicKey` to the first `sign()` call. Uses rejection-clearing in-flight promise dedup to prevent thundering herd on concurrent first calls and avoid permanently caching transient init failures.
  - **`expectedPublicKeyPem` tripwire** (example) — optional field on `GcpKmsSigningProviderOptions` (both factories). Compares SPKI bytes at init time; throws explicitly when KMS returns null PEM with the tripwire set (no silent bypass). Catches out-of-band key rotations before they cause widespread verifier `request_signature_key_unknown` failures.
  - **`SigningProvider.fingerprint` JSDoc** — clarifies that the field may embed infra identifiers (e.g., GCP project ID via the version resource name) and recommends `kid` for shared observability pipelines.
  - **Multi-purpose key publication guidance** — example JSDoc now points at the JWKS-shape guidance (two JWK entries with different `kid` values and matching key bytes, tagged `adcp_use: 'request-signing'` / `'webhook-signing'`). Cryptographically safe via RFC 9421's `tag` profile isolation.
  - **`jwks_uri` informational override** — new optional field on `AgentRequestSigningOperationOverrides` (visible on both inline and provider config shapes). Mirrors what brand.json publishes for split-domain setups where the JWKS lives off the conventional `${agent_url}/.well-known/jwks.json` path. Carried for self-describing config + audit logs; the SDK doesn't consume it for signing (verifiers walk brand.json from `agent_url`).

- ecf015e: feat(signing): add `signerProvider` option to `createWebhookEmitter` for KMS-backed webhook signing

  Adopters who moved request signing to a managed key store (GCP KMS, AWS KMS, Azure Key Vault) via the 5.20.0 `SigningProvider` abstraction previously still had to hold a private JWK in process for webhook signing, defeating the KMS threat model.

  `WebhookEmitterOptions` now accepts `signerProvider?: SigningProvider` as a KMS-backed alternative to `signerKey`. Internally, the emitter routes to `signWebhookAsync` when a provider is set and `signWebhook` when a `signerKey` is set. Exactly one must be provided; construction throws `TypeError` if neither or both are given.

  All existing emitter semantics (retries, idempotency-key stability, content-digest, redirect policy) are identical between the two paths — only the signing dispatch differs.

  **Migration note:** `signerKey` changes from required to optional at the TypeScript type level. Existing callers that pass `signerKey` are unaffected. Callers who forward `WebhookEmitterOptions` and rely on `signerKey` being a required field in their own type signatures should update those types.

  **JWKS note:** The JWK published at `jwks_uri` for the key wrapped by a `signerProvider` MUST carry `adcp_use: "webhook-signing"` — receivers validate key purpose against this field.

## 5.20.0

### Minor Changes

- b43b39d: feat(signing): PostgresReplayStore for distributed verifier deployments

  Adds a Postgres-backed `ReplayStore` so multi-instance verifier deployments share replay-protection state. The default `InMemoryReplayStore` is per-process; on a fleet, an attacker who captures a signed request can replay it against a sibling whose cache hasn't seen the nonce — RFC 9421's 5-minute expiry bounds the window but that's plenty of time for an in-flight replay. `PostgresReplayStore` closes that hole using a `(keyid, scope, nonce)` primary key the verifier checks on every signed request.

  New exports from `@adcp/client/signing/server`:
  - `PostgresReplayStore` — `ReplayStore` implementation against the structural `PgQueryable` interface (same pattern as `PostgresTaskStore` and `PostgresStateStore`; the SDK stays free of a hard `pg` dependency).
  - `getReplayStoreMigration(tableName?)` — idempotent DDL for the cache table plus indexes on `expires_at` and `(keyid, scope, expires_at)`.
  - `sweepExpiredReplays(pool, options?)` — exported helper for callers to schedule (cron, app timer, `pg_cron`, etc.); Postgres has no native row-level TTL, so expired rows have to be deleted explicitly.

  The insert path is a single CTE statement that handles replay/cap/insert decision atomically. `ON CONFLICT DO UPDATE WHERE existing-is-expired` recycles expired rows in place — a same-nonce insert after the previous registration's TTL elapsed (but before the sweeper ran) correctly returns `'ok'` rather than falsely reporting `'replayed'`. Concurrent same-nonce inserts (10 parallel) consistently produce exactly one `'ok'` and the rest `'replayed'`, matching `InMemoryReplayStore` semantics.

  Wire format unchanged. No AdCP version bump.

  See [`docs/guides/SIGNING-GUIDE.md` § Verify Inbound Signatures](./guides/SIGNING-GUIDE.md#step-4-verify-inbound-signatures-seller) for the multi-instance failure mode and the wire-up.

  Closes #1015.

- 78fdb54: feat(testing): `adcp grade signer` — validate a signer end-to-end before going live

  Adds a CLI grader and matching library function that exercises a signer (typically KMS-backed) end-to-end: produces a sample signed AdCP request through the operator's signer, then verifies the result against the operator's published JWKS via the SDK's RFC 9421 verifier. Pass means a counterparty verifier will accept your signatures; fail produces a specific `error_code` + step matching the verifier-checklist semantics, so DER-vs-P1363 / kid-mismatch / wrong-key / algorithm-mismatch each surface as a distinct diagnostic instead of the generic `request_signature_invalid` you'd see in the seller's monitoring after pushing live traffic.

  Two signer-source modes:
  - `--key-file <path>` — local JWK file. Easy path for local dev / non-KMS testing.
  - `--signer-url <url>` — HTTP signing oracle for KMS-backed signers. Wire contract is intentionally minimal — `POST {payload_b64, kid, alg}` returns `{signature_b64}` (raw wire-format bytes, not DER) — so any KMS adapter can put a small handler in front of `provider.sign()` for grading without exposing the underlying KMS to the grader.

  Programmatic API: `gradeSigner(options)` exported from `@adcp/client/testing/storyboard/signer-grader`. Returns a `SignerGradeReport` with `passed`, `step.{status,error_code,diagnostic}`, the JWKS URI it resolved against, and the sample request the signer produced headers for (useful for operator-side diagnostics).

  Pairs with the `SigningProvider` abstraction (also in 5.20.0) — that release added the surface for KMS-backed signing; this one closes the loop by giving operators a way to validate their adapter before going live.

  Closes #610.

- c4afc75: feat(signing): add SigningProvider abstraction for KMS-backed RFC 9421 signing

  Adds a pluggable `SigningProvider` interface so private keys can live in a
  managed key store (GCP KMS, AWS KMS, Azure Key Vault, HashiCorp Vault Transit)
  instead of process memory. The async `sign(payload)` boundary matches RFC
  9421 §3.1 — the SDK produces the canonical signature base, the provider
  returns wire-format signature bytes.

  New surface:
  - `SigningProvider` interface and `AdcpSignAlg` type (exported from
    `@adcp/client/signing`).
  - `signRequestAsync` / `signWebhookAsync` — async variants that accept a
    provider; sync `signRequest` / `signWebhook` are unchanged.
  - `createSigningFetchAsync(upstream, provider, options)` — async-signing
    fetch wrapper, paired with the existing sync `createSigningFetch`. Two
    symbols rather than one overload so the latency-cost distinction is
    visible at integration time.
  - `derEcdsaToP1363(der, componentLen)` — DER → IEEE P1363 ECDSA signature
    converter for KMS adapters whose `sign` API returns DER (GCP, AWS, Azure).
  - `SigningProviderAlgorithmMismatchError` — typed error adapters throw when
    the declared algorithm doesn't match the underlying key, so misconfigurations
    fail fast at adapter construction rather than producing signatures verifiers
    reject downstream.
  - `@adcp/client/signing/testing` sub-path exporting `InMemorySigningProvider`
    and `signerKeyToProvider`. Constructor refuses to instantiate when
    `NODE_ENV=production` unless `ADCP_ALLOW_IN_MEMORY_SIGNER=1` is set.

  `AgentRequestSigningConfig` is now a discriminated union on `kind`:
  - `kind: 'inline'` (default — `kind` is optional on this shape so existing
    literals work unchanged) holds a private JWK in process.
  - `kind: 'provider'` delegates `sign()` to a `SigningProvider`.

  `buildAgentSigningContext` defensively hashes the provider-supplied
  `fingerprint` together with `algorithm` and `kid` before composing
  transport- and capability-cache keys, preserving the multi-tenant isolation
  property the in-memory path has always provided. The signing identity is
  snapshotted at context-build time so a provider object whose fields drift
  between build and outbound request cannot desynchronize the on-wire `keyid`
  from the cache key the connection was bound to.

  **Behavior change for non-UTF-8 byte bodies:** `createSigningFetch` and
  `createSigningFetchAsync` now throw `TypeError` on `Uint8Array` /
  `ArrayBuffer` request bodies that aren't valid UTF-8. Previously, invalid
  bytes were silently replaced with U+FFFD by `Buffer.toString('utf8')` —
  verification still passed because the wire and the digest agreed on the
  lossy string, but the seller received mangled content. Callers hitting
  this should pass a string body, ensure their bytes are UTF-8, or sign
  manually with `signRequest` / `signRequestAsync` against the exact wire
  bytes they intend to send. Error message names the escape hatch.

  Wire format unchanged. No AdCP version bump.

  A reference GCP KMS adapter ships at `examples/gcp-kms-signing-provider.ts`,
  type-checked under `npm run typecheck:examples`. AWS KMS and Azure Key Vault
  adapters can mirror the same pattern; users `npm i` the cloud SDK they need.

  See adcontextprotocol/adcp-client#1009.

### Patch Changes

- a8e50ac: fix(hints): drop AJV-prose fallback in `groupRequiredIssues`

  `MissingRequiredFieldHint.missing_fields` is documented as "Field name(s) the parent object was required to carry." When the field-name extraction regex did not match an AJV `required` error message (e.g. a reworded or locale-variant message), the fallback `?? issue.message` wrote the entire AJV prose string into `missing_fields[]` as if it were a field name. Downstream renderers (CLI, Addie, JUnit) wrap entries in backticks and generate "add the X field" coaching, so they would produce nonsense output for these entries.

  The fallback is now removed. When the regex does not match, the issue is skipped — `missing_fields` contains only clean field identifiers. Unextractable issues remain visible via `ValidationResult.warning`.

- 976c6e0: docs(testing): add @provenance annotations to StoryboardStepHint fields

  Each field on the five hint kinds (ContextValueRejectedHint, ShapeDriftHint,
  MissingRequiredFieldHint, FormatMismatchHint, MonotonicViolationHint) now
  carries a @provenance seller|storyboard|runner tag so downstream renderers
  (Addie, CLI, JUnit) can identify which fields contain seller-controlled bytes
  that must be sanitized before reaching prompt-injection-vulnerable surfaces.

  Also annotates StoryboardStepHintBase.message with an explicit warning that
  the pre-formatted string embeds seller bytes for context_value_rejected and
  monotonic_violation kinds; and adds @provenance to typedoc.json blockTags so
  the TypeDoc build recognises the new tag.

  Motivated by adcp#3084 and adcp#3220, where undocumented seller provenance on
  request_field and from_status produced prompt-injection vectors in downstream
  renderers.

## 5.19.0

### Minor Changes

- af944a1: feat(AgentClient): add `AgentClient.fromMCPClient()` factory for in-process MCP transport

  Adds a new static factory method that accepts a pre-connected `@modelcontextprotocol/sdk` `Client` instance instead of a URL-based agent config. This enables compliance test fleets to wire up a full `AgentClient` against an `InMemoryTransport` pair without an HTTP loopback server.

  **MCP only.** This factory wraps an MCP `Client` from `@modelcontextprotocol/sdk`. There is no equivalent in-process bridge for A2A today — for A2A agents, run them on a loopback HTTP server and use the standard `AgentClient` constructor with the agent's `agent_uri`.

  Key behaviors preserved over the in-process path:
  - `adcp_major_version` is injected on every tool call
  - `idempotency_key` is auto-generated for mutating tasks
  - `isError` envelopes surface as `TaskResult<{ success: false }>`
  - HTTP-only methods (`resolveCanonicalUrl`, `getWebhookUrl`, `registerWebhook`, `unregisterWebhook`) throw descriptive `in-process` guard errors
  - Endpoint discovery and SSRF validation are bypassed for the sentinel URI

  Exports the new `InProcessAgentClientConfig` type for typed factory usage.

- efbe785: Add `pgBackend.probe()` and `serve({ readinessCheck })` for fail-fast pool validation

  Sellers wiring `createIdempotencyStore({ backend: pgBackend(pool) })` from a `DATABASE_URL` env var previously got a silent failure mode: a bad URL (typo, deprovisioned DB, missing creds) lets the server boot successfully, advertise `IdempotencySupported`, then fail every mutating call indefinitely.

  This release adds:
  - **`pgBackend.probe()`** — runs `SELECT 1 FROM "<table>" LIMIT 0` at startup, validating both connectivity and that the idempotency table has been migrated. Throws a descriptive error naming the table, root cause, and remediation steps.
  - **`IdempotencyStore.probe()`** — delegates to `backend.probe()` when the backend implements it; no-ops for `memoryBackend`.
  - **`probeIdempotencyStore(store)`** — convenience export for callers that manage their own lifecycle (Lambda, custom HTTP frameworks).
  - **`ServeOptions.readinessCheck?: () => Promise<void>`** — called before `httpServer.listen()`. The server never accepts connections if the check throws, so a misconfigured pool crashes the process at deploy time rather than silently failing live traffic.

  Wire the probe in `serve()`:

  ```ts
  const store = createIdempotencyStore({ backend: pgBackend(pool), ttlSeconds: 86400 });
  pool.on('error', err => console.error('pg pool error', err)); // prevent crash on idle-client errors
  serve(createAgent, {
    readinessCheck: () => store.probe(),
  });
  ```

  `readinessCheck` is general-purpose — use it for any startup dependency check, not just idempotency.

  **Non-breaking.** `createIdempotencyStore` remains synchronous. Existing callers require no changes. Option A (async constructor) is tracked separately as a future major-version enhancement.

- a26db16: Storyboard runner: add `$generate:opaque_id` substitution and `context_outputs[generate]` for threading runner-minted task IDs through multi-step lifecycle storyboards.

  `$generate:opaque_id` and `$generate:opaque_id#<alias>` work identically to `$generate:uuid_v4` / `$generate:uuid_v4#<alias>` but carry explicit task-ID semantics. Both share the same alias cache namespace.

  `context_outputs` entries now accept `generate: "opaque_id" | "uuid_v4"` as an alternative to `path:`. When `generate` is set the runner mints (or reuses, via alias-cache coherence) a UUID at post-step time and writes it into `$context.<key>` for subsequent steps. If an inline `$generate:opaque_id#<key>` substitution already ran in the same step's `sample_request`, the generator reuses that value — the two forms are alias-coherent.

  `ContextProvenanceEntry.source_kind` and `ContextValueRejectedHint.source_kind` gain a `'generator'` variant for accurate diagnostic attribution. `ContextOutput.path` is now optional (mutually exclusive with the new `generate` field).

### Patch Changes

- c58ff99: **Fix `get_media_buys` convention extractor poisoning context during multi-page pagination walks (#998).** The extractor unconditionally captured `media_buys[0].media_buy_id` from every successful `get_media_buys` response. When a storyboard walks multi-page results, the page-1 response carries `pagination.has_more: true` — buys[0] is not the canonical buy, it is just the first item in a list slice. The captured ID was then picked up by the request-builder enricher on step 2 and injected as `media_buy_ids: [that_id]`, turning the pagination continuation into a single-ID lookup. The agent returned one buy with `has_more: false, total_count: 1`, failing `total_count: 3` storyboard assertions.

  The extractor now skips extraction when `pagination.has_more === true`, matching the conservative `=== true` convention used elsewhere in the codebase (`hasMorePages()` in `validations.ts`). When `has_more` is absent or `false` — i.e., a terminal or single-page response — extraction proceeds as before. This unblocks `get-media-buys-pagination-integrity` in `adcontextprotocol/adcp#3122` from upgrading to the seeded multi-page walk model used by `list_creatives` and other paginated storyboards.

## 5.18.0

### Minor Changes

- af01482: Storyboard runner: add the `a2a_context_continuity` validation check
  plus cross-step A2A envelope tracking. Closes #962.

  A2A 0.3.0 §7.1 binds follow-up `message/send` calls to a server-side
  conversation via `Message.contextId`; the server MUST echo it on the
  response Task. The `@a2a-js/sdk`'s `DefaultRequestHandler` does this
  automatically — `createA2AAdapter` (#899) passes through
  `requestContext.contextId`, so a passing seller built on the SDK
  won't trip a single-call check. The regression class is sellers that
  bypass the SDK's request handler and stamp their own `contextId` on
  the response, breaking buyer-side correlation across multi-turn flows
  (proposal refinement, IO signing, async approval). This kind of bug
  is only surface-able on **multi-step** storyboards where step N+1
  sends with the contextId returned by step N.

  The new check runs at step N+1 and compares
  `a2aEnvelope.result.contextId` against the most recent prior step's
  captured envelope. Skip semantics:
  - Non-A2A run (no envelope captured) → skip with `not_applicable`
    observation
  - First A2A step in a run (no prior to compare) → skip
  - Either envelope has no extractable `contextId` → skip
  - JSON-RPC error envelope (transport rejection) → skip — continuity
    is undefined when the call didn't reach the work layer
  - Skip cases tag the observation so triage can distinguish
    "validator self-skipped" from "validator passed because contexts
    matched"

  Failure cases:
  - Current step's response has no `contextId` (empty/missing) on a
    non-first send → fail with a pointer to `/result/contextId`
  - Current step's response `contextId` differs from prior step's →
    fail with both values surfaced and the prior step id named in
    the diagnostic

  **Runner-side plumbing**: per-step A2A envelopes are now tracked in
  a long-lived `priorA2aEnvelopes` map on `ExecutionState`, populated
  after each capture. The validator reads the most recent insertion-
  order entry as the comparison baseline. Probe steps, MCP steps, and
  capture-bypass paths don't insert, so cross-step comparisons walk
  back to the most recent A2A step automatically.

  Suggested by the ad-tech-protocol-expert review on #952. Filed as
  #962, scoped as a separate validator since the failure mode and
  fix surface are distinct from `a2a_submitted_artifact`'s single-call
  wire-shape check.

  **Coverage**:
  - 10 unit tests against `validateA2AContextContinuity` (synthetic
    envelopes covering match, divergence, missing contextId, every
    skip path)
  - 2 integration tests against `runStoryboard` driving multi-step
    storyboards: one against a conformant `createA2AAdapter` (passes),
    one against a hand-rolled regressed adapter that stamps a fresh
    contextId per send (fails)

- 6124deb: Storyboard runner: capture A2A wire shape on `protocol: 'a2a'` runs and
  add the `a2a_submitted_artifact` validation check. Closes the regression
  class from adcp-client#904 — pre-#899 A2A adapters that emitted
  `Task.state: 'submitted'` with `final: true` and `adcp_task_id` inside
  `artifact.parts[0].data` instead of `artifact.metadata` would otherwise
  pass the storyboard suite despite being non-conformant per A2A 0.3.0.

  The check asserts the wire-shape invariants for AdCP `submitted` arms
  over A2A:
  1. `Task.state === 'completed'` — A2A Task.state tracks the HTTP
     transport call; `'submitted'` is the INITIAL state per A2A 0.3.0
     and forbidden as a terminal value.
  2. `Task.id` and `Task.contextId` non-empty — required by A2A 0.3.0
     for `tasks/get` addressability and follow-up correlation.
  3. `artifact.artifactId` non-empty — required for chunked-artifact
     resumption and buyer-side caching.
  4. `artifact.metadata.adcp_task_id` carries the AdCP-level handle
     (per A2A 0.3.0 metadata-extension convention).
  5. `artifact.parts[0]` is a DataPart with `data.status === 'submitted'`
     — the AdCP payload preserves its native discriminator.
  6. If `data.adcp_task_id` is also present (forward-compatibility for
     a future AdCP tool whose response schema legitimately includes
     it), it MUST equal `metadata.adcp_task_id` — divergent or
     solo-payload writes are the regression class.

  JSON-RPC error envelopes fail the check with a distinct
  `error_code: 'a2a_jsonrpc_error_envelope'` so dashboards can separate
  transport rejections from submitted-arm shape drift.

  The check self-skips with a `not_applicable` observation on non-A2A
  runs (MCP, raw-probe dispatch path) so storyboards can include it
  alongside MCP-shape assertions without forcing the runner to know
  which transport ran.

  Wires `withRawResponseCapture` around the SDK-driven A2A dispatch in
  the runner so the JSON-RPC envelope is observable for validation;
  captured response bodies pass through `redactSecrets` before landing
  in `ValidationContext.a2aEnvelope` so AdCP-style secret-shaped fields
  in DataPart payloads (`api_key`, `client_secret`, etc.) don't reach
  persisted compliance reports. `withRawResponseCapture` now surfaces
  partial captures on rejection (attached as `error.captures`) so
  storyboard validators get a wire-shape envelope even when the SDK
  threw mid-parse. Adds `A2ATaskEnvelope` to the public testing types
  and exports `getCapturesFromError` from the protocols module.

  The companion compliance scenario (adcontextprotocol/adcp#3083 — the
  `create_media_buy_async_submitted` storyboard) drives this check.
  Closes the runner-side half of adcp-client#904.

- c085911: Brand `AdcpServer` as nominal + lint `as any` in skill examples.

  Two complementary defenses against the API-drift class that landed PR #945 (the creative skill teaching `server.registerTool`):
  - **`AdcpServer` is now a branded (nominal) type.** A phantom symbol-keyed property (`[ADCP_SERVER_BRAND]?: never`) makes `(plainObject as AdcpServer)` casts from structurally-similar objects fail at compile time. A real `AdcpServer` is only obtainable by calling `createAdcpServer()`. Closes the door on `(somePlainObject as AdcpServer).registerTool(...)` patterns that tried to reach for an MCP-SDK method the framework intentionally doesn't expose. Type-only change — no runtime behavior, no breaking change for any caller passing a value produced by `createAdcpServer()`.
  - **`scripts/typecheck-skill-examples.ts` now flags `as any` in extracted skill blocks.** The pattern hides the API drift that strict types would otherwise catch — every legitimate cast has a typed alternative (typed factories like `htmlAsset()`, named discriminated unions like `AssetInstance`, response builders like `buildCreativeResponse()`). New `as any` in a skill block fails the harness; existing uses in `skills/build-seller-agent/deployment.md` (Express middleware boundary code, 2 occurrences) are baselined as known. Authors who genuinely need the escape hatch can use `// @ts-expect-error` against a specific known issue instead — greppable and self-documenting.

  Type-level test in `src/lib/server/adcp-server.type-checks.ts` locks the brand against regression — if a future change accidentally removes the brand, `tsc --noEmit` fails because the negative assertions stop firing.

  This is dx-expert priority #4 from the matrix-v18 review (CI defenses #1–#3 shipped in #945, #957, #961).

- 1158429: **Add `${Parent}_${Property}Values` const arrays for inline anonymous string-literal unions** (closes #932).

  Companion to the named-enum exports landed in 5.17 (PR #931). The earlier shipment covered every spec enum that has a stable named type (`MediaChannelValues`, `PacingValues`, etc., 122 total). This release adds the inline anonymous unions that don't have stable named types in the generated TypeScript — exactly the cases where consumers were re-declaring spec literal sets in their own validation code:

  ```ts
  // Before — drift bait, hand-maintained on the consumer side.
  const VALID_IMAGE_FORMATS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'avif', 'tiff', 'pdf', 'eps']);
  const VALID_VIDEO_CONTAINERS = new Set(['mp4', 'webm', 'mov', 'avi', 'mkv']);

  // After — authoritative, drift-detected.
  import { ImageAssetRequirements_FormatsValues, VideoAssetRequirements_ContainersValues } from '@adcp/client/types';
  ```

  **Naming convention.** Every `z.union([z.literal(...), ...])` (or its `z.array(...)`-wrapped variant) inside a named object schema gets a corresponding export named `${ParentSchema}_${PropertyName}Values`, where the property name is PascalCased. Property paths that reference a named enum (e.g. `unit: DimensionUnitSchema.optional()`) are intentionally skipped — use the matching `${TypeName}Values` from `enums.generated.ts`.

  **Coverage.** 104 inline-union arrays exported across 51 parent schemas. User-flagged cases all included: `ImageAssetRequirements_FormatsValues`, `VideoAssetRequirements_FormatsValues` / `_ContainersValues` / `_CodecsValues`, `AudioAssetRequirements_FormatsValues` / `_ChannelsValues`, plus video frame-rate/scan-type/GOP-type discriminators, audio channel layouts, account scopes, payment terms, and many more.

  **Implementation.** New script `scripts/generate-inline-enum-arrays.ts` walks the compiled Zod schemas via runtime introspection (Zod 4 `_def`) rather than regex on the generated TS — cleaner and future-proofs against codegen output format changes. Output goes to `src/lib/types/inline-enums.generated.ts`. Wired into the existing `generate-zod-schemas` script (runs after Zod codegen, since it depends on Zod schemas being current). The new test `test/lib/inline-enum-arrays.test.js` cross-validates every emitted array against the parent Zod schema property — if either side drifts, the test fails fast.

  **Behavior unchanged for existing consumers.** Pure addition; no public-API rename, no breaking change to `enums.generated.ts`. Adapters can drop their hand-maintained `VALID_IMAGE_FORMATS`-style constants in a follow-up.

- df80e85: feat(testing,server): shape-drift hint + response helper for `get_plan_audit_logs`

  The storyboard runner's `LIST_WRAPPER_TOOLS` table now covers `get_plan_audit_logs`, so a handler that returns a bare `[{plan_id, …}]` array instead of `{ plans: [...] }` gets the targeted hint (`Use getPlanAuditLogsResponse() from @adcp/client/server`) alongside the AJV error.

  `getPlanAuditLogsResponse(data, summary?)` is now exported from `@adcp/client/server` and `@adcp/client`, mirroring the existing list-tool helpers (`listPropertyListsResponse`, `listContentStandardsResponse`, …).

  Note: the wrapper key is `plans`, not `logs` as issue #856's body claimed. Verified against `schemas/cache/3.0.0/governance/get-plan-audit-logs-response.json` and `tools.generated.ts:11542` — audit entries are bundled under each `plans[].entries[]` record. Closes #856.

- 24e9569: feat(server): PostgresTaskStore.createTask accepts optional caller-supplied taskId

  Compliance storyboard controller scenarios (`force_create_media_buy_arm`,
  `force_task_completion`) need to inject buyer-supplied task IDs for storyboard
  determinism. `PostgresTaskStore.createTask` now accepts an optional `taskId`
  field on its first argument: when supplied, the ID is used verbatim; when
  omitted, a random hex ID is generated as before. Throws if the supplied ID is
  empty, longer than 128 characters, or already exists (the collision is detected
  via PG uniqueness constraint, not a pre-check race).

  **Caveats and follow-ups:**
  - `InMemoryTaskStore` (re-exported from the upstream MCP SDK) does NOT honor
    caller-supplied `taskId` — sellers running without `DATABASE_URL` (e.g., test
    paths) get random IDs even when one is supplied. Filing an upstream MCP SDK
    issue to add `taskId?: string` to `CreateTaskOptions` so both stores can honor
    it cleanly is the right durable fix; this PR is the Postgres-only shim until
    upstream lands.
  - The `task_id` namespace on `PostgresTaskStore` is process-global today (no
    tenant scoping in the schema). Callers using caller-supplied IDs are
    responsible for namespace isolation. A future migration to a composite
    `(tenant_id, task_id)` key would close this for production use.
  - The storyboard runner does not yet send caller-supplied IDs through to the
    controller tool's input schema. That wiring (runner → tool input → task
    store) is a separate change tracked in the parent issue.

- efb2fa6: feat(conformance): add `requires_capability` storyboard-level skip gate

  Storyboard runner now evaluates a `requires_capability: { path, equals }` predicate before running any phase. When the predicate is false (agent declared the capability unsupported), the runner emits a single `{ skipped: true, skip_reason: 'capability_unsupported' }` storyboard result instead of a cascade of misleading per-phase failures. This fixes the idempotency universal storyboard running against agents that declare `adcp.idempotency.supported: false` (added in PR #931). The same mechanism applies to any future capability-gated storyboard.

- a085f4a: Cross-domain specialism-declaration runtime check on `createAdcpServer`.

  When a domain handler group (`creative`, `signals`, `brandRights`) is wired but `capabilities.specialisms` doesn't include any of that domain's specialisms, `createAdcpServer` now logs an error via the configured logger:

  ```
  createAdcpServer: creative handlers are wired but capabilities.specialisms
  does not include any creative specialism. Add at least one of
  'creative-ad-server', 'creative-generative', 'creative-template' to
  capabilities.specialisms — without it, the conformance runner reports
  "No applicable tracks found" and the agent grades as failing despite
  working tools.
  ```

  The matrix v18 run (issue #785) had this drift class account for ~30% of "agent built every tool but storyboard reports no applicable tracks" cases. The conformance runner gates tracks on the `capabilities.specialisms` claim, so an agent with working tools but no claim grades as failing silently.

  Logged via `logger.error` (matching the idempotency-disabled precedent) rather than thrown — middleware-only test harnesses legitimately wire handlers without declaring specialisms, and a hard throw would create more friction than it removes. Production agents will see the warning in boot logs and conformance failure in the matrix.

  `mediaBuy` is intentionally exempt from the check. Its specialism choices (sales-non-guaranteed vs sales-guaranteed vs sales-broadcast-tv vs sales-social etc.) are commercially significant and an agent may legitimately defer the declaration to a follow-up. The `build-seller-agent` skill cross-cutting pitfalls section already covers the right declaration.

  Tests in `test/server-create-adcp-server.test.js` lock the new behavior:
  - Throws-equivalent: error logged when handlers wired without specialism
  - No-error: handlers + matching specialism aligned
  - No-error: no domain handlers wired
  - No-error: mediaBuy without specialism (commercial-significance carve-out)

  This is dx-expert priority #5 from the matrix-v18 review (CI defenses #1–#4 shipped in #945, #957, #961, #970). With this, the cheap-CI-defense ladder is complete.

- df9d7bd: **Extend `StoryboardStepHint` taxonomy: `shape_drift`, `missing_required_field`, `format_mismatch`, `monotonic_violation`** (closes #935; supersedes #937).

  Issue #935 proposed making `StoryboardStepHint` the canonical surface for **every** runner-side diagnostic that has structured fields a renderer can consume. PR #937 shipped the first member (`shape_drift`) but left the broader vision unfinished — the structured fields were added in parallel to the existing `ValidationResult.warning` prose, and no consumer rendered the structured fields. This release closes the loop:

  **1. Base type + four new hint kinds.** New `StoryboardStepHintBase` constrains every hint to `{ kind, message }`; the union now includes `ShapeDriftHint` (PR #937), `MissingRequiredFieldHint`, `FormatMismatchHint`, and `MonotonicViolationHint`. Each kind carries machine-readable fields so renderers don't regex-parse the prose:

  | `kind`                   | When it fires                                                                                                    | Structured fields                                                                                             |
  | ------------------------ | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
  | `shape_drift`            | Bare-array list responses, platform-native `build_creative`, wrong-wrapper `sync_creatives` / `preview_creative` | `tool`, `observed_variant`, `expected_variant`, `instance_path`                                               |
  | `missing_required_field` | Strict AJV reports `keyword: "required"` issues (lenient Zod accepted)                                           | `tool`, `instance_path`, `schema_path`, `missing_fields[]`, `schema_url?`                                     |
  | `format_mismatch`        | Strict AJV rejected a `format` / `pattern` / other non-required keyword that lenient Zod accepted                | `tool`, `instance_path`, `schema_path`, `keyword`, `schema_url?`                                              |
  | `monotonic_violation`    | `status.monotonic` invariant catches an off-graph transition                                                     | `resource_type`, `resource_id`, `from_status`, `to_status`, `from_step_id`, `legal_next_states[]`, `enum_url` |

  **2. De-duplication.** Shape-drift detection moved to `shape-drift-hints.ts` as the canonical surface; the legacy `detectShapeDriftHint` (string) in `validations.ts` now delegates to it so the two surfaces can't drift apart, and the redundant shape-drift prose was removed from `ValidationResult.warning` (it lives only on `step.hints[]` going forward). Strict-AJV `warning` prose is **kept for one minor** for back-compat with consumers that scrape it; new code should consume `step.hints[]`.

  **3. Assertion → hint plumbing.** `AssertionResult` gained an optional `hint?: StoryboardStepHint` that the runner mirrors into the owning step's `hints[]` for `scope: "step"` results. `status.monotonic` is the first user — it now emits a `MonotonicViolationHint` alongside the existing prose `error`. The hint surfaces under the same taxonomy regardless of which subsystem (validation, assertion, runner-internal detector) produced it.

  **4. CLI renders structured fields.** `bin/adcp-step-hints.js` branches on `hint.kind` and prints per-kind detail lines under each prose hint:

  ```
     💡 Hint: media_buy mb-1: active → pending_creatives (step "create" → step "regress")...
              media_buy mb-1: active → pending_creatives
              from step: create
              legal next states: canceled, completed, paused
  ```

  Renderers that don't recognize a `kind` literal still display the prose `message` verbatim (forward-compat per `StoryboardStepHintBase`).

  **Wire-format compatibility.** Adding union members is non-breaking — the JSDoc on `StoryboardStepHint` already said "more kinds may be added over time," and existing consumers that only render `message` keep working. The `ValidationResult.warning` prose for shape-drift is removed (its content lives on `step.hints[*].message` instead), so consumers that scraped specifically `warning` for shape-drift recipes need to switch surfaces.

  **Spec alignment.** None required — `StoryboardStepHint` is a runner-internal diagnostic surface defined by the runner-output contract. The structured fields mirror existing taxonomies the spec already uses (`SchemaValidationError.instance_path` / RFC 6901, `enums/*-status.json` URLs).

- d059760: Strict discriminator types for creative assets, vendor pricing, and sync rows.

  The codegen produces strict per-variant interfaces (`ImageAsset`, `CpmPricing`, etc.) but doesn't emit canonical discriminated unions over them. This release adds three hand-authored unions on top of the generated bases so handler authors can opt into compile-time discriminator checking instead of runtime schema validation:
  - **`AssetInstance`** — discriminated union of every creative asset instance (`ImageAsset | VideoAsset | AudioAsset | TextAsset | HTMLAsset | URLAsset | CSSAsset | JavaScriptAsset | MarkdownAsset | VASTAsset | DAASTAsset | BriefAsset | CatalogAsset | WebhookAsset`), keyed on `asset_type`. Use as the value type for `creative_manifest.assets[<key>]`. Omitting `asset_type` or returning a plain `{ url, width, height }` against this type fails to compile.
  - **`AssetInstanceType`** — the `asset_type` discriminator value union (`'image' | 'video' | …`). Useful for exhaustive switch-case helpers.
  - **`SyncAccountsResponseRow`** — extracted named type for one row in `SyncAccountsSuccess.accounts[]`. Forces the `action` literal-union discriminator (`'created' | 'updated' | 'unchanged' | 'failed'`) and the `status` enum on every row at compile time.
  - **`SyncGovernanceResponseRow`** — same pattern for `SyncGovernanceSuccess.accounts[]`. Forces the `status: 'synced' | 'failed'` discriminator.
  - **Vendor-pricing exports completed** — `PerUnitPricing`, `CustomPricing`, `VendorPricing`, `VendorPricingOption` are now re-exported from `@adcp/client` (previously only `CpmPricing`, `PercentOfMediaPricing`, `FlatFeePricing` were).
  - **Product-pricing exports completed** — `CPMPricingOption`, `VCPMPricingOption`, `CPCPricingOption`, `CPCVPricingOption`, `CPVPricingOption`, `CPPPricingOption`, `FlatRatePricingOption`, `TimeBasedPricingOption` re-exported (the union type `PricingOption` and `CPAPricingOption` were already exported).

  Type tests in `src/lib/types/asset-instances.type-checks.ts` use `// @ts-expect-error` to lock in the constraints — if a future codegen regression loosens any discriminator (e.g., makes `asset_type` optional), `tsc --noEmit` fails on a now-unexpected error. The file uses the `.type-checks.ts` suffix (not `.test.ts`) so it participates in the project's normal `npm run typecheck` pass; explicitly excluded from `tsconfig.lib.json` so it doesn't ship in `dist/`.

  Drift class this catches at compile time:

  ```ts
  // Before: this slipped past TS, was caught only by runtime validator.
  const asset: Record<string, unknown> = { url: '...', width: 1920, height: 1080 };
  return { creative_manifest: { format_id, assets: { hero: asset } } };

  // After: typed as AssetInstance, missing asset_type is a compile error.
  const asset: AssetInstance = { url: '...', width: 1920, height: 1080 };
  //                            ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  // error TS2353: Object literal may only specify known properties, and
  // 'url' does not exist in type 'AssetInstance'. Property 'asset_type'
  // is missing.
  ```

  This is dx-expert priority #3 from the matrix-v18 review (CI defenses #1 and #2 shipped in #945 and #957).

- fcc9b5b: feat(sync): pull canonical agent skills from the protocol tarball

  `scripts/sync-schemas.ts` now extracts protocol-managed skills (`call-adcp-agent`, `adcp-media-buy`, `adcp-creative`, `adcp-signals`, `adcp-governance`, `adcp-si`, `adcp-brand`) from the published `/protocol/<version>.tgz` bundle alongside schemas and compliance, into `@adcp/client/skills/<name>/`. The sync is **manifest-driven and per-name** — only directories enumerated in `manifest.contents.skills` are overwritten, so SDK-local skills (`build-seller-agent`, `build-creative-agent`, etc.) stay untouched.

  The buyer-side `call-adcp-agent` skill is now sourced from the spec repo (adcontextprotocol/adcp#3097) rather than maintained as a local copy — version-pinned to `ADCP_VERSION`, Sigstore-verified via the same cosign path as schemas, no manual sync.

  Adds an `ADCP_BASE_URL` env override (defaults to `https://adcontextprotocol.org`) so CI / local-dev can point sync at a fake CDN for testing.

### Patch Changes

- 62beb82: **Fix storyboard runner injecting `brand`/`account` into tools whose request schemas declare `additionalProperties: false` (#940).** The storyboard runner's `applyBrandInvariant` helper unconditionally injected `brand` (and a synthetic `account` when none was present) into every outgoing request. Tools like `sync_plans`, `list_property_lists`, and `delete_property_list` have strict request schemas that do not include these fields. Before v5.17.0 this was silently tolerated (request validation defaulted to `'warn'`); PR #909 flipped the default to `'strict'`, causing 11 storyboards to regress with `VALIDATION_ERROR: must NOT have additional properties`.

  `applyBrandInvariant` now accepts an optional `taskName` and consults the raw request schema JSON to decide which fields are safe to inject. It skips top-level `brand` injection when the schema declares `additionalProperties: false` and does not list `brand` in `properties`; similarly for the synthetic `account` construction. Tools that do declare these fields (e.g. `get_products`, `create_media_buy`) are unaffected. Fails open when schemas are unavailable (not synced) or `taskName` is omitted, preserving backwards compatibility.

  A new exported helper `schemaAllowsTopLevelField(toolName, field)` is added to `schema-loader.ts` for this purpose; it reads raw JSON without touching AJV internals.

  The runner now also leaves storyboard-authored `account: { account_id }` payloads untouched. `AccountReference` is `oneOf` of `{account_id}` (closed via `additionalProperties:false`) or `{brand, operator, sandbox?}`. The previous code merged `brand` into any plain-object `account`, producing `{account_id, brand}` payloads that match neither `oneOf` branch under strict AJV — an issue latent for tools like `list_creatives` whose schemas use AccountReference. Brand is now merged only when the existing `account` carries `brand` or `operator` (the natural-key variant).

- 153945b: Fix `ProtocolResponseParser.getStatus` and `getTaskId` to read AdCP
  work-layer fields from A2A wrapped Task responses instead of the
  transport-layer fields. Closes #973.

  Per #899's two-lifecycle contract, A2A `Task.state` reflects the
  HTTP-call lifecycle (always `'completed'` for AdCP submitted arms —
  the call returned with a queued AdCP task), and `Task.id` is the
  SDK-generated transport handle (pinned to one HTTP call). The AdCP
  work lifecycle and work handle live on the artifact:
  `artifact.parts[0].data.status` and `artifact.metadata.adcp_task_id`
  respectively.

  **Pre-fix behavior**:
  - `getStatus` for an A2A submitted-arm response returned
    `'completed'` (read from `result.status.state`), preventing
    `TaskExecutor.handleAsyncResponse` from ever entering the
    SUBMITTED branch. Buyers thought async operations finished
    synchronously — `result.submitted` was undefined; no
    `SubmittedContinuation` was issued.
  - `getTaskId` returned the A2A Task.id, which the seller's AdCP
    `tasks/get` tool would not recognize (the seller knows the AdCP
    task handle, not the transport id).

  **Fix**: when `result.kind === 'task'` AND the artifact's first
  DataPart carries an AdCP payload, prefer the AdCP-layer fields:
  - `getStatus`: read `artifact.parts[0].data.status` if it's an
    `ADCP_STATUS` enum value; fall back to `result.status.state`.
  - `getTaskId`: read `artifact.metadata.adcp_task_id` if present and
    passes the session-id safety guard; fall back to `result.id`.

  Non-AdCP A2A responses (no artifact, no DataPart, or `data.status`
  not in the AdCP enum) keep the previous behavior — the transport-
  layer fields are authoritative.

  **End-to-end consequence**: combined with #966 (server-task-id
  plumbing) and #967 (AdCP `tasks/get` request/response shape), A2A
  submitted-arm polling now works end-to-end against any
  `createA2AAdapter`-backed seller. Probe before this PR:

  ```
  result.status = completed   ← WRONG, treated as sync completion
  result.submitted = undefined
  result.metadata.serverTaskId = <random A2A UUID>
  ```

  After:

  ```
  result.status = submitted
  result.submitted.taskId = tk_seller_handle_99   ← AdCP work handle
  ```

  **Tests**:
  - `test/lib/protocol-response-parser-a2a-submitted.test.js` — 15
    unit tests covering AdCP-layer reads (submitted/working/failed),
    fallback paths (no artifact, no DataPart, malformed status, no
    metadata), interaction with MCP `structuredContent` (untouched),
    and session-id safety guards.
  - `test/server-a2a-submitted-end-to-end.test.js` — full submitted →
    working → working → completed roundtrip against a real
    `createA2AAdapter`. Asserts (1) SDK classifies as submitted,
    (2) `SubmittedContinuation.taskId` is the AdCP handle, (3)
    polling dispatches `tasks/get` with snake_case `task_id`, (4)
    the spec-shape `tasks/get` response resolves
    `waitForCompletion()` with `result.media_buy_id`.

  This is the third and final landmark of the A2A submitted-arm
  polling story (#966 → #967 → #973). With it, A2A buyers can drive
  guaranteed-buy / IO-signing / governance-review / batch-processing
  flows end-to-end through the SDK without webhook-only fallbacks.

- fbc36cb: Fix `TaskExecutor.getTaskStatus` to dispatch the AdCP `tasks/get` tool
  spec-conformantly. Closes #967.

  **Pre-fix bugs**:
  1. **Wrong request param**: SDK passed `{ taskId }` (camelCase). AdCP
     3.0 schema (`schemas/cache/3.0.0/bundled/core/tasks-get-request.json`)
     requires `{ task_id }` (snake_case). Conformant sellers reject as
     INVALID_PARAMS.
  2. **Wrong response shape mapping**: SDK read `(response.task as TaskInfo)` —
     expects a non-spec nested wrapper with camelCase fields. AdCP-spec
     responses are flat snake_case (`{ task_id, task_type, status,
created_at, updated_at, ... }`); real spec-conformant responses
     produced `taskId: undefined` everywhere on the polled `TaskInfo`.
  3. **Wrong primary path**: SDK tried MCP `experimental.tasks.getTask`
     first for MCP agents and fell through to the AdCP tool on
     capability-missing. The MCP-experimental path tracks
     transport-call lifecycle (the MCP analog of A2A `Task.state`),
     not AdCP work lifecycle. For polling submitted-arm tasks (which
     is what `pollTaskCompletion` does) we need work status; the two
     interfaces are not substitutes (per protocol-expert review on
     #966/#967).

  **Fix**:
  - Drop the MCP-experimental.tasks first attempt. Always dispatch the
    AdCP `tasks/get` tool over the agent's transport.
  - Pass the request param as `task_id` (snake_case).
  - Map the response via a new `mapTasksGetResponseToTaskInfo` helper
    that walks the transport-level wrappers (MCP `structuredContent`,
    A2A `result.artifacts[0].parts[0].data`, legacy `{ task: ... }`
    nested wrapper) and the AdCP-spec flat shape, then projects to the
    internal `TaskInfo`.
  - Bypass `extractResponseData` for `tasks/get` — the generic
    AdCP-error-arm detection misinterprets the spec's informational
    `error: { code, message }` block as an error envelope and shreds
    the response into `{ errors: [...] }`. The new helper handles
    unwrapping directly.
  - Pass through `result` / `task_data` from `additionalProperties: true`
    so completion data round-trips when sellers add it. (Note: AdCP
    3.0 doesn't define a typed completion-payload field on `tasks/get`;
    see adcp#3123 for the upstream clarification issue. Forward-compat
    with all three possible spec resolutions.)

  **Behavior change**: MCP sellers that supported `experimental.tasks`
  but did NOT register an AdCP `tasks/get` tool will now see polling
  fail rather than silently use the wrong-lifecycle interface. This is
  deliberate — the previous behavior was incorrect (returned transport
  status, not work status). Sellers should register `tasks/get` as an
  AdCP tool to support buyer-side polling.

  Adds `test/server-tasks-get-spec-shape.test.js` with six regression
  tests:
  - Request param naming (snake_case `task_id`, no camelCase `taskId`)
  - AdCP-spec flat response mapping (incl. ISO 8601 timestamps)
  - Result-data passthrough via additionalProperties
  - Error-block mapping (failed status with `error: { code, message }`)
  - Legacy `{ task: ... }` nested-shape backward compat
  - No MCP-experimental.tasks first attempt

  Companion of #966 (server-task-id plumbing). With both PRs landed,
  MCP submitted-arm polling works end-to-end against spec-conformant
  sellers. A2A submitted-arm polling still has additional bugs at the
  parser layer (`getStatus` reads transport state, `getTaskId` extracts
  A2A Task.id instead of `artifact.metadata.adcp_task_id`); tracked in
  adcp-client#973.

- 4b02028: Audit storyboard request-builder enrichers for placeholder-id clobber
  pattern (closes #989).

  **Findings from the 12-site audit:**

  `get_content_standards` keeps `'unknown'` — `standards_id` is required
  by `GetContentStandardsRequestSchema` (no `.optional()`), so returning
  `{}` would violate the schema round-trip invariant. The `'unknown'`
  placeholder correctly triggers a clean NOT_FOUND when context lacks a
  real id, surfacing the authoring gap. This differs from `get_media_buys`
  (fixed in #983/#988) where `media_buy_ids` is optional.

  All other `'unknown'` placeholders in mutating writes (`update_media_buy`,
  `calibrate_content`, `check_governance`, `update_content_standards`,
  `validate_content_delivery`, `acquire_rights`, `update_rights`,
  `creative_approval`, `si_send_message`, `si_terminate_session`) are
  correct: they produce a clean NOT_FOUND, surfacing "wire context_outputs
  from the create step."

  **Code change:** Four mutating-write enrichers used `'test-creative'` as
  the creative/artifact-id fallback. Unlike `'unknown'`, `'test-creative'`
  could be silently accepted by a pre-seeded test agent, masking an
  authoring error. Standardised all four to `'unknown'` for consistency:
  - `report_usage` — `creative_id`
  - `calibrate_content` — `artifact_id`
  - `validate_content_delivery` — `artifact_id`
  - `creative_approval` — `creative_id`

  **Tests:** Added 3 unit tests for `get_content_standards` to
  `test/lib/request-builder.test.js` (unknown fallback, context injection,
  fixture wins).

- fc70b9a: **Fix `get_media_buys` and `get_media_buy_delivery` storyboard enrichers injecting `media_buy_ids: ["unknown"]` when no context ID is present (#983).** Both enrichers unconditionally built `media_buy_ids: [context.media_buy_id ?? 'unknown']`. When a storyboard tests the broad-list/pagination path (no IDs in `sample_request`), the fixture-wins merge (`{ ...enriched, ...fixture }`) could not clear the injected placeholder because the fixture simply omitted the key. Agents received `media_buy_ids: ["unknown"]`, returned 0 matches, and storyboard `pagination.has_more` assertions failed.

  Both enrichers now omit `media_buy_ids` entirely when `context.media_buy_id` is absent, matching the pattern used by `list_creatives` and `list_accounts`. When a real ID is present the behavior is unchanged. This unblocks the `get-media-buys-pagination-integrity` storyboard in `adcontextprotocol/adcp#3122` from upgrading to its intended multi-page seeded walk.

- 72b3f87: `verifyIntrospection`: drop the `as Record<string, unknown>` cast on the
  introspection response stored in `AuthPrincipal.claims`. `JWTPayload`'s
  `[propName: string]: unknown` index signature already accepts the RFC 7662
  response shape structurally, so the cast was hiding the real relationship
  between the two types. Adds a JSDoc callout on `AuthPrincipal.claims` that
  the field carries either a decoded JWT (verifyBearer) or an RFC 7662
  introspection response (verifyIntrospection), and that adapter handlers
  passing claim values (`sub`, `username`, `client_id`) into an LLM context
  must narrow and validate — an upstream IdP that controls those fields can
  inject prompt content otherwise.
- 5d788bc: `TaskExecutor.pollTaskCompletion`: handle every non-progressing AdCP
  task status. Closes #977 (both halves).

  **Pre-fix**: `pollTaskCompletion` only exited on `completed`, `failed`,
  and `canceled`. Three non-progressing statuses caused the loop to spin
  until the caller's timeout:
  - **`rejected`** — definitively terminal per the AdCP `task-status`
    enum ("Task was rejected by the agent and was not started"). Now
    collapses onto the same `failed`/`canceled` exit branch with
    `{ success: false, status: 'failed' }`.
  - **`input-required`** — paused state. Polling alone can't advance it;
    the buyer must satisfy the paused condition (supply input) and
    retry the original tool call. Now returns a
    `TaskResultIntermediate` with `status: 'input-required'`,
    `success: true` (mirrors the synchronous `handleInputRequired`
    no-handler path).
  - **`auth-required`** — paused state. Same handling as
    `input-required`. Also added to `TaskResultIntermediate`'s status
    union and the `TaskStatus` type.

  **Error fallback**: the polling path now checks `status.message`
  before the generic `Task <status>` template, matching the
  synchronous dispatch path. `TaskInfo` gains an optional `message`
  field; the `tasks/get` response mapper preserves the top-level
  `message` field through to it.

  **Side fixes** caught by review:
  - `mcp-tasks.mapMCPTaskToTaskInfo`: the `statusMessage → error`
    projection now checks against the AdCP-mapped status (post-
    `mapMCPTaskStatus`) instead of the MCP-side raw status. The prior
    check used `['failed', 'rejected', 'canceled']` against the
    pre-mapping string — but MCP Tasks emits `'cancelled'` (British)
    and never `'rejected'` as a standard status, so MCP-cancelled
    tasks weren't surfacing `statusMessage` as `error`.
  - `onTaskEvents`: `'canceled'` was falling through to
    `onTaskUpdated`. Now joins `'failed'` and `'rejected'` on the
    `onTaskFailed` branch.
  - `TaskStatus` union: adds `'rejected'`, `'canceled'`, and
    `'auth-required'` for metadata fidelity.

  **Tests**: `test/lib/poll-task-completion-terminal-states.test.js`
  covers all three new exit paths plus regressions for `failed` /
  `canceled`. 9 tests; mocks dispatch via `protocol: 'a2a'` so polls
  route directly through `ProtocolClient.callTool` without the MCP
  Tasks protocol fast path.

  **adcp#3126 alignment** (typed `tasks/get` result field):
  adcontextprotocol/adcp#3126 closed the spec ambiguity flagged in
  adcp#3123 by adding a typed `result` field on `tasks/get` responses
  (gated by `include_result: true` on the request, populated when
  `status: 'completed'`). The SDK now sets `include_result: true` on
  every polling request so spec-conformant 3.1.0+ sellers populate
  the typed field; pre-3.1.0 sellers ignore the unknown request
  field, and the response mapper continues to read `result` (the
  typed and informal paths share the same field name). Dropped the
  informal `task_data` alias from the mapper — `result` is the
  canonical name.

- fbc36cb: Fix `SubmittedContinuation.taskId` and the polling cycle to use the
  server-assigned task handle instead of the SDK's runner-side
  correlation UUID. Closes #966.

  Pre-fix bug: `setupSubmittedTask` plumbed the local UUID generated at
  request time (`TaskState.taskId`, used for the `activeTasks` map and
  the `{operation_id}` webhook URL macro) through to the
  `SubmittedContinuation`. `track()` and `waitForCompletion()` then
  addressed `tasks/get` calls with that local UUID — which the seller
  has never seen, so any spec-conformant seller would respond with
  NOT_FOUND. Existing mock tests masked this because they ignored the
  `taskId` parameter when stubbing the polling response.

  Post-fix: `setupSubmittedTask` extracts the server-assigned handle via
  `responseParser.getTaskId(response)` (which already walks both the
  flat AdCP `response.task_id` shape and the A2A `result.kind === 'task'`
  → `result.id` shape) and uses it for both the buyer-facing
  `SubmittedContinuation.taskId` field and the closures' polling calls.
  The local UUID stays internal for `activeTasks` bookkeeping and the
  webhook URL macro.

  When a seller violates the spec and omits the task handle entirely,
  the SDK falls back to the local UUID so callers still get a non-
  undefined `taskId` field — pollers won't be able to locate the work,
  but this matches the historical (broken) behavior surface and avoids
  introducing a hard fail at a code path that's been silently wrong.

  Updates `SubmittedContinuation.taskId` JSDoc to document that it
  carries the server handle and is distinct from the runner-side
  correlation id.

  Adds `test/server-task-id-plumbing.test.js` — five regression tests
  covering the conformant path, polling/track invocations addressing the
  right id, the spec-violation fallback, and the A2A `result.kind: 'task'`
  branch of `responseParser.getTaskId`.

  Companion follow-up: #967 — fix the AdCP `tasks/get` request param
  naming (`taskId` → `task_id`) and the response-shape mapping. This PR
  plumbs the right ID; #967 wires it into a spec-conformant request and
  parses the spec-conformant response.

- d62da47: Skill drift fixes (caught by `npm run typecheck:skill-examples`):
  - 8 SKILL.md files imported `verifyApiKey`, `verifyBearer`, `anyOf`, `bridgeFromTestControllerStore` from `@adcp/client` (top-level) — these symbols only exist under `@adcp/client/server`. Agents copy-pasting the example would get `Module has no exported member` at compile time. Fixed across all affected skills (`build-creative-agent`, `build-generative-seller-agent`, `build-governance-agent`, `build-retail-media-agent`, `build-seller-agent`, `build-si-agent`, `build-signals-agent`, `build-seller-agent/deployment.md`).

  Plus `scripts/typecheck-skill-examples.ts` — extracts every fenced TS block from `skills/**/*.md`, compiles each as a standalone module against the published `@adcp/client` types, and fails on new typecheck errors. Baseline mode (`scripts/skill-examples.baseline.json`) records the 142 known documentation-pattern errors (placeholder identifiers, untyped `ctx.store.list` returns) so the script ships green on day one and ratchets down over time. Run with `npm run typecheck:skill-examples`.

- ea54d16: Skill drift fixes surfaced by matrix conformance harness:
  - **build-creative-agent**: replace non-existent `server.registerTool('preview_creative', ...)` with the `creative.previewCreative` domain handler that has existed since `createAdcpServer` first shipped. Agents following the previous skill text wrote `TypeError: server.registerTool is not a function` into `serve()`, the factory threw, no tools registered, and the agent returned 401 on every request.
  - **build-creative-agent**: vendor-pricing pitfall added — `list_creatives.creatives[].pricing_options[]` uses field name `model` (not `pricing_model` like products), and each model has its own required fields. Includes the `flat_fee` `period` requirement that the schema enforces but earlier skill text omitted.
  - **All skills**: cross-cutting pitfall callout — `capabilities.specialisms` on `createAdcpServer` is required for storyboard track resolution. Agents that wire every tool but don't claim their specialism fail conformance with "No applicable tracks found" silently.
  - **build-seller-agent**: split into `SKILL.md` (95 KB, was 136 KB) plus `deployment.md` and 6 specialism-delta files under `specialisms/`. Reduces the single-file budget Claude has to process when building a sales-non-guaranteed agent.
  - **build-brand-rights-agent / build-generative-seller-agent / build-governance-agent / build-retail-media-agent**: `sync_accounts` response per-row `action` field clarified (`'created' | 'updated' | 'unchanged' | 'failed'` enum required by schema; previously skill examples omitted it).

  Plus `scripts/conformance-replay.ts` — deterministic in-process schema-conformance harness covering creative-template (6/6 steps pass in ~2s). Not user-facing; ships in the published package because `scripts/**` is published. v0; expansion to other specialisms in follow-ups.

- 4d91c11: **Docs (in-source): clarify why `tools/list` publishes empty `inputSchema`.** The framework intentionally registers tools with `PASSTHROUGH_INPUT_SCHEMA` so MCP `tools/list` returns `{ type: 'object', properties: {} }` per tool — full per-tool schemas would balloon the context window for LLM consumers, who are the primary readers of MCP discovery. Tool shapes live in `docs/llms.txt`, the SKILL.md files, and `schemas/cache/`. Comment-only change at `create-adcp-server.ts` (registration + `PASSTHROUGH_INPUT_SCHEMA` definition) and `SingleAgentClient.adaptRequestForServerVersion` (consumer side) so future engineers don't try to "fix" the empty schemas by inlining them. Points downstream consumers at `schema-loader.ts` / `schemaAllowsTopLevelField` (#940) as the canonical pattern when they need a tool's shape.
- ce4d1ce: **Fix `version.ts` drift on release.** Changesets bumps `package.json` for the Release PR but doesn't know about `src/lib/version.ts`, so every release left the in-repo `version.ts` stale (e.g., `package.json: 5.17.0` while `version.ts: 5.16.0`). The npm tarball was always correct because `build:lib` runs `sync-version` on the CI runner — but the git tree drifted.

  Fix: chain `npm run sync-version` after `changeset version` so the Release PR includes the synced `version.ts`. When merged, both files stay in lockstep.

  No runtime behavior change. The published package's `LIBRARY_VERSION` was already correct via the build-time sync; this just keeps the git source-of-truth honest.

## 5.17.0

### Minor Changes

- 0a0b802: **Fix MCP/A2A validation asymmetry (#909).** Before this change, the MCP SDK's Zod validator ran only on the MCP transport — A2A bypassed it via `AdcpServer.invoke()`, so the same malformed request could be rejected on MCP (with a raw `-32602` JSON-RPC error) while silently reaching the handler on A2A. The framework AJV validator now runs authoritatively on both transports, producing a single structured `adcp_error` envelope with the same pointer-level `issues[]` regardless of transport.

  **Implementation:**
  - Framework-registered tools (`create-adcp-server.ts`) now pass `z.object({}).passthrough()` as `inputSchema` instead of per-tool Zod shapes. The passthrough shape preserves handler arguments (the SDK's `validateToolInput` returns `undefined` when no schema is registered, which would have destroyed args on MCP); the empty declared-properties make the framework AJV validator the sole enforcer for both transports.
  - `requests` validation mode default flipped from `'warn'` to `'strict'` outside production. Matches the existing `responses: 'strict'` default and ensures A2A malformed payloads are rejected before reaching handlers (previously the MCP SDK's Zod filled this role; that safety net is gone).
  - Client-side field-stripping in `SingleAgentClient.adaptRequestForServerVersion` treats an empty-properties schema as "fail open" instead of "strip everything" (JSON Schema semantics). Required because the server's post-#909 `tools/list` publishes `{ type: 'object', properties: {} }` for every tool — the previous code would have stripped every buyer-supplied field.

  **Wire format change:**
  - MCP clients no longer receive raw `-32602 Input validation error: <Zod text>` on malformed requests. They receive the framework's structured `adcp_error` envelope (`code: 'VALIDATION_ERROR'`, `issues: [{ pointer, message, keyword }]`) — same shape A2A clients always get. Clients that parsed `-32602` text need to migrate to reading `structuredContent.adcp_error`.
  - `tools/list` over MCP returns `{ type: 'object', properties: {} }` per tool (no per-tool parameter schemas). AdCP-native discovery (`get_adcp_capabilities`) already works over both transports; upstream [adcp#3057](https://github.com/adcontextprotocol/adcp/issues/3057) proposes `get_schema` as a capability tool for per-tool shape discovery.
  - Test seller fixtures using sparse payloads now need explicit `validation: { requests: 'off' }` alongside `responses: 'off'`. The seven in-tree test helpers were updated accordingly.

  **New test:** `test/server-validation-symmetry.test.js` sends the same malformed request to one `AdcpServer` over MCP and A2A; asserts `adcp_error.code`, `recovery`, and sorted issue-pointer lists match. Locks #909 against regression.

- 42a66f3: **A2A serve adapter (preview).** `createA2AAdapter({ server, agentCard, authenticate, taskStore })` exposes the same `AdcpServer` that `serve()` mounts over MCP as a peer A2A JSON-RPC transport. Both transports share the dispatch pipeline — idempotency store, state store, `resolveAccount`, request/response validation, governance — so a handler change is picked up by both at once.

  **Scope (v0):** `message/send`, `tasks/get`, `tasks/cancel`, `GET /.well-known/agent-card.json`. Streaming (`message/stream`), push notifications, and mid-flight `input-required` interrupts are explicit "not yet" — tracked for v1. The adapter is marked preview; pin a minor version while the AdCP-over-A2A conventions stabilise across the ecosystem.

  **Handler return → A2A `Task.state` mapping (aligned with A2A 0.3.0 lifecycle):**
  - Success arm → `completed` + DataPart artifact carrying the typed payload
  - Submitted arm (`status:'submitted'`) → `completed` (the transport call itself completed; `submitted` is initial-only per A2A 0.3.0, not terminal) + DataPart artifact preserving the AdCP response; **`adcp_task_id` rides on `artifact.metadata`** so the AdCP payload still validates cleanly against the tool's response schema
  - Error arm (`errors:[]`) → `failed` + DataPart artifact preserving the spec-defined error shape
  - `adcpError('CODE', ...)` → `failed` + DataPart artifact with `adcp_error`

  **Two lifecycles, one response.** A2A `Task.state` tracks the transport call (did the HTTP request complete?); AdCP `status` inside the artifact tracks the work (submitted / completed / failed). A `completed` A2A task can carry a `submitted` AdCP response — they're orthogonal state machines. Buyers resume async AdCP work via `artifact.metadata.adcp_task_id`.

  **`mount(app)` convenience helper.** `adapter.mount(app)` wires all four routes from one call: JSON-RPC at the agent-card URL's pathname, the agent card at both `{basePath}/.well-known/agent-card.json` (A2A SDK discovery convention) and `/.well-known/agent-card.json` (origin-root probes). Eliminates the common 404 on first discovery when sellers mount the card at only one path. `A2AMountOptions` supports `basePath` override and `wellKnownAtRoot: false` for deployments where an upstream proxy owns origin-root routes.

  **Skill addressing.** Clients send a `Message` with a single `DataPart` carrying `{ skill: '<tool_name>', input: { ... } }`. The legacy key `parameters` (emitted by `src/lib/protocols/a2a.ts` before the adapter landed) is accepted as an alias for `input` so same-SDK client/server pairs talk cleanly. Non-conforming messages surface as `Task.state='failed'` with `reason: 'INVALID_INVOCATION'`.

  **New public surface.** `AdcpServer.invoke({ toolName, args, authInfo, signal })` — production-safe alias of the tool-call path both transports run through. Docstring makes auth the caller's responsibility; `dispatchTestRequest` stays the test-only sibling.

  **New exports** (from `@adcp/client` and `@adcp/client/server`): `createA2AAdapter`, `A2AInvocationError`, `A2AAdapter`, `A2AAdapterOptions`, `A2AAgentCardOverrides`, `A2AMountOptions`, `ExpressAppLike`, plus `AdcpAuthInfo` and `AdcpInvokeOptions` for transport authors building custom adapters.

  **Dependencies.** Uses `@a2a-js/sdk` (already a peer dep for the client-side caller) via its `/server` subpath export; no new peer deps required. `@types/express` added as a devDep so our types resolve when the SDK's express middleware returns `RequestHandler` from `express`.

- d102262: **Strict types and builders for `Format.assets[]`.** The codegen collapses the discriminated union under `Format.assets[]` to `BaseIndividualAsset` — no per-asset-type branches, no `requirements` field. That means a platform emitting a loose literal like `{ asset_type: 'image', requirements: { file_types: ['jpg'] } }` compiled clean but failed strict response validation, because the real spec field is `formats`, not `file_types`. `scope3data/agentic-adapters#118` hit this across five adapters (Pinterest, TikTok, UniversalAds, Criteo, CitrusAd) on four independent axes: `file_types` vs `formats`/`containers`, `min_duration_seconds` vs `min_duration_ms`, comma-joined `aspect_ratio`, and `min_count`/`max_count` placed on an individual asset instead of a `repeatable_group` wrapper.

  **New types** — per-asset-type slot shapes that wire the existing `ImageAssetRequirements` / `VideoAssetRequirements` / `AudioAssetRequirements` / `TextAssetRequirements` / `MarkdownAssetRequirements` / `HTMLAssetRequirements` / `CSSAssetRequirements` / `JavaScriptAssetRequirements` / `VASTAssetRequirements` / `DAASTAssetRequirements` / `URLAssetRequirements` / `WebhookAssetRequirements` / `CatalogRequirements` interfaces into a discriminated `IndividualAssetSlot` union, plus `RepeatableGroupSlot` and a top-level `FormatAssetSlot = IndividualAssetSlot | RepeatableGroupSlot`. `GroupAssetSlot` variants parallel the individual slots for use inside `RepeatableGroupSlot.assets[]`. Exported from `@adcp/client`.

  **New builders** — `imageAssetSlot`, `videoAssetSlot`, `audioAssetSlot`, `textAssetSlot`, `markdownAssetSlot`, `htmlAssetSlot`, `cssAssetSlot`, `javascriptAssetSlot`, `vastAssetSlot`, `daastAssetSlot`, `urlAssetSlot`, `webhookAssetSlot`, `briefAssetSlot`, `catalogAssetSlot`, `repeatableGroup`, and per-asset-type `*GroupAsset` helpers. Each injects `item_type` and `asset_type` so callers write the meaningful fields only. A `FormatAsset` namespace groups all of them for single-import use (`FormatAsset.image(...)`, `FormatAsset.group(...)`).

  **What this catches.** With the generated types, `{ requirements: { file_types: ['jpg'] } }` was `{ [k: string]: unknown }` and passed the compiler. With the new slot types, it fails at the authorship site — the compiler knows the spec's field names and closed enums. The type-test file `src/type-tests/format-asset-slots.type-test.ts` asserts via `@ts-expect-error` that `file_types`, `min_duration_seconds`, out-of-enum `containers`/`formats`, and `min_count`/`max_count` on an individual asset are all rejected — CI's typecheck fails if any of those regress.

  **Skills updated.** `skills/build-seller-agent/SKILL.md`, `skills/build-generative-seller-agent/SKILL.md`, and `skills/build-creative-agent/SKILL.md` each gained a "format asset slot" section with the four translation footguns and concrete builder-based examples framed for that audience (social/retail sales, generative DSPs, ad servers/CMPs).

  Additive change — existing `Format.assets[]` literals continue to compile; the new surface is available for authors who want compile-time protection for requirement shapes.

- 942acda: **Add `idempotency: 'disabled'` mode and standalone enum value arrays.**

  Two additive surfaces aimed at consumers who currently duplicate spec data or have to UUID-inject every test payload to satisfy AdCP 3.0's `idempotency_key` requirement.

  **1. `idempotency: 'disabled'` for `createAdcpServer`.** The `idempotency` option on `AdcpServerConfig` now accepts the literal `'disabled'` in addition to an `IdempotencyStore`. When set:
  - **`get_adcp_capabilities` flips to the spec's `IdempotencyUnsupported` branch** — the response advertises `adcp.idempotency: { supported: false }` with `replay_ttl_seconds` omitted, matching the `oneOf` discriminator in `get-adcp-capabilities-response.json`. Buyers reading capabilities can fall back to natural-key dedup before retrying spend-committing operations. (Earlier drafts of this change kept `supported: true`; that's a money-flow footgun and was caught in expert review.)
  - The mutating-tool middleware (`INVALID_REQUEST` / `IDEMPOTENCY_CONFLICT` / `IDEMPOTENCY_EXPIRED`) is skipped.
  - Schema validation (`validation.requests: 'strict'`) tolerates a missing `idempotency_key` on mutating tools — every other required field still produces `VALIDATION_ERROR`. The filter is surgical: only the `keyword: 'required', pointer: '/idempotency_key'` issue is dropped (top-level `instancePath`-based; nested fields would not match).
  - A pre-middleware shape gate enforces `IDEMPOTENCY_KEY_PATTERN` (`^[A-Za-z0-9_.:-]{16,255}$`) whenever a key IS supplied, **regardless of disabled mode** — defense-in-depth so a malformed key never reaches handler logs even when validation is `'off'` and the replay middleware is skipped.
  - The "mutating handlers without an idempotency store" startup error log is suppressed.
  - **`createAdcpServer` throws at construction unless `NODE_ENV` is explicitly `'test'` or `'development'`** (or the operator sets `ADCP_IDEMPOTENCY_DISABLED_ACK=1` to acknowledge the risk). The earlier draft only refused under `NODE_ENV === 'production'`, but `NODE_ENV` is unset by default in raw Lambda, custom containers, and many K8s deployments — exactly the environments where a silent disabled-mode start is most dangerous. The inverted allowlist makes the safe defaults explicit: dev/test work without ceremony, anything else fails fast or requires deliberate ack. Inside the allowlist a `logger.warn` fires so the choice stays visible.

  Production servers must still wire a real store via `createIdempotencyStore({ backend, ttlSeconds })` — `'disabled'` is for non-production test fleets that don't model replay behavior. The existing `idempotency: store` and `idempotency: undefined` paths are unchanged.

  **Storyboard interaction.** The universal `compliance/.../universal/idempotency.yaml` storyboard explicitly states that sellers declaring `supported: false` MUST skip it. Auto-skip wiring in the runner is a follow-up; today, running this storyboard against a disabled-mode agent will fail (correctly, since the agent has no replay window to test).

  **2. Standalone enum value arrays.** A new generated file `src/lib/types/enums.generated.ts` exports a `${TypeName}Values` const array for every named string-literal union in the AdCP TypeScript types — `MediaChannelValues`, `PacingValues`, `MediaBuyStatusValues`, `DeliveryTypeValues`, `AssetContentTypeValues`, etc. (122 enums total). Adapters can now import the spec's literal sets directly instead of duplicating them or re-deriving from Zod:

  ```ts
  import { MediaChannelValues } from '@adcp/client/types';
  const channels = new Set<string>(MediaChannelValues);
  if (!channels.has(input)) throw new Error('unknown channel');
  ```

  Codegen is wired into the existing pipeline (`generate-types` now also runs `generate-enum-arrays`), so `ci:schema-check` catches drift the same way it catches type drift. The new test `test/lib/enum-arrays.test.js` cross-validates that every `Values` array round-trips against its matching `Schema` Zod validator — if either side drifts, the test fails fast.

  **Inline anonymous unions (e.g., `formats?: ('jpg' | 'jpeg' | ...)[]` inside `ImageAssetRequirements`) are out of scope** — they don't have a stable name in the generated TypeScript. Use the Zod schema's introspection if you need them. A follow-up may extract specific high-value inline enums to named exports.

- b74a9ce: Add `mcpToolNameResolver` export on `@adcp/client/server` — a default `resolveOperation` for MCP agents wiring RFC 9421 signature auth. Parses the buffered JSON-RPC body on `req.rawBody` and returns `params.name` when `method === 'tools/call'`; returns `undefined` otherwise so the downstream handler produces a precise error instead of the pre-check rejecting every unsigned call.

  Use directly as `resolveOperation` on `verifySignatureAsAuthenticator`, `requireSignatureWhenPresent`, or `requireAuthenticatedOrSigned` instead of hand-rolling the same JSON-RPC parser in every seller agent.

- 7681396: feat(server): host-aware `serve()` for one-process multi-host deployments

  `ServeOptions.publicUrl` and `protectedResource` now accept a `(host) => …`
  function, and the factory's `ServeContext` carries the resolved `host` so one
  process can front many hostnames (white-label sellers, multi-brand adapters)
  without re-owning the HTTP plumbing. Set `trustForwardedHost: true` when
  `serve()` sits behind a proxy that sanitizes `X-Forwarded-Host`. Per-host
  resolver results are cached. Static `publicUrl: string` is unchanged.

  `verifyBearer({ audience })` now also accepts `(req, ctx) => string` where
  `ctx = { host, publicUrl }` comes from `serve()`'s host resolution — use
  `audience: (_req, { publicUrl }) => publicUrl!` so the JWT audience check
  and the RFC 9728 `resource` URL can never diverge. Reading `X-Forwarded-Host`
  directly in the callback is a footgun when `trustForwardedHost` is off.

  New `UnknownHostError` class — throw it from the factory (or `publicUrl`/
  `protectedResource` resolvers) for unconfigured hosts; `serve()` maps to
  404 with a generic body so the routing table never crosses the wire.

  New `getServeRequestContext(req)` helper exposes the resolved
  `{ host, publicUrl }` to custom authenticators wired outside `verifyBearer`.

  New `resolveHost(req, { trustForwardedHost? })` and `hostname(host)` exports
  — same logic `serve()` uses internally, so callers building their own
  host-dispatch middleware behind `createExpressAdapter` don't re-implement the
  X-Forwarded-Host / RFC 7239 Forwarded / overwrite-vs-append hardening.

  New `reuseAgent: true` on `ServeOptions` — lets the factory cache
  `AdcpServer` instances per host instead of reconstructing on every request.
  The framework wraps connect→handleRequest→close in a per-instance async
  mutex because MCP's `Protocol.connect()` rejects when a transport is
  already attached. Concurrent requests on different cached servers still
  run in parallel. Closes #901.

  New `verifyIntrospection({ introspectionUrl, clientId, clientSecret, … })`
  authenticator — RFC 7662 bearer validation for adapter agents that proxy
  upstream platform OAuth (Snap, Meta, TikTok, …) rather than minting their
  own JWTs. Matches `verifyBearer`'s shape (`null` on missing bearer, throws
  `AuthError` on reject). Features: TTL-capped positive cache keyed on SHA-256
  of the token, opt-in negative caching, RFC 6749 §2.3.1 form-urlencoded Basic
  auth, fail-closed on upstream errors/timeouts, optional `requiredScopes` and
  `audience` checks. Closes #902.

  Closes #885.

- 547080a: **Enrich `oneOf` / `anyOf` validation errors with variant metadata.** When AJV rejects a request because a discriminated-union field matched none of its variants, the emitted `ValidationIssue` now carries a `variants[]` array describing what each variant would accept — instead of the bare "must match exactly one schema in oneOf" that left naive LLM clients stuck.

  Before:

  ```json
  { "pointer": "/account", "keyword": "oneOf", "message": "must match exactly one schema in oneOf" }
  ```

  After:

  ```json
  {
    "pointer": "/account",
    "keyword": "oneOf",
    "message": "must match exactly one schema in oneOf",
    "variants": [
      { "index": 0, "required": ["account_id"], "properties": ["account_id"] },
      { "index": 1, "required": ["brand", "operator"], "properties": ["brand", "operator", "sandbox"] }
    ]
  }
  ```

  A caller reading this knows exactly which combinations to try — pick one variant's `required` fields. Empirically, this unsticks the #1 naive-LLM stall point (discriminated `account` on `create_media_buy`, discriminated `destinations[]` on `activate_signal`, etc.).

  **Scope:** applies to both `validateRequest` and `validateResponse`. Variants land on the same `issues[]` that ship at `adcp_error.issues` and `adcp_error.details.issues` on wire envelopes — no new field on the error envelope itself. Non-union keywords (`required`, `type`, `enum`, `additionalProperties`, …) are unchanged.

  **Trade-off:** response payload grows slightly for schemas with many variants. Variants are derived from public `@adcp/client`/AdCP spec schemas — no seller-specific information leaks. `schemaPath` gating (production strip) is unchanged; `variants` is not gated because the information is already public in the canonical schemas under `schemas/cache/<version>/`.

  **Related:** pairs with [#918](https://github.com/adcontextprotocol/adcp-client/pull/918) (buyer-side `call-adcp-agent` skill) and #915 (validation symmetry). Together these give naive LLMs two paths to recover: the skill carries priors about common variants; the enriched error carries them at runtime for variants the skill doesn't cover. Non-LLM buyers (programmatic clients) benefit regardless.

- be61077: feat(testing): add rawA2aProbe for A2A transport-layer storyboard diagnostics

  Adds `rawA2aProbe({ agentUrl, method, params?, headers?, allowPrivateIp? })` to
  `src/lib/testing/storyboard/probes.ts`, mirroring `rawMcpProbe` for agents
  exposed over the A2A transport. Returns `{ httpResult: HttpProbeResult;
taskResult?: TaskResult }` so the storyboard `ValidationContext` can consume both
  probes interchangeably. Surfaces raw JSON-RPC error codes (including A2A-specific
  `-32002 TaskNotCancelable`) without protocol aliasing.

- 6c626bd: `runStoryboardStep` now accepts and emits `context_provenance` so LLM-orchestrated step-by-step runs can thread rejection-hint provenance across calls the same way `context` already flows. Closes adcp-client#880. Before this, stateless step calls always initialized an empty provenance map and `context_value_rejected` hints never fired on that surface.
  - `StoryboardRunOptions.context_provenance?: Record<string, ContextProvenanceEntry>` — seeds the map.
  - `StoryboardStepResult.context_provenance?: Record<string, ContextProvenanceEntry>` — full accumulated map after this step's own writes are applied. Absent when empty.

  Full `runStoryboard` behavior is unchanged (it builds the map internally; the field still surfaces on each step result for consumers reading compliance reports).

- 7227b96: Four ergonomic upgrades to the RFC 9421 signing surface — all backwards compatible, all opt-in via omission:
  - **`verifySignatureAsAuthenticator`** now defaults `replayStore` and `revocationStore` to fresh `InMemoryReplayStore` / `InMemoryRevocationStore` instances when omitted. Every authenticator instance gets its own default stores (no cross-talk). Wire explicit stores in multi-replica deployments where replay state must be shared.
  - **`createExpressVerifier`** gets the same defaults — symmetric with `verifySignatureAsAuthenticator` so both the `serve()` and raw-Express paths have identical ergonomics.
  - **`buildAgentSigningFetch`** now defaults `upstream` to `globalThis.fetch` when omitted. Throws a clear `TypeError` if `globalThis.fetch` isn't available, rather than binding `undefined` and failing cryptically on first request.
  - **`createAgentSignedFetch(options)`** — new preset for the single-seller buyer case. Bundles `buildAgentSigningFetch` with a `CapabilityCache` lookup keyed by the target seller's `agent_uri`. One call replaces the four-object `buildAgentSigningFetch` + `CapabilityCache` + explicit `getCapability` wire-up:

    ```typescript
    // fetch.ts
    export const signedFetch = createAgentSignedFetch({
      signing: { kid, alg: 'ed25519', private_key: privateJwk, agent_url: 'https://agent.example.com' },
      sellerAgentUri: 'https://seller.example.com',
    });
    ```

    For multi-seller adapters, build one preset per seller or drop to `buildAgentSigningFetch` with a URL-dispatching `getCapability`.

- 79abb02: Add `createWebhookVerifier` factory for secure-by-default webhook signature verification (issue #926).

  `verifyWebhookSignature` requires callers to supply `replayStore` and `revocationStore` explicitly — callers who construct a new options object per request would silently receive no replay protection if stores were defaulted inside the per-call function. The new `createWebhookVerifier(options)` factory mirrors `createExpressVerifier`: stores are instantiated once at creation time and captured in closure scope, so all requests handled by the returned verifier share the same replay and revocation state. Pass an explicit shared store (Redis, Postgres, etc.) for multi-replica deployments. `verifyWebhookSignature` itself is unchanged — required stores remain required.

### Patch Changes

- 4035667: **Document why `createAgentSignedFetch.cache` defaults to the shared `defaultCapabilityCache` (#927).** The shared default is load-bearing: `ProtocolClient` / `buildAgentSigningContext` writes the seller's `get_adcp_capabilities` response into `defaultCapabilityCache`, and the signing fetch reads from the same instance so a single priming call serves every subsequent signing decision. Passing a fresh `new CapabilityCache()` without priming it silently disables `required_for` enforcement — cold cache → `shouldSignOperation` returns `false` → required ops ship unsigned → seller rejects, with no error from the SDK side. JSDoc on the `cache` field now spells this out, plus when an explicit cache is appropriate (primed in tests, out-of-band capability discovery), plus the security framing (cached entries are public seller advertisements, not buyer secrets).

  No behavior change.

- c9ddd63: **Resolve `globalThis.fetch` lazily in `buildAgentSigningFetch` (#927).** The previous implementation called `defaultUpstream()` at factory-call time and bound the result; a polyfill installed between factory creation and first request was silently ignored. The factory's docstring already promised "polyfills / patches that run after this module loads still take effect" — true at the import-vs-call axis, but not at the factory-call-vs-request axis. Resolution now happens per-request inside the returned closure when `upstream` is omitted, so a late-installed polyfill takes effect on its first request.

  The error thrown when `globalThis.fetch` is unavailable now surfaces on the first outbound request (where it was always going to matter) rather than at factory construction. Callers passing an explicit `upstream` see no behavior change — the lazy path is taken only when the default is in use.

- a7253a5: `skills/call-adcp-agent/SKILL.md`: two dx-driven additions for naive LLM callers.
  1. **Replay semantics on `idempotency_key`.** The skill now spells out what "same key → cached response" actually means in practice — same `task_id`, same `media_buy_id`, byte-for-byte identical — and warns against the most common doubling pattern (generating a fresh UUID on retry). Async flows replay against the same `task_id`, so polling continues against the same task instead of forking.
  2. **Symptom → fix table.** A quick lookup of the most common `adcp_error.issues[*]` shapes mapped to their one-line fix: merged `oneOf` variants, missing `idempotency_key`, `budget` as object, `format_id` as string, made-up `destinations[*].type`, async `status: 'submitted'`, the three `recovery` modes (`retryable` / `correctable` / `unsupported`), and HTTP 401. Designed to short-circuit the recovery loop before the caller has to read the whole envelope schema.

  Docs-only — no library/CLI behavior change. Pairs with the `variants[]` enrichment shipped in [#919](https://github.com/adcontextprotocol/adcp-client/pull/919).

- 998ed95: New skill: `skills/call-adcp-agent/SKILL.md` — buyer-side playbook for LLM clients calling an AdCP agent. Covers the wire contract, the `oneOf` account variants, idempotency invariants, async flow (`status:'submitted'` + `task_id`), error recovery from `adcp_error.issues[]`, and minimal payload examples for the top five tools (`get_products`, `create_media_buy`, `sync_creatives`, `get_signals`, `activate_signal`).

  **Motivation**: [#915](https://github.com/adcontextprotocol/adcp-client/pull/915) made MCP `tools/list` schema-free (the trade-off for cross-transport validation symmetry). Empirical three-way comparison showed a naive LLM gets stuck on 5/5 common tools without priors; with this skill loaded, Claude-class clients land their first successful call in 1 hop on all five. Upstream [adcp#3057](https://github.com/adcontextprotocol/adcp/issues/3057) (`get_schema`) remains the longer-term spec path for programmatic schema discovery; this skill unblocks LLMs today.

  Referenced from `CLAUDE.md`; ships alongside the existing `skills/build-*-agent/` set.

- 3e86910: Three CLI DX wins for runner hints:
  1. **Word-wrap.** Long hint messages (often 250–300 chars) now wrap to terminal width with continuation indent under the message text — first line carries `💡 Hint:`, follow-up lines align so the wrapped block reads as a paragraph, not a runaway line. Width comes from `process.stdout.columns` (TTY), `$COLUMNS` (env), or 100-col fallback. Backtick-fenced identifiers (e.g. `` `pricing_option_id` ``) never split across lines.
  2. **Run-summary hint count.** The closing summary line on `adcp storyboard run` now appends `· N hints` when any fired (silent on zero). Single-storyboard, multi-storyboard, and multi-instance summaries all get the suffix. Surfaces diagnostic info without making the operator scroll back through every step.
  3. **`adcp storyboard --help` discoverability.** New `OUTPUT:` block explains the `💡 Hint:` line, names the JUnit / JSON surfaces, and links to `docs/guides/VALIDATE-YOUR-AGENT.md § Reading hint lines`.

- a2528cc: CLI now renders runner hints (`StoryboardStepResult.hints[]`) in both the human console output and JUnit `<failure>` body. Previously #875 added the detector and populated the field but the CLI was a no-op for the feature — triage output still looked identical to a bare seller error. Closes #879.

  Console output prefixes each hint with `💡 Hint:` at the same 3-space indent as `Error:` and validations. JUnit failure bodies append `Hint (<kind>): <message>` lines so CI dashboards and test reporters pick them up.

- 55e10a9: CI: `ci:docs-check` now ignores the `> @adcp/client v<version>` / `> Library: @adcp/client v<version>` header when diffing generated agent docs, matching how the `> Generated at:` header is already ignored. Closes #881 — previously every version bump forced a doc regeneration commit even when no real content changed.
- e2c2969: Fix docs/guides/BUILD-AN-AGENT.md create_media_buy CLI example to match current schema: PackageRequest uses `product_id` + `budget` (plain number) + `pricing_option_id`; `brand` uses `{domain}` discriminator; `idempotency_key` is required. Adds `--protocol a2a` usage examples to VALIDATE-YOUR-AGENT.md.
- 5732368: Runner hint detector now recognizes the `adcp_error` (singular object) response envelope — what the canonical `adcpError()` SDK helper emits — alongside the `errors[]` (plural array) shape it already handled. Closes adcp-client#907. Surfaced during dogfood: agents built on the helper (the recommended pattern) were silently missing `context_value_rejected` hints because the detector only read `errors[]`. Also accepts `adcp_error: [...]` defensively. When both shapes are present in one response, the plural `errors[]` wins (spec-canonical).
- ddf9bd7: Runner hint gate now fires on any step-level failure (task-level OR validation-level), not just task failures. Closes adcp-client#883. Some sellers return 200 with an advisory `errors[]` + `available:` list (success envelope with warnings); the previous gate missed those because `passed` was true at the task level. `expect_error` semantics are unchanged — genuinely-failing expect_error steps still stay silent by design.
- 0ae9200: Runner `context_value_rejected` hint closing sentence now cites the two tool names involved in the catalog drift (e.g. "Check that the seller's `get_signals` and `activate_signal` catalogs agree.") instead of deriving an identifier fragment from the context key. The previous phrasing ("Check that the seller's catalogs agree on the id for this `first_signal_pricing_option` across steps.") read awkwardly when the key was multi-word — surfaced during dogfood. Falls back to the single-task form when only the source tool is known, and to a generic closing when neither is known. The detector now accepts an optional `currentTask` argument; existing callers keep working unchanged (generic closing).
- fd25ba1: Extracts the JUnit XML formatter out of `bin/adcp.js` into `src/lib/testing/storyboard/junit.ts` so the formatter is testable as a pure function. Closes three deltas salvaged from closed PR #894:
  - **`adcp storyboard step` printer**: now renders `💡 Hint: …` below the `Error:` line (was dropped silently before). Matches the step printer's column-zero style.
  - **`<failure message=…>` attribute fallback**: when `step.error` is absent (e.g. the #883-widened hint gate fires on a validation-only failure), the first hint's message is used so CI dashboards that only read the attribute still surface the diagnosis.
  - **`formatStoryboardResultsAsJUnit` exported as `@internal`** on `@adcp/client/testing` — the CLI imports it from there; consumers that want to emit JUnit themselves can, but the module isn't a supported public API.

  Also drops the unused `formatHintsForFailureBody` helper from `bin/adcp-step-hints.js` now that the JUnit formatter owns its own hint rendering, and parameterizes `printStepHints` with an `indent` argument so both printers (phase-nested 3-space and column-zero) can share it.

- e0e0674: Hardened `resolvePath` in the storyboard runner to apply the same `FORBIDDEN_KEYS` + `hasOwnProperty` guard that `resolvePathAll` and `setPath` already use. A storyboard path like `__proto__.polluted`, `constructor`, or `hasOwnProperty` now resolves to `undefined` (not-found) instead of projecting `Object.prototype` state into validation results. No call site relied on the permissive behavior. Surfaced by the security review on #876.
- 137e887: **Fix: storyboard runner no longer fails agents on empty-phases storyboards.**

  When a storyboard had `phases: []` (e.g., a placeholder or a `requires_scenarios:`-composed storyboard), the runner emitted a synthetic phase with `passed: false` even though its only step was `skipped: true`. This caused agents to appear to fail on that storyboard in the compliance report, producing a confusing `__no_phases__` entry in the output — a string not in the storyboard-schema's documented grading vocabulary.

  Changes:
  - Synthetic phase `passed` corrected from `false` → `true` (a skipped step is neutral, not a failure).
  - Internal sentinel strings `'__no_phases__'` replaced with `'no_phases'` in `step_id` and `phase_id`, consistent with the documented `RunnerSkipReason` vocabulary.
  - When `storyboard.requires_scenarios` is populated, the detail message now explains the structural reason (scenario composition) rather than the generic placeholder message.

  Fixes #921.

- 6ad6450: **Add request signing guide (`docs/guides/SIGNING-GUIDE.md`).** End-to-end RFC 9421 walkthrough: key generation, JWKS publication, brand.json discovery, buyer-side signing via `createAgentSignedFetch`, seller-side verification via `requireAuthenticatedOrSigned` + `mcpToolNameResolver`, capability declaration on `request_signing`, key rotation, conformance vectors, and the full `request_signature_*` error code table cross-referenced against `compliance/cache/3.0.0/test-vectors/request-signing/`. README and `BUILD-AN-AGENT.md` cross-link to the new guide; the inline Request Signing snippet in `BUILD-AN-AGENT.md` is updated to match.

  **Widen `mcpToolNameResolver` parameter type.** Previously typed against `IncomingMessage & { rawBody?: string }`, which prevented passing it as `resolveOperation` on `createExpressVerifier` (`ExpressLike` request type). The function only reads `req.rawBody`, so the parameter is now typed as `{ rawBody?: string }` — both call sites typecheck without casts. No runtime change.

## 5.16.0

### Minor Changes

- d88f67b: Added `field_value_or_absent` storyboard check matcher. Passes when the field is absent OR present with a value in `allowed_values` / matching `value`; fails only when present with a disallowed value. Use it for envelope-tolerant assertions (e.g. fresh-path `replayed`) where the spec allows omission but forbids a wrong value. Closes #873.
- 713be7b: Runner emits non-fatal `context_value_rejected` hints when a seller's error
  response lists the values it would have accepted (`available` / `allowed` /
  `accepted_values`) and the rejected request value traces back to a prior-step
  `$context.*` write. Collapses the "SDK bug vs seller bug" triage (issue #870)
  — the hint cites which step wrote the context key and, for `context_outputs`,
  the YAML response path. Pass/fail is unchanged; hints surface on
  `StoryboardStepResult.hints[]`.

  Also aligns context extraction with the rest of the pipeline: convention
  extractors now resolve the effective task name from `$test_kit.*` references
  consistently with validation and enrichment (previously the extractor lookup
  used the pre-resolution token and silently missed in that case).

  New exports on `@adcp/client/testing`:
  - Types: `StoryboardStepHint`, `ContextValueRejectedHint`, `ContextProvenanceEntry`
  - Runtime: `detectContextRejectionHints`, `extractContextWithProvenance`,
    `applyContextOutputsWithProvenance`

- b7a3424: SDK ergonomics fixes addressing feedback on 5.15.0.

  **Root re-exports.** The `Success` / `Error` / `Submitted` arms of every `*Response` discriminated union now export from the `@adcp/client` root (previously only the full `*Response` unions did). `AdcpServer` handler returns no longer need `as any` to narrow off the union. Covered arms include `SyncCreativesSuccess`, `SyncAudiencesSuccess`, `CreateMediaBuy{Success,Error,Submitted}`, `UpdateMediaBuy{Success,Error}`, `BuildCreative{Success,MultiSuccess,Error}`, `ActivateSignal{Success,Error}`, `ProvidePerformanceFeedback{Success,Error}`, `SyncEventSources{Success,Error}`, `LogEvent{Success,Error}`, `SyncAccounts{Success,Error}`, `SyncGovernance{Success,Error}`, `UpdateContentStandards{Success,Error}`, `SyncAudiences{Success,Error}`, and `SyncCreatives{Success,Error,Submitted}`.

  **Idempotency store dual-export.** `createIdempotencyStore`, `memoryBackend`, `pgBackend`, `getIdempotencyMigration`, `IDEMPOTENCY_MIGRATION`, `cleanupExpiredIdempotency`, `hashPayload`, plus `IdempotencyStore` / `IdempotencyStoreConfig` / `IdempotencyBackend` / `IdempotencyCacheEntry` / `IdempotencyCheckResult` / `MemoryBackendOptions` / `PgBackendOptions` now re-export from the `@adcp/client` root (previously only `@adcp/client/server`), matching the dual-export treatment of `createAdcpServer`.

  **Widened handler return types + response-union narrowing.** `DomainHandler<K>` now accepts `Promise<AdcpToolMap[K]['result'] | AdcpToolMap[K]['response'] | McpToolResponse>`. Adapter-style handlers that return `Result<CreateMediaBuyResponse, ...>` where `CreateMediaBuyResponse = Success | Error | Submitted` type-check without `as any`. The dispatcher narrows at runtime:
  - `status === 'submitted' && typeof task_id === 'string'` → Submitted envelope. Framework wraps without the Success-builder defaults (`revision`, `confirmed_at`, `valid_actions`) so async-task shapes round-trip correctly.
  - `errors: Error[]` with no Success-arm fields → Error arm. Framework wraps as `{ isError: true, structuredContent: { errors: [...] } }`, preserving the typed-union shape the spec defines.
  - Otherwise → Success arm, response builder applies as before.

  `AdcpToolMap` entries gained a `response` field (full union) alongside the existing `result` (narrow Success). Handlers and response builders continue to type-check against `result`; callers that want the permissive shape reach for `response`.

  **`extractResult(toolCallResult)` helper.** New lightweight companion to `unwrapProtocolResponse` — prefers `structuredContent`, falls back to JSON-parsing `content[0].text`, returns `undefined` otherwise. Use it on the client side of `mcpClient.callTool(...)` instead of writing the extraction by hand. `unwrapProtocolResponse` remains available when you also want schema validation and extraction-path provenance.

  **`VALIDATION_ERROR.issues` surfaced at top level.** Strict-mode validation errors now expose `adcp_error.issues` (RFC 6901 pointer list) at the top level of the envelope so operators see it on the first render. The same list is still mirrored at `adcp_error.details.issues` for buyers that index into `details` per AdCP spec convention — existing `details.issues` readers continue to work, no migration required. `adcp_error.details` also gains the `{ tool, side }` metadata. `schemaPath` gating is unchanged: stripped when `exposeErrorDetails` is off; request-side and response-side now thread the same `exposeSchemaPath` policy (previously request-side stripped schemaPath even in dev).

  Handlers that return a tool's \*Error arm with spec-violating items (missing `code` or `message`) get a dev-log warning at dispatch — the envelope still ships unchanged, matching the handler's intent, but drift is surfaced in logs.

### Patch Changes

- 156d87b: Triage routine now runs a mandatory pre-PR build+test gate (npm run ci:quick) before expert review, capped at 2 build→fix iterations.

## 5.15.0

### Minor Changes

- 6c1d5d0: `resolveAccount` now receives auth context, `checkGovernance` parses MCP envelope shapes correctly, and the seller skill documents alternative transports.

  **`resolveAccount(ref, ctx)` now receives `{ toolName, authInfo }`.** Adapters that front an upstream platform API (Snap, Meta, TikTok, retail media networks) need the caller's OAuth token to look up the upstream account. Previously `authInfo` was only available inside handlers, forcing resolvers to return a thin stub and re-resolve the platform account on every handler call. Single-arg resolvers (`async (ref) => ...`) remain valid — TypeScript allows a shorter parameter list.

  **`dispatchTestRequest(request, { authInfo })`.** Test harnesses can simulate the `authInfo` that `serve({ authenticate })` would populate, so `resolveAccount` and handler tests cover auth-sensitive paths without spinning up HTTP. Never mount this behind an HTTP route — `extras.authInfo` bypasses `authenticate`.

  **`checkGovernance` now extracts from `structuredContent` or `content[0].text` before falling back to top-level fields.** Fixes a latent bug where the helper returned "missing required fields" when the governance agent responded with a conformant MCP `CallToolResult` envelope rather than spreading the payload at the root. The single-agent JSDoc example no longer references a fabricated `ctx.account.governanceAgentUrl` field — it now shows the real `sync_governance` → `Account.governance_agents[]` flow.

  **Multi-agent governance helper is deferred** pending spec resolution on adcontextprotocol/adcp#3010 — `sync_governance` allows up to 10 governance agents per account but the `check_governance` request and the protocol envelope only thread a single `governance_context` per lifecycle. The SDK will ship an aggregation helper once the spec picks an interpretation.

  **Skill docs.** `skills/build-seller-agent/SKILL.md` gains an Alternative Transports section covering the `createAdcpServer().connect(transport)` pattern — multi-host HTTP on a single process and stdio — for cases where `serve()`'s single-`publicUrl`-per-process model doesn't fit.

### Patch Changes

- a050729: Two regressions from the 5.14 train (closes #862). Both restore documented
  behavior — no new surface, no new policy. **5.14.0 consumers should upgrade
  directly to this release; no code changes required.**

  ### (1) Schema loader: flat-tree domain `$ref` resolution

  `ensureCoreLoaded` pre-registered only `core/` and `enums/` before AJV
  compile. Tool schemas in flat-tree domain directories — `governance/`,
  `brand/`, `property/`, `collection/`, `content-standards/`, `account/`,
  `signals/` — ship alongside sibling building-block fragments they `$ref`,
  and those siblings were never registered. First compile of e.g.
  `governance/sync-plans-request.json` threw `can't resolve reference
/schemas/3.0.0/governance/audience-constraints.json`.

  The loader now walks every directory outside `bundled/` and pre-registers
  non-tool JSON fragments — covering `core/`, `enums/`, `pricing-options/`,
  `error-details/`, `extensions/`, and every flat-tree domain's sibling
  building blocks. Tool request/response files stay lazy-compiled so
  `relaxResponseRoot` still applies to response variants.

  **Blast radius is broader than storyboards.** The same `getValidator` is
  wired into strict-mode request/response validation
  (`AdcpClient({ strict: true })`, `createAdcpServer` default validation,
  `validateOutgoingRequest` / `validateIncomingResponse`, the dispatcher
  middleware, and `TaskExecutor`). Any 5.14.0 server-side adopter running
  strict validation on governance/brand/property/signals/collection/
  content-standards/account tools was silently throwing on first call;
  those paths are fixed by this release too.

  ### (2) `create_media_buy` enricher: fixture-per-package precedence

  The fixture-authoritative refactor in 5.14 (#816) set every task's
  top-level merge to fixture-wins, but the nested-package merge in
  `create_media_buy` kept the prior builder-authoritative precedence.
  Storyboards that authored explicit `product_id` / `pricing_option_id` /
  `bid_price` on `packages[0]` had those values overridden by the first
  discovered product's `pricing_options[0]` — e.g. a seller's
  `pinnacle_news_video_premium_pricing_0` replaced the fixture's
  `cpm_guaranteed`, failing create-buy with `INVALID_REQUEST`.

  Real seller ids in the fixture now win over discovery. Discovery
  still gap-fills when the author omits per-package ids — the
  behavior generic single-package storyboards rely on. Auction/CPM
  `bid_price` synthesis only fires when the fixture didn't author
  one, so bid-floor-boundary tests keep their explicit values.

  **Sentinel placeholders pass through to discovery.** The upstream
  universal compliance storyboards (`adcontextprotocol/adcp`:
  `universal/deterministic-testing.yaml`, `error-compliance.yaml`,
  `idempotency.yaml`, `domains/media-buy/state-machine.yaml`) ship
  `packages[0]` fixtures with `product_id: "test-product"` and
  `pricing_option_id: "test-pricing"` expecting the runner to
  substitute the seller's discovered identifiers. The enricher
  recognizes those two literals as sentinels and defers to discovery
  when either appears. Real seller ids (`cpm_guaranteed`,
  `sports_display_auction`, any non-sentinel string) keep winning.

  If your storyboard wants placeholder-then-discovery semantics for a
  new field, author `$context.<key>` substitution rather than a magic
  literal — the intent is explicit at the fixture level and the
  sentinel allowlist stays small.

  ### Out of scope

  Issue #862 also flagged `activate_signal` as "same pattern". The
  enricher is not `FIXTURE_AWARE` — the outer merge lets the storyboard's
  `$context.first_signal_pricing_option_id` overlay the enricher's pick,
  and both resolve from the same `signals[0].pricing_options[0]`. The
  mismatch reporters saw (`po_prism_abandoner_cpm` sent,
  `po_prism_cart_cpm` accepted) traces to seller catalog inconsistency
  between `get_signals` and `activate_signal`, not SDK synthesis.
  Follow-up in #870: have the storyboard runner emit a hint when a
  response's `available:` list excludes a context-derived value, so the
  reporter-facing symptom stops looking identical to an SDK bug.

- d856e1e: Triage routine now runs a mandatory pre-PR expert review on the diff (code-reviewer + domain expert in parallel) before opening the PR, capped at 2 review→fix iterations. Sign-offs recorded in the PR body.

## 5.14.0

### Minor Changes

- 36b920c: Dogfooding follow-ups from reference training agent (adcp#2889) plus
  four fixes surfaced while running the `media_buy` +
  `sales-non-guaranteed` compliance bundle against a fresh
  Spotify-shaped seller built on the new patterns. Nine bundled fixes
  across the server + testing surfaces:
  - **`registerTestController` auto-emits the `compliance_testing`
    capability block on `AdcpServer`** — per AdCP 3.0, comply_test_controller
    support is declared via `capabilities.compliance_testing.scenarios`,
    NOT as a value in `supported_protocols`. `registerTestController` now
    writes that block onto the server's capabilities object (new
    `ADCP_CAPABILITIES` internal symbol) using `factory.scenarios` or
    inferring from plain-store method presence. `parseCapabilitiesResponse`
    additionally normalizes the client-side `AdcpCapabilities.protocols`
    list from the block when declared by a peer. The misleading
    augmenter log that told sellers to "declare compliance_testing" was
    rewritten to point at the correct declaration (the capability block,
    not `supported_protocols`).
  - **`TaskExecutor` preserves structured tool-error payloads on failed
    tasks** — previously the FAILED branch dropped `result.data` unless
    `extractAdcpErrorInfo` recognized an `adcp_error` or `errors`
    envelope. Tool-level error shapes like `comply_test_controller`'s
    `{ success: false, error: 'UNKNOWN_SCENARIO', error_detail }` don't
    match that extractor, so storyboard validators checking
    `success: false` / `error_code` on controller error paths saw
    `undefined`. The branch now retains any non-empty structured
    payload so validators can read tool-specific envelopes the SDK
    doesn't model explicitly.
  - **`createIdempotencyStore()` throws a helpful error when called
    without `{ backend }`** — the zero-arg path previously crashed with
    `Cannot read properties of undefined (reading 'ttlSeconds')`. The
    error now names `memoryBackend()` and `pgBackend(pool)` as the two
    options.
  - **`registerTestController` echoes request `context` into the response
    envelope** — `createAdcpServer` auto-echoes `context` for domain tool
    handlers, but `registerTestController` wires `comply_test_controller`
    on the raw MCP surface and bypassed that pipeline. Every
    `controller_validation` + `deterministic_*` storyboard step fails
    `field_present: context` without this echo. The wrapper now attaches
    `input.context` onto the response when the handler didn't set one
    itself (handler-supplied context still wins, matching the
    domain-handler rule). Surfaced by a mini-seller migration exercise
    against the full `media_buy` + `sales-non-guaranteed` storyboard
    bundle.
  - **`bridgeFromSessionStore({ loadSession, selectSeededProducts, productDefaults? })`**
    (adcp-client#824) — new helper for sellers whose seed store is
    session-scoped (one Map per tenant / brand.domain / account_id, loaded
    per request). The existing `bridgeFromTestControllerStore` takes a
    single Map at construction time and doesn't compose with per-request
    session loading; the new helper takes an options object with two
    callbacks. Both `loadSession` and `selectSeededProducts` may be async,
    so lazy-loaded seed collections don't force eager hydration inside
    the loader. `loadSession` rejections propagate to the dispatcher —
    silent seed loss under DB failure would be worse than a loud error.
    `BridgeFromSessionStoreOptions<TSession>` is exported.
  - **`mcpAcceptHeaderMiddleware` now rewrites `req.rawHeaders`**
    (adcp-client#825) — the MCP SDK's `StreamableHTTPServerTransport`
    rebuilds its Fetch `Headers` from `req.rawHeaders` via
    `@hono/node-server`, ignoring `req.headers`. Patching only the parsed
    map was a silent no-op for the transport the middleware's name
    implies. Both surfaces now move in lockstep (case-insensitive on the
    rawHeaders name, all duplicate entries rewritten, no phantom entry
    added when `rawHeaders` lacks Accept — see JSDoc for the proxy-
    divergence tradeoff).
  - **`adcpError()` + dispatcher consult a per-code inside-`adcp_error` allowlist**
    (adcp-client#826) — new `ADCP_ERROR_FIELD_ALLOWLIST` map in
    `@adcp/client/server` (parallel to the existing
    `ERROR_ENVELOPE_FIELD_ALLOWLIST` for siblings). The builder filters
    its output against the allowlist for the given code. `IDEMPOTENCY_CONFLICT`
    is the canonical strict case: `recovery`, `retry_after`, `field`,
    `suggestion`, and `details` all drop from the wire shape so the
    envelope can't become a stolen-key read oracle. The dispatcher
    (`create-adcp-server.ts`) re-applies the same allowlist as
    defence-in-depth for handlers that hand-roll an envelope outside
    `adcpError()`. Codes without an entry pass through unchanged.
    Legacy `CONFLICT_ADCP_ERROR_ALLOWLIST` stays exported as an alias for
    the `IDEMPOTENCY_CONFLICT` entry. The allowlist is scoped to standard
    error codes on purpose — vendor codes need `recovery` per the spec's
    graceful-degradation contract, so don't extend this pattern there.
  - **Breaking (narrow surface): remove `createDefaultTestControllerStore` /
    `createDefaultSession` / `DefaultSessionShape`** (adcp-client#827) — the
    "collapse 300 lines to 10" default factory shipped in 5.11.0 only held
    for sellers whose session IS `DefaultSessionShape` (a bag of generic
    Maps). Every real seller has typed domain state (`MediaBuyState` with
    packages, history, revision; `CreativeState` with format_id, manifest,
    pricing_option_id; `GovernancePlanState` with budget allocations,
    flight, policy categories). The default handlers wrote into a
    **parallel bag of seed Maps those sellers' production tools don't
    read** — so `seed_media_buy` populated `session.seededMediaBuys` while
    `get_media_buy` read from `session.mediaBuys`, and subsequent storyboard
    steps silently saw empty state. Sellers either overrode every handler
    (net savings: zero) or silently drifted. The helper had been on npm
    for ~24 hours with zero documented adopters.

    The replacement is documentation, not another helper. `@adcp/client/testing`
    now re-exports the full integration surface in one place —
    `registerTestController`, `TestControllerStore`,
    `TestControllerStoreFactory`, `enforceMapCap`, `createSeedFixtureCache`,
    `SESSION_ENTRY_CAP`, `TestControllerError`, `CONTROLLER_SCENARIOS`,
    `SEED_SCENARIOS` — and `examples/seller-test-controller.ts` shows the
    real pattern (typed `MediaBuyState` + `CreativeState`, session-scoped
    factory, seed writes into the same records production readers use,
    ~200 LOC). Sellers with simpler domains should keep using
    `createComplyController` (adapter surface, unchanged).

  ## Type change
  - `AdcpErrorPayload.recovery` is now optional (previously required).
    Reflects the filtered wire shape — consumers that destructure
    `recovery` off a parsed conflict response MUST tolerate `undefined`.
    If you hit a TS strict-null complaint, use `payload.recovery ?? 'terminal'`
    or re-derive from `STANDARD_ERROR_CODES[payload.code]?.recovery`.

  ## Who is affected / upgrade path

  **No action required** for:
  - Callers of `adcpError()` — the builder now quietly filters disallowed
    fields per code; the wire shape is what the spec expects.
  - Callers of `bridgeFromTestControllerStore` — unchanged.
  - Callers reading `CONFLICT_ADCP_ERROR_ALLOWLIST` — it still exports as
    an alias for `ADCP_ERROR_FIELD_ALLOWLIST.IDEMPOTENCY_CONFLICT`.

  **Action required** for:
  - Handlers that emit `recovery` / `retry_after` / `details` on an
    `IDEMPOTENCY_CONFLICT` envelope via a hand-rolled response (not
    through `adcpError()`): the dispatcher now strips those fields before
    they reach the wire. Either switch to `adcpError('IDEMPOTENCY_CONFLICT', {...})`
    (recommended) or drop the disallowed fields from your envelope.
  - TS consumers that destructure `AdcpErrorPayload.recovery`
    non-optionally: guard with `??` or re-derive from the code.
  - Callers of `createDefaultTestControllerStore` / `createDefaultSession`
    or importers of the `DefaultSessionShape` / `DefaultLoadSessionInput` /
    `CreateDefaultTestControllerStoreOptions` / `DefaultTestControllerStoreResult`
    / `SeedFixture` / `BudgetSpendRecord` / `DeliverySimulationRecord` /
    `SessionTerminalStatus` types from `@adcp/client/testing`: these are
    removed. Replace with a `TestControllerStore` / `TestControllerStoreFactory`
    implementation against your own domain types — see
    `examples/seller-test-controller.ts` for the pattern. The scope
    primitives you need (`enforceMapCap`, `createSeedFixtureCache`,
    `SESSION_ENTRY_CAP`, `TestControllerError`) are now reachable from
    `@adcp/client/testing` alongside `registerTestController`.
  - Downstream tests that snapshot the exact `get_adcp_capabilities`
    response JSON for a server with `registerTestController` wired:
    the response now includes a top-level `compliance_testing.scenarios`
    block per AdCP 3.0. This is the spec-correct wire shape (previously
    missing), but snapshot tests pinning the old omitted-block shape
    will need regeneration. Mutating-tool responses on the fresh-exec
    path also now include `replayed: false` explicitly (was omitted) —
    same implication for pinned-snapshot tests.

- 6061973: Creative-agent ergonomics follow-ups from scope3 agentic-adapters#100 review (#844 follow-up):

  **`displayRender` / `parameterizedRender` factories for `Format.renders[]`** (closes #846)

  The `Format.renders[]` item schema's `oneOf` forces each entry to satisfy exactly one branch — `dimensions` (width + height) OR `parameters_from_format_id: true`. A render with only `{ role }` or `{ role, duration_seconds }` fails strict validation. Two new named exports from `@adcp/client`:

  ```ts
  import { displayRender, parameterizedRender } from '@adcp/client';

  renders: [
    displayRender({ role: 'primary', dimensions: { width: 300, height: 250 } }), // display/video
    parameterizedRender({ role: 'companion' }), // audio / template
  ];
  ```

  Also **corrects a spec-non-conformant audio example that shipped in #844** — audio `renders[]` must use `parameterizedRender` and encode duration/codec in `format_id.parameters` via `accepts_parameters`, not in the render entry.

  **`--strict-flags` on `adcp storyboard run`** (closes #847)

  Removed-flag warnings (added in #844) stay advisory by default. `--strict-flags` upgrades them to a hard exit 2 so CI pipelines can catch stale scripts as build-breakers:

  ```bash
  adcp storyboard run my-agent --platform-type creative_transformer --strict-flags
  # DEPRECATED: --platform-type was removed in 5.1.0 ...
  # ERROR: --strict-flags was set and 1 removed flag(s) were passed: --platform-type.
  # exit 2
  ```

  **`detectShapeDriftHint` on `build_creative` responses** (closes #845)

  When a `build_creative` response has platform-native fields (`tag_url`, `creative_id`, `media_type`, `tag_type`) at the top level instead of `{ creative_manifest }`, the storyboard runner now attaches an actionable fix-recipe to `ValidationResult.warning` — naming `buildCreativeResponse` / `buildCreativeMultiResponse` from `@adcp/client/server` and pointing at the `creative-template` skill section. Fires on both Zod-fail (common — platform-native shape) and Zod-pass-AJV-fail paths. No change to pass/fail logic — `warning` is advisory.

- e2f9ea9: Storyboard runner: fixture-authoritative request construction (closes #820).

  The runner's request-construction priority is inverted. `sample_request`
  is now the authoritative base payload — when authored, every top-level
  key the author wrote reaches the wire verbatim. The per-task enricher
  (formerly "request builder") runs alongside, filling fields the fixture
  left unset — typically discovery-derived identifiers, envelope fields,
  or context-substituted placeholders.

  The previous behavior silently fabricated payloads and discarded author
  fixtures on ~20 tasks whose enrichers didn't opt into a fixture-honoring
  early return. That false-green failure mode produced five consecutive
  fallback-shape bugs (#780 / #792 / #793 / #802 / #805) before anyone
  noticed the architecture was backward.

  ### New contract
  - **`sample_request` (authored)** — base payload. Context placeholders
    (`$context.*`, `$generate:uuid_v4`, `{{runner.*}}`) resolve as before.
  - **Enricher (per-task)** — produces fields that gap-fill the fixture.
    Fixture wins every top-level conflict.
  - **Fixture-aware enrichers** (`create_media_buy`, `comply_test_controller`) —
    declared in `FIXTURE_AWARE_ENRICHERS` because they splice
    discovery-derived fields INTO nested fixture structures (array-level
    merges the generic overlay can't express). The runner passes their
    output verbatim; envelope fields from the fixture (`context`, `ext`,
    `push_notification_config`, `idempotency_key`) still flow through.

  ### Load-time hard-fail

  Mutating tasks (per `MUTATING_TASKS`) now throw at storyboard load when
  `sample_request` is absent and `expect_error !== true`. The runner no
  longer fabricates write payloads. Error messages point at the task,
  step id, storyboard id, and suggest the concrete author action. Synthesized
  phases (request-signing, controller seeding) are unaffected — their
  runtime-generated steps don't pass through `parseStoryboard`.

  ### Rename (compat preserved)
  - `buildRequest` → `enrichRequest` (old name kept as deprecated alias)
  - `hasRequestBuilder` → `hasRequestEnricher` (old name kept)
  - `REQUEST_BUILDERS` → `REQUEST_ENRICHERS` (internal)

  External consumers pinned to the old names continue to work for one
  release. Migrate to the new names at your own pace.

  ### Observable-behavior changes
  - Mutating storyboards that omitted `sample_request` fail loudly at load
    instead of silently shipping fabricated payloads. This is the
    intentional correctness improvement.
  - **Fixture `account` now wins** on four tasks whose pre-inversion
    builders injected `context.account` OVER the fixture's authored
    `account` via the hybrid `{ ...sample_request, account: context.account }`
    pattern: `sync_catalogs`, `sync_creatives`, `report_usage`,
    `sync_audiences`. Storyboards that relied on the runner silently
    substituting `context.account` over their authored value will now send
    the authored value. Audit these fixtures if your tests depend on a
    specific account on these tasks.
  - Under fixture-wins merge, options-derived fields (e.g.
    `options.brief` → `signal_spec`) now coexist with authored fields
    (`sample_request.signal_ids`) instead of replacing them. A storyboard
    authoring signal_ids and being invoked with `--brief X` now sends
    both; agents receive a richer query. Schema-valid under
    `anyOf: [signal_spec | signal_ids]`.
  - Enricher-derived identity fields (e.g. `get_rights.brand_id` from
    `resolveBrand(options)`) gap-fill when fixture omits them. A
    storyboard that specifically needs an identity field absent must
    author it explicitly or opt out via `expect_error: true`.

  Strict-vs-lenient run reporting (the fourth proposal in #820) is
  deferred to a separate issue — it's a reporting-subsystem concern
  orthogonal to the request-construction flow.

- 122aaf5: Add response helpers and shape-drift detection for governance list tools (closes #854):

  **New response helpers** in `@adcp/client/server`:
  - `listPropertyListsResponse(data)` — wraps `{ lists: PropertyList[] }`
  - `listCollectionListsResponse(data)` — wraps `{ lists: CollectionList[] }`
  - `listContentStandardsResponse(data)` — handles the union type (success `{ standards }` / error `{ errors }`)

  All three follow the existing list-response pattern (`listCreativesResponse` / `listAccountsResponse`): default summary names the count and singular/plural handling, pass-through of the typed payload into `structuredContent`.

  **Shape-drift detection** — `list_property_lists`, `list_collection_lists`, and `list_content_standards` now join the `LIST_WRAPPER_TOOLS` table in the storyboard runner's `detectShapeDriftHint`. A handler that returns a bare array at the top level gets a pointed hint naming the correct wrapper key and the new helper.

  Brings the shape-drift detector's coverage of list tools to nine: `list_creatives`, `list_creative_formats`, `list_accounts`, `get_products`, `get_media_buys`, `get_signals`, and now the three governance tools. 34 shape-drift tests + 3 new response-helper tests covering count-formatting and the error-branch split on content standards.

- 42debb0: Catch stale CLI installs before users spend hours debugging phantom behavior.
  - **Docs:** pin `@latest` in every documented `npx @adcp/client` invocation. Unpinned `npx` reuses whatever version is cached in `~/.npm/_npx/` — users can have six different versions co-existing and not know which one runs. `@latest` forces npx to re-resolve against the registry each invocation.
  - **CLI:** add a startup staleness check. On every run, the CLI hits `registry.npmjs.org/@adcp/client/latest` (cached for 24h at `~/.adcp/version-check.json`, 800ms timeout, fire-and-forget) and prints a one-time stderr warning if the running version is behind the published latest. Catches every stale-install path, not just the npx copy-paste one: global installs, pinned `package.json`, corporate forks, `pnpm dlx` caches.
  - **Silenced in:** CI (`CI=true`), non-TTY stderr, `--json` mode, and `ADCP_SKIP_VERSION_CHECK=1`.

- a2ec3c0: Add `resolvePerStoryboard` callback to `runAgainstLocalAgent`

  `runAgainstLocalAgent` now accepts a `resolvePerStoryboard(storyboard, defaultAgentUrl)` callback that returns optional per-storyboard overrides. Callers can redirect a single storyboard to a different URL (e.g. route `signed_requests` at `/mcp-strict` while the rest stay on `/mcp`) and shallow-merge `StoryboardRunOptions` fields like `test_kit`, `brand`, `contracts`, or `auth` per storyboard without giving up the helper's single-serve / single-seed lifecycle. The override shape is flat — `{ agentUrl?, ...StoryboardRunOptions }` — and `webhook_receiver` stays helper-owned (typed out of the shape; re-applied after the merge). The callback may return a `Promise` for async work such as loading a test-kit YAML or minting a scoped token. Returning `undefined` keeps the run-level defaults, so existing callers are unaffected. Resolves #810.

- 94b1ebd: Storyboard steps can now opt out of a default invariant for that step
  only. New `StoryboardStep.invariants.disable: string[]` mirrors the
  existing storyboard-level `invariants.disable` but scoped to one step:
  the runner skips calling the named invariants' `onStep` for that step
  and leaves every other invariant (and every other step) untouched.

  ```yaml
  - id: check_plan_first_pass
    task: check_governance
    invariants:
      disable: [governance.denial_blocks_mutation]
  ```

  Motivating case: storyboards that exercise buyer recovery from a
  `check_governance` 200 `status: denied`. The `expect_error: true`
  escape introduced in 5.12.1 only covers wire-error denials
  (`adcp_error` responses). A 200 with `status: denied` is not a wire
  error, so the flag was semantically inapplicable — the invariant would
  anchor and flag every subsequent mutation in the run as a silent
  bypass. `invariants.disable` covers both shapes uniformly.

  Validation is fail-fast at runner start (matches the storyboard-level
  precedent):
  - unknown assertion id in step `invariants.disable` throws;
  - id already disabled storyboard-wide throws (dead code — remove one);
  - unknown top-level key (e.g. `disabled`) throws.

  The `governance.denial_blocks_mutation` failure message now names this
  field and renders the exact YAML snippet to paste, for every anchor
  shape. The previous message branched on anchor kind and suppressed the
  hint for 200-status denials — that suppression pointed authors at
  nothing. Unified under the one escape that works for both.

  `expect_error: true`'s implicit skip is unchanged. It remains the
  zero-ceremony path for expected-error contracts; `invariants.disable`
  is the explicit surface for everything else.

  Closes #815.

- c61ac15: Storyboard runner: strict/lenient response-schema reporting (closes the
  final proposal from #820).

  `response_schema` validations now run the strict AJV path alongside the
  existing lenient Zod check and record the strict verdict on each
  `ValidationResult.strict` (new optional field). The step's pass/fail is
  unchanged — it remains Zod-driven so existing tests and downstream
  reporting stay backward-compatible. The strict verdict is additive
  signal.

  ### Per-run summary

  Every `StoryboardResult` now carries a `strict_validation_summary`:

  ```ts
  {
    observable: boolean; // false = no strict-eligible checks ran
    checked: number; // response_schema checks with AJV coverage
    passed: number; // of checked, how many cleared strict AJV
    failed: number; // checked - passed
    strict_only_failures: number; // lenient-pass ∧ strict-fail — the #820 signal
    lenient_also_failed: number; // failed - strict_only_failures
  }
  ```

  `strict_only_failures` is the actionable number. Responses that cleared
  Zod passthrough but strict AJV rejected — typically `format: uri` or
  pattern violations Zod's generated `z.string()` doesn't enforce. A green
  lenient run with `strict_only_failures > 0` tells the developer their
  agent isn't production-ready for strict dispatchers.

  `observable: false` with zeroed counters signals "run had no
  strict-eligible checks" (distinct from strict-clean). Dashboards and
  JUnit formatters MUST check `observable` before rendering counts.

  ### New helpers exported from `@adcp/client/testing`
  - `summarizeStrictValidation(phases)` — compute the summary over a
    filtered subset of phases (e.g. render per-phase rollups in a
    dashboard without re-running validation).
  - `listStrictOnlyFailures(phases)` — flat drill-down list of every
    `strict_only_failure` with `{phase_id, step_id, task, variant,
issues}` for triage. Direct path from `strict_only_failures: 7` to
    the seven offending responses without walking four levels of nested
    arrays.

  ### AJV coverage extended to flat-tree domains

  The AJV schema loader now indexes `governance/`, `brand/`,
  `content-standards/`, `account/`, `property/`, and `collection/`
  alongside `bundled/`. This closes a coverage gap where
  `strict_validation_summary` systematically under-reported for mutating
  tasks whose schemas ship outside the bundled tree —
  `check_governance`, `acquire_rights`, `creative_approval`,
  `sync_governance`, `sync_plans`, CRUD on property_list / collection_list,
  etc. Previously those validations returned `strict: undefined` and
  didn't count toward `checked`; now they grade strict-eligible, so
  `format: uri` violations on `caller` and `idempotency_key` pattern
  mismatches (protocol-wide requirements per AdCP 3.0 GA) surface in the
  strictness delta where they belong.

  ### CLI summary line

  `adcp storyboard run` now prints a single human-readable line under the
  lenient pass/fail tally when `observable: true`:

  ```
  ✅ 32 passed, 0 failed, 3 skipped (1240ms)
  ⚠️  strict: 11/18 passed (7 lenient-only — strict dispatcher would reject)
  ```

  Silent when the run had no strict-eligible checks. The multi-storyboard
  local-agent mode aggregates across results before printing.

  ### `ValidationResult.warning` on strict-only failures

  When Zod passes and AJV rejects, the step stays `passed: true` but a new
  `warning` field carries the top AJV issue:

  ```
  "warning": "strict JSON-schema rejected /caller: must match format \"uri\" (+2 more AJV issues)"
  ```

  This closes the loop for LLM-driven self-correction and CI graphs that
  scan `error`/`warning` fields — they can act on the strict signal
  without the runner flipping step pass/fail and breaking existing tests.

  ### Async variant fallback signal

  When the agent's response advertises an async variant (`status:
submitted` / `working` / `input-required`) but the tool schema doesn't
  ship a variant schema, validation falls back to the sync response
  schema. The fallback is now surfaced:
  - `StrictValidationVerdict.variant_fallback_applied: true`
  - `StrictValidationVerdict.requested_variant: 'working'`
  - `ValidationResult.warning` names the gap

  A conformance signal that was previously invisible (the tool accepts
  sync-shaped validation even though the agent sent an async shape) now
  tells the author: "this tool doesn't schema the variant your agent is
  using." AJV acceptance of the sync fallback doesn't mask the signal.

  ### Out of scope — tracked follow-ups (#832)
  - Per-field envelope validation (`replayed`, `operation_id`, `context`,
    `ext` value shapes) as a separate check type — needs a spec
    contribution for `core/envelope.json`.
  - Opt-in `--strict` CLI flag that gates CI on
    `strict_only_failures == 0` — waiting for real-world delta telemetry
    before calibrating the gating policy.

### Patch Changes

- e2f9ea9: Fix storyboard request-builder fallback shapes: every fallback now
  satisfies the upstream JSON schema it pairs with, unblocking strict-mode
  agents that reject non-conforming payloads at the MCP boundary.

  **Builder fixes** (all only take effect when `step.sample_request` is
  absent — authored fixtures are unaffected):
  - `check_governance` — `caller` now emits `https://${brand.domain}`
    instead of a bare domain. Schema declares `caller: format: uri`. (#805)
  - `build_creative`, `preview_creative`, `sync_creatives` — the
    `format_id` placeholder for a missing format now carries a
    URI-formatted `agent_url` (`https://unknown.example.com/`) instead of
    the string `"unknown"`. Schema (`core/format-id.json`) declares
    `agent_url: format: uri`.
  - `update_media_buy` — fallback now injects
    `account: context.account ?? resolveAccount(options)`; schema lists
    `account` as required. Matches the pattern peer builders
    (`sync_creatives`, `sync_catalogs`, `report_usage`) already use.
  - `get_signals` — when neither `options.brief` nor
    `sample_request.signal_ids` is present, fallback now emits
    `{ signal_spec: 'E2E fallback signal discovery' }` instead of `{}`.
    Schema `anyOf: [signal_spec | signal_ids]`.
  - `create_content_standards` — fallback now emits a minimal inline
    bespoke policy (`policies: [{policy_id, enforcement: 'must', policy}]`)
    alongside `scope`. Schema `anyOf: [policies | registry_policy_ids]`.

  **New test**: `test/lib/request-builder-jsonschema-roundtrip.test.js` —
  AJV round-trip invariant that validates every builder fallback against
  the upstream JSON schema. Complements the existing Zod round-trip test
  (`request-builder-schema-roundtrip.test.js`), which does not enforce
  `format` keywords or strict `additionalProperties`. `KNOWN_NONCONFORMING`
  allowlist is empty; self-pruning guard tests fire if a new fallback
  regresses or an allowlisted task starts passing.

  **Observable-behavior notes**:
  - Callers importing `buildRequest` who asserted on `get_signals` returning
    `{}` will need to update — it now returns `{ signal_spec }`.
  - `update_media_buy` fallback now carries an `account`. Storyboards
    relying on a seller resolving account from `media_buy_id` alone via the
    fallback will now send a canonical account; if the seller is strict
    about account consistency across lifecycle, this is the correct signal.
    No shipping first-party storyboards hit this path (all author
    `sample_request.account`).

  Closes #805.

- 9e588bf: cli: warn on removed flags instead of silently ignoring

  `--platform-type` was removed from the SDK in 5.1 (`comply()` throws when it's passed programmatically), but the CLI was still capturing and silently dropping the flag. Third-party CI scripts that pass it today believe they're filtering agent selection when they aren't.

  `adcp storyboard run` (and its `adcp comply` deprecated alias) now emits a stderr warning naming the flag, the version it was removed in, and the migration path:

  ```
  [warn] --platform-type was removed in 5.1.0 and is being ignored.
  Agent selection is now driven by get_adcp_capabilities (supported_protocols + specialisms).
  Pass --storyboards <bundle-or-id> to target a specific bundle.
  ```

  Non-breaking — execution continues. Warnings are suppressed under `--json` to keep stdout as pure JSON. Detection covers both space-separated (`--platform-type value`) and equals (`--platform-type=value`) forms.

  The `REMOVED_FLAGS` map in `bin/adcp.js` is a single location to extend as we deprecate additional flags.

- 9e588bf: docs(creative-agent): louder build_creative response-shape callouts, add audio creative-template example

  Makes discoverability of existing SDK surface better for creative agents:
  - `docs/llms.txt` — new "Watch out:" blocks on `build_creative`, `preview_creative`, and `list_creative_formats` that point at `buildCreativeResponse`/`buildCreativeMultiResponse`/typed asset factories and flag the audio-formats `renders` gotcha. Driven by a data map in `scripts/generate-agent-docs.ts`.
  - `skills/build-creative-agent/SKILL.md` — cross-cutting pitfalls now mention `audioAsset` and spell out that platform-native top-level fields (`tag_url`, `creative_id`, `media_type`) are invalid responses. Adds an Audio subsection under `creative-template` covering format declaration (`type: 'audio'`, `renders: [{ role, duration_seconds }]`), async render pipelines, and a handler example using `buildCreativeResponse` + `audioAsset`.

  No library code changes — the factories and response helpers already shipped in prior releases.

- 48096a7: fix(testing): honor `step.sample_request` on add-shaped payloads in storyboard `sync_audiences` builder

  The storyboard request builder for `sync_audiences` only delegated to `step.sample_request` for delete or discovery shapes. Add-shaped payloads — where a storyboard authors `audience_id` with `add: [...]` identifiers — fell through to the generated fallback, which overwrote the authored id with `test-audience-${Date.now()}`. Downstream steps that referenced the authored id (e.g., `delete_audience` in the `audience_sync` specialism, or `$context.audience_id` substitutions) then hit `AUDIENCE_NOT_FOUND` because sync had registered a different id.

  The builder now delegates to `step.sample_request` whenever it's present (matching `sync_event_sources`, `sync_catalogs`, `sync_creatives`, and peers), falling back to the generated payload only when no `sample_request` is authored.

- d3bd569: Two independent envelope-layer fixes for mutating responses:

  ### 1. Omit `replayed` on fresh execution (align with `protocol-envelope.json`)

  The SDK used to stamp `replayed: false` on every fresh-path mutating response. The envelope spec explicitly permits the field to be "omitted when the request was executed fresh" — absence now signals fresh execution, presence signals replay. Replay responses still carry `replayed: true`.

  ### 2. Mirror the replay marker into L2 `content[0].text` (A2A/REST parity)

  The replay-path stamp previously only touched MCP `structuredContent` (L3). A2A and REST transports that consume `content[0].text` (L2) never saw `replayed: true` on replay — replay detection was silently broken on those transports. `stampReplayed` now updates both layers, matching the lockstep pattern used by `injectContextIntoResponse` and `sanitizeAdcpErrorEnvelope`. This is orthogonal to the envelope-semantics change and a bona fide bug fix.

  ### What you'll see
  - **Seller handlers (`createAdcpServer`)**: fresh mutating responses no longer carry `replayed: false`. Snapshot / contract tests asserting `replayed === false` on fresh need to be updated to `replayed !== true` (or `replayed === undefined`).
  - **A2A / REST buyers**: replay responses now carry `replayed: true` on the text body where they previously didn't. Replay detection on non-MCP transports starts working.
  - **Observability / log pipelines**: dashboards that count fresh executions via `replayed === false` go silent on this version. Switch to `replayed !== true` (fresh = absent or false) or key off a different signal (e.g. tool handler invocation count).
  - **Buyer-side readers (`@adcp/client` SDK)**: no change. `ProtocolResponseParser.getReplayed` already treats absence and `false` identically, and the envelope schema's `"default": false` means schema-aware parsers materialize the same value either way.
  - **Public `wrapEnvelope` helper**: unchanged. Sellers calling `wrapEnvelope({replayed: false})` directly still round-trip the explicit marker. The asymmetry between the framework path (omits on fresh) and wrapEnvelope callers (honors explicit `false`) is intentional and documented on the option.

  ### Upstream coordination

  Filed [`adcp-client#857`](https://github.com/adcontextprotocol/adcp-client/issues/857) against the `compliance/cache/latest/universal/idempotency.yaml` storyboard: its `field_value allowed_values: [false]` assertion on the fresh-path step conflicts with its own prose (`"Initial execution sets replayed: false (or omits the field)"`) — a literal-match bug where `any_of: [field_absent, field_value: false]` was intended. Until the storyboard fix lands, the `replay_same_payload` phase will fail on the fresh-path step for sellers on this SDK version; all other phases (`key_reuse_conflict`, `fresh_key_new_resource`, webhook dedup) still pass. Per `CLAUDE.md`'s storyboard-failure triage rule, the storyboard is the bug here — the envelope spec unambiguously permits omission.

  ### Internal
  - `create-adcp-server.ts`: `injectReplayed(response, value)` renamed to `stampReplayed(response)`; fresh-path call site dropped; replay-path stamp mirrors into both L2 text and L3 structuredContent.
  - `wrap-envelope.ts`, `envelope-allowlist.ts`, `validation/schema-loader.ts`: documentation only. `wrap-envelope.ts` picks up a note that the framework/helper asymmetry on fresh `replayed` is intentional.
  - `test/server-idempotency.test.js`: fresh-path assertion relaxed from `=== false` to `!== true`.

- 0cc6f98: docs(seller-skill): define the baseline explicitly

  Follow-up to #843. The seller-agent skill referenced "the baseline" 25+ times without enumerating it. A reader (or a coding agent like Claude) hitting the skill could not find an authoritative list of tools every `sales-*` agent must implement, which is the gap that let an adapter update remove `get_products` and `create_media_buy` on the read that `sales-social` is "walled-garden-only."

  Adds a new top-level "The baseline: what every sales-\* agent MUST implement" section to `skills/build-seller-agent/SKILL.md` with the full 11-tool table (`get_adcp_capabilities`, `sync_accounts`, `list_accounts`, `get_products`, `list_creative_formats`, `create_media_buy`, `update_media_buy`, `get_media_buys`, `sync_creatives`, `list_creatives`, `get_media_buy_delivery`), the `createAdcpServer` handler group each belongs to, a minimum handler skeleton, and an explicit "if a specialism's storyboard doesn't exercise a baseline tool, the tool is not optional" note.

  Also anchors the section and wires cross-refs from the "Specialisms are additive" intro paragraph and the `sales-social` "Baseline tools still apply" block so readers have a single source of truth for the baseline surface.

  No code changes; skill is shipped under `files[]` so a patch bump surfaces the doc update to downstream consumers who ship CLAUDE.md-linked skill packs.

- 42e43d4: Extend `detectShapeDriftHint` in the storyboard runner to cover `sync_creatives` and `preview_creative` alongside the existing `build_creative` detection (closes #849).

  Both tools share the same drift pattern as `build_creative`: a handler returns a single inner shape at the top level instead of wrapping it in the tool's required array/discriminator envelope. A bare schema error ("must have required property X") doesn't tell the developer they've inverted the response shape — this hint does.
  - **`sync_creatives`** — top-level `creative_id` / `platform_id` / `action` without a `creatives` array (or `errors` / `task_id` for the other two valid branches) → hint names `syncCreativesResponse()` from `@adcp/client/server`.
  - **`preview_creative`** — top-level `preview_url` / `preview_html` without the `previews[].renders[]` nesting and `response_type` discriminator → hint names `previewCreativeResponse()`. `interactive_url` alone doesn't trigger (it's a legal top-level sibling on the single-variant branch).

  Scoped per-tool so cross-tool field names can't bleed across branches (e.g. `build_creative`-specific `tag_url` doesn't trip the `preview_creative` branch).

  11 new tests covering positive detection, each valid branch that must stay silent, and cross-tool scoping.

- 908786e: Extend `detectShapeDriftHint` in the storyboard runner to cover list-shaped tools (closes #852):
  - `list_creatives` — handler returns bare `[{...}]` instead of `{ creatives, query_summary, pagination }`
  - `list_creative_formats` — bare array instead of `{ formats: [...] }`
  - `list_accounts` — bare array instead of `{ accounts: [...] }`
  - `get_products` — bare array instead of `{ products: [...] }`

  The detector now accepts `unknown` rather than `Record<string, unknown>` so it can recognize bare-array responses at the root — a common drift class where AJV's error ("expected object, got array") doesn't name the required wrapper key. Each known list tool gets a pointed hint naming the wrapper and the response helper (`listCreativesResponse`, `listCreativeFormatsResponse`, `listAccountsResponse`, `productsResponse`) from `@adcp/client/server`.

  Bare arrays for unknown task names pass through silently — the detector only fires on registered list tools to avoid false positives on APIs that legitimately return top-level arrays.

  8 new tests covering each tool, the wrapper-present negative case, unknown-task pass-through, empty-array handling, and null/primitive defensive cases.

## 5.13.0

### Minor Changes

- be0d60b: Envelope hygiene: colocate the two error-envelope allowlists into a
  single source of truth, and flip `wrapEnvelope` to a fail-closed default
  for unregistered error codes.

  Security-review follow-ups from #788 (M3 + M4):
  - **#800 (M4)**: `ERROR_ENVELOPE_FIELD_ALLOWLIST` (sibling-keys allowlist
    used by `wrapEnvelope`) and the former `CONFLICT_ALLOWED_ENVELOPE_KEYS`
    (inside-adcp_error allowlist used by the
    `idempotency.conflict_no_payload_leak` invariant) now live side-by-side
    in the new `src/lib/server/envelope-allowlist.ts` module. The latter
    is renamed to `CONFLICT_ADCP_ERROR_ALLOWLIST` to make the "keys inside
    the adcp_error block" scope obvious. Both are exported from
    `@adcp/client/server` so callers with custom error envelopes can
    inspect / extend the sets.
  - **#799 (M3)**: `wrapEnvelope` now fails closed on unregistered error
    codes. A code with no explicit entry in `ERROR_ENVELOPE_FIELD_ALLOWLIST`
    uses `DEFAULT_ERROR_ENVELOPE_FIELDS` — `context` only — instead of
    inheriting success-envelope semantics. Sellers that want `replayed`
    or `operation_id` on a bespoke error code must register it explicitly.
    The fail-closed posture matches the framework's own internal behavior:
    `create-adcp-server.ts` error paths only ever echo `context` via
    `finalize()`; `injectReplayed` is never called on error responses.

  **Who is affected**: consumers calling `wrapEnvelope` with an
  `adcp_error.code` other than `IDEMPOTENCY_CONFLICT` (the only code
  registered today) AND relying on `replayed` or `operation_id` to
  round-trip. On upgrade, those fields silently drop — only `context`
  echoes. `IDEMPOTENCY_CONFLICT` is unchanged.

  **Upgrade path**: for bespoke error codes that genuinely need
  `replayed` or `operation_id` on the envelope, build the envelope
  directly instead of calling `wrapEnvelope`, or open an issue so the
  code can be added to `ERROR_ENVELOPE_FIELD_ALLOWLIST`. The allowlist
  is intentionally frozen at the module level — extending it requires a
  spec-and-SDK conversation, not a local override.

  Breaking change (minor — `wrapEnvelope` was just shipped in 5.11.0):
  narrow external surface, days-old on npm.

  Closes #799, closes #800.

- e5ef1be: Pin to AdCP 3.0.0 GA.

  `ADCP_VERSION` flips from the rolling `latest` alias to the published
  `3.0.0` release. Generated types, Zod schemas, compliance storyboards,
  and `schemas-data/` are now locked to the 3.0.0 registry instead of
  tracking whatever the registry serves next. `COMPATIBLE_ADCP_VERSIONS`
  adds `'3.0.0'` alongside the existing `v3` alias and the beta.1 /
  beta.3 wire-compat entries so mixed-version traffic keeps working.

  Supply-chain: the 3.0.0 tarball is cosign-verified against
  `adcontextprotocol/adcp`'s release workflow OIDC identity, which is a
  stricter trust boundary than the checksum-only `latest` alias used
  before.

  Side effects of the pin:
  - `validate_property_delivery` response now uses its generated
    `ValidatePropertyDeliveryResponseSchema` (upstream shipped the
    registry entry in 3.0.0 GA). The schema requires `list_id`,
    `summary`, `results`, and `validated_at`; `compliant` is optional.
    The previous hand-written stub accepted a bare `{compliant}` OR a
    bare `{errors}` fallback; **the `{errors}` branch is gone** — error
    responses now flow through the protocol's async error channel
    rather than the response body. Callers reading `compliant` still
    work; callers that consumed `.errors` from the response must switch
    to the standard `TaskResult.adcpError` path.
  - `compliance/cache/3.0.0/` is populated (cosign-verified) and
    replaces `compliance/cache/latest/` as the storyboard source.

### Patch Changes

- 22b44c4: Fix `governance.denial_blocks_mutation` to allow expected-denial recovery
  paths.

  The invariant anchored any governance denial (`GOVERNANCE_DENIED`,
  `TERMS_REJECTED`, `POLICY_VIOLATION`, etc.) and then flagged any later
  successful mutation in the same run as a silent bypass. That fired on
  first-party storyboards whose whole purpose is to test recovery —
  `media_buy_seller/governance_denied_recovery` (buyer shrinks the buy
  and retries) and `media_buy_seller/measurement_terms_rejected` (buyer
  relaxes terms and retries) — because the retry step succeeded against
  the same plan and tripped the anchor.

  A denial step that the storyboard marks `expect_error: true` is the
  author explicitly acknowledging the denial. The subsequent mutation is
  a recovery path, not a silent bypass, so the invariant no longer
  anchors when the denial step is expected. The silent-bypass signal is
  preserved for `check_governance` 200s with `status: denied` and for
  `adcp_error` responses the author did not declare expected.

  When the invariant does fire on a wire-error denial, the failure
  message now points the author at the `expect_error: true` escape so
  the next author doesn't have to re-derive it from source. The hint is
  suppressed on `check_governance` 200 denials where the flag has no
  effect.

  Closes #811.

## 5.12.0

### Minor Changes

- 054d37a: Expose `wrapEnvelope` from `@adcp/client/server` — a public helper for attaching AdCP envelope fields (`replayed`, `context`, `operation_id`) to handler responses, with error-code-specific field allowlists (e.g., IDEMPOTENCY_CONFLICT drops `replayed`). Promoted for sellers that wire their own MCP / A2A handlers without the framework.

  Parity with the framework's internal `injectContextIntoResponse`: `opts.context` is NOT attached when the inner payload already carries a `context` the handler placed itself (handler wins). The per-error-code allowlist now lists `context` explicitly rather than short-circuiting — a module-load invariant asserts every allowlist entry includes `context` so future error codes can't silently drop correlation echo. Return type widened to surface the envelope fields (`replayed?`, `context?`, `operation_id?`) for caller autocomplete.

- 8d86be7: Add `runAgainstLocalAgent` to `@adcp/client/testing` — a one-call compliance harness that composes `createAdcpServer` + `serve` + `seedComplianceFixtures` + the webhook receiver + the storyboard runner. Sellers iterating on their handlers no longer need to hand-roll the 300-line bootstrap (ephemeral port, fixtures, webhook receiver, loop, teardown) from `adcp`'s `server/tests/manual/run-storyboards.ts`.

  **Programmatic surface.** `@adcp/client/testing` now exports `runAgainstLocalAgent({ createAgent, storyboards, fixtures?, webhookReceiver?, authorizationServer?, runStoryboardOptions?, onListening?, onStoryboardComplete?, bail? })`. The caller's `createAgent` must close over a stable `stateStore` so seeds persist across the factory calls `serve()` makes per request. `storyboards` accepts `'all'` (every storyboard in the cache), `AgentCapabilities` (the same resolution the live assessment runner does), `string[]` (storyboard or bundle ids), or `Storyboard[]`.

  **CLI surface.** `adcp storyboard run --local-agent <module> [id|bundle]` is a thin wrapper over the programmatic helper. The module must export `createAgent` as default or named. `--format junit` emits a JUnit XML report on stdout for single-storyboard and `--local-agent` runs — each storyboard becomes a `<testsuite>`, each step a `<testcase>`.

  **Test authorization server.** `@adcp/client/compliance-fixtures` now exports `createTestAuthorizationServer({ subjects?, issuer?, algorithm? })` — an in-process OAuth 2.0 AS that serves RFC 8414 metadata, JWKS, and a client-credentials token endpoint. Pairs with `runAgainstLocalAgent({ authorizationServer: true })` to grade `security_baseline`, `signed-requests`, and other auth-requiring storyboards locally without reaching an external IdP. RS256 by default (ES256 available); HS\* is refused to match `verifyBearer`'s asymmetric-only allowlist.

  **New guide.** `docs/guides/VALIDATE-LOCALLY.md` walks the ten-line pattern, the stable-stateStore rule, the CLI equivalent, and the auth-server integration.

  Closes adcp-client#786.

- 39e661f: Add seed fixture merge helpers and a `get_products` test-controller bridge so Group A compliance storyboards can seed fixtures end-to-end without seller boilerplate.

  **Seed merge helpers** (`@adcp/client/testing`):
  - Generic `mergeSeed<T>(base, seed)` — permissive merge: `undefined`/`null` in seed preserves base; every other leaf (including `0`, `false`, `""`, `[]`) overrides. Arrays replace by default; `Map`/`Set` throw.
  - Typed per-kind wrappers (`mergeSeedProduct`, `mergeSeedPricingOption`, `mergeSeedCreative`, `mergeSeedPlan`, `mergeSeedMediaBuy`) layer **by-id overlay** on well-known id-keyed arrays so seeding a single entry doesn't drop the rest: `pricing_options[]` by `pricing_option_id`, `publisher_properties[]` by `(publisher_domain, selection_type)`, `packages[]` by `package_id`, creative `assets[]` by `asset_id`, plan `findings[]` by `policy_id`, plan `checks[]` by `check_id`.
  - Shared `overlayById(base, seed, identity)` helper so sellers can apply the same overlay rule to domain-specific fields.

  **`get_products` bridge** (`@adcp/client`):
  - `createAdcpServer({ testController: { getSeededProducts } })` — seeded products append to handler output on sandbox requests (`account.sandbox === true`, `context.sandbox === true`, and — when `resolveAccount` returns an account — `ctx.account.sandbox === true`). Production traffic or a resolved non-sandbox account skips the bridge entirely. `product_id` collisions resolve with the seeded entry winning. Returns that are non-arrays or entries missing `product_id` are logged and dropped rather than thrown. Handler-declared `sandbox: false` stays authoritative (the bridge does not overwrite it).
  - `bridgeFromTestControllerStore(store, productDefaults)` — one-liner that wraps any `Map<string, unknown>` seed store into a `TestControllerBridge`; each stored fixture is merged onto `productDefaults` via `mergeSeedProduct`.
  - Opt-in via presence of `getSeededProducts`; the previous `augmentGetProducts` flag is dropped (one-rule opt-in).

### Patch Changes

- f86afe4: Storyboard runner: honor `step.sample_request` in
  `list_creative_formats` request builder.

  Prior behavior hardcoded `list_creative_formats() { return {}; }`, so
  any storyboard step declaring `format_ids: ["..."]` (or any other
  query param) in its sample_request hit the wire as an empty request.
  The agent returned unfiltered results and downstream round-trip /
  substitution-observer assertions failed silently (the agent looked
  non-conformant, but the filter had never been sent).

  Mirrors the pattern used by peer builders (`build_creative`,
  `sync_creatives`, etc.). No other API change.

  Closes #780.

- b8b7fb2: Storyboard runner: fix spec-violating shapes and `sample_request`
  precedence across the SI + governance request builders. All affected
  builders now honor `step.sample_request` first (matching peer builders),
  and their synthetic fallbacks conform to the generated Zod schemas so
  framework-dispatch agents running strict validation at the MCP boundary
  no longer reject them with `-32602 invalid_type`.
  - `si_get_offering`: drop the string `context` and the out-of-schema
    `identity`; emit the prose string as optional `intent` (per
    `si-get-offering-request.json`, `context` is a ref to an object).
  - `si_initiate_session`: move prose from `context` (which must be an
    object) to required `intent`; default the identity fallback to the
    realistic anonymous handoff shape (`consent_granted: false` +
    `anonymous_session_id`) instead of `consent_granted: true` with an
    empty consented user — spec-legal either way, but the anonymous shape
    is what a host that hasn't obtained PII consent actually sends.
  - `si_send_message` / `si_terminate_session`: honor `sample_request` so
    storyboards can drive `action_response`, `handoff_transaction`,
    `termination_context`, and non-default `reason` paths without the
    fallback stomping the scenario.
  - `sync_governance`: lengthen default `authentication.credentials` to
    meet `minLength: 32`, and honor `sample_request` so fixtures like
    `signal-marketplace/scenarios/governance_denied.yaml` that author
    `url: $context.governance_agent_url` flow through.

  Closes #802.

- 8d58987: Fix unbounded re-execution when a buyer SDK retries a mutating request against a handler whose response fails strict-mode validation (issue #758).

  Under the strict response-validation default, a drifted handler produced a `VALIDATION_ERROR` and released its idempotency claim on the way out, so the next retry re-entered the handler with the same drift — looping as fast as the buyer's retry budget allowed. The dispatcher now caches the `VALIDATION_ERROR` envelope under the same `(principal, key, payloadHash)` tuple for 10 seconds; retries on the same key short-circuit to the cached error instead of re-running side effects, and the cache clears itself before a handler fix would be gated on TTL expiry.

  A retry with a different canonical payload still produces `IDEMPOTENCY_CONFLICT` (the cache scopes on payload hash, same as the success cache), and a buyer that generates a fresh idempotency key per retry is not short-circuited — both behaviors are intentional. Same-key retry storms are the dominant failure mode; fresh-key loops already have the buyer's backoff as the correct control point.

  New `IdempotencyStore.saveTransientError(...)` method is optional on the interface — custom store implementations that want retry-storm protection can implement it; omitting it preserves the prior release-on-error behavior. Stores built via `createIdempotencyStore` pick it up automatically.

  **Operational note.** A drifted handler reachable by a hostile buyer is a cache-fill vector (every fresh key writes a 10s entry). Alert on sustained `VALIDATION_ERROR` rates per principal — steady-state should be zero.

- c6bced1: Testing: schema-driven round-trip invariant for every storyboard request builder, plus fallback fixes so each builder's fallback round-trips through the generated Zod schema.

  Adds `test/lib/request-builder-schema-roundtrip.test.js` that iterates every task in `TOOL_REQUEST_SCHEMAS` (plus `creative_approval` and `update_rights`) and asserts the fallback request — empty context, empty `sample_request`, synthetic `idempotency_key` where required — parses cleanly against the matching schema from `src/lib/types/schemas.generated.ts`. New builders are picked up automatically.

  Running the invariant surfaced eight pre-existing fallbacks that had drifted out of spec. Fixed:
  - `update_media_buy` packages fallback now sets `package_id`.
  - `update_rights` / `creative_approval` fallbacks use `rights_id` (the spec field) instead of `rights_grant_id`; `creative_approval` now emits `creative_url` + `creative_id`.
  - `sync_creatives` fallback assets carry the required `asset_type` discriminator (`image` / `video` / `text`). `buildAssetsForFormat` uses spec-correct video fields (`duration_ms`, `container_format`, `width`, `height`).
  - `calibrate_content` / `validate_content_delivery` artifacts use `assets: []` (the schema is an array of typed assets, not an object map).
  - `activate_signal` defaults `destinations` to a placeholder agent entry so the fallback path satisfies the schema's required array.
  - `create_content_standards` / `update_content_standards` fallbacks align with the current `scope` + `policies` shape (old schema used `name` + `rules`).
  - `si_get_offering` / `si_initiate_session` pass `options.si_context` through the schema's `intent` (string) field instead of the wire-level `context` slot that the spec types as `ContextObject`; `si_initiate_session` now emits the required `intent`.

  Closes #803.

- 5e52efa: Fix storyboard `REQUEST_BUILDERS` for `log_event` and `create_media_buy` so they emit spec-conformant payloads and honor hand-authored `step.sample_request` — framework-dispatch agents running zod at the MCP boundary previously rejected these with `-32602 invalid_type` (#793).
  - **`log_event`** now honors `step.sample_request` when present (same convention as `sync_catalogs`, `update_media_buy`, `report_usage`). The synthetic fallback emits `event_time` (was `timestamp`) and places `value` + `currency` under `custom_data` (was nested `value: { amount, currency }`). Unblocks `sales_catalog_driven` and `sales_social` storyboards whose authored events carried `event_time`, `content_ids`, and spec-shaped siblings that the builder was discarding.
  - **`create_media_buy`** now emits every authored package instead of dropping `packages[1+]`. The first package still receives context-derived `product_id` / `pricing_option_id` overrides (so single-package storyboards against arbitrary sellers keep working); additional packages pass through with context injection only, preserving per-package `product_id`, `bid_price`, `pricing_option_id`, and `creative_assignments`. Unblocks multi-package storyboards (e.g. `sales_non_guaranteed`) where `context_outputs` captured `packages[1].package_id` as `second_package_id` — the next step was being skipped with "unresolved context variables from prior steps".

  Surfaced while diagnosing adcontextprotocol/adcp#2872.

## 5.11.0

### Minor Changes

- 740f609: Add typed factory helpers for creative asset construction that inject the `asset_type` discriminator: `imageAsset`, `videoAsset`, `audioAsset`, `textAsset`, `urlAsset`, `htmlAsset`, `javascriptAsset`, `cssAsset`, `markdownAsset`, `webhookAsset`, plus a grouped `Asset` namespace (`Asset.image({...})`) over the same functions.

  Each helper takes the asset shape without `asset_type` and returns an object tagged with the canonical literal — `imageAsset({ url, width, height })` produces `{ url, width, height, asset_type: 'image' }` — eliminating the boilerplate at every construction site. The discriminator is written last in the returned object so a runtime bypass (cast that slips `asset_type` into the input) cannot overwrite it.

  Return type is `Omit<T, 'asset_type'> & { asset_type: '<literal>' }` (intersection) rather than the raw generated interface, so the builders compile regardless of whether the generated TypeScript types currently carry the discriminator — a defensive choice that makes the helpers stable across schema regenerations.

- 828c112: Add `createDefaultTestControllerStore` to `@adcp/client/testing` — a default factory that wires every `force_*`, `simulate_*`, `seed_*` scenario against a generic `DefaultSessionShape`. Sellers provide `loadSession` / `saveSession` and get a conformance-ready `TestControllerStore` without hand-rolling 300+ lines of boilerplate. Supports partial overrides for sellers who need to customize specific handlers.
- dd04ae9: Add `@adcp/client/express-mcp` middleware that rewrites JSON-only `Accept` headers so they pass the MCP SDK's `StreamableHTTPServerTransport` check when `enableJsonResponse: true`. Local escape hatch pending upstream SDK fix (https://github.com/modelcontextprotocol/typescript-sdk/issues/1944).
- 4dc4743: Storyboard cross-step invariants are now default-on. Bundled assertions (`status.monotonic`, `idempotency.conflict_no_payload_leak`, `context.no_secret_echo`, `governance.denial_blocks_mutation`) apply to every run unless a storyboard opts out — forks and new specialisms no longer ship with zero cross-step gating silently.
  - `Storyboard.invariants` now accepts an object form `{ disable?: string[]; enable?: string[] }`. `disable` is the escape hatch that removes a specific default; `enable` adds a consumer-registered (non-default) assertion on top of the baseline. The legacy `invariants: [id, ...]` array form still works and is treated as additive on top of the defaults.
  - **Behavior change for direct-API callers**: `resolveAssertions(['id'])` now returns `[...defaults, ...named]` instead of exactly the named ids. Callers that relied on the array-only return shape (e.g., snapshotting `resolveAssertions([...]).length`) should switch to `resolveAssertions({ enable: [...], disable: listDefaultAssertions() })` to reproduce the old semantics.
  - `AssertionSpec` gained an optional `default?: boolean` flag. Consumers registering custom assertions via `registerAssertion(...)` can opt their own specs into the default-on path.
  - `resolveAssertions(...)` fails fast on unknown ids in `enable` / the legacy array, and on `disable` ids that aren't registered as defaults (typo guard — a silent no-op would mask coverage gaps). Errors name the registered set and emit a `Did you mean "..."?` suggestion when one of the unknown ids is within Levenshtein distance 2 of a known id.
  - Unknown top-level keys on the object form (e.g. `invariants: { disabled: [...] }` — trailing `d` typo) throw instead of silently normalising to an empty disable set.
  - New export `listDefaultAssertions()` (re-exported from `@adcp/client/testing`) enumerates the default-on set for tooling / diagnostics.

  `status.monotonic` failure messages now include the legal next states from the anchor status and a link to the canonical enum schema, e.g.
  `media_buy mb-1: active → pending_creatives (step "create" → step "regress") is not in the lifecycle graph. Legal next states from "active": "canceled", "completed", "paused". See https://adcontextprotocol.org/schemas/latest/enums/media-buy-status.json for the canonical lifecycle.`
  Terminal states render as `(none — terminal state)` so the message is unambiguous.

- 6a2c2c5: Add typed factory helpers for `preview_creative` render objects: `urlRender`, `htmlRender`, `bothRender`, plus a grouped `Render` namespace. Each helper takes the render payload without `output_format` and returns an object tagged with the canonical discriminator — `urlRender({ render_id, preview_url, role })` produces a valid url-variant render without repeating `output_format: 'url'` at every call site.

  Mirrors the `imageAsset` / `videoAsset` pattern shipped in #771. `PreviewRender` is a oneOf on `output_format` (`url` / `html` / `both`) where the discriminator decides which sibling field becomes required. Matrix runs consistently surfaced renders missing either `output_format` or its required sibling — the helpers make the wrong shape syntactically harder to express because the input type requires the matching `preview_url` / `preview_html` per variant.

  Return type uses `Omit<Variant, 'output_format'> & { output_format: <literal> }` so the builders stay robust across schema regenerations. Discriminator is spread last so a runtime cast cannot overwrite the canonical tag.

  Skill pitfall callouts in `build-creative-agent` and `build-generative-seller-agent` now recommend the render helpers alongside the asset helpers.

- 9d583aa: Extend the bundled `status.monotonic` default assertion to track the audience lifecycle alongside the seven resource types it already guards (adcontextprotocol/adcp#2836). `sync_audiences` responses carry per-audience `status` values (`processing | ready | too_small`) drawn from the newly-named spec enum at `/schemas/enums/audience-status.json`, and the assertion now rejects off-graph transitions across storyboard steps for every observed `audience_id`.

  **Transition graph** — fully bidirectional across the three states, matching the spec's permissive "MAY transition" hedging:
  - `processing → ready | too_small` on matching completion.
  - `ready ↔ processing` on re-sync (new members → re-match).
  - `too_small → processing | ready` on re-sync (more members → re-match, directly back to ready when the re-matched count clears the minimum).
  - `ready ↔ too_small` as counts cross `minimum_size` across re-syncs.

  **Observations** are drawn from `sync_audiences` responses only — discovery-only calls (request omits the `audiences[]` array) still return `audiences[]`, so the extractor covers both write and read paths under the single task name. No separate `list_audiences` task exists in the spec. Actions `deleted` and `failed` omit `status` entirely on the response envelope; the extractor's id+status guard makes those rows silent (nothing to observe, nothing to check).

  **Resource scoping** is `(audience, audience_id)`, independent from the other tracked resources. Unknown enum values drift-reset the anchor rather than failing — `response_schema` remains the gate for enum conformance.

  8 new unit tests cover the forward flow, the too_small → processing → ready re-sync path, bidirectional `ready ↔ too_small`, `ready → processing` on re-sync, self-edge silent pass, deleted/failed silent pass, per-audience-id scoping, and enum-drift tolerance. The assertion description now enumerates `audience` alongside the other resource types.

  Follow-up: wiring `audience-sync/index.yaml` with `invariants: [status.monotonic]` in the adcp spec repo once this release lands.

- eca55c5: Storyboard runner auto-fires `comply_test_controller` seed scenarios from the `fixtures:` block (adcp-client#778).

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

- 5ef797e: Sync generated types to AdCP 3.0 GA and consolidate the 4.x → 5.x migration guide.

  **Generated-type changes** (in `src/lib/types/*.generated.ts`, re-exported via `@adcp/client` and `@adcp/client/types`):
  - **Asset types** (`ImageAsset`, `VideoAsset`, `AudioAsset`, `TextAsset`, `URLAsset`, `HTMLAsset`, `JavaScriptAsset`, `WebhookAsset`, `CSSAsset`, `MarkdownAsset`, `BriefAsset`, `CatalogAsset`, `VASTAsset`, `DAASTAsset`) gain a required `asset_type` literal discriminator (e.g. `asset_type: 'image'`). Handlers that construct asset literals must populate it.
  - **`GetProductsRequest.refine[]`** — `id` renamed to `product_id` (product scope) / `proposal_id` (proposal scope); `action` is now optional (defaults to `'include'`). New-in-GA surface — beta.3 clients never sent this.
  - **`GetProductsResponse.refinement_applied[]`** — flat object replaced by a discriminated `oneOf` union on `scope`. Each arm carries `product_id`/`proposal_id` (previously a shared `id`). New-in-GA surface.
  - **VAST/DAAST** — common fields (`vast_version`, `tracking_events`, `vpaid_enabled`, `duration_ms`, `captions_url`, `audio_description_url`) hoisted from inside each `oneOf` arm to the base object. Wire payloads are unchanged; codegen is cleaner.
  - **Governance plan requests** (`ReportPlanOutcomeRequest`, `GetPlanAuditLogsRequest`, `CheckGovernanceRequest`) — tightened to reject redundant `account` fields alongside `plan_id`. New-in-GA surface.

  **Wire-level compatibility.** Against the previously-compatible AdCP `3.0.0-beta.3`, the only bidirectional wire breaker is the asset `asset_type` discriminator: a GA client strictly validating an asset payload from a beta.3 server will reject, because beta.3 servers don't emit the discriminator. Set `validation: { requests: 'warn' }` if you need that traffic to flow. Every other change is either TS-only (same JSON on the wire) or new-in-GA surface that beta.3 counterparties never exercise. rc.1 / rc.2 clients sending GA servers the old `refine[].id` shape will be rejected (`additionalProperties: false`) — upgrade the client.

  **If upgrading your handlers:** (1) populate `asset_type` on every asset literal your handlers construct (`"image"`, `"video"`, `"vast"`, `"daast"`, …); (2) rename `refine[].id` → `refine[].product_id` / `refine[].proposal_id` on the scope-matching arm; (3) run `tsc --noEmit` — tightened brand-rights + `DomainHandler` return types will point to every drift site. Full walkthrough in [`docs/migration-4.x-to-5.x.md`](../docs/migration-4.x-to-5.x.md) Part 4.

  **Migration doc consolidated.** `docs/migration-4.30-to-5.2.md` and `docs/migration-5.3-to-5.4.md` are superseded by `docs/migration-4.x-to-5.x.md`, which walks the full 4.x → 5.x train release-by-release and includes a wire-interop matrix near the top.

  **New dev tool: `npm run schema-diff`.** Compares `schemas/cache/latest/` against the snapshot captured on the previous `npm run sync-schemas` run (now written to `schemas/cache/latest.previous/`). Groups wire-level changes by kind (field renames, newly-required fields, `additionalProperties` tightened, `oneOf` arm count changes, enum deltas) so the output surfaces interop concerns without re-reading 700 lines of generated TS. Run with no args for the default before/after pair, or pass two directories: `npm run schema-diff -- <dirA> <dirB>`.

### Patch Changes

- 2cfbb8a: Cycle-A fixes from matrix v12 failure analysis:

  **SDK**: `TaskExecutor.normalizeResponseForValidation` now strips underscore-prefixed client-side annotations (`_message`, future `_*` fields) before running AJV schema validation. These are added by the response unwrapper as text-summary hints; they're not part of the wire protocol. Schemas with `additionalProperties: false` (`create-property-list-response`, `create-collection-list-response`, etc.) would otherwise reject every response reaching the grader's schema check. Fixes 6 v12 failures across governance property-list CRUD.

  **Skills**: added a "Cross-cutting pitfalls matrix runs keep catching" block to each `build-*-agent/SKILL.md` inside the existing imperative callout. Each skill lists the specific patterns Claude drifted on in matrix v12 runs — targeted per tool surface:
  - `capabilities.specialisms` is `string[]` of enum ids, NOT `[{id, version}]` objects (all 8 skills)
  - `get_media_buy_delivery` requires top-level `currency: string` (seller, retail-media, generative-seller)
  - `build_creative` returns `{creative_manifest: {format_id, assets}}`, not sync_creatives-style fields (creative, generative-seller)
  - Each asset in `creative_manifest.assets` requires an `asset_type` discriminator (creative, generative-seller)
  - Mutating-tool responses have `additionalProperties: false` — don't add extra fields (governance)

  These live inside the imperative "fetch docs/llms.txt before writing return" callout so they're adjacent to where Claude scans for shape info.

- 5d823e6: Skill pitfalls for Cycle C — seller-side response-row drift surfaced by matrix v14:
  - `get_media_buy_delivery /media_buy_deliveries[i]/by_package[j]` rows require the billing quintet: `package_id`, `spend`, `pricing_model`, `rate`, `currency`. Matrix v14 caught 4 failures on mock handlers that returned `{package_id, impressions, clicks}` without the billing fields. Added to seller + retail-media + generative-seller pitfall callouts.
  - `get_media_buys /media_buys[i]` rows require `media_buy_id`, `status`, `currency`, `total_budget`, `packages`. Matrix v14 caught 2 failures on persist/reconstruct paths. Pitfall callouts now explicitly say: persist `currency` + `total_budget` at `create_media_buy` time, echo verbatim.

  No SDK code change. This closes the last two non-specialism-specific drift classes; residual failures after matrix v15 will be storyboard-specific step expectations (generative quality, governance denial shape).

- 369aea8: Skill pitfalls for Cycle D — two narrow drift classes matrix v15 surfaced after the 3.0 GA schema sync (#773):
  - `get_media_buy_delivery /reporting_period/start` and `/end` are ISO 8601 **date-time** strings (`new Date().toISOString()` produces the canonical shape), not date-only. GA added strict `format: "date-time"` validation; `'2026-04-21'` now fails. Added to seller, retail-media, generative-seller, and creative-agent skill pitfall callouts.
  - `videoAsset({...})` now requires `width` and `height` per GA (previously optional on `VideoAsset`). Mocks that passed `{url}` alone fail validation at `/creative_manifest/assets/<name>/width`. Added to creative-agent and generative-seller pitfalls with a concrete pixel-values example.

  No SDK code change. Closes v15's two residual schema-drift classes. Residual failures after this land are storyboard-specific step expectations (generative quality grading, governance denial shape specifics) — the tight-loop per-pair phase.

- 55c7c3b: Storyboard runner: honor `step.sample_request` in `get_rights`
  request builder.

  Prior behavior hardcoded `query: 'available rights for advertising'`
  and `uses: ['ai_generated_image']`, and injected `brand_id` from the
  caller's `brand.domain`. Storyboards declaring scenario-specific
  query text, uses, or a `buyer_brand` hit the wire with the generic
  fallback instead, and rights-holder rosters rejected the
  caller-domain `brand_id` as unknown — so `rights[0]` was undefined,
  `$context.rights_id` didn't resolve, and downstream `acquire_rights`
  steps failed with `rights_not_found` instead of the error the
  storyboard was actually asserting (e.g., `GOVERNANCE_DENIED` in
  `brand_rights/governance_denied`).

  Mirrors the pattern used by peer builders (`sync_plans`,
  `check_governance`, `list_creative_formats`,
  `create_content_standards`, etc.). The generic fallback still runs
  when no `sample_request` is authored.

  Closes adcp#2846.

- 7fd0948: Fix: response-schema AJV validators now accept envelope fields (`replayed`, `context`, `ext`, and future envelope additions) at the response root on every tool.

  The bundled JSON response schemas for the property-list family (`create_property_list`, `update_property_list`, `delete_property_list`, `get_property_list`, `list_property_lists`, `validate_property_delivery`) ship with `additionalProperties: false` at the root, which rejected `replayed: false` — even though security.mdx specifies `replayed` as a protocol-level envelope field that MAY appear on any response. That left a two-faced contract: the universal-idempotency storyboard requires `replayed: false` on the initial `create_media_buy`, but emitting the same envelope field on property-list tools tripped strict response validation.

  `schema-loader` now flips `additionalProperties: false` to `true` at the response root (and at each direct `oneOf` / `anyOf` / `allOf` branch one level deep) when compiling response validators. Nested body objects stay strict so drift inside a `Product`, `Package`, or list body still fails validation. Request schemas remain strict so outgoing drift fails at the edge. Matches the envelope extensibility the Zod generator already expresses via `.passthrough()`. Fixes #774.

## 5.10.0

### Minor Changes

- 8f9260b: feat(server): request validation defaults to `'warn'` outside production

  `createAdcpServer({ validation: { requests } })` previously defaulted to
  `'off'` everywhere. It now defaults to `'warn'` when
  `NODE_ENV !== 'production'`, mirroring the asymmetric default already in
  place for `responses` (`'strict'` in dev/test, `'off'` in production).

  Production behaviour is unchanged: the default stays `'off'` when
  `NODE_ENV === 'production'`, so prod request paths pay no AJV cost.

  What operators will see: in dev/test/CI, each incoming request that
  doesn't match the bundled AdCP request schema logs a single
  `Schema validation warning (request)` line through the configured
  logger, with the tool name and the field pointer. Nothing is rejected —
  the request still flows to the handler exactly as before. Node's test
  runner does not set `NODE_ENV`, so suites running under `node --test`
  fall into the dev/test bucket and will start emitting these warnings.

  How to opt out: pass `validation: { requests: 'off' }` on the server
  config, or set `NODE_ENV=production` for the process.

  Why: keeps request and response defaults symmetric, and prepares seller
  operators for upstream AdCP schema tightenings (e.g. adcp#2795, which
  introduces a required `asset_type` discriminator — buyer agents still
  on RC3 fixtures will lack it). Surfacing those drifts as warnings
  during development beats discovering them in a downstream consumer's
  `VALIDATION_ERROR` after deploy.

  Related: #694 (original intent for `requests: 'warn'`) and #727 A
  (response-side default precedent).

- 86a0fde: Register the fourth default cross-step assertion `status.monotonic` (adcontextprotocol/adcp#2664). Resource statuses observed across storyboard steps MUST transition only along edges in the spec-published lifecycle graph for their resource type. Catches regressions like `active → pending_creatives` on a media_buy, or `approved → processing` on a creative asset, that per-step validations cannot detect.

  **Tracked lifecycles** (one transition table per resource type, hardcoded against the enum schemas in `static/schemas/source/enums/*-status.json` in the spec repo, with bidirectional edges listed explicitly):
  - `media_buy` — forward flow `pending_creatives → pending_start → active`, `active ↔ paused` reversible, terminals `completed | rejected | canceled`.
  - `creative` (asset lifecycle) — forward flow `processing → pending_review → approved | rejected`, `approved ↔ archived` reversible, `rejected → processing | pending_review` allowed on re-sync, no terminals.
  - `creative_approval` — per-assignment on a package, forward `pending_review → approved | rejected`, `rejected → pending_review` allowed on re-sync.
  - `account` — `active ↔ suspended` and `active ↔ payment_required` reversible, terminals `rejected | closed`.
  - `si_session` — forward `active → pending_handoff → complete | terminated`, terminals `complete | terminated`.
  - `catalog_item` — forward `pending → approved | rejected | warning`, `approved ↔ warning` reversible, `rejected → pending` allowed on re-sync.
  - `proposal` — one-way `draft → committed`.

  **Observations** are drawn from task-aware extractors on `stepResult.response`: `create_media_buy` / `update_media_buy` / `get_media_buys`, `sync_creatives` / `list_creatives`, nested `.packages[].creative_approvals[]`, `sync_accounts` / `list_accounts`, `si_initiate_session` / `si_send_message` / `si_terminate_session`, `sync_catalogs` / `list_catalogs` (per-item), `get_products` (when the response carries a `proposal`). Unknown tasks produce no observations.

  **State** is scoped `(resource_type, resource_id)` so independent resources don't interfere. Self-edges (same status re-read) are silent pass. Skipped / errored / `expect_error: true` steps don't record observations. Unknown enum values (drift) reset the anchor without failing — `response_schema` catches enum violations.

  Failure output names the resource, the illegal transition, and the two step ids: `media_buy mb-1: active → pending_creatives (step "create" → step "regress") is not in the lifecycle graph.` Consumers who need a stricter variant can `registerAssertion(spec, { override: true })`.

  18 new unit tests cover forward flows, terminal enforcement, bidirectional edges, skip semantics, (resource_type, resource_id) scoping, nested creative_approval arrays, adcp_error-gated observations, enum-drift tolerance.

- 573a176: Improve OAuth ergonomics for `adcp storyboard run`.
  - **Fix classification**: capability-discovery failures whose error message says `"requires OAuth authorization"` (the wording `NeedsAuthorizationError` emits) now classify as `auth_required` with the `Save credentials: adcp --save-auth <alias> <url> --oauth` remediation hint, instead of falling through to `overall_status: 'unreachable'` with no actionable advice. The keyword list in `detectAuthRejection` now matches `"authorization"` and `"oauth"` in addition to `401/unauthorized/authentication/jws/jwt/signature verification`.
  - **Surface the hint earlier**: the OAuth remediation observation now fires whenever the error text looks OAuth-shaped, not only when `discoverOAuthMetadata` successfully walks the well-known chain — an agent that 401s before its OAuth metadata is resolvable still gets a useful hint.
  - **Inline OAuth flow**: `adcp storyboard run <alias> --oauth` now opens the browser to complete PKCE when the saved alias has no valid tokens, then proceeds with the run. Matches the existing `adcp <alias> get_adcp_capabilities --oauth` behavior so the two-step dance (`--save-auth --oauth` then `storyboard run`) is no longer required. Raw URLs still need `--save-auth` first; MCP only.

  Docs: `docs/CLI.md` and `docs/guides/VALIDATE-YOUR-AGENT.md` document both flows and add a troubleshooting row for the `Agent requires OAuth` failure.

- 86ccc99: feat(server): response validation defaults to `'strict'` outside production

  `createAdcpServer({ validation: { responses } })` previously defaulted to
  `'warn'` when `NODE_ENV !== 'production'`. It now defaults to `'strict'`
  in dev/test/CI so handler-returned schema drift fails with
  `VALIDATION_ERROR` (with the offending field path in `details.issues`)
  instead of logging a warning the caller can silently ignore.

  Production behaviour is unchanged: the default stays `'off'` when
  `NODE_ENV === 'production'`, so prod request paths pay no validation
  cost. Pass `validation: { responses: 'warn' }` to restore the previous
  dev-mode behaviour; `validation: { responses: 'off' }` opts out
  entirely.

  Why: the `compliance:skill-matrix` harness has repeatedly surfaced
  `SERVICE_UNAVAILABLE` from agents whose responses fail the wire schema.
  The dispatcher's response validator catches this drift with a clear
  field pointer, one layer that every tool inherits automatically. Making
  that the default catches it during handler development rather than in a
  downstream consumer.

  Migration: handler tests that use sparse fixtures (e.g.
  `{ products: [{ product_id: 'p1' }] }`) will start returning
  `VALIDATION_ERROR`. Either fill in the missing required fields to match
  the AdCP schema, or set `validation: { responses: 'off' }` on the test
  server to keep the fixture intentionally minimal. Note that Node's
  test runner does **not** set `NODE_ENV`, so test suites running under
  `node --test` (with `NODE_ENV=undefined`) fall into the dev/test
  bucket and will start validating responses — this is intentional.

  Also: the `VALIDATION_ERROR` envelope's `details.issues[].schemaPath`
  is now gated behind `exposeErrorDetails` (same policy as the existing
  `SERVICE_UNAVAILABLE.details.reason` field). Production responses no
  longer leak `#/oneOf/<n>/properties/...` paths that fingerprint the
  handler's internal `oneOf` branch selection — buyers still get
  `pointer`, `message`, and `keyword`, which is sufficient to fix a
  drifted payload.

  Closes #727 (A).

- f64007c: fix(server): tighten handler return types so schema drift fails `tsc`

  Two related tightenings close #727 (B).

  **1. `AdcpToolMap` brand rights results.** `acquire_rights`,
  `get_rights`, and `get_brand_identity` had `result: Record<string,
unknown>` — a stale scaffold from before the response types were
  code-generated. Replaced with the proper generated types:
  - `acquire_rights` → `AcquireRightsAcquired | AcquireRightsPendingApproval | AcquireRightsRejected`
  - `get_rights` → `GetRightsSuccess`
  - `get_brand_identity` → `GetBrandIdentitySuccess`

  **2. `DomainHandler` return type.** The handler return union
  previously included `| Record<string, unknown>` as a general escape
  hatch, so any handler could return any shape. Sparse returns like
  `{ rights_id, status: 'acquired' }` passed `tsc` and only failed at
  wire-level validation. Handler return type is now just
  `AdcpToolMap[K]['result'] | McpToolResponse`, so drift fails at
  compile time. `adcpError(...)` still works — it returns
  `McpToolResponse`.

  **Migration.** If a handler returns a plain object literal without
  spelling out the full success shape, `tsc` will now flag the drift
  with an error like:

  ```
  Type '{ products: [{ product_id: 'p1' }] }' is not assignable to type
  'McpToolResponse | GetProductsResponse'.
    Property 'reporting_capabilities' is missing in type
    '{ product_id: 'p1' }' but required in type 'Product'.
  ```

  Two ways to fix:
  - Fill in the missing required fields to match the AdCP schema (what
    the wire-level validator would have demanded anyway). Use
    `DEFAULT_REPORTING_CAPABILITIES` for `Product.reporting_capabilities`
    if you don't have seller-specific reporting policy yet.
  - If you genuinely need a loose return (e.g. a test fixture), wrap
    with a response builder — `productsResponse({ ... })`,
    `acquireRightsResponse({ ... })`, etc. The builders accept typed
    inputs so the drift surfaces there instead of silently passing
    through.

  **Reference agents.** `test-agents/seller-agent.ts` now uses
  `DEFAULT_REPORTING_CAPABILITIES` on each product (the old code had
  a "Use plain objects instead of Product type" comment whose premise
  was wrong — `reporting_capabilities` is required, not optional).
  `test-agents/seller-agent-signed-mcp.ts` had a latent bug:
  `createMediaBuy` was reading `pkg.package_id` from the request, but
  `PackageRequest` has no such field — buyers send `buyer_ref` and
  the seller mints `package_id` per spec. The handler now mints
  `crypto.randomUUID()` like a real seller would.

### Patch Changes

- 275fa70: `docs/llms.txt` now includes per-tool response contracts. Each tool section gets a `**Response (success branch):**` block listing the required + optional fields drawn from the bundled JSON schemas — same format the existing request block uses.

  Closes the drift path we kept seeing in matrix runs: agents dropped required response fields (missing `format_id` on `creative_manifest`, plural-variant hallucinations like `creative_deliveries` for `creatives`, missing top-level `currency`) because the skill examples documented the intent but the full per-field contract lived in the generated schemas and was never surfaced in the llms.txt index Claude actually reads when building. The contract is now one anchored section away: `docs/llms.txt#build_creative`, `docs/llms.txt#get_creative_delivery`, etc. — same convention as the llms.txt pattern other projects use.

  No SDK code change; llms.txt is regenerated via `npm run generate-agent-docs`.

- 6ae3169: chore(server): migrate McpServer.tool() → registerTool() repo-wide (#705)

  Replaces every use of the MCP SDK's deprecated `McpServer.tool(...)`
  overload with the supported `registerTool(name, config, handler)` form.
  Behavior is unchanged; `tools/list` output is identical aside from a
  cleaner path to the same metadata.

  **What moved**
  - `src/lib/server/create-adcp-server.ts` — the AdcpToolMap registration
    loop and `get_adcp_capabilities` now use `registerTool`, with
    `annotations` declared at register time instead of via a post-hoc
    `.update()` call.
  - `src/lib/server/test-controller.ts`, `src/lib/testing/comply-controller.ts`
    — `comply_test_controller` registration.
  - `src/lib/testing/stubs/governance-agent-stub.ts` — all five tools
    (`get_adcp_capabilities`, `sync_plans`, `check_governance`,
    `report_plan_outcome`, `get_plan_audit_logs`).
  - `examples/error-compliant-server.ts` — the canonical seller template.
  - JSDoc, prose, and README-ish comments updated to the new form.

  **`outputSchema` deliberately not wired on framework tools**

  The MCP SDK's _client-side_ `callTool` validates `structuredContent`
  against the declared `outputSchema` whenever structuredContent is
  present — regardless of `isError`
  (`@modelcontextprotocol/sdk/dist/esm/client/index.js:504`). AdCP's
  `adcpError()` envelope carries `structuredContent: { adcp_error: {...} }`
  alongside `isError: true`, which would fail every client-side outputSchema
  check (the error shape doesn't match the success schema). Until the SDK
  gates that client-side check on `!isError` (the server-side validator
  already does), framework-registered tools are migrated _without_
  `outputSchema`. Response drift is caught by the dispatcher's AJV
  validator (#727) instead, and `customTools` may opt in explicitly via
  `customTools[*].outputSchema` — validated by a new regression test.

  Closes #705.

- 275fa70: Skill files now point Claude at `docs/llms.txt#<tool>` for per-tool field contracts instead of duplicating them inline.

  **Callout wording is imperative, not descriptive** (per prompt-engineering review): _"Before writing any handler's return statement, fetch `docs/llms.txt` and grep for `#### \`<tool_name>\``..."_ Replaces the earlier passive "contracts live at X" phrasing that relied on Claude optionally following the pointer. Safety-net sentence reframed as permission ("write the obvious thing and trust the contract") rather than threat.

  **Grep instructions match how agents actually find sections**: Markdown anchors resolve on GitHub but Claude reading the raw file searches for `#### \`tool_name\``. The callout names that pattern directly.

  **build-creative-agent slim** collapses verbose response-shape blocks into a 4-column handler-binding table: `Tool | Handler | Contract | Gotchas`. The Contract column carries a direct anchor link per tool so Claude is likelier to click the one adjacent to the row it's reading than a general pointer three lines up. Asset-shape bullets stay inline (most-drifted fields historically). Net -94 lines on that skill.

  **Other 7 skills get the pointer callout only** — structural slims deferred until matrix v12 signal is in. Two variables (pointer + slim) on one skill lets us disambiguate outcomes.

  Lands on top of strict validation default in dev (#727/#757) and the llms.txt response-contract generator (#761). Together: llms.txt is canonical, skills are narrative + gotchas, strict validation catches residual drift at call site.

## 5.9.1

### Patch Changes

- b1497f9: ci: consolidate pipeline and drop redundant jobs

  CI-only change, no runtime/library behaviour affected. Published package contents are unchanged.
  - `ci.yml`: collapse `test` / `quality` / `security` into a single job. Each was re-running `checkout + setup-node + npm ci`, wasting ~1–2 min of setup per PR. Also removes the `clean && build:lib` re-build in the old quality job and the redundant `build` step (alias of `build:lib`).
  - `ci.yml`: drop `publish-dry-run`. `release.yml`'s `prepublishOnly` already validates packaging on the actual release PR.
  - `ci.yml`: drop dead `develop` branch from the push trigger.
  - `schema-sync.yml`: drop the PR-triggered `validate-schemas` job — `ci.yml` already syncs schemas and diffs generated files on every PR. Scheduled auto-update job preserved.
  - `commitlint.yml`: use `npm ci` instead of `npm install --save-dev`; the `@commitlint/*` packages are already in `devDependencies`.

- 933eb2d: Two response-layer fixes for agents built from partial skill coverage:

  **`buildCreativeResponse` / `buildCreativeMultiResponse` no longer crash on missing fields.** The default summary previously dereferenced `data.creative_manifest.format_id.id` without guards — handlers that drop `format_id` (required by `creative-manifest.json`) crashed the dispatcher with `Cannot read properties of undefined (reading 'id')`, swallowing the real schema violation behind an opaque `SERVICE_UNAVAILABLE`. Now the summary optional-chains through the field chain and falls back to a generic string, so the response reaches wire-level validation and the buyer sees the actual missing-field error.

  **`replayed: false` is no longer injected on fresh executions.** `protocol-envelope.json` permits the field to be "omitted when the request was executed fresh"; emitting `false` violates strict task response schemas that declare `additionalProperties: false` (`create-property-list-response`, etc.). Fresh responses now drop any prior `replayed` marker; replays still carry `replayed: true`. The existing `test/lib/idempotency-client.test.js` "replayed omitted is surfaced as undefined" test aligns with this shift.

  Surfaced by matrix v10: six `creative_generative` pairs crashed with the dereference, and every `property_lists` pair hit the `additionalProperties` violation.

- 5eb2ae9: fix(testing): `context.no_secret_echo` walks structured `TestOptions.auth`, and `registerAssertion` accepts `{ override: true }`
  - The default `context.no_secret_echo` assertion in `@adcp/client/testing`
    previously treated `options.auth` as a string and added the whole
    discriminated-union object to its secret set. `String.includes(obj)`
    against `[object Object]` matched nothing, so the assertion was
    effectively a no-op for every consumer passing structured auth (bearer,
    basic, oauth, oauth_client_credentials). It now extracts the leaf
    secrets across every variant:
    - bearer: `token`
    - basic: `username`, `password`, and the base64 `user:pass` blob an
      `Authorization: Basic` header would carry
    - oauth: `tokens.access_token`, `tokens.refresh_token`,
      `client.client_secret` (confidential clients)
    - oauth_client_credentials: `credentials.client_id` and
      `credentials.client_secret` — resolving `$ENV:VAR` references to their
      runtime values so echoes of the real secret (not the reference string)
      are caught — plus `tokens.access_token` / `tokens.refresh_token`

    A minimum-length guard (8 chars) skips substring matching on fixture
    values that would otherwise collide with benign JSON.

  - `registerAssertion(spec, { override: true })` now replaces an existing
    registration instead of throwing. Lets consumers swap in a stricter
    version of an SDK default (e.g. their own `context.no_secret_echo`)
    without calling `clearAssertionRegistry()` and re-registering every other
    default. Default behaviour (`{ override: false }` / no options) is
    unchanged and still throws on duplicate ids.

- afc01f1: Widen two bundled default assertions per security-review feedback on adcontextprotocol/adcp#2769.

  **`idempotency.conflict_no_payload_leak`** — flip the denylist-of-5-fields to an allowlist of 7 envelope keys (`code`, `message`, `status`, `retry_after`, `correlation_id`, `request_id`, `operation_id`). The previous implementation only flagged `payload`, `stored_payload`, `request_body`, `original_request`, `original_response` — a seller inlining `budget`, `start_time`, `product_id`, or `account_id` at the `adcp_error` root slipped past, turning idempotency-key reuse into a read oracle for stolen-key attackers. Allowlisting closes the hole: anything a seller adds beyond the 7 envelope fields now fails the assertion.

  **`context.no_secret_echo`** — scan the full response body recursively (not just `.context`), add a bearer-token literal regex (`/\bbearer\s+[A-Za-z0-9._~+/=-]{10,}/i`), add recursive suspect-property-name match (`authorization`, `api_key`, `apikey`, `bearer`, `x-api-key`), and pick up `options.test_kit.auth.api_key` as a verbatim-secret source. The previous scope (`response.context` only, verbatim `options.auth_token`/`.auth`/`.secrets[]` only) missed the common cases where sellers echo credentials into `error.message`, `audit.incoming_auth`, nested debug fields, or as header-shaped properties. All caller-supplied secrets gate on a minimum length (8 chars) to avoid false positives on placeholder values.

  Both changes are patch-level — the assertion ids, public registration API, and passing-case behavior are unchanged; the narrowing on main was fresh in 5.9 and had no adopters broad enough for the strictening to break in practice.

  `governance.denial_blocks_mutation` is unchanged.

  16 new unit tests cover both widenings: allowlist hits (valid envelope passes), denylist vestigial names still fail, non-allowlisted field leaks (including stable sorted error output), plus bearer literals, verbatim `options.auth_token` echo, `options.secrets[]` echo, `test_kit.auth.api_key` echo, suspect property names at any depth, array walking, short-value false-positive guard, and prose-"bearer" ignore.

## 5.9.0

### Minor Changes

- 6180150: Fix A2A multi-turn session continuity + add `pendingTaskId` retention for HITL flows. Mirrors [adcp-client-python#251](https://github.com/adcontextprotocol/adcp-client-python/pull/251).

  **The bug.** The A2A adapter (`callA2ATool`) never put `contextId` or `taskId` on the Message envelope — every send opened a fresh server-side session regardless of caller state. `AgentClient` compounded the error by storing `result.metadata.taskId` into `currentContextId` on every success, so the field that was supposed to carry the conversation id was actually carrying a per-task correlation id. Multi-turn A2A conversations against sellers that key state off `contextId` (ADK-based agents, session-scoped reasoning, any HITL flow) silently fell back to new-session-every-call.

  **The fix.**
  - `callA2ATool` takes a new `session` arg and injects `contextId` / `taskId` onto the Message per the @a2a-js/sdk type.
  - `ProtocolClient.callTool` threads session ids through to the A2A branch (MCP unaffected — no session concept there).
  - `TaskExecutor` stops aliasing `options.contextId` to the client-minted correlation `taskId`. The local `taskId` is now always a fresh UUID; the caller's `contextId` rides on the wire envelope only.
  - `TaskResultMetadata` gains `contextId` (server-returned A2A session id) and `serverTaskId` (server-tracked task id), populated from the response by `ProtocolResponseParser.getContextId` / `getTaskId`.
  - `AgentClient` retains `contextId` across sends (auto-adopted from server responses so ADK-style id rewriting is transparent) and tracks `pendingTaskId` only while the last response was non-terminal (`input-required` / `working` / `submitted` / `auth-required` / `deferred`). Terminal states clear `pendingTaskId` so the next call starts fresh.

  **Public API (AgentClient).**

  ```ts
  client.getContextId(); // read retained contextId
  client.getPendingTaskId(); // read pending server taskId (HITL resume)
  client.resetContext(); // wipe session state
  client.resetContext(id); // rehydrate persisted contextId across process restart
  ```

  `setContextId(id)` and `clearContext()` still exist for backwards compatibility (`clearContext` now delegates to `resetContext()`).

  **One AgentClient per conversation.** Sharing an instance across concurrent conversations interleaves session ids (last-write-wins) — create a fresh `AgentClient` or call `resetContext()` per logical conversation. Callers needing resume-across-process-restart should persist `getContextId()` / `getPendingTaskId()` after non-terminal responses and seed them back via `resetContext(id)` + direct `setContextId` on rehydration.

  **Behavior change to note.** `TaskOptions.contextId` no longer overrides the client-minted correlation `taskId` (which was its unintended side effect). Callers who were reading `result.metadata.taskId` expecting to see their caller-supplied `contextId` should now read `result.metadata.contextId`.

- 0e7c1c9: `createAdcpServer`'s dispatcher now auto-unwraps `throw adcpError(...)` into the normal response path. Handlers that `throw` an envelope (instead of `return`-ing it) used to surface as `SERVICE_UNAVAILABLE: Tool X handler threw: [object Object]` — the thrown value is a plain object, not an `Error`, so `err.message` is undefined and `String(err)` yields the `[object Object]` literal. The dispatcher now detects the envelope shape (`{ isError: true, content: [...], structuredContent: { adcp_error: { code } } }`) and returns it directly, preserving the typed code / field / suggestion exactly as if the handler had written `return`.

  Driver: matrix v8 showed this pattern persisting across fresh-Claude builds even when the skill examples use `return`. Fixing it at the dispatcher closes the class of bugs once, instead of hoping every skill-corpus update lands. A `logger.warn` still fires on unwrap so agent authors see they should switch to `return`, but buyers stop paying for the mistake.

  Idempotency claims are released on unwrap (same as any other thrown path) so retries proceed normally. Non-envelope throws (`TypeError`, custom errors, strings, objects without the full envelope shape) still surface as `SERVICE_UNAVAILABLE` with the underlying cause in `details.reason` — the existing handler-throw disclosure from PR #735 is unchanged.

- 8c64d65: Bundle the `governance.denial_blocks_mutation` default assertion and auto-register the existing defaults on any `@adcp/client/testing` import (adcontextprotocol/adcp#2639, #2665 closed as superseded).

  **New default assertion** (`default-invariants.ts`):

  `governance.denial_blocks_mutation` — once a plan receives a denial signal (`GOVERNANCE_DENIED`, `CAMPAIGN_SUSPENDED`, `PERMISSION_DENIED`, `POLICY_VIOLATION`, `TERMS_REJECTED`, `COMPLIANCE_UNSATISFIED`, or `check_governance` returning `status: "denied"`), no subsequent step in the run may acquire a resource for that plan. Plan-scoped via `plan_id` (pulled from response body or the runner's recorded request payload — never stale step context). Sticky within a run: a later successful `check_governance` does not clear the denial. Write-task allowlist excludes `sync_*` batch shapes for now. Silent pass when no denial signal appears.

  **Auto-registration wiring**:

  `storyboard/index.ts` now side-imports `default-invariants` so any consumer of `@adcp/client/testing` picks up all three built-ins (`idempotency.conflict_no_payload_leak`, `context.no_secret_echo`, `governance.denial_blocks_mutation`). Previously only `comply()` triggered registration; direct `runStoryboard` callers against storyboards declaring `invariants: [...]` would throw `unregistered assertion` on resolve. Consumers who want to replace the defaults can `clearAssertionRegistry()` and re-register.

  **Supersedes** #2665 (the sibling `@adcp/compliance-assertions` package proposal): shipping these in-band is the lower-ceremony path and makes storyboards that reference the ids work out of the box against a fresh `@adcp/client` install.

- 7aca3fa: Add typed `CapabilityResolutionError` for `resolveStoryboardsForCapabilities` (and by extension `comply()`). Addresses [#734](https://github.com/adcontextprotocol/adcp-client/issues/734).

  **The problem.** The resolver threw plain `Error` instances for two distinct, actionable agent-config faults — "specialism has no bundle" and "specialism's parent protocol isn't declared in `supported_protocols`". Callers (AAO's compliance heartbeat, `evaluate_agent_quality`, the public `applicable-storyboards` REST endpoint) could only distinguish them by regexing the message, which broke if wording drifted and caused agent-config faults to page observability as system errors.

  **The fix.** Export `CapabilityResolutionError extends ADCPError` with a `code` discriminator and structured fields so callers can branch without parsing messages:

  ```ts
  import { CapabilityResolutionError } from '@adcp/client/testing';

  try {
    resolveStoryboardsForCapabilities(caps);
  } catch (err) {
    if (err instanceof CapabilityResolutionError) {
      switch (err.code) {
        case 'unknown_specialism':
          // err.specialism
          break;
        case 'specialism_parent_protocol_missing':
          // err.specialism, err.parentProtocol
          break;
      }
    }
  }
  ```

  Existing message text is preserved so regex-based callers keep working during the migration. The `unknown_protocol` code is reserved for future use — today an unknown `supported_protocols` entry still logs a `console.warn` and is skipped (fail-open), not thrown.

- 7f27e8f: `createAdcpServer` now defaults `validation.responses` to `'warn'` when `process.env.NODE_ENV !== 'production'`. Previously both sides defaulted to `'off'`, leaving schema drift to surface downstream as cryptic `SERVICE_UNAVAILABLE` or `oneOf` discriminator errors far from where the offending field lives.

  The new default catches handler-returned drift at wire-validation time with a clear field path, in dev/test/CI, where you want the signal. Production behavior is unchanged — set `NODE_ENV=production` and both sides stay `'off'`.

  Override explicitly via `createAdcpServer({ validation: { responses: 'off' | 'warn' | 'strict', requests: ... } })` — an explicit config always wins over the environment-derived default.

  This is the first half of the architecture fix tracked in [#727](https://github.com/adcontextprotocol/adcp-client/issues/727) — validation belongs at the wire layer, not in response builders. Tightening generated TS discriminated unions so `tsc` catches sparse shapes is the remaining half.

  Cost: one AJV compile per tool on cold start + one validator invocation per response in dev. No effect on production.

- 0cc20df: `createAdcpServer`'s `exposeErrorDetails` now defaults to `true` outside `NODE_ENV=production`. Handler throws emit the underlying cause message and handler name in `adcp_error.details` + the human-readable text, so agent authors see `SERVICE_UNAVAILABLE: Tool acquire_rights handler threw: Cannot find module '@adcp/client/foo'` instead of the opaque `encountered an internal error` we used to ship.
  - Production behavior is unchanged (errors stay redacted for live agents).
  - Explicit `exposeErrorDetails: false` still wins — production deployments that want the redaction without relying on `NODE_ENV` should keep setting it.
  - `logger.error('Handler failed', ...)` now includes the full stack (`err.stack`) so server logs point at the exact line that blew up, not just the message.

  Matrix-harness debuggability was the driver: every `SERVICE_UNAVAILABLE` in matrix v5–v7 was an opaque black box that required re-running with `--keep-workspaces` and inspecting Claude-generated code to figure out why a handler threw. With this default, the matrix log shows the fault line on the first run.

- e979d07: Add OAuth 2.0 client credentials (RFC 6749 §4.4) support to the library and CLI for machine-to-machine compliance testing. Addresses [adcontextprotocol/adcp#2677](https://github.com/adcontextprotocol/adcp/issues/2677).

  **The problem.** Sales agents that authenticate via OAuth client credentials couldn't be tested with `@adcp/client` without a user manually exchanging credentials for a token and pasting the bearer in. Tokens expire; CI pipelines need a way to point the library at a token endpoint and let it handle refresh.

  **Library-level auto-refresh.** `ProtocolClient.callTool` now re-exchanges the secret for a fresh access token before every call when `AgentConfig.oauth_client_credentials` is set (cached while valid — single POST on miss, no-op on warm cache). Concurrent callers for the same agent coalesce onto one refresh POST. On a mid-call 401 the client force-refreshes once and retries — covers the case where the AS rotates something out of band. Refreshed tokens persist via any attached `OAuthConfigStorage`.

  **New `auth` type on `TestOptions`.** `createTestClient` / `ADCPMultiAgentClient` accept `{ type: 'oauth_client_credentials', credentials, tokens? }`. Storyboard runs, `adcp fuzz`, `adcp grade`, and any programmatic consumer get auto-refresh for free.

  **CLI flags on `--save-auth`:**

  ```bash
  # Token endpoint is discovered from the agent URL
  # (RFC 9728 protected-resource metadata + RFC 8414 AS metadata)
  adcp --save-auth my-agent https://agent.example.com \
    --client-id abc123 --client-secret xyz789 \
    --scope adcp

  # Override discovery if the agent doesn't advertise OAuth metadata
  adcp --save-auth my-agent https://agent.example.com \
    --oauth-token-url https://auth.example.com/token \
    --client-id abc123 --client-secret xyz789
  ```

  Full subcommand help: `adcp --save-auth --help`.

  **Secret storage.** Literal secrets land in `~/.adcp/config.json` (mode `0600`, directory `0700`). For CI, `--client-id-env` / `--client-secret-env` store a `$ENV:VAR_NAME` reference resolved at token-exchange time — nothing sensitive on disk:

  ```bash
  adcp --save-auth my-agent https://agent.example.com \
    --oauth-token-url https://auth.example.com/token \
    --client-id-env CLIENT_ID --client-secret-env CLIENT_SECRET
  ```

  Empty env-var values are rejected loudly (catches the common `.env` typo `CLIENT_SECRET=`).

  **Audience binding (RFC 8707).** `AgentOAuthClientCredentials` accepts `resource?: string | string[]` (emitted as repeated `resource` form fields, RFC 8707) and `audience?: string` (the Auth0/Okta/Azure AD vendor parameter). Required for agents behind audience-validating proxies.

  **Security hardening.**
  - `token_endpoint` must be `https://` — `http://` is rejected with a typed `malformed` error before any request hits the wire. `http://localhost` and `http://127.0.0.1` are allowed for local dev.
  - Userinfo URLs (`https://user:pass@auth.example.com/token`) are rejected — credentials belong in `client_id` / `client_secret`, not the URL, and leaking them via error messages and log aggregators is easy.
  - SSRF guard: private-IP / loopback token endpoints are rejected unless the caller opts in with `allowPrivateIp: true`. The CLI opts in (operator-driven); the library trusts whatever the agent URL already trusts. Hosted consumers accepting untrusted configs get the guard for free.
  - Basic auth encoding follows RFC 6749 §2.3.1 (form-urlencoded: space → `+`, `!'()*` percent-encoded) — not `encodeURIComponent`. Fixes interop with secrets containing those characters.
  - `error_description` from the authorization server is control-character-stripped and truncated before being surfaced — defends against ANSI / CRLF injection from a hostile AS.

  **`is401Error` now recognizes MCP SDK error shape** (`err.code === 401`). The MCP `StreamableHTTPClientTransport` throws errors with HTTP status on `.code`; the retry path for CC and auth-code flows was silently skipping them. Caught by the new integration test.

  **CLI flags (all on `--save-auth`):**
  - `--client-id <value>` / `--client-id-env <VAR>` — literal or env reference
  - `--client-secret <value>` / `--client-secret-env <VAR>` — literal or env reference
  - `--scope <scope>` — optional OAuth scope
  - `--oauth-token-url <url>` — optional; discovered from the agent URL via RFC 9728 + RFC 8414 when omitted. Supply explicitly only when the agent does not advertise OAuth metadata.
  - `--oauth-auth-method basic|body` — credential placement (default: `basic` per RFC 6749 §2.3.1)

  **Programmatic API** under `@adcp/client/auth`:
  - `exchangeClientCredentials(credentials, options?)` — one-shot token exchange
  - `ensureClientCredentialsTokens(agent, options?)` — refresh-if-stale helper that updates `agent.oauth_tokens` in place (coalesces concurrent calls) and optionally persists via `OAuthConfigStorage`
  - `ClientCredentialsExchangeError` — typed error with `kind: 'oauth' | 'malformed' | 'network'`, `oauthError`, `oauthErrorDescription`, `httpStatus`
  - `MissingEnvSecretError` — typed error with `reason: 'unset' | 'empty'`
  - `resolveSecret`, `isEnvSecretReference`, `toEnvSecretReference` — secret-resolution utilities
  - `AgentOAuthClientCredentials` — type for the new `AgentConfig.oauth_client_credentials` field

  The authorization-code flow (`--oauth`) and existing `auth_token` paths are unchanged. `createFileOAuthStorage` persists `oauth_client_credentials` alongside `oauth_tokens` so CLI and programmatic consumers share the same on-disk shape.

- 65740a1: Thin response builders for four tools whose handlers previously had no typed wrapper, plus per-variant constructors for `acquire_rights`:
  - **`acquireRightsResponse(data)`** — envelope wrapper on the `AcquireRightsResponse` union.
  - **`acquireRightsAcquired({...})`, `acquireRightsPendingApproval({...})`, `acquireRightsRejected({...})`** — per-variant constructors. A coding agent typing `acquireRightsAcqu…` gets the right variant's required-field shape directly without reading a 4-variant union.
  - **`syncAccountsResponse(data)`** — envelope wrapper on `SyncAccountsResponse`.
  - **`syncGovernanceResponse(data)`** — envelope wrapper on `SyncGovernanceResponse`.
  - **`reportUsageResponse(data)`** with `.acceptAll(request, { errors })` shortcut — the `.acceptAll` form computes `accepted = usage.length - errors.length` so the common "ack all / ack all minus validated failures" cases are one call.

  All four are auto-applied via `createAdcpServer`'s `TOOL_META` — handlers return domain objects and the framework wraps. Also exported from `@adcp/client` and `@adcp/client/server` for manual use.

  **Scope note** (per test-agent-team review): these builders are **only** MCP envelope wrappers — they do not enforce schema constraints like `credentials.minLength: 32`, `authentication.schemes.length === 1`, or `creative_manifest.format_id` object shape. Those belong in wire-level Zod validation (already available as `createAdcpServer({ validation: { responses: 'strict' } })`, tracked for default-on). Validation in builders would be the wrong layer — it only fires for tools whose handlers reach the wrapper, misses manual-tool paths, and encourages per-tool workarounds instead of fixing the generator + validator.

- e68b2fb: Add uniform-error-response fuzz invariant (adcontextprotocol/adcp-client#731). `adcp fuzz` now runs a paired-probe check on referential lookup tools asserting byte-equivalent error responses for "exists but inaccessible" vs "does not exist" — the AdCP spec MUST from error-handling.mdx (landed in adcp#2689, hardened in adcp#2691).

  Two modes:
  - **Baseline** (default, single token): two fresh UUIDs probed per tool. Catches id-echo, header divergence, MCP `isError` / A2A `task.status.state` divergence. Always runs.
  - **Cross-tenant** (new `--auth-token-cross-tenant` flag + `ADCP_AUTH_TOKEN_CROSS_TENANT` env var): seeder runs as tenant A, invariant probes as tenant B against the seeded id + a fresh UUID. Catches the full cross-tenant existence-leak surface.

  Comparator enforces identical `error.code` / `message` / `field` / `details`, HTTP status, MCP `isError`, A2A `task.status.state`, and response headers with a closed allowlist (`Date`, `Server`, `Server-Timing`, `Age`, `Via`, `X-Request-Id`, `X-Correlation-Id`, `X-Trace-Id`, `Traceparent`, `Tracestate`, `CF-Ray`, `X-Amz-Cf-Id`, `X-Amz-Request-Id`, `X-Amzn-Trace-Id`). `Content-Length`, `Vary`, `Content-Type`, `ETag`, `Cache-Control`, and rate-limit headers MUST match.

  Tool coverage: `get_property_list`, `get_content_standards`, `get_media_buy_delivery`, `get_creative_delivery`, `tasks_get`. Extending is additive via `TOOL_ID_CONFIG` in `src/lib/conformance/invariants/uniformError.ts`.

  **Public API:**
  - New option: `RunConformanceOptions.authTokenCrossTenant?: string`
  - New report field: `ConformanceReport.uniformError: UniformErrorReport[]`
  - New CLI flag: `--auth-token-cross-tenant <token>`

  **Security:** response headers are redacted at capture time when they name a credential (`Authorization`, `X-Adcp-Auth`, `Cookie`, etc.), and bearer tokens echoed in response bodies are masked — no credential ever lands in a stored report.

  **Docs:** `docs/guides/VALIDATE-YOUR-AGENT.md` has a new "Uniform-error-response invariant (paired probe)" subsection including the preparation checklist for two-tenant testing. `skills/build-seller-agent/SKILL.md` § Protocol-Wide Requirements adds "Resolve-then-authorize" as a universal MUST; `skills/build-governance-agent/SKILL.md` cross-references it.

- fb38c53: **Breaking for raw-string callers:** adapter error code string values changed from lowercase-custom (`'list_not_found'`) to uppercase-snake (`'REFERENCE_NOT_FOUND'`, `'UNSUPPORTED_FEATURE'`, etc.) to comply with the AdCP spec's uppercase-snake convention. Closes #700.

  **Affected constants** (the KEYS are unchanged, only the emitted string VALUES changed):
  - `PropertyListErrorCodes` (`property-list-adapter.ts`)
  - `ContentStandardsErrorCodes` (`content-standards-adapter.ts`)
  - `SIErrorCodes` (`si-session-manager.ts`)
  - `ProposalErrorCodes` (`proposal-manager.ts`)

  **Unaffected**: code that uses the exported enum constants. `PropertyListErrorCodes.LIST_NOT_FOUND` still resolves — the key is stable, only the emitted value changed.

  **Breaks**: code that pattern-matches raw strings. Multiple `*_NOT_FOUND` keys now collapse to `'REFERENCE_NOT_FOUND'` so string-based switches can no longer distinguish the source domain.

  **Migration**: replace raw-string comparisons with the exported helpers + constants.

  ```ts
  // Before — silently stops matching after this change
  if (err.code === 'list_not_found') { … }

  // After — stable across future value changes
  import { isPropertyListError, PropertyListErrorCodes } from '@adcp/client';

  if (isPropertyListError(err) && err.code === PropertyListErrorCodes.LIST_NOT_FOUND) { … }
  ```

  **Semver justification**: bumped `minor` rather than `major` because these adapter scaffolds are pre-stable surface intended for implementers extending the stock classes — not yet depended on by downstream shipped products. A repo-wide search found zero raw-string consumers. Value changes in future releases may warrant `major` once implementers are shipping.

  Also emitted by this change: `SIErrorCodes.SESSION_TERMINATED` now emits the message `"Session is not active"` (previously `"Session has already been terminated"`) to match the existing `SESSION_EXPIRED` branch — prevents subclass implementers from accidentally leaking terminal-vs-expired state distinction in multi-tenant deployments.

### Patch Changes

- fb38c53: Drop the `provide_performance_feedback` request builder from the storyboard runner so the spec-conformant `sample_request` from the storyboard drives the payload. The builder emitted non-spec `feedback`/`satisfaction`/`notes` fields that caused conformant sellers to reject the request with `INVALID_REQUEST`. Closes #689.
- ba8c907: Fix `sync_catalogs` and `report_usage` storyboard request-builders to honor `step.sample_request` when present, and use spec-valid defaults when building a fallback.

  **sync_catalogs** — before this fix, the builder ignored the storyboard's `sample_request` entirely and returned a hardcoded catalog with `feed_format: 'json'` (not in the `FeedFormatSchema` union: `google_merchant_center | facebook_catalog | shopify | linkedin_jobs | custom`) and no `type` field (required by `CatalogSchema`). Every conformance agent running the generated Zod schema rejected the request with `-32602` on both paths. The fallback now uses `type: 'product'` + `feed_format: 'custom'`, and the builder reads `sample_request` first.

  **report_usage** — same pattern: builder ignored `sample_request` and returned per-entry shape `{ creative_id, impressions, spend: { amount, currency } }` which doesn't match `usage-entry.json` (expects top-level `vendor_cost: number` + `currency: string` + `account` on each entry). Agents rejected with `-32602` listing all three missing fields. Fixed by reading `sample_request` first and aligning the fallback to the spec shape.

  Surfaced by the matrix harness — every `sales_catalog_driven` and `creative_ad_server` run showed the same builder-generated -32602 before this patch.

- faef971: Clarify idempotency-on-error semantics in the seller and creative skill docs, driven by the audit in [#744](https://github.com/adcontextprotocol/adcp-client/issues/744).

  **What the audit found.** The dispatcher releases the idempotency claim on every error path — envelope returns, envelope throws, and uncaught exceptions. That's already documented for the "transient failures don't lock into the cache" case, but the handler-author implication wasn't spelled out: a handler that mutates state before erroring will double-write on retry. The surface for this bug widened with [#743](https://github.com/adcontextprotocol/adcp-client/pull/743) (auto-unwrap of thrown envelopes), which blesses `throw adcpError(...)` as a supported path.

  **Why not cache terminals instead.** The AdCP `recovery: terminal` catalog is mostly state-dependent (`ACCOUNT_SUSPENDED`, `BUDGET_EXHAUSTED`, `ACCOUNT_PAYMENT_REQUIRED`, `ACCOUNT_SETUP_REQUIRED` all flip after out-of-band remediation). Caching them would lock buyers into stale errors for the full replay TTL. Only `UNSUPPORTED_FEATURE` and `ACCOUNT_NOT_FOUND` are truly immutable, and re-executing them is cheap.

  **Changes.**
  - `skills/build-seller-agent/SKILL.md` idempotency section now documents the mutate-last contract, with a worked `budgetApproved` example showing the broken-vs-correct ordering and a note on making partial-write paths converge via natural-key upsert.
  - `skills/build-creative-agent/SKILL.md` swaps the now-stale "throw surfaces as `SERVICE_UNAVAILABLE`" rationale (invalidated by #743) for the still-true claim-release rationale.

  No runtime behavior changes; docs only. No changes to `compliance/cache/` — storyboards there are machine-synced from the upstream spec repo, so a conformance assertion that locks in error-claim-release semantics is a follow-up for `adcontextprotocol/adcp`.

- 929b6b3: Add `unresolved_hidden_by_pagination` meta-observation to `refs_resolve` when `target_paginated` AND at least one `unresolved_with_pagination` co-occur on the same result. Closes #718.

  Catches the integrity gap introduced by #717: a seller that unconditionally returns `pagination.has_more: true` can hide refs it can't service — the demotion logic passes the check, and graders keying on `refs_resolve.passed` alone miss the structural smell. The new meta-observation names the co-occurrence neutrally (structural descriptor, not an accusation — graders decide intent) so compliance dashboards get an independent grader signal without changing pass/fail semantics. Shape mirrors `scope_excluded_all_refs` (the #711 silent-no-op detector): `{ kind, unresolved_count }` — the per-ref detail already lives in the `unresolved_with_pagination` observations. `unresolved_count` is deduped, so it matches the per-ref observation count.

  Becomes redundant when `adcp#2601`'s "compliance mode returns everything referenced in a single response" rule lands at the spec level.

- e68b2fb: Internal: MCP and A2A protocol adapters can now capture raw HTTP responses (status, headers, body, latency) when `withRawResponseCapture(fn)` is active. Exported from `src/lib/protocols/rawResponseCapture.ts`. Conformance-only infrastructure — the wrapper is a pass-through when no capture slot is set, so regular clients pay only one AsyncLocalStorage lookup per request. Foundation for the uniform-error-response fuzz invariant (issue #731).
- fb38c53: Extract the protocol transport-suffix regex (`/mcp`, `/a2a`, `/sse`) to a single source in `utils/a2a-discovery` and share it between `SingleAgentClient.computeBaseUrl` and the storyboard `canonicalizeAgentUrlForScope`. Adding a new transport now only requires updating one regex. Closes #719.
- 0169874: Skill fixes uncovered by matrix v8's handler-throw disclosure (PR #735):
  - **brand-rights skill** (`acquire_rights` + `sync_accounts` + `sync_governance`): swap `|` → `:` in the composite account-key template literal. `ctx.store.put`'s key pattern is `[A-Za-z0-9_.\-:]` — `|` is rejected and the handler throws on the first sync. Also guard `acquireRights` against missing `account.brand.domain` / `account.operator` before composing the key.
  - **creative skill** (`list_creatives` + `build_creative`): destructure `ctx.store.list` — it returns `{ items, nextCursor? }`, not a bare array. Previously the examples called `.filter`/`.find` on the envelope object and blew up with `TypeError`, surfaced as `SERVICE_UNAVAILABLE`. Also flip `throw adcpError(...)` to `return adcpError(...)` in `build_creative`; throwing bypasses the envelope path and reports as `SERVICE_UNAVAILABLE` instead of `CREATIVE_NOT_FOUND`.
  - **governance skill** (`property-lists`): add a `list_property_lists` example showing `const { items } = await ctx.store.list('property_list')`. Matrix v8 builds repeatedly `.map`-ed the raw result; the skill now shows the correct shape in-line.

  No SDK code changes — these are skill-corpus fixes visible to agent builders.

- 53c531e: Storyboard runner now forwards `push_notification_config` from `sample_request` to the outbound request when a programmatic request builder is used (`create_media_buy`, `update_media_buy`, etc.). Previously, only `context`, `ext`, and `idempotency_key` were merged from the hand-authored sample_request on top of the builder output — `push_notification_config` silently fell off the wagon, so every webhook-emission conformance phase (`universal/webhook-emission`, `specialisms/sales-broadcast-tv` window-update webhook, etc.) failed vacuously with the agent under test never receiving the webhook URL. `{{runner.webhook_url:<step_id>}}` substitution is applied to the carried-over config so the runner's ephemeral receiver URL still resolves correctly. Fixes #747.
- 18fa51b: Extend the uniform-error-response comparator (adcontextprotocol/adcp-client#738) to walk A2A Task and Message shapes when looking for the AdCP error envelope. `extractEnvelope` now finds `adcp_error` nested in `result.artifacts[].parts[].data` (Task reply) or `result.parts[].data` (Message reply); `peelWrappers` reduces A2A Task/Message bodies to their data-part payloads so per-request `task.id` / `contextId` / `artifactId` / `messageId` don't false-positive structural compares on identical success bodies.

  Adds `test/lib/uniform-error-invariant-a2a.test.js` — the A2A-shaped sibling of the existing MCP integration test, running the same five-case matrix (baseline compliant/leak, cross-tenant compliant/leak, baseline fallback) against an in-process A2A seller reached through `@a2a-js/sdk/client`. Closes the gap where only hand-crafted JSON strings exercised the A2A path.

## 5.8.2

### Patch Changes

- 2942e58: Fix `createAdcpServer` context echo for Sponsored Intelligence tools. `si_get_offering` and `si_initiate_session` define `context` as a domain-specific string on the request but require the protocol echo object on the response. The response auto-echo now only copies `request.context` when it is a plain object, so SI responses no longer fail with `/context: must be object`.
- 56bbc59: Follow-up to the skill schema refresh (PR #716) targeting matrix failures that persisted:
  - **`DEFAULT_REPORTING_CAPABILITIES` over hand-rolled literals** — seller, generative-seller, and retail-media skill product examples previously hand-rolled `reporting_capabilities: { ... }` which drifts every time the spec adds a required field (most recently `date_range_support` in AdCP latest). Skills now use the SDK-provided constant and flag the drift tax explicitly.
  - **`create_media_buy` must persist `currency` + `total_budget`** — seller skill's `createMediaBuy` example flattens request `total_budget: { amount, currency }` into top-level `currency` + `total_budget` fields on the persisted buy, so subsequent `get_media_buys` responses pass the new required-field schema check. The old example stored only `packages[].budget` and the required top-level fields weren't reconstructable.
  - **`update_media_buy.affected_packages` must be `Package[]`, not `string[]`** — seller skill's `updateMediaBuy` example now returns package objects (`{ package_id, ... }`) instead of bare IDs. The `update-media-buy-response` oneOf discriminator rejects string arrays with `/affected_packages/0: must be object`.

- 7e04fa0: Option B (structural) groundwork — stop treating response shapes as hand-written forever:
  - `generate-agent-docs.ts` now extracts response schemas and emits a `_Response (success branch):_` block under every tool in `docs/TYPE-SUMMARY.md`. For tools whose response is a `oneOf` success/error discriminator (e.g., `update_media_buy`), the generator picks the success arm (no `errors` required field) so builders see the happy-path shape. `_Request:_` and `_Response_` are now visually separated.
  - `TYPE-SUMMARY.md` is regenerated; every tool now carries both sides of the wire.
  - Seller + creative skills: added explicit top-level `currency` in `getMediaBuyDelivery` and `getCreativeDelivery` examples. The response schemas require it; the old examples omitted it and fresh-Claude agents built under those skills failed `/currency: must have required property` validation.

  Builders can now cross-reference hand-written skill examples against an auto-updating TYPE-SUMMARY response block. When the spec adds a required field, the generated doc updates immediately while the skill example may lag — that's the drift-detection signal.

  Next logical step (not in this PR): replace the hand-written `**tool** — Response Shape` blocks in skills with direct `See [TYPE-SUMMARY.md § tool](…)` pointers so the skill narrative focuses on logic and the shape stays generated.

## 5.8.1

### Patch Changes

- f61f284: Re-export the storyboard assertion registry (`registerAssertion`,
  `getAssertion`, `listAssertions`, `clearAssertionRegistry`,
  `resolveAssertions`, and types `AssertionSpec`, `AssertionContext`,
  `AssertionResult`) from `@adcp/client/testing` so authors of invariant
  modules can import them from the documented package entry point. The
  underlying module (`./storyboard/assertions`) already exported these;
  only the parent `./testing` index was missing the re-exports. Closes
  the gap introduced by #692.
- bdebac9: `refs_resolve` scope: canonicalize `$agent_url` by stripping transport
  suffixes instead of comparing raw target URL to bare agent origins.

  Before this fix, storyboards using `scope: { key: 'agent_url', equals:
'$agent_url' }` silently graded every source ref `out_of_scope` on MCP
  and A2A runners, because `$agent_url` expanded to the runner's target
  URL (with `/mcp`, `/a2a`, or `/.well-known/agent.json` suffixes) while
  refs carried the bare agent URL per AdCP convention. Net effect: the
  check degraded from integrity enforcement to a no-op on every MCP agent.

  The scope comparator now mirrors `SingleAgentClient.computeBaseUrl`:
  strip `/mcp`, `/a2a`, `/sse`, and `/.well-known/agent[-card].json`
  suffixes; lowercase scheme and host; drop default ports; strip
  userinfo, query, and fragment. Path below the transport suffix is
  preserved, so sibling agents at different subpaths on a shared host
  (e.g. `https://publisher.com/.well-known/adcp/sales` vs
  `/.well-known/adcp/creative`) remain distinguishable. Closes #710.

- bdebac9: `refs_resolve`: harden grader-visible observation and `actual.missing`
  payloads against hostile agent responses.

  Compliance reports may be published or forwarded to third parties, so
  every ref field emitted by the runner is now:
  - **Userinfo-scrubbed** on URL-keyed fields via WHATWG URL parsing plus
    a regex fallback that scrubs `scheme://user:pass@` shapes embedded
    in non-URL fields. Credentials planted in `agent_url` values can no
    longer leak through compliance output.
  - **Scheme-restricted** on URL-keyed fields: non-`http(s)` schemes
    (e.g. `javascript:`, `data:`, `file:`) are replaced with a
    `<non-http scheme: …>` placeholder so downstream UIs rendering
    `agent_url` as a link cannot inherit a stored-XSS vector.
  - **Length-capped** at 512 code points per string field, with a
    code-point-boundary truncation that preserves surrogate pairs.
  - **Count-capped** at 50 observations per check, with an
    `observations_truncated` marker when the cap fires. Meta
    observations (`scope_excluded_all_refs`, `target_paginated`)
    precede per-ref entries so the cap never drops primary signal.

  Match and dedup behavior is unchanged: the internal projection used
  for ref comparison is kept separate from the sanitized projection used
  for user-facing output, so truncation never false-collapses dedup
  keys. `refsMatch` and `projectRef` also now use `hasOwnProperty` to
  prevent storyboard authors from accidentally drawing match keys from
  `Object.prototype`. Closes #714.

- bdebac9: `refs_resolve`: emit a `scope_excluded_all_refs` meta-observation when
  a scope filter partitions every source ref out. The integrity check
  enforces nothing when no ref falls in-scope; graders previously got a
  silent pass. The meta-observation surfaces the structural smell without
  changing pass/fail semantics. Suppressed under `on_out_of_scope: 'ignore'`
  (which explicitly opts out of scope warnings). Closes #711.
- bdebac9: `refs_resolve`: detect paginated current-step targets and demote
  unresolved refs to observations instead of failing the check.

  Previously, when the target response carried `pagination.has_more:
true`, any ref legitimately defined on a later page graded as
  `missing` — a false-positive failure against a conformant paginating
  seller. The runner now emits a `target_paginated` meta-observation and
  reports each would-be-missing ref as an `unresolved_with_pagination`
  observation, letting the check pass until the spec-level resolution
  lands (compliance mode requiring sellers to return everything
  referenced by products in a single response). Closes #712.

- c4ff3e6: Skill example refresh to match recent upstream schema changes and fix a brand-rights coverage gap surfaced by the `compliance:skill-matrix` dogfood harness:
  - `list_creative_formats.renders[]`: upstream restructured renders to require `role` plus exactly one of `dimensions` (object) or `parameters_from_format_id: true` under `oneOf`. Updated seller, creative, generative-seller, and retail-media skill examples; flagged `renders: [{ width, height }]` as the canonical wrong shape.
  - `get_media_buys.media_buys[]`: `currency` and `total_budget` are now required per row. Seller skill example now shows both; added a persistence note (save these fields on `create_media_buy` so subsequent queries can echo them).
  - `context` response field: schema-typed as `object`. Across all 8 skills, rewrote the "Context and Ext Passthrough" section to stop recommending `context: args.context` echo (which fabricates string values when `args.context` is undefined or confused with domain fields like `campaign_context`). Explicit guidance: leave the field out of your return — `createAdcpServer` auto-injects the request's context object; hand-setting a non-object string fails validation and the framework does not overwrite.
  - Brand-rights governance flow: the `brand_rights/governance_denied` scenario expects the brand agent to call `check_governance` before issuing a license. Added `accounts: { syncAccounts, syncGovernance }` handlers and a `checkGovernance()` call in the `acquireRights` example, returning `GOVERNANCE_DENIED` with findings propagated from the governance agent.
  - Seller idempotency section: referenced [adcontextprotocol/adcp-client#678](https://github.com/adcontextprotocol/adcp-client/issues/678) as a known grader-side limitation on the missing-key probe (MCP Accept header negotiation), so builders don't chase a skill fix for what's actually a grader issue.

## 5.8.0

### Minor Changes

- 809d02e: `adcp storyboard run` gains `--invariants <module[,module...]>`. The flag
  dynamic-imports each specifier before the runner resolves
  `storyboard.invariants`, giving operators a way to populate the assertion
  registry (adcp#2639) without editing the CLI. Relative paths resolve against
  the current directory; bare specifiers resolve as npm packages.

  Modules are expected to call `registerAssertion(...)` at import time. The
  flag runs before the `--dry-run` gate so bad specifiers surface immediately
  during preview, not after agent resolution and auth.

  Applies to `adcp storyboard run`, `adcp comply` (deprecated alias), and
  `adcp storyboard run --url` multi-instance dispatch.

- 46de887: Add `createComplyController` to `@adcp/client/testing` — a domain-grouped
  seller-side scaffold for the `comply_test_controller` tool. Takes typed
  `seed` / `force` / `simulate` adapters and returns `{ toolDefinition,
handle, handleRaw, register }` so a seller can wire the tool with a single
  `controller.register(server)` call.

  ```ts
  import { createComplyController } from '@adcp/client/testing';

  const controller = createComplyController({
    // Gate on something the SERVER controls — env var, resolved tenant flag,
    // TLS SNI match. Never trust caller-supplied fields like input.ext.
    sandboxGate: () => process.env.ADCP_SANDBOX === '1',
    seed: {
      product: ({ product_id, fixture }) => productRepo.upsert(product_id, fixture),
      creative: ({ creative_id, fixture }) => creativeRepo.upsert(creative_id, fixture),
    },
    force: {
      creative_status: ({ creative_id, status }) => creativeRepo.transition(creative_id, status),
    },
  });
  controller.register(server);
  ```

  The helper owns scenario dispatch, param validation, typed error
  envelopes (`UNKNOWN_SCENARIO`, `INVALID_PARAMS`, `FORBIDDEN`), MCP
  response shaping, and seed re-seed idempotency (same id + equivalent
  fixture returns `previous_state: "existing"`; divergent fixture returns
  `INVALID_PARAMS` without touching the adapter). Transition enforcement
  stays adapter-side so the controller and the production path share a
  single state machine.

  Hardened against common misuse: sandbox gate requires strict `=== true`
  (a gate that returns a truthy non-boolean denies, not allows); fixture
  keys `__proto__` / `constructor` / `prototype` are rejected with
  `INVALID_PARAMS`; the default seed-fixture cache is capped at 1000
  net-new keys to bound memory under adversarial seeding; and the
  `toolDefinition.inputSchema` is shallow-copied so multiple controllers
  on one process don't share a mutable shape.

  `list_scenarios` bypasses the sandbox gate so capability probes always
  succeed — buyer tooling can distinguish "controller exists but locked"
  from "controller missing", while state-mutating scenarios remain gated.
  `register()` emits a `console.warn` when no `sandboxGate` is configured
  and no `ADCP_SANDBOX=1` / `ADCP_COMPLY_CONTROLLER_UNGATED=1` env flag is
  set, so silent fail-open misuse becomes loud without breaking the
  optional-gate API shape.

  Also extends `TestControllerStore` with the five seed methods
  (`seedProduct`, `seedPricingOption`, `seedCreative`, `seedPlan`,
  `seedMediaBuy`) and exports `SEED_SCENARIOS`, `SeedScenario`,
  `SeedFixtureCache`, and `createSeedFixtureCache`. Existing
  `registerTestController` callers now pick up the seed surface and an
  internal idempotency cache for free. Closes #701.

- d8fd93f: Add `runConformance(agentUrl, opts)` — property-based fuzzing against an
  agent's published JSON schemas, exposed as a new `@adcp/client/conformance`
  subpath export so `fast-check` and the schema bundle stay off the runtime
  client path. Closes #691.

  Under the hood: `fast-check` arbitraries derived from the bundled draft-07
  schemas at `schemas/cache/latest/bundled/`, paired with a two-path oracle
  that classifies every response as **accepted** (validates the response
  schema), **rejected** (well-formed AdCP error envelope with a spec-enum
  reason code — the accepted rejection shape), or **invalid** (schema
  mismatch, stack-trace leak, credential echo, lowercase reason code,
  mutated context, or missing reason code). Responses that cleanly reject
  unknown references count as passes, not failures.

  Stateless tier covers 11 discovery tools across every protocol:
  `get_products`, `list_creative_formats`, `list_creatives`,
  `get_media_buys`, `get_signals`, `si_get_offering`,
  `get_adcp_capabilities`, `tasks_list`, `list_property_lists`,
  `list_content_standards`, `get_creative_features`. Self-contained-state
  and referential-ID tiers are tracked for follow-up releases.

  ```ts
  import { runConformance } from '@adcp/client/conformance';

  const report = await runConformance('https://agent.example.com/mcp', {
    seed: 42,
    turnBudget: 50,
    authToken: process.env.AGENT_TOKEN,
  });
  if (report.totalFailures > 0) process.exit(1);
  ```

  See `docs/guides/CONFORMANCE.md` for the full options reference.

- 7c0b146: Conformance fuzzer Phase 2 (#698) — referential tools, fixture injection,
  and `adcp fuzz` CLI.
  - **Referential stateless tools**: 6 new tools in the default run —
    `get_media_buy_delivery`, `get_property_list`, `get_content_standards`,
    `get_creative_delivery`, `tasks_get`, `preview_creative`. Random IDs
    exercise the rejection surface (agents must return
    `REFERENCE_NOT_FOUND`, not 500).
  - **Fixtures**: new `RunConformanceOptions.fixtures` option. When a
    request property name matches a pool (`creative_id`/`creative_ids`,
    `media_buy_id`/`media_buy_ids`, `list_id`, `task_id`, `plan_id`,
    `account_id`, `package_id`/`package_ids`), the arbitrary draws from
    `fc.constantFrom(pool)` instead of random strings — testing the
    accepted path on referential tools.
  - **`adcp fuzz <url>` CLI**: new subcommand with `--seed`, `--tools`,
    `--turn-budget`, `--protocol`, `--auth-token`, `--fixture name=a,b`,
    `--format human|json`, `--max-failures`, `--max-payload-bytes`, and
    `--list-tools`. Exits non-zero on failure. Reproduction hint on every
    failure: `--seed <seed> --tools <tool>`.

  ```bash
  adcp fuzz https://agent.example.com/mcp --seed 42
  adcp fuzz https://agent.example.com/mcp --fixture creative_ids=cre_a,cre_b --format json | jq
  ```

  New public exports: `REFERENTIAL_STATELESS_TOOLS`, `DEFAULT_TOOLS`,
  `ConformanceFixtures`, `SkipReason`.

- 73db0ac: Conformance fuzzer Stage 4 — creative seeding, configurable brand,
  broader stack-trace detection, additionalProperties probing, and stricter
  context-echo enforcement.

  **Coverage (A)**
  - **`sync_creatives` auto-seeder**: preflights `list_creative_formats`,
    picks the first format whose required assets are all of a simple type
    (image, video, audio, text, url, html, javascript, css, markdown),
    synthesizes placeholder values, and captures `creative_id`s from the
    response. Now runs as part of `seedFixtures` / `autoSeed`.
  - **`seedBrand` option** + **`--seed-brand <domain>`** CLI flag: overrides
    the mutating-seeder brand reference. Defaults to
    `{ domain: 'conformance.example' }`, which sellers with brand
    allowlists reject. Configurable per run.

  **Oracle (D)**
  - **JVM + .NET stack-trace signatures**: `at com.foo.Bar.method(Bar.java:42)`
    and `at Foo.Bar() in X.cs:line 42` shapes detected alongside the
    existing V8/Python/Go/PHP patterns.
  - **additionalProperties injection**: when a schema permits extra keys
    (`additionalProperties: true`), the generator sometimes injects one
    (~15% frequency, single extra key from a fixed vocabulary). Exercises
    the unknown-field tolerance surface — a common crash source where
    agents deserialize into strict structs and reject unexpected keys.
  - **Stricter context-echo**: when a response schema declares a
    top-level `context` property, dropping it entirely is now an invariant
    violation. Silent tolerance preserved for tools whose response schema
    omits the field.

  New public exports: extended `SeederName` with `'sync_creatives'`,
  `SeedOptions.brand`, `RunConformanceOptions.seedBrand`.

- 6b2a3b9: Conformance fuzzer Tier 3 — auto-seeding + update-tool fuzzing.
  - **`seedFixtures(agentUrl, opts)`** helper — creates a property list,
    a content-standards config, and (after a `get_products` preflight) a
    media buy on the agent, captures the returned IDs, and returns a
    `ConformanceFixtures` bag ready to pass to `runConformance`. Each
    seeder is best-effort: failures degrade to a recorded warning and an
    empty pool, never a thrown exception.
  - **`runConformance({ autoSeed: true })`** — runs the seeder first,
    merges results into `options.fixtures` (explicit fixtures win on
    conflict), and includes Tier-3 update tools (`update_media_buy`,
    `update_property_list`, `update_content_standards`) in the default
    tool list. The report carries `autoSeeded: boolean` and a
    `seedWarnings` array.
  - **`adcp fuzz --auto-seed`** CLI flag. `--list-tools` now marks
    Tier-3 tools with `(update — needs --auto-seed or --fixture)`. The
    human-readable report surfaces seeded IDs and any seed warnings.
  - New `standards_ids` fixture pool — `content_standards` uses
    `standards_id`, not `list_id`, so it gets its own key.

  ⚠️ Auto-seed mutates agent state. Point at a sandbox tenant — the
  fuzzer creates artifacts that the agent owns. There is no teardown.

  New public exports: `seedFixtures`, `UPDATE_TIER_TOOLS`,
  `DEFAULT_TOOLS_WITH_UPDATES`, and the `SeedOptions` / `SeedResult` /
  `SeederName` / `SeedWarning` types.

- 3de1e82: Storyboard runner now implements first-class branch-set grading, the
  `contributes: true` boolean shorthand, and the implicit-detection fallback
  the AdCP spec requires (adcp-client#693, adcp#2633, adcp#2646).

  **Authoring (parser):** phases can declare `branch_set: { id, semantics }`
  and contributing steps can use `contributes: true` as shorthand for
  `contributes_to: <enclosing phase's branch_set.id>`. Enforced at parse time:
  - `contributes: true` is only legal inside a phase that declares `branch_set:`.
  - A step MUST NOT set both `contributes` and `contributes_to` (ambiguous).
  - `contributes_to:` inside a branch-set phase MUST equal `branch_set.id`.
  - Phases declaring `branch_set:` MUST set `optional: true`.
  - `branch_set.semantics` must be a supported value (`any_of` today; future
    `all_of` / `at_least_n` are reserved). Unknown values are rejected at
    parse rather than silently skipping grading.

  **Grading (runner):** after all phases run, branch-set peers are re-graded
  per the schema rule (storyboard-schema.yaml "Per-step grading in any_of
  branch patterns"). Branch-set membership is resolved two ways:
  1. Explicit `branch_set: { id, semantics: 'any_of' }` declaration.
  2. Implicit fallback: an optional phase with a step declaring
     `contributes_to: <flag>` that matches a later `assert_contribution
check: any_of` target. Keeps pre-adcp#2633 storyboards working
     unchanged.

  When a peer contributes the flag, non-contributing peers' failing steps are
  re-labeled as `skipped: true` with a new canonical skip reason
  `peer_branch_taken` and the mandated detail format:

  ```
  <flag> contributed by <peer_phase_id>.<peer_step_id> — <this_phase_id> is moot
  ```

  Hard failures (non-optional phases and `presenceDetected` PRM 2xx paths,
  adcp-client#677) are exempt from re-grading — the invariants they enforce
  must stand even when a peer branch contributed.

  `peer_branch_taken` is distinct from `not_applicable` (coverage gap) and
  raw `failed` — dashboards can tell "agent took the other branch" apart
  from "agent misbehaved." When no peer contributes, failures stay raw and
  `assert_contribution` is the single signal that fails the storyboard.

  `comply.ts` observation generators (`check_governance` + slow-response)
  now guard on `!step.warnings?.length` so re-graded moot peers don't emit
  stale observations.

  No storyboard migration is required.

- 7fbbe96: Add `refs_resolve` cross-step storyboard validation (adcp#2597, adcp-client#670). A new check that asserts every ref in a source set (e.g., `products[*].format_ids[*]` from a prior `get_products`) resolves to a member of a target set (e.g., `formats[*].format_id` from the current `list_creative_formats`), using configurable `match_keys`. Supports `[*]` wildcard path segments via a new `resolvePathAll` helper, scope filtering by key (with `$agent_url` substitution for the agent under test), and three out-of-scope grading modes (`warn`, `ignore`, `fail`). Failed checks name the exact unresolved ref tuples in `actual.missing` and dedupe on the projected tuple so one bad ref across 50 products shows up once. `runValidations()` now accepts `storyboardContext` on its `ValidationContext` argument so cross-step checks can read prior-step outputs; existing call sites pass it through from the runner.

  Hardening for untrusted inputs:
  - `resolvePathAll` caps output at 10,000 terminal values to prevent wildcard fan-out OOM from a malicious agent response shaped for exponential expansion.
  - Path segments `__proto__`, `constructor`, and `prototype` are skipped, and `hasOwnProperty` gates each object lookup so a storyboard path cannot surface prototype-chain state into compliance reports.
  - Path strings over 1 KiB return an empty segment list rather than burning CPU on pathological input.
  - `scope.equals` normalizes trailing slashes on both sides when the scope key ends in `url`, so a storyboard author can pass a literal URL or `$agent_url` interchangeably.
  - `refsMatch` rejects a match when either side is missing a declared `match_key`, preventing two refs that both omit a key from fuzzy-matching on the others.

- 4116ea5: Reference verifier now grades negative RFC 9421 conformance vectors 021–027 (adcp-client#683, follow-up to #631). Vectors 021–026 were already implemented at the library level but skipped in the conformance suite via a three-location skip-list; 027 required a new verifier rule and a builder mutator.
  - **Vector 027 — unsigned webhook authentication**: `verifyRequestSignature` now rejects unsigned requests whose JSON body carries a non-empty `push_notification_config.authentication` object anywhere in the tree, returning `request_signature_required`. Applies regardless of whether the operation sits in `capability.required_for`, closing the downgrade path where an attacker who captured a bearer token could register webhook credentials and redirect callbacks. Scan is recursive (handles auth material nested inside arrays of pending updates), Content-Type independent (so an attacker can't evade by labeling the body `text/plain`), and bounded: body length is capped at 1 MB (oversized unsigned bodies fail closed with `request_signature_required` since we can't prove absence of webhook auth within our DoS budget) and recursion is capped at depth 64 to prevent stack-blowing on pathologically nested JSON. `storyboard/request-signing/builder` registers 027 as a passthrough mutator since the adversarial shape lives in the fixture body, not a programmatic mutation.
  - **Test harness — vector 026**: `test/request-signing-vectors.test.js` deferred its `canonicalTargetUri` precompute until a `replay_cache_entries` preload actually needs it. The eager call threw on non-ASCII-authority vectors inside harness setup before the verifier's own parse-time check could run.
  - **Skip-list cleanup**: `NEGATIVE_VECTORS_UNIMPLEMENTED` removed from `test/request-signing-vectors.test.js`; grader negative-count assertions in `test/request-signing-grader-e2e.test.js`, `test/request-signing-grader-mcp.test.js`, `test/request-signing-grader-vectors.test.js`, and `test/request-signing-runner-integration.test.js` updated from 26 to 27.

- 77ea1b9: Add schema-driven validation against the bundled AdCP JSON schemas on both
  the client and the server (closes adcp-client#688).

  **Client hooks** (on the `AdcpClient` / `SingleAgentClient` `validation`
  config, applied automatically via `TaskExecutor`):
  - `validation.requests: 'strict' | 'warn' | 'off'` — validate outgoing
    payloads before dispatch. `strict` throws `ValidationError`
    (`code: 'VALIDATION_ERROR'`) with a JSON Pointer to the offending field;
    `warn` logs to debug logs and continues. Default: `warn`.
  - `validation.responses: 'strict' | 'warn' | 'off'` — validate incoming
    payloads on receive. `strict` fails the task; `warn` logs and continues.
    Default: strict in dev/test, warn in production. Overrides the legacy
    `strictSchemaValidation` flag when set.

  **Server middleware** (opt-in on `createAdcpServer`'s `validation` config):
  - `validation.requests: 'strict'` — dispatcher returns
    `adcpError('VALIDATION_ERROR', …)` before the handler runs.
  - `validation.responses: 'strict'` — handler-returned drift surfaces as a
    `VALIDATION_ERROR` envelope; `warn` logs to the configured logger and
    returns the response unchanged.

  Validation uses the bundled JSON schemas shipped at
  `dist/lib/schemas-data/<adcp_version>/` — async response variants
  (`-submitted`, `-working`, `-input-required`) are selected by payload shape
  (`status` field), matching issue #688's spec. `additionalProperties` is
  left permissive so vendor extensions don't trip the validator. The
  `VALIDATION_ERROR` envelope carries the full issue list (pointer, message,
  keyword, schema path) under `details.issues` for programmatic indexing.

- eb675dc: Add a cross-step assertion registry to the storyboard runner
  (adcontextprotocol/adcp#2639). Storyboards now accept a top-level
  `invariants: [id, ...]` array that references assertions registered via
  `registerAssertion(spec)` from `@adcp/client/testing`. The runner resolves
  the ids at start (fails fast on unknowns), fires `onStart` → `onStep`
  (per step) → `onEnd` (once at the end), routes step-scoped failures into
  the step's `validations[]` as `check: "assertion"`, and records every
  result on a new `StoryboardResult.assertions[]` field. A failed assertion
  flips `overall_passed` — assertions are gating conformance signal, not
  advisory output.

  New public exports from `@adcp/client/testing`: `registerAssertion`,
  `getAssertion`, `listAssertions`, `clearAssertionRegistry`,
  `resolveAssertions`, and types `AssertionSpec`, `AssertionContext`,
  `AssertionResult`.

  Assertions encode cross-step properties that per-step checks can't
  express cleanly: governance denial never mutates, idempotency dedup
  across replays, context never echoes secrets on error, status
  transitions monotonic, and so on. The registry ships the framework;
  concrete assertion modules live alongside the specialisms that own them.

  No behavior change for storyboards that don't set `invariants`.

- 4981b6b: Add `SubstitutionObserver` + `SubstitutionEncoder` — paired runner-side
  and seller-side primitives for the catalog-item macro substitution rule
  (adcontextprotocol/adcp#2620) and its runtime conformance contract
  (adcontextprotocol/adcp#2638, test-kit
  `substitution-observer-runner`). Closes #696.

  The library is available both at the root import and at the dedicated
  `@adcp/client/substitution` subpath.

  **Seller side** — produce RFC 3986-conformant encoded values from
  raw catalog data:

  ```ts
  import { SubstitutionEncoder } from '@adcp/client/substitution';

  const encoder = new SubstitutionEncoder();
  const safe = encoder.encode_for_url_context(rawCatalogValue);
  const url = template.replace('{SKU}', safe);
  // Optional defense-in-depth guard at catalog ingest:
  encoder.reject_if_contains_macro(rawCatalogValue);
  ```

  **Runner side** — observe a creative preview and grade substitution
  per the test-kit contract:

  ```ts
  import { SubstitutionObserver } from '@adcp/client/substitution';

  const observer = new SubstitutionObserver();
  const records = observer.parse_html(preview_html);
  // (or)  const records = await observer.fetch_and_parse(url); // SSRF-policy-enforced
  const matches = observer.match_bindings(records, template, [
    { macro: '{SKU}', vector_name: 'reserved-character-breakout' },
  ]);
  for (const m of matches) {
    const r = observer.assert_rfc3986_safe(m);
    if (!r.ok) report(r); // { error_code, byte_offset, expected, observed }
  }
  ```

  Both surfaces share a single RFC 3986 implementation
  (`encodeUnreserved`, `equalUnderHexCasePolicy`, `isUnreservedOnly`) so
  one bug-fix path covers producer and verifier. The seven canonical
  fixture vectors from
  `static/test-vectors/catalog-macro-substitution.json` ship as
  `CATALOG_MACRO_VECTORS` for reuse by storyboards and tests.

  `enforceSsrfPolicy` / `enforceSsrfPolicyResolved` implement the
  contract's normative deny list (IPv4 + IPv6 CIDRs, cloud metadata
  hostnames, scheme allow-list, bare-IP-literal rejection in Verified
  mode, DNS revalidation of every resolved address). `fetch_and_parse`
  pins the request to the already-policy-checked address via undici's
  `connect.lookup`, closing the DNS rebinding window between
  resolve and connect.

  The observer additionally ships `assert_unreserved_only`,
  `assert_no_nested_expansion`, and `assert_scheme_preserved` covering
  the contract's stricter validations
  (`rfc3986_unreserved_only_at_macro_position`,
  `nested_expansion_not_re_scanned`, `url_scheme_preserved`).

  Custom-vector payloads (inline `raw_value` + `expected_encoded`) are
  SHA-256 redacted by default in error reports per the contract's
  `error_report_payload_policy`; canonical fixture values echo
  verbatim. Pass `{ include_raw_payloads: true }` to any assertion
  helper to override — NOT for Verified grading.

- c9977e5: Add `--webhook-receiver-auto-tunnel` for webhook-grading a remote agent from
  a local machine. Autodetects `ngrok` or `cloudflared` on `PATH`, spawns the
  tunnel pointed at the receiver, extracts the public URL, plumbs it into
  proxy mode, and tears the tunnel down on exit (including on SIGINT/SIGTERM).

  Use `ADCP_WEBHOOK_TUNNEL="<cmd> {port}"` to override detection with a
  custom tunnel command — the CLI passes the auto-assigned port via `{port}`
  substitution and captures the URL behind an explicit
  `ADCP_TUNNEL_URL=https://…` marker the custom command must emit on
  stdout/stderr. The marker convention avoids misrouting webhooks to docs or
  diagnostic URLs that tunnel binaries often log at startup; ngrok and
  cloudflared detections use vendor-pinned regexes for the same reason.

  The flag is mutually exclusive with `--webhook-receiver-public-url` and
  any `--webhook-receiver` mode (auto-tunnel already implies proxy), and
  (like `--webhook-receiver`) incompatible with `--multi-instance-strategy
multi-pass`. Skipped during `--dry-run` (the conflict validation still
  runs, but no tunnel is spawned).

  No spec change: the tunnel forwards ordinary HTTPS to the local receiver,
  so the `webhook_receiver_runner` parity invariant (`loopback_mock` ≡
  `proxy_url` for the same agent emitter path) holds. Spec-compliant with the
  test-kit's "MUST NOT require a specific tunnel vendor" rule — detection is
  PATH-based and vendor-agnostic. A hosted rendezvous service for graders
  that can't install a tunnel binary is tracked separately at
  adcontextprotocol/adcp#2618 (milestone 3.1.0).

- a4b8eb8: Expose the storyboard-runner webhook receiver on the CLI (closes adcp-client#675).
  Before this change, `adcp storyboard run` could not enable the `webhook_receiver`
  runtime plumbing that already existed on `runStoryboard`, so storyboards whose
  grading depends on observing outbound webhooks — `webhook-emission`,
  `idempotency`, and any sales specialism that grades `window_update` /
  IO-completion flows — skipped their webhook-assertion steps with
  `"Test-kit contract 'webhook_receiver_runner' is not configured on this runner."`
  even when the agent emitted fully spec-compliant signed RFC 9421 webhooks.

  Three new flags on `adcp storyboard run` / `adcp comply`:
  - `--webhook-receiver [MODE]` — host an ephemeral receiver. `MODE` is
    `loopback` (default; binds on 127.0.0.1) or `proxy` (operator-supplied
    public URL).
  - `--webhook-receiver-port PORT` — force a specific bind port; defaults to
    auto-assign.
  - `--webhook-receiver-public-url URL` — public HTTPS base URL for `proxy`
    mode (implies `--webhook-receiver proxy` when used alone).

  Setting any of these activates the receiver and adds `webhook_receiver_runner`
  to the run's `contracts` set so `requires_contract` gates resolve. The flags
  are also plumbed through `ComplyOptions` (`webhook_receiver`, `contracts`) so
  programmatic callers of `comply()` get the same behavior without dropping to
  `runStoryboard` directly.

### Patch Changes

- 745415f: Adds `docs/guides/VALIDATE-YOUR-AGENT.md` — the operator-facing checklist covering `adcp storyboard run`, `adcp fuzz` (Tier 1/2/3), `adcp grade request-signing`, multi-instance testing, `--webhook-receiver`, schema-driven validation hooks, custom `--invariants`, and `SubstitutionEncoder`/`Observer`. Cross-linked from `BUILD-AN-AGENT.md` and the repo `CLAUDE.md`.

  Ships `npm run compliance:skill-matrix` (new `scripts/manual-testing/run-skill-matrix.ts` driver + `skill-matrix.json`) which fans the existing `agent-skill-storyboard.ts` harness across skill × storyboard pairs with `--filter`, `--parallel`, and `--stop-on-first-fail`.

  Every `skills/build-*-agent/SKILL.md` replaces its ad-hoc `## Validation` section with a uniform `## Validate Locally` block: canonical storyboard IDs, cross-cutting bundles (`security_baseline,idempotency,schema_validation,error_compliance`), `adcp fuzz` with per-specialism `--tools`, per-specialism failure decoder, and a pointer back to the operator checklist. `build-retail-media-agent/SKILL.md` gains `SubstitutionEncoder.encode_for_url_context` wiring guidance for catalog-driven macro URLs.

- f233402: `security_baseline` runner now enforces RFC 9728 protected-resource metadata
  (PRM) validations whenever the agent serves PRM at all, closing a spoofing
  path (adcp-client#677) where an agent with a broken OAuth metadata document
  could pass the storyboard by also declaring an API key. Previously,
  `oauth_discovery`'s `optional: true` semantics swallowed failures of the
  `resource_equals_agent_url` and `http_status: 200` checks so long as the
  API-key path carried `auth_mechanism_verified`. Now:
  - A PRM response of **HTTP 404** skips the `oauth_discovery` phase cleanly
    (step reports `skip_reason: 'oauth_not_advertised'`, remaining phase steps
    cascade-skip). API-key-only agents that don't serve PRM see no change.
  - Any **HTTP 2xx** PRM response flips the phase into hard-fail mode: a
    wrong `resource` URL, missing `authorization_servers`, or unreachable
    authorization-server metadata fails the storyboard regardless of whether
    the API-key path also passes.
  - Other PRM statuses (401, 500, redirects, fetch errors) keep their
    existing swallow-on-optional behavior — the rule only tightens when the
    agent is honestly advertising OAuth.

  The semantic shift encoded here: the test-kit's `auth.api_key` declaration
  is an opt-IN to the API-key path, not an opt-OUT of the OAuth path. An
  agent that serves PRM must serve it correctly.

- bce4c9d: Route storyboard steps with `omit_idempotency_key: true` on mutating tasks through the raw-HTTP MCP probe so no SDK-layer normalization can inject a key onto the wire (adcp-client#678, adcp#2607). The `skipIdempotencyAutoInject` plumbing in `normalizeRequestParams`, `SingleAgentClient.executeAndHandle`, and `TaskExecutor.executeTask` already honors the flag, but a single regression in any of those sites would silently make every SDK-speaking agent pass the missing-key conformance vector vacuously. Dispatching via `rawMcpProbe` (the same path already used for `step.auth` overrides and `probeSignedRequest`) removes the escape hatch entirely.

  Scope: applies when `options.protocol` is `'mcp'` and `options.auth` is absent, `'bearer'`, or `'basic'`. OAuth and A2A stay on the SDK path — their dispatch requires refresh-capable tokens / a different envelope that the raw probe can't replicate — and continue to rely on the existing `skipIdempotencyAutoInject` plumbing. No YAML surface change: the existing `omit_idempotency_key: true` field on a mutating step is the trigger, matching how the runner already gates the runner-level `applyIdempotencyInvariant` skip.

  Hardening for outbound headers: bearer tokens and basic credentials are validated for CR/LF/non-printable ASCII before being placed in headers (errors name the offending field without echoing the value), empty bearer tokens fail loudly instead of silent SDK fallback, and basic-auth usernames containing `:` are rejected per RFC 7617. `X-Test-Session-ID` is added to `SECRET_KEY_PATTERN` so any future code path that persists outbound headers into compliance reports redacts it automatically.

- 0b4115f: Skill docs follow-ups from the agent-skill-storyboard harness runs:
  - `build-seller-agent/SKILL.md` § sales-guaranteed restructured to lead with a 3-row routing table (IO signing → `submitted` task envelope / `creative_assignments` empty → synchronous `pending_creatives` / otherwise → `active` with `confirmed_at`). The old section led with "IO approval = task envelope" and fresh Claude defaulted to `submitted` for every scenario, missing the `pending_creatives` path. The routing logic is now the first code block in the section.
  - `build-brand-rights-agent/SKILL.md` shrunk from 472 → 415 lines (~12%) by collapsing the duplicated idempotency and `Protecting your agent` content into pointers at the seller skill. The long skill was causing the `agent-skill-storyboard.ts` harness to time out before Claude wrote `server.ts`.
  - Dropped the stale "ai_generated_image not in enum" warning — upstream adcontextprotocol/adcp#2418 merged, enum now lists `ai_generated_image` + `image_generation`.

  No public-surface changes; docs-only patch.

- d51c8a5: Add test-runner guardrails so a single hung test can't consume hours of CPU (fixes #680):
  - `npm test` / `npm run test:lib` / `prepublishOnly` now pass `--test-timeout=60000`. A stuck test fails after 60s with a stack trace instead of spinning indefinitely at high CPU (previously `--test-force-exit` only fired after the runner finished, which a spinning test never reaches).
  - CI jobs in `.github/workflows/ci.yml` now declare `timeout-minutes` so a runaway job is capped at its wall-clock budget instead of eating up to the GitHub Actions default six-hour ceiling.
  - `CONTRIBUTING.md` and `AGENTS.md` document the `kill -QUIT <pid>` tip for dumping the V8 stack when a test appears hung.

- d2f1021: Register vector 027 (`webhook-registration-authentication-unsigned`) as a passthrough mutation in the request-signing builder. The fixture carries its adversarial shape in the vector itself (unsigned bearer-auth request with `push_notification_config.authentication` in the body) — no programmatic mutation needed, just preserve fixture bytes through `applyTransport`.

  This unblocks CI after the upstream compliance cache added vector 027. The verifier rule it exercises (`#webhook-security` — MUST require 9421 when authentication is present in a webhook registration body) is not yet implemented; vector 027 is added to the unimplemented-verifier skip lists alongside 021–026 until the rule lands.

## 5.7.0

### Minor Changes

- 7d33a92: AdCP 3.0 release blockers — SDK-level wiring for conformance-runner integration.

  **New subpath exports**
  - `@adcp/client/compliance-fixtures` — canonical `COMPLIANCE_FIXTURES` data for every hardcoded ID storyboards reference (`test-product`, `sports_ctv_q2`, `video_30s`, `native_post`, `native_content`, `campaign_hero_video`, `gov_acme_q2_2027`, `mb_acme_q2_2026_auction`, `cpm_guaranteed`, etc.) plus a `seedComplianceFixtures(server)` helper that writes fixtures into the state store under well-known `compliance:*` collections. Closes [#663](https://github.com/adcontextprotocol/adcp-client/issues/663).
  - `@adcp/client/schemas` — re-exports every generated Zod request schema plus `TOOL_INPUT_SHAPES` (ready-to-register `inputSchema` map covering non-framework tools like `creative_approval` and `update_rights`) and a `customToolFor(name, description, shape, handler)` helper. Closes [#667](https://github.com/adcontextprotocol/adcp-client/issues/667).

  **Server (`@adcp/client/server`)**
  - `createExpressAdapter({ mountPath, publicUrl, prm, server })` returns the four pieces an Express-mounted agent needs: `rawBodyVerify` (captures raw bytes for RFC 9421), `protectedResourceMiddleware` (RFC 9728 PRM at the origin root), `getUrl` (mount-aware URL reconstruction for the signature verifier), and `resetHook` (delegates to `server.compliance.reset()`). Closes [#664](https://github.com/adcontextprotocol/adcp-client/issues/664).
  - `requireAuthenticatedOrSigned({ signature, fallback, requiredFor, resolveOperation })` bundles presence-gated signature composition with `required_for` enforcement on the no-signature path. `requireSignatureWhenPresent` grew an options parameter that carries the same `requiredFor` + `resolveOperation` semantics. Unsigned requests with no credentials on a `required_for` operation throw `AuthError` whose cause is `RequestSignatureError('request_signature_required')`; valid bearer bypass stays valid. Closes [#665](https://github.com/adcontextprotocol/adcp-client/issues/665).
  - `respondUnauthorized({ signatureError })` emits a `WWW-Authenticate: Signature error="<code>"` challenge when the rejection comes from the RFC 9421 verifier. `serve()` auto-detects this via `signatureErrorCodeFromCause(err)` — the signed_requests negative-vector grader reads the error code off the challenge, so previously callers had to override the 401 response by hand.
  - `AdcpServer.compliance.reset({ force? })` drops session state and the idempotency cache between storyboards. Refuses to run in production-like deployments unless `force: true` is passed. `IdempotencyStore.clearAll` is now an optional method on the store; `memoryBackend` implements it, production backends leave it undefined. Closes [#666](https://github.com/adcontextprotocol/adcp-client/issues/666).

  **Testing (`@adcp/client/testing`)**
  - Request-signing grader accepts an `agentCapability` option. When present, vectors whose `verifier_capability` can't coexist with the agent's declared profile (`covers_content_digest` disagreement, vector-asserted `required_for` not in agent's list) auto-skip with `skip_reason: 'capability_profile_mismatch'`. `skipVectors` stays available for operator-driven overrides. Closes [#668](https://github.com/adcontextprotocol/adcp-client/issues/668).

- 5b2ebb3: v3 audit follow-ups — tightened per expert review:

  **Build pipeline**
  - `build:lib` now runs `sync-version` before `tsc` so `src/lib/version.ts` can't drift from `package.json` across changeset-driven bumps. `sync-version` now validates both version strings against `/^[0-9A-Za-z.\-+]+$/` to prevent template injection into the generated TS file.

  **sync_creatives validator**
  - New `SyncCreativesItemSchema`, `SyncCreativesSuccessStrictSchema`, and `SyncCreativesResponseStrictSchema` exports. The strict schema enforces: required `creative_id` + `action`; spec's conditional that `status` MUST be absent when `action ∈ {failed, deleted}`; `preview_url` limited to `http(s):` URLs; ISO-8601 `expires_at`; `assignment_errors` key regex. Wired into `TOOL_RESPONSE_SCHEMAS` so pipeline-level strict validation catches per-item drift for `sync_creatives` responses automatically.

  **V3 guard**
  - New `VersionUnsupportedError` with typed `reason` ('version' | 'idempotency' | 'synthetic'). Agent URL stays on the instance property but is omitted from the default message to prevent leakage into shared log sinks.
  - `client.requireV3()` now corroborates the v3 claim: requires `majorVersions.includes(3)`, `adcp.idempotency.replayTtlSeconds` present, and rejects synthetic capabilities. Closes the "lying seller" bypass path.
  - New `allowV2` config option on `SingleAgentClientConfig` — per-client bypass; `ADCP_ALLOW_V2=1` env fallback only applies when `allowV2` is `undefined`. Enables safe use in multi-tenant deployments.
  - `requireV3ForMutations: true` opt-in gates mutating calls before dispatch.

## 5.6.0

### Minor Changes

- 0891b98: Add `multi-pass` multi-instance strategy for storyboard runner (#607)

  Opt-in via `--multi-instance-strategy multi-pass` (CLI) or
  `multi_instance_strategy: 'multi-pass'` (library). Runs the storyboard once
  per replica, each pass starting the round-robin dispatcher at a different
  replica. Ensures each step is exercised against a different replica across
  passes — surfacing bugs isolated to one replica (stale config, divergent
  version, local-cache miss) that single-pass round-robin can't distinguish
  from a success. Default stays `round-robin` to keep CI time predictable.

  `StoryboardResult` gains `passes?: StoryboardPassResult[]` with per-pass
  detail. Top-level `passed_count` / `failed_count` / `skipped_count` and
  `overall_passed` aggregate across passes; top-level `phases` remains the
  first pass for backward compatibility.

  Known limitation: for N=2, offset-shift preserves pair parity, so a
  write→read pair whose dispatch indices differ by an even amount lands
  same-replica in every pass (the canonical property_lists case:
  write at step 0, read at step 2, distance 2). Dependency-aware
  dispatch reading `context_inputs` (tracked as #607 option 2) is the
  recommended path for testing cross-replica state at N=2.

- 63b6de7: Add `requireSignatureWhenPresent(signatureAuth, fallbackAuth)` — presence-gated composition for RFC 9421 signatures (#659)

  `anyOf(verifyApiKey, verifySignatureAsAuthenticator)` has either-or
  semantics: a request with a valid bearer and a present-but-invalid
  signature is accepted because `anyOf` catches the sig adapter's
  `AuthError` and falls through. That's wrong for the `signed-requests`
  specialism, whose conformance vectors include negatives like
  `request_signature_revoked` and `request_signature_window_invalid`
  that must reject even when a bearer is also supplied.

  `requireSignatureWhenPresent` encodes the spec-compliant contract:

  | RFC 9421 signature header present? | Outcome                                                                                                 |
  | ---------------------------------- | ------------------------------------------------------------------------------------------------------- |
  | yes                                | signature authenticator runs; principal / `AuthError` / `null→AuthError` is final — fallback never runs |
  | no                                 | fallback runs verbatim                                                                                  |

  Presence is detected from either `Signature-Input` OR `Signature` — a
  request with only one of the pair is malformed but still signed intent
  and MUST NOT silently fall through to bearer. The existing
  `verifySignatureAsAuthenticator` adapter now recognizes the same pair
  (previously it required `Signature-Input`; a solo `Signature` header
  incorrectly fell through).

  The composed authenticator propagates `AUTH_NEEDS_RAW_BODY` when either
  branch needs it, so `serve()` still buffers `req.rawBody` ahead of
  authentication.

  **Composition guard**: the returned authenticator is tagged
  `AUTH_PRESENCE_GATED`; `anyOf` throws at wire-up time when any child
  carries the tag, because wrapping would re-open the bypass the gate
  exists to prevent. Invert the order instead:
  `requireSignatureWhenPresent(sig, anyOf(bearer, apiKey))`.

  ```ts
  import {
    serve,
    anyOf,
    verifyApiKey,
    verifyBearer,
    verifySignatureAsAuthenticator,
    requireSignatureWhenPresent,
  } from '@adcp/client/server';

  serve(createAgent, {
    authenticate: requireSignatureWhenPresent(
      verifySignatureAsAuthenticator({ jwks, replayStore, revocationStore, capability, resolveOperation }),
      anyOf(verifyApiKey({ keys }), verifyBearer({ jwksUri, issuer, audience }))
    ),
  });
  ```

  New public exports: `requireSignatureWhenPresent`, `AUTH_PRESENCE_GATED`,
  `tagAuthenticatorPresenceGated`, `isAuthenticatorPresenceGated`.

## 5.5.0

### Minor Changes

- c3eb9a1: feat(server): bearer-or-signature composition (#655) + capability overrides (#654)

  Two additions for downstream agents that claim the `signed-requests` specialism
  and/or need to surface per-domain capability fields the framework doesn't
  auto-derive.

  **`verifySignatureAsAuthenticator` (#655).** New adapter that turns
  `verifyRequestSignature` into an `Authenticator` composable with
  `anyOf(verifyApiKey(...), verifySignatureAsAuthenticator(...))`. Lets a single
  endpoint accept either bearer credentials OR a valid RFC 9421 signature —
  previously, mounting the Express-shaped verifier downstream of a bearer gate
  caused signed-but-unauthed requests to fail 401 before the verifier ran.

  ```ts
  import { serve, verifyApiKey, anyOf, verifySignatureAsAuthenticator } from '@adcp/client/server';

  serve(createAgent, {
    authenticate: anyOf(
      verifyApiKey({ keys: { sk_live_abc: { principal: 'acct_42' } } }),
      verifySignatureAsAuthenticator({
        jwks,
        replayStore,
        revocationStore,
        capability: { supported: true, required_for: [], covers_content_digest: 'either' },
        resolveOperation: req => {
          try {
            const body = JSON.parse(req.rawBody ?? '');
            if (body.method === 'tools/call') return body.params?.name;
          } catch {}
          return undefined;
        },
      })
    ),
  });
  ```

  `serve()` now buffers `req.rawBody` before authentication when any wired
  authenticator carries the `AUTH_NEEDS_RAW_BODY` tag (the signature adapter
  sets it; `anyOf` propagates it). Bearer-only and JWT-only configurations are
  unaffected — buffering stays deferred until preTransport runs.

  **`capabilities.overrides` (#654).** New per-domain merge field on
  `AdcpCapabilitiesConfig`. Deep-merges on top of the framework's auto-derived
  `get_adcp_capabilities` response so agents can surface fields like
  `media_buy.execution.targeting.*`, `media_buy.audience_targeting`,
  `media_buy.content_standards.supported_channels`, or
  `compliance_testing.scenarios` without reaching for `getSdkServer()` to
  replace the tool.

  ```ts
  createAdcpServer({
    name: 'My Seller',
    version: '1.0.0',
    mediaBuy: {
      /* handlers */
    },
    capabilities: {
      features: { audienceTargeting: true },
      overrides: {
        media_buy: {
          execution: { targeting: { geo_countries: true, language: true } },
          audience_targeting: {
            supported_identifier_types: ['hashed_email'],
            minimum_audience_size: 500,
          },
        },
        compliance_testing: { scenarios: ['force_media_buy_status'] },
      },
    },
  });
  ```

  Nested objects merge; arrays and primitives replace; `null` on a top-level
  override removes the auto-derived block. Top-level fields the framework owns
  (`adcp`, `supported_protocols`, `specialisms`, `extensions_supported`) stay
  managed by their dedicated config fields.

  New exports from `@adcp/client/server`:
  `verifySignatureAsAuthenticator`, `VerifySignatureAsAuthenticatorOptions`,
  `AUTH_NEEDS_RAW_BODY`, `tagAuthenticatorNeedsRawBody`,
  `authenticatorNeedsRawBody`, `AdcpCapabilitiesOverrides`.

## 5.4.0

### Minor Changes

- e6abfdd: Ship five downstream-ergonomics fixes surfaced while porting a training agent onto 5.3. One public-type change (breaking for pre-release consumers only — the type never reached a stable release), four additive.

  **BREAKING (pre-release only) — `createAdcpServer()` returns `AdcpServer` instead of SDK `McpServer`.** Re-exporting the SDK's `McpServer` type forced consumers through a specific module resolution path. A TypeScript ESM consumer importing `@adcp/client` (CJS) and separately importing `@modelcontextprotocol/sdk` (ESM) got two structurally-identical but distinct `McpServer` types — the SDK's private `_serverInfo` field breaks assignment compatibility between them. Owning the type on our side eliminates the hazard for every consumer. `AdcpServer` exposes `connect`, `close`, and the new `dispatchTestRequest`. Tool registration continues to flow through `createAdcpServer`'s domain-grouped handler config. For seller extensions outside `AdcpToolMap`, pass a `customTools` map in the same config — no `getSdkServer()` escape hatch required. `serve()` accepts both `AdcpServer` and raw `McpServer` (for `createTaskCapableServer` users). See `docs/migration-5.3-to-5.4.md` for the verbatim diffs.

  **`AdcpServer.dispatchTestRequest({ method, params })`** — encapsulated test-only dispatch so downstream harnesses stop writing `(server as any)._requestHandlers.get(...)`. The `'tools/call'` overload returns a typed `CallToolResult`; the generic fallback returns `unknown`.

  **`McpToolResponse.structuredContent` is now optional.** Error responses no longer need to fabricate an empty `structuredContent` to satisfy the type. All built-in success builders still populate it.

  **`SingleAgentClient.validateRequest` drops `schema.strict()`.** The storyboard runner's `applyBrandInvariant` injects top-level `brand`/`account` onto every outgoing request for run-scoped tenancy. Tools whose schema declares neither (`list_creative_formats`, `get_signals`, `activate_signal`, `sync_creatives`) had strict() rejecting the injection client-side BEFORE `adaptRequestForServerVersion` could strip by schema. Non-strict parse lets the injection flow to the adapter. Required-field and shape violations still reject. Typo detection on unknown top-level keys now happens server-side.

  **Storyboard runner `request_signing.transport: 'raw' | 'mcp'`.** Plumbs the existing grader option through the storyboard runner so MCP-only agents can pass the `signed-requests` specialism's vectors — each vector body is wrapped in a JSON-RPC `tools/call` envelope and posted to the `/mcp` mount instead of per-operation HTTP endpoints. Matches the `adcp grade request-signing --transport mcp` CLI flag.

## 5.3.0

### Minor Changes

- b6eb1ff: `createAdcpServer` auto-wires the RFC 9421 verifier when the seller declares the `signed-requests` specialism and provides `signedRequests: { jwks, replayStore, revocationStore }`. Startup-fails when `signedRequests` is configured without the specialism claim; logs a loud error when the specialism is claimed without a `signedRequests` config (to avoid breaking legacy manual `serve({ preTransport })` wiring). Closes the footgun where claiming the specialism didn't enforce it.
- 65d851a: Add `experimental_features` support on capabilities (adcp-client#627).

  `AdcpCapabilities` now carries an `experimentalFeatures?: string[]` field populated from the AdCP 3.0 GA `experimental_features` envelope on `get_adcp_capabilities` responses. New helper `supportsExperimentalFeature(caps, id)` lets consumers gate reliance on `x-status: experimental` surfaces (`brand.rights_lifecycle`, `governance.campaign`, `trusted_match.core`, etc.) on an explicit seller opt-in. `resolveFeature` handles the `experimental:<id>` namespace so `require()`/`supports()` flows work the same way they do for `ext:<name>` extensions.

  The `custom` vendor-pricing variant and the `per_unit` catchup from AdCP 3.0 GA were already picked up in the previous types regeneration — no type-surface changes ship with this release.

- b6eb1ff: Add fluent `result.match({...})` method on `TaskResult`. Mirrors the free-function `match(result, handlers)` so autocomplete on `result.` surfaces the handler-dispatch helper alongside the other accessors. Method is attached non-enumerably by the client when a result leaves `executeTask`/`pollTaskCompletion`/`resumeDeferredTask`, so `JSON.stringify(result)` and `{...result}` are unaffected. For hand-constructed results (test fixtures, custom middleware), call the exported `attachMatch(result)` helper or keep using the free function.
- b6eb1ff: Add `match(result, handlers)` — exhaustive, compile-time-checked handler for the `TaskResult` discriminated union. Replaces manual `if (result.status === ...)` narrowing at response sites. Optional `_` catchall makes handlers optional.

### Patch Changes

- 7d50ecf: Fix `applyBrandInvariant` scoping for tools whose schema declares `account` but not top-level `brand` (e.g. `get_media_buys`, `get_media_buy_delivery`, `list_creatives`). The helper was only injecting top-level `brand` and merging into an existing `account`; when the request-builder produced no `account`, `adaptRequestForServerVersion` would strip the unrecognized top-level `brand` and the run-scoped brand was lost on the wire. Now the helper constructs an `account` (via `resolveAccount(options)`) when the request omits one, so session scoping survives for every schema shape. Non-object `account` values (`null`, arrays) are still passed through unchanged. (adcp-client#643)
- b8edc63: Storyboard `error_code` validation now reads the spec-canonical `data.errors[0].code` envelope (per `core/error.json`), falling back to legacy locations (`adcp_error.code`, `error_code`, `code`, `error.code`) and the regex on `taskResult.error`. Previously, spec-conformant agents returning `{ errors: [...], context }` had their code extracted via regex instead of typed field access.
- cca6c57: Fix `ProtocolResponseParser.getStatus()` misclassifying spec-compliant AdCP v3 domain envelopes as MCP task-status envelopes. Four `ADCP_STATUS` literals (`completed`, `canceled`, `failed`, `rejected`) collide with domain status enums like `MediaBuyStatus` / `CreativeStatus`. Previously, a seller returning `cancel_media_buy` with `{ structuredContent: { status: "canceled", media_buy: {...}, adcp_version: "3.0.0" } }` got routed through `TaskExecutor`'s terminal-failure branch — the client returned `{ success: false, data: undefined, error: "Task canceled" }` on a successful cancellation.

  The parser now disambiguates using an envelope-shape check: exclusive task-lifecycle literals (`submitted`, `working`, `input-required`, `auth-required`) are trusted from `structuredContent.status` unconditionally; shared literals are only treated as task status when the envelope carries no keys outside the `ProtocolEnvelope` allowlist. Otherwise the response falls through to the `COMPLETED` fallback so Zod validators parse the domain payload. Unblocks the `media_buy_state_machine` storyboard on `cancel_buy` / `resume_canceled_buy`. Reported and root-caused by @fgranata in adcp-client#646.

- b6eb1ff: Extend `skills/build-seller-agent/SKILL.md` with a worked GDPR Art 22 / EU AI Act Annex III example — shows `plan.human_review_required` threaded through `createAdcpServer.mediaBuy.createMediaBuy` with `buildHumanOverride` on approval. No code changes.
- b6eb1ff: Flag the webhook HMAC-SHA256 authentication path as SDK-deprecated. Emits a one-time `console.warn` on first use per process; suppress with `ADCP_SUPPRESS_HMAC_WARNING=1`. `@deprecated` JSDoc tag added to `WebhookAuthentication.hmac_sha256`. HMAC remains in the AdCP spec as a legacy fallback for buyers that registered `push_notification_config.authentication.credentials`, so the SDK keeps supporting it — no hard removal date. Migrate to RFC 9421 webhook signatures when your counterparties are ready (see `docs/migration-4.30-to-5.2.md#webhook-hmac-legacy-deprecation`).
- 65d851a: Auto-inject `idempotency_key` on mutating storyboard requests and untyped `executeTask` calls (adcp-client#625).

  The storyboard runner now mints a UUID v4 `idempotency_key` on any mutating step whose `sample_request` omits one — matching how a real buyer operates, so compliance storyboards exercise handler logic rather than short-circuiting on the server's required-field check. Auto-injection applies to `expect_error` steps too, so scenarios that expect specific failures (GOVERNANCE_DENIED, UNAUTHORIZED, brand_mismatch, etc.) reach the error path they named instead of hitting INVALID_REQUEST first. Storyboards that intentionally test the server's missing-key rejection opt out with the new `step.omit_idempotency_key: true` flag.

  The underlying `normalizeRequestParams` helper now derives its mutating-task set from the Zod request schemas (`MUTATING_TASKS` in `utils/idempotency`) rather than a hand-maintained list. The Zod-derived set adds auto-injection for `acquire_rights`, `update_media_buy`, `si_initiate_session`, `si_send_message`, `build_creative`, and the property / collection / content-standards writes — all of which the spec declares as mutating but the hand-maintained list was missing. Any caller using `client.executeTask(<mutating-task>, params)` — typed or untyped — now receives the same auto-injected key the typed methods already minted via `executeAndHandle`.

- b6eb1ff: Add `docs/guides/idempotency-crash-recovery.md` — worked buyer-side recipe for crash-recovery using `IdempotencyConflictError` + `IdempotencyExpiredError` + natural-key lookup + `metadata.replayed`. No code changes.
- 4fd7091: Regenerate TypeScript types for the new `governance-aware-seller` specialism in `AdCPSpecialism`. Pure regeneration from upstream schemas — no code changes.
- 24131aa: Scope replay store by (keyid, @target-uri) instead of keyid alone (adcp#2460). A captured signature on one endpoint can no longer be replayed against another. Pass a `scope` argument to `ReplayStore.has/insert/isCapHit` — existing custom implementations must update their signatures.
- 8455c8e: Fix `adcp storyboard run <agent> --file <path.yaml>` erroring out with "Cannot combine a storyboard ID with --file". The CLI parser was not stripping `--file` and its value from the positional-argument list, so the file path collided with the storyboard-ID slot (adcp-client#637). `--file=<path>` (equals form) is now parsed too.
- 24131aa: Emit a one-time `console.warn` when a client receives v2 capabilities — v2 is unsupported as of AdCP 3.0 GA (2026-04-20, adcp#2220). Suppress with `ADCP_ALLOW_V2=1` env var or `adcp --allow-v2` on the CLI. Functional behavior unchanged — v2 paths still execute, just loud about it.
- 24131aa: Add `webhook_mode_mismatch` and `webhook_target_uri_malformed` to the webhook-signature error taxonomy (adcp#2467). Verifier now splits key-purpose failures into "no purpose declared" (`key_purpose_invalid`) vs "wrong purpose for mode" (`mode_mismatch`), and rejects malformed `@target-uri` components with a dedicated code before signature computation.

## 5.2.0

### Minor Changes

- 9c2d5cc: `BrandJsonJwksResolver` — discover a sender's webhook-signing keys from their `brand.json`.

  Receiver-side ergonomic: instead of pre-configuring a `jwks_uri` per counterparty, point the verifier at the sender's `brand.json` and the resolver walks `agents[]`, extracts the right `jwks_uri`, and delegates caching to `HttpsJwksResolver`. Delivers the `brand.json → JWKS auto-resolver` piece of the #631 follow-up list.

  **New**
  - `BrandJsonJwksResolver` — implements `JwksResolver`, pluggable into `verifyWebhookSignature.jwks` (or `verifyRequestSignature.jwks`).
  - `BrandJsonResolverError` + `BrandJsonResolverErrorCode` — typed error surface (`invalid_url`, `invalid_house`, `redirect_loop`, `redirect_depth_exceeded`, `fetch_failed`, `invalid_body`, `schema_invalid`, `agent_not_found`, `agent_ambiguous`, `jwks_origin_mismatch`). Verifier callers can fold transient failures into `webhook_signature_key_unknown` without parsing error message strings.
  - `BrandAgentType`, `BrandJsonJwksResolverOptions` — selector types (agent type plus optional `agentId` / `brandId`).

  **Behavior**
  - Follows `authoritative_location` and `house` redirect variants up to `maxRedirects` hops (default 3); loops and depth-exceeded chains are rejected explicitly.
  - Structurally validates every redirect target (scheme, no userinfo, no fragments smuggled into loop detection) before dispatch; the `house` string variant is gated on a bare-hostname regex so an attacker-supplied brand.json can't inject userinfo or paths via the `https://${house}/…` interpolation.
  - Honors the spec fallback: when `jwks_uri` is absent on the selected agent, defaults to `/.well-known/jwks.json` on the origin of the agent's `url` — **but only when that origin matches the final brand.json origin**. Cross-origin fallback is rejected with `jwks_origin_mismatch`; publishers hosting their agent on a different origin must declare an explicit `jwks_uri`.
  - Brand.json cache tracks `ETag` + `Cache-Control: max-age` (capped by `maxAgeSeconds`, default 1h). Unknown `kid` cascades: the inner JWKS refreshes first; if still unknown and the brand.json cooldown has elapsed, brand.json re-resolves to pick up a rotated `jwks_uri`.
  - Ambiguous selectors (multiple agents of the same type, no `agentId`) throw `agent_ambiguous` with a clear error listing the candidate ids.
  - All fetches go through `ssrfSafeFetch`, so an attacker-supplied brand.json or JWKS URL can't resolve to the receiver's private network or IMDS.

  **Example**

  ```typescript
  import {
    BrandJsonJwksResolver,
    verifyWebhookSignature,
    InMemoryReplayStore,
    InMemoryRevocationStore,
  } from '@adcp/client/signing';

  const jwks = new BrandJsonJwksResolver('https://publisher.example/.well-known/brand.json', {
    agentType: 'sales',
  });

  await verifyWebhookSignature(request, {
    jwks,
    replayStore: new InMemoryReplayStore(),
    revocationStore: new InMemoryRevocationStore(),
  });
  ```

- e557245: Request-signing verifier: tighten RFC 9421 conformance against new spec
  vectors (#2323) and adcp#2468.
  - `@target-uri` canonicalization now decodes percent-encoded unreserved
    bytes (RFC 3986 §6.2.2.2) so `%7E` and `~` produce a byte-identical
    signature base.
  - Verifier rejects at step 1 when a signed request carries duplicate
    Signature-Input dictionary keys, multi-valued Content-Type or
    Content-Digest headers covered by the signature, a non-ASCII
    authority (U-label), or userinfo on the `@authority` component.
  - Step 8 binds sig-params `alg` to the resolved JWK's `alg`: a missing
    JWK `alg`, an alg mismatch, or inconsistent kty/crv per RFC 8037
    (EdDSA↔OKP) / RFC 7518 (ES256↔EC/P-256) all fail with
    `request_signature_key_purpose_invalid`.
  - Compliance test-vector loader accepts `jwks_override` as an
    alternative to `jwks_ref`; the grader routes `jwks_override` vectors
    through the library verifier directly since a live HTTP probe can't
    mutate a target agent's JWKS per-vector.

- fd49ecc: Rollup 5.2.0 — bundles the work that went into the unpublished 6.0.0. Treat the
  heads-up section below as "breaking" if you're upgrading directly from 5.1.0.

  ## ⚠️ 5.1.0 → 5.2.0 — treat as MAJOR

  This rollup is labeled `minor` because 5.1.0 had negligible adoption and the jump from 4.x is the intended upgrade path. If you are on 5.1.0, **treat this as a major upgrade** — the following source-level breaks require code changes:
  - `VerifyResult` is now a discriminated union (`status: 'verified' | 'unsigned'`); branching on `result.keyid === ''` no longer works.
  - `TaskStatus` narrowed — `'governance-escalated'` removed; fold into `'governance-denied'` and inspect `governance.findings`.
  - `domain` → `protocol` rename threaded through public types, compliance cache paths, and `TasksGetResponse` / `TasksListRequest.filters` / `MCPWebhookPayload`.
  - `BudgetAuthorityLevel` type removed; migrate to `budget.reallocation_threshold` / `budget.reallocation_unlimited` and `plan.human_review_required`.

  See the "Heads-up if tracking 5.1.0 → 5.2.0" section below for full migration detail.

  ## Heads-up if tracking 5.1.0 → 5.2.0

  ### Verifier API v3 (closes #583 items 1 and 2, #584)

  `verifyRequestSignature` return shape is now a discriminated union:

  ```ts
  type VerifyResult =
    | { status: 'verified'; keyid: string; agent_url?: string; verified_at: number }
    | { status: 'unsigned'; verified_at: number };
  ```

  Pre-5.2 returned a `VerifiedSigner` with `keyid: ''` as a sentinel when the
  request was unsigned on an operation not in `required_for`. Consumers that
  branched on `result.keyid === ''` must now branch on `result.status`.

  `createExpressVerifier` updates `req.verifiedSigner` accordingly — the field is
  set only when `status === 'verified'`.

  `VerifyRequestOptions.operation` is now optional. Omitting it treats the
  operation as "not in any `required_for`" and returns an unsigned result.

  `ExpressMiddlewareOptions.resolveOperation` may now return `undefined` — bypass
  `required_for` enforcement without losing verifier coverage on signed paths.

  ### Governance status narrowing

  `GovernanceCheckResult.status` narrows to `'approved' | 'denied' | 'conditions'`.
  `TaskStatus` drops `'governance-escalated'`. `TaskResultFailure.status` narrows
  to `'failed' | 'governance-denied'`. If you branch on
  `result.status === 'governance-escalated'`, fold into `'governance-denied'` and
  inspect `governance.findings` for human-review signals.

  ### Governance `budget.authority_level` removed

  AdCP dropped `budget.authority_level` in favor of:
  - `budget.reallocation_threshold: number ≥ 0` / `budget.reallocation_unlimited: true` (mutually exclusive)
  - `plan.human_review_required: boolean` for GDPR Art 22 / EU AI Act Annex III

  Mapping: `agent_full → reallocation_unlimited: true`; `agent_limited → keep
reallocation_threshold`; `human_required → plan.human_review_required: true`.

  ### Compliance cache rename: `domain` → `protocol`

  `compliance/cache/{version}/domains/` → `.../protocols/`.
  `PROTOCOL_TO_DOMAIN` → `PROTOCOL_TO_PATH`. `ComplianceIndexDomain` →
  `ComplianceIndexProtocol`. `BundleKind` value `'domain'` → `'protocol'`.
  `AdCPDomain` → `AdCPProtocol`. `TasksGetResponse.domain` → `protocol`;
  `TasksListRequest.filters.{domain,domains}` → `{protocol,protocols}`;
  `MCPWebhookPayload.domain` → `protocol`. `PROTOCOLS_WITHOUT_BASELINE` removed.

  ### Generated-types cleanup (#621)

  Typeless JSON Schema nodes (e.g. `check_governance.conditions[].required_value`)
  now compile to `unknown` / `z.unknown()` instead of being narrowed to
  `Record<string, unknown>`. Spec-correct scalar responses from compliant agents
  no longer fail validation. Multi-pass dedup removes ~7000 lines from
  `core.generated.ts`.

  ### Property-list account migration

  AdCP 3.0 account migration absorbed. `BudgetAuthorityLevel` type removed.
  `DelegationAuthority` now re-exported from `./types/core.generated`.
  `PropertyListAdapter.listLists` filters by `account` primitive (not removed
  `principal`).

  ## Additions

  ### Idempotency for v3 mutating requests (#568, #569; upstream adcp#2315)
  - Client methods for mutating tools auto-generate UUID v4 `idempotency_key` when
    the caller omits one. Internal retries reuse the same key.
  - `result.metadata.idempotency_key` surfaces the sent key.
  - `result.metadata.replayed` surfaces whether the seller returned a cached
    response. Side-effect-emitting agents MUST check this before re-firing.
  - Typed errors: `IdempotencyConflictError` (mint fresh key), `IdempotencyExpiredError` (look up by natural key).
  - `result.errorInstance` carries a typed `ADCPError` subclass when available.
  - New `getIdempotencyReplayTtlSeconds()` on `SingleAgentClient` / `AgentClient`.
    Throws on v3 sellers that omit the REQUIRED declaration — no silent default.
  - `useIdempotencyKey(key)` BYOK helper validates format up-front.
  - Idempotency keys redacted in debug logs by default (`ADCP_LOG_IDEMPOTENCY_KEYS=1` to opt in).
    `redactIdempotencyKey(key)` exported.

  ### Server-side middleware (`@adcp/client/server`)
  - `createIdempotencyStore({ backend, ttlSeconds })` — RFC 8785 JCS payload
    canonicalization, atomic `putIfAbsent` claim step, auto-declares
    `adcp.idempotency.replay_ttl_seconds`, rejects low-entropy keys, excludes
    the echo-back `context` from the hash but keeps string-typed `context` on SI
    tools.
  - Backends: `memoryBackend()`, `pgBackend(pool, { tableName? })`.
  - `getIdempotencyMigration()` DDL + `cleanupExpiredIdempotency(pool)` periodic
    reclaim.
  - Guardrail: logs error when mutating handlers are registered without an
    idempotency store.

  ### OAuth zero-config + diagnostics
  - `NeedsAuthorizationError` — thrown automatically on 401 Bearer challenge;
    carries `agentUrl`, `resource`, `resourceMetadataUrl`, `authorizationServer`,
    `authorizationEndpoint`, `tokenEndpoint`, `registrationEndpoint`,
    `scopesSupported`, parsed challenge.
  - `discoverAuthorizationRequirements(agentUrl, options?)` — RFC 9728 +
    RFC 8414 walk.
  - `createFileOAuthStorage({ configPath, agentKey? })` — atomic writes against
    the CLI's agents.json.
  - `bindAgentStorage` / `getAgentStorage` — per-agent WeakMap storage binding.
  - OAuth tokens now thread through `ADCPMultiAgentClient` and the storyboard
    runner (previously bearer-only). `NonInteractiveFlowHandler` +
    `createNonInteractiveOAuthProvider(agent, { agentHint? })`.
  - `TestOptions.auth` accepts `{ type: 'oauth', tokens, client? }`.
  - CLI `adcp diagnose-auth <alias|url>` — end-to-end OAuth diagnostic with ranked
    hypotheses. `runAuthDiagnosis`, `parseWWWAuthenticate`,
    `decodeAccessTokenClaims`, `validateTokenAudience`, `InvalidTokenError`,
    `InsufficientScopeError` exported.

  ### Signing — HTTPS stores + structured headers + replay buckets
  - `HttpsJwksResolver(url, options)` — HTTPS-fetching JWKS with `ETag`,
    `Cache-Control`, lazy refetch on key-unknown, SSRF-guarded.
  - `HttpsRevocationStore(url, options)` — cached `RevocationSnapshot`, fails
    closed past `next_update + graceSeconds` with
    `request_signature_revocation_stale`.
  - Parser swap to `structured-headers` library (RFC 8941 / RFC 9651) — profile
    checks (required params, tag, alg allowlist, typing) stay as typed wrappers.
  - Time-bucket replay store — O(1) amortized `has`/`insert`/`isCapHit` on hot
    keyids. Default `maxEntriesPerKeyid` 1M → 100k.
  - `ssrfSafeFetch` — primitive blocking IMDS / private networks.

  ### Request-signing grader — MCP mode + review fixes
  - `GradeOptions.transport: 'raw' | 'mcp'` (default `'raw'`). MCP mode wraps
    vectors in `tools/call` envelopes and extracts `operation` from the vector
    URL's last path segment.
  - CLI: `adcp grade request-signing <agent-url>` with `--transport`,
    `--skip-rate-abuse`, `--rate-abuse-cap`, `--only`, `--skip`,
    `--allow-live-side-effects`, `--allow-http`, `--json`.
  - `GradeReport` exposes `passed_count` / `failed_count` / `skipped_count`.
  - Safety: vectors 016 (`replay_window`) and 020 (`rate_abuse`) auto-skip
    against non-sandbox endpoints unless `allowLiveSideEffects: true`.
  - `live_endpoint_warning` replaces misleading `endpoint_scope_warning`.
  - Skipped vectors report as `skipped: true` (not scored as failures).
  - Hardened `extractSignatureErrorCode` (alphabet-constrained),
    `splitChallenges` (quote-state tracked).
  - New test-agent `test-agents/seller-agent-signed-mcp.ts`.

  ### Storyboard runner — multi-instance mode
  - `runStoryboard` accepts an array of agent URLs. Steps round-robin across
    replicas so writes on one instance must be visible on another. Canonical
    `write on [#A] → read on [#B] → NOT_FOUND` failure signature.
  - CLI: repeated `--url` engages multi-instance mode (minimum 2). JSON output
    gains `agent_urls[]`, `multi_instance_strategy`, per-step `agent_url` +
    `agent_index`. `--dry-run` prints the assignment plan.
  - Guide: `docs/guides/MULTI-INSTANCE-TESTING.md`. Implements client-side half
    of adcp#2363; closes adcp#2267.

  ### Governance helpers
  - `buildHumanReviewPlan(input)` — stamps `human_review_required: true`.
  - `buildHumanOverride({ reason, approver, approvedAt? })` — builds the artifact
    for downgrading `human_review_required: true → false` on re-sync. Validates
    reason ≥20 chars, approver is an email, no control chars, ISO 8601 dates.
  - `validateGovernancePlan(plan)` — client-side XOR + Annex III invariant check
    that codegen drops from `if/then`.
  - Constants: `REGULATED_HUMAN_REVIEW_CATEGORIES`, `ANNEX_III_POLICY_IDS`.

  ### Idempotency storyboard end-to-end
  - Middleware stamps `metadata.replayed: false` on every mutating response (not
    just replays).
  - Replay echoes the current retry's `context` (middleware strips `context`
    before caching; re-injects on replay).
  - MCP-level `idempotency_key` relaxed to optional when the framework has an
    idempotency store wired — middleware returns structured `adcp_error`.
  - Harness: `$generate:uuid_v4[#alias]` placeholder, forwarded
    `idempotency_key`, `$context.<key>` in validation `value` / `allowed_values`,
    `TaskOptions.skipIdempotencyAutoInject` for compliance runs.

  ## Fixes
  - Governance E2E — removed stale `plan.campaigns` assertion; approve test now
    picks a `fixed_price` pricing option (was `[0]`, which broke on agents that
    ordered auction options first). Closes #613.
  - Property-list storyboard — brand-injection builders removed so runner falls
    through to spec-correct `account` primitive. Closes #577.
  - Governance: dropped non-spec `'escalated'` status. Closes #589.
  - Protocol rename `domain` → `protocol` threaded end-to-end.
  - Request-signing grader vector 010 (`content-digest-mismatch`) now tests
    lying-signer detection, vector 009 (`key-purpose-invalid`) honors pinned
    `jwks_ref`.

  ## Public API additions (overview)

  ```ts
  // Client
  import {
    IdempotencyConflictError,
    IdempotencyExpiredError,
    NeedsAuthorizationError,
    generateIdempotencyKey,
    isMutatingTask,
    isValidIdempotencyKey,
    canonicalize,
    canonicalJsonSha256,
    closeMCPConnections,
    adcpErrorToTypedError,
    useIdempotencyKey,
    redactIdempotencyKey,
    discoverAuthorizationRequirements,
    createFileOAuthStorage,
    bindAgentStorage,
    getAgentStorage,
    createNonInteractiveOAuthProvider,
    runAuthDiagnosis,
    parseWWWAuthenticate,
    decodeAccessTokenClaims,
    validateTokenAudience,
    InvalidTokenError,
    InsufficientScopeError,
    buildHumanReviewPlan,
    buildHumanOverride,
    validateGovernancePlan,
    REGULATED_HUMAN_REVIEW_CATEGORIES,
    ANNEX_III_POLICY_IDS,
    type MutatingRequestInput,
    type IdempotencyCapabilities,
  } from '@adcp/client';

  // Server
  import {
    createIdempotencyStore,
    memoryBackend,
    pgBackend,
    hashPayload,
    getIdempotencyMigration,
    cleanupExpiredIdempotency,
    HttpsJwksResolver,
    HttpsRevocationStore,
    type IdempotencyStore,
    type IdempotencyBackend,
  } from '@adcp/client/server';
  ```

- 7e5d228: Server-side authentication middleware: API key, OAuth JWT, or both.

  AdCP agents MUST authenticate incoming requests (per the `security_baseline` storyboard in the universal track). This release adds first-class middleware so sellers can wire auth in ~5 lines.

  **New**
  - `verifyApiKey({ keys? | verify? })` — static or dynamic API-key authenticator.
  - `verifyBearer({ jwksUri, issuer, audience, requiredScopes? })` — OAuth 2.0 JWT validation via `jose` + JWKS. Strict audience enforcement catches the "resource URL mismatch" class of bug. Defaults to an asymmetric-only algorithm allowlist (RS*/ES*/PS\*/EdDSA) to block algorithm-confusion attacks, and extracts scopes from both `scope` (string) and `scp` (string | array) claims.
  - `anyOf(a, b, ...)` — combinator for accepting API key OR OAuth. Wraps rejections in a sanitized `AuthError` so probing attackers can't learn expected-audience or token-shape details from error responses.
  - `respondUnauthorized(req, res, opts)` — RFC 6750-compliant 401/403 with `WWW-Authenticate: Bearer`. `realm` defaults to `"mcp"` (stable) instead of the attacker-controlled `Host` header.
  - `AuthError` — exported error class with a sanitized `publicMessage`; the underlying implementation error is preserved as `cause` for server-side logging.
  - `ServeOptions.authenticate` — plug any authenticator into `serve()`; no request reaches the MCP transport without passing.
  - `ServeOptions.publicUrl` — canonical https:// URL of the MCP endpoint. Required when `protectedResource` is configured. The RFC 9728 `resource` field, the RFC 6750 `resource_metadata` URL on 401 challenges, and the JWT audience all come from this — closes a Host-header phishing vector where a server would otherwise advertise whatever host a caller sent.
  - `ServeOptions.protectedResource` — advertise OAuth 2.0 protected-resource metadata (RFC 9728) at `/.well-known/oauth-protected-resource<mountPath>`.
  - MCP `AuthInfo` propagation — `serve()` sets `req.auth` from the auth principal (token, clientId, scopes, expiresAt, extra) so MCP tool handlers receive it via `extra.authInfo`. `createAdcpServer` handlers see it on `ctx.authInfo`.

  **Skills**
  - `build-seller-agent/SKILL.md` gains a full "Protecting your agent" section with API key, OAuth, and both-at-once examples, plus a conformance checklist.
  - Short "Protecting your agent" section added to every other `build-*-agent` skill (signals, creative, retail-media, governance, si, brand-rights, generative-seller) so every agent-builder walks past the auth prompt on their way to validation.

  **Dependency**
  - Promoted `jose` from transitive to direct (it was already in the tree via `@modelcontextprotocol/sdk`).

- 2756df6: Storyboard runner: outbound-webhook conformance grading (adcontextprotocol/adcp#2426, matching the spec shape from adcontextprotocol/adcp#2431).

  **Storyboard runtime:**
  - `runStoryboard` / `runStoryboardStep` accept a `webhook_receiver` option that binds an ephemeral HTTP listener (loopback-mock mode default; `proxy_url` mode accepts an operator-supplied public base). The receiver mints per-step URLs under `/step/<step_id>/<operation_id>` and exposes `{{runner.webhook_base}}` / `{{runner.webhook_url:<step_id>}}` substitutions so storyboards inject them into `push_notification_config.url`. Downstream filters pick up the same operation_id via `{{prior_step.<step_id>.operation_id}}`.
  - Three new pseudo-tasks (step `task` values, not validation checks):
    - **`expect_webhook`** — asserts a matching delivery arrived carrying a well-formed `idempotency_key` (pattern `^[A-Za-z0-9_.:-]{16,255}$`). Optional `expect_max_deliveries_per_logical_event` caps distinct logical events in the window — catches publishers that re-execute on replay under a fresh key.
    - **`expect_webhook_retry_keys_stable`** — configures the receiver to reject the first N deliveries with a configurable 5xx, then asserts every observed delivery carries the byte-identical `idempotency_key`. Fails with `insufficient_retries`, `idempotency_key_rotated`, or `idempotency_key_format_changed`.
    - **`expect_webhook_signature_valid`** — delegates to the new RFC 9421 webhook verifier. Grades `not_applicable` when `webhook_signing` is not configured on runStoryboard options.
  - `requires_contract` on any webhook-assertion step grades `not_applicable` when the contract id is not listed in `options.contracts` — lets cross-cutting storyboards (e.g. idempotency) reference webhook assertions without forcing every runner to host a receiver.

  **RFC 9421 webhook signing:**
  - `verifyWebhookSignature` in `@adcp/client/signing/server` — 14-step verifier checklist per `docs/building/implementation/security.mdx#verifier-checklist-for-webhooks`. Tag `adcp/webhook-signing/v1`, mandatory covered components `@method`, `@target-uri`, `@authority`, `content-type`, `content-digest`, key purpose `adcp_use: "webhook-signing"`. Throws `WebhookSignatureError` with a specific `webhook_signature_*` code.
  - `signWebhook` in `@adcp/client/signing/client` — companion signer for publishers emitting conformant webhooks.
  - `WEBHOOK_SIGNING_TAG` and `WEBHOOK_MANDATORY_COMPONENTS` constants exported from both sub-barrels.

  **Test coverage:** 25 new tests across `test/lib/storyboard-webhook-receiver.test.js` and `test/lib/storyboard-webhook-signature.test.js` covering per-step routing, retry-replay policy, runner-variable substitution, every expect_webhook\* error code, and a full E2E flow with a signing publisher.

- b4709ad: Regenerated types from latest AdCP schemas. Adds `idempotency_key` (required, string) to webhook payloads — `MCPWebhookPayload`, `ArtifactWebhookPayload`, `CollectionListChangedWebhook`, `PropertyListChangedWebhook` — and renames `RevocationNotification.notification_id` → `idempotency_key`.

  Upstream migrated these surfaces to a single canonical dedup field. Receivers must dedupe by `idempotency_key` scoped to the authenticated sender identity. Publishers populating `RevocationNotification.notification_id` must rename the field.

- 6ec01c6: Regenerated types from latest AdCP schemas.
  - `CreateMediaBuyResponse` union gains `CreateMediaBuySubmitted` — async task envelope with `status: 'submitted'` and `task_id`, returned when a media buy cannot be confirmed synchronously (IO signing, governance review, batched processing). The `media_buy_id` and `packages` land on the completion artifact, not this envelope.
  - `PushNotificationConfig.authentication` is now optional and deprecated. Omitting it opts in to the RFC 9421 webhook profile (the default in 4.0); Bearer and HMAC-SHA256 remain for legacy compatibility only.
  - `RightUse` adds `ai_generated_image`.

  Consumers of `CreateMediaBuyResponse` that exhaustively discriminate on the union must handle the new `'submitted'` branch.

- 078b52c: Publisher-side webhook emission — the symmetric counterpart to PR #629's receiver-side dedup.

  **New `createWebhookEmitter`** in `@adcp/client/server`. One `emit(url, payload, operation_id)` call and the emitter handles:
  - RFC 9421 signing with a fresh nonce per attempt (adcp#2423).
  - Stable `idempotency_key` per `operation_id` reused across retries (adcp#2417) — regenerating on retry is the highest-impact at-least-once-delivery bug the runner-side conformance suite catches.
  - JSON serialized once with compact separators (`,` / `:`, no spaces) and posted byte-identically — the signature-base input and the wire body come from the same bytes, preventing the Python `json.dumps` default-spacing trap pinned by adcp#2478.
  - Retry with exponential backoff + jitter on 5xx / 429. Terminal on 4xx and on 401 responses carrying `WWW-Authenticate: Signature error="webhook_signature_*"` (retrying a signature failure produces identical bytes and identical rejection).
  - Pluggable `WebhookIdempotencyKeyStore` (default in-memory) — swap in a durable backend for multi-replica publishers.
  - HMAC-SHA256 / Bearer fallback modes for legacy buyers that registered `push_notification_config.authentication.credentials`. HMAC path uses the same compact-separators pinning.

  **`createAdcpServer` integration.** New `webhooks?: { signerKey, retries?, idempotencyKeyStore?, ... }` config option. When set, `ctx.emitWebhook` is populated on every handler's context — completion handlers post signed webhooks without constructing the signer, fetching, or tracking idempotency themselves:

  ```ts
  createAdcpServer({
    name,
    version,
    webhooks: { signerKey: { keyid, alg: 'ed25519', privateKey: jwk } },
    mediaBuy: {
      createMediaBuy: async (params, ctx) => {
        const media_buy_id = await persist(params);
        await ctx.emitWebhook({
          url: params.push_notification_config.url,
          payload: { task: { task_id, status: 'completed', result: { media_buy_id } } },
          operation_id: `create_media_buy.${media_buy_id}`,
        });
        return { media_buy_id, packages: [] };
      },
    },
  });
  ```

  **Full-stack E2E test.** `test/lib/webhook-emitter-server-e2e.test.js`: `createAdcpServer` with a real handler → `ctx.emitWebhook` → real HTTP POST → receiver captures → `verifyWebhookSignature` accepts. No mocks on the signer or verifier path. Closes the "we haven't spun up an actual server and watched the full stack verify" gap flagged during PR #631 review.

  **Exports** from `@adcp/client/server`:
  - `createWebhookEmitter`, `memoryWebhookKeyStore`
  - Types: `WebhookEmitter`, `WebhookEmitterOptions`, `WebhookEmitParams`, `WebhookEmitResult`, `WebhookEmitAttempt`, `WebhookEmitAttemptResult`, `WebhookIdempotencyKeyStore`, `WebhookRetryOptions`, `WebhookAuthentication`
  - `HandlerContext.emitWebhook` — new optional field, populated when `webhooks` config is set.

- 7b76326: Webhook receiver-side deduplication via `AsyncHandlerConfig.webhookDedup`.

  AdCP webhooks use at-least-once delivery — publishers retry until they see a 2xx, so the same event can arrive more than once. The spec now requires an `idempotency_key` on every MCP, governance, artifact, and revocation webhook payload so receivers have a canonical dedup field. This release plumbs that key through the client pipeline and ships a drop-in dedup layer for the MCP envelope path.

  **New**
  - `AsyncHandlerConfig.webhookDedup?: { backend: IdempotencyBackend; ttlSeconds?: number }` — drop duplicate deliveries with a single config. Reuses `IdempotencyBackend` from `@adcp/client/server`, so the same `memoryBackend()` or `pgBackend(...)` used for request-side idempotency can back webhook dedup. Defaults to 24h retention.
  - `WebhookMetadata.idempotency_key?: string` — extracted from the MCP envelope and passed to every `onXxxStatusChange` handler so application code can log, trace, or build its own dedup on top.
  - `WebhookMetadata.protocol?: 'mcp' | 'a2a'` — transport that delivered the webhook; useful for handler code that branches on protocol (A2A lacks `idempotency_key`).
  - `Activity` union gains `'webhook_duplicate'` — surfaced via `onActivity` when a repeat key is dropped. The typed handler is NOT called for duplicates.
  - `Activity.idempotency_key?: string` — surfaced on both `webhook_received` and `webhook_duplicate` for correlation.

  **Type changes (strict-TS callers may need to update)**
  - The `Activity.type` union gains `'webhook_duplicate'`. TypeScript users doing exhaustive `switch (activity.type)` with a `never`-check will see a new missing-case error. Treat `webhook_duplicate` the same as `webhook_received` in `onActivity` logging, or branch on `activity.type` to suppress side effects for duplicates.

  **Behavior**
  - Scope is per-agent under a reserved prefix (`adcp\u001fwebhook\u001fv1\u001f{agent_id}\u001f{idempotency_key}`) — keys from different senders are independent, and the prefix guarantees no collision with request-side idempotency entries when sharing a backend.
  - `putIfAbsent` closes the concurrent-retry race: when two retries race on the same fresh key, exactly one wins the claim and dispatches; the rest surface as `webhook_duplicate`.
  - MCP payloads missing or violating the `idempotency_key` format (`^[A-Za-z0-9_.:-]{16,255}$`) dispatch without dedup and log a `console.warn` with the spec pattern and a docs pointer. A2A payloads (which do not carry the field) dispatch silently — the absence is expected and unactionable.
  - Handler exceptions inside the dispatched handler are caught and logged as today; the dedup claim is intentionally NOT released on handler error. This preserves at-most-once handler execution: the publisher sees 2xx once (because `handleWebhook` returns normally) and won't retry, so releasing the claim would only matter on a future unrelated retry of the same key, which is never expected.

  **Schema sync**
  - `MCPWebhookPayload`, `CollectionListChangedWebhook`, `PropertyListChangedWebhook`, `ArtifactWebhookPayload`, and `RevocationNotification` now include `idempotency_key` as a required field (picked up from AdCP `latest`).

  **Example**

  ```typescript
  import { AdCPClient } from '@adcp/client';
  import { memoryBackend } from '@adcp/client/server';

  const client = new AdCPClient(agents, {
    webhookUrlTemplate: 'https://your-app.com/adcp/webhook/{task_type}/{agent_id}/{operation_id}',
    webhookSecret: process.env.WEBHOOK_SECRET,
    handlers: {
      webhookDedup: { backend: memoryBackend() },
      onCreateMediaBuyStatusChange: async (result, metadata) => {
        // First delivery runs here; publisher retries are dropped.
      },
    },
  });
  ```

  Governance list-change / artifact / brand-rights revocation webhooks are not yet routed through `AsyncHandler`; dedup for those payload types is a follow-up.

- 2756df6: Close the webhook-signing conformance gap after adcontextprotocol/adcp#2445 merged canonical test vectors.

  **Error enum aligned with merged spec.** The webhook-signature error taxonomy (`security.mdx#webhook-callbacks`) folds every window-level failure into a single `webhook_signature_window_invalid` code — `webhook_signature_expired` isn't in the enum. Drops our stray `_expired` code; adds `webhook_signature_rate_abuse` (per-keyid cap exceeded, step 9a) and `webhook_signature_revocation_stale` (revocation list past grace). Verifier step numbers realigned to the canonical 1–13 + 9a.

  **Parser now enforces the single-alphabet rule.** RFC 9421 `Signature` / `Content-Digest` tokens that mix base64url (`[-_]`) with standard-base64 (`[+/=]`) are ambiguous and the spec mandates rejection with `*_header_malformed`. Both verifiers inherit the fix.

  **Storyboard error enum** extended in lockstep: `signature_window_invalid` replaces `signature_expired`, plus `signature_rate_abuse`, `signature_revocation_stale`, `signature_alg_not_allowed`, `signature_components_incomplete`, `signature_header_malformed`, `signature_params_incomplete`. Exhaustive mapping catches new verifier codes at compile time.

  **Conformance harness.** Vendored the 7 positive + 21 negative vectors from adcontextprotocol/adcp under `test/fixtures/webhook-signing-vectors/` (AdCP tarball hasn't re-released yet; swap to `compliance/cache/...` on the next sync). Every vector runs through `verifyWebhookSignature` — passing vectors verify cleanly, negative vectors throw with byte-matching error codes. State-dependent vectors (replay, revocation, rate-abuse, revocation-stale) install their `test_harness_state` into fresh stores per vector. 2 positive vectors (`004-default-port-stripped`, `005-percent-encoded-path`) are skipped pending an upstream regeneration — their baked signatures contradict the request-signing canonicalization rules the webhook spec inherits.

### Patch Changes

- c94935b: `build-seller-agent` SKILL.md — document two more Common Mistakes surfaced by real seller-agent builds: (1) placing the IO-signing `setup` URL at the top level of a media buy response instead of nesting it under `account.setup` (response builders now reject this at runtime), and (2) bypassing response builders and forgetting `valid_actions` — `mediaBuyResponse` and `updateMediaBuyResponse` auto-populate it from `status`; `get_media_buys` callers should use `validActionsForStatus()` per buy.
- 3c293ae: Skill docs: specialism coverage tables, composition guide, AdCP 3.0 GA alignment.

  Every `build-*-agent/SKILL.md` now maps specialism IDs to concrete per-specialism deltas, with archetype splits where the contracts diverge (creative: ad-server / template / generative). Root `CLAUDE.md` gets the inverse specialism → skill index.

  Seller skill picks up:
  - Protocol-Wide Requirements: `idempotency_key` via `createIdempotencyStore`, mandatory auth pointer, signature-header transparency.
  - Composing OAuth + signing + idempotency: real `serve({ authenticate, preTransport })` wiring, `verifyBearer` from `@adcp/client/server`, low-level `verifyRequestSignature` (preTransport-shaped; not `createExpressVerifier` which is Express-shaped), `resolveIdempotencyPrincipal` threading from `ctx.authInfo.clientId` + multi-tenant composition.
  - Per-specialism sections for `sales-guaranteed` (A2A task envelope for IO approval), `sales-non-guaranteed` (bid_price + update_media_buy), `sales-broadcast-tv`, `sales-social`, `sales-proposal-mode`, `audience-sync`, `signed-requests`.

  Governance skill: Plan shape updated to `budget.reallocation_threshold` / `reallocation_unlimited` + `human_review_required` (no more `authority_level`), `content_standards.policies[]` as structured array with per-entry `enforcement`, `validate_content_delivery.artifact.assets` as array, `property-lists` / `collection-lists` (new) / `content-standards` specialism sections. Governance status enum is approved | denied | conditions — approved-with-conditions is `status: 'conditions'`, not an approved + conditions array.

  Signals skill: async platform-activation pattern, value-type constraints, deployed_at.

  Brand-rights skill: schema-accurate `logos[].background` (dark-bg/light-bg/transparent-bg), `tone.voice` nesting, `terms` with required pricing_option_id/amount/currency/uses, `rights_constraint` with required `rights_agent`, `approval_webhook` credentials minLength 32, `available_uses` using spec-valid enum values.

  Retail-media skill: scope note (catalog-driven ≠ retail-only).

  Validated via five rounds of fresh-builder tests against the skills + one end-to-end test with the storyboard runner. Median build confidence climbed from 3/5 (round 1) to 4-5/5 (round 5). End-to-end runs surfaced three upstream spec/runner bugs now tracked in adcontextprotocol/adcp#2418, adcontextprotocol/adcp#2420, and adcontextprotocol/adcp-client#625.

- 5d81fe9: Generator: typeless JSON Schema properties now emit `unknown` instead of `Record<string, unknown>`.

  JSON Schema properties declared with only a `description` (no `type`, `$ref`, combinator, enum, or structural keyword) are defined by the spec to accept any JSON value — scalar or object. `json-schema-to-typescript` defaults these to `{ [k: string]: unknown }`, which downstream Zod generation then narrowed to `z.record(z.string(), z.unknown())`. That schema rejected scalar values the spec legitimately allows, e.g. a number returned for `check_governance` `conditions[].required_value`.

  `enforceStrictSchema` in `scripts/generate-types.ts` now annotates schema nodes whose keys are all metadata-only (`description`, `title`, `$comment`, `examples`, `default`, `deprecated`, `readOnly`, `writeOnly`, `$id`, `$anchor`, `$schema`) with `tsType: 'unknown'` before handing them to `json-schema-to-typescript`, so the emitted TS is `unknown` and the Zod mirror is `z.unknown()`. Validation-only keywords like `required` (common in `anyOf` branches on request schemas) are not metadata, so constraints still compose. The recursion now also reaches `patternProperties`, schema-valued `additionalProperties`, `not`, `if`/`then`/`else`, `contains`, `propertyNames`, `unevaluatedItems`/`unevaluatedProperties`, and schema-valued `dependencies`/`dependentSchemas`.

  Side fix: `removeNumberedTypeDuplicates` now iterates passes (up to 10) until no further collapses occur. Nested numbered references (e.g. `CatalogFieldMapping2` references `ExtensionObject32`) previously caused the outer duplicate to fail body comparison and stay in the output; they now collapse once the inner reference resolves on an earlier pass.

  Regenerated affected types in `src/lib/types/*.generated.ts`. Notable corrections:
  - `CheckGovernanceResponse.conditions[].required_value`: `Record<string, unknown>` → `unknown`.
  - `CatalogFieldMapping.value` / `.default`: `Record<string, unknown>` → `unknown`.
  - `Response.data`: `Record<string, unknown>` → `unknown`.

  If you narrowed one of these fields with `as Record<string, unknown>`, replace with a value-shape assertion appropriate to the spec.

## 5.1.0

### Minor Changes

- 50c809a: Pull storyboards from the AdCP compliance tarball instead of bundling them.

  Released as a minor bump: 5.0 was intentionally shipped incomplete while the
  upstream compliance tarball + cosign signing work landed (adcontextprotocol/adcp#2273).
  5.0 has not seen meaningful adoption, so the removals below are treated as finishing
  the 5.x surface rather than a 6.0 breaking release.

  `npm run sync-schemas` fetches `/protocol/{version}.tgz` from adcontextprotocol.org,
  verifies its sha256 sidecar, and extracts both `schemas/` and `compliance/` into
  `schemas/cache/{version}/` and `compliance/cache/{version}/`. Per-file schema sync is kept
  as a fallback. The compliance cache ships with the published npm package — no network
  call required for first use.

  When a pinned version ships cosign sidecars (`.sig` / `.crt`, per
  adcontextprotocol/adcp#2273), `sync-schemas` verifies them against the upstream
  release workflow's Sigstore identity. `latest.tgz` is intentionally unsigned and skipped.
  Missing sidecars or a missing `cosign` binary fall back to checksum-only trust with a
  clear log line; a present-but-failed verification is a hard error.

  Storyboard selection is driven by the agent's `get_adcp_capabilities` response:
  `supported_protocols` resolves to domain baselines and `specialisms` resolves to
  specialism bundles. The runner fails closed when:
  - an agent declares a specialism whose bundle isn't in the local cache (stale cache — re-sync);
  - an agent declares a specialism whose parent domain isn't in `supported_protocols`.
    Unknown `supported_protocols` entries (new spec version, typo) log a warning and are skipped.

  `discoverAgentProfile` now calls `get_adcp_capabilities` to populate
  `profile.supported_protocols` + `profile.specialisms`. A probe failure is surfaced
  as `profile.capabilities_probe_error` and a top-level error-severity observation,
  rather than silently downgrading the assessment.

  **Breaking changes**:
  - The `storyboards/` directory is no longer shipped in the npm package. Consumers
    relying on direct file paths must read from `/compliance/{version}/` on
    adcontextprotocol.org or the `compliance/cache/` tree after running sync.
  - `ComplyOptions.platform_type` is removed. Callers that still pass it get a
    runtime error pointing to this changeset. Capability-driven selection replaces
    platform-type curated lists. Pass `storyboards: [id]` for explicit/targeted runs;
    bundle ids (e.g., `sales-guaranteed`) expand to every storyboard in the bundle.
  - `ComplianceResult.platform_coherence` and `ComplianceResult.expected_tracks` are
    removed along with the `expected` track status.
  - `ComplianceSummary.tracks_expected` is removed.
  - Removed exports: `PlatformType`, `SalesPlatformType`, `CreativeAgentType`,
    `SponsoredIntelligenceType`, `AINativePlatformType`, `PlatformProfile`,
    `PlatformCoherenceResult`, `CoherenceFinding`, `InventoryModel`, `PricingModel`,
    `getPlatformProfile`, `getAllPlatformTypes`, `getPlatformTypesWithLabels`,
    `PLATFORM_STORYBOARDS`, `getStoryboardIdsForPlatform`, `extractScenariosFromStoryboard`,
    `filterToKnownScenarios`, `loadBundledStoryboards`, `loadBundledScenarios`,
    `getStoryboardById`, `getScenarioById`, `getStoryboardsForPlatformType`,
    `getComplianceStoryboards`, `getApplicableComplianceStoryboards`, `listStoryboards`.
  - CLI: `adcp storyboard list --platform-type` and
    `adcp storyboard run --platform-type` / `--list-platform-types` are removed.
    Added `adcp storyboard run <agent> --file <path.yaml>` for ad-hoc spec-evolution runs.

  New exports on `@adcp/client/testing`: `resolveStoryboardsForCapabilities`,
  `resolveBundleOrStoryboard`, `findBundleById`, `listBundles`, `loadBundleStoryboards`,
  `listAllComplianceStoryboards`, `getComplianceStoryboardById`, `loadComplianceIndex`,
  `getComplianceCacheDir`.

- 6953c35: Optimistic concurrency primitives on `AdcpStateStore`.

  **New**
  - `putIfMatch(collection, id, data, expectedVersion)` — atomic compare-and-swap. Returns `{ok: true, version}` on success, `{ok: false, currentVersion}` on conflict. `expectedVersion: null` means insert-only.
  - `getWithVersion(collection, id)` — read a document with its row version.
  - `patchWithRetry(store, collection, id, updateFn, options?)` — get → compute → putIfMatch → retry loop for read-modify-write updates. Throws `PatchConflictError` after `maxAttempts` (default 5).
  - Both built-in stores (`InMemoryStateStore`, `PostgresStateStore`) track a monotonically increasing `version` per row. Every `put`/`patch`/`putIfMatch` bumps it.
  - Sessioned stores (`createSessionedStore` / `store.scoped(key)`) proxy the new methods through so scoped views get CAS for free.

  **Postgres migration**
  - `getAdcpStateMigration()` adds `version INTEGER NOT NULL DEFAULT 1` via `ADD COLUMN IF NOT EXISTS`. Existing rows start at version 1. No data rewrite.

  **Docs**
  - `docs/guides/CONCURRENCY.md` gains a section covering `patchWithRetry`, `putIfMatch`, and when to reach for each.

  No breaking changes. Both new methods are optional on the `AdcpStateStore` interface; custom stores that don't implement them keep working.

- 835e633: SessionStore ergonomics + state-store validation (batch 1 of upstream feedback).

  **New**
  - `store.scoped(sessionKey)` on built-in stores + `scopedStore(store, key)` helper that works on any `AdcpStateStore` (falls back to `createSessionedStore` when a custom store doesn't implement the method). Returns a session-isolated view that auto-prefixes ids and filters `list()` by `_session_key`. `::` is reserved as the scope separator and is rejected in session keys and ids so scopes can't collide.
  - `HandlerContext.sessionKey` + `resolveSessionKey` hook on `createAdcpServer`. Sellers derive the scoping key once; handlers read `ctx.sessionKey` instead of re-parsing params.
  - `StateError` with typed codes (`INVALID_COLLECTION`, `INVALID_ID`, `PAYLOAD_TOO_LARGE`, …), built-in charset/length validation on every store operation, configurable `maxDocumentBytes` (5 MB default) on `InMemoryStateStore` and `PostgresStateStore`.
  - `structuredSerialize` / `structuredDeserialize` helpers so handlers can round-trip `Map`, `Set`, and `Date` through the state store without writing per-type converters. Envelope tag is namespaced as `__adcpType` and the deserializer validates payload shape, so caller data that happens to use the same field is passed through unchanged.

  **Docs**
  - `docs/guides/CONCURRENCY.md` — explicit last-writer-wins vs per-row isolation model, the read-modify-write race on whole-session blobs, and why per-entity rows are safer.
  - `docs/guides/TASKRESULT-5-MIGRATION.md` — the four migration patterns for the 5.0 discriminated-union `TaskResult` (success check, error extraction, status narrowing, intermediate states).

  No breaking changes. `scoped` on `AdcpStateStore` is an optional method; custom store implementations that don't define it keep working.

### Patch Changes

- 97f8c8f: Regenerate AdCP schemas and registry from upstream. Pulls in sponsored-intelligence / sales specialism and related domain enums into the generated type exports. Mechanical regen — no handwritten code changes.
- 4e0c482: Response builders now throw a descriptive error when `setup` is placed at the top level of a media buy response. The IO-signing setup URL belongs inside `account.setup` (a field on `Account`), not on the media buy itself. This was a silent trap because `DomainHandler` accepts `Record<string, unknown>` so the strict type wasn't catching it. Affects `mediaBuyResponse`, `updateMediaBuyResponse`, and `getMediaBuysResponse`.

## 5.0.0

### Major Changes

- fc33966: BREAKING: TaskResult is now a discriminated union. Failed tasks use status:'failed' instead of 'completed'. MCP isError responses preserve structured data (adcp_error, context, ext) instead of throwing. Adds adcpError, correlationId, retryAfterMs convenience accessors and isRetryable()/getRetryDelay() utilities.

### Minor Changes

- 5a3c835: Brand rights as a first-class server domain, plus creative-asset record shape alignment

  **Brand rights first-class domain.** `createAdcpServer({ brandRights: {...} })` now accepts a domain group for the three schema-backed tools: `get_brand_identity`, `get_rights`, and `acquire_rights`. No more manual `server.tool()` registration, no bespoke `taskToolResponse` wrapping — context echo, account resolution, and `brand` protocol declaration in `get_adcp_capabilities` all work out of the box.

  `update_rights` and `creative_approval` are intentionally **not** part of the domain group. The AdCP spec has no published JSON schemas for either — `creative_approval` is modeled as a webhook (POST to `approval_webhook` returned from `acquire_rights`), and `update_rights` is only described in prose. Adding permissive passthrough schemas just to satisfy a storyboard would be building to the test. They will be added when upstream schemas land (tracked in https://github.com/adcontextprotocol/adcp).

  **Request-builder honors `sample_request` for `build_creative` and `sync_creatives`.** Hand-authored sample payloads are preserved end-to-end, so storyboards can exercise slot-specific briefs, format-scoped uploads, and multi-format requests without the builder overwriting them. Matches the behavior already present for `update_media_buy`, `create_media_buy`, `sync_plans`, and `calibrate_content`.

  **Creative asset record shape.** All storyboard `sample_request.creatives[].assets` payloads now match the generated `CreativeAssetSchema`, which declares `assets` as `z.record(asset_id, asset)`. Agents validating requests against the generated Zod schemas will no longer reject storyboard payloads that previously used the array-of-asset-objects form. Fixes `creative_lifecycle`, `creative_template`, `creative_generative`, `creative_sales_agent`, `social_platform`, `media_buy_seller`, `media_buy_proposal_mode`, `media_buy_guaranteed_approval`, `deterministic_testing`, and `brand_rights`.

  **Protocol gaps surfaced** (tracked for upstream AdCP spec work):
  - `update_rights` and `creative_approval` lack published JSON schemas — the latter is spec'd as a webhook, so the gap is request/response schemas for either transport
  - `error_compliance` storyboard is media-buy-scoped (requires `get_products`) — needs capability-aware dispatch to cover creative, signals, brand-rights, and governance agents

  **Skill updates.**
  - `build-brand-rights-agent/SKILL.md` rewritten around the new domain group and against the actual `schemas/cache/latest/brand/*.json` shapes (`names` as locale-keyed objects, `logos` with `orientation`/`background`/`variant`, `pricing_options` with `model`/`price`/`uses`, `acquire_rights` status discriminated union). Creative-approval flow is documented as an outbound webhook POST; `update_rights` is documented as a regular HTTP endpoint until schemas land.

- f44c8c9: Add context passthrough testing, format_id reconciliation, and identifier roundtrip validations across all storyboards. Client SDK now preserves context and ext through field stripping via ADCP_ENVELOPE_FIELDS. Runner merges context/ext from sample_request into request builder output.
- 8ad72f4: Added `createAdcpServer` — declarative server builder with domain-grouped handlers, automatic account resolution, response builder wiring, tool annotations, and auto-generated capabilities. Added `checkGovernance` and `governanceDeniedError` composable helpers for governance checks in financial handlers.
- ed52beb: Add `validation.filterInvalidProducts` client option to filter out invalid products from get_products responses instead of rejecting the entire response when some products fail schema validation
- 337fbeb: Fix broken code examples in build-seller-agent skill and improve createAdcpServer DX. Skill fixes: tsc command, creative state transitions, simulateDelivery params, confirmed_at, storyboard table, capabilities casing, channels type inference. Framework fixes: make account optional in registered MCP input schemas for handler-level validation; accept Record<string, unknown> from DomainHandler return types so plain object literals compile without exact type matching. Add compile-time test for all skill file typescript examples.
- 8376f90: Add NetworkConsistencyChecker for validating managed publisher network deployments. Detects orphaned pointers, stale pointers, missing pointers, schema errors, and unreachable agent endpoints. Available as both a library import and CLI command (`adcp check-network`).
- 316565c: Add media buy response builders that eliminate common implementation traps: validActionsForStatus() maps status to valid actions, mediaBuyResponse() auto-defaults revision/confirmed_at/valid_actions, cancelMediaBuyResponse() requires cancellation metadata. Sync schemas from latest AdCP.
- d99b118: Add composable scenario library for seller storyboard certification. Scenarios are small, focused behavior tests (governance outcomes, product refinement, proposal finalize) that specialization storyboards declare via `requires_scenarios`. The compliance engine resolves and runs them alongside the main storyboard, enabling modular certification without duplicating test logic across seller types.
- 5a3c835: Add storyboards, scenarios, and SDK helpers covering AdCP 3.0 primitives
  - New `collection_governance` storyboard for collection list CRUD, webhook delivery, and targeting via `CollectionListReference`
  - New `media_buy_seller/measurement_terms_rejected` scenario exercising the `TERMS_REJECTED` round-trip: buyer proposes unworkable terms, seller rejects, buyer retries with seller-compatible terms
  - New `media_buy_seller/governance_denied_recovery` scenario verifying the buyer can correct a denied buy and retry within plan limits
  - New `media_buy_seller/pending_creatives_to_start` scenario validating the `pending_creatives → pending_start` transition after `sync_creatives`
  - New `media_buy_seller/inventory_list_targeting` scenario exercising `property_list` + `collection_list` targeting on both `create_media_buy` AND `update_media_buy` (catches create/update parity regressions) and verifying persistence via `get_media_buys`
  - New `media_buy_seller/inventory_list_no_match` scenario covering the case where referenced lists resolve to zero matching inventory — seller must return a zero-forecast product or an informative error, not crash
  - New `signal_marketplace/governance_denied` and `brand_rights/governance_denied` scenarios covering governance across signal activation and rights licensing purchase types
  - Extended `error_compliance` with a `version_negotiation` phase that validates `VERSION_UNSUPPORTED` on an unsupported `adcp_major_version` and acceptance of a supported one
  - New `media_buy_seller/invalid_transitions` scenario with hard `error_code` assertions for `MEDIA_BUY_NOT_FOUND`, `PACKAGE_NOT_FOUND`, and `NOT_CANCELLABLE` (state-machine hardening)
  - Hardened existing `error_compliance` probes (`negative_budget`, `reversed_dates_error`, `nonexistent_product`) from soft `field_present: errors` to specific `error_code` assertions via `allowed_values`
  - `check: error_code` validations now accept `allowed_values` in addition to `value`, so scenarios can assert one-of for semantically overlapping codes (e.g. `VALIDATION_ERROR` vs `INVALID_REQUEST`)
  - Wired new scenarios into parent storyboards via `requires_scenarios`
  - Extended `fictional-entities.yaml` with a `collections` section (outdoor, automotive, and food programming) so storyboards have canonical test data for `collection_list` targeting
  - Extended `test-kits/acme-outdoor.yaml` with an `inventory_targets` section providing matching and non-matching `PropertyListReference` / `CollectionListReference` fixtures
  - Added `resolvePropertyList` / `resolveCollectionList` / `matchesPropertyList` / `matchesCollectionList` helpers to `@adcp/client/server` so seller handlers can filter inventory against buyer-supplied list references in one line

- 7116ee7: Type brand_json with Zod schema matching the AdCP brand.json spec. SandboxBrand.brand_json is now typed as BrandJson instead of Record<string, unknown>, and sandbox data is validated at load time. Brand entries use spec-compliant field names (id, names) instead of the previous brand_id/name.
- 48c0501: Close schema pipeline gap: generate TypeScript types and Zod schemas for all missing JSON schemas, add TOOL_REQUEST_SCHEMAS and TOOL_RESPONSE_SCHEMAS exports

### Patch Changes

- 1395e20: Add behavioral compliance validations to brand rights, property governance, and content standards storyboards
  - Brand rights: verify resolved identity data (brand_id match, names present), reject invalid brand IDs, validate creative approval decisions, test expired campaign and nonexistent grant enforcement
  - Property governance: assert compliant/non-compliant delivery verdicts, add enforcement phase with authorized and unauthorized publisher tests, fix context propagation for property_list_id
  - Content standards: assert calibration verdict, add must-rule violation test, add policy version change test with re-calibration, strengthen delivery validation with summary and results checks

- 09a0c3e: Fix storyboard sample_requests and request-builder fallbacks to match AdCP schemas for brand_rights and property_governance
- a8159c9: Enable `--protocol a2a` for storyboard testing. Connection cleanup is now protocol-aware, A2A clients are cached to avoid re-fetching the agent card on every tool call, and the compliance-testing auto-augment log now goes to stderr so it doesn't corrupt `--json` output.
- 5a3c835: Preserve `adcp_major_version` through per-tool field filtering and handle synchronous error responses from MCP Tasks servers. Version-negotiation probes (e.g. intentionally unsupported major versions) now reach sellers intact, and `VERSION_UNSUPPORTED` errors returned synchronously by MCP servers are surfaced to callers rather than being masked by a Tasks SDK validation error.

## 4.30.2

### Patch Changes

- 86d2e3d: Fix ext field being incorrectly stripped from v2 server requests. ext is a protocol-level extension field valid in all AdCP versions and should always be preserved.
- 1a0a863: Fix crash when servers return explicit null for optional array fields (creative_assignments, creative_ids, products) on media buy packages
- 52570f3: Fix brand field being silently stripped when a v3 server is misdetected as v2. The v2 adapter renames brand → brand_manifest, but the schema filter then drops brand_manifest when the tool schema declares brand. Added adapter alias reconciliation so brand_manifest maps back to brand when the schema expects it. Improved version detection logging to surface why get_adcp_capabilities failures cause v2 fallback.

## 4.30.1

### Patch Changes

- b143658: Fix schema-based field stripping to apply for all server versions, not just v3. Fields like idempotency_key and ext that are not declared in the remote server's tool schema are now stripped before sending, preventing validation errors on servers that don't accept them.

## 4.30.0

### Minor Changes

- c3dd940: Add full brand identity blocks (logos, colors, fonts, tone) and creative assets to all test kit YAMLs. New test kits for Bistro Oranje, Summit Foods, and Osei Natural. Enables loading all sandbox brands from @adcp/client instead of hardcoding them.

## 4.29.0

### Minor Changes

- 01ee05b: Add compliance status APIs for buyer integration
  - Added `getAgentCompliance()`, `getAgentStoryboardStatus()`, `getAgentStoryboardStatusBulk()` to RegistryClient
  - Added `lookupOperator()` and `lookupPublisher()` to RegistryClient with typed responses
  - RegistrySync now processes `agent.compliance_changed` feed events and emits typed `compliance_changed` events
  - `AgentSearchResult` includes optional `compliance_summary` field
  - `findAgents()` accepts `compliance_status` filter
  - Exported new types: `AgentCompliance`, `AgentComplianceDetail`, `StoryboardStatus`, `OperatorLookupResult`, `PublisherLookupResult`, `ComplianceChangedPayload`
  - Registry schema sync adds new agent types: `brand`, `rights`, `measurement`, `buying` (additive, non-breaking)

## 4.28.1

### Patch Changes

- 655384f: Fix getCapabilities() silently falling back to synthetic v2 for v3 agents. Make publisher_domains optional in GetAdCPCapabilitiesResponse schema so agents that omit it (e.g. OpenAds) pass validation. Replace bare catch {} with diagnostic logging and re-throw for auth/timeout errors.

## 4.28.0

### Minor Changes

- 43efdc8: Remove dry_run as a protocol concept in favor of sandbox
  - Removed X-Dry-Run HTTP header from test client
  - Removed dry_run from TestOptions, TestResult, SuiteResult, StoryboardResult, ComplianceResult
  - Made sandbox: true the default for all test runs (comply, testAgent, testAllScenarios)
  - Changed CLI --dry-run to preview mode (shows steps without executing, opt-in)
  - Replaced --no-dry-run flag with --dry-run (default is now to execute)

- 02cdc70: Add sandbox entity system for storyboard testing and fix documentation gaps
  - Fix sync_creatives examples in generative seller SKILL.md (status→action, errors as objects)
  - Fix channels enum in TYPE-SUMMARY.md (20 real MediaChannel values, not 8)
  - Add PricingOption variant details to TYPE-SUMMARY.md (CPV parameters)
  - Add fictional-entities.yaml defining all 14 companies from the AdCP character bible
  - Add getSandboxEntities() / getSandboxBrand() / isSandboxDomain() exports from testing module
  - Add sandbox boolean to registry OpenAPI spec (ResolvedBrand, BrandRegistryItem, saveBrand)
  - Migrate all fictional entity domains to IANA-reserved .example TLD
  - Add --sandbox flag to save-brand CLI command

- ce4932a: Sync storyboards from adcp 3.0: broadcast TV seller, generative updates, governance and status fixes
  - Add media_buy_broadcast_seller storyboard (linear TV with Ad-ID, measurement windows, C7 reconciliation)
  - Update creative_generative and media_buy_generative_seller storyboards
  - Fix governance storyboards: status→decision field, binding structure, domain→.com
  - Fix media buy storyboards: status lifecycle (pending_activation→pending_creatives/pending_start)
  - Fix path references (media_buys→media_buy_deliveries, field_value additions)
  - Fix signal storyboards: validation and path corrections

### Patch Changes

- bcf2651: Fix adcp_major_version breaking v2 seller tool calls
  - Stop injecting adcp_major_version into tool args for v2 sellers (strict Pydantic schemas reject it)
  - Make ProtocolClient version-aware via serverVersion parameter
  - Strip adcp_major_version in all v2 request adapters as belt-and-suspenders

## 4.27.0

### Minor Changes

- 9bb0a66: Deprecate `adcp comply` CLI command in favor of `adcp storyboard run`. Running `adcp storyboard run <agent>` without a storyboard ID now runs all matching storyboards (the same behavior as `adcp comply`). The `comply` command still works but prints a deprecation warning and will be removed in v5.

### Patch Changes

- eed5456: Add context extractors for list_creatives, sync_catalogs, sync_audiences, and sync_event_sources so storyboards can use $context references instead of hardcoded IDs

## 4.26.2

### Patch Changes

- 49c0466: Add check_governance and report_plan_outcome context extractors to storyboard runner

## 4.26.1

### Patch Changes

- 6e1eb2d: fix: get_signals builder passes through signal_ids from sample_request, activate_signal removes hardcoded platform destination fallback

## 4.26.0

### Minor Changes

- 51068e1: Improve comply runner signal-to-noise ratio against real agents
  - Skip storyboard steps when agent doesn't implement the tool (new `missing_tool` skip reason)
  - Detect unresolved `$context` placeholders and skip with `dependency_failed` instead of sending invalid requests
  - Catch "Unknown tool" errors from agents and convert to skips
  - Add rate limit retry with exponential backoff and jitter (3 retries, 2s/4s/8s base)
  - Fix `sync_creatives` request builder to send creatives for all discovered formats, not just the first (#482)
  - Fix `mapStepToTestStep` to preserve runner's skip semantics (skips no longer counted as failures)
  - Fix `extractErrorData` to handle nested JSON in error messages
  - Truncate agent error messages to 2000 chars to prevent report bloat

- 24d9c97: Storyboard infrastructure and skill validation for all 16 remaining storyboards
  - Fix response-unwrapper `_message` stripping for union schema validation (Zod v4 compatibility)
  - Fix `expect_error` handling for `schema_validation` reversed_dates step
  - Add `requires_tool` to governance storyboard steps that need seller tools
  - Add request builders for governance, content standards, brand rights, SI tools
  - Add context extractors for `create_content_standards`, `get_rights`, `acquire_rights`
  - Register missing response schemas: `create_content_standards`, `update_content_standards`, `validate_property_delivery`
  - Add task-map entries: `check_governance`, `create_content_standards`, `update_content_standards`, `get_account_financials`, `log_event`
  - Fix campaign governance YAML sample_requests to match current schemas
  - Fix content standards YAML sample_requests (scope, artifact, records fields)
  - Sync PLATFORM_STORYBOARDS with storyboard platform_types declarations
  - New test: storyboard-completeness.test.js (structural validation for all bundled storyboards)
  - New skills: build-governance-agent, build-si-agent, build-brand-rights-agent
  - Updated skills: build-seller-agent (error responses), build-creative-agent (asset shapes)

### Patch Changes

- 8ed8fe9: fix: comply runner sends account.sandbox: true in test controller requests

  comply_test_controller request builder now injects account with sandbox: true so the training agent does not return FORBIDDEN during deterministic testing

## 4.25.0

### Minor Changes

- 5d5b2ec: Fix SSE transport fallback, schema validation, and compliance testing detection
  - Track successful StreamableHTTP connections and skip SSE fallback on reconnection (prevents 405 errors on POST-only servers)
  - Improve union schema error messages with field-level detail instead of generic "Invalid input"
  - Consolidate ResponseValidator to use canonical TOOL_RESPONSE_SCHEMAS map
  - Auto-augment declared capabilities when comply_test_controller is present but compliance_testing protocol is not declared
  - Fix brand_rights storyboard sample_requests to match protocol schemas (brand_id, rights_id, context flow)
  - Add brand rights response schemas for schema drift checking
  - Add --timeout flag to `adcp comply` CLI (default 120s) so storyboard runs have a budget

- 7de4434: Add 13 typed response builders for server-side AdCP tools, add `@adcp/client/server` subpath export, and add setup instructions to all build skills

### Patch Changes

- 8acb2d0: Fix normalizeFormatsResponse to handle raw array responses from creative agents, and distinguish missing test harness from not-testable skip reasons in storyboard runner
- 71e2de3: Fix storyboard field name drift: governance `decision`→`status`, creative `results`→`creatives`, audit log `entries`→`plans[0].entries`, setup path nesting. Fix context extractors for build_creative, sync_creatives, activate_signal, create_property_list. Deprecate `CommittedCheckRequest.mediaBuyId` (removed from protocol). Add schema drift detection test.

## 4.24.0

### Minor Changes

- daea974: Add brand rights protocol test scenarios (brand_identity, brand_rights_flow, creative_approval) and brand compliance track
- 3e79195: Added PostgresTaskStore for distributed MCP servers. Replaces InMemoryTaskStore when running multiple server instances behind a load balancer, storing tasks in a shared PostgreSQL table. Includes MCP_TASKS_MIGRATION SQL constant and cleanupExpiredTasks() utility.
- 14206aa: Comply CLI DX improvements: failures array, expected text, storyboard filtering, SKILL.md
  - `ComplianceResult.failures[]` — flat array of failed steps with storyboard_id, step_id, expected text, error, and fix_command for targeted re-running
  - `adcp comply --storyboards media_buy_seller,error_compliance` — run specific storyboards (validated against bundled set)
  - "How to Fix" section in human-readable comply output with expected responses and debug commands
  - `adcp storyboard show` now displays narratives and expected responses (was titles-only)
  - `adcp storyboard list` now includes `track` field in JSON output
  - `adcp storyboard step --context @file.json` — read context from file (no shell escaping)
  - Updated SKILL.md with comply/storyboard workflow, routing, and filtering options
  - Top-level help clarifies comply vs storyboard vs test relationship
  - `ComplianceResult.storyboards_executed` (optional) lists which storyboard IDs were executed
  - Scenario names in track results changed from bare `phase_id` to `storyboard_id/phase_id`

- 41e9f9e: Added registerTestController(server, store) and TestControllerStore for server-side comply_test_controller implementation. Sellers can add deterministic compliance testing support with one function call instead of implementing the tool from scratch. Also adds skip_reason field to StoryboardStepResult to distinguish "not testable" (agent lacks tool) from "dependency failed" (prior step failed).

### Patch Changes

- 69a6dde: Add build-seller-agent skill (`skills/build-seller-agent/SKILL.md`) that guides coding agents through domain decisions and implementation of a seller MCP server
- c56645a: Fix storyboard request builder gaps found during real-agent validation: always include pricing_option_id in create_media_buy, add measurement_period to provide_performance_feedback, add 6 missing request builders, register 7 missing response schemas

## 4.23.0

### Minor Changes

- 6dc5ad0: Storyboard-driven compliance routing: comply() now resolves storyboards directly instead of routing through tracks. Added `storyboards` option, `PLATFORM_STORYBOARDS` mapping, `extractScenariosFromStoryboard()`, and `filterToKnownScenarios()`. Tracks are now a reporting layer derived from storyboard results.

## 4.22.1

### Patch Changes

- 744c829: serve() now creates a shared task store and passes it to the agent factory via ServeContext, fixing MCP Tasks protocol (tasks/get) failures over stateless HTTP where each request previously got its own empty task store.

## 4.22.0

### Minor Changes

- ee1753d: Send adcp_major_version on every request per adcontextprotocol/adcp#1959. Sellers can validate the declared version against their supported range and return VERSION_UNSUPPORTED on mismatch.
- 68da21e: Add `serve()` helper for zero-boilerplate agent HTTP servers, fix examples to use npm-consumer import paths, and ship docs/llms.txt + BUILD-AN-AGENT.md in the npm package for agent discoverability.
- ea93508: Migrate comply() to storyboard-driven testing. The compliance engine now runs storyboard YAMLs instead of hand-written scenario functions. Adds YAML format extensions (expect_error, requires_tool, context_outputs/context_inputs, error_code validation) and 10 new compliance storyboards covering governance, SI, brand rights, state machines, error compliance, schema validation, behavioral analysis, audiences, and deterministic testing. Deprecates SCENARIO_REQUIREMENTS, DEFAULT_SCENARIOS, and testAllScenarios() in favor of storyboard execution.
- ea93508: Add storyboard-driven testing module with CLI support. Storyboards are YAML-defined test workflows that map directly to SingleAgentClient methods, enabling step-by-step agent testing. Includes 12 bundled storyboards from the AdCP spec, a stateless per-step CLI (`adcp storyboard step`) designed for LLM consumption, and platform type tags for backwards compatibility with the existing compliance system.
- e5002a4: Add `userAgent` config to `PropertyCrawlerConfig` and `TestOptions`, threaded through to all outbound HTTP requests via both MCP and A2A transports. Wire the existing but unused `SingleAgentClientConfig.userAgent` field into protocol headers. Export `PropertyCrawlerConfig` type from public API.

### Patch Changes

- 913fadd: Add generated agent documentation (llms.txt, TYPE-SUMMARY.md) and update SKILL.md with all 24 test scenarios
- cc07055: Fix skipped-step counting in storyboard runner and add tool_discovery diagnostic observations to comply(). Steps skipped due to requires_tool are now correctly counted as skipped instead of passed, and comply() emits observations showing discovered tools and expected-vs-actual tools when tracks are skipped.

## 4.21.0

### Minor Changes

- bb491ed: Sync schemas and types for AdCP 3.0.0-rc.3

### Patch Changes

- 21b2053: fix: eliminate comply tester false positive observations
  - Add `observation_data` field to `TestStepResult` to separate structured data (for observations) from display-only `response_preview`, eliminating false positives from snapshot-only `get_media_buys` previews
  - Handle nested `media_buy` response envelope when extracting `canceled_by`, `canceled_at`, and `revision` from cancel step
  - Suppress schema validation console noise via existing `logSchemaViolations` config instead of monkey-patching console

## 4.20.0

### Minor Changes

- 3bff582: Add RegistrySync for in-memory registry replica with agent/authorization indexes, event feed polling, and zero-latency lookups. Add `lookupDomains()` for concurrent domain→agent resolution. Parallelize `lookupPropertiesAll()` with configurable concurrency. Align registry sync types with live server.

## 4.19.0

### Minor Changes

- d0dc6b5: Add dedicated `reporting_flow` scenario for precise reporting compliance evaluation. The reporting track now uses `reporting_flow` (which requires `get_media_buy_delivery`) instead of piggybacking on `full_sales_flow`.

## 4.18.2

### Patch Changes

- e3cb1c3: fix: stop early-exiting product discovery for v2 servers when request contains property_list or required_features filters that are already stripped by the v2 adapter

## 4.18.1

### Patch Changes

- 60bc7b2: Add unknown flag detection to `comply` command with "did you mean?" suggestions, and remove 5 unused dependencies (better-sqlite3, @types/better-sqlite3, @apidevtools/json-schema-ref-parser, json-schema-to-ts, markdown-it)
- 64a4bdb: Fix A2A capability detection using `skill.id` instead of `skill.name` for tool mapping, so `buildSyntheticCapabilities` correctly identifies protocols like `media_buy` from A2A agent cards

## 4.18.0

### Minor Changes

- c93b30b: Add `overall_status`, `tested_tracks`, `skipped_tracks`, and `expected_tracks` to ComplianceResult; accept `platform_type` as string with internal validation

## 4.17.0

### Minor Changes

- c6a167e: Add `linear_tv_platform` platform type for agents transacting linear TV inventory. Includes CPP and CPM pricing, reserved inventory model, and broadcast-specific creative workflow (ISCI codes via sync_creatives).

  Add `get_media_buy_delivery` as an expected tool for all sales platform profiles. Every platform with a reporting track should support delivery data — this was previously only expected on DSP and generative DSP profiles.

  Add behavioral characteristics (`inventory_model`, `pricing_models`) to all platform profiles. Add `cpc` pricing model for search and retail media platforms. Add `cpp` pricing model for linear TV.

  Remove deprecated `FormatCategory` type, `CreativeFormatType` type, `findByType()` from `CreativeAgentClient`, and `findFormatsByType()` from `ADCPMultiAgentClient`. These were deprecated in favor of filtering by format assets directly.

## 4.16.2

### Patch Changes

- beb7ece: fix: strip buyer_ref before strict validation in validateRequest() to preserve backward compatibility with pre-4.15 servers

## 4.16.1

### Patch Changes

- f34a58d: fix: add buyer_ref backward compatibility shim for pre-4.15 servers on create_media_buy and update_media_buy

## 4.16.0

### Minor Changes

- 4c4bf89: Add comply_test_controller support for deterministic lifecycle compliance testing. When a seller exposes the optional `comply_test_controller` tool in sandbox mode, comply walks full state machines by forcing seller-side transitions instead of just observing. Includes 7 new scenarios: creative state machine, media buy state machine, account state machine, SI session state machine, delivery simulation, budget simulation, and controller self-validation.
- a965023: Add `timeout_ms` and `signal` options to `comply()` for timeout and cancellation support. `timeout_ms` stops new scenarios from starting when exceeded. `signal` accepts an `AbortSignal` for external cancellation (e.g., graceful shutdown). Both options compose — either can trigger abort.

### Patch Changes

- 502b1ae: Fix CodeQL code scanning alerts: eliminate ReDoS in webhook agent ID inference, sanitize error logging to prevent sensitive data exposure, and harden GitHub Actions workflow permissions
- c1a9abf: Improve schema validation error messages for union response schemas (create_media_buy, activate_signal, build_creative, etc.). Previously, validation failures on these tools produced the unhelpful `(root): Invalid input`. Now reports the specific missing or invalid fields from the closest-matching schema variant (e.g., `media_buy_id: expected string, received undefined`). Also fixes TaskExecutor.extractResponseData() to retry unwrapping without schema validation when the initial call fails.

## 4.15.0

### Minor Changes

- 656e5f2: Add audience governance schemas, match breakdown, and compliance testing.

  **Schemas**: audience-selector (signal ref or description discriminated union), audience-constraints (include/exclude), restricted-attribute (GDPR Article 9 enum), match-id-type (hashed PII + universal IDs). Synced from AdCP PR #1593.

  **Breaking upstream changes**: `buyer_ref` removed from create/update_media_buy, `buyer_campaign_ref` removed from check_governance/report_plan_outcome, `governance_context` changed from structured object to opaque string token. GovernanceMiddleware, GovernanceAdapter, and TaskExecutor updated accordingly.

  **Compliance**: sync_audiences response schema registered for validation. Campaign governance scenarios added to comply() governance track. sync_plans now exercises policy_categories, audience constraints, and restricted_attributes. Delivery monitoring includes audience_distribution indices. Signals flow reports governance metadata availability.

- fef68a7: Add governance_context round-trip verification to comply() with stub governance agent for active seller testing
- 83ecdcc: Support MCP Tasks protocol for async tool calls

  When connected to MCP servers that declare `capabilities.tasks.requests.tools.call`, the client now uses MCP Tasks protocol methods (`tasks/get`, `tasks/result`, `tasks/cancel`, `tasks/list`) instead of custom AdCP tool calls for async lifecycle management. This removes the LLM from the polling path and aligns with the MCP specification (2025-11-25 experimental).

  Client-side: `ProtocolClient.callTool()` transparently uses `callToolStream()` when the server supports tasks, falling back to standard `callTool` otherwise. `TaskExecutor.getTaskStatus()` and `listTasks()` use protocol-level methods when available.

  Server-side: New helpers for publishers to add MCP Tasks support — `createTaskCapableServer()`, `registerAdcpTaskTool()`, `taskToolResponse()`, plus re-exports of `InMemoryTaskStore`, `TaskStore`, and `isTerminal` from the MCP SDK.

- 8ea9139: Support order lifecycle management from AdCP spec.
  - Cancellation fields on media buys and packages (`canceled`, `canceled_at`, `canceled_by`, `cancellation_reason`)
  - `confirmed_at` timestamp on create and get responses
  - `revision` for optimistic concurrency on create, get, and update
  - `valid_actions` on responses so agents know permitted operations per state
  - `include_history` parameter and revision history on `get_media_buys`
  - Per-package `creative_deadline` for mixed-channel orders
  - 6 new error codes: `INVALID_STATE`, `NOT_CANCELLABLE`, `MEDIA_BUY_NOT_FOUND`, `PACKAGE_NOT_FOUND`, `VALIDATION_ERROR`, `BUDGET_EXCEEDED`
  - `CanceledBy` enum type (`buyer` | `seller`)
  - Updated governance middleware for upstream schema changes (`governance_context` now opaque string, `buyer_campaign_ref` removed from governance requests)

## 4.14.0

### Minor Changes

- 9338bb4: Add state machine compliance scenarios to comply framework: media_buy_lifecycle (pause/resume/cancel transitions), terminal_state_enforcement (reject updates to canceled buys), and package_lifecycle (package-level pause/resume independent of media buy status). Includes valid_actions and pause/resume observations.

### Patch Changes

- a7f4585: Fix CLI to use saved OAuth tokens automatically instead of requiring --auth flag on every request
- 2fff9d6: Fix comply() response validation: validate required fields and enum values against Zod schemas (#371, #372), fix signals_flow sending brief instead of signal_spec (#373)

## 4.13.0

### Minor Changes

- fc34114: Add getPlatformTypesWithLabels() for platform type discovery with labels. Fix buildStaticInlineCreative missing required creative_id. Fix activateSignal to use spec field names (signal_agent_segment_id, destinations) with backward-compat normalizer shims.
- 8e30a66: Re-export commonly needed nested types (PackageUpdate, Package, Destination, SignalFilters, PricingOption, PriceGuidance, Episode, ShowSelector) from main entry point. Add typesVersions to package.json so subpath imports work under moduleResolution: node. Fix ./types subpath to include runtime entries for Zod schema imports.
- 8205a86: Fix schema .shape compatibility and add server-side helpers
  - Fix 9 broken Zod request schemas that had .and() intersections breaking MCP SDK server.tool() registration
  - Add typed response builders (capabilitiesResponse, productsResponse, mediaBuyResponse, deliveryResponse)
  - Add adcpError() helper for L3-compliant structured error responses
  - Add error extraction utilities for client-side error classification
  - Add error compliance test scenario for comply

### Patch Changes

- daac3ca: Fix generated Zod schemas breaking MCP SDK JSON Schema conversion

  Remove `z.undefined()` from generated union types (e.g., `z.union([z.boolean(), z.undefined()])` → `z.boolean()`) since `z.undefined()` has no JSON Schema representation and causes `toJSONSchema()` to throw. Also strip redundant `.and(z.record(...))` intersections that create `ZodIntersection` types losing `.shape` access needed by MCP SDK for tool registration.

- 2e87c5a: Fix MCP connection exhaustion during comply/test runs by reusing cached connections instead of creating a new TCP connection per tool call. Adds auth-aware cache keying, LRU eviction, and transport-error-only retry logic.
- fc5b158: Remove as-any casts from core library code for improved type safety
- 0d2a781: Enable `noUncheckedIndexedAccess` in TypeScript config for safer array/record access

## 4.12.0

### Minor Changes

- c9d32f1: Support both /.well-known/agent.json (current A2A spec) and /.well-known/agent-card.json (legacy) for agent card discovery

### Patch Changes

- 9bc632c: Fix `audienceManagement` capability flag never being detected. The Zod schema and wire format define the feature flag as `audience_targeting`, but `parseCapabilitiesResponse` was reading `audience_management`. Renamed the internal `MediaBuyFeatures` property to match schema naming and updated `TASK_FEATURE_MAP` so `sync_audiences` correctly requires the flag.
- 9bc632c: Fix `get_products` responses with non-array `products` field crashing downstream consumers. Added Zod schema validation for `get_products` responses in the response unwrapper and updated `normalizeGetProductsResponse` to convert malformed responses to AdCP error responses instead of silently passing through.
- 9fce3ec: Replace `any` types with `unknown` and concrete types at protocol boundaries, error classes, logger, and internal client casts

## 4.11.0

### Minor Changes

- 40bd0b7: Add platform-type-aware compliance testing. Users can declare what they're building (e.g., `--platform-type social_platform`) and comply will validate coherence, show expected-but-missing tracks, and provide actionable build guidance. Remove convince assessment from SDK.

### Patch Changes

- ccdee67: Fix test harness `create_media_buy` scenarios failing with `account: Invalid input`

  The `buildCreateMediaBuyRequest` helper was not including the required `account` field,
  causing client-side Zod validation to reject the request before it reached the agent.
  - Add `account: resolveAccount(options)` to `buildCreateMediaBuyRequest`
  - Add backwards-compatible `account` inference in `normalizeRequestParams` so callers
    that pre-date the required `account` field keep working (derived from `brand`)

- c8604f4: Fix OAuth protected resource validation for servers behind reverse proxies or DNS aliases. The MCP SDK's default same-origin check rejected servers that advertise a canonical resource URL different from the connection URL. The client now accepts cross-origin resource URLs while enforcing HTTPS.

## 4.10.0

### Minor Changes

- 6c60e35: Add `comply` and `convince` assessment flows to the testing surface and CLI.
  - add compliance track reporting via `adcp comply`
  - add AI-assisted merchandising assessment via `adcp convince`
  - export the new compliance helpers from `@adcp/client/testing`

## 4.9.0

### Minor Changes

- 6950b52: Add OpenTelemetry tracing support for observability
  - Added `@opentelemetry/api` as an optional peer dependency
  - New `withSpan()` utility wraps async operations in OTel spans
  - Instrumented `ProtocolClient.callTool()`, `callMCPTool()`, `callA2ATool()`, and `connectMCPWithFallback()`
  - Trace context headers (`traceparent`) automatically injected into tool call requests (excludes discovery endpoints to avoid leaking trace IDs to untrusted servers)
  - All tracing is no-op when `@opentelemetry/api` is not installed
  - Exported utilities: `getTracer`, `isTracingEnabled`, `injectTraceHeaders`, `withSpan`, `addSpanAttributes`, `recordSpanException`

  When consumers use an OTel-compatible observability system (Sentry, Datadog, etc.), spans from this library automatically appear as children of the consuming application's traces.

- 4d9d03c: Fix creative protocol testing issues and add creative_lifecycle scenario
  - Fix preview_creative test calls to use current schema (request_type: 'single' + creative_manifest)
  - Remove incorrect media_buy gate on sync_creatives (now dual-domain with creative protocol)
  - Fix cross-validation false positives from shared tools (list_creative_formats, list_creatives, sync_creatives)
  - Respect min_spend_per_package when building test media buy requests
  - Add creative_lifecycle scenario: format validation, bulk sync, snapshot testing, build/preview

- d855c7e: Add governance SDK support: GovernanceMiddleware for buyer-side transaction validation, governance adapter, governance test scenarios, and capabilities discovery for governance protocol detection. TaskExecutor now intercepts tool calls to check governance before execution, auto-applies conditions, and reports outcomes.

  **Schema refresh (breaking):**
  - Removed `stats.hosted` from `listBrands` response — consumers reading this field will get a compile error
  - New enum members: `MediaChannel: 'ai_media'`, `TaskType: 'get_brand_identity' | 'get_rights' | 'acquire_rights'`, `AdCPDomain: 'brand'` — may break exhaustive switch/assertNever patterns
  - `limit`/`offset` parameters in `listPolicies`, `getBrandHistory`, `getPropertyHistory`, `getPolicyHistory` typed as `string` (upstream registry.yaml issue)

## 4.8.0

### Minor Changes

- 561df2e: Add creative library protocol support. `list_creatives` now available in both media-buy and creative domains for agents that host creative libraries. `build_creative` gains library retrieval mode via `creative_id`, `library_id`, and `macro_values` fields. New `CreativeVariable` type for DCO variable definitions. `CreativeFilters` extended with `format_ids`, `format_types`, `has_variables`, `has_served`, and `concept_ids`. `has_creative_library`, `supports_generation`, and `supports_transformation` capability flags added. `CreativeAgentClient` gains `listCreatives()` method.

### Patch Changes

- 1f35004: Emit expected/found/missing tool diffs on capability_discovery cross-validation failure, and surface step-level failure details in formatSuiteResults output
- a94a8db: Remove testing UI server and Fly.io deployment. The testing framework is now available via the CLI (`npx @adcp/client`) and Addie. Removes `dotenv` from dependencies (was only used by the server).
- 28d53e6: Extract sandbox account resolution into testable resolveAccountForAudiences function. Add step details for sandbox discovery fallback paths. Add 11 unit tests covering all sandbox resolution branches.

## 4.7.2

### Patch Changes

- 7970f11: Update sandbox account descriptions to clarify behavior by account model. Implicit accounts declare sandbox via sync_accounts with sandbox: true. Explicit accounts discover pre-existing sandbox test accounts via list_accounts. Testing framework now tries explicit sandbox discovery before falling back to natural key.
- d7bc11e: Fix executeTask() to run version adaptation and response normalization, matching the pipeline used by typed methods like getProducts(). Previously, v3-only fields like buying_mode were sent to v2 agents, causing rejection errors.

## 4.7.1

### Patch Changes

- bb0669c: Fix webhook HMAC signature verification to use raw HTTP body bytes instead of re-serialized JSON. `verifyWebhookSignature()` now accepts a raw body string (preferred) or parsed object (backward compat). This fixes cross-language interop where different JSON serializers produce different byte representations.

## 4.7.0

### Minor Changes

- 254a80f: Add sandbox support to AccountCapabilities and testing scenarios. Sellers declaring `account.sandbox: true` in capabilities are now parsed and exposed via `supportsSandbox()`. Test scenarios support `sandbox: true` option to use the natural key (brand + operator + sandbox) without provisioning. Audience sync scenario updated to use `AccountReference` instead of deprecated bare `account_id`.

## 4.6.0

### Minor Changes

- c614f3d: Fix AdCP errors (plural) envelope detection in TaskExecutor, add step-level failure details to formatSuiteResults, and add feature capability validation API (supports/require)

## 4.5.2

### Patch Changes

- fcf2da6: Preserve brand_manifest through request normalization so agents that require it receive it. The normalizer now derives brand from brand_manifest without deleting it.
- d1c85f3: fix: add SSE transport fallback to MCP endpoint discovery

  discoverMCPEndpoint() was only probing candidate URLs with StreamableHTTPClientTransport. Agents that exclusively support the older SSE transport were rejected at the discovery gate, even though callMCPTool() would have handled them correctly. The testEndpoint() helper now mirrors the StreamableHTTP → SSE fallback already present in the tool-call path, so SSE-only agents pass discovery and reach the tool call successfully.

## 4.5.1

### Patch Changes

- dbfff62: Improve type discoverability for platform implementors with naming convention guide in export comments
- 610a4e7: fix: make v3-required by_package fields optional for v2.x agent backward compatibility

  Real-world agents implementing v2.5/v2.6 of the AdCP spec were failing schema validation because v3 added new required fields (pricing_model, rate, currency, breakdown item IDs, total_budget, approval_status) that older agents don't send. Added a BACKWARD_COMPAT_OPTIONAL_FIELDS mechanism to generate-types.ts that removes specified fields from required arrays before TypeScript/Zod generation, without touching the canonical JSON schemas.

## 4.5.0

### Minor Changes

- 128fc8b: Add v3 protocol testing scenarios: property_list_filters, si_handoff, schema_compliance
  - `property_list_filters`: Tests all 4 property list filter types (garm_categories, mfa_thresholds, custom_tags, feature_requirements) with round-trip validation via get_property_list resolve:true
  - `si_handoff`: Tests ACP handoff flow — initiates session, sends purchase-intent message, terminates with `reason: 'handoff_transaction'`, validates acp_handoff structure
  - `schema_compliance`: GET-only validation of v3 field correctness: channel enum values (hard fail on invalid), pricing field names (fixed_price, floor_price placement), format assets structure
  - Adds UI element schema validation to `si_session_lifecycle`: validates all 8 element types (text, link, image, product_card, carousel, action_button, app_handoff, integration_actions) and type-specific required fields
  - Fixes `si_terminate_session` using invalid `reason: 'user_ended'` — corrected to `'user_exit'`

### Patch Changes

- c717bca: Fix MCP discovery probe and A2A canonical URL fetch dropping agent.headers

  Custom headers (e.g. Basic auth) set on an agent config were forwarded to
  callMCPTool correctly but were missing from the initial MCP endpoint discovery
  probe and the A2A canonical URL fetch. Both paths now include agent.headers in
  the same merge order used by the protocol layer: custom headers first, then
  auth_token auth headers on top.

## 4.4.0

### Minor Changes

- 5606dce: Generated Zod object schemas now use `.passthrough()` so unknown fields from agent responses are preserved instead of stripped. Consumers who receive catalog items or other objects with platform-specific extra fields no longer lose those fields after validation.

## 4.3.0

### Minor Changes

- a98c764: Support HTTP Basic auth in testing SDK and fix MCP SSE fallback auth forwarding
  - `TestOptions.auth.type` now accepts `'basic'` in addition to `'bearer'`
  - Basic auth routes the pre-encoded token to `agentConfig.headers` as `Authorization: Basic <token>` instead of `agentConfig.auth_token`, preventing the library from double-wrapping it as Bearer
  - MCP SSE transport fallback now forwards the `Authorization` header via `?auth=` URL param (same workaround already used for `auth_token`), so Basic auth works on agents that only support the older SSE transport
  - Header name lookup for SSE fallback is now case-insensitive
  - A2A debug log now redacts the `Authorization` header value regardless of whether `auth_token` is set (previously only redacted when `auth_token` was present)

### Patch Changes

- 2ea16e3: Fix package.json license field to Apache-2.0 (matching LICENSE file), refine plugin.json description and keywords, correct scenario count from 19 to 20 in SKILL.md.

## 4.2.0

### Minor Changes

- 0f28aa7: Add Claude Code plugin with `/adcp` skill for calling agents, running compliance tests, and querying the registry directly from Claude Code. Includes `.claude-plugin/plugin.json` manifest for marketplace distribution.

## 4.1.0

### Minor Changes

- 5d0c1d2: Sync upstream AdCP v3 schema changes

  **Breaking changes:**
  - `PackageRequest.optimization_goal` (scalar) renamed to `optimization_goals` (array). The seller now optimizes toward goals in priority order. Update all `create_media_buy` callers to pass an array inside each package.
  - `PackageRequest.catalog` (scalar) renamed to `catalogs` (array). Each catalog should have a distinct type. The v2 downgrade adapter uses `catalogs[0]`; multi-catalog support requires v3 servers.
  - `Measurement` type renamed to `OutcomeMeasurement` on `Product.outcome_measurement`.
  - `SyncAccountsRequest` restructured: `house` account type removed; `brand` and `operator` (both required) replace the old free-form structure; billing enum values changed.
  - `SyncAccountsResponse`: `account_id` removed; `parent_account_id` replaced by `account_scope` enum.
  - `ActivateSignalRequest`: `deployments` renamed to `destinations`; new optional `action: 'activate' | 'deactivate'` field added (defaults to `'activate'`).
  - `GetProductsRequest`: `feedback`, `product_ids`, and `proposal_id` fields removed; `refine` buying mode added.
  - `AudienceMember.external_id` is now a required field (was absent). All `sync_audiences` callers must supply a stable buyer-assigned ID per member.
  - `'external_id'` removed from `UIDType` union. Use the top-level `AudienceMember.external_id` field instead.
  - `FrequencyCap.suppress_minutes` is now optional (was required). The type now supports two independent capping modes: recency gate (`suppress_minutes`) and volumetric cap (`max_impressions` + `per` + `window`). At least one must be set.
  - `MediaBuyStatus` now includes `'rejected'` as a terminal state.

  **New features:**
  - `reach` added as an `OptimizationGoal` kind with `reach_unit` and `target_frequency` fields
  - Keyword targeting via `TargetingOverlay.keyword_targets` and `negative_keywords` (search/retail media)
  - Keyword management on `UpdateMediaBuyRequest`: `keyword_targets_add/remove`, `negative_keywords_add/remove`
  - `by_keyword` delivery breakdown in `GetMediaBuyDeliveryResponse`
  - Signal pricing restructured into typed `CpmPricing | PercentOfMediaPricing | FlatFeePricing` models
  - `GetSignalsRequest` updated: `deliver_to` replaced by top-level `destinations?` and `countries?`
  - `ActivateSignalRequest` gains `account_id` and `buyer_campaign_ref`
  - `SignalFilters.max_percent` for filtering percent-of-media signals
  - `buying_mode: 'refine'` for iterative product selection workflows
  - `supports_keyword_breakdown` added to `ReportingCapabilities`
  - Keyword targeting capability flags (`keyword_targets`, `negative_keywords`) in `GetAdCPCapabilitiesResponse`
  - New exports: `OptimizationGoal`, `ReachUnit`, `TargetingOverlay`, `OutcomeMeasurement`, `SignalPricingOption`, `SignalPricing`, `CpmPricing`, `PercentOfMediaPricing`, `FlatFeePricing`
  - New exports: `CreativeBrief`, `CreativeManifest`, `BuildCreativeRequest`, `BuildCreativeResponse`, `PreviewCreativeRequest`, `PreviewCreativeResponse`, `GetMediaBuysRequest`, `GetMediaBuysResponse`
  - New exports: `ImageAsset`, `VideoAsset`, `AudioAsset`, `TextAsset`, `URLAsset`, `HTMLAsset`, `BriefAsset`, `ReferenceAsset`, `EventCustomData`
  - New exports: `Duration`, `DeviceType`, `DigitalSourceType`, `FrequencyCap`, `GeographicBreakdownSupport`
  - New exports: `StandardErrorCode`, `ErrorRecovery`, `TaskErrorDetail`, `STANDARD_ERROR_CODES`, `isStandardErrorCode`, `getErrorRecovery` — standard error code vocabulary for programmatic agent recovery

  **Migration guide: account_id → AccountReference**

  All account-scoped tools now use `account: AccountReference` (a typed discriminated union) instead of the bare `account_id: string`. The `AccountReference` type is exported from `@adcp/client`.

  ```typescript
  // Before
  { account_id: 'acct_123', media_buy_ids: [...] }

  // After
  { account: { account_id: 'acct_123' }, media_buy_ids: [...] }
  ```

  `AccountReference` is a union: `{ account_id: string } | { brand: BrandReference; operator: string }`. Use `account_id` after receiving a seller-assigned ID from `sync_accounts` or `list_accounts`.

  **Automatic backward-compat conversions:**

  The client library auto-converts these deprecated fields with a one-time console warning:

  | Legacy field                       | Converted to                 | Scope                            |
  | ---------------------------------- | ---------------------------- | -------------------------------- |
  | `account_id: string`               | `account: { account_id }`    | All tools                        |
  | `campaign_ref`                     | `buyer_campaign_ref`         | All tools                        |
  | `deployments`                      | `destinations`               | activate_signal                  |
  | `deliver_to`                       | `destinations`               | get_signals                      |
  | `PackageRequest.optimization_goal` | `optimization_goals: [goal]` | create/update_media_buy packages |
  | `PackageRequest.catalog`           | `catalogs: [catalog]`        | create/update_media_buy packages |

  Additionally, the following conversions from earlier releases continue to apply:

  | Legacy field                        | Converted to        | Scope                          |
  | ----------------------------------- | ------------------- | ------------------------------ |
  | `brand_manifest` (string or object) | `brand: { domain }` | get_products, create_media_buy |
  | `product_selectors`                 | `catalog`           | get_products                   |

  These shims ease migration but will be removed in a future major version. Update your code to use the new field names.

## 4.0.2

### Patch Changes

- 2867b24: fix: strip undeclared fields from get_products for partial v3 agents

  Agents that declare `get_adcp_capabilities` (detected as v3) but whose `get_products` inputSchema omits some v3 fields (e.g. `brand`, `buying_mode`) would receive those fields and reject them with a Pydantic `unexpected_keyword_argument` error.

  The client now filters request params to only the fields declared in the agent's cached inputSchema for any v3 tool call. This replaces the previous per-field approach (`toolDeclaresField`) with a general schema-based filter that handles all undeclared fields automatically.

- be452e6: Add v2/v3 adapter for sync_creatives requests

  Introduces `adaptSyncCreativesRequestForV2` which strips the v3-only `account` field and `catalogs` array from each creative, and converts the v3 `status` enum (`'approved'` / `'rejected'`) to the v2 `approved` boolean before sending to v2 servers.

## 4.0.1

### Patch Changes

- 7c6e168: Fix v2/v3 backwards compatibility for create_media_buy, update_media_buy, and get_products

  **Inbound normalization (pre-strict-validation)**
  - `brand_manifest` passed to `create_media_buy` is now converted to `brand` (BrandReference) and stripped before Zod strict validation fires, matching the existing `get_products` pattern. Previously these requests failed with "Request validation failed: Unrecognized key: brand_manifest".
  - `update_media_buy` is no longer incorrectly included in the `brand_manifest` normalization block — neither the v2 nor v3 update schema has a `brand` field.

  **Outbound adaptation (v3 client → v2 server)**
  - `adaptCreateMediaBuyRequestForV2` now converts `brand: { domain }` → `brand_manifest: 'https://<domain>'` before sending to v2 servers. Previously `brand` passed through unchanged and v2 servers rejected it as an unrecognised field.
  - `adaptCreateMediaBuyRequestForV2` now preserves `brand` in the output when it cannot be converted (no `domain` present), consistent with `adaptGetProductsRequestForV2`.
  - `adaptCreateMediaBuyRequestForV2` now throws a clear error when `proposal_id` is present with no packages — proposal mode is v3-only and v2 servers require an explicit `packages` array.
  - `adaptGetProductsRequestForV2` now correctly strips the `account` field (was erroneously deleting `account_id`, a field that doesn't exist at the top level).
  - `adaptPackageRequestForV2` now strips `catalog` from package items — it is a v3-only field not present in the v2 package schema. Applies to both `create_media_buy` and `update_media_buy` packages.
  - Brand manifest URL format aligned: both `get_products` and `create_media_buy` now use the bare domain URL (`https://<domain>`) when converting `brand` → `brand_manifest` for v2 servers.

- 9863b82: Fix get_products failing with "Unexpected keyword argument: buying_mode" on partial v3 agents

  When calling `get_products`, the client infers and adds `buying_mode` to requests for backwards compatibility. For agents detected as v3 (have `get_adcp_capabilities`) but with an incomplete `get_products` implementation that doesn't declare `buying_mode` in its tool schema, this caused a pydantic validation error and the entire call to fail.

  The fix caches tool `inputSchema` data (already fetched via `listTools` during capability detection) and uses it in `adaptRequestForServerVersion` to strip `buying_mode` from `get_products` requests when the agent's schema doesn't declare the field. Fails open — if no schema is cached, the field is sent unchanged.

  This is targeted to `get_products` + `buying_mode` at the existing version-adaptation layer, rather than blanket schema filtering at the protocol layer.

## 4.0.0

### Major Changes

- 6bf2960: Sync upstream schema changes (breaking):
  - `OptimizationGoal` redesigned as discriminated union with `metric` (seller-tracked delivery metrics: clicks, views, etc.) and `event` (advertiser-tracked conversions with multiple event sources) kinds; both support `target` and `priority`
  - `Package.optimization_goal` renamed to `optimization_goals` (array)
  - `Product.conversion_tracking.supported_optimization_strategies` renamed to `supported_targets` with updated values: `target_cost_per|target_threshold_rate|target_per_ad_spend` → `cost_per|per_ad_spend|maximize_value`
  - `account_id?: string` replaced by `account: AccountReference` (required) on `CreateMediaBuyRequest`, `GetMediaBuysRequest`, `SyncCreativesRequest`, `SyncEventSourcesRequest`, `SyncAudiencesRequest`, `SyncCatalogsRequest`, and `GetAccountFinancialsRequest`; `AccountReference` is a `oneOf` supporting `{ account_id }` or `{ brand, operator }` natural key. `GetProductsRequest` gains an optional `account?: AccountReference` field.
  - `Account.house` and `Account.brand_id` removed; replaced by `Account.brand?: BrandReference`
  - `billing` enum: `'brand'` value removed
  - `MediaBuy.campaign_ref` renamed to `buyer_campaign_ref`
  - `Signal.pricing` replaced by `Signal.pricing_options: PricingOption[]`
  - `LogEventRequest` usage records: `operator_id` field removed; `pricing_option_id` field added for billing verification; `kind` field removed
  - `PostalCodeSystem`: added `ch_plz` (Swiss) and `at_plz` (Austrian) postal code systems

  New additions:
  - `OptimizationGoal` metric kind: added `engagements`, `follows`, `saves`, `profile_visits` metrics and optional `view_duration_seconds` for `completed_views` threshold
  - `OptimizationGoal` event kind: added `maximize_value` target kind
  - `Product.metric_optimization` capability object (`supported_metrics`, `supported_view_durations`, `supported_targets`)
  - `Product.max_optimization_goals` field
  - `DeliveryMetrics`: added `engagements`, `follows`, `saves`, `profile_visits` fields
  - `GetAdCPCapabilitiesResponse.conversion_tracking.multi_source_event_dedup` capability flag
  - `get_account_financials` tool with request/response types
  - `BrandID`, `BrandReference`, `AccountReference` types

### Minor Changes

- 9628b8e: Expose account management capabilities from get_adcp_capabilities response

  The `AdcpCapabilities` type now includes an `account` field (type `AccountCapabilities`) populated when the seller declares account management settings in their capabilities response. Fields include:
  - `requireOperatorAuth` — whether per-operator authentication is required
  - `authorizationEndpoint` — OAuth endpoint for operator auth
  - `supportedBilling` — billing models the seller supports
  - `defaultBilling` — default billing when omitted from sync_accounts
  - `requiredForProducts` — whether an account is required before calling get_products

## 3.25.1

### Patch Changes

- fca1a4b: Fix v2 brand_manifest URL: use base domain instead of /.well-known/brand.json path, which may not exist on advertiser domains and caused "brand_manifest must provide brand information" errors from v2 servers like Magnite.

## 3.25.0

### Minor Changes

- 9cb2cf5: feat: adapt get_products requests for v2 servers
  - Add `adaptGetProductsRequestForV2` to convert v3 request fields to v2 equivalents:
    - `brand` (BrandReference) → `brand_manifest` (string URL)
    - `catalog` → `promoted_offerings` (type='offering') or `promoted_offerings.product_selectors` (type='product')
    - v3 channel names mapped to v2 equivalents (olv/ctv → video, streaming_audio → audio, retail_media → retail)
    - Strip v3-only fields: `buying_mode`, `buyer_campaign_ref`, `property_list`, `account_id`, `pagination`
    - Strip v3-only filter fields: `required_features`, `required_axe_integrations`, `required_geo_targeting`, `signal_targeting`, `regions`, `metros`
  - Add `normalizeProductChannels` to expand v2 channel names to v3 on response products (video → [olv, ctv], audio → streaming_audio, native → display, retail → retail_media)
  - Wire `get_products` into `adaptRequestForServerVersion` switch in `SingleAgentClient`
  - Normalize `brand_manifest` and `product_selectors` in `normalizeRequestParams` before Zod validation for backwards compatibility
  - Strip v3-only package fields (`optimization_goal`) and top-level fields (`account_id`, `proposal_id`, `total_budget`, `artifact_webhook`, `reporting_webhook`) when adapting `create_media_buy`/`update_media_buy` for v2 servers

## 3.24.0

### Minor Changes

- 081dc21: Add `findCompany()` to RegistryClient for resolving colloquial brand names to canonical forms via `GET /api/brands/find`
- b3a03f8: Infer buying_mode from brief presence on get_products for backwards compatibility

## 3.23.0

### Minor Changes

- 7143b35: Add `headers` field to `AgentConfig` for per-agent custom HTTP headers

  Enables sending additional HTTP headers (API keys, org IDs, etc.) alongside the standard bearer token on every request to a specific agent. Auth headers always take precedence over custom headers.

## 3.22.0

### Minor Changes

- 3842fcd: Wrap new AdCP capabilities: buying_mode on GetProductsRequest, CatalogFieldMapping, CatalogFieldBinding, Overlay types. Add checkPropertyList and getPropertyCheckReport to RegistryClient. Registry OpenAPI spec now synced automatically via sync-schemas.

## 3.21.0

### Minor Changes

- 6128d21: Sync AdCP schemas and implement get_media_buys tool
  - Add `get_media_buys` request validation via `GetMediaBuysRequestSchema`
  - Add `GetMediaBuysRequest` / `GetMediaBuysResponse` types and Zod schemas (generated)
  - Add `getMediaBuys()` method to `Agent` and `AgentCollection`
  - Add `get_creative_features` types and agent methods
  - Rename `campaign_ref` to `buyer_campaign_ref` across create/update media buy
  - Add `max_bid` boolean to CPM/VCPM/CPC/CPCV/CPV pricing options

## 3.20.0

### Minor Changes

- 55e6294: Add test suite orchestrator to `@adcp/client/testing`

  New exports:
  - `testAllScenarios(agentUrl, options)` — discovers agent capabilities and runs all applicable scenarios, returning a `SuiteResult`
  - `getApplicableScenarios(tools, filter?)` — returns which scenarios are applicable for a given tool list
  - `SCENARIO_REQUIREMENTS` — maps each scenario to its required tools
  - `DEFAULT_SCENARIOS` — the canonical set of scenarios the orchestrator runs
  - `formatSuiteResults(suite)` — markdown formatter for suite results
  - `formatSuiteResultsJSON(suite)` — JSON formatter for suite results
  - `SuiteResult` type — aggregated result across all scenarios
  - `OrchestratorOptions` type — `TestOptions` extended with optional `scenarios` filter

## 3.19.0

### Minor Changes

- 4718fa0: Sync AdCP catalog schemas: add `sync_catalogs` task, `Catalog` core type, and new catalog-related enums (`CatalogType`, `CatalogAction`, `CatalogItemStatus`). The `GetProductsRequest` now accepts a `catalog` field for product selection. Deprecated `PromotedProducts` and `PromotedOfferings` types are retained in the backwards-compatibility layer with a `promotedProductsToCatalog()` migration helper.

## 3.18.0

### Minor Changes

- c8eef79: Sync upstream AdCP schema: sandbox mode support and creative format filters
  - Added `sandbox?: boolean` to `Account`, `MediaBuyFeatures`, and all task response types (`GetProductsResponse`, `CreateMediaBuySuccess`, `UpdateMediaBuySuccess`, `SyncCreativesSuccess`, `ListCreativesResponse`, `ListCreativeFormatsResponse`, `GetMediaBuyDeliveryResponse`, `ProvidePerformanceFeedbackSuccess`, `SyncEventSourcesSuccess`, `LogEventSuccess`, `SyncAudiencesSuccess`, `BuildCreativeSuccess`, `ActivateSignalSuccess`, `GetSignalsResponse`)
  - Added `sandbox?: boolean` filter to `ListAccountsRequest` and `SyncAccountsRequest`
  - Added `output_format_ids` and `input_format_ids` filter fields to `ListCreativeFormatsRequest`
  - Added `input_format_ids` to `Format`

## 3.17.0

### Minor Changes

- 4292c77: Add sync_audiences tool support and BrandReference migration
  - Added `testSyncAudiences()` scenario for testing first-party CRM audience management
  - Added `audienceManagement` feature detection in capabilities
  - Added `sync_audiences` to supported tool list
  - Migrated from `BrandManifest` to `BrandReference` (upstream schema change)
  - Backwards-compatible: `BrandManifest`, `BrandManifestReference`, and `brandManifestToBrandReference()` re-exported from `compat.ts` with deprecation notice
  - Updated `TestOptions` to accept `brand?: { domain: string; brand_id?: string }` and `audience_account_id?: string`

## 3.16.0

### Minor Changes

- 03d47c6: Add full AdCP Registry client with 28 SDK methods and 17 CLI commands

  Generates TypeScript types from the registry OpenAPI spec using openapi-typescript. Expands RegistryClient with methods for brand/property listing, agent discovery, authorization validation, search, and adagents tooling. Adds corresponding CLI commands including list-brands, list-properties, search, agents, publishers, stats, validate, lookup, discover, and check-auth.

### Patch Changes

- 253c86b: Fix: retry StreamableHTTP on session errors instead of falling back to SSE. When a server returns 404 "Session not found", the client now retries with a fresh StreamableHTTP connection rather than incorrectly falling back to SSE transport.

## 3.15.0

### Minor Changes

- 1fb8afc: Sync upstream AdCP schema changes: add CreativeBrief type to BuildCreativeRequest, replace estimated_exposures with forecast on Product, remove proposal_id from GetProductsRequest. Track ADCP_VERSION 'latest' for schema sync.

## 3.14.1

### Patch Changes

- 45b1229: Upgrade @fastify/cors and @fastify/static for Fastify 5 compatibility, fixing production server crash loop
- d22c3b2: Fix OAuth discovery to use RFC 8414 path-aware resolution, trying `{origin}/.well-known/oauth-authorization-server{path}` before falling back to root

## 3.14.0

### Minor Changes

- 094a10b: Add brand and property registry lookup methods via RegistryClient

## 3.13.0

### Minor Changes

- cc02dc8: Sync AdCP schema to 3.0.0-beta.3 with daypart targeting, delivery forecasting, demographic systems, and optional account_id

## 3.12.0

### Minor Changes

- 0d89757: Update to latest AdCP schema with new features:

  **Breaking type changes:**
  - **BrandManifest tone**: Changed from `string` to object with `voice`, `attributes`, `dos`, `donts`
  - **Format.type**: Now optional (`FormatCategory` deprecated in favor of assets array)

  **Targeting & Signals:**
  - **TargetingOverlay**: Added `age_restriction`, `device_platform`, and `language` fields
  - **BrandManifest logos**: Added structured fields (`orientation`, `background`, `variant`)
  - **Data Provider Signals**: New `DataProviderSignalSelector` and `SignalTargeting` types
  - **get_signals**: Now supports `signal_ids` for exact lookups in addition to `signal_spec`

  **Conversion Tracking:**
  - New `EventType` and `ActionSource` enums
  - `Package.optimization_goal` for target ROAS/CPA with attribution windows
  - `Product.conversion_tracking` for conversion-optimized delivery
  - New `sync_event_sources` and `log_event` tools (with Agent class methods)
  - Delivery metrics: `conversion_value`, `roas`, `cost_per_acquisition`, event type breakdowns

  **Creative:**
  - `UniversalMacro` typed enum for creative tracking macro placeholders
  - `BaseIndividualAsset` / `BaseGroupAsset` extracted as named interfaces

  **Pagination:**
  - Standardized `PaginationRequest` / `PaginationResponse` types across all list endpoints
  - New `paginate()` utility to auto-collect all items across pages
  - New `paginatePages()` async generator for progressive page-by-page loading
  - Deprecated legacy `PaginationOptions` (offset/limit pattern)

  **Product Discovery & Pricing:**
  - `PromotedProducts` interface for product selector queries
  - `CPAPricingOption` for cost-per-acquisition pricing model
  - `isCPAPricing()` helper to detect CPA pricing options
  - Geo exclusion fields (`geo_countries_exclude`, `geo_regions_exclude`, etc.)

  **Capabilities:**
  - `EVENT_TRACKING_TOOLS` constant for conversion tracking tool detection
  - `conversionTracking` feature flag in `MediaBuyFeatures`
  - Added `age_restriction`, `device_platform`, `language` feature flags

  **Exports:**
  - All new types exported from main barrel: `PromotedProducts`, `CPAPricingOption`, `EventType`, `ActionSource`, `SyncEventSourcesRequest/Response`, `LogEventRequest/Response`
  - `isCPAPricing` utility exported alongside existing pricing helpers

## 3.11.2

### Patch Changes

- bbdb92a: Add OAuth support to CLI test command
  - Add `--oauth` flag to test command for OAuth-protected MCP agents
  - Send both `Authorization: Bearer` and `x-adcp-auth` headers in MCP requests (standard OAuth header + legacy AdCP for backwards compatibility)
  - Add token expiry check before running tests with saved OAuth tokens

## 3.11.1

### Patch Changes

- 6ec7e3e: Extract shared `is401Error` helper for centralized 401 authentication error detection

## 3.11.0

### Minor Changes

- cdcf3a7: Add `@adcp/client/auth` export path for OAuth and authentication utilities

## 3.10.0

### Minor Changes

- d7f6ce7: Add OAuth discovery utilities for checking if MCP servers support OAuth authentication.

  New exports:
  - `discoverOAuthMetadata(agentUrl)` - Fetches OAuth Authorization Server Metadata from `/.well-known/oauth-authorization-server`
  - `supportsOAuth(agentUrl)` - Simple boolean check if server supports OAuth
  - `supportsDynamicRegistration(agentUrl)` - Check if server supports dynamic client registration
  - `OAuthMetadata` type - RFC 8414 Authorization Server Metadata structure
  - `DiscoveryOptions` type - Options for discovery requests (timeout, custom fetch)

### Patch Changes

- d7f6ce7: Export Account domain types from main entry point
  - `Account` - billing account interface
  - `ListAccountsRequest` - request params for listing accounts
  - `ListAccountsResponse` - response payload with accounts array

  The types existed in tools.generated.ts but weren't explicitly exported from @adcp/client.

## 3.9.0

### Minor Changes

- 1e919b7: ### Breaking Changes

  **TaskExecutor behavior changes for async statuses:**
  - **`working` status**: Now returns immediately as a successful result (`success: true`, `status: 'working'`) instead of polling until completion or timeout. Callers should use the returned `taskId` to poll for completion or set up webhooks.
  - **`input-required` status**: Now returns as a successful paused state (`success: true`, `status: 'input-required'`) instead of throwing `InputRequiredError` when no handler is provided. Access the input request via `result.metadata.inputRequest`.

  **Migration:**

  ```typescript
  // Before: catching InputRequiredError
  try {
    const result = await executor.executeTask(agent, task, params);
  } catch (error) {
    if (error instanceof InputRequiredError) {
      // Handle input request
    }
  }

  // After: checking result status
  const result = await executor.executeTask(agent, task, params);
  if (result.status === 'input-required') {
    const { question, field } = result.metadata.inputRequest;
    // Handle input request
  }
  ```

  **Conversation context changes:**
  - `wasFieldDiscussed(field)`: Now returns `true` only if the agent explicitly requested that field via an `input-required` response (previously checked if any message contained the field).
  - `getPreviousResponse(field)`: Now returns the user's response to a specific field request (previously returned any message content containing the field).

  ### New Features
  - Added v3 protocol testing scenarios:
    - `capability_discovery` - Test `get_adcp_capabilities` and verify v3 protocol support
    - `governance_property_lists` - Test property list CRUD operations
    - `governance_content_standards` - Test content standards listing and calibration
    - `si_session_lifecycle` - Test full SI session: initiate → messages → terminate
    - `si_availability` - Quick check for SI offering availability
  - Exported `ProtocolClient` and related functions from main library for testing purposes

- 38ba6a6: Add OAuth support for MCP servers
  - New OAuth module in `src/lib/auth/oauth/` with pluggable flow handlers
  - `MCPOAuthProvider` implements MCP SDK's `OAuthClientProvider` interface
  - `CLIFlowHandler` for browser-based OAuth with local callback server
  - OAuth tokens stored directly in AgentConfig alongside static auth tokens
  - CLI flags: `--oauth` for OAuth auth, `--clear-oauth` to clear tokens
  - `--save-auth <alias> <url> --oauth` to save agents with OAuth
  - Auto-detection of OAuth requirement when MCP servers return UnauthorizedError
  - Helper functions: `hasValidOAuthTokens`, `clearOAuthTokens`, `getEffectiveAuthToken`
  - Security fix: use spawn instead of exec for browser open to prevent command injection

## 3.8.1

### Patch Changes

- 7365296: Fix schema validation for v2 pricing options in get_products responses

  When servers return v2-style pricing options (rate, is_fixed, price_guidance.floor), schema validation now normalizes them to v3 format (fixed_price, floor_price) before validation. This ensures v2 server responses pass validation against v3 schemas.

## 3.8.0

### Minor Changes

- d3869a1: Add ADCP v3.0 compatibility while preserving v2.5/v2.6 backward compatibility

  **New Features:**
  - Capability detection via `get_adcp_capabilities` tool or synthetic detection from tool list
  - v3 request/response adaptation for pricing fields (fixed_price, floor_price)
  - Authoritative location redirect handling with loop detection and HTTPS validation
  - Server-side adapter interfaces (ContentStandardsAdapter, PropertyListAdapter, ProposalManager, SISessionManager)
  - New domains: governance, sponsored-intelligence, protocol

  **Adapters:**
  - Pricing adapter: normalizes v2 (rate, is_fixed) to v3 (fixed_price, floor_price)
  - Creative adapter: handles v2/v3 creative assignment field differences
  - Format renders adapter: normalizes format render structures
  - Preview normalizer: handles v2/v3 preview response differences

  **Breaking Change Handling:**
  - All v2 responses automatically normalized to v3 API
  - Clients always see v3 field names regardless of server version
  - v2 servers receive adapted requests with v2 field names

### Patch Changes

- d3869a1: Fix multi-agent partial failure handling using Promise.allSettled

## 3.7.1

### Patch Changes

- 3a60592: Fix JavaScript syntax error in testing UI and update hono for security
  - **UI Fix**: Resolved syntax error in `index.html` dimension parsing logic that caused `toggleAddAgent` and other functions to be undefined. The invalid `} else { } else if {` structure was corrected to proper nested conditionals.
  - **Security**: Updated `hono` from 4.11.3 to 4.11.4 to fix high-severity JWT algorithm confusion vulnerabilities (GHSA-3vhc-576x-3qv4, GHSA-f67f-6cw9-8mq4).

## 3.7.0

### Minor Changes

- 302089a: Add AdCP v2.6 support with backward compatibility for Format schema changes
  - New `assets` field in Format schema (replaces deprecated `assets_required`)
  - Added format-assets utilities: `getFormatAssets()`, `getRequiredAssets()`, `getOptionalAssets()`, etc.
  - Updated testing framework to use new utilities
  - Added URL input option for image/video assets in testing UI
  - Added 21 unit tests for format-assets utilities

## 3.6.0

### Minor Changes

- 2749985: Add `test` subcommand to CLI for running agent test scenarios

  New CLI command enables testing AdCP agents directly from the command line:

  ```bash
  # List available test scenarios
  npx @adcp/client test --list-scenarios

  # Run discovery tests against the built-in test agent
  npx @adcp/client test test

  # Run a specific scenario
  npx @adcp/client test test full_sales_flow

  # Test your own agent
  npx @adcp/client test https://my-agent.com discovery --auth $TOKEN

  # JSON output for CI pipelines
  npx @adcp/client test test discovery --json
  ```

  Available scenarios include: health_check, discovery, create_media_buy, full_sales_flow,
  error_handling, validation, pricing_edge_cases, and more.

  The command exits with code 0 on success, 3 on test failure, making it suitable for CI pipelines.

## 3.5.2

### Patch Changes

- fb041b6: Fix validation error when agents return empty publisher_domains array

  The JSON Schema defines `minItems: 1` for publisher_domains, which caused validation to fail when agents returned empty arrays. This is a common scenario when an agent isn't authorized for any publishers yet.

  The fix relaxes the generated TypeScript types and Zod schemas to accept empty arrays by:
  - Removing `minItems` constraints during TypeScript type generation
  - Converting tuple patterns (`z.tuple([]).rest()`) to arrays (`z.array()`) in Zod schema generation

  This change improves interoperability with real-world agents that may return empty arrays for optional array fields.

## 3.5.1

### Patch Changes

- 15244b1: fix(testing): Use publisher_domains instead of legacy authorized_properties in discovery tests

## 3.5.0

### Minor Changes

- 6d5d050: Add comprehensive E2E agent testing framework with support for discovery, media buy creation, creative sync, and behavioral analysis scenarios.
- 9b34827: Simplify authentication configuration by removing `requiresAuth` and `auth_token_env` fields.

  **Breaking Changes:**
  - `AgentConfig.requiresAuth` has been removed - if `auth_token` is provided, it will be used
  - `AgentConfig.auth_token_env` has been removed - use `auth_token` directly with the token value

  **Migration:**

  ```typescript
  // Before
  const config = {
    id: 'my-agent',
    agent_uri: 'https://agent.example.com',
    protocol: 'mcp',
    requiresAuth: true,
    auth_token_env: 'MY_TOKEN_ENV_VAR', // or auth_token: 'direct-token'
  };

  // After
  const config = {
    id: 'my-agent',
    agent_uri: 'https://agent.example.com',
    protocol: 'mcp',
    auth_token: process.env.MY_TOKEN_ENV_VAR, // or 'direct-token'
  };
  ```

  The simplified model: if `auth_token` is provided, it's sent with requests. If not provided, no authentication is sent.

### Patch Changes

- e602659: Regenerate TypeScript types to match AdCP v2.5.1 schemas

## 3.4.0

### Minor Changes

- 0494341: Updates webhook handler to better support mcp and a2a payloads. Adds typed payloads; Makes reporting webhook configurable;

### Patch Changes

- a639f2c: Fix skipping .data generation when status is submitted
- b1ad29d: feat: URL canonicalization and agent comparison

  **Auto-detect A2A protocol for .well-known/agent-card.json URLs**

  When users provide a `.well-known/agent-card.json` URL (e.g., `https://example.com/.well-known/agent-card.json`), the library now correctly detects this as an A2A agent card discovery URL and switches to the A2A protocol.

  **Canonical URL resolution**

  Added methods to resolve and compare agents by their canonical base URL:
  - `getCanonicalUrl()` - Synchronously returns the canonical base URL (computed from configured URL)
  - `resolveCanonicalUrl()` - Async method that fetches the agent card (A2A) or discovers endpoint (MCP) to get the authoritative canonical URL
  - `isSameAgent(other)` - Compare two agents by canonical URL
  - `isSameAgentResolved(other)` - Async comparison that resolves canonical URLs first
  - `getResolvedAgent()` - Get agent config with canonical URL resolved

  Canonical URL computation:
  - For A2A: Uses the `url` field from the agent card, or strips `/.well-known/agent-card.json`
  - For MCP: Strips `/mcp` or `/mcp/` suffix from discovered endpoint

  This enables comparing agents regardless of how they were configured:

  ```typescript
  // These all resolve to the same canonical URL: https://example.com
  agent1.agent_uri = 'https://example.com';
  agent2.agent_uri = 'https://example.com/mcp';
  agent3.agent_uri = 'https://example.com/.well-known/agent-card.json';

  client.agent('agent1').isSameAgent(client.agent('agent2')); // true
  ```

  Fixes #175

## 3.3.3

### Patch Changes

- fbc29ae: Fix CLI --auth flag to use literal token values directly

  The CLI was incorrectly setting `auth_token_env` (environment variable name) instead of `auth_token` (direct value) when the user provided `--auth TOKEN`. This caused authentication to fail with "Environment variable not found" warnings because the auth module tried to look up the literal token as an environment variable name.

- 53d7cec: Remove spurious index signature types from generated validation schemas

  The `json-schema-to-typescript` library was incorrectly generating index signature types (e.g., `{ [k: string]: unknown }`) for schemas with `oneOf` and `additionalProperties: false`. This caused validation to allow arbitrary extra fields on requests like `update_media_buy` and `provide_performance_feedback`.

  Changes:
  - Added `removeIndexSignatureTypes()` function to post-process generated types
  - Added `update_media_buy` and `list_creatives` schemas to the validation map
  - Added tests for request validation with extra fields

## 3.3.2

### Patch Changes

- 27693b2: Fixed CLI bug where agentConfig was not wrapped in array for AdCPClient constructor

## 3.3.1

### Patch Changes

- ec50aae: Fix Zod schema validation to accept null values for all optional fields. Updated the schema generator to apply `.nullish()` globally to all optional schema fields, allowing both `null` and `undefined` values where TypeScript types permit.

## 3.3.0

### Minor Changes

- a322f4c: fix: treat working/input-required as valid intermediate states and extract A2A webhook payloads
  - `working` status now returns immediately with `status: 'working'` instead of polling and timing out
  - `input-required` status returns valid result instead of throwing `InputRequiredError` when no handler provided
  - Made `success=true` consistent for all intermediate states (working, submitted, input-required, deferred)
  - Added `taskType` parameter to `handleWebhook` for all client classes (SingleAgentClient, AgentClient, ADCPMultiAgentClient)
  - `handleWebhook` now extracts ADCP response from raw A2A task payloads (artifacts[0].parts[].data where kind === 'data')
  - Handlers now receive unwrapped ADCP responses instead of raw A2A protocol structure

## 3.2.1

### Patch Changes

- 918a91a: Fixed ProtocolResponseParser to correctly detect input-required status in A2A JSON-RPC wrapped responses. The parser now checks response.result.status.state for A2A responses before falling back to other status locations, preventing "Schema validation failed" errors when agents return input-required status.

## 3.2.0

### Minor Changes

- 8b05170: Clean up SDK public API and improve response handling

  IMPROVEMENTS:
  1. Agent class methods now return raw AdCP responses matching schemas exactly
  2. Removed internal implementation details from public API exports
  3. Added response utilities: unwrapProtocolResponse, isAdcpError, isAdcpSuccess

  ## What Changed

  **Low-level Agent class** now returns raw AdCP responses matching the protocol specification:
  - Success responses have required fields per schema (packages, media_buy_id, buyer_ref)
  - Error responses follow discriminated union: `{ errors: [{ code, message }] }`
  - Errors returned as values, not thrown as exceptions

  **High-level clients unchanged** - ADCPMultiAgentClient, AgentClient, and SingleAgentClient still return `TaskResult<T>` with status-based patterns. No migration needed for standard usage.

  ## API Export Cleanup

  Removed internal utilities that were never meant for public use:
  - Low-level protocol clients (ProtocolClient, callA2ATool, callMCPTool)
  - Internal utilities (CircuitBreaker, getCircuitBreaker, generateUUID)
  - Duplicate exports (NewAgentCollection)

  Public API now includes only user-facing features:
  - All Zod schemas (for runtime validation, forms)
  - Auth utilities (getAuthToken, createAdCPHeaders, etc.)
  - Validation utilities (validateAgentUrl, validateAdCPResponse)
  - Response utilities (unwrapProtocolResponse, isAdcpError, isAdcpSuccess)

  ## Migration Guide (Only if using low-level Agent class directly)

  **Most users don't need to migrate** - if you're using ADCPMultiAgentClient, AgentClient, or SingleAgentClient, no changes needed.

  ### If using Agent class directly:

  ```javascript
  // Before:
  const agent = new Agent(config, client);
  const result = await agent.createMediaBuy({...});
  if (result.success) {
    console.log(result.data.media_buy_id);
  }

  // After:
  const agent = new Agent(config, client);
  const result = await agent.createMediaBuy({...});
  if (result.errors) {
    console.error('Failed:', result.errors);
  } else {
    console.log(result.media_buy_id, result.buyer_ref);
  }
  ```

  ### Removed Internal Exports

  If you were importing `ProtocolClient`, `CircuitBreaker`, or other internal utilities, use the public Agent class instead.

### Patch Changes

- b2b7c8b: Fixed A2A webhook configuration placement to match A2A SDK specification.

  **Bug Fix: A2A Webhook Configuration Placement**

  The A2A protocol requires webhook configuration to be placed in the top-level `configuration` object, not in skill parameters.

  **Correct format per A2A SDK:**

  ```javascript
  {
    message: { messageId, role, kind, parts: [...] },
    configuration: {
      pushNotificationConfig: { url, headers }
    }
  }
  ```

  **Previous incorrect format:**

  ```javascript
  {
    message: {
      parts: [
        {
          data: {
            skill: 'toolName',
            parameters: {
              pushNotificationConfig: { url, headers }, // WRONG - not a skill parameter
            },
          },
        },
      ];
    }
  }
  ```

  **Changes:**
  - Moved `pushNotificationConfig` from skill parameters to `params.configuration` in A2A protocol handler
  - MCP protocol correctly continues to use `push_notification_config` in tool arguments (per MCP spec)
  - Uses generated `PushNotificationConfig` type from AdCP schema for type safety
  - Fixed A2A artifact validation to check `artifactId` field per @a2a-js/sdk Artifact interface

  **Documentation:**
  - Added AGENTS.md section clarifying `push_notification_config` (async task status) vs `reporting_webhook` (reporting metrics)
  - Both use PushNotificationConfig schema but have different purposes and placement requirements

- 8b05170: Fix CLI tool missing dependency file in published package. The adcp command now works correctly when installed via npx.

## 3.1.0

### Minor Changes

- discriminated-unions-fix: Add discriminated union support and fix missing AdCP tools. Re-synced AdCP schemas to include all 13 tools (was only generating 4). Added support for discriminated unions in type definitions.
- slow-kings-boil: Fixed critical validation bug where sync_creatives, create_media_buy, build_creative, and get_products requests were not being validated. Request validation now uses strict mode to reject unknown top-level fields.

### Patch Changes

- 1763342270: Added explicit auth_token field and fixed auth_token_env to properly support environment variable lookup. AgentConfig now supports two authentication methods: auth_token (direct value) and auth_token_env (environment variable name).
- d064ad36: Fixed A2A protocol to use 'parameters' field instead of 'input' per AdCP specification.
- make-reporting-webhook-configurable: Make reporting_webhook configurable.

## 3.0.3

### Patch Changes

- a4cc9da: Fix CLI tool missing dependency file in published package. The adcp command now works correctly when installed via npx.

## 3.0.2

### Patch Changes

- 579849e: add support for application level context management

## 3.0.1

### Patch Changes

- c24cd21: Fix CLI tool missing dependency file in published package. The adcp command now works correctly when installed via npx.
- c24cd21: Fixed MCP and A2A protocol authentication issues. MCP endpoints now receive required Accept headers, and CLI properly sets requiresAuth flag for authenticated agents.

## 3.0.0

### Major Changes

- 5c1d32e: Simplified API surface - removed deprecated exports and renamed primary client to `AdCPClient`.

  ## Breaking Changes

  **Removed:**
  - `AdCPClient` (deprecated wrapper with confusing lowercase 'd')
  - `createAdCPClient()`, `createAdCPClientFromEnv()` factory functions
  - `createADCPClient()`, `createADCPMultiAgentClient()` factory functions
  - `SingleAgentClient` and `AgentClient` exports from `/advanced` (use `client.agent(id)` instead)

  **Moved to `/advanced`:**
  - Protocol-level clients: `ProtocolClient`, `callMCPTool`, `callA2ATool`, `createMCPClient`, `createA2AClient`

  **Renamed:**
  - `ADCPMultiAgentClient` → `AdCPClient` (primary export, proper AdCP capitalization)

  ## New API

  ```typescript
  import { AdCPClient } from '@adcp/client';

  const client = new AdCPClient([agentConfig]);
  const client = AdCPClient.fromEnv();
  ```

  Works for single or multiple agents. See `MIGRATION-v3.md` for migration guide.

### Minor Changes

- bd57dd1: Added test helpers for easy testing and self-documenting examples. New exports include `testAgent` (pre-configured MCP test agent), `testAgentA2A` (pre-configured A2A test agent), `testAgentNoAuth` / `testAgentNoAuthA2A` (unauthenticated variants for demonstrating auth requirements), `testAgentClient` (multi-agent client with both protocols), `createTestAgent()` helper function, and `creativeAgent` (pre-configured MCP creative agent). Test helpers are available via `@adcp/client/testing` subpath export and provide instant access to AdCP's public test agent and official creative agent with no configuration required.

  Also added built-in CLI aliases (`test`, `test-a2a`, `test-no-auth`, `test-a2a-no-auth`, `creative`) for zero-config command-line access to test and creative agents.

### Patch Changes

- bd57dd1: Fixed authentication bug where tokens shorter than 20 characters were incorrectly treated as environment variable names. The `auth_token_env` field now always contains the actual token value. For environment variable expansion, use shell substitution (e.g., `--auth $MY_TOKEN`).

## 2.7.2

### Patch Changes

- 523e490: Fix CLI tool missing dependency file in published package. The adcp command now works correctly when installed via npx.
- a73d530: Fix MCP authentication bug where x-adcp-auth header was not being sent to servers. The client now properly includes authentication headers in all MCP requests using the SDK's requestInit.headers option instead of a custom fetch function. This fixes authentication failures with MCP servers that require the x-adcp-auth header.
- 35eab77: Fixed ADCP schema validation for framework-wrapped responses. When agent frameworks like ADK wrap tool responses in the A2A FunctionResponse format `{ id, name, response: {...} }`, the client now correctly extracts the nested data before validation instead of validating the wrapper object. This fixes "formats: Required" validation errors when calling ADK-based agents.
- bae7d59: Added EditorConfig and Prettier configuration files to enforce consistent code style across editors. Updated git hooks to support longer commit messages and improved commit-msg hook to work across different Node.js environments. Fixed localStorage issue in demo agent site that was erasing custom agents on page load.

## 2.7.1

### Patch Changes

- ea72f62: call onActivity function within all tool request/response

## 2.6.1

### Patch Changes

- 1027d34: Fix CLI tool missing dependency file in published package. The adcp command now works correctly when installed via npx.

## 2.5.7

### Patch Changes

- 48add90: PropertyCrawler: Add browser headers and graceful degradation for missing properties array

  **Fixes:**
  1. **Browser-Like Headers**: PropertyCrawler now sends standard browser headers when fetching `.well-known/adagents.json` files:
     - User-Agent: Standard Chrome browser string (required by CDNs like Akamai)
     - Accept, Accept-Language, Accept-Encoding: Browser-standard values
     - From: Crawler identification per RFC 9110 (includes library version)

     This resolves 403 Forbidden errors from publishers with CDN bot protection (e.g., AccuWeather, Weather.com).

  2. **Graceful Degradation**: When a publisher has a valid `adagents.json` file with `authorized_agents` but no `properties` array, PropertyCrawler now:
     - Infers a default property based on the domain
     - Returns the property as discoverable
     - Includes a warning message to guide publishers to add explicit properties
     - Adds warnings array to `CrawlResult` interface

  This enables property discovery even when publishers have completed only partial AdCP setup, improving real-world compatibility.

  **Real-World Impact:**
  - AccuWeather: Now successfully crawled (was failing with 403)
  - Weather.com: Now returns inferred property (was returning nothing)
  - Result: Properties discoverable from partial implementations

  **Breaking Changes:** None - API remains backward compatible. The `CrawlResult.warnings` field is new but optional.

  Fixes #107

## 2.5.6

### Patch Changes

- 470151b: Fixed timeout handling tests to match TaskExecutor behavior. Tests now correctly expect error results instead of thrown exceptions when timeouts occur.
- 934e89f: Fixed Zod schema generation failures and made generation errors fatal. Previously, `ts-to-zod` was failing to generate 19 schemas (including `GetProductsRequestSchema` and `GetProductsResponseSchema`) due to cross-file dependency issues. Now all 82 schemas generate successfully and failures exit with error code 1 to catch issues early.
- 79423e3: Add configurable log levels to PropertyCrawler to reduce noise from expected failures. The PropertyCrawler now accepts a `logLevel` option ('error' | 'warn' | 'info' | 'debug' | 'silent') that controls logging verbosity. Expected failures (404s, HTML responses, missing .well-known/adagents.json files) are now logged at debug level instead of error/warn level, while unexpected failures remain at error level. This prevents log pollution when domains don't have adagents.json files, which is a common and expected scenario.

## 2.5.5

### Patch Changes

- d02ed3c: Fix MCP endpoint discovery Accept header handling and send both auth headers

  The `discoverMCPEndpoint()` and `getAgentInfo()` methods had issues with header handling:
  1. **Lost Accept headers**: Didn't preserve the MCP SDK's required `Accept: application/json, text/event-stream` header
  2. **Missing Authorization header**: Only sent `x-adcp-auth` but some servers expect both headers

  Changes:
  - Updated `discoverMCPEndpoint()` to use the same header-preserving pattern as `callMCPTool()`
  - Updated `getAgentInfo()` to properly handle Headers objects without losing SDK defaults
  - Both methods now correctly extract and merge headers from Headers objects, arrays, and plain objects
  - Now sends **both** `Authorization: Bearer <token>` and `x-adcp-auth: <token>` for maximum compatibility
  - Added TypeScript type annotations for Headers.forEach callbacks

  Impact:
  - MCP endpoint discovery now works correctly with FastMCP SSE servers
  - Authentication works with servers expecting either `Authorization` or `x-adcp-auth` headers
  - Accept headers are properly preserved (fixes "406 Not Acceptable" errors)

## 2.5.4

### Patch Changes

- 3061375: Fixed MCP Accept header handling for Headers objects

  The customFetch function in mcp.ts was incorrectly handling Headers objects by using object spread syntax (`{...init.headers}`), which returns an empty object for Headers instances. This caused the MCP SDK's required `Accept: application/json, text/event-stream` header to be lost.

  **Changes:**
  - Fixed Headers object extraction to use `forEach()` instead of object spread
  - Fixed plain object extraction to use `for...in` loop with `hasOwnProperty` check
  - Added comprehensive tests for Headers object handling and Accept header preservation

  **Bug Timeline:**
  - Bug introduced in v2.3.2 (commit 086be48)
  - Exposed between v2.5.0 and v2.5.1 when SDK started passing Headers objects
  - Fixed in this release

  **Impact:**
  - MCP protocol requests now correctly include the required Accept header
  - MCP servers will no longer reject requests due to missing Accept header

- 4a3e04a: Upgraded @modelcontextprotocol/sdk to 1.20.2

  Updated the MCP SDK dependency from 1.19.1 to 1.20.2 to get the latest bug fixes and improvements.

## 2.5.3

### Patch Changes

- 3061375: Fixed MCP Accept header handling for Headers objects

  The customFetch function in mcp.ts was incorrectly handling Headers objects by using object spread syntax (`{...init.headers}`), which returns an empty object for Headers instances. This caused the MCP SDK's required `Accept: application/json, text/event-stream` header to be lost.

  **Changes:**
  - Fixed Headers object extraction to use `forEach()` instead of object spread
  - Fixed plain object extraction to use `for...in` loop with `hasOwnProperty` check
  - Added comprehensive tests for Headers object handling and Accept header preservation

  **Bug Timeline:**
  - Bug introduced in v2.3.2 (commit 086be48)
  - Exposed between v2.5.0 and v2.5.1 when SDK started passing Headers objects
  - Fixed in this release

  **Impact:**
  - MCP protocol requests now correctly include the required Accept header
  - MCP servers will no longer reject requests due to missing Accept header

- 4a3e04a: Upgraded @modelcontextprotocol/sdk to 1.20.2

  Updated the MCP SDK dependency from 1.19.1 to 1.20.2 to get the latest bug fixes and improvements.

## 2.5.2

### Patch Changes

- cc82c4d: Fixed A2A protocol discovery endpoint and Accept headers
  - Changed discovery endpoint from incorrect `/.well-known/a2a-server` to correct `/.well-known/agent-card.json` per A2A spec
  - Updated Accept header from `application/json` to `application/json, */*` for better compatibility with various server implementations
  - Updated protocol detection test to correctly expect A2A detection for test-agent.adcontextprotocol.org

## 2.5.1

### Patch Changes

- 799dc4a: Optimize pre-push git hook for faster development workflow
  - Reduced pre-push hook execution time from 5+ minutes to ~2-5 seconds
  - Now only runs essential fast checks: TypeScript typecheck + library build
  - Removed slow operations: schema sync, full test suite
  - Full validation (tests, schemas) still runs in GitHub Actions CI
  - Makes git push much faster while catching TypeScript and build errors early

- b257d06: Improved debug logging and error messages for MCP protocol errors
  - CLI now displays debug logs, conversation history, and full metadata when --debug flag is used
  - MCP error responses (`isError: true`) now extract and display the actual error message from `content[].text`
  - Previously showed "Unknown error", now shows detailed error like "Error calling tool 'list_authorized_properties': name 'get_testing_context' is not defined"
  - Makes troubleshooting agent-side errors much easier for developers

- 24a5ed7: UI formatting and error logging improvements
  - Fixed media buy packages to include format_ids array (was causing Pydantic validation errors)
  - Added error-level logging for failed media buy operations (create, update, get_delivery)
  - Fixed format objects display in products table (was showing [object Object])
  - Added runtime schema validation infrastructure with Zod
  - Added request validation to AdCPClient (fail fast on invalid requests)
  - Added configurable validation modes (strict/non-strict) via environment variables
  - Preserved trailing slashes in MCP endpoint discovery
  - Improved error display in UI debug panel with proper formatting
  - Added structured logger utility to replace console statements
  - **BREAKING**: Aligned budget handling with AdCP spec - MediaBuy.budget (object) is now MediaBuy.total_budget (number)
  - **BREAKING**: Removed budget field from CreateMediaBuyRequest (calculated from packages per spec)

## 2.5.0

### Minor Changes

- 739ed7a: Add protocol auto-detection to CLI tool - users can now omit the protocol argument and the CLI will automatically detect whether an endpoint uses MCP or A2A via discovery and URL pattern heuristics
- 739ed7a: Add agent alias support to CLI tool - save agent configurations with short aliases for quick access. Users can now save agents with `--save-auth <alias> <url>` and call them with just `adcp <alias> <tool> <payload>`. Config stored in ~/.adcp/config.json with secure file permissions.

### Patch Changes

- 739ed7a: Fix pre-push hook to skip slow tests by setting CI=true, matching GitHub Actions behavior and preventing unnecessary test timeouts during git push
- 8f9270c: Fix webhook HMAC verification by propagating X-ADCP-Timestamp header through AgentClient.handleWebhook() and server route. Update update_media_buy tool signature to remove push_notification_config (matches create_media_buy). Add auto-injection of reporting_webhook in createMediaBuy when webhookUrlTemplate is configured.

# 2.4.2

- Update `update_media_buy` tool signature to match `create_media_buy` - remove `push_notification_config` from request
- Fix webhook HMAC verification by propagating `X-ADCP-Timestamp` through `AgentClient.handleWebhook` and server route

  Previously, the server only forwarded `X-ADCP-Signature` to the client verifier. The timestamp required by the HMAC scheme (message = `{timestamp}.{json_payload}`) was not passed through, causing verification to fail when `webhookSecret` was enabled. This change:
  - Updates `AgentClient.handleWebhook(payload, signature, timestamp)` to accept and forward the timestamp.
  - Updates the webhook route to extract `X-ADCP-Timestamp` and pass it into `handleWebhook`.
  - Allows `AdCPClient.handleWebhook` to successfully validate signatures using both headers.

## 2.4.1

### Patch Changes

- 9f18fa1: Fix CLI tool missing dependency file in published package. The adcp command now works correctly when installed via npx.

## 2.4.0

### Minor Changes

- 5030c85: Add CLI tool and MCP endpoint auto-discovery
  - Add command-line tool (`bin/adcp.js`) for testing AdCP agents
  - Add automatic MCP endpoint discovery (tests provided path, then tries adding /mcp)
  - Add `getAgentInfo()` method for discovering agent capabilities
  - CLI supports tool discovery, execution, authentication, and async webhook handling

## 2.3.2

### Patch Changes

- 3f8460b: Fix conditional fetch logic for auth headers to prevent sporadic authentication failures when making parallel requests

## 2.3.1

### Patch Changes

- 87bb6d2: Fix A2A Authorization header being overwritten by SDK headers. The custom fetchImpl now spreads SDK headers first, then applies auth headers to ensure they take precedence.
- a8cbaf7: Fix creative sync validation errors by correcting format field name and structure

  Multiple locations in the codebase were incorrectly using `format` instead of `format_id` when creating creative assets for sync_creatives calls. This caused the AdCP agent to reject creatives with validation errors: "Input should be a valid dictionary or instance of FormatId".

  **Fixed locations:**
  - `src/public/index.html:8611` - Creative upload form
  - `src/public/index.html:5137` - Sample creative generation
  - `scripts/manual-testing/full-wonderstruck-test.ts:284` - Test script (also fixed to use proper FormatID object structure)

  All creatives are now properly formatted according to the AdCP specification with the correct `format_id` field containing a FormatID object with `agent_url` and `id` properties.

## 2.3.0

### Minor Changes

- 329ce6e: Add Zod schema exports for runtime validation with automatic generation

  This release adds Zod schema exports alongside existing TypeScript types, enabling runtime validation of AdCP data structures. All core schemas, request schemas, and response schemas are now available as Zod schemas.

  **New exports:**
  - Core schemas: `MediaBuySchema`, `ProductSchema`, `CreativeAssetSchema`, `TargetingSchema`
  - Request schemas: `GetProductsRequestSchema`, `CreateMediaBuyRequestSchema`, `SyncCreativesRequestSchema`, etc.
  - Response schemas: `GetProductsResponseSchema`, `CreateMediaBuyResponseSchema`, `SyncCreativesResponseSchema`, etc.

  **Features:**
  - Runtime validation with detailed error messages
  - Type inference from schemas
  - Integration with React Hook Form, Formik, etc.
  - OpenAPI generation support via zod-to-openapi
  - **Automatic generation**: Zod schemas now generated automatically when running `npm run generate-types`
  - **CI integration**: Pre-push hooks and CI checks ensure schemas stay in sync

  **Automatic workflow:**

  ```bash
  # Sync latest AdCP schemas and generate all types (TypeScript + Zod)
  npm run sync-schemas && npm run generate-types
  ```

  **Usage:**

  ```typescript
  import { MediaBuySchema } from '@adcp/client';

  const result = MediaBuySchema.safeParse(data);
  if (result.success) {
    console.log('Valid!', result.data);
  }
  ```

  **Documentation:**
  - `docs/ZOD-SCHEMAS.md` - Complete usage guide with NPM distribution details
  - `docs/VALIDATION_WORKFLOW.md` - CI integration (existing)
  - `examples/zod-validation-example.ts` - Working examples

### Patch Changes

- 244f639: Sync with AdCP v2.1.0 schema updates for build_creative and preview_creative
  - Add support for creative namespace in schema sync script
  - Generate TypeScript types for build_creative and preview_creative tools
  - Update creative testing UI to handle new schema structure:
    - Support output_format_ids array (was output_format_id singular)
    - Handle new preview response with previews[].renders[] structure
    - Display multiple renders with dimensions and roles for companion ads

  Schema changes from v2.0.0:
  - Formats now have renders array with role and structured dimensions
  - Preview responses: outputs → renders, output_id → render_id, output_role → role
  - Removed format_id and hints fields from preview renders

## 2.1.0

### Minor Changes

- 1b28db9: Add creative agent testing UI and improve error detection
  - Add creative testing UI with full lifecycle workflow (list formats → select → build/preview)
  - Fix FormatID structure to send full {agent_url, id} object per AdCP spec
  - Improve error detection to check for data.error field in agent responses
  - Update to AdCP v2.0.0 schemas with structural asset typing
  - Add FormatID type safety to server endpoints
  - Support promoted_offerings asset type with BrandManifestReference

## 2.0.2

### Patch Changes

- cf846da: Improve type safety and use structured data from schemas
  - Replace custom types with generated schema types (Format, Product, etc)
  - Remove all 'as any' type casts for better type safety
  - Remove 30+ lines of workaround code for non-standard responses
  - Export key schema types for public API (Format, Product, PackageRequest, CreativeAsset, CreativePolicy)
  - Client now expects servers to return proper structured responses per AdCP spec

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.2](https://github.com/adcontextprotocol/adcp-client/compare/v0.4.1...v0.4.2) (2025-10-09)

### Features

- add protocol-level webhook configuration support ([#38](https://github.com/adcontextprotocol/adcp-client/issues/38)) ([89bec3e](https://github.com/adcontextprotocol/adcp-client/commit/89bec3e695b94e551366022be4ea0ccc0b84ff2a))

## [0.4.1](https://github.com/adcontextprotocol/adcp-client/compare/v0.4.0...v0.4.1) (2025-10-08)

### Features

- add event store visibility and persist completed tasks ([#35](https://github.com/adcontextprotocol/adcp-client/issues/35)) ([5470662](https://github.com/adcontextprotocol/adcp-client/commit/5470662983ca4b1df3562e2224436e067c145b35))

### Bug Fixes

- distinguish task completion from operation success ([#34](https://github.com/adcontextprotocol/adcp-client/issues/34)) ([34b8d88](https://github.com/adcontextprotocol/adcp-client/commit/34b8d889745d96f60e00d7f5da45ae19fa253a18))

## [0.4.0] - 2025-10-05

### Changed

#### **BREAKING CHANGE: Handler Naming Convention**

- **All async handlers renamed** from `onXXXComplete` to `onXXXStatusChange` to better reflect their behavior
- Handlers now receive ALL status changes (completed, failed, needs_input, working, submitted), not just completions
- `WebhookMetadata` interface extended with `status` and `error` fields for status inspection

**Affected Handlers:**

- `onGetProductsComplete` → `onGetProductsStatusChange`
- `onListCreativeFormatsComplete` → `onListCreativeFormatsStatusChange`
- `onCreateMediaBuyComplete` → `onCreateMediaBuyStatusChange`
- `onUpdateMediaBuyComplete` → `onUpdateMediaBuyStatusChange`
- `onSubmitMediaBuyComplete` → `onSubmitMediaBuyStatusChange`
- `onCancelMediaBuyComplete` → `onCancelMediaBuyStatusChange`
- `onManageCreativeAssetsComplete` → `onManageCreativeAssetsStatusChange`
- `onSyncCreativesComplete` → `onSyncCreativesStatusChange`
- `onListCreativesComplete` → `onListCreativesStatusChange`
- `onGetMediaBuyComplete` → `onGetMediaBuyStatusChange`
- `onListMediaBuysComplete` → `onListMediaBuysStatusChange`
- `onTaskComplete` → `onTaskStatusChange` (fallback handler)

#### **BREAKING CHANGE: Removed Separate Status Handlers**

- Removed `onTaskSubmitted`, `onTaskWorking`, and `onTaskFailed` handlers
- All status changes now route through the typed handlers (e.g., `onGetProductsStatusChange`)
- Use `metadata.status` to check status type within your handlers

### Added

- **Status field** in `WebhookMetadata` interface to identify the current task status
- **Error field** in `WebhookMetadata` interface for failed task error messages
- **Comprehensive test suite** for async handler status changes (12 tests covering all status types)
- **In-memory event storage** in example server for debugging and observability
- **Events API endpoints** (`/api/events` and `/api/events/:operationId`) for querying stored events

### Migration Guide

**Before (v0.3.0):**

```typescript
const client = new ADCPMultiAgentClient(agents, {
  handlers: {
    onGetProductsComplete: (response, metadata) => {
      console.log('Products received:', response.products);
    },
    onTaskFailed: (metadata, error) => {
      console.error('Task failed:', error);
    },
  },
});
```

**After (v0.4.0):**

```typescript
const client = new ADCPMultiAgentClient(agents, {
  handlers: {
    onGetProductsStatusChange: (response, metadata) => {
      // Check status to handle different cases
      if (metadata.status === 'completed') {
        console.log('Products received:', response.products);
      } else if (metadata.status === 'failed') {
        console.error('Task failed:', metadata.error);
      } else if (metadata.status === 'needs_input') {
        console.log('Clarification needed:', response.message);
      }
    },
  },
});
```

**Why this change?**

- Handlers were already receiving all status changes, but the `Complete` suffix was misleading
- Separate status handlers (`onTaskFailed`, etc.) were redundant with typed handlers
- New naming is more honest about behavior and simplifies the API surface
- `metadata.status` provides clear, type-safe status inspection

## [0.3.0](https://github.com/adcontextprotocol/adcp-client/compare/v0.2.4...v0.3.0) (2025-10-04)

### Features

- fix A2A artifact extraction and add protocol response validation ([#28](https://github.com/adcontextprotocol/adcp-client/issues/28)) ([c4fe2d9](https://github.com/adcontextprotocol/adcp-client/commit/c4fe2d99cfc929f4aa083f95baeb64d3f211bef1))

## [0.2.3] - 2025-09-25

### Fixed

- **A2A Protocol Compliance** - Fixed message format to use `kind: "message"` and `input` instead of deprecated `parameters` field
- **Package-Lock Version Sync** - Resolved version mismatch between package.json (0.2.3) and package-lock.json (0.2.2)
- **MCP Product Extraction** - Fixed product extraction logic for proper display in testing UI

### Security

- **Authentication Token Management** - Removed all hardcoded authentication tokens from source code
- **Environment Variable Security** - Added support for `auth_token_env` to reference environment variables instead of hardcoded values
- **HITL Testing Security** - Created secure HITL setup with `.env.hitl.template` and git-ignored `.env.hitl` file
- **GitGuardian Compliance** - Achieved full compliance with security scanning requirements

### Added

- **Node.js Version Specification** - Added `.nvmrc` file specifying Node.js 20 requirement
- **HITL Setup Documentation** - Created comprehensive `docs/development/hitl-testing.md` with security-first configuration guide
- **Comprehensive Protocol Testing** - Added protocol compliance, schema validation, and integration contract tests
- **Security Documentation** - Enhanced README.md with security best practices and environment variable usage
- **CI Validation** - Added server configuration tests to prevent deployment issues

### Changed

- **Testing Strategy** - Implemented comprehensive protocol testing strategy documented in `docs/development/protocol-testing.md`
- **Documentation Updates** - Updated README.md to reflect v0.2.3 changes, security improvements, and Node.js requirements

### Development

- **Test Organization** - Restructured test suite with protocol-specific test categories
- **Mock Strategy** - Improved mocking strategy to test at SDK integration level instead of HTTP level
- **Error Reporting** - Enhanced error messages and debugging information for protocol issues

## [1.0.0] - 2025-09-20

### Added

#### Core Library Features

- **AdCPClient class** - Main client for interacting with AdCP agents
- **Unified protocol support** - Single API for both MCP and A2A protocols
- **ConfigurationManager** - Environment-based agent configuration loading
- **Type-safe APIs** - Comprehensive TypeScript type definitions
- **Protocol-specific clients** - `createMCPClient()` and `createA2AClient()` factory functions

#### Authentication & Security

- **Built-in authentication** - Bearer token and API key support
- **URL validation** - SSRF attack prevention with security checks
- **Token management** - Environment variable and direct token support
- **Secure defaults** - Production-safe configuration out of the box

#### Reliability & Performance

- **Circuit breaker pattern** - Automatic fault tolerance for failing agents
- **Concurrent request management** - Configurable batching with `MAX_CONCURRENT` limits
- **Timeout handling** - Request timeout with configurable `REQUEST_TIMEOUT`
- **Retry logic** - Built into circuit breaker implementation
- **Debug logging** - Comprehensive request/response logging

#### Tool Support

- **get_products** - Retrieve advertising products with brief and promoted offering
- **list_creative_formats** - Get supported creative formats
- **create_media_buy** - Create media buys from selected products
- **manage_creative_assets** - Upload, update, and manage creative assets
- **sync_creatives** - Bulk synchronization of creative assets
- **list_creatives** - Query and filter creative assets
- **Standard formats** - Built-in creative format definitions

#### Developer Experience

- **Comprehensive documentation** - JSDoc comments for all public APIs
- **Usage examples** - Multiple example files showing different patterns
- **Error handling** - Detailed error messages with actionable information
- **TypeScript IntelliSense** - Full type support with auto-completion

#### Testing Framework

- **Interactive web UI** - Point-and-click testing interface at http://localhost:3000
- **REST API** - Programmatic testing endpoints for CI/CD integration
- **Multi-agent testing** - Parallel execution across multiple agents
- **Performance metrics** - Response time analysis and success rates
- **Debug mode** - Request/response inspection with protocol-level details

#### Package & Distribution

- **Dual-purpose package** - Library + testing framework in one package
- **NPM-ready configuration** - Proper exports, types, and file inclusion
- **CommonJS & ESM support** - Compatible with all Node.js module systems
- **Minimal dependencies** - Only essential protocol SDKs as peer dependencies

### Technical Implementation

#### Architecture

- **Modular design** - Separated concerns in `src/lib/` for library code
- **Protocol abstraction** - Unified interface hiding MCP/A2A differences
- **Clean API surface** - Intuitive methods with consistent naming
- **Extensible design** - Easy to add new protocols and tools

#### Dependencies

- **@a2a-js/sdk** ^0.3.4 - Official A2A protocol client
- **@modelcontextprotocol/sdk** ^1.17.5 - Official MCP protocol client
- **TypeScript** ^5.3.0 - Full type safety and modern JavaScript features
- **Node.js** >=18.0.0 - Modern Node.js runtime support

#### Build System

- **TypeScript compilation** - Separate library and server builds
- **Source maps** - Full debugging support in development
- **Declaration files** - Complete `.d.ts` files for TypeScript users
- **Tree-shaking ready** - ESM exports for optimal bundle sizes

### Documentation

#### Files Added

- **README.md** - Comprehensive library documentation with examples
- **examples/basic-mcp.ts** - Simple MCP client usage
- **examples/basic-a2a.ts** - A2A client with multi-agent testing
- **examples/env-config.ts** - Environment-based configuration
- **API.md** - Detailed API reference (planned)
- **CONTRIBUTING.md** - Development guidelines (planned)
- **SECURITY.md** - Security policy and reporting (planned)

#### Examples & Tutorials

- **Quick start guide** - Get running in under 5 minutes
- **Multi-agent patterns** - Concurrent testing strategies
- **Error handling** - Comprehensive error management examples
- **Authentication setup** - Token configuration and security best practices

### Breaking Changes

This is the initial release, so no breaking changes from previous versions.

### Migration Guide

#### From Raw Protocol SDKs

If you were previously using `@a2a-js/sdk` or `@modelcontextprotocol/sdk` directly:

```typescript
// Before (raw MCP SDK)
import { Client as MCPClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const client = new MCPClient({
  name: 'My App',
  version: '1.0.0',
});

const transport = new StreamableHTTPClientTransport(new URL(agentUrl));
await client.connect(transport);
const result = await client.callTool({ name: 'get_products', arguments: args });

// After (@adcp/client)
import { createMCPClient } from '@adcp/client';

const client = createMCPClient(agentUrl, authToken);
const result = await client.callTool('get_products', args);
```

#### From Testing Framework Only

If you were using this as a testing framework only:

```typescript
// Before (server-side functions)
import { testSingleAgent } from './protocols';

const result = await testSingleAgent(agentId, brief, offering, toolName);

// After (library client)
import { AdCPClient } from '@adcp/client';

const client = new AdCPClient(agents);
const result = await client.callTool(agentId, toolName, {
  brief,
  promoted_offering: offering,
});
```

### Known Issues

- Repository and homepage URLs in package.json need to be updated for actual publication
- GitHub Actions CI/CD workflow not yet implemented
- Bundle size optimization not yet implemented
- Some server-only dependencies still included in main dependencies

### Upcoming Features (Next Release)

- Request/response interceptors for custom processing
- Connection pooling for improved performance
- Response caching with configurable TTL
- Plugin system for extending functionality
- Metrics and telemetry hooks
- Advanced retry strategies with backoff
- Request deduplication
- GraphQL-style query composition

---

**Note**: This changelog follows the [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) format. Each version documents:

- **Added** for new features
- **Changed** for changes in existing functionality
- **Deprecated** for soon-to-be removed features
- **Removed** for now removed features
- **Fixed** for any bug fixes
- **Security** for vulnerability fixes
