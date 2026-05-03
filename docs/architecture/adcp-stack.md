# The AdCP stack

## Why this doc exists

Two audiences keep arriving at the same wrong conclusion:

1. **Early implementers** who built before the SDKs were mature, looked at
   what the SDK shipped at the time, and decided to roll their own. Most
   of what the SDK provides today didn't exist when they made that call —
   so their mental model of "what the SDK does" is frozen at AdCP 2.5
   and a few hundred lines of transport glue.
2. **New implementers** who say *"I'll build my own AdCP agent from
   scratch — I don't need an SDK."* AdCP looks like a thin protocol from
   the outside; from the inside, by the time a buyer's `create_media_buy`
   reaches business logic, it has crossed five distinct layers of
   protocol concern, each non-trivial and each governed by a published
   spec contract.

This doc names the layers, says what each one contains, says what an SDK
at each layer should provide, says how the SDK absorbs **version drift**
(spec version, SDK version, and per-peer version) so adopters don't, and
is honest about what *"from scratch"* signs you up for. Audience: AdCP
implementers (whether building an agent, authoring an SDK, or evaluating
one), in any language.

## The five layers

```
┌─────────────────────────────────────────────────────────────┐
│  L4 — Business logic                                        │ ← yours, always
│  Inventory forecasting, pricing, creative review, upstream  │
│  ad-server calls (GAM/FreeWheel/Kevel/etc.). The agent's    │
│  competitive surface — what makes your agent yours.         │
├─────────────────────────────────────────────────────────────┤
│  L3 — Protocol semantics                                    │
│  Lifecycle state machine (`pending_creatives → active →     │ ┐
│  completed/canceled/rejected`), idempotency, error code     │ │
│  catalog, transition validation (`NOT_CANCELLABLE` vs       │ │ what an
│  `INVALID_STATE`), async-task contract, webhook emission,   │ │ AdCP SDK
│  conformance test surface, RFC-9421-driven request          │ │ provides
│  pinning, response envelope shaping.                        │ │
├─────────────────────────────────────────────────────────────┤ │
│  L2 — Auth & registry                                       │ │
│  Agent identity verification, brand resolution, AAO         │ │
│  bridge, multi-tenant account resolution, principal         │ │
│  scoping, sandbox-vs-live account routing.                  │ │
├─────────────────────────────────────────────────────────────┤ │
│  L1 — Identity & signing                                    │ │
│  RFC 9421 HTTP message signatures, public-key registries,   │ │
│  signature verification, key rotation handling.             │ │
├─────────────────────────────────────────────────────────────┤ ┘
│  L0 — Wire & transport                                      │
│  Bytes on the wire. JSON-over-HTTP framing, MCP message     │
│  envelopes, A2A SSE streams, JSON schema validation,        │
│  TypeScript/Python/Go type generation from the spec.        │
└─────────────────────────────────────────────────────────────┘
```

### L0 — Wire & transport

What it does: takes protocol bytes off the wire and turns them into typed
in-memory values. Schema validation catches malformed payloads at the door.

What's in it:
- HTTP routing (or stdio for MCP-over-stdio).
- MCP message framing (`tools/call` envelope, JSON-RPC 2.0).
- A2A SSE event streams.
- JSON schema validation against the spec's `*.json` files.
- Type generation: producing language-native types from the spec's
  schemas, so application code is statically checked.

If you only have L0, you have a parser. The buyer's `create_media_buy`
is a typed object on your stack — and you have to do everything else
yourself.

### L1 — Identity & signing

What it does: cryptographically verifies that the request came from who
the headers claim it did, and that the body wasn't modified in transit.

What's in it:
- RFC 9421 HTTP message signatures (`Signature-Input`, `Signature` headers).
- Public-key resolution from agent registries (or operator-published JWKs).
- Signature verification against the canonicalized request.
- Replay-window enforcement (`created` / `expires` parameters).
- Key rotation: handling `keyid` changes without dropping in-flight
  requests.

