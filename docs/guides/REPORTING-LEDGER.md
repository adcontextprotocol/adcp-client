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

## Managed Delivery and Reconciled Billing

Core remains the default and has no destination, external-resource, or receipt dependency. To opt into the higher tiers, apply `REPORTING_MANAGED_DELIVERY_MIGRATION` **after** `REPORTING_LEDGER_MIGRATION`, explicitly construct the Core store with `managedDelivery: true`, create a `PostgresReportingManagedDeliveryStore`, and pass both stores with a destination adapter to `createReportingManagedDeliveryRuntime`. The async factory proves the stores share one authority and validates the RC3 tier wiring before returning it. It advertises `managed_delivery` only when an immutable binding, delivery, bounded resource reading, generation-fenced revocation, and at least one verification profile are installed. The advertised automated recovery window must equal every installed managed Core configuration's recovery window. It advertises `reconciled_billing` and `receipt_task` only when an authenticated consumer resolver and canonical-digest verification are also installed.

```ts
import {
  PostgresReportingLedgerStore,
  PostgresReportingManagedDeliveryStore,
  REPORTING_MANAGED_DELIVERY_MIGRATION,
  createReportingManagedDeliveryRuntime,
  reportingManagedDeliveryBindingV1,
} from '@adcp/sdk/reporting/ledger';

await pool.query(REPORTING_MANAGED_DELIVERY_MIGRATION);
const managedStore = new PostgresReportingManagedDeliveryStore(pool);
const managedCoreStore = new PostgresReportingLedgerStore(pool, {
  acknowledgeIsolatedDatabase: true,
  managedDelivery: true,
});
await managedStore.authorizeDestination({
  account_id: internalAccountId,
  destination_ref: destinationRef,
  generation: 1,
  authorized_at: new Date().toISOString(),
});
await managedStore.installBinding(
  reportingManagedDeliveryBindingV1({
    // Binds the Core configuration generation installed above. That
    // configuration's `schedule.recoveryWindowMilliseconds` is 3_600_000, which
    // is what `automatedRecoveryWindowSeconds: 3600` below has to equal.
    ...bindingForInstalledCoreConfiguration,
    account_id: internalAccountId,
    destination_ref: destinationRef,
    authorization_generation: 1,
  })
);

type SellerContext = { account?: unknown; agent: { agent_url: string } };
const managed = await createReportingManagedDeliveryRuntime<SellerContext>({
  coreStore: managedCoreStore,
  store: managedStore,
  adapter: destinationAdapter,
  offerings: reportingDeliveryOfferings,
  resolveConsumerId: context => context.agent.agent_url,
  // MUST equal every installed managed binding's Core
  // `schedule.recoveryWindowMilliseconds` / 1000 — see the precondition note below.
  automatedRecoveryWindowSeconds: 3600,
  statusRetentionDays: 90,
  resourceRetentionDays: 30,
  authorizationRevocationSeconds: 60,
});

// Supply these to the matching server slots/capability document.
const { getReportingStatus, getMediaBuyDelivery, syncReportingReceipts } = managed;
const reportingDelivery = managed.reportingDeliveryCapabilities;

// Run from a durable scheduler; replicas safely share SKIP LOCKED leases.
await managed.runWorker({ maxIterations: 100 });
```

`automated_recovery_window_seconds` is published once per agent, in one capability document, while Core `schedule.recoveryWindowMilliseconds` is per configuration. The advertised value is a **maximum** — the longest a due obligation may stay `delayed` while automated recovery continues before it becomes `action_required` — so one agent-wide number is truthful exactly when it is at least every installed window. `createReportingManagedDeliveryRuntime` enforces that bound and nothing more: advertising less than the widest installed window is refused with the offending value named, advertising more is conservative and allowed, sub-second Core windows are rounded up to the whole second the capability is expressed in, and a deployment with no managed binding — a fresh install, or one that has just offboarded its last managed tenant — starts normally. Heterogeneous tenants behind one agent therefore need no separate endpoint per cohort: advertise the widest window they run.

