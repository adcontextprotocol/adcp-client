# Three account modes + SDK-as-router for compliance

## Status

DRAFT — design proposal. Reshapes how the SDK relates to compliance
testing. Anchors in `docs/architecture/adcp-stack.md` (the layered
architecture); this doc is the SDK-side artifact.

## Thesis

There are three operationally distinct account modes, not two. The SDK
should route requests to different backends based on the mode of the
resolved account:

```
account.mode === 'live'    → adopter.DecisioningPlatform (existing path)
account.mode === 'sandbox' → adopter.DecisioningPlatform (their test infra)
account.mode === 'mock'    → mock-server backend (new SDK route)
```

| Mode | What it is | Who owns truth | Use cases |
|---|---|---|---|
| **live** | Production traffic | Adopter's upstream (GAM, FreeWheel, Kevel, …) | Real money buyers |
| **sandbox** | Adopter's own test account | Adopter's test infra (test DB, test GAM tenant, etc.) | Adopter's playground — internal QA, demo, integration testing of *their* code; **live-compliance storyboards** (planned) certify that the actual deployed agent behaves correctly under storyboards |
| **mock** | SDK-routed-to-mock-server | The mock-server | **Spec compliance** — storyboards exercise the protocol against the SDK's reference path without any upstream involvement; agent development without an upstream; cross-SDK compliance |

Two kinds of compliance, two modes:

- **Spec compliance** — runs in mock mode. Storyboards exercise the AdCP
  wire protocol against the SDK's reference path (mock-server backend).
  Pure L3 protocol test; the adopter's upstream is not involved. This
  is what certifies "your SDK implements the spec correctly."
