---
'@adcp/sdk': minor
---

Add period-aligned reporting retention. `PostgresReportingLedgerStore.retireExpiredPeriods({ statusRetentionDays, recordRetentionDays, limit })` retires whole periods once their end and latest publication are past the window and nothing holds them: it records a tombstone (new `adcp_reporting_obligation_tombstones` table in `REPORTING_LEDGER_MIGRATION`), deletes external row objects at their recorded versions, then deletes the period's rows and ledger records in one transaction. Retired periods are never re-planned (`listRetiredObligationOrdinals`, `ReportingLedgerPeriodRetiredError`), and `ledger_retained_from` advances past them. `sweepRowWriteIntents` deletes only objects an abandoned upload created and no commit references. The production service accepts `retention: { enabled: true, recordRetentionDays?, limit? }` and its scheduler now also sweeps abandoned row uploads and expired cursor snapshots and checkpoints.
