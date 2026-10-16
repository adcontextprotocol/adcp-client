# Reliable Reporting storage moved to `@adcp/reporting-storage`

**Applies to:** SDK 16 beta. **Kind:** breaking, by design. There are no re-export shims: the moved subpaths are gone from `@adcp/sdk`.

The Reliable Reporting storage implementations now ship as their own package, `@adcp/reporting-storage`, on its own version line. `@adcp/sdk` keeps the protocol layer. If you import anything from `@adcp/sdk/reporting/gcs`, `/s3`, `/azure` or `/bigquery`, or the PostgreSQL store, row storage, managed delivery or notification activity from `@adcp/sdk/reporting/ledger`, or `createPostgresReliableReportingProductionService` from `@adcp/sdk/reporting/service`, change those imports. Nothing else changes on the wire, in the database schema, or in the ledger's behavior.

Why: storage keeps its own release cadence, as Auth.js, LangGraph and OpenTelemetry do, so a storage fix does not need an SDK release and an experimental storage break does not need an SDK major. The Python SDK is making the same split (adcp-client-python#1510). See [Reliable Reporting stability policy](guides/REPORTING-STABILITY.md).

## What to do

1. Install the package next to the SDK. `@adcp/sdk` is a peer dependency of it, so the host keeps exactly one copy:

   ```bash
   npm install @adcp/sdk@beta @adcp/reporting-storage@beta
   ```

   Pin the storage package with `~` (`"@adcp/reporting-storage": "~0.1.0"`): it is pre-1.0 and every export is experimental. The cloud SDKs are optional peers of the new package, not of `@adcp/sdk` any more, so keep `@aws-sdk/client-s3`, `@azure/storage-blob` and `@google-cloud/storage` in your own dependencies for the providers you use.

2. Change the imports using the table below. Run `tsc --noEmit`: every missed name is a `has no exported member` error that names the symbol.

3. If you pass `maintenance` to `createReliableReportingService`, wrap it (see [`maintenance` is now a factory](#maintenance-is-now-a-factory)).

4. Re-run your own tests. No database migration is needed: every migration constant has the same SQL under its new import path.

## Import mapping

| Old import                                                                 | New import                                                                  |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `@adcp/sdk/reporting/ledger`: `PostgresReportingLedgerStore`, the ledger, row-storage, object-write and change-feed migrations, `sweepExpiredReportingLedgerState`, row storage (`ReportingRowStorageV1`, bindings, providers contract, filesystem provider, conformance suite), object writes, the change feed | `@adcp/reporting-storage` |
| `@adcp/sdk/reporting/ledger`: the managed-delivery runtime, `PostgresReportingManagedDeliveryStore`, `REPORTING_MANAGED_DELIVERY_MIGRATION`, the adapter contract and router | `@adcp/reporting-storage/managed` |
| `@adcp/sdk/reporting/ledger`: notification activity (`createPostgresReportingNotificationActivityRuntime`, `createPostgresReportingNotificationAttemptCheckpoint`, `REPORTING_NOTIFICATION_ACTIVITY_MIGRATION`) | `@adcp/reporting-storage/notifications` |
| `@adcp/sdk/reporting/ledger`: everything else (the `ReportingLedgerStore` interface and its types, `createReportingDeliveryHandler`, `createReportingStatusHandler`, `createSyncReportingStatusHandler`, `createReportingProducer`, health, coverage, lifecycle, row encoding and digests, `ReportingRowStoreError`) | unchanged: `@adcp/sdk/reporting/ledger` |
| `@adcp/sdk/reporting/service`: `createPostgresReliableReportingProductionService` and its types | `@adcp/reporting-storage/service` |
| `@adcp/sdk/reporting/service`: retention, compaction, orphan-collection and change-feed maintenance (`runReportingLedgerMaintenance`, `ReportingRetentionOptionsV1`, `ReportingCompactionOptionsV1`, `ReportingMaintenancePartialFailureError`, and the related types) | `@adcp/reporting-storage` |
| `@adcp/sdk/reporting/service`: `createReliableReportingService`, the conformance runner | unchanged: `@adcp/sdk/reporting/service` |
| `@adcp/sdk/reporting/gcs` | `@adcp/reporting-storage/gcs` |
| `@adcp/sdk/reporting/s3` | `@adcp/reporting-storage/s3` |
| `@adcp/sdk/reporting/azure` | `@adcp/reporting-storage/azure` |
| `@adcp/sdk/reporting/bigquery` | `@adcp/reporting-storage/bigquery` |
| `@adcp/sdk/reporting/consumer`, `@adcp/sdk/reporting/source`, `@adcp/sdk` | unchanged |

Before and after:

```ts
// Before
import {
  PostgresReportingLedgerStore,
  REPORTING_LEDGER_MIGRATION,
  createReportingProducer,
} from '@adcp/sdk/reporting/ledger';
import { createGcsReportingRowObjectProviderV1 } from '@adcp/sdk/reporting/gcs';

// After
import { createReportingProducer } from '@adcp/sdk/reporting/ledger';
import { PostgresReportingLedgerStore, REPORTING_LEDGER_MIGRATION } from '@adcp/reporting-storage';
import { createGcsReportingRowObjectProviderV1 } from '@adcp/reporting-storage/gcs';
```

### Every moved export, by new subpath

<details>
<summary>84 exports of <code>@adcp/reporting-storage</code></summary>

`FilesystemReportingRowObjectProviderOptionsV1`, `PostgresReportingLedgerStore`, `PostgresReportingLedgerStoreOptions`, `REPORTING_LEDGER_CHANGES_MIGRATION`, `REPORTING_LEDGER_FINALITY_FENCE_CONSTRAINT`, `REPORTING_LEDGER_FINALITY_WRITER_FENCE_MIGRATION`, `REPORTING_LEDGER_MIGRATION`, `REPORTING_OBJECT_WRITE_AUTHORITY_MIGRATION`, `REPORTING_OBJECT_WRITE_MIGRATION`, `REPORTING_ROW_DEFAULT_KEY_TEMPLATE`, `REPORTING_ROW_KEY_PLACEHOLDERS`, `REPORTING_ROW_NATIVE_VERSION_REF_MAX_LENGTH`, `REPORTING_ROW_OBJECT_REF_MAX_LENGTH`, `REPORTING_ROW_STORAGE_MIGRATION`, `REPORTING_ROW_STORAGE_TABLES`, `ReportingChangeCursorExpiredError`, `ReportingChangeFeedMaintenanceOptionsV1`, `ReportingChangeKindV1`, `ReportingChangeRecordV1`, `ReportingChangesPageV1`, `ReportingCompactionOptionsV1`, `ReportingLedgerMaintenanceOptionsV1`, `ReportingLedgerMaintenanceStoreV1`, `ReportingLedgerMaintenanceTaskNameV1`, `ReportingLedgerMaintenanceTaskResultV1`, `ReportingMaintenancePartialFailureError`, `ReportingObjectRowBindingV1`, `ReportingObjectWriteAuthorityStoreV1`, `ReportingObjectWriteBindingV1`, `ReportingObjectWriteConflictError`, `ReportingObjectWriteContextV1`, `ReportingObjectWriteCursorV1`, `ReportingObjectWriteNotRevokedError`, `ReportingObjectWritePlanV1`, `ReportingObjectWriteScopeV1`, `ReportingObjectWriteStoreV1`, `ReportingObjectWriteV1`, `ReportingOrphanBindingResultV1`, `ReportingOrphanCollectionOptionsV1`, `ReportingOrphanCollectionResultV1`, `ReportingOrphanCollectionStateV1`, `ReportingPgPool`, `ReportingPostgresRowBindingV1`, `ReportingPreparedRowSetV1`, `ReportingRetentionOptionsV1`, `ReportingRowBindingDefinitionV1`, `ReportingRowBindingSelectionInputV1`, `ReportingRowChunkLocatorV1`, `ReportingRowObjectContextV1`, `ReportingRowObjectDeleteInputV1`, `ReportingRowObjectGetInputV1`, `ReportingRowObjectListEntryV1`, `ReportingRowObjectListInputV1`, `ReportingRowObjectLocationV1`, `ReportingRowObjectProviderV1`, `ReportingRowObjectPutInputV1`, `ReportingRowObjectStatInputV1`, `ReportingRowSetHandleV1`, `ReportingRowSetPrepareInputV1`, `ReportingRowStorageOptionsV1`, `ReportingRowStorageV1`, `RunReportingLedgerMaintenanceInputV1`, `assertReportingLedgerMaintenanceOptions`, `assertReportingObjectWriteScope`, `assertReportingRowKeyTemplateV1`, `assertReportingRowPrefixV1`, `createFilesystemReportingRowObjectProviderV1`, `decodeReportingChangeCursorV1`, `encodeReportingChangeCursorV1`, `isLegacyAccountChangeCursor`, `isReportingObjectWriteConflictError`, `isReportingObjectWriteNotRevokedError`, `probeReportingRowStorageSchemaV1`, `renderReportingRowObjectKeyV1`, `reportingLedgerMaintenance`, `reportingObjectWriteName`, `reportingObjectWritePlanFingerprint`, `reportingObjectWriteScopeKey`, `reportingRowAccountKeyV1`, `reportingRowRevisionKeyV1`, `reportingRowWriteIntentIdV1`, `runReportingLedgerMaintenance`, `runReportingRowObjectProviderConformanceV1`, `sweepExpiredReportingLedgerState`

</details>

<details>
<summary>35 exports of <code>@adcp/reporting-storage/managed</code></summary>

`CreateReportingManagedDeliveryAdapterRouterOptionsV1`, `CreateReportingManagedDeliveryRuntimeOptionsV1`, `PostgresReportingManagedDeliveryStore`, `PostgresReportingManagedDeliveryStoreOptions`, `REPORTING_ADAPTER_PROBE_DEADLINE_MILLISECONDS_V1`, `REPORTING_DESTINATION_PATTERNS_V1`, `REPORTING_DESTINATION_TRANSPORT_PATTERN_V1`, `REPORTING_MANAGED_DELIVERY_MIGRATION`, `ReportingDestinationAuthorizationV1`, `ReportingDestinationPatternV1`, `ReportingDestinationRevocationLeaseV1`, `ReportingManagedDeliveryAdapterRouterV1`, `ReportingManagedDeliveryAdapterV1`, `ReportingManagedDeliveryAdvertisedPoliciesV1`, `ReportingManagedDeliveryLeaseV1`, `ReportingManagedDeliveryProbeErrorV1`, `ReportingManagedDeliveryRouteCountsV1`, `ReportingManagedDeliveryRouteDescriptionV1`, `ReportingManagedDeliveryRouteV1`, `ReportingManagedDeliveryRoutingErrorCodeV1`, `ReportingManagedDeliveryRoutingErrorV1`, `ReportingManagedDeliveryRoutingOperationV1`, `ReportingManagedDeliveryRuntimeV1`, `ReportingManagedDeliveryStore`, `ReportingManagedDeliveryWorkerOptionsV1`, `ReportingManagedDeliveryWorkerResultV1`, `UNROUTED_REPORTING_ROUTE_KEY_V1`, `adjustmentReceiptEvidenceMatches`, `assertCredentialFreeReportingResourceLocationV1`, `assertMaterializationOutcome`, `createReportingManagedDeliveryAdapterRouterV1`, `createReportingManagedDeliveryRuntime`, `readManagedReportingResource`, `receiptEvidenceMatches`, `runManagedDeliveryWorker`

</details>

<details>
<summary>20 exports of <code>@adcp/reporting-storage/notifications</code></summary>

`PostgresReportingNotificationActivityOptions`, `PostgresReportingNotificationActivityRuntime`, `REPORTING_NOTIFICATION_ACTIVITY_MIGRATION`, `ReportingAccountActivityPageV1`, `ReportingAccountActivityRecordV1`, `ReportingAccountActivityV1`, `ReportingDeliveryReadyActivityV1`, `ReportingLedgerChangedActivityV1`, `ReportingLifecycleActivityV1`, `ReportingNotificationActivityPageV1`, `ReportingNotificationActivityRecordV1`, `ReportingNotificationActivityV1`, `ReportingNotificationAttemptCheckpointV1`, `ReportingNotificationProjectionErrorV1`, `ReportingNotificationRecoveryMetricsV1`, `ReportingNotificationRetryableSuppressionError`, `createPostgresReportingNotificationActivityRuntime`, `createPostgresReportingNotificationAttemptCheckpoint`, `getReportingNotificationActivityMigration`, `recipientTableName`

</details>

<details>
<summary>3 exports of <code>@adcp/reporting-storage/service</code></summary>

`CreatePostgresReliableReportingProductionServiceOptionsV1`, `PostgresReliableReportingProductionServiceV1`, `createPostgresReliableReportingProductionService`

</details>

<details>
<summary>13 exports of <code>@adcp/reporting-storage/gcs</code></summary>

`CreateGcsReportingManagedDeliveryAdapterOptionsV1`, `CreateGcsReportingRowObjectProviderOptionsV1`, `GcsReportingObjectFenceV1`, `GcsReportingReadAuthorizationV1`, `GcsReportingReadScopeV1`, `GcsReportingReaderOptionsV1`, `ReportingGcsFenceError`, `createGcsReportingManagedDeliveryAdapterV1`, `createGcsReportingObjectFenceV1`, `createGcsReportingReferenceResolverV1`, `createGcsReportingResourceReaderV1`, `createGcsReportingRowObjectProviderV1`, `isReportingGcsFenceError`

</details>

<details>
<summary>2 exports of <code>@adcp/reporting-storage/s3</code></summary>

`CreateS3ReportingRowObjectProviderOptionsV1`, `createS3ReportingRowObjectProviderV1`

</details>

<details>
<summary>2 exports of <code>@adcp/reporting-storage/azure</code></summary>

`CreateAzureBlobReportingRowObjectProviderOptionsV1`, `createAzureBlobReportingRowObjectProviderV1`

</details>

<details>
<summary>10 exports of <code>@adcp/reporting-storage/bigquery</code></summary>

`BigQueryReportingWarehouseSinkV1`, `CreateBigQueryReportingWarehouseSinkOptionsV1`, `REPORTING_WAREHOUSE_SINK_MIGRATION`, `ReportingBigQueryClientV1`, `ReportingWarehouseRowContextV1`, `createBigQueryReportingWarehouseSinkV1`, `reportingWarehouseCurrentRowsViewSqlV1`, `reportingWarehouseDefaultTablesSqlV1`, `reportingWarehouseJobIdV1`, `reportingWarehouseLoadDeadlineV1`

</details>

## Behavior changes

### `maintenance` is now a factory

The SDK does not know what maintenance a store needs, and retention, compaction and orphan collection are about the PostgreSQL store's data model. So `createReliableReportingService({ maintenance })` takes a factory, and `@adcp/reporting-storage` supplies the PostgreSQL one:

```ts
// Before
createReliableReportingService({
  store,
  maintenance: { retention: { enabled: true }, changeFeed: true },
});

// After
import { reportingLedgerMaintenance } from '@adcp/reporting-storage';

createReliableReportingService({
  store,
  maintenance: reportingLedgerMaintenance({ retention: { enabled: true }, changeFeed: true }),
});
```

The options are unchanged. The service still hands the factory the retention and recovery-window commitments it advertises, so retention still cannot disagree with what buyers were told, and a configuration the store cannot serve still fails when the service is constructed, not on the first scheduled pass. `service.runMaintenance()` returns the same per-task results, typed as `ReliableReportingMaintenanceTaskResultV1` (`{ task, status, result | error, partialFailure? }`). A store from another package can supply its own factory. `createPostgresReliableReportingProductionService` is unchanged: it takes `retention`, `compaction`, `changeFeed` and `orphanCollection` directly.

### `service.setup.migrations` comes from the store

`createReliableReportingService` no longer names the PostgreSQL migration. `service.setup.migrations` is the store's own `migrations` list (`ReportingLedgerStore.migrations`, optional). `PostgresReportingLedgerStore` lists `[REPORTING_LEDGER_MIGRATION]`, so `await pool.query(reporting.setup.migrations[0])` keeps working. A store with nothing to install (an in-memory test double) gives an empty list.

### Error classes now live with the interface

`ReportingLedgerLeaseLostError`, `ReportingLedgerPeriodRetiredError` and `ReportingLedgerContinuityError` are exported from `@adcp/sdk/reporting/ledger`, where the `ReportingLedgerStore` types are. The package re-throws these exact classes. The protocol layer still recognizes them by `name`, so a store from any package, or another copy of the SDK, is understood.

### The Core service refuses managed-delivery offerings

A `createReliableReportingService` without a managed-delivery composition still refuses offerings that need Managed Delivery or Reconciled Billing, now naming `@adcp/reporting-storage/service` in the error. A composition built elsewhere opts in with the exported `REPORTING_MANAGED_DELIVERY_COMPOSITION_V1` key.

### New exports on `@adcp/sdk`

So a store can live outside the SDK against public API only: `compareReportingInstants`, `reportingPeriodDate`, `reportingPeriodSchedule`, `isFrozenCalendarRulesMismatch`, the receipt and verification evidence guards, `isWellFormedUnicodeString` and `getReportingDeliveryOfferingValidatorV1` (from `@adcp/sdk/reporting/ledger`); `reportingManagedDeliveryBindingV1`, `createSyncReportingReceiptsHandler`, `ReportingReceiptSyncStoreV1` and `SyncReportingReceiptsParamsV1` (from `@adcp/sdk/reporting/ledger`; the receipts handler only needs `syncReceiptBatch`); the scheduler helpers `reportingSchedulerErrorMessage`, `reportingSchedulerDelay`, `rotateReportingRoster`, `reportingDeploymentWideAccountIds`, `reportReportingSchedulerError` and `warnReportingSchedulerFailure` (from `@adcp/sdk/reporting/service`); and `DEFAULT_UNKNOWN_ERROR_RECOVERY` (from `@adcp/sdk`).

## Other things that moved

| Was                                                           | Now                                                                                       |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `scripts/validate-reporting-gcp.mjs`                          | `packages/reporting-storage/scripts/validate-reporting-gcp.mjs` (`npm run validate:reporting-gcp` still works at the repository root) |
| `examples/reliable-reporting-lifecycle`, `examples/reliable-reporting-service` | `packages/reporting-storage/examples/...`                                |
| Optional peers `@aws-sdk/client-s3`, `@azure/storage-blob`, `@google-cloud/storage` on `@adcp/sdk` | optional peers of `@adcp/reporting-storage` |
| Experimental policy for `reporting/gcs`, `s3`, `azure`, `bigquery` and the storage exports of `ledger` and `service` | the whole `@adcp/reporting-storage` package is pre-1.0 and experimental; see [REPORTING-STABILITY.md](guides/REPORTING-STABILITY.md) |

The consumer-side Postgres persistence (`createPostgresReportingConsumerRuntimeV1`, `REPORTING_CONSUMER_POSTGRES_MIGRATION` under `@adcp/sdk/reporting/consumer`) and webhook activity (`createPostgresReportingWebhookActivityV1`, exported from `@adcp/sdk`) stay in the SDK for now.

## Self-grade

```bash
# nothing should still import a moved subpath
grep -rn "@adcp/sdk/reporting/\(gcs\|s3\|azure\|bigquery\)" src
# nothing should read storage exports from the SDK subpaths
grep -rn "PostgresReporting\|REPORTING_[A-Z_]*MIGRATION\|createPostgresReliableReportingProductionService" src | grep "@adcp/sdk"
npx tsc --noEmit
```
