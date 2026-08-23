# AdCP 3.2 media-buy lifecycle compatibility

SDK 14 separates the tools an MCP seller **advertises** from the compatibility
routes it can still **call**. A 3.2 seller should make the compact lifecycle the
obvious path for new buyers without breaking a 3.0 or 3.1 buyer that already
calls the established names.

The SDK is pinned to the signed `3.2.0-beta.5` bundle. That exact prerelease
supersedes beta.4 and adds the normative async identity, cross-channel
convergence, webhook retry-horizon, and continuation-generation contract.
Beta.4 introduced flexible-window availability and the products-only legacy
purchase-continuation contract.

## MCP surface comparison

The active 3.2 `media-buy` profile advertises these registered tools:

| Area | AdCP 3.2 active media-buy profile |
|---|---|
| Product and proposal lifecycle | `list_products`, `request_proposals`, `refine_proposals`, `decline_proposals` |
| Purchase and control | `buy_products`, `accept_proposal`, `control_media_buy` |
| Readback | `get_media_buys`, `get_media_buy_delivery` |
| Accounts | `list_accounts`, `sync_accounts`, `get_account_financials`, `report_usage` |
| Creative library | `list_creatives`, `sync_creatives` |
| Media data | `sync_audiences`, `sync_catalogs`, `sync_event_sources`, `log_event`, `provide_performance_feedback` |
| Governance and notifications | `sync_governance`, `sync_agent_notification_configs` |
| Protocol | `get_adcp_capabilities`, `get_task_status`, `list_tasks` |

The deprecated `get_products`, `create_media_buy`, and `update_media_buy` names
are not advertised in that profile. AdCP 3.0/3.1 sellers advertise the legacy
lifecycle instead. `get_media_buys` and `get_media_buy_delivery` remain current
in both generations.

Every framework tool in `tools/list` carries `_meta.adcp_version`. The list
result also carries `_meta.adcp_version` and `_meta.adcp_profile` so a generic
MCP host can display the exact protocol pin and selected role surface without
inferring either from input schemas. Active-profile entries publish the exact,
self-contained draft-2020-12 request projection. Response validation remains
with the framework's AJV validator because current MCP clients apply a declared
success-only `outputSchema` to structured error results too.

## Implement both surfaces from one seller

Use `mediaBuyLifecycle` for the primary 3.2 implementation and keep `sales`
when the endpoint must continue serving older buyers:

```ts
const platform = {
  // accounts, capabilities, statusMappers, ...

  mediaBuyLifecycle: {
    proposalRefinement: {
      supported_dimensions: ['total_budget', 'product_changes'],
    },
    listProducts,
    requestProposals,
    refineProposals,
    declineProposals,
    buyProducts,
    acceptProposal,
    controlMediaBuy,
  },

  // Compatibility facade for AdCP 3.0/3.1 callers.
  sales: {
    getProducts,
    createMediaBuy,
    updateMediaBuy,
    getMediaBuys,
    getMediaBuyDelivery,
  },
};

createAdcpServerFromPlatform(platform, {
  name: 'seller',
  version: '1.0.0',
  adcpVersion: '3.2.0-beta.5',
});
```

With the default `mcpToolProfile: 'auto'`, registering any compact lifecycle
handler on a 3.2 server selects the active media-buy profile. The legacy
handlers stay registered and callable but disappear from `tools/list`.
`mcpToolProfile: 'all'` is available for migration diagnostics; it should not
be the normal production discovery surface.

The compact tools are not mere renames. Proposal digests, immutable terms,
feed and pricing versions, optimistic revisions, and accepted commercial
snapshots make a general field-cast downgrade unsafe. SDK 14's
`MediaBuyLifecycleCoordinator` therefore projects only the documented common
subset and reports every selected tool and loss boundary. It never retries an
ambiguous mutation through the other lifecycle.

```ts
const lifecycle = await agent.negotiateMediaBuyLifecycle();

const products = await lifecycle.listProducts({
  brand: { domain: 'example.com' },
  max_results: 25,
});

console.log(products.compatibility);
// {
//   negotiated_version: '3.1',
//   lifecycle: 'established',
//   tools_used: ['get_products'],
//   compatibility: 'lossless_projection',
//   warnings: [],
//   losses: []
// }
```

On a dual-surface 3.2 seller, compact is preferred. Use
`preferredLifecycle: 'established'` only for a deliberate compatibility test
lane and only when capability discovery includes the corresponding established
tool. Forcing established against a compact-only advertisement returns a typed
error before dispatch; the SDK does not assume a hidden alias is callable.
Auto negotiation applies the same rule per operation: if a partial 3.2 surface
advertises neither the requested compact tool nor its established counterpart,
the coordinator returns `MediaBuyLifecycleCompatibilityError` with
`feature: 'lifecycle_tool_not_advertised'`. It never probes an unadvertised
mutation.

