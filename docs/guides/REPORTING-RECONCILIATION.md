# Reporting reconciliation

## Core-only health reconciliation

Use `reconcileReportingCoreV1` when the seller advertises the required Core
tier without managed delivery or reconciled billing. It is a synchronous pure
function: pass the obligations and revisions returned by
`get_reporting_status`, the response's scope closure facts, and the recovery
window recorded from reporting capabilities. It derives `waiting`, `healthy`,
`delayed`, `action_required`, or `complete` without a destination, manifest,
canonicalization contract, resource reader, materialization, or receipt.

```ts
import {
  reconcileReportingCoreV1,
  type CoreReportingObligationV1,
  type CoreReportingRevisionV1,
} from '@adcp/sdk';

const obligations: CoreReportingObligationV1[] = [];
const revisions: CoreReportingRevisionV1[] = [];
const seenCursors = new Set<string>();
let cursor: string | undefined;
let status;
let snapshotId: string | undefined;
let ledgerAsOf: string | undefined;
let pageCount = 0;
do {
  if (++pageCount > 1_000) throw new Error('Seller reporting history exceeds the buyer page budget');
  status = await seller.getReportingStatus({
    account: { account_id: 'account-1' },
    view: 'periods',
    ...(cursor ? { pagination: { cursor } } : {}),
  });
  if (!status.ledger_snapshot_id || !status.ledger_as_of) {
    throw new Error('Seller omitted reporting snapshot identity');
  }
  if (
    (snapshotId && status.ledger_snapshot_id !== snapshotId) ||
    (ledgerAsOf && status.ledger_as_of !== ledgerAsOf)
  ) {
    throw new Error('Seller reporting snapshot changed during pagination');
  }
  snapshotId ??= status.ledger_snapshot_id;
  ledgerAsOf ??= status.ledger_as_of;
  obligations.push(...(status.periods ?? []));
  revisions.push(...(status.revisions ?? []));
  if (obligations.length + revisions.length > 100_000) {
    throw new Error('Seller reporting history exceeds the buyer record budget');
  }
  if (!status.pagination) throw new Error('Seller omitted reporting pagination');
  if (status.pagination.has_more && !status.pagination.cursor) {
    throw new Error('Seller reporting cursor did not advance');
  }
  cursor = status.pagination.has_more ? status.pagination.cursor : undefined;
  if (cursor && seenCursors.has(cursor)) throw new Error('Seller reporting cursor repeated');
  if (cursor) seenCursors.add(cursor);
} while (cursor);

const reportingDelivery = capabilities.media_buy?.reporting_delivery;
if (
  !status?.scope ||
  !ledgerAsOf ||
  !reportingDelivery ||
  typeof reportingDelivery.automated_recovery_window_seconds !== 'number'
) {
  throw new Error('Seller omitted required reporting Core facts');
}

const result = reconcileReportingCoreV1({
  obligations,
  revisions,
  scope: {
    closed: status.scope.scope_closed,
    coverageComplete: status.scope.coverage_complete,
    recordsComplete: true,
  },
  clocks: {
    ledgerAsOf,
    automatedRecoveryWindowSeconds:
      reportingDelivery.automated_recovery_window_seconds,
  },
});
```

Core revisions join to obligations by their protocol logical-slice identity:
account, report definition, reporting profile, media-buy denominator, and
period. A qualifying revision with `row_count: 0` satisfies its obligation;
zero rows is explicit reporting, while no revision is a missing report.

`scope.coverage_complete` proves retention coverage, not that the seller emitted
every obligation the buyer independently expected. Buyers that derive an
expected-period denominator from an accepted schedule must compare that set to
`obligations` separately; seller scope coverage cannot prove an omitted period.

## Managed-delivery and receipt reconciliation

`reconcileReporting` turns the reporting ledger into a buyer-verifiable result. It reads one stable ledger snapshot, checks the expected period set, inspects each current destination materialization, submits any required consumer receipts, and then reads the seller's ledger back before returning.

The helper only returns `definitive: true` when all of these conditions hold:

- the buyer supplies its own complete `expectedPeriods` denominator;
- the seller closes the requested scope and declares its coverage complete;
- every expected report definition, feed, reporting profile, campaign set, and period has an obligation;
- every obligation's history counts match the returned immutable records;
- the current revision has the required finality;
- a verified, unexpired materialization matches the obligation;
- every consumer-receipt obligation has an accepted receipt for the same revision, materialization, row count, control totals, and required verification evidence.

An omitted expected-period denominator can still diagnose delivery, but can never prove completeness. Pass `[]` only when the buyer independently knows that no periods are expected in the requested scope.

