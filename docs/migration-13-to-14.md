# Migrating from 13.x to 14 beta

SDK 14 adopts AdCP `3.2.0-beta.4` while preserving the canonical creative boundary introduced in SDK 13. Most SDK 13 applications can install the beta and continue using the established 3.x tools unchanged; adopt the compact 3.2 lifecycle only after the remote agent advertises it.

AdCP 3.2 prereleases are exact protocol pins: beta.4 replaces beta.3 in the
SDK's compatible-version list rather than extending a rolling 3.2-beta range.
Beta.1 restored `adcp_major_version` on `buy_products`,
`accept_proposal`, and `control_media_buy`; the SDK now sends that field again
for beta.1 and later while retaining its omission only for an explicitly
configured beta.0 peer. Beta.2 added canonical compact proposal and direct-buy
storyboards through operational control and MediaBuy readback; beta.4 adds
flexible-window availability and durable products-only legacy purchase
continuations.

```bash
npm install @adcp/sdk@beta
```

The untagged npm install remains SDK 13. Keep that line for production AdCP 3.1 deployments until the 3.2 application and its counterparties have completed beta validation.

## Compound compliance capability gates

Starting with `@adcp/sdk@14.0.0-beta.4`, storyboard authors can declare
`requires_all_capabilities` with two or more capability predicates. Every
predicate is AND-composed, including a separate `requires_capability` when both
forms are present. The runner evaluates this applicability gate before runtime
requirements and advertised-tool gates, so tool availability cannot override a
capability the agent declined.

Compound gates also fail closed when the raw capability payload is unavailable;
advertising or auto-registering a related tool is not evidence of a capability
declaration. The legacy permissive fallback for an existing singular
`requires_capability` remains unchanged.

```yaml
requires_all_capabilities:
  - path: media_buy.propagation_surfaces
    contains: snapshot
  - path: creative.has_creative_library
    equals: true
```

An unmet predicate produces one whole-storyboard `not_applicable` result and no
steps are dispatched. Empty and single-entry lists fail during storyboard
loading; keep using `requires_capability` for a singular predicate.

## Upgrade checklist

