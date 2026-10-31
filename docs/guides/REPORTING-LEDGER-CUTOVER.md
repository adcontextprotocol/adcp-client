# Cutting over to the SDK reporting ledger from your own ledger tables

This guide is for a seller that already runs its own Reliable Reporting ledger
(tables for configuration generations, obligations and revisions, row files in
object storage and a warehouse, status issues and transitions) and wants
`@adcp/sdk` and `@adcp/reporting-storage` to own the ledger from now on. Read the
[ledger guide](REPORTING-LEDGER.md) first for the SDK side, and the
[operations runbook](REPORTING-OPERATIONS.md) for production practice.

The short version:

- Pick **one authoritative ledger per period**. The SDK ledger produces and
  serves every period from a boundary you choose. Your tables become read-only.
- **Do not migrate data and do not dual-write.** The old tables keep answering
  exact reads for old revision IDs until their retention lapses, through a
  single read-only hook, then you drop them.
- Everything buyer-visible stays stable across the cutover: old revision IDs
  keep resolving, and new ones come from the SDK.

## Adopt the SDK tables, or implement the store over your own?

You have two ways to run the SDK's service on top of what you have.

| | Adopt `PostgresReportingLedgerStore` (recommended) | Implement `ReportingLedgerStore` over your tables |
| --- | --- | --- |
| Schema | The SDK's `adcp_reporting_*` tables, installed by `npx adcp-reporting-storage migrate` | Yours |
| Row storage | `rowStorage`: verified chunked rows in your GCS, S3 or Azure bucket, or PostgreSQL | You implement `readRevisionRows` and verify rows against the committed binding yourself |
| Change feed | `changeFeed: true`: `changesAfter`, current-revision reads, consumer cursors | You implement it, or go without host reads and the warehouse sink |
| Retention | `maintenance.retention`: period-aligned retirement honouring the change-feed hold | You implement `retireExpiredPeriods` and tombstones, or never retire |
| Maintenance | `maintenance`: snapshot sweep, abandoned-upload sweep, feed pruning | You write all of it |
| Warehouse | `@adcp/reporting-storage/bigquery` sink | Not available: it reads the SDK store |
| Correctness | Lease fencing, gap-free status checkpoints, immutable generations and the revision binding are enforced in one tested place | Every one of those guarantees is yours to prove |
| Existing data | Starts empty; old tables stay behind a read-only hook | Old data served natively |