A unique official revision takes precedence over a retained snapshot even without an explicit supersession link. The logical-slice join includes owned revisions whose destination materialization is still pending. In that case the result names the official revision, remains nondefinitive with `MISSING_VERIFIED_MATERIALIZATION`, and does not inspect or receipt the older snapshot. Forks, cycles, multiple official revisions, incomplete history, and mismatched ownership still prevent definitive reconciliation; the seller's retained records are preserved.

```ts
import {
  createHttpsReportingResourceReader,
  reconcileReporting,
} from '@adcp/sdk';

const result = await reconcileReporting({
  client: seller,
  request: {
    account: { account_id: 'account-1' },
    period: {
      start: '2026-08-01T00:00:00Z',
      end: '2026-09-01T00:00:00Z',
    },
  },
  expectedPeriods: [{
    deliveryConfigId: 'billing-feed',
    deliveryConfigVersion: 3,
    reportDefinitionId: 'billing-v1',
    feedPurpose: 'billing',
    reportingProfile: 'billing-v1',
    mediaBuyIds: ['buy-1', 'buy-2'],
    destinationRef: 'destination-billing-v3',
    deliveryMethod: 'file_transfer',
    requiredFinality: 'official',
    reconciliationMode: 'consumer_receipt',
    coverageRequirement: 'full',
    coverage: {
      status: 'full',
      media_buy_ids: ['buy-1', 'buy-2'],
      fully_covered_media_buy_ids: ['buy-1', 'buy-2'],
      partially_covered_media_buy_ids: [],
      unsupported_media_buy_ids: [],
      unknown_media_buy_ids: [],
      package_ids: ['package-1', 'package-2'],
      covered_package_ids: ['package-1', 'package-2'],
      unsupported_package_ids: [],
      unknown_package_ids: [],
    },
    reportDefinitionUri: 'https://schemas.seller.example/report-definitions/billing-v1.json',
    reportDefinitionSha256: savedBillingDefinitionSha256,
    schemaVersion: '1',
    schemaUri: 'https://schemas.seller.example/reporting/billing-v1.json',
    schemaSha256: savedBillingSchemaSha256,
    schemaDialect: 'https://json-schema.org/draft/2020-12/schema',
    schemaRefPolicy: 'local_fragment_only',
    officialFinality: {
      policyId: 'billing-close-v1',
      basis: 'contractual_cutoff',
    },
    verificationProfile: 'canonical_digest',
    canonicalization: {
      id: 'billing-rows-v1',
      uri: 'https://schemas.seller.example/canonicalization/billing-rows-v1.json',
      sha256: savedCanonicalizationSha256,
      primaryKeys: ['media_buy_id', 'date'],
    },
    periodStart: '2026-08-01T00:00:00Z',
    periodEnd: '2026-09-01T00:00:00Z',
  }],
  resourceReader: createHttpsReportingResourceReader(),
  credentialProvider: {
    async getCredentials({ obligation }) {
      const destination = await loadSavedDestination(obligation.destination_ref);
      return {
        headers: {
          authorization: `Bearer ${await destinationToken(obligation.destination_ref)}`,
        },
        allowedOrigins: [destination.readerOrigin],
      };
    },
  },
  manifestInspectorOptions: {
    referenceAllowedOrigins: ['https://schemas.seller.example'],
    consumerCommitRef: 'buyer-reporting-ledger:2026-08',
    maxInspectionMs: 60_000,
  },
});

if (!result.definitive) {
  throw new Error('Reporting is not ready for billing');
}
```

When `inspect` is omitted, `resourceReader` enables the built-in manifest path. It verifies the exact manifest bytes before parsing, manifest identity and completeness, every object size and SHA-256, declared compression and format, the pinned row schema and report definition, row count and control totals, and the pinned RFC 8785 canonical-content contract. The bundled decoders cover JSONL and CSV with `none` or `gzip` compression. Configure format/compression decoders for Parquet, Avro, ORC, Zstandard, or Snappy. The aggregate inspection deadline covers credential lookup, reads, reference resolution, custom adapters, validation, and canonicalization.

The HTTPS reader applies the SDK's DNS-pinned SSRF controls, refuses redirects and cross-origin `object_ref` values, and accepts short-lived headers only through the credential provider. `allowedOrigins` must come from the consumer's saved destination configuration; the reader refuses to send credentials to an origin named only by the seller's resource descriptor. For S3, GCS, or Azure, implement `ReportingResourceReader`; it receives the destination-bound context and opaque credentials without placing either in the ledger or receipt. Complex control totals can supply `controlTotalCalculator`; the default handles only report-definition metrics whose declared aggregation is `sum` and whose `source_expression` resolves to numeric row values.

