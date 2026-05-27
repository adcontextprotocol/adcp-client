# Migrating from `@adcp/sdk` 6.7 to 6.9

> **Status: GA in 6.9.** Most changes are additive — adopters running on
> 6.7 today see no behavior change on `npm update @adcp/sdk` unless they
> opt in. **Two exceptions** require attention before bumping; the rest
> are pure additions you can adopt at your own pace.
>
> **Why skip 6.8?** 6.8.0 was published on 2026-05-03 with a mix of
> ready and not-yet-ready content; we deprecated it the same day in
> favour of a curated 6.9.0 that wraps everything we wanted in 6.8.0
> plus the post-6.8 follow-up fixes. **6.7 → 6.9 is the supported path**;
> 6.7 → 6.8 → 6.9 also works (6.8.0 is deprecated, not removed) but
> there's no reason to stage there.
>
> **The two exceptions:**
>
> - **Adopters using `comply_test_controller`**: the framework now
>   auto-wires the sandbox-authority gate inside
>   `createAdcpServerFromPlatform`. Hand-rolled
>   `controller.register(server)` callers (or anyone setting
>   `account.sandbox === true` on the wire) need to know the gate is
>   resolver-driven now: the resolved-account `mode` is the trust
>   boundary, not buyer-supplied flags. See recipe **#1**.
> - **Adopters running `npm run compliance:skill-matrix` in CI**: the
>   skill-matrix harness is removed in favour of the **fork-matrix**
>   (`npm run compliance:fork-matrix`). Same compliance question, runs
>   in seconds instead of ~50 minutes, deterministic. See recipe **#2**.

## Audit first — the two breaking recipes

Before bumping, read recipes **#1** and **#2**. Everything else is
additive and can be applied incrementally.

