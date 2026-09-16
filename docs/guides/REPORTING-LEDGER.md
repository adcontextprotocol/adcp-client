# Seller Reporting Ledger

`@adcp/sdk/reporting/ledger` turns a conforming reporting source into durable seller-side Reliable Reporting Core. It is separate from the buyer-side `reconcileReporting` API.

```ts
import { Pool } from 'pg';
import {
  PostgresReportingLedgerStore,
  REPORTING_LEDGER_MIGRATION,
  sweepExpiredReportingLedgerState,
  createReportingDeliveryHandler,
  createReportingProducer,
  createReportingStatusHandler,
  createSyncReportingStatusHandler,
  type ReportingConsumerStatusLedgerStore,
} from '@adcp/sdk/reporting/ledger';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
await pool.query(REPORTING_LEDGER_MIGRATION);

const store = new PostgresReportingLedgerStore(pool, {
  acknowledgeIsolatedDatabase: true,
});
const producer = createReportingProducer({
  store,
  source,
  offerings,
  contact: { name: 'Reporting operations', email: 'reporting@example.invalid' },
});

const getReportingStatus = createReportingStatusHandler(store);
const getMediaBuyDelivery = createReportingDeliveryHandler(store);

// Run periodically from one or more bounded maintenance workers.
await sweepExpiredReportingLedgerState(pool);
```

Pass `getReportingStatus` and `getMediaBuyDelivery` directly to the matching `createAdcpServer` slots. The delivery helper serves only exact `reporting_revision_id` reads and returns the row payload bound by the ledger revision. Advertise `media_buy.reporting_delivery` in `experimental_features` together with a `media_buy.reporting_delivery` capability whose Reliable Reporting version is `1.0` only after both handlers are wired. Configure account resolution on the server: both handlers require the framework-resolved, caller-scoped account identity and never trust a request-body identity as an authorization boundary. If two callers can name the same upstream account, the resolver must issue distinct internal account IDs for their ledger namespaces. Install immutable delivery-configuration generations through `producer.installConfiguration`, call `planObligations()` after period close, and run `runWorker()` from a durable scheduler. Multiple workers are safe: PostgreSQL claims use `SKIP LOCKED`, expiring leases, and fencing generations.

The planner uses fixed millisecond periods and an explicitly frozen IANA source timezone. Calendar or billing-cycle schedules should be expanded by the seller into immutable period boundaries before installation; the SDK intentionally has no Temporal dependency. At period end, the obligation freezes the constituent denominator and coverage. A zero-row source object commits like any other revision. Absence remains an empty revision association. A deployment with per-tenant workers should pass the resolved `account_id` to both `planObligations()` and `runWorker()`; omitting it intentionally runs a deployment-wide worker.

Official configurations also pin a `finalityPolicy` (`policyId` plus `source_final` or `contractual_cutoff`). For `source_final`, set `sourceSignal` to the exact opaque signal identifier the adapter places in the manifest finality evidence's `evidenceRef`; the worker requires an exact match before irreversible official publication. `expected_at` and the wire delivery SLA use the same official deadline.

Every revision stores its rows together with an RFC 8785 JCS SHA-256 binding and exact decimal control totals for requested numeric metrics. A revision number and obligation are immutable. Official revisions are terminal; later source corrections are immutable adjustments bound to the official revision, never superseding revisions. Status snapshots omit row payloads, are capped at 8 MiB, expire after 15 minutes, and keep cursor pages stable over the flat obligation/revision/adjustment union. A periods response returns an opaque `changes_checkpoint`; echo that value verbatim as `changes_after` rather than supplying a timestamp. Account-scoped write/snapshot locks make those checkpoints gap-free for SDK store writes. The default table set is deployment-wide; use a dedicated database/schema and acknowledge that boundary explicitly. `sourceScope` must contain opaque routing identities only—never credentials or bearer tokens—because it is retained with the obligation.

## Transactional status notifications and account activity

Production deployments can join every health or observed-finality transition to
a compact account-operator activity record. Health transitions additionally
create one durable, schema-conformant `reporting.status_changed` intent;
finality-only changes remain internal activity because the AdCP event is defined
only for health changes:

