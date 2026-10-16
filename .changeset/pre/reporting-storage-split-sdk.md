---
'@adcp/sdk': major
---

Reliable Reporting storage moved out of `@adcp/sdk` into a new package, `@adcp/reporting-storage` (adcp-client#3286). This is a clean break during the SDK 16 beta: the moved subpaths are removed and there are no re-export shims. `@adcp/sdk` keeps the protocol layer and never imports the new package.

**Removed from `@adcp/sdk`.**

- `@adcp/sdk/reporting/gcs`, `/s3`, `/azure` and `/bigquery` are now `@adcp/reporting-storage/gcs`, `/s3`, `/azure` and `/bigquery`.
- From `@adcp/sdk/reporting/ledger`: `PostgresReportingLedgerStore` and every migration (`REPORTING_LEDGER_MIGRATION`, the finality writer fence, `REPORTING_ROW_STORAGE_MIGRATION`, `REPORTING_LEDGER_CHANGES_MIGRATION`, the object-write migrations) move to `@adcp/reporting-storage`, together with row storage, object writes and the change feed. The managed-delivery runtime, `PostgresReportingManagedDeliveryStore` and the adapter router move to `@adcp/reporting-storage/managed`. Notification activity moves to `@adcp/reporting-storage/notifications`.
- From `@adcp/sdk/reporting/service`: `createPostgresReliableReportingProductionService` moves to `@adcp/reporting-storage/service`, and the retention, compaction, orphan-collection and change-feed maintenance helpers move to `@adcp/reporting-storage`.
- The optional peers `@aws-sdk/client-s3`, `@azure/storage-blob` and `@google-cloud/storage` are now optional peers of `@adcp/reporting-storage`, not of `@adcp/sdk`.

**Still in `@adcp/sdk`.** The `ReportingLedgerStore` interface and its lease, transaction, row-read and revision-metadata types; the canonical row encoding and digests; `createReportingDeliveryHandler`, the status, sync-status and receipt handlers and status ingest; the producer; `createReliableReportingService`; `@adcp/sdk/reporting/consumer` and `/source`; and the health, coverage, lifecycle and schedule helpers.

**Breaking changes beyond the import paths.**

- `createReliableReportingService({ maintenance })` takes a factory instead of an options object, because retention, compaction and orphan collection are about the PostgreSQL store's data model. Pass `reportingLedgerMaintenance({ ...sameOptions })` from `@adcp/reporting-storage`. The service calls the factory once at construction with `{ store, statusRetentionDays, automatedRecoveryWindowSeconds }`, so retention still cannot disagree with the retention the service advertises, and a store that cannot be maintained still fails construction. `runMaintenance()` returns the neutral `ReliableReportingMaintenanceTaskResultV1`.
- `service.setup.migrations` is now the store's own `migrations` (`ReportingLedgerStore.migrations`, optional); `PostgresReportingLedgerStore` lists the ledger migration, so `reporting.setup.migrations[0]` keeps working, and a store with nothing to install gives `[]`.
- `ReportingLedgerLeaseLostError`, `ReportingLedgerPeriodRetiredError` and `ReportingLedgerContinuityError` moved into `@adcp/sdk/reporting/ledger`'s store types; the import path is unchanged.
- `createReportingManagedDeliveryRuntime` and its store interface are no longer in the SDK, but `createSyncReportingReceiptsHandler` and `reportingManagedDeliveryBindingV1` stay, against a new narrow `ReportingReceiptSyncStoreV1`.
- Core-only services refuse managed-delivery offerings with an error that names `@adcp/reporting-storage/service`.

**Added** so storage can be built against public API only: `compareReportingInstants`, `reportingPeriodDate`, `reportingPeriodSchedule`, `isFrozenCalendarRulesMismatch`, the receipt and verification evidence guards, `isWellFormedUnicodeString` and `getReportingDeliveryOfferingValidatorV1` on `@adcp/sdk/reporting/ledger`; the scheduler helpers and `REPORTING_MANAGED_DELIVERY_COMPOSITION_V1` on `@adcp/sdk/reporting/service`; and `DEFAULT_UNKNOWN_ERROR_RECOVERY` on `@adcp/sdk`. `npm run lint:boundaries` and `test/lib/reporting-storage-boundary.test.js` keep `@adcp/sdk` from importing the storage package.

**Migration.** Install `@adcp/reporting-storage` beside the SDK, change the imports, and wrap `maintenance` in `reportingLedgerMaintenance`. No database migration is needed: every migration has the same SQL under its new path. The full old-path to new-path table is in `docs/migration-reporting-storage-package.md`.