If you have L0+L1, you know who's calling you. You still don't know
*what* they're allowed to do.

### L2 — Auth & registry

What it does: turns a verified identity into a scoped principal — which
buyer, which brand, which advertiser account, which sandbox-vs-live tier.

What's in it:
- Agent registry lookup (resolving agent metadata from a published agent
  card).
- Brand resolution: mapping the requesting agent to a buyer brand /
  advertiser identity.
- AAO (AdCP Authorization Object) bridge for delegated authority chains.
- Multi-tenant account resolution: the same wire request maps to
  different accounts depending on the principal.
- Sandbox-vs-live account flagging (`account.sandbox === true` for test
  tenants; production accounts otherwise).
- Permission scoping: which AdCP tools this principal is allowed to
  call.

If you have L0+L1+L2, you have a verified, scoped principal asking to
do something. You still don't know if the *something* is legal in the
current state.

### L3 — Protocol semantics

What it does: enforces what AdCP *means*. The wire shape is well-formed
(L0); the caller is authentic (L1) and authorized (L2); now: is the
request legal given the current state of the world?

What's in it:
- **Lifecycle state machines**: `MediaBuy` (`pending_creatives →
  pending_start → active → paused/completed/canceled/rejected`),
  `Creative` (`processing → pending_review → approved/rejected/archived`),
  `Account`, `SISession`, `CatalogItem`, `Proposal`, `Audience`. Each
  with legal edges defined by the spec.
- **Transition validation**: enforce the legal edges per resource;
  emit `NOT_CANCELLABLE` for cancel-attempts against a state that
  forbids it; `INVALID_STATE` for other illegal moves. The
  cancellation-specific code takes precedence over the generic one
  whenever the attempted action is a cancel.
- **Idempotency**: `idempotency_key` required on every mutating tool;
  same key replays the cached response within TTL; cross-payload reuse
  fails with `IDEMPOTENCY_CONFLICT` (with no payload echo, per the
  stolen-key read-oracle threat model).
- **Error code catalog**: 47 codes with recovery semantics
  (`transient` / `correctable` / `terminal`). Choosing the right code
  is part of the spec contract.
- **Async-task contract**: tools that don't complete synchronously
  return a `task_id`; clients poll or receive webhook callbacks; the
  task's terminal artifact carries the original tool's response shape.
- **Webhook emission**: state changes notify subscribed buyers, with
  retry, idempotency, and signature.
- **Conformance test surface**: `comply_test_controller` (sandbox-only)
  exposes `seed_*` / `force_*` / `simulate_*` so storyboards can drive
  state deterministically.
- **Response envelope**: `context`, `task_id`, `status` field, error
  envelope shape, `adcp_version` echo, capability advertisement.

If you have L0+L1+L2+L3, you have a complete AdCP protocol
implementation. You still haven't done any business logic.

### L4 — Business logic

This is what makes your agent yours.

What's in it:
- Inventory forecasting against your real ad server.
- Pricing logic, deal terms, contract semantics.
- Creative review policy (brand safety, format compliance).
- Upstream calls to GAM / FreeWheel / Kevel / Yahoo / your in-house
  decisioning engine.
- Optimization, pacing, fraud detection — anything that differentiates
  your inventory from a competitor's.

This is the layer an AdCP SDK leaves to you, **and only this layer**.

## What an SDK at each layer should provide

Implementer-facing checklist. An SDK that claims coverage of layer L*n*
should expose, at minimum, the primitives below. Adopters use this as
a self-evaluation tool when picking an SDK; SDK authors use it as a
build target.

### L0 coverage

- Generated language-native types from the published JSON schemas
  (one type per request/response pair, plus shared resource types).
- A schema validator (AJV, Pydantic, etc.) wired against the bundled
  schemas — so adopters can validate inbound and outbound payloads
  without hand-rolling the schema-loading dance.