```ts
import { createPostgresPersistentNotificationRuntime } from '@adcp/sdk/server';
import {
  createPostgresReportingNotificationActivityRuntime,
  PostgresReportingLedgerStore,
  REPORTING_LEDGER_FINALITY_WRITER_FENCE_MIGRATION,
  REPORTING_LEDGER_MIGRATION,
} from '@adcp/sdk/reporting/ledger';

const notifications = createPostgresPersistentNotificationRuntime({
  db: pool,
  publisherScope: 'seller-production',
  subscriptions: { acknowledgeIsolatedDatabase: true },
  ...notificationOptions, // proof, protected credentials, webhooks, authorization
});
const reportingActivity = createPostgresReportingNotificationActivityRuntime({
  db: pool,
  notifications,
  // Use a deployment-unique value whenever a PostgreSQL schema is shared.
  namespace: 'seller-production',
  // Pure host-owned mapping from an internal ledger account. Never derive
  // this from transition data, an incoming request body, or ctx_metadata.
  tenantScopeForAccount: accountId => durableAccountDirectory.tenantFor(accountId),
});

// Rolling-deployment order: ledger and notification tables, activity table,
// drain legacy pending transitions, then application code configured with the port.
await pool.query(REPORTING_LEDGER_MIGRATION);
for (const sql of notifications.migrations.all) await pool.query(sql);
for (const sql of reportingActivity.migrations.all) await pool.query(sql);

// Wire the durable pre-POST checkpoint. Build it before the notification
// runtime; probe() below fails closed if it is missing.
// const attemptCheckpoint = createPostgresReportingNotificationAttemptCheckpoint({
//   db: pool,
//   namespace: 'seller-production',
// });
// ... then pass `checkpointDeliveryAttempt: attemptCheckpoint` to
// createPostgresPersistentNotificationRuntime above.

// Before enabling the port, keep legacy subscribers configured and run
// retryReportingStatusNotificationsV1() until listPendingTransitions() is empty.
// The transactional store fails closed if legacy pending rows remain.

// Last cutover step, only once no pre-SDK-14 writer is still serving: fence
// finality-less transitions out of the log. A surviving legacy writer now fails
// closed on append instead of silently adding another redundant finality event.
await pool.query(REPORTING_LEDGER_FINALITY_WRITER_FENCE_MIGRATION);

const store = new PostgresReportingLedgerStore(pool, {
  acknowledgeIsolatedDatabase: true,
  notificationActivityPort: reportingActivity.port,
});

// Do not also pass legacy ReportingLedgerSubscriberV1 callbacks to lifecycle
// reconciliation. The transactional port is the sole notification handoff.

await reportingActivity.probe();
await notifications.probe();

// Run both bounded calls repeatedly from the deployment's durable scheduler.
await reportingActivity.recoverOnce({
  ownerToken: process.env.INSTANCE_ID!,
  onError: (error, claim) => operationalLogger.error({ error, claim }),
});
await notifications.recoverOnce({ ownerToken: process.env.INSTANCE_ID! });
```

`applyLifecycleProjection()` owns the transaction. After locking and rechecking
the obligation and revision evidence, the PostgreSQL store inserts the
transition, updates its issues, and calls `notificationActivityPort` with that
same transaction client. A port error rolls the whole unit back. The port does
no network I/O and stores no destination or authentication material. Only after
commit does `recoverOnce()` call the existing persistent-notification runtime,
which reads current subscriptions, enforces tenant/account matching and live
authorization, resolves opaque credential bindings, and checkpoints the normal
encrypted webhook outbox before POSTing. The activity queue is not a second
sender, credential authority, retry engine, or reporting ledger.
The store atomically stamps the transition's `notifiedAt` field as a durable
handoff marker in that same transaction. In transactional mode this field means
the activity intent is durable, not that a recipient matched or network delivery
occurred. A legacy deployment with unnotified transitions must drain or
explicitly resolve them before enabling the port; the lifecycle rejects the
cutover rather than silently abandoning those rows.

The logical notification identity is derived from the immutable transition and
is reused through ambiguous crashes. Intent insertion is exactly once;
delivery remains at least once. A crash before commit exposes neither the
transition nor its activity. A crash after commit leaves pending work. A crash
after webhook checkpointing may replay projection, but the existing webhook
delivery identity prevents rebinding. The bridge intentionally binds recipients
when the existing notification runtime checkpoints each per-subscriber webhook
delivery, not while the ledger transaction is open: that keeps subscription
credentials and destination authority out of the ledger transaction and ensures
a replacement or revocation that wins before checkpointing is honored. From
that checkpoint onward the subscriber and destination generation are stable;
the runtime rechecks live authorization on every attempt and suppresses stale
or revoked generations. Already-authorized in-flight POSTs cannot be retracted.
This explicit drain-time rule is what the replacement and revocation crash tests
assert.