Compatibility responses retain useful public types instead of reducing wire
rows to `unknown`. `CompatibleProduct` is the canonical-or-established product
union, and `CompatibleProposal` is the canonical-or-established proposal union.
Proposal calls return operation-specific discriminants:

- `requestProposals`: `operation: 'request'` with `outcome: 'proposed' |
  'products_available' | 'rejected' | 'legacy_unavailable'`.
- `refineProposals`: `operation: 'refine'` with native per-refinement
  `results[].outcome` arms, or an explicit `legacy_projected` /
  `legacy_unavailable` top-level outcome.
- `declineProposals`: `operation: 'decline'` with typed native results, or
  `legacy_unconfirmed` plus `results[].outcome: 'unconfirmed'` when the caller
  opted into legacy omit semantics.

Those projection discriminants exist only after `result.status ===
'completed'`. `CompatibilityTaskResult<TCompleted, TWire>` is status-aware:
submitted, working, input-required, deferred, and failed branches expose the
SDK-returned compact or canonical-established source data instead of claiming
a completed outcome. On a completed projection, the typed `raw` member retains
that SDK source object. The established source is a
`CanonicalGetProductsResponse`, including `projection.diagnostics`; it is not
the untouched seller emission. Migration and conformance tooling that truly
needs the legacy wire must use the explicit `getProductsLegacy()` API outside
the coordinator. The coordinator's `CompatibleRefinementResult` also restores
the canonical proposal base on revised, partial, and finalized arms. The beta.3
generator defect tracked in #2619 is fixed in this SDK: proposal rows and their
outcome discriminants remain available to TypeScript callers. The compatibility
boundary runtime-validates request-proposal outcome branches and refinement
child proposals before exposing the stronger types, even when general client
response validation is disabled. It also rechecks the full refinement request
semantics on immediate, polled, tracked, and deferred completions before caching
a successor. Compact decline
result arms are runtime-validated and correlated in request order; the coordinator
accepts both rows that echo `proposal_id` and ordered rows that omit it, while
rejecting a conflicting echoed ID.

### Durable established proposal state

Established 3.0/3.1 proposal snapshots are process-local unless the coordinator
is given an `EstablishedProposalStore`. Production buyers that discover and
mutate proposals in separate HTTP requests should supply the same durable store
to every worker:

```ts
const lifecycle = await agent.negotiateMediaBuyLifecycle({
  principalScope: authenticatedPrincipalId,
  legacyPurchaseSellerSessionScope: authenticatedSellerSessionId,
  establishedProposalStore: proposalLedger,
  allowedLosses: ['proposal_terms_digest_not_enforced'],
});
```

The interface is intentionally compatible with an application-owned proposal
ledger. It stores only the SDK's reduced immutable proposal evidence plus
principal, seller, account, version, normalized `expiresAt`, digest, mutation reservation, task,
ambiguity, and terminal-fence fields. It never receives the raw seller response,
credentials, presigned URLs, timers, listeners, or live coordinator objects.

`legacyPurchaseSellerSessionScope` must be a stable, non-secret identity for the
authenticated seller session; it prevents proposals from one credential or
seller account session being reused by another. `reserveMutation()` is an
atomic multi-record compare-and-swap. Durable SQL or Redis implementations must
use the backing service's clock in the same transaction to turn `retryTtlMs`
into the persisted first reservation and retry deadline, compare every supplied
`snapshotFingerprint` with the stored evidence, admit only one worker, permit
only an exact same-key retry inside that deadline, and never make a terminal
record available again. The mutation fence is proposal-wide within the same
principal, seller session, and protocol version, even when two requests spell
the account scope differently, but one mutation and its restart reconciliation
must contain bindings from exactly one normalized account scope.
`InMemoryEstablishedProposalStore` is bounded;
it is suitable for tests and local development, including simulating fresh
`AgentClient` instances, but not for multiple processes.

`completeRefinement()` is also one transaction. It consumes every reserved
source generation, installs each distinct successor snapshot, and restores
only bindings named in `retainedBindings` (the seller's authoritative
`refinement_applied.status: "unable"` sources). A same-ID successor is
available only when its fingerprint differs from the consumed generation; an
identical row remains terminal so an ambiguity replay cannot resurrect the
source. Implementations must retain a bounded completion tombstone keyed by
`operationKey`, including source, successor, and retained fingerprints. An
exact repeated completion returns `updated`, while conflicting completion
evidence fails closed. Stamp each tombstone with the backing store's
authoritative completion time and retain it for at least
`ESTABLISHED_PROPOSAL_COMPLETION_TOMBSTONE_RETENTION_MS` (seven days).
`findSubmittedTask()` exposes that `completedAt` / `retainUntil` window when a
tombstone services recovery. Tombstones count toward the configured record and
byte limits until they expire.
`putSnapshot(snapshot, expectedSnapshotFingerprint)` may replace a different
generation only when that exact generation is still available in the same
atomic transaction; concurrent, reserved, and terminal generations win.
`discardSnapshot()` must likewise compare the expected fingerprint in the
delete transaction.

