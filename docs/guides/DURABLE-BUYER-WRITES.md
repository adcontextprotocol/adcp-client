# Durable buyer writes across processes

This recipe preserves one outbound AdCP 3.2 mutation when the HTTP caller,
callback receiver, poller, and publisher are different processes. It is
validated against the SDK 14 prerelease carrying the pinned `3.2.0-rc.4`
protocol bundle. Earlier SDK 14 prereleases are not the supported baseline for
this recipe.

The compiling two-process example is:

- [`caller.ts`](../../examples/durable-buyer-writes/caller.ts) — stages an
  immutable `buy_products` request, binds the SDK callback operation to it in
  the registration transaction, and dispatches with a request-scoped client.
- [`worker.ts`](../../examples/durable-buyer-writes/worker.ts) — reconstructs a
  fresh authorized client for callback verification, polling, A2A continuation
  resume, and host-outbox publication.

The example uses PostgreSQL, but the SDK also ships
`redisWebhookRegistrationStore` and Redis replay/idempotency backends. Do not
mix volatile and durable implementations in one receiver fleet.

## Four identities, four columns

Never substitute one of these values for another:

| Identity | Issuer and purpose | Example column |
| --- | --- | --- |
| Logical operation ID | Host application; one business intent and its recovery record | `logical_operation_id` |
| Request `idempotency_key` | Buyer; immutable replay identity for one canonical mutating request | `request_idempotency_key` |
| Seller `task_id` | Seller; polling handle for accepted asynchronous work | `seller_task_id` |
| Webhook `idempotency_key` | Seller webhook infrastructure; delivery-key binding for retries of one payload | SDK webhook-dedup backend |

The webhook delivery key is an infrastructure-layer convention carried in the
AdCP webhook envelope, not the original request key. The SDK's client-minted
`operation_id` is a fifth correlation/routing value: the example stores it as
`sdk_operation_id` in an insert-only route table and binds every retry attempt
to the host operation before network dispatch. Late callbacks from an earlier
attempt therefore remain verifiable and routable.
An A2A `Task.id`, A2A `contextId`, and a deferred continuation token remain
separate again.

A retry after an uncertain response reloads the stored canonical payload and
request key. It does not regenerate either. A later A→B→A business sequence is
three operations with three keys even though the final business state resembles
the first. A timeout is not evidence that the seller rejected the request and
is never an automatic reason to rotate the key. Reconcile by the operation's
natural key before deciding that a new intent exists.

## Production wiring

The published example is source rather than a package export, so applications
normally copy it. Import its migration/readiness functions locally and run
them from deployment/startup tooling before accepting traffic:

```ts
import { Pool } from 'pg';
import { migrateDurableBuyer, probeDurableBuyerStores } from './durable-buyer-writes/caller.js';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
await migrateDurableBuyer(pool);
await probeDurableBuyerStores(pool); // startup/readiness, not once per request
```

Its named tables are deployment-specific:

| State | Example namespace/table | Retention |
| --- | --- | --- |
| Host operation, natural key, and terminal winner | `buyer_prod_v1` in `buyer_adcp_operations` | Through business reconciliation and audit policy |
| SDK attempt-to-operation routes | `buyer_adcp_operation_routes` | At least as long as the matching callback registrations |
| Host publication outbox | `buyer_prod_v1` in `buyer_adcp_publications` | Until published, then through the host's duplicate-proof horizon |
| Trusted callback registration | `buyer_adcp_webhook_registrations` | At least the seller webhook retry horizon; seven days in the example |
| RFC 9421 nonce replay fence | `buyer_adcp_webhook_replays` | SDK signature window; sweep only expired rows |
| Webhook delivery and terminal dedup | `buyer_adcp_webhook_dedup` | At least `max(24h, advertised delivery retry horizon)`; seven days in the example |
| Deferred continuation | Host `DeferredTaskStorage` | At least the permitted human-input/recovery interval; seven days in the example |

Use deployment-unique PostgreSQL table names or Redis prefixes. Run the
root-exported `cleanupExpiredWebhookRegistrations()` and the
`@adcp/sdk/signing/server` export `sweepExpiredReplays()` as bounded
maintenance. Remove an attempt route only after its registration is gone;
idempotency-backend cleanup is likewise operational maintenance, not a
correctness prerequisite. The pinned 3.2 schema caps the advertised webhook
retry horizon at the example's seven-day value. Backend clocks, not process
clocks, decide expiry.

