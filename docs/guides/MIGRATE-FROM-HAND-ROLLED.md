# Migrating from a hand-rolled AdCP agent

This guide is for adopters with a **working AdCP agent in production**
who want to move to `@adcp/sdk` without a flag-day rewrite. Your agent
serves real traffic; you have engineers who built the current stack and
will defend it; you can't afford a multi-week freeze. The path is
incremental — swap one layer at a time, ship after each step, re-certify
as you go.

If you're greenfield, you're in the wrong doc — see
[Build an Agent](./BUILD-AN-AGENT.md). If you're still deciding whether
to migrate at all, see
[Where to start, Q3](../where-to-start.md#three-questions-to-pick-your-layer).

## 0. Inventory what you own today

Before swapping anything, write down what your hand-rolled stack
provides at each layer of [the AdCP stack](../architecture/adcp-stack.md).
Use the L0–L3 checklists in that doc as the rubric. Mark each row:
*shipped* / *partial* / *not yet*.

This determines order of operations. The lowest-risk swap is usually
the layer where you have the **least** coverage today, because there's
the least existing behavior to reconcile.

## 1. Get to spec compliance first, before changing any code

Single most important step:

1. Stand up a **mock-mode account** in your agent. (If you don't have
   the live/sandbox/mock distinction yet, see
   [Account-mode mismatch](#account-mode-mismatch) below — add the
   flag at your boundary first.)
2. Route mock-mode traffic to the reference mock-server.
3. Run the AdCP storyboards against your agent.
4. Read the pass/fail report.

The failure list is your migration backlog, ordered. It converts "I
think the SDK adds value" into "here are the 23 storyboards we fail
and which L3 component each one points at." Without this step you're
buying an SDK based on a sales pitch instead of measured gap.

You may discover you're more conformant than you thought (in which
case the migration is smaller than you expected) or less (in which
case the case for adopting the SDK strengthens). Either outcome is
useful.

## 2. Order of operations (lowest risk first)

Recommended swap order:

1. **Conformance test surface** (`comply_test_controller`). Pure
   additive — mock-mode traffic now goes through the SDK; live traffic
   untouched. Earns spec-compliance certification on the spot.
2. **Error code catalog**. Replace your error-envelope construction
   with the SDK's error builders. Recovery classifications and code
   precedence (e.g., `NOT_CANCELLABLE` over `INVALID_STATE`) come for
   free.
3. **Idempotency cache**. Riskiest swap — see
   [Two idempotency caches in series](#two-idempotency-caches-in-series).
4. **Async-task store + dispatcher**. Adopt the SDK's `task_id`
   + terminal-artifact contract. Often touches your worker queue.
5. **State machines**, one resource at a time. MediaBuy first if it's
   where you spend the most maintenance time. Re-run lifecycle
   storyboards after each.
6. **Webhook emission** (signed, retried, idempotent). Independent of
   1–5; can be parallelized.
7. **RFC 9421 signing + verification**. Independent of everything
   above; can be parallelized.
8. **Auth / account store**. Last. Your hand-rolled L2 probably
   encodes business decisions that don't move easily.

You can stop at any step. Adopting at L3 (steps 1–6) without L2 is a
perfectly valid endpoint — your auth layer keeps doing what it does,
the SDK takes over protocol semantics. See
[What you can leave hand-rolled](#what-you-can-leave-hand-rolled).

## 3. Conflict modes to watch for

These are the "two stacks fighting each other" failure modes that
make incremental migration painful if you don't see them coming.

### Two idempotency caches in series

Your existing cache fields requests at the perimeter; the SDK's cache
fields requests at the protocol boundary. Symptoms: same
`idempotency_key` returns different envelopes depending on which
cache hit first; cross-payload reuse is detected by one and not the
other.

**Resolution.** Pick one, retire the other. Usually retire yours —
the SDK's enforces the *no-payload-echo* invariant on
`IDEMPOTENCY_CONFLICT` (stolen-key read-oracle threat) and the
cross-payload conflict detection that the spec mandates. If you
need to keep your storage backend (Redis, Postgres), point the
SDK's cache contract at it as a custom backend instead of forking
the SDK.

### Account-mode mismatch

The SDK distinguishes `live` / `sandbox` / `mock` accounts. If your
hand-rolled stack lacks the distinction, mock-mode storyboards may
dispatch to live handlers. Symptoms: storyboards mutate production
state; conformance certification refuses to dispatch.

**Resolution.** Add the account-mode flag at your boundary before
adopting the SDK's conformance controller. The SDK's
`comply_test_controller` refuses to run against any account that
isn't sandbox or mock — that refusal is a feature, not a bug.

### Webhook signature ownership

If both stacks try to sign outbound webhooks, the receiver sees two
`Signature` headers (or one wins and the other is silently
overwritten by the proxy). Either way, signatures don't verify.

**Resolution.** Pick one signer at the boundary; usually the SDK's,
since it tracks key rotation against the public key registry and
handles the RFC 9421 canonicalization correctly. Keep your
KMS-backed key material; configure the SDK's signing-provider
abstraction to use it.

### State machine drift

Your hand-rolled state machine probably has edges the SDK rejects
(e.g., direct `pending_creatives → completed` skipping `active`,
or `active → canceled` without distinguishing the
`NOT_CANCELLABLE` vs `INVALID_STATE` precedence). Symptoms:
lifecycle storyboards fail with `INVALID_STATE` where you expected
to succeed.

**Resolution.** Run the lifecycle storyboards against your agent
*before* swapping the state machine. Reconcile your edge set to
the spec — fix obvious bugs, file spec issues for ambiguities.
Then swap the SDK's state machine in; it'll enforce what you just
hand-converged on.

### Webhook delivery transport

If your queue/worker stack delivers webhooks today, the SDK's
emitter would double-deliver if you wire it on without retiring
yours. Symptoms: receivers see duplicate idempotency keys with the
same payload at slightly different times.

**Resolution.** The SDK builds the envelope; how you ship it is
yours. Configure the SDK to hand off to your existing transport
instead of running its built-in HTTP delivery — that's the seam.

### Schema validation collisions

If you validate inbound payloads against your own schema bundle,
and the SDK validates again at its boundary, you get either
duplicate work (cheap) or contradictory verdicts (a real bug —
your bundle drifted from the published schemas).

**Resolution.** Retire your local validator after the SDK is in.
While both run, treat any discrepancy as your bundle being stale,
not the SDK being wrong.

## 4. Intermediate states that pass conformance

After each step, you can re-run mock-mode storyboards and re-certify.
You don't need to finish the migration to claim conformance — you
only need to pass the storyboards at whatever cut-line the SDK's
conformance suite enforces.

| After step | What you have | Conformance status |
|---|---|---|
| 1 | Conformance controller wired; agent unchanged | **Spec compliance** (mock-mode storyboards run against your unchanged L3) |
| 2 | + SDK error envelopes | Same; better recovery semantics |
| 3 | + SDK idempotency | Same; tighter security on cross-payload reuse |
| 4 | + SDK async-task contract | Same; uniform task lifecycle |
| 5 | + SDK state machines | Same; transition validation no longer your problem |
| 6 | + SDK webhook envelope | Same; signed, retried, dedup-keyed |
| 7 | + SDK signing | **Live compliance** (when that storyboard set ships) |
| 8 | + SDK account store | Full L4-on-SDK |

You ship after each step. Production traffic stays up.

## 5. What you can leave hand-rolled

The SDK is opinionated where the spec is opinionated, and pluggable
where it isn't. You don't have to give up your existing infra:

- **Signing provider.** Keep your KMS integration. The SDK accepts
  a custom signer.
- **Account store.** Keep your multi-tenant routing. The SDK's
  `AccountStore` interface is the seam.
- **Idempotency backend.** Keep your Redis / Postgres. The SDK's
  cache contract is pluggable.
- **Webhook delivery transport.** Keep your queue. The SDK builds
  the envelope; how you ship it is yours.
- **Schema validation library.** Keep AJV / your validator if you
  want; the SDK uses its own at its boundary, not yours.

If your hand-rolled stack has good answers to these, swap them in
as **configuration**, not as forks.

## 6. Versioning during the migration

Two version axes you'll be juggling:

- **Spec version of your buyers.** A migration is a great moment to
  add `adcpVersion` per-call pinning so you stop forking handlers
  by buyer-version. See
  [Version Adaptation](./VERSION-ADAPTATION.md).
- **SDK version.** Don't migrate to the legacy subpath
  (`@adcp/sdk/server/legacy/v5`) as a final state — migrate *through*
  it. The legacy subpath exists so you can adopt one specialism at a
  time on `createAdcpServerFromPlatform` while the rest stays on the
  v5 entry point. Greenfield code in the same project uses the v6
  framework directly.

## 7. When to *not* migrate

If your agent serves a frozen wire surface for a small set of named
buyers and your engineers spend ~zero time on protocol maintenance,
the migration ROI is low. Reasonable holds:

- You're on AdCP 2.5, none of your buyers want 3.x, and you're
  willing to deprecate when they do.
- Your conformance gap (from step 1) is small enough to fix in
  place without adopting the SDK.
- You have a hard regulatory or operational reason for owning every
  layer end-to-end.

In those cases, do step 1 anyway — route mock-mode through the
reference mock-server for spec compliance certification — and revisit
the migration question at AdCP 4.0 or when your buyer mix moves.

The migration is for adopters whose **maintenance load is real and
growing**. The cost claim
([~3–4 person-months for L0–L3 from scratch](../architecture/adcp-stack.md#why-sdks-matter-more-in-adcp-than-in-eg-http))
is what you're *buying back* by adopting incrementally — but only if
that maintenance load actually exists.

## See also

- [The AdCP stack (architecture)](../architecture/adcp-stack.md)
- [Where to start](../where-to-start.md)
- [Version Adaptation](./VERSION-ADAPTATION.md)
- [Conformance](./CONFORMANCE.md)
- [Build an Agent](./BUILD-AN-AGENT.md) (greenfield path; useful as a
  reference for what the L4-on-SDK end state looks like)