Implementing the store over your own tables is a large surface: the store is
the correctness boundary for leases, fencing, immutability, snapshot
checkpoints and the binding digest. You also forgo row storage, the change
feed, retention and the sink, which are all implemented against the SDK
tables. Choose it only when a hard constraint forbids a second schema. For
almost every seller with an existing ledger, adopt the SDK tables and put the
old ones behind the [legacy fallback](#the-legacy-fallback-hook).

## Core-only setup with GCS object rows

Run the SDK ledger in its own schema or database. The default table set is
deployment-wide, so the store requires `acknowledgeIsolatedDatabase: true`.
You do not need the production service: Core plus `maintenance` covers
production, serving, row storage, the change feed and retention. If you
advertise Managed Delivery or Reconciled Billing today, read
[What a Core-only cutover does not carry](#what-a-core-only-cutover-does-not-carry).

```ts
import { Pool } from 'pg';
import { Storage } from '@google-cloud/storage';
import { PostgresReportingLedgerStore, reportingLedgerMaintenance } from '@adcp/reporting-storage';
import { createGcsReportingRowObjectProviderV1 } from '@adcp/reporting-storage/gcs';
import { createReliableReportingService } from '@adcp/sdk/reporting/service';

// Apply once with your migration owner (PostgreSQL 13+): npx adcp-reporting-storage migrate
// (the ledger, row storage and change feed are versions 0002, 0004 and 0005).

const pool = new Pool({ connectionString: process.env.REPORTING_LEDGER_DATABASE_URL });
const store = new PostgresReportingLedgerStore(pool, {
  acknowledgeIsolatedDatabase: true,
  changeFeed: true,
  rowStorage: {
    deploymentNamespace: 'prod-us',
    bindings: {
      rows: {
        kind: 'object',
        provider: 'gcs',
        location: { bucket: 'acme-reporting' }, // your existing bucket
        prefix: 'adcp-ledger-rows', // a prefix the legacy writer never uses
        compression: 'gzip',
      },
    },
    providers: { gcs: createGcsReportingRowObjectProviderV1({ storage: new Storage() }) },
    selectRowBinding: () => 'rows',
  },
});
await store.readyRowStorage();

const reporting = createReliableReportingService({
  store,
  statusRetentionDays: 90, // the commitment advertised to buyers; retention uses it
  // ...adapters, contact, resolveSource, resolveCurrency, resolveCoverage
  legacyRevisionReader, // see "The legacy fallback hook"
  maintenance: reportingLedgerMaintenance({
    retention: { enabled: true, recordRetentionDays: 120, limit: 100 },
    changeFeed: { changeRetentionDays: 30, maxFeedHoldDays: 7 },
  }),
});
```

With object row storage, PostgreSQL holds only revision headers, row-set and
chunk manifests (digests, sizes, object keys and versions) and lifecycle
state. The bytes live in your bucket.

- **Reusing your bucket.** Point the binding at the existing bucket with a
  prefix the legacy writer never touches. Keys are `{prefix}/{namespace_key}/...`
  with a hashed account segment, and the SDK only creates, reads and deletes
  objects under that prefix.
- **Bucket requirements.** Uniform bucket-level access and enforced public
  access prevention are required. A lifecycle `Delete` rule that can match live
  objects under the SDK prefix (no `matchesPrefix`, or an overlapping one) makes
  the GCS probe refuse the binding, so scope any bucket-wide lifecycle rule to
  your legacy prefix. Keep retention-driven deletion in the ledger's pruning.
- **Namespace.** `deploymentNamespace` is mixed into every key. Keep it stable
  across deploys and distinct per environment.
- **Maintenance.** `reporting.start({ deploymentWide: true, onError })` runs
  `maintenance` at most once per `intervalMilliseconds`; or call
  `reporting.runMaintenance()` from your own scheduler. Retention uses the
  service's `statusRetentionDays`, so it can never retire a period earlier than
  the retention you advertise. See
  [Core-only setup](REPORTING-LEDGER.md#core-only-setup-with-row-storage-change-feed-and-retention).
  Enable `retention` last.

### Keeping your BigQuery tables fed

`@adcp/reporting-storage/bigquery` follows the change feed and loads every
committed revision's verified rows into BigQuery tables you name
([sink details](REPORTING-LEDGER.md#bigquery-warehouse-sink)). The warehouse
copy is derived and never served.

```ts
const sink = createBigQueryReportingWarehouseSinkV1({
  store,
  db: pool,
  bigquery: new BigQuery({ projectId: 'analytics-prod' }),
  name: 'warehouse',
  projectId: 'analytics-prod',
  datasetId: 'reporting',
  rowsTableId: 'media_buy_delivery_rows_v2', // new tables, not your legacy ones
  revisionsTableId: 'media_buy_delivery_revisions_v2',
  mapRow: row => ({ media_buy_id: row.media_buy_id, impressions: row.impressions, spend: row.spend }),
});
```

Give the sink its **own new tables** rather than your legacy ones. It adds its
own fixed columns (`reporting_revision_id`, `reporting_obligation_id`,
`account_id`, `revision_number`, `finality`, `period_date` (the period start's date in its source timezone), `ordinal`), and
loading into a table another writer owns invites double counting. Give analysts
one view that `UNION ALL`s the legacy table, bounded to periods before the
cutover boundary, with the sink's `current_rows` view, bounded to periods from
it. Query `current_rows`, never the raw rows table, because pacing snapshots
are cumulative.

## Cutover, step by step

Choose a **cutover boundary** `B`: the start of a reporting period (for a daily
schedule, a midnight in the source timezone). Periods that start before `B`
belong to your legacy ledger forever. Periods that start at or after `B`
belong to the SDK ledger.

1. **Stand up the SDK ledger without serving it.** Apply the migrations, build
   the store and service, run `runMaintenance()`, and confirm the GCS probe
   passes in each environment. Do not call `reporting.install(platform)` yet
   and do not start its scheduler. Nothing is buyer-visible.
2. **Wire the legacy fallback hook** (below) over your existing exact-revision
   read, and exercise it in staging with a revision ID from your legacy tables.
3. **Rehearse in staging** with a shadow service (see
   [Shadow comparison](#shadow-comparison)) over a few real periods until row
   counts, control totals and row digests match.
4. **Install configurations in the last legacy period.** The SDK plans
   obligations from `max(schedule.anchor, installedAt)`, rounded up to the next
   period boundary. Install each active configuration through
   `installConfiguration` (your `accounts.upsert` mapping) after the start of
   the last legacy period and before `B`, with `schedule.anchor` no later than
   `B`. The first period the SDK produces is then `B`, never the period in
   progress. Verify that no SDK obligation exists for a period before `B`.
5. **Stop the legacy writer for periods at or after `B`.** The legacy
   production job must not plan or write any period starting at or after `B`,
   and must not publish new revisions for earlier ones (see
   [Corrections to pre-cutover periods](#corrections-to-pre-cutover-periods)).
   Do this by configuration (disable the planner for the new periods), not by
   revoking database permissions mid-write.
6. **Switch the serving path.** Deploy with `reporting.install(platform)` and
   `reporting.start({ deploymentWide: true, onError })`. From this deploy the
   SDK's handlers answer `get_reporting_status` and `get_media_buy_delivery`,
   the capability document is the SDK's, and exact reads for old revision IDs
   flow through the fallback. Make the legacy tables read-only now (revoke
   `INSERT`, `UPDATE` and `DELETE` from the application role).
7. **Watch the first SDK period close:** worker progress, the first revision's
   binding, a buyer exact read, the warehouse sink's `runOnce()` result, and a
   legacy-ID exact read through the fallback.
8. **Decommission** the legacy tables after retention
   ([below](#decommissioning-the-old-tables)).

Because the boundary is a period boundary, no period is ever produced by both
ledgers, so no revision ID or `revision_content_sha256` is ever ambiguous.

### What `get_reporting_status` shows after cutover

History starts at the cutover. The SDK ledger knows only the periods it owns,
from the first boundary at or after each configuration's install instant. A
status read over a wide range returns the SDK's obligations, revisions and
health for periods at or after `B` and nothing for earlier periods. Those
periods are outside the SDK's ownership, so they are absent rather than
reported as missing history. `HISTORY_UNAVAILABLE` is reserved for periods the
SDK owns whose obligation records are gone (retired by retention or
compacted).

Buyers that need pre-cutover data keep using the revision IDs they already
hold: exact `get_media_buy_delivery` reads for those IDs are served by the
fallback for as long as your legacy tables retain them. Tell buyers that status
listing starts at the boundary while exact reads of known revisions continue.

The SDK has no hook for listing pre-cutover periods through
`get_reporting_status`. Do not synthesize SDK obligations for old periods: that
is a data migration, with all the identity problems described below.

### Corrections to pre-cutover periods

A late correction to a period that started before `B` needs a decision. The
SDK cannot produce a revision for a period it never owned, and your legacy
writer is read-only. Either keep the legacy writer enabled **for corrections of
pre-cutover periods only**, and keep those tables writable until the last such
period leaves its correction window, or handle them out of band. The rule that
must hold is that every period has exactly one authoritative writer.

## The legacy fallback hook

`createReliableReportingService` (and
`createPostgresReliableReportingProductionService`) takes an optional
`legacyRevisionReader`. The SDK handler always answers first. Only when the SDK
ledger has no such revision for the resolved account does it call your reader
with the same request and context.

```ts
import type { ReportingLegacyRevisionReaderV1 } from '@adcp/sdk/reporting/ledger';

const legacyRevisionReader: ReportingLegacyRevisionReaderV1 = async (request, context) => {
  // `context.account` is the framework-resolved account, not request.account.
  const accountId = (context.account as { id: string }).id;
  const row = await legacyDb.findRevision({
    reporting_revision_id: request.reporting_revision_id,
    account_id: accountId, // scope by the resolved account
  });
  if (!row) return null; // not found here either
  return buildGetMediaBuyDeliveryResponse(row, request.pagination);
};
```

The contract:

- **Signature.** `(request, context) => Promise<GetMediaBuyDeliveryResponse | null | undefined>`.
  The request and context are exactly what the SDK handler received, including
  `pagination` and `context.signal`.
- **Not found.** Return `null` or `undefined`. The caller gets the SDK's own
  nondisclosing `REFERENCE_NOT_FOUND` with `field: "reporting_revision_id"`,
  identical to an unknown ID on a pure-SDK deployment.
- **Errors.** An error your reader throws propagates unchanged. Throw
  `AdcpError('SERVICE_UNAVAILABLE')` for your own outages instead of returning
  `null`, so buyers retry instead of concluding the revision is gone.
- **Authorization is yours.** The SDK has resolved the account and cannot judge
  whether a legacy revision belongs to it. Your reader **must** scope the lookup
  by `context.account` and return `null` for another account's revision. The SDK
  also routes a request for an SDK-owned revision that belongs to a *different*
  account to your reader, so it must never answer for a revision it cannot
  attribute to the resolved account.
- **When it is called.** Only for a revision the SDK ledger does not hold for
  the resolved account.
- **When it is never called.** For an SDK-owned revision that is expired, whose
  rows are missing, corrupt or disagree with the committed binding, or that
  comes with an unusable cursor; and on read capacity exhaustion or any other
  error. Falling back there could serve different content under an ID the SDK
  owns.
- **Read-only and bounded.** The hook must not write to the SDK ledger. The SDK
  releases its per-account read slot before calling you, so bound your reader's
  own concurrency and timeouts.
- **Shape.** Return a full `get_media_buy_delivery` response for that revision,
  including `reporting_revision_binding` and `reporting_revision` with the
  revision ID and `revision_content_sha256` your buyers already recorded. Page
  rows with the same `pagination` contract; your cursors only need to round-trip
  through your reader.
- **Identity.** Keep legacy revision IDs distinguishable from SDK IDs (`rrev_`
  plus a 32-character digest) so a legacy ID can never collide with one the SDK
  later derives.

## Why not dual-write

A second authoritative ledger looks like a safe migration path and is the most
dangerous one.

- **Revision IDs and content hashes are buyer-visible.** The SDK derives a
  revision ID from the obligation and the source publication, and
  `revision_content_sha256` is the SHA-256 of the canonical JSON of
  `{ reporting_revision_id, row_count, control_totals, reporting_rows }`. Two
  ledgers writing the same period produce **two different IDs and two different
  hashes**, and the buyer's receipts bind to whichever one they saw.
- **Divergence is silent.** Two writers can disagree on a restatement, an
  official finality decision or an adjustment, and nothing detects it until a
  buyer reconciles a bill against a revision the other ledger never recorded.
- **Immutability is per ledger.** An official revision is terminal in one
  ledger while the other may still treat the period as open.
- **Leases and fencing do not span ledgers.** Each fences only its own writers.

A **shadow write for comparison is fine** as long as it is never served: a
separate database, never installed on the platform, never advertised, never
notifying. The moment a shadow ledger can answer a buyer, it is a second
authoritative ledger.

## Shadow comparison

Before the boundary, run the SDK service against a separate shadow database and
feed it the same source periods. Compare what the two ledgers committed for the
same period. Do not compare `revision_content_sha256` directly: it includes the
revision ID, and IDs differ between ledgers by construction. Compare the inputs
to that hash:

```ts
import { createHash } from 'node:crypto';
import { canonicalize } from '@adcp/sdk';

const rowsDigest = (rows: readonly unknown[]) => createHash('sha256').update(canonicalize(rows), 'utf8').digest('hex');

// SDK side, against the shadow store
const current = await shadowStore.getCurrentRevision({ account_id, reporting_obligation_id });
const page = await shadowStore.readRevisionRows({
  reporting_revision_id: current.reporting_revision_id,
  account_id,
  offset: 0,
  limit: Math.max(1, current.binding.rowCount),
});

// Compare with the legacy revision for the same account and period:
//   row count, control totals (name and exact decimal value), rowsDigest(rows)
```

- **Parity means** equal row count, equal `control_totals`, and equal canonical
  row digests. Array order is part of the canonical form, so sort both sides by
  your natural key first if your legacy writer does not guarantee order.
- **Expected differences:** revision ID, `revision_content_sha256`, timestamps,
  freshness and manifest evidence.
- Run the comparison until a full set of periods, including one restatement,
  matches. Then tear the shadow down; do not leave a second ledger running.

## Decommissioning the old tables

After cutover the legacy tables answer exact reads for revision IDs buyers
already hold. The retention you advertised bounds how long.

1. The last legacy period ends at `B`. Keep its revisions for the legacy
   deployment's advertised `status_retention_days`, counted from that close.
2. When that window has lapsed for every legacy period, the fallback has
   nothing buyers can still legitimately ask for. Remove `legacyRevisionReader`,
   deploy, and confirm an exact read of an old ID returns `REFERENCE_NOT_FOUND`.
3. Stop the legacy export jobs, drop the legacy tables, delete or archive the
   legacy objects (under their own prefix, never under the SDK prefix), and
   retire the legacy BigQuery tables once analysts have moved to the new view.

Keep the legacy tables for the whole window, not only until the last revision
was read: buyers verify revisions up to the advertised retention, and that value
is a commitment. The SDK's `statusRetentionDays` applies to new periods only.

## What a Core-only cutover does not carry

Core-only advertises Reliable Reporting Core: `get_reporting_status` and
`get_media_buy_delivery`. It does not deliver files to buyer destinations
(Managed Delivery) and does not accept consumer receipts (Reconciled Billing).
If your legacy materializations feed buyer-owned destinations, either keep
delivering them from your own pipeline, reading revisions through
`listCurrentRevisions` or the change feed rather than from your old tables, or
adopt the production service with the managed-delivery add-on as a separate,
later step. Do not advertise a tier the new ledger does not implement.

## Mapping from typical custom tables to the SDK tables

Your names will differ. Map by role.

| Your concept (typical custom table) | SDK table | Notes |
| --- | --- | --- |
| Configuration generation (`reporting_core_config_generation`) | `adcp_reporting_configurations` | One immutable generation per `(account_id, delivery_config_id, delivery_config_version)`, with a semantic fingerprint and the frozen source scope and currency in `data` (JSONB). Installed by `installConfiguration`; a changed configuration is a new generation. |
| Obligation (`reporting_obligation`) | `adcp_reporting_obligations` | One row per configuration and period ordinal: period bounds, `state` (`pending` or `terminal`), `next_attempt_at`, lease owner, generation and expiry. The rest is in `data`. |
| Revision with explicit columns (`reporting_revision`, 39 columns) | `adcp_reporting_revisions` | Promoted columns are `revision_id`, `obligation_id`, `revision_number`, `finality`, `kind`, `supersedes_revision_id` and `content_sha256`. The remainder (report definition and digest, profile, schema version, row count, control totals, freshness, manifest and finality evidence) is the wire revision inside `data` (JSONB). Do not recreate your 39 columns: use `getCurrentRevision`, `listCurrentRevisions` and the change feed. |
| Row files (GCS objects plus BigQuery) | `adcp_reporting_row_bindings`, `adcp_reporting_row_sets`, `adcp_reporting_row_chunks`, plus your bucket | Postgres holds the manifest only: digests, sizes, object key and native version per chunk. Rows are verified canonical JSONL chunks in the object store. An unchanged pulse shares its predecessor's row set. BigQuery is fed by the sink, not by the ledger. |
| Corrections after an official revision | `adcp_reporting_adjustments` | Immutable adjustments bound to the official revision, never superseding revisions. |
| Status issues | `adcp_reporting_issues` | Obligation-scoped issues with observed and resolved times. |
| Status transitions and lifecycle | `adcp_reporting_transitions`, `adcp_reporting_lifecycle_state` | Append-only health transitions with a sequence and a durable notified marker, plus a per-obligation reconciliation watermark. Current health is derived from these on read. |
| Materializations (delivery evidence for buyer destinations) | `adcp_reporting_materializations`, `adcp_reporting_managed_bindings`, `adcp_reporting_receipts` | Managed Delivery add-on only; absent in a Core-only deployment. |
| Snapshots as status read caches | `adcp_reporting_snapshots`, `adcp_reporting_checkpoints` | Ephemeral cursor state with a 15-minute expiry, swept by maintenance. Not a durable record. |
| Snapshots as intraday revisions | `adcp_reporting_revisions` with `finality = 'snapshot'` | A pacing snapshot is a revision whose finality is `snapshot`; `official` is terminal. |
| Retired periods | `adcp_reporting_obligation_tombstones` | A compact record that refuses replays and preserves the audit conclusion after retention deletes a period. |
| Change log | `adcp_reporting_changes`, `adcp_reporting_feed_consumers` (plus horizons) | With `changeFeed: true`. Replaces polling your revision table. |
| Row upload bookkeeping | `adcp_reporting_object_write_*` | Intent and fencing records for object uploads. |

## Cutover checklist

- [ ] SDK ledger in an isolated schema or database, migrations applied, probes
      green in every environment.
- [ ] Row bucket prefix is separate from legacy objects; no bucket lifecycle rule
      can delete live SDK objects.
- [ ] `legacyRevisionReader` scopes by `context.account`, returns `null` for
      unknown, and throws for its own outages.
- [ ] Cutover boundary `B` chosen; each configuration installed during the last
      legacy period; no SDK obligation exists before `B`.
- [ ] Legacy writer disabled for periods at or after `B` (and a correction path
      for earlier periods decided).
- [ ] Legacy tables read-only after the switch deploy.
- [ ] Buyers told: status listing starts at `B`; old revision IDs keep working
      until the legacy retention lapses.
- [ ] Shadow ledger (if any) is unreachable from the serving path.
- [ ] Decommission date recorded: end of the last legacy period plus the legacy
      `status_retention_days`.