1. Pin SDK 14 with the `beta` tag or an exact `14.0.0-beta.*` version. Do not rely on npm `latest` for beta rollout.
2. Move compact-first applications to `agent.negotiateMediaBuyLifecycle()` so the SDK owns capability-gated established fallbacks and their declared loss boundaries.
3. If you use request signing, propagate the negotiated or configured agent version into signing and verification. Expect standard padded Base64 plus mandatory `Content-Digest` only for AdCP 3.2.
4. Return `media_buy_status`, not top-level `status`, from new media-buy server handlers.
5. Add handlers only for the 3.2 tools your server actually implements and advertise the same set in capability discovery.
6. Re-run TypeScript against generated schema imports. Prefer per-tool type slices if the complete schema barrel exhausts the default Node heap.
7. Exercise mixed-version tests before rollout: 14→3.0, 14→3.1, 14→3.2 beta, and older buyer→14 server where applicable.
8. If a legacy brief may return products without a proposal, configure a durable `LegacyPurchaseContinuationStore`, stable `principalScope`, and application-owned `reconcileLegacyPurchase(record, exactInput)` callback before offering `continueLegacyPurchase()`. Keep reverse compact-seller → older-buyer handlers application-owned.
9. If established 3.0/3.1 proposal discovery and mutation can land on different processes, configure the same durable `EstablishedProposalStore`, stable `principalScope`, and stable non-secret `legacyPurchaseSellerSessionScope` on every coordinator. Recover submitted work with `reconcileEstablishedProposalTask({ account, sellerTaskId })`; see [Media-buy compatibility: durable established proposal state](./guides/MEDIA-BUY-3.2-COMPATIBILITY.md#durable-established-proposal-state). The bundled in-memory store is a non-durable reference implementation.

### Legacy continuation store upgrade

SDK 14 tightens the durable continuation contract. Custom stores must make
`recordSubmittedTask()` an atomic first-writer-wins bind: the first seller task
ID and exact same-ID retries return `true`; a different ID returns `false` and
never overwrites it. The seller task ID and any pending callback task ID must
also match regardless of which is written first. `complete()` now distinguishes
the installing `completed` writer from an exact `duplicate` and a divergent
`conflict`; when a pending callback already exists, it atomically promotes and
returns that earlier terminal winner as `pending_completed` with required
settlement metadata instead of the caller's stale candidate.

Replica-safe callback recovery requires implementing
`getByCallbackOperationId()`, `recordPendingSettlement()`, and
`acknowledgePendingSettlement()` together; partial implementations are rejected.
The acknowledgement is an atomic outbox clear after application handler dispatch,
so a transient handler failure remains retryable. Stores that implement none of
these methods remain polling-only, and the
SDK suppresses task webhooks for those operations. Share the durable webhook
registration store between replicas (and the replay store for RFC 9421).
Default completed-operation replay retention is seven days; an explicit
`legacyPurchaseOperationTtlMs` configures both monitoring and replay retention.

Seller pauses are now protocol-specific. A2A can invoke an input handler or
return a resume closure only for a live `input-required`/`auth-required` A2A
Task, using its transport `Task.id`; the separate AdCP task handle remains for
`tasks/get` polling. Completed A2A Tasks with artifact-level pauses and MCP
responses expose `input-required` or `auth-required`
without invoking the handler and without `deferred`; use an
application/protocol-specific recovery path.
Pre-upgrade persisted A2A deferred records that lack an A2A transport task ID are
rejected and removed on resume rather than replayed as a fresh mutation.

## Existing 3.x calls remain valid

No mechanical rewrite is required for code that stays on the established lifecycle:

```ts
const products = await agent.getProducts({
  buying_mode: 'brief',
  brief: 'Reach outdoor enthusiasts in Italy',
});

await agent.createMediaBuy(/* canonical SDK 13 request */);
```

SDK 14 retains the canonical/legacy projection layer and the exact compatible-version list for released AdCP 3.0 and 3.1 versions. Keep using the explicit `*Legacy()` methods only for raw wire migration or conformance tooling, just as in SDK 13.

One already state-changing established-tool variant gains optional-key replay
semantics under 3.2:
`get_products({ buying_mode: 'refine', refine: [{ scope: 'proposal', action:
'finalize', ... }] })`. SDK 14 clients attach an `idempotency_key`; preserve it
for an exact retry. SDK 14 servers cache the finalize variant when a valid key
is supplied. The compatibility schema still permits older callers to omit the
key, but those calls cannot receive cache-backed replay protection. Ordinary
discovery and non-finalizing refinement remain read-only. Sellers using the
proposal-manager framework must wire the same durable idempotency store used
by their other commercial mutations.

SDK 14 also hardens replay-cache isolation by including the tool and trusted
resolved session/account identity in canonical replay identity. The original
SDK 14 key shape retained the SDK 13 scope and bare `authInfo.clientId`
principal format. The PostgreSQL security hardening release additionally
prefixes requests served through `serve()` with a canonical endpoint scope;
that stronger key does not match pre-upgrade durable entries. Before deploying
that release, stop accepting mutations, drain in-flight work, and wait at least
the full configured replay TTL after the last accepted mutation (or migrate or
dual-read the old keyspace). Upgrade all instances together: a mixed rolling
deployment can execute the same retry once under each key shape. The new 3.2
compact mutation tools use
credential-kind-prefixed principals such as `oauth:<client_id>`,
`api_key:<key_id>`, or `agent:<agent_url>` and do not fall back to session or
account identity. Those tools have no SDK 13 cache entries to migrate.

If you supply `resolveIdempotencyPrincipal`, your resolver remains
authoritative for both established and compact tools; keep its output stable
across the deployment or deliberately dual-read/migrate your backing store.
Because SDK 14's stronger payload identity differs,
a retry against an SDK 13 entry returns `IDEMPOTENCY_CONFLICT` instead of the
old cached body; reconcile by natural key rather than minting a replacement
key until the original replay TTL expires. New entries cannot replay a body
across tenants or tools.

## Adopt one compact-first lifecycle

The compact flow is not a rename of the established tools. SDK 14 provides a
compatibility coordinator so application code can express one compact-first
intent while the SDK selects the remote lifecycle before dispatch:

```ts
const lifecycle = await agent.negotiateMediaBuyLifecycle();

const products = await lifecycle.listProducts({
  brand: { domain: 'example.com' },
  max_results: 25,
});

const proposed = await lifecycle.requestProposals({
  brand: { domain: 'example.com' },
  brief: 'Reach outdoor enthusiasts in Italy',
});
```

Every result has a `compatibility` report with the negotiated version,
selected lifecycle, exact tools used, `native` / `lossless_projection` /
`lossy_projection`, warnings, and named losses. Compact tools are preferred
when advertised. `preferredLifecycle: 'established'` exists for a forced
dual-surface test lane, but only when capability discovery also proves that
the corresponding established tool is callable. A compact-only seller fails
that diagnostic lane with a typed error before dispatch.

Existing code that continues to call `getProducts`, `createMediaBuy`, and
`updateMediaBuy` remains on that established lifecycle; it is not routed
through the coordinator. A compact-first `listProducts` call becomes
`get_products` against a 3.0/3.1 seller and remains `list_products` against a
3.2 seller that advertises it. Purchase completion is intentionally stricter:
the older mutation cannot enforce 3.2 feed/pricing fencing or proposal digest
binding, so the coordinator rejects by default rather than claiming identical
semantics.

Lossy mutations fail before transport by default. For example, an established
seller cannot atomically enforce a compact feed/pricing snapshot. If the
application's own reconciliation policy accepts that exact limitation, opt in
by name:

```ts
const lifecycle = await agent.negotiateMediaBuyLifecycle({
  allowedLosses: ['feed_version_not_atomic', 'pricing_version_not_atomic'],
  principalScope: authenticatedPrincipalId,
});
```

Use a stable, non-secret `principalScope` derived from authenticated,
server-controlled identity for established proposal acceptance; never take it
from buyer-supplied request content. Without it, the coordinator deliberately
does not cache executable proposal snapshots and acceptance fails before
mutation. Snapshot quotas are isolated per principal. One `AgentClient`
retains at most 256 active principal partitions; empty inactive partitions are
reclaimable because terminal history is retained separately in 256 lazily
allocated, salted 256 KiB tombstone segments (64 MiB maximum). A principal can
consume only its assigned segment. A segment collision can cause a fail-closed
false positive for another principal, but never shares proposal data or
executable authority. Treat `dispose()` as terminal: in-flight results and
saved task continuations reject after disposal. If an established acceptance
has an unknown outcome, compact decline, refinement, and native acceptance
remain fenced until natural-key reconciliation; only an exact retry within an
advertised idempotency window may be sent.

Proposal hard constraints, alternatives, criteria, and amendment kinds are
never softened into legacy discovery filters. A requested proposal digest is
never invented or silently dropped. Unsupported guarantees throw
`MediaBuyLifecycleCompatibilityError` with `code: 'UNSUPPORTED_FEATURE'`, the
operation, negotiated version, named losses, and recovery guidance before any
mutation is sent.

An ordinary 3.0/3.1 proposal may not contain any digest or compact commercial
terms. The facade returns that proposal unchanged and can still execute the
same legacy `create_media_buy(proposal_id=...)` path, but only after the caller
opts into `proposal_terms_digest_not_enforced`,
`proposal_terms_digest_unavailable`, and
`proposal_snapshot_not_immutable`. If the legacy proposal has no expiry,
`proposal_hold_not_verifiable` is a fourth required opt-in. Supply the original
brand and flight through `established_fallback`; this is buyer provenance, not
a seller snapshot. Native 3.2 acceptance ignores that fallback and still
requires the seller digest.

The compatibility facade also rejects fields that the negotiated established
schema cannot represent. In particular, 3.2-only targeting, allocation,
budget-cap, bidding, pacing, governance, and opportunity controls are never
sent to a 3.0/3.1 tool. A direct compact `total_budget` is also rejected below
3.2: legacy direct-buy schemas do not carry the same top-level commitment
(proposal-mode budget support is separate). Shared per-purchase fields are
projected according to the negotiated schema, including 3.1+
`format_option_refs`; no field is silently stripped. During proposal
acceptance, caller-supplied budget,
budget-cap, timezone, or purchase-order values must match any digest-bound
seller terms; a conflict fails before `create_media_buy`.

For v2.5 specifically, proposal operations, `get_media_buys`, pagination,
cancellation, and v3-only package controls return typed unsupported errors.
Supported pause/resume updates require explicit `revision_not_atomic` opt-in
because v2.5 has no optimistic revision token.

Run the same compact CLI storyboards against established sellers with
`--media-buy-lifecycle-compat`. Use `--media-buy-compat-losses` only for the
exact guarantees your application has approved, and add
`--force-established-media-buy-lifecycle` to exercise a dual-surface 3.2
seller's fallback lane. For proposal flows, pass a stable non-secret
`--media-buy-principal-scope`; if omitted, the CLI creates a run-local scope,
which intentionally cannot authorize acceptance from another run.

Compatibility projection follows asynchronous continuations too. A submitted
or deferred proposal response is not treated as executable evidence until its
completion succeeds; `waitForCompletion()` and `resume()` project and retain
the completed proposal under the same compatibility and principal scope.

Use the generated request types or the narrow imports under
`@adcp/sdk/types/<tool>` for exact compact fields. Preserve the same request
and key for a transport retry; a changed commercial intent needs a new key.
The coordinator selects one mutation tool before transport and never retries
through the other lifecycle after an ambiguous failure.

For proposal refinement, validate the advertised limits and supported dimensions, keep hard constraints distinct from legacy discovery filters, and re-check `expires_at` immediately before acceptance. See [AdCP 3.2 proposal negotiation](migration-adcp-3.1-to-3.2-proposals.md).

AdCP 3.2's exact MCP schema also requires `account` at the top level of every
`comply_test_controller` request. Move a legacy
`context: { account, session_id }` controller call to
`{ account, context: { session_id } }`. The account remains an assertion of
intent; the seller must resolve it through its trusted account store and admit
only a persisted sandbox or mock account.

## Request-signing profiles are versioned

SDK 13 used the legacy AdCP 3.0/3.1 representation. SDK 14 selects between two profiles:

| Agent version | `Signature` encoding | `Content-Digest` encoding | Digest coverage |
|---|---|---|---|
| AdCP 3.0 or 3.1 | unpadded Base64URL | padded standard Base64 | governed by the legacy coverage policy |
| AdCP 3.2 | padded standard Base64 | padded standard Base64 | mandatory |

High-level A2A/MCP clients carry the configured agent version automatically. Low-level signing integrations should pass their trusted version context and can inspect the signature encoding with `requestSigningEncodingForVersion()`. For SDK 13 source compatibility, a low-level verifier with no `adcpVersion` accepts either signature encoding and applies its configured digest-coverage policy; an explicit trusted 3.2 pin keeps mandatory digest coverage.

For a staged server rollout, set the internal verifier option
`signedRequests.covers_content_digest: 'either'` to accept SDK 13 Base64URL
signatures and SDK 14's 3.2 encoding on the same endpoint. Continue advertising
`covers_content_digest: 'required'` in the 3.2 capability document; SDK 14
projects that strict public contract automatically. Move the internal verifier
to `required` after legacy callers are gone.

Do not select a signing profile from a version value inside an unverified request body or header. On the server, bind the version to the endpoint, tenant, or authenticated agent configuration. Webhook signatures do not move to the 3.2 request profile.

Low-level `verifyRequestSignature()` calls that omit `adcpVersion` tolerate both
the legacy Base64URL and 3.2 RFC 8941 Base64 serialization so frozen 3.0/3.1
integrations do not inherit the SDK's own protocol pin. This does not relax
digest policy: `capability.covers_content_digest` remains authoritative. Pass a
trusted `adcpVersion` whenever one is available for deterministic diagnostics.

## Cross-role governance is capability-gated

AdCP 3.2 governance authorizes one exact downstream action. A buyer-side
`GovernanceMiddleware` now checks only tasks the target advertises under
`adcp.governance_enforcement.tasks` with `signed_context` mode **and** the
`governance.campaign` experimental feature marker. Intent checks
carry `plan_id`, `target_agent`, `tool`, and the exact payload; they never reuse
`governance_context`. An approved check adds the returned compact JWS to the
downstream payload. A conditions verdict carries only `consultation_context`
and must be adjusted and re-checked before it authorizes anything.

Modern buyer configuration needs a stable caller URL. Conditional tasks use
`resolveApplicability` when deciding whether a stateful change increases a
commitment, and `resolveIntentDetails` supplies the authoritative ceiling for
tasks whose amount is not derivable from the request:

```ts
const client = new AgentClient(seller, {
  governance: {
    campaign: {
      agent: governanceAgent,
      planId,
      callerUrl: 'https://buyer.example/mcp',
      resolveApplicability: async (tool, payload) => {
        if (tool !== 'update_media_buy') return true;
        const current = await mediaBuyStore.get(String(payload.media_buy_id));
        return payload.total_budget != null &&
          payload.total_budget.amount > current.total_budget;
      },
      resolveIntentDetails: async (tool, payload) => {
        if (tool !== 'update_media_buy') return {};
        const delta = await computePositiveBudgetDelta(payload);
        return { proposedCommitment: { amount: delta.amount, currency: delta.currency } };
      },
    },
  },
});
```

The SDK handles stateless pause, cancel, deactivate, and creative-estimate
exemptions itself. If a conditional request needs seller state and no resolver
is installed, it is governed conservatively. Direct `TaskExecutor` callers
must pass the target capability result; configured governance fails closed
when it is absent.

Services verify the token before starting a side effect:

```ts
import {
  InMemoryGovernanceReplayStore,
  createAdcpGovernanceEnforcementMiddleware,
} from '@adcp/sdk/server';
import { HttpsJwksResolver } from '@adcp/sdk/signing/server';

const enforceGovernance = createAdcpGovernanceEnforcementMiddleware({
  expectedIssuer: 'https://governance.example/mcp',
  expectedAudience: 'https://seller.example/mcp',
  jwks: new HttpsJwksResolver('https://governance.example/.well-known/jwks.json'),
  replayStore: new InMemoryGovernanceReplayStore(),
});

await enforceGovernance(
  {
    token: params.governance_context,
    authenticatedCaller: principal.agentUrl,
    task: 'create_media_buy',
    payload: params,
    actualCommitment: { amount: params.total_budget.amount, currency: params.total_budget.currency },
  },
  () => commitMediaBuy(params),
);
```

Use a shared atomic `GovernanceReplayStore` in multi-replica production
services; the in-memory implementation is for a single process. The verifier
checks critical markers, signature and key purpose, issuer, audience,
authenticated caller, task, JCS payload hash, currency, amount ceiling, time
window, revocation, and one-time `jti` consumption. Existing
`media_buy.governance_aware` online-consultation integrations remain the 3.0/
3.1 compatibility path; do not infer cross-role enforcement from that legacy
boolean.

The server-specific middleware returns a structured `PERMISSION_DENIED` AdCP
response for missing, invalid, expired, or conflicting authorization. The
framework-neutral `createGovernanceEnforcementMiddleware` throws
`GovernanceAuthorizationError`; use it only when your framework explicitly
maps that error to a permission denial. Resolve exact retries from the
service's idempotency cache before invoking governance verification: a
consumed authorization is always rejected, and the middleware never invokes
the side effect twice. Without a fresh combined key-and-JTI revocation
resolver, intent-token lifetime is capped at 15 minutes.

Seller-side `GovernanceAdapter.checkCommitted()` accepts the legacy
plan-addressed request shape during 3.x. The modern shape supplies
`governanceContext`; purchase commitment is derived from
`plannedDelivery.total_budget` and `currency`, while modification calls must
supply the seller-computed positive `executionCommitment`. Governance-agent
transport failure now throws `GovernanceAdapterError` with
`governance_agent_unreachable` instead of being reported as a policy denial.
Catch it at the server handler boundary and return
`governanceUnavailableError()`, which emits the required transient
`GOVERNANCE_UNAVAILABLE` wire error.

## Server handler additions

`createAdcpServerFromPlatform()` routes the new compact lifecycle through
`platform.mediaBuyLifecycle`, including `proposalRefinement` capability
metadata for `refineProposals`. Keep `platform.sales` beside it when the same
seller must accept 3.0/3.1 callers. Both facades should call the same business
services rather than maintaining parallel commercial state.

The generated handler maps cover:

- `list_products`, `request_proposals`, `refine_proposals`, `decline_proposals`
- `buy_products`, `accept_proposal`, `control_media_buy`
- `report_plan_adjustment`
- `sync_agent_notification_configs`

On a 3.2 server, the default `mcpToolProfile: 'auto'` advertises only the
intersection of registered tools and the active spec `media-buy` profile. The
deprecated names remain callable compatibility routes. Use
`mcpToolProfile: 'all'` only for migration diagnostics. MCP `tools/list`
includes `_meta.adcp_version` and `_meta.adcp_profile`, and each framework tool
includes `_meta.adcp_version`.

An SDK 14 server may therefore continue serving 3.0/3.1 clients through the
established tool names without steering new MCP clients toward them. Verify
both facades use the same authorization, tenant isolation, idempotency, and
commercial source of truth. The exact surface comparison and test matrix are
in [AdCP 3.2 media-buy lifecycle compatibility](guides/MEDIA-BUY-3.2-COMPATIBILITY.md).

For create/update media-buy handlers, use `media_buy_status` for the business state:

```ts
return {
  media_buy_id,
  media_buy_status: 'active',
  // ...response fields
};
```

The outer `status` remains the asynchronous task state (`completed`, `working`, `submitted`, `input_required`, or `deferred`).

## Notification and plan-adjustment tools

`syncAgentNotificationConfigs()` replaces the caller's desired agent-level notification configuration declaratively. Treat clear, pause, and replace as authenticated configuration mutations, honor revision fencing, and never merge secrets into logs or `ctx_metadata`.

`reportPlanAdjustment()` is an authenticated, append-only governance record. Replays must be idempotent, but a changed adjustment is a new intent. Scope storage and idempotency to the authenticated tenant/principal rather than a request-supplied account alone.

## Type and schema changes

Regenerated 3.2 types include new tools, error codes, canonical formats, measurement surfaces, and more exact intersections/tuples. If application code imported broad generated types or runtime schemas, expect TypeScript to reveal newly exhaustive unions.

The media-buy compatibility coordinator does not expose `unknown[]` rows or a
`Record<string, unknown>` escape hatch. Product and proposal collections use
`CompatibleProduct` / `CompatibleProposal`, proposal methods return separate
request/refine/decline response types with stable `operation` and `outcome`
discriminants, and each `raw` member is the SDK-returned compact or
canonical-established source response union. Established `raw` is a
`CanonicalGetProductsResponse` with `projection.diagnostics`, not untouched
seller emission; use `getProductsLegacy()` outside the coordinator only when
raw legacy wire inspection is actually required. `CompatibleRefinementResult` restores the canonical proposal
base on revised, partial, and finalized result arms at this boundary; the
underlying beta.3 generator correction is tracked separately in #2619. The
coordinator validates that full canonical child shape at runtime, correlates
ordered compact decline results whether or not they echo `proposal_id`, and
blocks projected legacy acceptance while a decline for that proposal remains
unresolved. Refinement likewise fences every source before dispatch and restores
it only for a verified compact `unable`; ambiguous or malformed refinement paths
retire the source rather than permitting stale acceptance. These checks also run
on submitted, tracked, deferred, and task-update completions before proposal
state is cached or a mutation fence is released.
The result union is status-aware: narrow `result.status === 'completed'` before
reading those completed-only discriminants. Intermediate and failure branches
retain the SDK-returned source response instead of fabricating a proposal outcome.

Use focused imports where possible:

```ts
import type { ControlMediaBuyRequest } from '@adcp/sdk/types/control-media-buy';
import { ControlMediaBuyRequestSchema } from '@adcp/sdk/schemas';
```

The repository's own build allocates an 8 GB TypeScript heap for the full surface. Focused application imports avoid paying that cost.

## Rollout and rollback

Keep separate compatibility lanes in CI:

- SDK 14 client → AdCP 3.2 beta reference agent
- SDK 14 client → representative AdCP 3.1 seller
- SDK 14 client → representative AdCP 3.0 seller
- supported 3.0/3.1 client → SDK 14 server

Canary the beta by endpoint or tenant. Rolling back to SDK 13 is safe only while the application continues to preserve the established 3.x tool path and has not made its storage model depend exclusively on a 3.2-only workflow.