Keep `inspect` as the advanced override for native snapshots. A BigQuery adapter can inspect a table version, while Snowflake or Databricks adapters can verify a shared relation. `ReportingInspectionError.retryable` distinguishes transport/readiness failures from permanent digest, schema, or integrity failures, so permanent failures are never retried. Store receipts in a durable `checkpointStore` so a process restart does not repeat destination work. Set `checkpointScope` to a stable, non-secret seller-and-authenticated-principal identifier; checkpoint keys also include account, obligation, revision, materialization, and destination. The checkpoint preserves the receipt-write idempotency key across uncertain retries.

For a replicated production buyer, use the PostgreSQL persistence bundle instead of
process memory:

```ts
import { createPostgresReportingConsumerRuntimeV1 } from '@adcp/sdk';

const persistence = createPostgresReportingConsumerRuntimeV1({
  db: pool,
  namespace: 'billing-reporting-v1',
});

for (const migration of persistence.migrations.all) await pool.query(migration);
await persistence.probe();

const result = await reconcileReporting({
  // ...client, request, expectations, and inspector configuration...
  checkpointStore: persistence.checkpointStore,
  checkpointScope: 'seller-42:buyer-principal-7',
  pendingConsumerStatusStore: persistence.pendingConsumerStatusStore,
});
```

The bundle also exposes a compare-and-set `changesCheckpointStore` for the
opaque `changes_after` recovery cursor and a database-clock, generation-fenced
`workLeases` store. Claim one lease per seller/principal/account before running
reconciliation in multiple replicas. A stale generation cannot renew or
release its successor's lease. The scope is stored only as a SHA-256 digest;
never put credentials, bearer tokens, or connection strings in it.

Receipt checkpoints are immutable first-writer-wins records. Replaying the
same checkpoint is accepted, while different bytes for the same reporting
revision and destination fail closed with
`ReportingConsumerPersistenceConflictError`. Pending consumer-status statements
remain replaceable until the seller confirms them, preserving the exact
`status_as_of` and request body across lost responses. Run migrations during a
controlled deployment before admitting traffic, and make `probe()` part of
readiness rather than liveness.

### Production consumer loop

`createReliableReportingConsumerV1` assembles those stores into a bounded,
replica-safe worker. Polling remains authoritative for clock-driven status
changes. `reporting.delivery_ready` and `reporting.ledger_changed` doorbells
first drain every `changes_after` page from the durable checkpoint, then run a
full reconciliation only when the delta contains records.

```ts
import {
  createPostgresReportingConsumerRuntimeV1,
  createReliableReportingConsumerV1,
} from '@adcp/sdk';

const persistence = createPostgresReportingConsumerRuntimeV1({
  db: pool,
  namespace: 'billing-reporting-v1',
});

const consumer = createReliableReportingConsumerV1({
  persistence,
  ownerToken: processInstanceId, // unique per process; never a credential
  pollIntervalMs: 60_000,
  leaseMilliseconds: 30_000,
  maxConcurrentAccounts: 8,
  accounts: [{
    consumerScope: 'seller-42:buyer-principal-7',
    accountId: 'account-1',
    reconciliation: {
      client: seller,
      request: { account: { account_id: 'account-1' } },
      expectedPeriods,
      resourceReader,
      credentialProvider,
      manifestInspectorOptions,
    },
  }],
  onResult: result => reportingMetrics.observe(result),
  onError: (error, accountId) => reportingAlerts.capture(error, { accountId }),
});

consumer.start();

// The HTTP route must verify the advertised AdCP webhook signature first.
await consumer.handleAuthenticatedNotification(verifiedWebhookBody);

// Stop accepting work and wait for in-flight reconciliation before closing DB/network clients.
await consumer.stop();
```

Webhook bodies are routing hints, never reporting evidence. The runtime accepts
them only through the deliberately named `handleAuthenticatedNotification`
entry point; signature verification belongs at the HTTP boundary. Unknown
accounts and unrelated notification types are ignored. Work for one account is
coalesced in-process and fenced across replicas. Lease loss aborts subsequent
protocol calls and prevents checkpoint advancement. A failed or expired change
cursor falls back to a complete snapshot and is observable through `onError`
and `cursorRecovered`.

Run `reporting.status_changed` through a full read: health can cross a deadline
without committing a new immutable record. Periodic polling is required for the
same reason even when every webhook arrives. Persist a checkpoint only after
the entire snapshot or delta has been consumed; the runtime enforces this and
uses compare-and-set advancement to fail closed on unexpected concurrency.

Totals are returned once per canonical reporting revision. Each entry includes its coverage status and covered/package denominators, so partial evidence cannot be mistaken for full billing totals. Delivering the same revision to a buyer, governance agent, and archive destination does not multiply its rows or financial control totals. Each consumer still authenticates independently and submits its own receipt; one consumer's acceptance never implies another's.