Authorize a destination generation and install its immutable binding before creating any obligation for that Core configuration. Once an obligation is observable, only an exact idempotent replay of the existing binding is accepted, so the managed tier cannot appear outside the Core changes checkpoint. Build the binding with `reportingManagedDeliveryBindingV1`, which binds the exact internal account, Core configuration generation, destination authorization generation, feed purpose, method, verification profile, reconciliation mode, and resource-retention promise. Revocation commits the durable deny first, fails queued work, and makes resource reads and receipt submission fail closed; provider-side grant cleanup is a separately leased worker action. Reauthorization uses a strictly greater generation and a new Core configuration generation. It never re-enables an old binding.

The worker claims and commits through short PostgreSQL transactions but performs destination I/O outside them. Pass `authorizationRevocationSeconds` to `runWorker()` — `createReportingManagedDeliveryRuntime` does it for you from the advertised capability — so the promise is enforced rather than merely published: a cleanup attempt is clipped so it cannot run past `revoked_at` plus the window, a failed attempt's retry lease never outlasts the window, and a grant that has already outlived it is returned as `revocationsOverdue` for alarming. Delivery, revocation, and resource reads have hard SDK deadlines even when an adapter ignores cancellation; resource descriptors are limited to 1 MiB and resource bodies to 64 MiB by default. Adapters must advertise `revocationFencesDeliveryGenerations: true`, make the logical `(configuration generation, revision, destination generation)` write idempotent, and install a provider-side generation tombstone before `revoke()` returns. Every delivery must be keyed by that generation and refuse a tombstoned generation, including a late provider write that completes after the SDK timed out. A successful commit requires the lease generation and unexpired lease, current authorization, exact Core row count and control totals, all evidence required by the selected verification profile, the official canonical digest when required, an immutable native version reference when applicable, and an `expires_at` satisfying the configured retention window.

`sync_reporting_receipts` derives both account and consumer from authenticated context. RC3 caps `receipts` and `adjustment_receipts` at 100 each in JSON Schema, and bounds the batch as a whole in the request's `x-adcp-validation.batch_identity`: receipt IDs must be unique across both arrays, "whose combined length MUST NOT exceed 100". That annotation is normative prose rather than machine-checked on this path — `x-adcp-validation` is registered as an AJV keyword for commercial terms only — so the handler enforces the combined bound itself. A request that satisfies both per-array caps but exceeds 100 combined is therefore spec-invalid — and unanswerable regardless, since `results` is capped at 100 while one result per submitted receipt is required — so it is refused with a `VALIDATION_ERROR` envelope rather than an over-long `results` array. Its PostgreSQL implementation serializes each caller namespace, records a compact per-entry verdict for idempotency replay — receipt bodies are rehydrated from the append-only receipt table rather than duplicated — and retains those replay rows for 30 days so a consumer at the per-consumer batch cap is throttled instead of permanently locked out. An exact same-key replay is side-effect free and returns the caller its own recorded verdict even after the destination authorization is revoked: revocation governs what may be newly *accepted*, not what an already-answered idempotency key answers, and the body is the caller's own receipt echoed back, so no other consumer's state is read. Submitting new evidence while revoked is still refused. It exposes append-only histories only to that consumer. Revision receipts must name the exact obligation, successful materialization, current authorization, and verification evidence, and a revision whose finality satisfies the obligation's own `required_finality`, so a snapshot-finality contract reconciles on the same terms an official one does. `billing` feeds are not such a contract: RC3 requires `required_finality: official` for them unconditionally, and `installConfiguration` now refuses the combination, so a terminal accepted billing receipt can never land against a provisional revision. Accepted leaves are terminal; a rejected leaf may be repaired only by an exact `supersedes_reporting_receipt_id`. Later source corrections remain Core adjustments and receive separate append-only adjustment receipts—neither official revisions nor earlier receipts are rewritten. Lookup failures intentionally share one generic error so the task cannot probe another account's retained objects.

The lifecycle compare-and-set covers managed state as well as Core evidence. The projection reads managed rows in their own transaction, so `getManagedLifecycleProjection` returns a `managedStateVersion` token over the obligation's materializations, receipts (including current-leaf flips), adjustments and destination-authorization state; `applyLifecycleProjection` re-reads it inside the apply transaction and refuses a stale apply. Without it a revocation, receipt or settled materialization arriving between projection and apply would be overwritten by a health computed before it existed — most visibly as a `complete` persisted and webhooked over a receipt that had just arrived. A refused apply is recomputed and retried immediately, bounded, rather than waiting for a deadline sweep that a managed-only change may never schedule.