Account operators can read a bounded keyset page without loading report rows:

```ts
const page = await reportingActivity.listActivity({
  tenantId: authenticatedTenant.id,
  accountId: resolvedInternalAccount.id,
  limit: 100, // 1..200
  cursor: previousPage.nextCursor,
});
```

Both scope values must come from authenticated server context. Cursors are
scope-bound and cannot be moved between accounts or tenants; the runtime also
revalidates the account-to-tenant mapping on every read. Pagination is a
newest-first operator view, not a gap-free change feed: a transaction that
commits after a page was read may have an earlier PostgreSQL sequence, so
refresh from the first page to discover concurrent late commits. Records include
the transition identity, health and observed-finality change, occurrence and
projection timestamps, issue IDs, period, and non-secret configuration/report
correlation references. They never embed revision rows, `sourceScope`,
subscriber destinations, credential handles, credentials, or `ctx_metadata`.
Each compact activity intent is capped at 64 KiB.
The runtime also applies atomic per-tenant backpressure at 100,000 pending
health notifications by default; tune `maxPendingPerTenant` to deployment
capacity and alert on the operational error instead of dropping durable intent.
This is an SDK/adopter API only: AdCP defines the complete health-notification
wire payload but no public account-activity read task, so do not expose `listActivity()`
as an invented wire extension.

Projected activity defaults to 90-day retention measured from projection (or
from commit for finality-only records that require no wire projection). Override `retentionMs` only to
match an explicit operator policy, schedule bounded `pruneProjected()` calls,
and retain pending rows until they have been projected. The reporting worker
retries failed projection without a terminal attempt cap; once the notification
runtime has durably accepted every matched subscriber, its own webhook outbox
owns delivery retry and retention. Supply `recoverOnce({ onError })` to report a
failed projection attempt without changing lease or retry semantics.
`matched` reports how many active subscribers were checkpointed; a projected
row with `matched: 0` is expected after revocation and does not claim network
delivery. Each recovery poll claims one row at a time so work waiting behind a
slow fanout is never left under an expiring pre-claimed lease.
The host remains responsible for a database-level retained-row/byte quota and
storage alerting per tenant or isolated deployment; the runtime's pending cap
protects delivery backlog but is not a general PostgreSQL storage quota.

### Recipient intent is frozen before any send, and revisable per recipient

The recovery worker commits its resolved recipients before anything leaves the
process, via `NotificationEvent.freezeRecipients`. The runtime then delivers
only the intersection of what is resolvable now and what was committed, so each
subscriber's `delivery_id` — and therefore the `idempotency_key` it dedupes on —
is stable across an ambiguous retry.

What makes a frozen set safely revisable is a second durable barrier:
`PersistentNotificationRuntimeOptions.checkpointDeliveryAttempt`, awaited on the
allow path of live delivery authority immediately before every external POST.
Wire `createPostgresReportingNotificationAttemptCheckpoint()` into it. It is a
runtime-level option keyed on the durable attempt context rather than a
per-emission closure because an emission snapshot cannot carry a function, so a
per-emission barrier would be skipped by the recovered outbox path — the path
where an ambiguous send is most likely.

The hook is runtime-wide, so the reporting checkpoint passes any event type it
does not own straight through. Failing closed on another subsystem's
notification would suppress every one of its attempts until the retry horizon
expired. `eventTypes` **extends** the owned set and can never shrink it —
`reporting.status_changed` is always owned, because a configuration that
silently stopped checkpointing reporting deliveries while the runtime still
advertised checkpoint support is the precise bug the checkpoint exists to
prevent.

Construction and `probe()` both fail closed unless the notification port proves
it runs the checkpoint. A custom `{ emit }` port must set
`hasDeliveryAttemptCheckpoint: true`, asserting that it forwards the event it is
handed to a runtime that does; otherwise a crash plus a destination replacement
re-addresses the notification under a second generation and idempotency key.
`acknowledgeMissingAttemptCheckpoint` exists only for tests that deliberately
demonstrate that hazard.

Declaring the capability is not sufficient, and is not trusted. Freeze and
checkpoint are one contract: a port that declares support but never calls
`freezeRecipients` leaves nothing addressable, so the checkpoint has no row to
mark and settlement would see zero outstanding recipients and record the
notification as delivered although nothing was sent. The runtime verifies that
the freeze actually ran and refuses to project the emission otherwise.