The remaining transitions are equally fail-closed: `recordSubmittedTask()` may
set a seller task ID once, must conflict on a different ID, and must reject
reuse of a task ID already held by a live record or completion tombstone in the
same principal, seller-session, protocol-version, and account scope;
`releaseMutation()` changes only the exact reserved/retryable claim back to
available, except that exact seller-task reconciliation may also release a
terminal `commit-uncertain` claim after an authoritative terminal error;
`markAmbiguous()` preserves the first store-clock retry deadline and
otherwise writes a permanent commit-uncertain fence; `completeMutation()` is
only accept→accepted and compares a hash of the authoritative reduced terminal
evidence so conflicting successful observations fail closed; and
`completeDecline()` atomically terminalizes successful
rows while restoring seller-confirmed unable bindings. Authoritatively settled
terminal records are permanent authorization fences. Completion tombstones are
authorization fences through their protocol-owned retention horizon: a bounded
store must return capacity rather than evict them early and reauthorize a
proposal. Any `reserveMutation()` reuse of an `operationKey` represented by a
retained completion tombstone must return `conflict`, even when the new claim
or binding evidence differs; only an exact repeated completion may return the
idempotent `updated` outcome. The tombstone must also service the
scoped `findSubmittedTask(..., sellerTaskId)` lookup so reconciliation remains
idempotent after the caller loses a completion response. Durable stores should
implement `pruneCompletionTombstones()` or an equivalent database-owned sweeper
that uses the database clock. At or after `retainUntil`, pruning may make
`findSubmittedTask()` return `undefined`; `reserveMutation()` then derives its
result solely from the remaining source records and may reserve again when all
sources were restored as available.

After restart, call
`lifecycle.reconcileEstablishedProposalTask({ account, sellerTaskId })`. The
coordinator uses `findSubmittedTask()` in buyer-principal, seller-session,
protocol-version, and account scope, polls through the official client,
validates the task ID and tool, rebuilds reduced successor evidence, and applies
the correct accept/refine/decline transition. An already-settled operation is
reported from its tombstone without polling an evicted or stale seller task.
Seller-task reconciliation remains available after a redispatch retry deadline
expires, and a permanent `commit-uncertain` fence is not reported as settled;
an exact authoritative seller observation may still complete or release it.
Seller task IDs are not globally
unique, so a store must never offer an unscoped lookup. When seller success is
observed but the completion transition cannot be committed,
the coordinator fails closed. Reconcile the seller mutation through the
application's natural key and apply the matching accept, decline, or refinement
completion with the retained claim before allowing another lifecycle request. Submitted seller task
IDs are retained through `recordSubmittedTask()` so the same ledger can drive
authoritative completion reconciliation after restart.

### Products-only legacy continuations

An established 2.5, 3.0, or 3.1 seller may answer a brief with products but no
proposal. Beta.4 projects that honest result as `products_available`; it never
invents a proposal, terms digest, or feed fence. The returned
`purchase_continuation` names the exact products and losses that must be
accepted before the legacy `create_media_buy` mutation:

```ts
const continuations = createInMemoryLegacyPurchaseContinuationStore();
const lifecycle = await agent.negotiateMediaBuyLifecycle({
  principalScope: authenticatedPrincipalId,
  // Required for established 2.5, 3.0, and 3.1 sellers that provide no server
  // context ID. Persist this non-secret authenticated session ID across rehydration.
  legacyPurchaseSellerSessionScope: authenticatedSellerSessionId,
  legacyPurchaseContinuationStore: continuations,
});

const discovery = await lifecycle.requestProposals({ account, brand, brief });
if (discovery.status === 'completed' && discovery.data.outcome === 'products_available') {
  const continuation = discovery.data.purchase_continuation;
  if (continuation.kind === 'legacy_create') {
    await lifecycle.continueLegacyPurchase({
      idempotency_key: crypto.randomUUID(),
      continuation_token: continuation.continuation_token,
      account,
      selected_product_ids: [continuation.product_ids[0]],
      accepted_losses: continuation.losses,
      legacy_create_request: exactLegacyCreateRequest,
    });
  } else {
    // listed_purchase carries seller-issued feed/pricing fences and proceeds
    // through the native buy_products flow.
  }
}
```

