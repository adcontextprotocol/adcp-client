---
'@adcp/sdk': minor
---

Reporting ledger paths that only need revision metadata no longer load revision rows. `ReportingLedgerStore` gains optional `listRevisionMetadata(obligationId, accountId?)` and `listAdjustmentMetadata(obligationId)`, implemented by `PostgresReportingLedgerStore` with `data - 'rows'`. The producer, lifecycle reconciler and status ingest prefer them and fall back to `listRevisions`/`listAdjustments` with rows dropped, so custom stores keep working unchanged. Managed Delivery materialization planning now selects and groups by revision id instead of the full revision document. Adds the `ReportingLedgerAdjustmentMetadataV1` type.