The checkpoint and a concurrent recipient replacement run as separate statements
against a pool, so neither sees the other's uncommitted work: a freeze can
propose a replacement generation while the original is being checkpointed, and
PostgreSQL keeps both rows. A partial unique index on
`(namespace, transition_id, subscriber_key) WHERE attempt_at IS NOT NULL` is the
arbiter — the second generation's checkpoint fails, so it is never POSTed, and
the next freeze drops it because its subscriber is already claimed.

Revisability is tracked **per recipient**, in `<activity_table>_recipients`:

- A recipient with no `attempt_at` provably never received a POST, because
  suppression fails closed before the checkpoint. It is replaced in place when
  it goes stale, which closes the window where a destination is replaced between
  candidate enumeration and the first POST.
- A recipient with `attempt_at` is pinned. Pinning is keyed on the **subscriber**,
  not the destination generation: once a subscriber has been addressed, a later
  generation of that subscriber is never addressed for this notification,
  because that would be one logical delivery under two idempotency keys.
- One recipient's attempt never pins a sibling. In a fanout, a subscriber
  suppressed stale before its own first POST is still re-resolved while an
  already-addressed sibling stays pinned.
- Unattempted rows are replaced rather than superseded, so a claim that retries
  many times before any send cannot accumulate rows. A settled recipient is left
  out of later emissions — it still gates projection, but re-addressing it would
  be redundant traffic.
- Settled history is compacted to one row per subscriber, and `maxRecipients`
  bounds **every retained row**. Counting only the addressable recipients let
  terminal rows grow for the lifetime of a claim that kept retrying while fresh
  subscribers settled.
- The bound and the replacement are one statement, and the rows it measures are
  taken `FOR UPDATE`. Measuring separately let a concurrent checkpoint turn a
  revisable row into a pinned one after the budget approved the write: the
  `DELETE` then re-checked the locked row, skipped it, and the retained set
  landed above the bound. Compaction runs before the budget, so a bound that
  compaction can satisfy never refuses, and a refusal mutates nothing — raise
  `maxRecipients` and the claim self-heals on its next pass.

| Replacement lands | Outcome |
| --- | --- |
| Before candidate enumeration | New generation enumerated and delivered |
| Between enumeration and the first POST | Suppressed `subscription_stale`, claim released, next pass replaces that recipient with the new generation; the superseded one gets nothing |
| After that recipient was checkpointed | Never re-addressed; the pinned recipient settles terminally |
| Revoked entirely | Empty recipient set is committed and the activity settles undelivered |

### Suppression is not delivery, and delivery is not settlement

Live delivery authority fails closed before every POST. Use
`notificationSuppressionDisposition(reason)` to tell the two kinds apart:

- **terminal** — `subscription_missing`, `subscription_inactive`,
  `event_not_allowed`, `authorization_denied`. The subscriber must not receive
  this event.
- **retryable** — `authorization_error`, `credential_unavailable`,
  `subscription_stale`, `attempt_checkpoint_unavailable`. Authority could not be
  established: a store read failed, an authorization or credential callback threw
  or timed out, the generation moved mid-flight, or the durable checkpoint could
  not be written. Nothing was sent (`attempts: 0`).

`subscription_stale` is the one reason whose disposition depends on the caller.
A live emission can re-resolve the new generation, so it stays retryable. A
**recovered** attempt (`WebhookEmitAttempt.recovered`) is pinned to the snapshot
it was taken from and can never become valid for a replaced generation, so it is
terminal — otherwise the outbox reclaims a dead delivery until its horizon
expires.

A delivery that throws is classified too: a retired binding or an exhausted
retry horizon surfaces as `failure.reason: 'delivery_binding_retired'` with
`terminal: true` and settles under terminal policy. Flattening it into a
retryable failure left the activity pending forever and eventually exhausted the
tenant's pending capacity.

A retryable suppression no longer terminalizes the delivery in the webhook
outbox either — it releases it, exactly as a retryable exhausted HTTP result
does, so the only durable record of the send survives for the outbox worker.

Projection requires **every** stored recipient to have reached a terminal
disposition: delivered, or deliberately not delivered. An outcome that never
reached a subscriber — a retryable suppression, a transport error, an exhausted
but retryable HTTP result — leaves the claim unsettled and the activity is not
recorded as delivered. The bundled runtime raises
`ReportingNotificationRetryableSuppressionError` for a retryable suppression.
Custom notification runtimes must implement the same barriers and the same
classification.