The in-memory store is a single-process reference implementation. Production
clusters should implement `LegacyPurchaseContinuationStore` with durable,
atomic issuance, binding verification, operation-wide idempotency indexing,
and claim operations. To accept mutation callbacks after a restart or on a
different replica, a custom store must also implement
`getByCallbackOperationId`, `recordPendingSettlement`,
`claimPendingSettlementPublication`, `releasePendingSettlementPublication`,
`acknowledgePendingSettlement`, and `recordDeferredTaskToken`; implementing only
part of that durable inbox/outbox contract is rejected during coordinator
negotiation. The pending-settlement write
must atomically compare exact callback identity and terminal content, and must
be retained through `operation.replayExpiresAt`. A pending callback task ID and
the write-once seller task binding must match in either write order.
`recordDeferredTaskToken` is a compare-and-swap: initial binding expects no
prior token, a nested pause supplies the exact prior token as its fourth
argument, stale writers return `false`, and an exact installed-token retry
returns `true`. That exact token is also the only callback-capable claimed route
allowed to send seller continuation input; ambiguous, completed, expired,
stale, unlinked, or coordinator-less routes fail closed.
When a restarted/public resume pauses again, the SDK first persists the new
deferred checkpoint, then uses that compare-and-swap to replace the legacy
operation's exact prior token, and only then consumes the prior SDK checkpoint
or returns the new token. If the cross-store handoff fails after seller input
was dispatched, the prior checkpoint stays claimed and the replacement remains
unauthorized, preventing either generation from redispatching input.
`acknowledgePendingSettlement` must atomically clear the exact pending entry and
retain its stable, nonempty `acknowledgedSettlementFingerprint` through
`operation.replayExpiresAt`. `get` and `getByCallbackOperationId` must return
that proof, and exact ACK retries must validate it; this is the durable evidence
that application publication already occurred if a later deferred-checkpoint
write fails. If the exact terminal result was completed without a pending
outbox entry, ACK installs the same proof after publication succeeds. Use the
exported `legacyPurchaseSettlementFingerprint()` helper to compute the enforced
canonical proof. It binds the operation, seller task, task type, and terminal
value while intentionally excluding the webhook delivery event key.
`claimPendingSettlementPublication` and
`releasePendingSettlementPublication` are an atomic renewable lease over the
exact outbox entry. A live different owner returns `false`, the same owner may
renew, an expired owner may be replaced, release removes only the exact owner,
and pending acknowledgement requires that owner. Publication callbacks must
remain idempotent across lease loss. Existing stores may omit all six
methods and continue polling-only operation; the coordinator suppresses push
notifications for those stores so no callback can be acknowledged only in
process memory. The default reference store implements callback recovery, so a
committed A2A pause requires configured `deferredStorage`; without it the pause
fails closed. A polling-only store that omits all six callback methods can
still use an in-process pause continuation without deferred storage.
Sender callback inbox writes stop at `operation.replayExpiresAt`, but an
already-dispatched seller task may finish later. A pending settlement marked
`publicationSource: 'sdk'` may therefore be installed after that time and must
remain retained until exact-owner acknowledgement; cleanup must not delete an
expired completed record while that SDK outbox is pending. Its successful ACK
extends completed replay retention by at least seven days so a crash before a
separate deferred-checkpoint ACK can still recover the publication proof.
Every accepted sender or SDK terminal outbox also starts a fresh seven-day
recovery horizon at admission; a callback admitted just before the old deadline
therefore remains retryable while its handler and cross-store finalization run.
No pending outbox is cleanup-eligible while its publication lease is
unexpired. An expired sender-owned outbox may be reclaimed only after both the
replay deadline and any active lease end.

The reference store is bounded to 256 records / 4 MiB
and prunes expired unused or completed records; it deliberately does not evict
ambiguous mutations. Tokens are principal-, account-, seller-session-,
source-version-, expiry-, product-, discovery-request-, and full
observed-response-bound. Re-observing the same discovery returns the same
token. A claim is consumed at the first mutation; exact retries replay the
recorded terminal `TaskResult` during a replay window of at least seven days.
`legacyPurchaseOperationTtlMs` configures unresolved-operation monitoring and
may lengthen, but never shorten, that terminal replay retention.

Custom stores must also implement the terminal CAS outcome precisely:
`complete()` returns `completed` only when it installs the caller's candidate,
`pending_completed` with required settlement metadata when it atomically
promotes an earlier queued callback, `duplicate` for an exact already-installed
retry, and `conflict` for a different terminal value. This distinction prevents two
replicas racing inbox drain and callback recovery from publishing completion
twice. If a pending callback won before `complete()`, the transaction must
promote and return that pending terminal value (including its settlement
identity), never discard it in favor of the caller's stale candidate. The SDK
validates the returned callback operation, seller task, task type, and terminal
content before accepting `pending_completed`.

`recordSubmittedTask()` is also an atomic, write-once binding: the first seller
task ID wins, an exact same-ID retry succeeds, and a different ID returns
`false` without overwriting the stored identity. Callback settlement trusts
this binding, so a last-writer-wins implementation is unsafe. Binding must also
return `false` when an already queued callback names a different seller task;
the inverse pending-settlement write must return `conflict`.

Applications that receive webhooks must negotiate and retain the lifecycle
coordinator before marking the callback route ready. On process restart, build
a fresh `AgentClient`, negotiate a coordinator with the same durable store,
`principalScope`, and `legacyPurchaseSellerSessionScope`, and only then serve
callbacks. This installs the callback-operation recovery lookup synchronously
when negotiation completes. The seller-session scope must be stable across
replicas; do not rely on a newly negotiated in-memory context ID for cold-start
recovery.