## Consumer status and posting deadlines

`reconcileReporting` also plans the rc.3 **consumer-status** loop: the statements the buyer owes the
seller about what it did and did not receive. Every plan lands on
`ReportingReconciliationResult.consumerStatuses`; the subset actually written appears on
`postedConsumerStatuses`, item-local rejections on `failedConsumerStatuses`.

Nothing is posted until a plan is `overdue`, and `overdue` needs a deadline. **If no deadline can be
derived the SDK posts nothing — by design.** That is the single most common surprise here, so the
resolution order is worth knowing:

| # | Source | Notes |
|---|---|---|
| 1 | `obligation.expected_at` | The seller's own commitment. Normalized, never echoed verbatim. |
| 1a | — *(present but unreadable)* | **Nothing is derived and rows 2–3 are not consulted.** A present `expected_at` is the seller's real deadline; a locally derived one would disagree with it and the statement would be refused on every run. Only the seller can fix the value. |
| 2 | `ExpectedReportingPeriod.deliverySlaSeconds` | Added to the period end for every finality. `reporting-schedule.json` defines `expected_at` only as period end plus `delivery_sla`; an SDK-local source-finality cutoff never replaces this protocol clock. |
| 3 | `obligation.schedule.delivery_sla` | Last resort, only when you pinned nothing above **and an obligation exists** — so it is never available for `obligation_missing`, which is what the pins are for. Deliberately last: it is as seller-controlled as `expected_at`, and preferring it would let a seller move its own deadline. |

The deadline is then that instant plus `ExpectedReportingPeriod.automatedRecoveryWindowSeconds`. That
window is advertised on the delivery **capabilities**, not on the obligation, so the ledger cannot
supply it — **without it nothing is ever overdue and nothing is ever posted.** Record it when you
accept the configuration generation.

`received` and `content_mismatch` additionally require `client.getMediaBuyDelivery`, because both
must carry a digest the buyer recomputed from rows it actually read.

### Why a plan was not posted

`plan.suppressed` says which, and `plan.reason` says what to do about it.

| `suppressed` | Meaning | Your move |
|---|---|---|
| `unchanged` | The current leaf already says exactly this. | Nothing. Re-posting would supersede a statement with its own duplicate. |
| `deadline_unknown` | No deadline could be derived: a pin is missing, the seller's `expected_at` is unreadable, or the deadline overflowed the representable range. | `reason` names which. Record the pin it names; for an unreadable `expected_at` only the seller can fix it; for an overflow, lower `automatedRecoveryWindowSeconds` or have the seller correct `expected_at`. |
| `consumption_unavailable` | No exact-revision reader is wired. | Supply `client.getMediaBuyDelivery`. |
| `posting_unavailable` | No poster is wired, so there is nothing to append to. | Supply `client.syncReportingStatus`. |
| `period_identity_unknown` | The seller's `period.source_timezone` is not a recognized IANA zone, and that value is part of the chain's logical key. | Record `ExpectedReportingPeriod.periodSourceTimezone`, or have the seller correct it. Substituting a zone would produce a statement it refuses on every run. |
| `local_budget_exhausted` | Your own `ledgerLimits` ran out mid-read, the revision exceeded the SDK's size ceiling, or a row was too *wide* for the SDK to walk. | Raise `maxRevisionRows`, `maxPages` or `maxLoadMs`; the size and breadth ceilings are not tunable. Never reported as a seller failure — a row nested deeper than the reader walks is `unreadable` / `reader_incompatible` instead, because no conformant tabular row has that shape. |
| `leaf_undisclosed` | Your chain has more than one unsuperseded leaf, or the seller named a current leaf it did not return. | A seller-side defect either way; the buyer declines to guess which leaf to supersede. |
| `chain_indeterminate` | The revision chain forked, or a head names a predecessor you never saw. | A seller-side defect. The buyer stays silent rather than blaming the seller for what it could not read. |

**Alert on any `suppressed` value other than `unchanged`.** `unchanged` is the healthy steady state — every posted period comes back `unchanged` on the next reconcile — but the other seven mean this period will never post until something changes.

Two more conditions deserve an alert, because neither sets `suppressed`:

- **`plan.deadlineBeyondPin` is set.** The seller's own `expected_at` is later than your pinned expectation by more than your recovery window. It is still honoured — the spec makes the seller's instant authoritative — but left unwatched it is indistinguishable from "not due yet", and a seller can use it to opt out of the loop entirely.
- **`overdue: true`, unsuppressed, and absent from `postedConsumerStatuses`.** Look in `failedConsumerStatuses`.

Some suppressions are the seller's doing and you cannot configure your way out of them — `leaf_undisclosed` and `chain_indeterminate` in particular. Those are worth escalating out of band rather than retrying.