Intent is stored relationally, one row per recipient, keyed by a bounded 64-hex
fingerprint; only that fingerprint is indexed, so an individual recipient
reference has no length limit. `maxRecipients` defaults to 10,000 — the ceiling
the notification runtime enforces on `maxFanoutCandidates`.

Custom ledger stores implement
`ReportingLedgerNotificationActivityPortV1<TTransaction>` over their existing
authority transaction. Their `applyLifecycleProjection` equivalent must call
`recordTransition({ transition, obligation }, tx)` after its compare/lock and
before commit, and must roll back the authoritative transition if the port
fails. In the same transaction they must stamp `notifiedAt` as the durable
handoff marker. Stores must also compare `expectedPreviousFinality` with the
latest stored transition before applying a finality-only projection; this field
is optional only so pre-v14 implementations continue to compile during
migration.

That comparison must read **one** committed baseline, never a freshly
recomputed one. Transitions written from SDK 14 onward carry their own
`finality`, so the baseline is read straight back off the row. Pre-v14 rows
carry none, and their baseline is **not** reconstructed — it resolves to `none`,
which the store persists via
`resolveTransitionFinalityBaseline(reporting_obligation_id)` under its account
lock. `reconcileReportingStatusLifecycleV1` calls that port before deciding the
transition, and stores that omit it must also ignore `expectedPreviousFinality`,
in which case the lifecycle assumes `none` itself.

Do not try to reconstruct a historical baseline. Nothing already stored proves
which revisions had committed when a pre-v14 transition was recorded:

- **Payload timestamps** (a revision's `createdAt` against the transition's
  `occurredAt`) rank creation instants, not commits. A revision constructed
  before the transition but committed after it counts as already observed.
- **Insert wall clocks** (`recorded_at`, `created_at`, anything derived from
  `clock_timestamp()`) can repeat within a microsecond and can step backward, so
  a revision that committed after the transition can still compare equal or
  earlier. Comparing one against the transition's application-clock `occurredAt`
  additionally mixes clocks, so the store and the lifecycle decision disagree
  under skew and the compare-and-set wedges permanently.

Either rule can conclude `official`, which makes `previousFinality` equal
`finality` and silently suppresses the real snapshot→official transition and its
activity record forever. Resolving to `none` instead records at most one
redundant finality-only transition per obligation at upgrade, which stays
internal activity because the AdCP status webhook is health-only.

That bound holds only while no pre-v14 writer is still appending. During a
rolling deploy an old pod keeps writing finality-less transitions; each becomes
the latest row, gets its baseline committed as `none`, and produces another
redundant finality-only transition. Deploy ordering and wall clocks cannot rule
that out, so make it enforceable in the database.
`REPORTING_LEDGER_FINALITY_WRITER_FENCE_MIGRATION` adds

```sql
CHECK (data ? 'finality') NOT VALID
```

to `adcp_reporting_transitions`. `NOT VALID` is the whole point: PostgreSQL
enforces the constraint for every INSERT and UPDATE while leaving historical
rows unvalidated, so existing finality-less rows keep working and new
legacy-shaped writes are rejected. Two consequences to plan for:

- **Run it last**, after legacy pending transitions are drained and no old pod
  remains. A surviving legacy writer will fail its appends with
  `rejected by the finality writer fence`. That is deliberate — a loud rejection
  beats a quietly unbounded event stream.
- **Any UPDATE must leave the row fence-clean.** The baseline resolver and
  `markTransitionNotified` both write `finality` as part of their update, so a
  historical row is repaired by the same statement that touches it.

A store that implements neither the baseline port nor the optional `finality`
fields is treated as unable to observe finality at all: the baseline becomes the
currently observed finality, so the comparison is a no-op and no finality-only
transition is ever written. Without that, every reconciliation tick would see
`none -> official` and append another one forever. Such a store behaves exactly
as it did before finality existed — health transitions still fire.

Custom stores carry the same obligation: after cutover, reject any transition
write that does not record an observed finality, and enforce it in the storage
engine rather than in application code — an application-level check does not
bind a pod running last release's binary. Repair a historical row in the same
statement that mutates it.