Use that same reconstructed `AgentClient` to redeem a persisted continuation;
do not construct a separate `SingleAgentClient`, because it would not own the
coordinator's settlement recoverer and exact-token authorizer:

```ts
const agent = new AgentClient(agentConfig, { deferredStorage });
await agent.negotiateMediaBuyLifecycle({
  legacyPurchaseContinuationStore,
  principalScope,
  legacyPurchaseSellerSessionScope,
});

const resumed = await agent.resumeDeferredTask(deferredToken, humanInput);
```

The webhook authenticity state is a separate durability boundary. Replicas
must also share a durable `webhookRegistrationStore`; RFC 9421 deployments
must share the configured replay store as well. A fresh client with the
default in-memory registration or replay store intentionally rejects a
callback before continuation recovery runs.

For any established seller without a server context ID,
`legacyPurchaseSellerSessionScope` is required before a continuation can be
issued. It must be a stable, non-secret ID derived by the application from the
authenticated seller/account session—not a bearer token. Persist and reuse it
with the continuation store so a restarted coordinator can redeem or replay
the same operation without making the token portable to another credentialed
session. This applies to 2.5, 3.0, and 3.1; endpoint identity is not an
authenticated session identity. URL userinfo and presigned URLs are rejected
before the discovered payload can enter durable storage.

Every 2.5 continuation declares `mutation_idempotency_not_guaranteed`.
3.0/3.1 continuations declare the same loss whenever the seller does not
advertise a usable replay TTL; accepting an idempotency key alone is not treated
as evidence that a mutation can be replayed safely. Submitted completions are
accepted only for the exact seller task ID recorded at dispatch. Unstructured
or SDK-synthetic terminal errors remain ambiguous and retain the durable fence.

A transport crash becomes `LegacyPurchaseContinuationError` with
`code: 'ambiguous'`. `reconcileLegacyPurchase(record, exactInput)` receives the
durable, secret-safe mutation descriptor (`sourceMutationKey`, selected product
IDs, and a submitted seller task ID when available) plus the exact retry input.
It must return a schema-valid terminal `create_media_buy` result found by an
application-owned natural key. The SDK never blindly repeats an ambiguous
legacy create or persists webhook credentials from the request. For a
callback-capable continuation store, the reconciled result must include the
authoritative seller identity in `metadata.serverTaskId` unless the claim
already durably records it; otherwise the SDK cannot fence later callback
publication against the reconciled winner and fails closed.

Native 3.2 sellers cannot return `products_available`. A dual-surface 3.2
server can serve older buyers through explicit legacy `sales` handlers: the
SDK keeps those routes callable while omitting their names from the compact
`tools/list` profile. The application still owns the real legacy
discovery/create context. The SDK does not derive a synthetic legacy proposal
or create payload from compact terms; the signed reverse-compatibility vector
tests that `get_products` followed by `create_media_buy` stays entirely on the
explicit legacy facade.
Because compact proposals are immutable, refinement places every source under
a shared principal-scoped execution fence before dispatch. Only a verified
`unable` result restores that exact source snapshot; a validated successor adds
new acceptance evidence under its own proposal ID. In-flight, malformed,
ambiguous, disposed, and expired refinements leave the source non-executable.

## Buyer projection policy