`DeferredTaskStorage` is deliberately an application adapter because paused
state can contain application-owned projection context. Supply the same atomic
implementation to every caller and worker. It must implement generation CAS,
atomic operation routing, encrypted-at-rest storage, expiry, and the full
contract in [Async API reference](./ASYNC-API-REFERENCE.md#deferredtaskstorage).
Do not replace it with `MemoryStorage` in a restart-sensitive deployment.

### Stage, then dispatch

```ts
const ledger = new PostgresOperationLedger(pool);
await ledger.stage(logicalOperationId, orderId, authorizedSession, {
  account: { account_id: authorizedSession.sellerAccountId },
  brand: { domain: advertiserDomain },
  feed_version: selectedFeedVersion,
  pricing_version: selectedPricingVersion, // when list_products supplied one
  purchases: selectedRealProducts,
  purchase_order_ref: orderId,
  start_time: 'asap',
  end_time: campaignEnd,
});

await dispatchStagedBuy(dependencies, logicalOperationId);
```

`stage()` commits the logical ID, separately supplied natural key, request key,
complete canonical payload, seller/account binding, tenant, and principal before
the SDK call. Mirror the natural key into a seller-supported field such as
`purchase_order_ref` or namespaced `context` so seller readback can reconcile an
expired or ambiguous request. During SDK pre-dispatch registration,
the example's `OperationBoundRegistrationStore` atomically writes the supported
PostgreSQL registration and binds the new SDK `operation_id` to that row. A
crash before that transaction returns sends nothing; a crash after it remains
recoverable by a different process. A retry creates another operation route
but reuses the original canonical payload and request key. A seller response
without result data remains `dispatch-uncertain`; malformed result data becomes
`terminal-result-pending`. Neither can win terminal settlement merely because a
transport adapter reported `failed`. Treat `staged`, `dispatch-uncertain`, and
`terminal-result-pending` as reconciliation queues, not terminal outcomes.
Abort and deadline errors are thrown rather than returned by the SDK; the
example catches that path, marks the stored row `dispatch-uncertain`, and
rethrows the original error with its SDK-attached request key intact.

The host's `resolveSellerSession()` rechecks current tenant, principal, seller,
and account authorization and re-derives the request-local bearer. It returns
`undefined` for an authorization denial and throws for an infrastructure
failure, so callback workers can return static 404 versus retryable 5xx without
leaking details. No token is stored in the operation, deferred state, callback
URL, or `ctx_metadata`.

### Receive on a fresh process

Mount a raw-body route matching the configured server-owned template:

```ts
app.post(
  '/adcp/webhook/:task_type/:agent_id/:operation_id',
  express.raw({ type: 'application/json' }),
  async (req, res, next) => {
    try {
      await receiveTaskWebhook(dependencies, req, res);
    } catch (error) {
      next(error); // static application 500/503 handler; never reflect error.message
    }
  },
);
```

`receiveTaskWebhook()` resolves the operation from `(seller,
operation_id)`, reauthorizes it, constructs a new `AgentClient`, and invokes the
SDK HTTP helper. The helper reads the shared registration, verifies RFC 9421
and its replay fence, validates the route/envelope/task identities, and applies
the shared webhook-dedup claim before the host handler runs. Its public URL is
constructed from server-owned configuration, never `Host` or forwarding
headers. Preserve the helper's 2xx/409/429/503 mapping.
The example rejects seller IDs outside the RFC 3986 unreserved set because the
SDK substitutes callback macros without percent-encoding them. Missing or
unauthorized pre-verification routes receive a static 400/404; database or
readiness failures flow to the application's static error middleware.

### Poll or resume after restart

Persist `metadata.serverTaskId`, never `metadata.taskId`, as the seller polling
handle. When no callback arrives:

```ts
await recoverByPolling(dependencies, logicalOperationId, AbortSignal.timeout(15_000));
```

`recoverByPolling()` intentionally uses the public `TaskExecutor` because the
similarly named `AgentClient.getTaskStatus()` method is internal. Its third
positional argument is optional transport configuration; the example passes
`undefined` before the abort signal. A terminal poll without the canonical
`result` is evidence of status, but not enough to fingerprint or publish the
business result; keep reconciling until result readback or a callback supplies
it.

For an A2A pause with a verified native continuation, persist the SDK deferred
token and reconstruct the client with the same `DeferredTaskStorage` before:

```ts
await resumePendingInput(dependencies, logicalOperationId, approvedInput);
```

Reauthorization happens immediately before resume. MCP pauses and A2A pauses
without native `Task.id` plus `contextId` are intentionally nonresumable; the
status label or seller work ID cannot be promoted into a continuation
capability. For a committed legacy-purchase compatibility continuation,
negotiate `MediaBuyLifecycleCoordinator` on the fresh `AgentClient` with the
same durable continuation store, `principalScope`, and stable non-secret
`legacyPurchaseSellerSessionScope` before `resumeDeferredTask()`. That installs
the SDK settlement recoverer; a bare replacement client correctly fails closed.
For the direct `buy_products` path, the example also takes a leased host
continuation claim immediately before resume. Terminal callbacks return a
retryable in-progress response while that claim is live; a callback that wins
before the claim prevents resume. The example enforces a five-minute minimum
and renews the claim while the resume call is active. If renewal is lost, it
refuses to commit that worker's observation and lets callback or polling
reconciliation choose the terminal winner.

Direct A2A mutations can close the nested-pause handoff window with
`TaskOptions.durableContinuationRecovery`. Supply an `ownerScope` derived from
the authenticated principal and seller account, then persist the initial
`result.deferred.recovery` operation ID and host-only recovery key. If a worker
dies after atomically moving the SDK route from token A to token B but before
the host observes B, a fresh `AgentClient` calls
`recoverDirectPauseContinuation({ operationId, recoveryKey, ownerScope })` to
reconstruct B without seller I/O. The SDK stores only a key digest, also binds
the route to the supplied owner scope and trusted seller identity, and keeps this
direct route separate from the legacy compatibility coordinator's committed
settlement path. A claimed uncertain-dispatch fence fails with an explicit
"do not redispatch" error. Persist the initial recovery pair before treating
the first pause as restart-safe. The route ends when continuation leaves a
resumable pause; a missing route after possible dispatch is never evidence
that redispatch is safe. Reconcile terminal uncertainty by polling the saved
seller task ID.

## Terminal settlement and host publication

Direct responses, verified callbacks, polls, and continuation results compete
to update one locked operation row. The first authoritative terminal
fingerprint wins. An exact duplicate sees the same fingerprint and one existing
outbox row. A different canonical terminal payload rolls back with a conflict
and cannot replace the winner. Task-envelope labels that carry the same
canonical commitment payload intentionally converge; the first observed label
remains in the operational status column.

Only schema-valid terminal seller result payloads are fingerprinted. The
fingerprint projects immutable commitment identity (`media_buy_id`, `revision`,
`accepted_proposal`, and `purchase_bindings`) and excludes delivery-only or
time-varying fields such as `replayed`, `context`, `ext`, `available_actions`,
`media_buy_status`, `confirmed_at`, and `warnings`, so direct, poll, and
callback delivery of the same business result converge. The first full
validated payload remains the publication value. The ledger's `status` column records task-envelope
status independently from the commitment payload's own `completed`/`failed`
discriminant. SDK-local transport failures and terminal polls that
omit `result` remain nonterminal host observations. An incomplete terminal
callback is rejected with a retryable 503 before the SDK publishes its dedup
claim, so a corrected retry can still settle the operation.

The same database transaction records the terminal winner and inserts the
publication outbox row. `publishOne()` establishes a leased publication owner
before calling application code. Because PostgreSQL and an external event bus
do not share a transaction, the downstream publisher must atomically
deduplicate `logicalOperationId`. A crash after the external send but before
the database ACK then causes an idempotent retry, not a duplicate business
effect. Keep each send below the example's 60-second lease or renew the claim
effect. Keep each send below the example's 60-second lease; this compact helper
does not expose publication-lease renewal. If the destination cannot offer that
contract, publish into a database table consumed transactionally with the
destination's own state instead.

The SDK owns transport/protocol validation, callback authentication, replay
protection, registration persistence, delivery claims, status normalization,
and continuation fencing. The host still owns:

- authenticated tenant/principal/seller/account resolution and credential
  re-derivation;
- durable logical-operation, canonical-request, natural-key, and task-handle
  storage;
- an atomic `DeferredTaskStorage` implementation for restart-safe A2A pauses;
- terminal winner plus publication-outbox transaction;
- idempotent downstream publication, leases, monitoring, dead letters, and
  retention/cleanup scheduling;
- campaign approvals, budgets, per-seller orchestration, and ongoing delivery
  reconciliation.

## Evidence matrix

| Boundary | Expected convergence | Existing SDK evidence / host proof |
| --- | --- | --- |
| Seller accepts, response is lost | Retry the same canonical payload and request key; reconcile before any new intent | Exact pinned-key transport retry is covered by [`media-buy-lifecycle-coordinator.test.js`](https://github.com/adcontextprotocol/adcp-client/blob/main/test/lib/media-buy-lifecycle-coordinator.test.js#L12478); typed replay, conflict, and expiry surfaces are covered by [`idempotency-client.test.js`](https://github.com/adcontextprotocol/adcp-client/blob/main/test/lib/idempotency-client.test.js#L114), [line 288](https://github.com/adcontextprotocol/adcp-client/blob/main/test/lib/idempotency-client.test.js#L288), and [line 307](https://github.com/adcontextprotocol/adcp-client/blob/main/test/lib/idempotency-client.test.js#L307). The example stages the canonical request value and key first. |
| Callback before submitted response | Callback winner is retained; later nonterminal response is stale | [`task-executor-pre-dispatch-boundary.test.js`](https://github.com/adcontextprotocol/adcp-client/blob/main/test/lib/task-executor-pre-dispatch-boundary.test.js#L351). |
| Callback reaches another process after caller exit | Fresh receiver reads the shared trusted registration and operation binding | PostgreSQL and Redis reconstruction are covered by [`webhook-registration-durability.test.js`](https://github.com/adcontextprotocol/adcp-client/blob/main/test/lib/webhook-registration-durability.test.js#L239) and [line 359](https://github.com/adcontextprotocol/adcp-client/blob/main/test/lib/webhook-registration-durability.test.js#L359); restarted durable callback settlement is covered by [`task-executor-pre-dispatch-boundary.test.js`](https://github.com/adcontextprotocol/adcp-client/blob/main/test/lib/task-executor-pre-dispatch-boundary.test.js#L2096). |
| Restart after observation, before host publication | Terminal winner and one outbox row commit together; a publisher lease is recoverable | The example's PostgreSQL rollback and expired-lease recovery are exercised in [`durable-buyer-writes.test.js`](https://github.com/adcontextprotocol/adcp-client/blob/main/test/examples/durable-buyer-writes.test.js#L91) and [line 128](https://github.com/adcontextprotocol/adcp-client/blob/main/test/examples/durable-buyer-writes.test.js#L128). Downstream idempotency on `logicalOperationId` closes the post-send/pre-ACK window. |
| Repeated identical terminal observations | Acknowledge without another handler/publication | Host transaction race: [`durable-buyer-writes.test.js`](https://github.com/adcontextprotocol/adcp-client/blob/main/test/examples/durable-buyer-writes.test.js#L59). SDK delivery-key and cross-key terminal dedup: [`async-handler-webhook-dedup.test.js`](https://github.com/adcontextprotocol/adcp-client/blob/main/test/lib/async-handler-webhook-dedup.test.js#L194) and [`task-executor-pre-dispatch-boundary.test.js`](https://github.com/adcontextprotocol/adcp-client/blob/main/test/lib/task-executor-pre-dispatch-boundary.test.js#L2505). |
| Conflicting terminal observations | Preserve first winner and return conflict | Host winner preservation: [`durable-buyer-writes.test.js`](https://github.com/adcontextprotocol/adcp-client/blob/main/test/examples/durable-buyer-writes.test.js#L59). SDK dedup and deferred winner protection: [`async-handler-webhook-dedup.test.js`](https://github.com/adcontextprotocol/adcp-client/blob/main/test/lib/async-handler-webhook-dedup.test.js#L288) and [`single-agent-deferred-recovery.test.js`](https://github.com/adcontextprotocol/adcp-client/blob/main/test/lib/single-agent-deferred-recovery.test.js#L3006). |
| Pending input or authorization | A fresh authorized process resumes the persisted current A2A token once; callbacks and the host lease fence competing settlement | SDK generation fencing and restart settlement are covered by [`single-agent-deferred-recovery.test.js`](https://github.com/adcontextprotocol/adcp-client/blob/main/test/lib/single-agent-deferred-recovery.test.js#L155), [line 411](https://github.com/adcontextprotocol/adcp-client/blob/main/test/lib/single-agent-deferred-recovery.test.js#L411), and [line 2136](https://github.com/adcontextprotocol/adcp-client/blob/main/test/lib/single-agent-deferred-recovery.test.js#L2136). The host reauthorization/lease is in `resumePendingInput()`. Direct A→B route recovery at the store-B/host-observation crash boundary is covered by [`direct-pause-recovery.test.js`](https://github.com/adcontextprotocol/adcp-client/blob/main/test/lib/direct-pause-recovery.test.js). |
| No callback; polling recovery | Poll exact seller `task_id`; callback and poll race to the same terminal winner | Poll-first closure and competing callback fencing: [`task-executor-pre-dispatch-boundary.test.js`](https://github.com/adcontextprotocol/adcp-client/blob/main/test/lib/task-executor-pre-dispatch-boundary.test.js#L1104). Restarted pending polling without redispatch: [`single-agent-deferred-recovery.test.js`](https://github.com/adcontextprotocol/adcp-client/blob/main/test/lib/single-agent-deferred-recovery.test.js#L2524). |

## Task completion is not delivery completion

A completed `buy_products`, `accept_proposal`, or `create_media_buy` task says
that mutation finished and yields a MediaBuy identity. It does not say the buy
finished delivering. Move that `media_buy_id` into a separate, durable delivery
reconciliation loop using `get_media_buys`, `get_media_buy_delivery`, reporting
materializations, and their own notification receipts. Deleting the task
operation must never delete the campaign/delivery watch.

Task-status push is eligible only after the seller returns `submitted` or
otherwise creates durable asynchronous work. AdCP 3.2 synchronous terminal
responses are authoritative inline and must not produce a task-completion
webhook. The server-side silence contract is tested in
[`server-decisioning-auto-emit-completion.test.js`](https://github.com/adcontextprotocol/adcp-client/blob/main/test/server-decisioning-auto-emit-completion.test.js#L94).
`reporting_webhook` is a distinct ongoing-delivery channel and remains in the
task parameters; it is not a substitute for `push_notification_config`.

## Helper boundaries

`attachTaskDeadlineIdempotencyKey` is an internal SDK helper, not a package-root
API. After the SDK already selected the request key, it copies that key onto a
pending `TaskTimeoutError` so callers can recover the exact request. It does not
derive a logical operation ID, canonicalize business intent, persist a request,
or authorize rotation. Application code should inspect the timeout's exposed
idempotency-key field and return to its own durable operation row.

Media-buy action helpers have a different boundary. `assessMediaBuyAction` and
the legacy `preflightUpdateMediaBuy` assess whether a proposed update/control
is legal against accepted terms, current state, and advertised actions. They do
not prove creative validity, account authorization, product availability,
budget approval, or final seller acceptance. Product/capability discovery,
`validate_input` or `sync_creatives({ dry_run: true })`, authenticated account
resolution, and the actual mutation retain those responsibilities.
`preflightUpdateMediaBuy` is root-exported; import `assessMediaBuyAction` from
`@adcp/sdk/media-buy/actions`.

## Adoption checklist

- [ ] Pin and test the SDK 14 prerelease carrying AdCP `3.2.0-rc.4`; reassess this guide when upgrading either pin.
- [ ] Apply every current migration helper and the host operation/outbox migration before traffic; configure unique tables/prefixes and readiness probes.
- [ ] Persist one logical operation, natural key, request key, and canonical request before dispatch; refuse same-operation payload drift.
- [ ] Keep every SDK attempt route through the matching callback-registration retention window; retries add routes but preserve the request key.
- [ ] Use one stable seller ID and the same registration, RFC 9421 replay, webhook-dedup, deferred, operation, and publication stores on every replica.
- [ ] Retain callback/dedup/proof state for at least `max(24h, seller advertised webhook horizon)` and request keys through the seller replay horizon.
- [ ] Re-resolve tenant, principal, seller credential, and seller account before dispatch, callback handling, polling, and continuation resume.
- [ ] Capture exact raw callback bytes and build the public URL from trusted configuration; keep the SDK's failure status mapping.
- [ ] Persist `metadata.serverTaskId` for polling. Never poll with SDK `operation_id`, request key, A2A `Task.id`, or continuation token.
- [ ] Make terminal settlement first-writer-wins, fingerprint canonical task value, insert the host outbox in the same transaction, and make the downstream consumer idempotent by logical operation ID.
- [ ] Configure and contract-test a durable `DeferredTaskStorage` before accepting restart-sensitive A2A pauses; never fabricate MCP continuation identity.
- [ ] For direct A2A mutations, enable `durableContinuationRecovery`, persist the first `deferred.recovery` pair before treating the pause as restart-safe, and recover the current pause route after a crash; a missing route after possible dispatch never authorizes redispatch.
- [ ] Alert on aged reconciliation rows, unpublished outbox rows, and repeated publisher failures; apply a host-owned retry/dead-letter policy.
- [ ] Keep MediaBuy/delivery reconciliation alive after create-task completion.
- [ ] Run `npm run ci:doc-links` and `npm run ci:quick`; the linked focused suites are the acceptance evidence for the SDK-owned boundaries.