- **#1 — Framework-side sandbox-authority gate auto-wires
  `comply_test_controller`** (Phase 2 of #1435). The framework now
  registers the controller itself, threading `extra.authInfo` through
  `platform.accounts.resolve` BEFORE dispatch. Live-mode accounts
  cannot reach the controller regardless of what `account.sandbox`
  claims on the wire. Adopters with hand-rolled `controller.register`
  + custom gating need to remove their plumbing or migrate to the
  new shape.
- **#2 — `compliance:skill-matrix` removed; use `compliance:fork-matrix`**.
  The skill-matrix harness graded "can a fresh Claude session build an
  AdCP server from prose in `SKILL.md`" — useful when there were no
  worked references. Now that every production specialism has a
  `examples/hello_*_adapter_*.ts` fork target with a CI-tested gate,
  the fork-matrix asks the same question against the workflow real
  adopters use. Empirical comparison: skill-matrix v18 ran 1/8 in
  ~50 min with 6 timeouts; fork-matrix runs 23/23 in ~10 s.

> **Cross-reference (already covered in 6.6→6.7).** If you're upgrading
> directly from a pre-6.7 baseline, also read recipe **#10b** in
> `migration-6.6-to-6.7.md` — `accounts.resolution: 'derived'` now
> refuses inline `account_id` references with `INVALID_REQUEST` (the
> runtime change shipped in 6.7 via #1475 and the migration doc was
> backfilled in 6.9 via #1492).

## What you get for free (additive headlines)

A condensed list of the additive surface you can adopt at any time
after bumping. Recipes for the load-bearing ones are below.

| Area | Headline |
|---|---|
| Sandbox routing | `Account.mode` convention + sandbox-authority helpers (`AccountMode`, `getAccountMode`, `isSandboxOrMockAccount`, `assertSandboxAccount`); server-side `Account.sandbox` `@deprecated` (legacy compat preserved) |
| Server config | `createAdcpServer.instructions` accepts an async function (per-session prose from a registry / KV / policy doc) |
| Buyer-agent registry | Authenticator-stamped `extra` flows into `BuyerAgentRegistry.resolveByCredential`'s second arg |
| Method composition | Variadic `composeMethod(inner, ...hooks)` overload |
| Comply controller | `ComplyControllerConfig.force` extended with `create_media_buy_arm` + `task_completion` slots; new `queryUpstreamTraffic` adapter alongside `seed`/`force`/`simulate`/`sandboxGate` (closes the structured-config / dispatcher gap) |
| Account stores | `createDerivedAccountStore` (Shape D — single-tenant, auth-derived); `RosterAccountStoreOptions.resolveWithoutRef` for ref-less tools |
| Conformance | `ConformanceClient` outbound-WebSocket Socket Mode primitive (dev/staging only) |
| New worked references | 5 new hello adapters: `hello_seller_adapter_non_guaranteed`, `hello_creative_adapter_ad_server`, `hello_si_adapter_brand`, plus mock-servers for `sales-non-guaranteed`, `creative-ad-server`, `sponsored-intelligence`. Multi-tenant adapter passes strict-tsc gate. |
| SI v6 | `SponsoredIntelligencePlatform` shape (protocol-keyed dispatch, auto-hydrated session) |
| Schema bump | AdCP 3.0.6 cache (closes upstream fixture gaps for `inventory_list_targeting` + `sales_guaranteed`) |
| Type fidelity | `asset_type` discriminator restored on `Individual*Asset` slot types (compile-time catch for missing field) |
| Storyboard runner | Symmetric account resolution on `update_media_buy` / `get_media_buys` / `get_media_buy_delivery` enrichers (no more sandbox-vs-prod partition mismatches) |
| Tool surface | `tasks/get` registered under both `tasks_get` and slash form; accepts brand+operator account refs (not just `account_id`) |
| Client API | `AgentClient.executor` accessor (was `@internal`-only) |
| Type re-exports | `RightUse`, `RightType`, `SICapabilities`, `SIIdentity`, `SISessionStatus`, `SIUIElement`, `SignalFilters`, `SignalTargeting` re-exported from `@adcp/sdk/types` |
| Skill prose | All 8 `build-*-agent/SKILL.md` collapsed onto fork-target pointers (-6,916 lines); `skills/cross-cutting.md` consolidates shared rules |

---

## Breaking recipes

### 1. **breaking** — `comply_test_controller` is now framework-gated by resolved-account `mode`

`createAdcpServerFromPlatform` now bypasses
`controller.register(server)` for `comply_test_controller` and
registers the tool itself. Before dispatch, the framework calls
`platform.accounts.resolve(ref, { authInfo, toolName })` and admits
only when the resolved account's `mode` is `'sandbox'` or `'mock'`
(legacy `account.sandbox === true` is honoured for backwards-compat).
Live-mode accounts cannot reach the controller, regardless of what
the caller stamps on the wire.

**Why this matters.** Pre-6.9 the gate was advisory — adopters who
forgot to wire it shipped a controller-callable production server.
The 6.9 framework gate is the trust boundary: the resolved account is
the only signal that admits the controller. Buyer-supplied
`account.sandbox === true` is honoured (legacy compat) but does not
override the resolver.

**Action required:**

| Your pre-6.9 setup | What to do |
|---|---|
| `controller.register(server)` called explicitly with a custom `sandboxGate` | Remove the explicit `register` call. Replace your `sandboxGate` with `complyTest:` config on `createAdcpServerFromPlatform`. The framework's gate runs first. |
| `complyTest:` config block already in use | No change required. The framework gates the dispatcher; your config still wires force-adapters / seed-adapters as before. |
| Custom resolver that stamps `mode: 'sandbox'` on test accounts | No change required. The gate reads `mode` from the resolved account — your resolver is the source of truth. |
| Test-only account refs that arrive with `account.sandbox === true` and rely on legacy compat | No change required. The framework infers `mode: 'sandbox'` from the legacy flag. Migrate to `mode: 'sandbox'` explicit when convenient. |
| No `comply_test_controller` use at all | No change required. The gate is dormant unless `complyTest:` is wired. |

**Worked reference.** `examples/hello_seller_adapter_guaranteed.ts`
ships the canonical pattern — Phase 3 of #1435 collapsed the example
onto the framework gate, so the adapter itself contains zero
controller-registration code. Fork that file as the starting point.

**Audit:**

```bash
grep -rn "controller\.register\b" src/
```

Each hit is a candidate for migration. If the registration is
inside a non-`createAdcpServerFromPlatform` setup (raw MCP server),
keep it — the framework gate only runs inside
`createAdcpServerFromPlatform`.

### 2. **breaking** — `compliance:skill-matrix` removed; switch to `compliance:fork-matrix`

`scripts/manual-testing/run-skill-matrix.ts`,
`agent-skill-storyboard.ts`, and `skill-matrix.json` are deleted.
`npm run compliance:skill-matrix` and `compliance:agent-skill` are
removed.

**Why.** The skill-matrix asked "can Claude build an AdCP server from
SKILL.md prose alone?" — the right question when there were no worked
references. With `examples/hello_*_adapter_*.ts` covering every
production specialism, the equivalent question is "does the canonical
fork target produce a passing storyboard?" The fork-matrix runs that
question against the same gate adopters fork from. Same coverage,
~10 seconds, deterministic, no LLM variance.

**Action required:**

| Your CI today | What to do |
|---|---|
| `npm run compliance:skill-matrix` (or `compliance:agent-skill`) | Replace with `npm run compliance:fork-matrix` |
| Custom workflow that pulls `skill-matrix.json` | Migrate to the fork-matrix. Each `test/examples/hello-*.test.js` boots the adapter, runs the storyboard grader, and verifies upstream traffic — the three-gate contract from `docs/guides/EXAMPLE-TEST-CONTRACT.md`. |

**Empirical comparison** (from PR #1496):

| Harness | Pass rate | Wall (parallel) | Determinism |
|---|---|---|---|
| skill-matrix v18 | 1 / 8 | ~50 min, 6 timeouts | LLM-variance dominated |
| fork-matrix | 23 / 23 | ~10 s | Deterministic |

---

## Additive recipes

### 3. `Account.mode` convention + sandbox-authority helpers

New surface from `@adcp/sdk/server`:

- **`AccountMode`** — `'live' | 'sandbox' | 'mock'`. Default `'live'`
  when unspecified (fail-closed).
- **`getAccountMode(account)`** — reads `mode` off any account-shaped
  value, with back-compat for legacy `sandbox: boolean`.
- **`isSandboxOrMockAccount(account)`** — predicate.
- **`assertSandboxAccount(account, opts?)`** — throws
  `AdcpError('PERMISSION_DENIED')` (with
  `details: { scope: 'sandbox-gate' }`) for live-mode or missing
  accounts. Use to gate test-only surfaces.

Pure additive. Existing `account.sandbox === true` adopters keep
working — the helpers infer `mode: 'sandbox'` from the legacy flag
automatically. Recipe #1's framework gate uses these primitives; you
can also wire `assertSandboxAccount(ctx.account, { tool: '...' })` in
your own custom test surfaces.

**Server-side `Account.sandbox` is now `@deprecated`** in favor of
`Account.mode`. Adopters stamping `sandbox: true` on resolved accounts
keep working via `getAccountMode`'s legacy fallback — the field will
be removed in a future major. Migrate to `mode: 'sandbox'` explicit
when convenient. **Wire-side `AccountReference.sandbox` is unchanged**
— it's part of AdCP's natural-key disambiguation per the spec's
`core/account-ref.json`. The deprecation is server-side only.

Trust-boundary detail: the resolved account's `mode` is the trust
signal — sourced from your tenant store keyed by authenticated
principal. `AccountReference.sandbox` (buyer input) is **not** a
trust signal; spreading buyer input into the resolved account
effectively moves the trust boundary onto the wire and defeats the
framework gate. See `docs/proposals/lifecycle-state-and-sandbox-authority.md`
§ Trust boundary for the wrong/right code patterns.

```ts
import { assertSandboxAccount } from '@adcp/sdk/server';

// In a custom test handler:
async function onMyTestEndpoint(ctx) {
  assertSandboxAccount(ctx.account, { tool: 'my_test_endpoint' });
  // ... live-mode accounts never reach here.
}
```

### 4. `createAdcpServer.instructions` accepts an async function

The function form of `instructions` now supports
`Promise<string | undefined>` returns. The framework awaits the
result during the MCP `initialize` handshake — the session does not
proceed until the promise settles. Async-fetched per-session prose
(brand-manifest registries, KV stores, real-time policy docs) without
blocking server construction.

```ts
createAdcpServer({
  instructions: async ctx => {
    const manifest = await brandManifests.get(ctx.tenant);
    return manifest?.intro ?? defaultProse;
  },
  onInstructionsError: 'skip', // or 'fail' for load-bearing policy
});
```

`onInstructionsError: 'skip' | 'fail'` governs async rejections
identically to sync throws. Existing string-form and sync-function-form
adopters are unaffected.

New export: `MaybePromise<T>` type alias (`T | Promise<T>`) for use in
async-optional callback signatures.

### 5. `BuyerAgentRegistry` forwards authenticator `extra` to `resolveByCredential`

`BuyerAgentRegistry.bearerOnly` and `.mixed` now forward
`authInfo.extra` as a second optional argument to
`resolveByCredential`. Adopters using prefix-based bearer conventions
(demo tokens, tenant-encoded keys) can stamp extension data in their
`verifyApiKey.verify` callback and recover it in the resolver without
a pre-registered hash lookup.

`ResolveBuyerAgentByCredential` gains an optional second parameter
`extra?: Record<string, unknown>`. Existing single-argument
implementations satisfy the widened type without changes (TS
structural typing).

`attachAuthInfo` in `serve.ts` propagates `principal.extra` from the
`AuthPrincipal` returned by `authenticate()` into `info.extra`. The
`credential` field is always spread last so an adopter-supplied
`extra.credential` cannot overwrite the framework-enforced
kind-discriminated credential (forgery vector closed).

### 6. `composeMethod(inner, ...hooks)` variadic overload

Stack multiple guards / instrumentation layers without nesting:

```ts
import { composeMethod } from '@adcp/sdk/server';

const handler = composeMethod(
  innerHandler,
  authGuard,
  rateLimitGuard,
  metricsHook,
);
// Equivalent to: composeMethod(composeMethod(composeMethod(composeMethod(innerHandler, authGuard), rateLimitGuard), metricsHook))
```

Existing two-arg `composeMethod(inner, hook)` calls keep working
unchanged.

### 7. `ComplyControllerConfig.force` — `create_media_buy_arm` + `task_completion` slots

The dispatcher in `test-controller.ts` already handled
`force_create_media_buy_arm` and `force_task_completion` (in
`CONTROLLER_SCENARIOS`, `SCENARIO_MAP`, and the `switch` dispatch),
but `buildStore` and `advertisedScenarios` had no bridge from the
typed config to those store methods. Adopters on the structured
config who implemented the underlying logic still hit
`UNKNOWN_SCENARIO` every time. 6.9 closes the gap.

New surface:

- `ForceCreateMediaBuyArmParams` —
  `{ arm: 'submitted' | 'input-required'; task_id?: string; message?: string }`
- `ForceTaskCompletionParams` —
  `{ task_id: string; result: Record<string, unknown> }`
- `DirectiveAdapter<P>` — adapter type returning
  `ForcedDirectiveSuccess` (distinct from `ForceAdapter<P>` which
  returns `StateTransitionSuccess`)
- `ComplyControllerConfig.force.create_media_buy_arm?` and
  `force.task_completion?`
- `buildStore` wires both adapters; `advertisedScenarios` pushes the
  matching `FORCE_*` scenarios when present
- `testing/test-controller.ts` `ControllerScenario` union extended

All additive. Unblocks the `media_buy_seller/create_media_buy_async`
storyboard and any other storyboard that drives those force scenarios
through `createComplyController`.

**`queryUpstreamTraffic` adapter** (sibling of
`seed`/`force`/`simulate`/`sandboxGate`). Adopters using the
high-level `complyTest:` opts surface on `createAdcpServerFromPlatform`
can wire `query_upstream_traffic` (spec PR
adcontextprotocol/adcp#3816) without dropping to the lower-level
`registerTestController` API.

```ts
complyTest: {
  queryUpstreamTraffic: (params, _ctx) => {
    const result = recorder.query({
      principal: RECORDER_PRINCIPAL,
      ...(params.since_timestamp !== undefined && { sinceTimestamp: params.since_timestamp }),
      ...(params.endpoint_pattern !== undefined && { endpointPattern: params.endpoint_pattern }),
      ...(params.limit !== undefined && { limit: params.limit }),
      ...(params.attestation_mode !== undefined && { attestationMode: params.attestation_mode }),
      ...(params.identifier_value_digests !== undefined && {
        identifierValueDigests: params.identifier_value_digests,
      }),
    });
    return toQueryUpstreamTrafficResponse(result);
  },
}
```

`advertisedScenarios()` includes `'query_upstream_traffic'` when set,
so `list_scenarios` reports it. `hello_signals_adapter_marketplace`
migrated to this shape; the recorder integration is mechanical now.

### 8. `createDerivedAccountStore` — Shape D `AccountStore` factory

Adopters whose tenant is the auth principal alone — no `account_id`
on the wire (audiostack, flashtalking, single-namespace retail-media)
— get a complete `AccountStore` from one `toAccount(ctx)` callback.

```ts
import { createDerivedAccountStore } from '@adcp/sdk/server';

const accounts = createDerivedAccountStore<MyMeta>({
  toAccount: ctx => ({
    id: 'my_tenant',
    name: 'MyPlatform',
    status: 'active',
    ctx_metadata: {}, // bearer stays on ctx.authInfo, not here
  }),
});
```

Replaces ~25–30 LOC of bearer-extract + throw-`AUTH_REQUIRED` +
return-singleton boilerplate. Standardizes the correct
`'derived'` resolution declaration (many Shape D adapters declared
`'explicit'` pre-6.7 even though they ignore the wire field).

The factory throws `AUTH_REQUIRED` when `ctx.authInfo.credential` is
absent — set `skipAuthCheck: true` for unauthenticated single-tenant
agents (rare; public format catalogs).

Framework-side refusal of buyer-supplied `account_id` is the same
behaviour `'implicit'` adopters get — see `migration-6.6-to-6.7.md`
recipe **#10b**.

### 9. `RosterAccountStoreOptions.resolveWithoutRef` for ref-less tools

`list_creative_formats`, `provide_performance_feedback`,
`preview_creative`, and discovery-phase tools send no `account` field
on the wire. By default `createRosterAccountStore` returns `null`
(`ctx.account` is `undefined` in the handler). Set `resolveWithoutRef`
to route ref-less calls through your hook and then through
`toAccount`, enabling a synthetic publisher-wide singleton without
overriding `resolve` on the returned store.

```ts
const accounts = createRosterAccountStore({
  lookup: async (id, ctx) => /* ... */,
  toAccount: row => ({ id: row.id, name: row.name, status: 'active', ctx_metadata: row.meta }),
  resolveWithoutRef: async ctx => ({ id: 'publisher_wide', meta: { tenant: ctx.tenant } }),
});
```

When omitted, existing behaviour is unchanged. See
`docs/guides/account-resolution.md` § Ref-less resolution for the
canonical pattern.

### 10. `ConformanceClient` — outbound-WebSocket Socket Mode

New `ConformanceClient` from `@adcp/sdk/server`. Lets adopter
dev/staging MCP servers connect to a remote AdCP runner (today, Addie
at agenticadvertising.org) without public DNS or inbound firewall
exposure. Slack Socket Mode pattern.

```ts
import { ConformanceClient } from '@adcp/sdk/server';
import { mcpServer } from './my-mcp-server';

const client = new ConformanceClient({
  url: 'wss://addie.agenticadvertising.org/conformance/connect',
  token: process.env.ADCP_CONFORMANCE_TOKEN!,
  server: mcpServer,
});
await client.start();
```

Reverse-RPC at the TCP level only — MCP semantics unchanged.
Dev/staging only by design (per AdCP #3986 deployment-scoped
controller rule).

### 11. AdCP 3.0.6 schema bump + worked-reference end-to-end clean

`ADCP_VERSION` bumped to `3.0.6`. The bump pulls in two upstream
fixture fixes:

- adcontextprotocol/adcp#3989 — `sandbox: true` on every account
  block in `inventory_list_targeting` (closes the namespace mismatch
  the storyboard runner was hitting)
- adcontextprotocol/adcp#3990 — `task_completion.media_buy_id` path
  on `sales_guaranteed/create_media_buy` (drops the SDK-runner-
  prefix-not-being-used silent miscapture)

Three latent SDK gaps surfaced and closed against the
`hello_seller_adapter_guaranteed` worked example:

1. **`tasks/get` registered under both names.** Buyer-side
   `TaskExecutor.getTaskStatus` calls the spec's slash form
   `tasks/get`; the SDK only registered the underscore alias
   pre-6.9. Now registered under both. Fixes the 30 s
   `tasks/get poll timed out` failure on every HITL flow.
2. **`tasks/get` accepts brand+operator account refs.** Pre-6.9 the
   schema only accepted `{account_id}`; now matches the full
   canonical `AccountReference` (same fix Phase 2 made for
   `comply_test_controller`).
3. **`AgentClient.executor` accessor.** The public client returned by
   `multiClient.agent(id)` didn't expose its underlying
   `TaskExecutor`. The storyboard runner's `pollTaskCompletion`
   checks `client.executor` and silently fell back to webhook-only
   racing — which times out for fixtures whose push URL doesn't
   address a runner-controlled webhook. Added `@internal` executor
   getter on `AgentClient` that proxies to
   `SingleAgentClient.executor`.

Net adopter outcome: `hello_seller_adapter_guaranteed` passes its
storyboard unfiltered against AdCP 3.0.6.

### 12. Storyboard runner — symmetric account resolution

The runner's `update_media_buy`, `get_media_buys`, and
`get_media_buy_delivery` enrichers are now in
`FIXTURE_AWARE_ENRICHERS` and force-override `account` to
`context.account ?? resolveAccount(options)` instead of letting
fixture-authored `account` win.

**Why this mattered.** Pre-6.9 a storyboard's create step used a
runner-synthesized sandbox account (`{brand: 'test.example', sandbox: true}`),
the update step used the storyboard fixture's prod-shape account, and
the subsequent get read from `context.account` (sandbox). The update
wrote to the prod partition while create wrote to sandbox; get read
sandbox and saw stale create-time `targeting_overlay`. Surfaced as
the `media_buy_seller/inventory_list_targeting/get_after_update`
cascade failure.

No adopter action — fixture-authored storyboards keep working;
`account` is just authoritative from the harness now.

### 13. Codegen — `asset_type` discriminator restored on `Individual*Asset` slots

`json-schema-to-typescript` was flattening the schema's
`allOf:[baseIndividualAsset]` + `properties.asset_type.const`
discriminator on the 14 `IndividualXAsset` slot types, leaving them
as bare `BaseIndividualAsset` aliases. Adopters writing TS-clean code
constructing one of these without `asset_type` got runtime
`VALIDATION_ERROR` against the wire schema with no compile-time
signal.

6.9 adds a codegen post-processor that rewrites the affected aliases
into discriminated intersections:

```ts
export type IndividualImageAsset = BaseIndividualAsset & {
  asset_type: 'image';
  requirements?: ImageAssetRequirements;
};
```

Now TS catches missing `asset_type` at compile time, matching the
wire-schema requirement. **No runtime change** — the wire validator
already rejected these. The new TS errors catch a strictly
pre-existing bug at build time.

**Compat:** Adopters who previously constructed `IndividualXAsset`
literals without `asset_type` will see new TS errors. Add
`asset_type: '<type>'` to the literal — that's what the wire was
already rejecting.

### 14. Skill prose collapsed — `skills/cross-cutting.md` is the new shared rules surface

All 8 `build-*-agent/SKILL.md` files collapsed onto fork-target
pointers + cross-cutting reference. Net: 6,916 lines deleted across
seller, creative, signals, governance, brand-rights,
generative-seller, retail-media, si.

`skills/cross-cutting.md` consolidates the rules that were repeated
across every skill: `idempotency_key` is required on every mutating
call, resolve-then-authorize, auth, signed-requests, ctx_metadata
safety, account-resolution presets, webhook `operation_id` stability.

Each `build-*-agent/SKILL.md` now points at:
1. The fork target (`examples/hello_*_adapter_*.ts`)
2. `skills/cross-cutting.md` for shared rules
3. A short "what's specific to this specialism" delta

**Adopter impact:** if you bookmarked specific prose blocks in the
old `SKILL.md` files, they live in `skills/cross-cutting.md` (with
anchor links — see PR #1515) or in the specialism-specific subpages
under `skills/build-*-agent/specialisms/`.

### 15. New worked references + mock-servers

| Adapter | Specialism | Notes |
|---|---|---|
| `hello_seller_adapter_non_guaranteed` | `sales-non-guaranteed` | Programmatic auction with sync confirmation; deletion-fork of the guaranteed sibling |
| `hello_creative_adapter_ad_server` | `creative-ad-server` | Ad-server creative agent with macro substitution |
| `hello_si_adapter_brand` | `sponsored-intelligence` | Brand-side SI agent driving the SI mock through v6 platform |

Matching mock-servers ship for each specialism. `hello-cluster.ts`
boots all 7 hello-adapter specialisms + multi-tenant in one process
for cross-specialism dev. Audio creative-template patterns now have
runnable code (PR #1508).

---

## Self-grade checklist

Run through this after `npm update @adcp/sdk` to verify a clean
landing:

- [ ] `npm run typecheck` — clean. New `asset_type` discriminator
      errors, if any, point at literals that were already runtime-
      rejected. Add the missing field to the literal.
- [ ] `grep -rn 'controller\.register\b' src/` — every hit is either
      inside a non-`createAdcpServerFromPlatform` setup (keep) or a
      candidate for migration to `complyTest:` config (recipe #1).
- [ ] `grep -rn 'compliance:skill-matrix\|run-skill-matrix\|skill-matrix\.json' .github/ scripts/ package.json` —
      should return zero hits. Replace `compliance:skill-matrix`
      references with `compliance:fork-matrix` (recipe #2).
- [ ] `grep -rn 'customTools.*update_rights' src/` — leftover from
      6.6→6.7 audit; the throw still fires inside `createAdcpServer`
      construction. See `migration-6.6-to-6.7.md` recipe **#16**.
- [ ] `grep -rn "resolution: 'derived'" src/` — leftover from 6.6→6.7
      audit; the framework now refuses inline `account_id`. See
      `migration-6.6-to-6.7.md` recipe **#10b**.
- [ ] `npm test` — pre-existing pass rate maintained.
- [ ] `npm run compliance:fork-matrix` — 23/23 against the seven
      hello adapters + multi-tenant.

If all six pass, the bump is clean.

---

_Last updated: 2026-05-03 (drafted for 6.9.0 cut)._