| Coordinator operation | Compact tool | Established projection | Boundary |
|---|---|---|---|
| `listProducts` | `list_products` | `get_products(buying_mode='wholesale')` | Structured compact `criteria` is rejected unless a normative mapping exists. Actual `wholesale_feed_version` is renamed to `feed_version`; no value is invented. The stable response exposes `next_cursor` and `unchanged` in both lanes. The established request includes `pagination` only when the caller supplies a cursor or `max_results`; the SDK does not fabricate a page-size default. v2.5 pagination/field selection, pre-3.1 conditional feed/pricing reads, and response-field names absent from the negotiated enum are typed unsupported. |
| `requestProposals` | `request_proposals` | `get_products(buying_mode='brief')` | Only offer-filter fields and metric values defined by the negotiated release map field-by-field, plus policy IDs. Compact catalog selection lacks the complete legacy catalog metadata and fails closed. Targeting-overlay requirements are forwarded only to a 3.2 established surface; 3.0/3.1 cannot represent them. Product-ID filters, compact-only offer prerequisites, `ext`, opportunity, and governance context fail preflight. |
| `refineProposals` | `refine_proposals` | `get_products(buying_mode='refine')` | Ask and product include/omit map for revisions. Finalize maps only when it contains no additional refinement fields. Hard constraints, alternatives, criteria, amendment kinds, and finalize extras fail before dispatch. |
| `declineProposals` | `decline_proposals` | proposal-scoped legacy omit | Rejected by default because omit is not a terminal decline and cannot carry the required compact reason/detail. Explicit opt-in reports `proposal_decline_not_terminal` and `proposal_decline_reason_not_forwarded`. |
| `buyProducts` | `buy_products` | `create_media_buy` | Feed/pricing fencing is not atomic. Rejected by default; explicit opt-in names `feed_version_not_atomic` and, when present, `pricing_version_not_atomic`. Shared package fields and nested targeting/reporting enums map against the negotiated schema, including 3.1+ `format_option_refs`; newer targeting, metric, and postal shapes fail closed. v2.5 also rejects non-empty compact targeting and push notification configuration. A direct compact `total_budget` and fields introduced on the 3.2 established surface—including allocation, budget-cap, bidding, governance, opportunity, and newer package controls—map only on a negotiated 3.2 established lane. Compact `catalog_ids` and resolved `pricing` remain typed unsupported. |
| `acceptProposal` | `accept_proposal` | `create_media_buy(proposal_id=...)` | A compact-shaped proposal retains strict digest, immutable-snapshot, account-scope, kind/status, and expiry checks. Caller values cannot override digest-bound budget, budget-cap, timezone, or purchase-order terms. An honest 3.0/3.1 proposal remains executable with its ordinary `proposal_id` semantics only after explicit opt-in to `proposal_terms_digest_not_enforced`, `proposal_terms_digest_unavailable`, and `proposal_snapshot_not_immutable` (plus `proposal_hold_not_verifiable` when it has no expiry). The caller supplies the original brand/flight as `established_fallback`; the SDK does not claim those values came from the seller or synthesize a digest. |
| `controlMediaBuy` | `control_media_buy` | `update_media_buy` | Account, media-buy ID, and a positive revision are required. Revision and identically shaped fields present in the negotiated established schema map directly; `name` maps on the 3.2 established surface and fails closed on 3.0/3.1, whose update schemas do not define it. v2.5 requires explicit `revision_not_atomic` opt-in and rejects cancellation plus v3-only package controls. Pre-3.2 lanes reject the broader compact optimization-goal union and nested targeting/keyword shapes they cannot represent. Compact `catalog_ids` cannot be cast to established `catalogs` objects, so it fails closed in every established lane. |
| Readback | shared tools | `get_media_buys`, `get_media_buy_delivery` | Same public calls and canonical creative projection in every lane. Versioned request additions fail closed: webhook-activity and delivery-window/granularity options require 3.1+, while `indicator_types`, demographic breakdowns, and spot breakdowns require 3.2. Native postal reporting shapes require 3.1+. |

Lossy mutations are fail-closed. An adopter may opt into only the exact named
guarantees it has reviewed:

```ts
const lifecycle = await agent.negotiateMediaBuyLifecycle({
  allowedLosses: ['feed_version_not_atomic', 'pricing_version_not_atomic'],
  principalScope: authenticatedPrincipalId,
});

const purchase = await lifecycle.buyProducts(intent);
if (purchase.compatibility.compatibility === 'lossy_projection') {
  audit(purchase.compatibility.losses, purchase.compatibility.warnings);
}
```

`principalScope` must be a stable, non-secret tenant/principal identifier for
established proposal acceptance. Proposal snapshots are keyed by that scope
plus seller account and proposal ID. Without it, proposal discovery still
works but the coordinator does not retain executable snapshots and
`acceptProposal` fails closed. Derive it only from authenticated,
server-controlled identity; never accept it from buyer-supplied request
content. Never share a coordinator or its `AgentClient` across authentication
principals.

Proposal snapshots are shared and bounded per `AgentClient` and
`principalScope` partition (256 entries, 256 KiB per entry, 4 MiB total), so
one authenticated principal cannot consume another principal's snapshot
quota. An `AgentClient` retains at most 256 active principal partitions. An
empty inactive partition can be reclaimed while its terminal history remains
in a registry-level summary, so sequentially used principals do not exhaust
the active-partition limit.
The first retired proposal lazily allocates one of 256 salted probabilistic
tombstone segments. Each segment is a fixed 256 KiB and the registry allocates
only segments it uses (64 MiB maximum). Exact tombstone keys include the
principal scope, and a principal can consume capacity only in its salted
segment. Principals whose scopes hash to the same segment can share
false-positive availability failures, but never proposal data or executable
authority. The summary prevents rediscovery from reauthorizing a consumed
proposal without retaining proposal IDs. At very high lifetime mutation
counts, a false positive rejects an unused proposal rather than risking a
duplicate mutation; it never fails open.
Only successful completed proposal responses become executable snapshots.
Working, failed, unsafe, oversized, or unserializable same-ID responses
invalidate older evidence. Async results are projected and retained only after
a successful completion is observed through `waitForCompletion()`, `track()`,
`resume()`, or the `AgentClient` task-update stream (including working-task and
built-in webhook completion updates). Task-update proposal listeners expire
after five minutes; call `dispose()` to release them earlier. A later explicit
`track()` or `waitForCompletion()` still projects and retains a successful
completion after that listener window while the coordinator remains active.
Disposal is terminal: in-flight responses and previously returned task
continuations reject instead of projecting into a partition that may have been
reclaimed. If a decline or refinement was already dispatched, disposal keeps
its shared principal-scoped reservation and changes an in-flight attempt to
commit-uncertain; a newly negotiated coordinator can therefore perform only
the exact replay described below. Outstanding decline leases are capped at 256
operations and 1,024 proposal IDs; an additional decline fails before
dispatch. While any lease covers a proposal, an established `acceptProposal`
projection for the same principal fails before dispatch. A verified `unable`
decline releases the lease without revoking the snapshot, so the original
proposal remains executable. An input/auth pause retains a paused fence.