The transaction argument must be one BEGIN/COMMIT-bound connection, never a
pool or autocommit queryable; the per-tenant advisory transaction lock provides
capacity serialization under READ COMMITTED. Never call the port in a
post-commit subscriber callback. The bundled
PostgreSQL activity runtime accepts only the active queryable transaction and
can therefore be reused by a custom PostgreSQL ledger without adopting the SDK
ledger tables.

The transactional port and legacy `ReportingLedgerSubscriberV1` callbacks are
mutually exclusive. The bundled store exposes that mode to lifecycle
reconciliation and fails closed if both are supplied, preventing double fire;
the port's pending rows, rather than `listPendingTransitions()`, own retry.

The activity table is deliberately separate from Core revision and obligation
rows. Managed Delivery/Reconciled Billing work in #2944 can add immutable
materialization and receipt tables without changing this transition identity,
queue schema, or migration ordering.

`planObligations()` creates at most 1,000 obligations per call by default. Use its `account_id` and `maxObligations` options from a resumable scheduler when catching up dense or old schedules. Source executions are bounded to 10,000 objects, 1,000,000 rows, and 64 MiB per revision.

When `get_reporting_status` omits a period, the operational default horizon is the 24 hours ending at `ledger_as_of`. The `health` and `finality` arrays filter periods-view output only; they do not rewrite summary health or the underlying obligation projection.

`projectReportingObligationHealthV1` is the pure five-state projection. Before `expectedAt`, missing evidence is `waiting`; during recovery it is `delayed`; after the recovery deadline it is `action_required`; readable qualifying evidence is `healthy` for an open scope and `complete` for a closed scope. An unfiltered closed scope with no caller-owned configurations or no due periods is vacuously `complete`; an explicitly unknown configuration returns `lookup_unavailable`, and a snapshot with missing elapsed obligations fails closed. The simplified lifecycle persists deterministic issues and lifecycle transitions. In legacy mode it then calls only subscribers already authorized and supplied by the host; with the transactional port, finality-only changes stay in internal activity and health changes flow through the durable AdCP notification runtime.

## Consumer status ingest

The SDK is pinned to AdCP 3.2.0-rc.3 and exposes `sync_reporting_status` from the ledger subpath. Its request, response, consumer-status, obligation, issue, delivery-capabilities, and reporting-status types come from the published rc.3 schema bundle.

```ts
const syncReportingStatus = createSyncReportingStatusHandler(store, {
  // Derive this only from authenticated transport; it is never a payload field.
  resolveConsumerId: context => context.agent.agent_url,
});

const getReportingStatus = createReportingStatusHandler(store, {
  resolveConsumerId: context => context.agent.agent_url,
});
```

Existing authoritative ledgers only need the narrow
`ReportingConsumerStatusLedgerStore` port—not the producer/worker store. An
adapter supplies `listConfigurations`, `getObligation`,
`getRevisionMetadata`, `readSnapshotPage`, `getConsumerStatusBatchReplay`, and
`syncConsumerStatusBatch`. Keep the adapter over the existing authority store:
derive the internal account and durable consumer principal from authenticated
transport, authorize before every replay or read, return immutable revision
bindings, and implement current-leaf compare + append + original batch-result
replay in one transaction. Several authorized principals for one external
account must receive separate `(internal account, consumer principal)` chain
namespaces; never create a second authority store or trust either identity from
the request body.

```ts
const statusStore: ReportingConsumerStatusLedgerStore = {
  listConfigurations: accountId => existingLedger.configurations(accountId),
  getObligation: (id, accountId) => existingLedger.obligationForAuthorizedCaller(id, accountId),
  getRevisionMetadata: (id, accountId) => existingLedger.boundRevision(id, accountId),
  readSnapshotPage: (id, accountId, cursor, limit) =>
    existingLedger.authorizedSnapshotPage(id, accountId, cursor, limit),
  getConsumerStatusBatchReplay: input => existingLedger.statusBatchReplay(input),
  syncConsumerStatusBatch: input => existingLedger.compareAppendAndReplayStatusBatch(input),
};
```

Use `reportingConsumerStatusChainKeyV1`,
`reportingConsumerStatusChainKeyFromIdentityV1`,
`reportingConsumerStatusFingerprintV1`, and
`normalizeReportingConsumerStatusIdsV1` from `@adcp/sdk/reporting/ledger` when
implementing duplicate, exact-leaf, unchanged, and replay behavior. This keeps
equivalent RFC 3339 spellings in one logical chain. `readSnapshotPage` is
optional; omitting it makes seller snapshot provenance unavailable without
blocking statuses that do not claim snapshot provenance. Store failure results
use `retryAfterSeconds` (integer seconds from 1 through 3600); invalid hints and
oversized custom codes are omitted or replaced before reaching the wire.