`MAX_MATERIALIZATIONS_PER_ACCOUNT` and `MAX_RECEIPTS_PER_CONSUMER` are lifetime counts by default. Because managed evidence is immutable, a long-lived account eventually reaches them and then stops planning materializations and refuses every receipt with no way back. Construct the store with `new PostgresReportingManagedDeliveryStore(pool, { evidenceRetentionDays })` to make the caps active-scope: only evidence recorded inside that window counts against them, and `pruneExpiredEvidence({ account_id, limit })` deletes what has fallen outside it — never anything still inside the window, never a `pending` or leased materialization, and never a receipt batch inside its own replay retention. Set it at least as long as the `status_retention_days` you advertise, and run the prune from the same scheduler that runs the worker.

The managed tables are additive and do not alter the Core tables. This is the schema boundary coordinated with #2943: that work owns transactional reporting notification/activity intent and the existing webhook delivery/credential plane. Managed Delivery does not create a second webhook sender, outbox, credential store, or subscriber model. Apply both feature migrations after the Core migration in either order; each owns separate tables and both reuse the Core authority.

`planObligations()` creates at most 1,000 obligations per call by default. Use its `account_id` and `maxObligations` options from a resumable scheduler when catching up dense or old schedules. Source executions are bounded to 10,000 objects, 1,000,000 rows, and 64 MiB per revision.

When `get_reporting_status` omits a period, the operational default horizon is the 24 hours ending at `ledger_as_of`. The `health` and `finality` arrays filter periods-view output only; they do not rewrite summary health or the underlying obligation projection.

`projectReportingObligationHealthV1` is the pure five-state projection. Before `expectedAt`, missing evidence is `waiting`; during recovery it is `delayed`; after the recovery deadline it is `action_required`; readable qualifying evidence is `healthy` for an open scope and `complete` for a closed scope. An unfiltered closed scope with no caller-owned configurations or no due periods is vacuously `complete`; an explicitly unknown configuration returns `lookup_unavailable`, and a snapshot with missing elapsed obligations fails closed. The simplified lifecycle persists deterministic issues and `reporting.status_changed` transitions, then calls only subscribers already authorized and supplied by the host. When the store implements the optional `getManagedLifecycleProjection`, the reconciler folds Managed Delivery through the same projection the read path uses, so a persisted transition and its webhook report the health a read of that obligation would return instead of Core health alone. Reads are scoped to one authenticated consumer while a transition is account-level, so the reconciler keeps the most severe consumer: the seller's obligation is not reconciled until every consumer that owes a receipt has accepted. Consumer-specific issue codes — `RECEIPT_REQUIRED`, `RECEIPT_REJECTED`, `ADJUSTMENT_RECEIPT_REQUIRED`, `ADJUSTMENT_RECEIPT_REJECTED` — are deliberately excluded from that persisted set and from transition `issueIds`, because the issue store is keyed by obligation with no consumer dimension and reads republish persisted issues to whichever consumer is asking; publishing them would hand one consumer another's rejection state and exact receipt ingest timing. Their severity still reaches the account-level `health`, and each caller's own issues are recomputed per read. Aggregation runs over `obligatedConsumerIds`, not over whoever happens to have submitted, so a silent authorized consumer cannot vanish when another accepts. The managed tables carry no consumer dimension on destination authorizations or bindings, so the built-in PostgreSQL store cannot prove the roster is complete and reports `obligatedConsumerRosterComplete: false`; while that is false the reconciler keeps one zero-receipt consumer in the fold and never reports a `consumer_receipt` obligation reconciled. Supply the roster from your own authorization layer through the store's `obligatedConsumers` option — `(input: { reporting_obligation_id, account_id }) => Promise<{ ids, complete }>` — and return `complete: true` to get accurate reconciled transitions. Because the conservative default holds a `consumer_receipt` obligation at `action_required` from first delivery, and the per-consumer receipt issues are deliberately not persisted, the reconciler restates that state once per obligation as a `RECEIPT_REQUIRED` issue anchored to the obligation's own `expected_at`. It names no principal and carries no receipt timing, so a degraded persisted health is never unexplained and the leak stays closed.

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