The five-minute mutation watcher is an observation deadline, not an
idempotency deadline. If a decline or refinement is still in flight when that
watcher expires, its reservation becomes commit-uncertain and remains fenced.
A transport error, malformed continuation, or coordinator disposal makes the
same transition immediately. While the seller's advertised replay window
remains open, only the exact same request with the same idempotency key
may retry that reservation. The replay deadline is fixed from the first
attempt and cannot be extended by retries or a new coordinator. Once that
immutable deadline passes—or immediately when the seller advertised no replay
guarantee—the SDK retires the reservation into the principal's bounded
tombstone summary. Different refinements, declines, and acceptances remain
blocked before dispatch until the application reconciles the outcome.

An unresolved established acceptance is treated as possibly
committed when transport fails, its working-task watcher expires, or its
coordinator is disposed. Only the exact idempotent acceptance retry is allowed
while the seller's advertised replay window remains valid. Compact decline,
refinement, and native acceptance fail before dispatch until the application
reconciles the media buy by natural key. An explicit input- or authentication-
required pause is different: it may be retried exactly or terminally declined.

Refinement uses the same fail-closed model. Outstanding refinement leases are
bounded to 256 operations and 1,024 proposal IDs, overlap with another pending
refinement or decline is rejected before dispatch, and task-update completions
are validated before a fence is settled. A verified compact `unable` restores
the immutable source. A verified revision or finalization retires that source.
Ambiguous outcomes follow the shared watcher, exact-replay, and eventual
principal-tombstone rules above, preventing another coordinator for the same
principal from accepting stale terms while the seller may already have revised
or finalized them.

The same idempotency key is preserved when a compact mutation is projected to
an established tool. A changed payload still needs a new key. The coordinator
selects exactly one mutation tool before transport and does not fall back after
a timeout, so an ambiguous failure cannot create a duplicate buy.
An input/auth pause may be retried with that exact request and key after the
original proposal hold expires because the acceptance attempt began while the
hold was valid. This continuation is permitted only inside the seller's
advertised `replay_ttl_seconds`, measured from the first attempt; the deadline
never resets. If the seller omitted that guarantee or the window has elapsed,
the coordinator retires the proposal and requires natural-key reconciliation
before any new mutation.

Established proposal acceptance also needs the inputs that legacy
`create_media_buy` repeats but compact `accept_proposal` omits. Applications
may supply this fallback on every facade call; the native compact lane removes
it before dispatch:

```ts
await lifecycle.acceptProposal({
  account,
  proposal_id: proposal.proposal_id,
  proposal_terms_digest: proposal.terms_digest, // absent on an honest legacy proposal
  total_budget: { amount: 50_000, currency: 'USD' },
  established_fallback: {
    brand,
    start_time: flight.start,
    end_time: flight.end,
  },
});
```

For a legacy proposal with no digest or immutable commercial-terms snapshot,
omit `proposal_terms_digest` and opt into the three named losses above. The
proposal returned to the application is the seller's actual legacy proposal;
the compatibility layer does not upgrade its state or add compact fields.

A 3.2-only seller may omit `sales` entirely. `getMediaBuys` and
`getMediaBuyDelivery` can live on `mediaBuyLifecycle` alongside the seven
compact lifecycle methods. Authenticated mutations receive an immutable
`ctx.callerMutationScope`; `refineProposals` also receives the framework-owned
`ctx.proposalRefinementScope`. Persist and query proposal state under these
trusted namespaces, never a buyer-supplied proposal ID alone.

## Compatibility matrix to keep in CI

| Buyer surface | Seller surface | Expected path | Guarantee |
|---|---|---|---|
| Established `getProducts` / `createMediaBuy` / `updateMediaBuy` | AdCP 2.5–3.1 or a dual-surface 3.2 seller | Established tools are called directly | Existing application behavior remains unchanged; the compact coordinator is not involved. |
| Compact-first coordinator | AdCP 2.5 | `list_products` → `get_products`; purchase → `create_media_buy`; supported control → `update_media_buy` | The direct common subset remains usable. Proposal objects/binding, media-buy readback, pagination, cancellation, v3-only top-level/package fields, and update reporting-webhook changes are typed unsupported rather than sent into v2.5's permissive additional-properties boundary. Feed fencing and optimistic revision enforcement require their named loss opt-ins. |
| Compact-first coordinator | AdCP 3.0, 3.1, or 3.2 legacy-only | `list_products` → `get_products`; proposal discovery/refinement → `get_products`; control → `update_media_buy`; purchase → `create_media_buy` only when its named loss policy permits it | Common-subset reads and control are lossless. Atomic feed/pricing fencing, digest enforcement, and terminal decline are not representable and fail before mutation by default. |
| Compact-first coordinator | AdCP 3.2 dual-surface | Compact tools are preferred; `preferredLifecycle: 'established'` exercises the compatibility facade | Native by default; the forced established lane has the same explicit boundaries as older sellers. |
| Compact-first coordinator | AdCP 3.2 compact-only | Compact lifecycle tools | Native compact guarantees. |
| Existing AdCP 3.0/3.1 buyer | Dual-surface SDK 14 seller | Hidden legacy names remain directly callable even though compact names are the advertised profile | Existing buyer code does not need lifecycle negotiation. |