`sync_reporting_status` is a partial-success batch. The server validates the
closed request envelope, then the handler validates every status independently.
Custom handlers should parse each item with the exported
`ReportingConsumerStatusV1Schema` from `@adcp/sdk/reporting/ledger`; the ledger
handler already does this. The framework always applies strict envelope
validation for this task—even when general request validation is `warn` or
`off`—and rejects requests above 8 MiB, 10,000 JSON nodes, or the SDK maximum
JSON depth before dispatching either the built-in or a custom handler. Results
map one-for-one to submitted statuses in request order; inspect each `result`
even when the response envelope is `completed`. Custom handlers must also
reject every duplicate ID and every entry in a duplicate logical status chain.
`recorded_at` is seller-authored and response-only.

Clock-skew, ineligible-period, and too-early missing-status failures identify
the caller-controlled field. Obligation, revision, and snapshot mismatches are
intentionally indistinguishable so consumer status ingest cannot become an
existence oracle across retained ledger objects.

Per-item failures carry an explicit recovery classification. Schema and
authorization failures are `correctable`; an exhausted transient read slot is
`RATE_LIMITED`/`transient` with `retry_after`; oversized durable statements are
`REPORTING_STATUS_TOO_LARGE`/`correctable`; and exhausted append-only store
capacity is `REPORTING_STATUS_CAPACITY_EXHAUSTED`/`terminal`. The last two are
open-vocabulary AdCP extension codes, so clients must use their accompanying
`recovery` value rather than a closed code switch.

The language-neutral acceptance vectors ship at
`@adcp/sdk/compliance-fixtures/reporting-consumer-status-v1.json`. They pin
exact request bytes and SHA-256 digests, frozen clocks and principals, ordered
results, and post-operation ledger state so non-TypeScript adapters can run the
same contract without installing the SDK ledger as a second authority store.

The PostgreSQL store compares the exact current leaf for each consumer/configuration/report-definition/period chain in the same transaction that appends the new statement. An exact batch replay returns its original results; an identical status ID already recorded through another batch returns `unchanged`. Stale or omitted supersession fails without forking the chain. Periods readback includes only the authenticated consumer's history. A negative current statement—or a received statement naming a revision superseded by a later seller restatement—adds `CONSUMER_STATUS_MISMATCH` to that consumer's projection without changing seller-authored ledger evidence.

### rc.3 consumer-status hardening

`content_mismatch` is the fifth consumer status: the buyer consumed the exact
revision the seller requires and it contradicts a fact the accepted
configuration generation already fixed. It carries a required closed
`mismatch_code` (`scope_media_buy_missing`, `coverage_short`, `metric_missing`,
`schema_nonconformant`, `currency_mismatch`, `period_mismatch`) plus the
obligation id, the revision id, and the recomputed
`observed_revision_content_sha256`, so the disagreement names the exact bytes
that were read. It is **not** a measurement dispute — a buyer must not use it to
argue about how many impressions the seller counted; that is
`measurement_terms` / `makegood_policy` territory.

Not every conflict is an immediate escalation. A `received` statement made stale
*only* by a seller restatement projects the caller-scoped view as `delayed`
until a bounded re-read grace deadline, then `action_required`. The buyer read
exactly what the seller then required, so it gets one bounded chance to re-read
before the disagreement escalates. The deadline is the `created_at` of the
**first** revision that superseded the one the buyer named, plus the generation's
`schedule.delivery_sla` — or `automated_recovery_window_seconds` when that SLA is
zero, so a zero-SLA feed still yields a bounded window. Later restatements
supersede later revisions and therefore cannot restart it; a seller cannot hold
an unresolved mismatch below `action_required` by restating on a timer. Every
other conflict kind is `action_required` immediately.

`projectReportingConsumerStatusMismatchV1` is that projection as a pure
function, exported so a custom store can reuse the exact logic the built-in
handler runs. It returns the issue, the caller-scoped health it forces, and the
grace deadline when one applies.

