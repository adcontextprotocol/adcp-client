---
'@adcp/sdk': patch
---

Reliable Reporting: snapshot compaction now fails closed when an object row binding's `keyTemplate` omits `{revision_key}`. With such a template two revisions with identical chunk content can name one object key, so a concurrent commit adopting that object could lose its rows to compaction deleting it. `createReliableReportingService` (`maintenance.compaction`) and `createPostgresReliableReportingProductionService` (`compaction`) throw at construction, and `PostgresReportingLedgerStore.compactSupersededSnapshots` throws before deleting anything; new `PostgresReportingLedgerStore.assertCompactionSafeRowBindings()` exposes the check. The default key template already includes `{revision_key}` and is unaffected; compaction remains off by default.