- Transport adapters for at least one of {MCP, A2A}; ideally both.
  These typically wrap upstream protocol SDKs (e.g.,
  `@modelcontextprotocol/sdk` and `@a2a-js/sdk` in TypeScript;
  equivalent libraries in other languages) rather than reimplementing
  them.
- A schema-bundle accessor that finds the right schema files for the
  active AdCP version without forcing the adopter to hardcode paths.

### L1 coverage

- RFC 9421 message-signature signing for outbound requests.
- RFC 9421 verification for inbound requests, including replay-window
  enforcement on `created` / `expires` and `keyid`-based key lookup.
- A pluggable signing-provider abstraction: in-process keys for
  development, KMS / HSM providers for production.
- Test fixtures or a verifier-test harness so adopters can assert
  their signing wiring is correct without booting a full agent.

### L2 coverage

- An `AccountStore` (or equivalent) abstraction that resolves an
  authenticated principal to a scoped account, with hooks for
  multi-tenant routing.
- Authentication primitives for at least API-key and bearer-token
  shapes, plus a way to compose them.
- Brand-resolution / agent-registry lookup (or a documented
  extension point if the SDK doesn't ship it natively).
- The sandbox-vs-live account flag (or equivalent — see the
  three-account-mode design in `docs/proposals/lifecycle-state-and-sandbox-authority.md`),
  enforced at the SDK boundary so the conformance-test surface
  refuses to dispatch on production accounts.

### L3 coverage

- Lifecycle state-machine graphs for all spec-defined resources, with
  a transition-assertion primitive that emits the spec-correct error
  code (`NOT_CANCELLABLE` / `INVALID_STATE` / etc.).
- Idempotency cache with cross-payload conflict detection and the
  no-payload-echo invariant on `IDEMPOTENCY_CONFLICT` envelopes.
- Async-task store + dispatcher: tools opt into async; the SDK
  returns `task_id`, accepts polling, and emits the terminal artifact.
- Webhook emitter: signed, retried, idempotent.
- The conformance test surface (`comply_test_controller`), wired to
  drive state deterministically when the resolved account is in
  sandbox or mock mode (and rejected otherwise).
- Per-resource persistence primitives that handle the spec's echo
  contracts (e.g., `targeting_overlay` echo on `get_media_buys`).
- Server-construction entry point that ties all of the above
  together with sane defaults.

### L4 coverage

Out of scope for the SDK. The adopter writes this.

## SDK coverage varies

Different language SDKs cover different subsets of L0–L3. There is no
single SDK every implementer must use; what matters is that an
implementation reaches the conformance bar at L3, regardless of how
much hand-rolling it took to get there.

A coverage matrix template:

| SDK | L0 | L1 | L2 | L3 | Adopter writes |
|---|---|---|---|---|---|
| Full-stack SDK | ✅ | ✅ | ✅ | ✅ | L4 only |
| Transport + signing only | ✅ | ✅ | ⚠️ | ❌ | L2 + L3 + L4 |
| Types-only / generated bindings | ✅ | ❌ | ❌ | ❌ | L1 + L2 + L3 + L4 |

(Specific SDKs and their current coverage live in each SDK's repo;
this template is the framing.)

The choice is a tradeoff between leverage and control. A full-stack
SDK ships you the most code for free but couples you to its choices.
A transport-only SDK gives you maximum control but signs you up for
months of L1–L3 work before you can certify. Most production
adopters want the full stack with the option to swap individual
layers (custom signing provider, custom account store, custom
idempotency backend) — which a well-architected full-stack SDK
exposes as configuration, not as a fork.

## Where can you start?

You can implement at any layer. The lower you start, the more you build.

| Starting layer | What you write | What's done for you |
|---|---|---|
| L0 (from scratch) | All five layers | Nothing |
| L1 (you have a JSON-over-HTTP toolkit) | L1+L2+L3+L4 | L0 (parser, schema validation) |
| L2 (you have HTTP signatures via a library) | L2+L3+L4 | L0+L1 |
| L3 (you have an auth/registry library) | L3+L4 | L0+L1+L2 |
| L4 (you use a full-stack AdCP SDK) | L4 only | L0+L1+L2+L3 |

A full-stack AdCP SDK lifts you to L4. You implement upstream calls.
The SDK threads the protocol envelope around them. Pick one if your
team's value-add is L4 differentiation; build lower if you have a
specific reason — and budget for the L1–L3 scope honestly.

## Why SDKs matter more in AdCP than in (e.g.) HTTP

A common comparison: *"HTTP is a protocol. People build HTTP servers from
scratch all the time. Why would AdCP be different?"*

The answer is layer L3. HTTP's protocol semantics are minimal — `methods`,
`status codes`, `headers`. A from-scratch HTTP server can ship in a
weekend with an off-the-shelf parser.

AdCP's L3 is large:

- **State machines**: 7 resource types with published lifecycle graphs.
- **Async tasks**: every mutating tool can be sync or async; the
  contract for which terminal artifact closes the task is non-trivial.
- **Idempotency**: cache, replay, conflict, TTL — all wired correctly.
- **Error catalog**: 47 codes with recovery classification. Picking
  the wrong one fails conformance.
- **Conformance test surface**: storyboards drive your state via the
  `comply_test_controller` tool. You ship a non-trivial controller
  surface.
- **Webhook emission**: signed, retried, idempotent.

A from-scratch AdCP agent is ~4 person-months of L3 alone, before any
L4 differentiation. Most teams that say *"I'll build from scratch"*
underestimate L3 by an order of magnitude.

## Version adaptation

Three "version" axes move at the same time, and an SDK's job is to keep
them from colliding inside your business logic:

| Axis | Example | What changes when it moves |
|---|---|---|
| **Spec version** | AdCP `2.5 → 3.0.5 → 3.1` | Wire shapes, error codes, lifecycle states, new tools |
| **SDK version** | `@adcp/sdk` 5.x → 6.x | API surface, ergonomics, compile-time guarantees |
| **Peer version (per call)** | Buyer at v3.0, seller at v2.5 | A single conversation crosses versions; payloads need translation |

A from-scratch agent has to handle all three by hand. `@adcp/sdk`
ships three concrete mechanisms so adopters don't:

1. **Per-call spec-version pinning.** Set `adcpVersion` on an agent;
   the SDK runs requests and responses through adapter modules
   (`src/lib/adapters/legacy/v2-5/`) so handler code stays on the
   current shape regardless of what the peer speaks.
2. **SDK-major migration via subpath imports.** Bumping `@adcp/sdk`
   doesn't force a rewrite — the prior major's surface lives at
   `@adcp/sdk/server/legacy/v5` and co-exists with the current
   entry point. Migrate one specialism at a time.
3. **Wire-level negotiation.** Sellers declare `supported_versions`
   in capabilities; mismatched callers get a `VERSION_UNSUPPORTED`
   envelope echoing the supported set so they can downgrade their
   pin programmatically.

Code-level recipes for each mechanism live in
[`docs/guides/VERSION-ADAPTATION.md`](../guides/VERSION-ADAPTATION.md).

### Why this matters

Versioning in AdCP is **continuous, not episodic**. Once 3.1 ships,
you'll be talking to 3.0 and 3.1 callers simultaneously, indefinitely.
Without translation adapters this is a fork in your codebase. With
them it's a constructor flag.

The spec itself has already done one of these crossings:

- **2.5 → 3.0** added mandatory idempotency, the
  `comply_test_controller` conformance surface, published lifecycle
  state machines, RFC 9421 signatures as a baseline, and an expanded
  error catalog with recovery classifications. A from-scratch 2.5
  agent was tractable; a from-scratch 3.0 agent is roughly 4
  person-months of L3 alone.

The from-scratch path that worked for 2.5 doesn't scale to 3.0, and
3.0 isn't where the spec stops. SDKs exist because L3 grew faster
than implementers could hand-roll, and the version-adaptation surface
keeps growing each release.

## What early implementers underestimate

Rough order of pain, for adopters who built before the SDKs covered
much:

1. **L3 is most of the work.** State machines, idempotency, error
   catalog, async tasks — ~4 person-months before any L4 differentiation.
2. **Conformance is L3-driven.** Storyboards probe state transitions
   and error shapes. Without an SDK's transition validators you
   re-derive the spec from test failures.
3. **Versioning compounds.** Each spec rev that adds a tool, a
   lifecycle edge, or an error code is a new translation row your
   adapters carry. Bypassing the SDK means owning that matrix
   forever.
4. **RFC 9421 + key rotation is its own project.** Signing providers,
   KMS integration, replay windows — none of which moves the needle
   on your L4 differentiation.
5. **The mock-server is shared infrastructure.** SDKs wire mock-mode
   dispatch to it for free. Hand-rolled implementations either skip
   mock-mode (and lose spec-compliance certification) or rebuild it.

If you built early, the honest move is to re-evaluate the SDK against
this list — not against the version you remember.

## What this means for compliance

Two kinds of compliance, both shaped by the layered model:

- **Spec compliance (L3 protocol test)** — does the implementation
  satisfy the AdCP wire contract? Storyboards walk the state machines,
  exercise the error codes, test the async-task contract. The
  adopter's upstream is irrelevant. Runs against **mock-mode**
  accounts: the agent forwards every tool call to the reference
  mock-server. This certifies the SDK's (or hand-rolled
  implementation's) L3 layer.
- **Live compliance (full-stack test, planned)** — does the actually
  deployed agent (adopter's L4 code against their test infra) behave
  correctly under storyboards end-to-end? Runs against **sandbox-mode**
  accounts: the adopter's code path is exercised, not the mock. This
  certifies that L0–L3 plus the adopter's upstream combined produce
  the right wire behavior. The storyboards for this haven't been
  built yet, but the three-account-mode design leaves room for them.

The reference mock-server is the **spec-compliance oracle** — a
black-box AdCP agent that storyboards run against. All language SDKs
forward mock-mode traffic to it over HTTP, so the reference path is
shared across the ecosystem. The mock-server is SDK-independent: a
hand-rolled L0–L3 implementation can pass spec compliance by routing
its own mock-flavored accounts to the same mock-server and verifying
storyboard pass/fail against its own L3 wire behavior.

The full routing model — three account modes (`live` / `sandbox` /
`mock`), out-of-process mock dispatch, no in-process shortcut — lives
in the SDK-side proposal docs alongside each SDK's repo.

## TL;DR

- AdCP has five layers; the spec lives at L0–L3, your agent lives at L4.
- "From scratch" means implementing L0–L3 yourself. That's a lot.
- A full-stack AdCP SDK lifts you to L4. You write business logic;
  the SDK handles the protocol. Different language SDKs cover
  different subsets of L0–L3; pick one that matches how much of the
  protocol you want to inherit.
- **Version adaptation is an SDK feature, not an adopter project.**
  Per-call spec-version adapters, legacy-subpath SDK imports, and
  on-wire `adcp_major_version` negotiation let you talk to peers on
  any supported version without forking your handlers. Hand-rolled
  agents inherit the entire translation matrix forever.
- Compliance comes in two flavors: **spec compliance** (mock-mode,
  protocol-only, L3 reference test) and **live compliance**
  (sandbox-mode, full-stack, L0–L4 end-to-end; planned).
- The mock-server is the cross-implementation oracle for spec
  compliance. Any SDK in any language can route to it.
- If you built before the SDKs were mature, the value of staying
  hand-rolled is now measured against today's SDK, not the one you
  evaluated in 2.5.