Issues now carry `opened_at`, which is fixed at first emission and carried
unchanged across every re-emission — including across the `delayed` →
`action_required` transition, which reuses the same `issue_id` so consumers age
one work item instead of two. The SDK derives it from immutable ledger facts
(the first superseding revision's `created_at` for a stale read, the statement's
`recorded_at` otherwise) rather than from the read time, because advancing it on
re-emission would reset the escalation clock on every poll. Optional
`issue_state` (`open` / `acknowledged` only — a retired issue leaves the
projection instead of being published at `resolved` / `waived`) and
`external_ref` (inert correlation text, never dereferenced, never shared across
callers on a caller-scoped issue) round out the lifecycle.

Pass `consumerMismatchEscalation` to `createReportingStatusHandler` when the
capability document advertises `consumer_mismatch_escalation_seconds` and
`operations_contact` — the schema requires both or neither, so the escalation
always has a destination:

```ts
const getReportingStatus = createReportingStatusHandler(store, {
  resolveConsumerId: context => context.agent.agent_url,
  consumerMismatchEscalation: {
    escalationSeconds: 86_400,
    operationsContact: { email: 'reporting-ops@seller.example' },
  },
});
```

Advertise the same commitment in the capability document from that one value,
so the reads and the document cannot drift:

```ts
const escalation = {
  escalationSeconds: 86_400,
  operationsContact: { email: 'reporting-ops@seller.example' },
};

const reportingDelivery = {
  reliable_reporting_version: '1.0',
  consumer_status_task: 'sync_reporting_status',
  ...reportingConsumerStatusCapabilityV1(escalation), // consumer_mismatch_escalation_seconds + operations_contact
};

const getReportingStatus = createReportingStatusHandler(store, {
  resolveConsumerId,
  consumerMismatchEscalation: escalation,
});
```

Both entry points run the same validation, so a window with no destination — or
a `NaN` / negative one — fails at wiring time rather than silently never firing.
If you also apply the `health` query filter in a custom store, pass
`consumerMismatchEscalation` there too; the bundled `PostgresReportingLedgerStore`
takes it as a constructor option for exactly that reason.

Past `opened_at` plus that window an open mismatch is emitted at
`action_required` with a `contact_*` action naming the diagnosed responsible
party. `wait_for_retry` and `repair_access` are automation hints and neither
survives the boundary. The escalation boundary takes precedence over the
stale-received grace window when the two overlap. `operations_contact` is inert
display metadata for a human operator: agents surface it and MUST NOT fetch the
URL, send protocol traffic to it, or treat either value as a credential.

The summary view gains `obligation_counts.consumer_status_pending` whenever a
consumer principal is resolved (which is exactly when this handler advertises
`consumer_status_task`). It counts obligations whose consumer-status deadline —
`expected_at` plus `automated_recovery_window_seconds` — has passed with an
*empty* status chain for the authenticated caller. A chain with any unsuperseded
leaf counts as current whatever that leaf says. It is a visibility count over
the caller's own silence and never a health input: it does not change health,
any other count, or advertised reliability statistics, and it overlaps the
health counts rather than partitioning them.

Finally, `authoritative_party: 'consumer'` on a delivery configuration is
reserved for a buyer-deposited billing revision task that no released AdCP
version defines. `assertSupportedReportingAuthoritativeParty` refuses it with
`UNSUPPORTED_FEATURE`; call it from your `sync_accounts` handler on each
requested configuration, before the generation becomes ready and before any
obligation exists. `installConfiguration` already applies it. Do not coerce the
value to `seller` — that silently installs a different contract than the buyer
asked for.

Core revisions intentionally omit feed purpose, destination, obligation, and
recipient identity. Obligations sharing the same account, report definition,
period, media-buy scope, and canonical content therefore reuse one revision,
including fan-out across direct-Core and managed-materialization consumers.

For account-local calendar periods, expand each boundary externally into an
immutable configuration generation. Do not model a local day as a constant
86,400,000 ms across daylight-saving changes. For example, the New York daily
periods `2026-03-08T05:00:00Z` → `2026-03-09T04:00:00Z` and
`2026-11-01T04:00:00Z` → `2026-11-02T05:00:00Z` use 82,800,000 and 90,000,000
milliseconds respectively. Give each generated boundary its own delivery
configuration version, set `anchor` and `installedAt` to the exact start,
`supersededAt` to the exact end, and set `periodMilliseconds` to `end - start`.
The repository-only fixture at
`test/fixtures/reporting-reconciliation/consumer-status.json` contains those
23/25-hour cases,
a calendar-month boundary, and the obligation-missing path with no invented
obligation ID.
