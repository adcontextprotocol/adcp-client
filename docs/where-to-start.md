# Where to start

You're about to write AdCP code. Before picking a tutorial, answer
this: **how much of the protocol do you want to inherit, and how much
do you want to write yourself?**

This page is the decision. The
[architecture deep-dive](./architecture/adcp-stack.md) is the
reasoning. The
[Getting Started](./getting-started.md) and
[Build an Agent](./guides/BUILD-AN-AGENT.md) guides are the next
clicks once you've chosen.

## The five layers, in one paragraph

Every AdCP request crosses five layers between the wire and your
business logic:

- **L0** — wire: bytes, JSON, schema validation, type generation.
- **L1** — signing: RFC 9421 message signatures, key rotation.
- **L2** — auth & registry: principal resolution, multi-tenant routing.
- **L3** — protocol semantics: lifecycle state machines, idempotency,
  error catalog, async tasks, conformance test surface, webhooks.
- **L4** — your business logic: inventory, pricing, creative review,
  upstream ad-server calls.

A full-stack SDK ships L0–L3 and leaves L4 to you. Picking a starting
layer = picking how much of L0–L3 you take on yourself.

## Where can you start?

You can enter at any layer. The lower you start, the more of the
protocol you write yourself —
[see the layer table](./architecture/adcp-stack.md#where-can-you-start)
for the full breakdown of "what you write vs. what's done for you" at
each entry point.

A from-scratch L0 → L3 build is roughly **4 person-months** before
any L4 differentiation, and that scope grows every time the spec
revs. Within a given language, the full-stack SDK is the default
entry point; the layered model exists to explain what you'd be
reimplementing if you went lower or ported to a new language.

## Three questions to pick your layer

**1. Are you building a caller, an agent, or both?**

- **Caller only** (a buyer-side app calling existing agents) →
  start at L4 with [Getting Started](./getting-started.md). The
  client API is small; you don't own L1–L3 at all.
- **Agent (server)** → keep reading; the rest of this page is for
  you.
- **Both** → start with the agent decision below; the client side
  is additive.

**2. What's your team's value-add?**

- **Inventory, pricing, creative review, decisioning** (i.e., L4) →
  start at L4. Your competitive surface is what you build on top of
  the protocol, not the protocol itself.
  → [Build an Agent](./guides/BUILD-AN-AGENT.md).
- **You are an SDK author / language porter** → start at L0–L1 and
  build up. The
  [architecture deep-dive](./architecture/adcp-stack.md) tells you
  what each layer must provide.
- **Anything else** → start at L4. Going lower is almost always a
  scope mistake disguised as a control preference.

**3. Do you already have a working agent built before the SDK was
mature?**

If yes: re-evaluate against
[today's SDK coverage](./architecture/adcp-stack.md#what-an-sdk-at-each-layer-should-provide),
not the SDK you remember. Most of L3 (lifecycle state machines,
idempotency, the conformance test surface, RFC 9421 baseline,
expanded error catalog) was added with AdCP 3.0. Hand-rolled 2.5
agents inherit the entire delta — and the
[version-adaptation surface](./architecture/adcp-stack.md#version-adaptation)
that lets a 3.x agent talk to a 2.5 caller without forking handler
code. If your stack predates these, the cheapest thing to do is
often **adopt the SDK at L2 or L3** rather than continue hand-rolling
forward.

## Recommended path

For ~95% of adopters: **start at L4 with the full-stack SDK.**

- New agent → [Build an Agent](./guides/BUILD-AN-AGENT.md). The
  guide's [Two paths](./guides/BUILD-AN-AGENT.md#two-paths) section
  picks between `createAdcpServerFromPlatform` (typed
  `DecisioningPlatform`, pre-wires L0–L3) and `createAdcpServer`
  (handler-bag API for finer control or in-flight v5 migrations).
- New caller → [Getting Started](./getting-started.md).
- Migrating from v5 → see [the 5.x → 6.x migration](./migration-5.x-to-6.x.md);
  the legacy subpath lets you co-exist while you migrate.
- Talking to peers on a different spec version →
  [Version Adaptation](./guides/VERSION-ADAPTATION.md).

For the small set of adopters going lower (porting the SDK to a new
language, building a special-purpose proxy, integrating into an
existing stack that owns L0–L2 already): start with the
[architecture deep-dive](./architecture/adcp-stack.md) — it's the
reference for what each layer must satisfy to reach the conformance
bar.

## What you give up by going lower

| You skip | Cost |
|---|---|
| L0 (use a generic JSON toolkit) | Hand-roll the schema validation matrix, the MCP/A2A transport adapters, the per-version type bundles. ~weeks. |
| L1 (use a generic crypto library) | Build the RFC 9421 canonicalization, replay-window enforcement, key-rotation handling, KMS integration. ~month. |
| L2 (own your own auth) | Build principal resolution, brand resolution, sandbox/live routing, account scoping. ~month. |
| L3 (own protocol semantics) | Build seven lifecycle state machines with legal-edge enforcement, idempotency cache with cross-payload conflict detection, async-task store + dispatcher, webhook emitter, the `comply_test_controller` conformance surface, and pick the right error code for every failure mode out of 47. **Most of the SDK's value is here.** ~3 months minimum. |

L4 is yours regardless of where you start. The choice is how much of
L0–L3 you want to own forever, including the version-adaptation work
each new spec rev brings.

## Still not sure?

Read [the architecture deep-dive](./architecture/adcp-stack.md). It
walks each layer end-to-end, names what an SDK at each layer must
provide, and covers the version-adaptation model in detail. Then
come back here and pick a starting layer.
