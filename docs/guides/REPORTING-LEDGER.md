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

`planObligations()` creates at most 1,000 obligations per call by default. Use its `account_id` and `maxObligations` options from a resumable scheduler when catching up dense or old schedules. Source executions are bounded to 10,000 objects, 1,000,000 rows, and 64 MiB per revision.

When `get_reporting_status` omits a period, the operational default horizon is the 24 hours ending at `ledger_as_of`. The `health` and `finality` arrays filter periods-view output only; they do not rewrite summary health or the underlying obligation projection.

`projectReportingObligationHealthV1` is the pure five-state projection. Before `expectedAt`, missing evidence is `waiting`; during recovery it is `delayed`; after the recovery deadline it is `action_required`; readable qualifying evidence is `healthy` for an open scope and `complete` for a closed scope. An unfiltered closed scope with no caller-owned configurations or no due periods is vacuously `complete`; an explicitly unknown configuration returns `lookup_unavailable`, and a snapshot with missing elapsed obligations fails closed. The simplified lifecycle persists deterministic issues and `reporting.status_changed` transitions, then calls only subscribers already authorized and supplied by the host.

## Consumer status ingest

The SDK is pinned to AdCP 3.2.0-rc.2 and exposes `sync_reporting_status` from the ledger subpath. Its request, response, consumer-status, obligation, issue, delivery-capabilities, and reporting-status types come from the published rc.2 schema bundle.

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