“Same application lifecycle” therefore means one coordinator API and the same
commercial intent wherever that intent is representable. It does **not** mean
that a 3.0 seller can enforce a 3.2-only atomicity or digest guarantee. The SDK
must reject that case or report the exact explicitly accepted loss; it must
never label the weaker mutation as equivalent.

The coordinator test matrix covers SDK 14 compact-first callers against v2.5,
3.0, 3.1, 3.2 legacy-only, 3.2 dual-surface (compact preferred and established
forced), and 3.2 compact-only discovery. Honest raw-MCP 3.0.25, 3.1.18, and
3.2 legacy-only fixtures execute direct purchase; pause, resume, cancellation,
and readback; plus request, finalize, decline, accept, post-accept control, and
readback for ordinary legacy proposals while
validating every request and response against the corresponding cached wire
bundle. Those lanes assert canonical format projection, pagination,
feed/pricing provenance, account/brand/context/currency continuity, exact
replay, changed-payload conflict, no duplicate mutation, control, and shared
readback. The honest v2.5 fixture executes its complete representable direct
subset, validates exact legacy wire, and asserts typed failures for pagination,
proposals, cancellation, unsupported create/update fields, and media-buy
readback. Versioned MCP fixtures also preserve submitted and input-required
proposal states without inventing completed outcomes. A normal 3.2 server
profile is exercised by 3.0 and 3.1 buyers through hidden established routes,
including proposal refinement/decline/acceptance, budget and date changes,
pause/resume/cancel, and readback. A2A integration proves the same coordinator
selects and projects the established direct, proposal, budget-control, and
media-buy/delivery-readback paths through the official A2A client/server stack;
date changes are asserted as a pre-dispatch typed boundary because compact
operational control deliberately excludes flight changes. A separate native
compact A2A lane covers successful proposal request, finalization, decline,
acceptance, direct purchase, pause/resume/cancel for both purchase paths,
stale-revision conflict, media-buy and delivery readback, identity continuity,
and the exact tool sequence.

The strict public-API MCP integration lanes validate compact 3.2, legacy 3.1,
and legacy 3.0 discovery requests against their selected wire bundles. Native
compact wire gates cover typed request/refine/decline outcomes, acceptance,
pause, resume, budget control, cancellation, and authoritative readback in
addition to the public CLI storyboards. Pass `--media-buy-lifecycle-compat` to route those compact steps
through the same coordinator against an external established seller. Named
mutation losses remain fail-closed unless supplied with
`--media-buy-compat-losses`; use
`--force-established-media-buy-lifecycle` for the separate fallback lane on a
dual-surface 3.2 seller. Add a stable, non-secret
`--media-buy-principal-scope` for proposal journeys; otherwise the CLI creates
a run-local scope that cannot authorize a later run. Together with the honest MCP fixtures and official A2A
coverage above, this is the issue #2613 SDK 14 release gate.

```bash
adcp storyboard run https://seller.example/mcp <compact-storyboard-id> \
  --media-buy-lifecycle-compat \
  --media-buy-principal-scope buyer-tenant-1 \
  --media-buy-compat-losses feed_version_not_atomic,pricing_version_not_atomic
```

The unresolved hard-budget mapping is tracked normatively in
`adcontextprotocol/adcp#6685`. Until the protocol defines equivalence between
compact `constraints.total_budget` and legacy `budget_range`, the SDK rejects
that structured constraint before dispatch rather than weakening it.

For each lane, assert more than tool presence:

1. `tools/list` exposes the version-appropriate surface and metadata.
2. The request validates against the selected 3.0, 3.1, or 3.2 bundle.
3. Tenant and authenticated-principal scope reaching the business handler is
   identical across both facades.
4. Exact retry keys replay; changed payloads conflict; no cache entry crosses
   a tool, tenant, account, or buyer principal.
5. Product, proposal, media-buy, and delivery reads return the same underlying
   commercial state through the appropriate versioned response projection.
6. Both MCP SDK clients and raw legacy-name calls are covered, so discovery
   filtering cannot accidentally remove compatibility dispatch.

Do not test a compact request by casting it to a legacy request type. Exercise
the actual buyer method and wire schema for each lane.