- **Live compliance** — runs in sandbox mode. Storyboards exercise the
  *deployed agent* (adopter's code path, against their test infra) to
  certify the full upstream-to-wire path actually works end-to-end. The
  storyboards for this aren't built yet — but that's the plan, and the
  three-mode model leaves room for them.

Adopters get both for free as long as they (1) flag their conformance
account `mode: 'mock'` for spec compliance, and (2) flag a sandbox
account `mode: 'sandbox'` for live compliance (when those storyboards
ship). Their `DecisioningPlatform` code doesn't change for either.

## Motivation

### What goes wrong today

Today, "sandbox mode" conflates two distinct concepts:

1. The adopter's test playground (their test data, their code path)
2. The compliance harness target (storyboards drive state via
   `comply_test_controller`)

This conflation forces every adopter to ship `complyTest:` wiring inside
their `DecisioningPlatform` — even though compliance is a protocol
concern, not a business-logic concern. Adopter feedback: *"I don't want
this in my production code."* That feedback is correct; compliance
scaffolding doesn't belong in business-logic code.

### What the layered stack tells us

`docs/architecture/adcp-stack.md` puts the lifecycle state machine,
idempotency, async-task contract, error catalog, and conformance test
surface all at L3. L4 (the adopter's code) is upstream business logic
only. Compliance certifies L3. **L4 should not contain L3 wiring.**

If we believe the layered story, the SDK should isolate L3 entirely —
including the conformance test surface. Adopters configure modes;
the SDK does the rest.

## The three modes in detail

### Live (production)

Nothing changes. Adopter's `DecisioningPlatform` methods handle every
request. SDK helps with envelope shaping, idempotency, validation
(`assertMediaBuyTransition`), echo (`MediaBuyStore`), webhook emission.
SDK never claims authority over status — the upstream is truth.

`account.mode === 'live'` (or undefined / absent — live is the default).

### Sandbox (adopter's playground)

Adopter's `DecisioningPlatform` runs against test data. Could be a real
DB with test fixtures, a test GAM tenant, a sandbox in their cloud
provider — whatever they want. The SDK's job is the same as in live mode;
the difference is purely in how the adopter has configured their backend.

`account.mode === 'sandbox'`. Adopter marks accounts in their
`AccountStore.resolve` implementation.

**Live-compliance storyboards run in sandbox mode** (planned, not yet
built). They certify the full deployed-agent path: adopter's
`DecisioningPlatform` methods, against their test infra, end-to-end
under storyboard pressure. Distinct from spec-compliance storyboards
(which run in mock mode and exercise the protocol path only). When
live-compliance storyboards ship, adopters point them at a sandbox-mode
account and certify that their actual code works — not just that the
SDK does.

### Mock (compliance / agent dev)

Adopter's `DecisioningPlatform` methods do **not run**. The SDK routes
every tool call to the mock-server backend. The mock owns lifecycle
state for these accounts. Storyboards drive state via the
`comply_test_controller` tool, which mutates the mock's state.

`account.mode === 'mock'`. Adopter does not write a `complyTest:`
block, does not maintain in-memory `seededMediaBuys` Maps, does not
gate on `process.env.ADCP_SANDBOX`.

How the SDK reaches the mock:

The SDK forwards mock-mode tool calls **out-of-process** to a running
`bin/adcp.js mock-server` over HTTP. Same shape every other AdCP SDK
(Python, Go) will use, since they can't import our TS mock-server
in-process. Standardizing on out-of-process means:

- One reference path, one set of wire-correctness tests. No "in-process
  shortcut works but out-of-process diverges" failure mode.
- Cross-language SDKs are first-class. A Python adopter routes their
  mock-mode accounts to the same `adcp mock-server` instance our TS
  adopter uses; same fixture state, same wire behavior.
- Exercises the full network path during conformance — picks up
  serialization edge cases, header handling, signature verification on
  the forward leg.

Conformance harnesses already shell out to the `adcp` binary today
(`bin/adcp.js storyboard run …`), so adopters in any language get the
mock-server invocation as part of running storyboards — no new
operational overhead.

## Why "mock" is its own mode (not just "sandbox")

The user-facing distinction:

- **Sandbox**: *"I want to test my code with test data."*
- **Mock**: *"I want to run my SDK without writing any code, against a
  reference implementation, for conformance."*

These are different needs. Conflating them is what produced the
`complyTest:` wiring problem in the first place — adopters were forced
to teach their codebase the shape of the compliance harness because
they had no other way to satisfy it.

With three modes, the wiring problem dissolves: compliance hits mock,
which is SDK-handled, which means adopter code is untouched.

## Cross-implementation story

This is the part that makes the model hold up across SDKs.

The mock-server is **language-agnostic**. It's a separate service (or
embeddable library) that ships predictable wire behavior for storyboards.
A Python AdCP SDK can route its mock-mode accounts to the same mock.
Compliance becomes: *"does your wire behavior match the mock's, when the
mock drives the same storyboards?"*

This is the right shape for a multi-implementation ecosystem. The
spec defines the wire; the mock defines the reference implementation;
storyboards exercise the reference. Any SDK in any language can hit
that bar.

If someone says *"I'm not using the SDK, I'll build my agent from
scratch"* — fine. They still need to pass conformance. They still hit
the same mock-server (in mock mode for their own implementation, then
verify their L3 logic matches). The mock is the impartial referee.

## What ships

### Phase 1 — sandbox-account authority for the comply controller

Smallest, most-load-bearing change. Ships first.

- Add `Account.mode: 'live' | 'sandbox' | 'mock'` as a new field
  (resolved decision; see § Resolved decisions). `Account.sandbox:
  boolean` either stays as a derived accessor for back-compat or gets
  deprecated outright in a future major.
- SDK enforces: `comply_test_controller` returns `PERMISSION_DENIED`
  unless `ctx.account.mode === 'sandbox'` or `ctx.account.mode ===
  'mock'`. The `ADCP_SANDBOX=1` env-gate becomes vestigial.
- Add `context.sandbox` fallback for unresolved-account paths
  (`get_adcp_capabilities`, probe calls, conformance pre-account
  bootstrap), preserving today's `isSandboxRequest` semantics.
- Migration note: adopters running the conformance harness with
  `ADCP_SANDBOX=1` and otherwise un-flagged accounts must mark
  conformance accounts in their `AccountStore.resolve` implementation.

### Phase 2 — mock-mode routing

The adopter-cleanup phase. Compliance becomes inherited.

- SDK detects `account.mode === 'mock'` on the way into tool dispatch.
- For mock-mode requests, the SDK forwards out-of-process to a running
  `bin/adcp.js mock-server` over HTTP (resolved decision; cross-language
  SDKs share this path). Adopter's `DecisioningPlatform` methods are
  not invoked.
- Comply controller dispatch routes to the mock-server's controller
  surface (same logic, different backend).
- Hello adapter cleanup: delete `seededMediaBuys` Map, delete
  `complyTest:` block, delete `process.env.ADCP_SANDBOX` checks.
  Adopter file shrinks by ~50-80 LOC. The example becomes a clean
  L4-only file.

### Phase 3 — composition for adopters with bespoke needs

- `complyTest:` option stays available. If the adopter supplies it,
  their handlers run *in addition to* the SDK's mock-mode defaults
  (or instead, if they explicitly opt out). This covers adopters
  whose sandbox needs differ from the mock's predictable defaults
  (e.g., a sandbox that simulates upstream-specific edge cases).
- Most adopters don't need this. The default path is "do nothing,
  inherit compliance."

## What this is NOT

- **Not "the SDK becomes a mock seller."** In live and sandbox modes
  the adopter's code runs as today. Mock mode is a routing decision,
  not a behavior change for live traffic.
- **Not breaking for v6 adopters.** Existing `complyTest:` callers
  keep working; they just become optional.
- **Not Postgres-store-for-production.** The mock-server has its own
  state (in-memory by default). It's not a parallel persistence
  layer for adopter business data.
- **Not a clock-driven status advancer in production or sandbox.**
  Auto-advance is mock-server logic, scoped to mock-mode accounts.
  Live and sandbox traffic comes from the adopter's upstream / test
  infra — they own their own clock semantics.

## What we want adopters to feel

> "I implement upstream calls. The SDK handles the protocol envelope.
> Compliance is something I get for free by using the SDK — I run a
> conformance harness against a mock-mode account, and it passes
> because the SDK routes it to a reference implementation. I don't
> write compliance code."

That's the pitch. The architecture above is what backs it up.

## What we don't want

- **Adopters writing `complyTest:` blocks** — they shouldn't have to.
  Compliance is L3; their code is L4.
- **The SDK lying about production state** — mock mode owns mock
  state; live mode defers to upstream truth. No reconciliation drama.
- **A new framework to learn** — `DecisioningPlatform` keeps its
  shape. Mode routing is configuration, not a code redesign.

## Resolved decisions

These were open questions in earlier drafts; product-owner direction
captured here for traceability.

- **Account.mode encoding**: `Account.mode: 'live' | 'sandbox' | 'mock'`
  as a **new field**, not a tri-state extension of `Account.sandbox:
  boolean`. Clearer at the call site; `Account.sandbox` can stay as a
  derived/computed accessor for back-compat where it's already wired,
  or be deprecated outright in a future major.
- **Mock-mode routing transport**: **out-of-process is the only path.**
  All language SDKs forward mock-mode tool calls to a running
  `bin/adcp.js mock-server` over HTTP. No in-process shortcut. One
  reference path = one wire-correctness contract; cross-language SDKs
  are first-class. Conformance harnesses already shell out to the
  `adcp` binary, so adopters don't pay a new operational cost.
- **Mock-server packaging**: stays in `bin/adcp.js`. All SDKs already
  invoke that binary for storyboard runs, so it's a known artifact in
  the ecosystem. No need to spin off as a separate Docker image or
  language-portable reference at this stage.
- **AdCP spec docs**: the layered architecture
  (`docs/architecture/adcp-stack.md`) **moves to
  `adcontextprotocol/adcp`** so it's the cross-SDK reference. This
  proposal stays in `adcp-client/docs/proposals/` as the SDK-side
  artifact for routing and account-mode semantics.
