---
'@adcp/sdk': minor
---

Add host reads to `PostgresReportingLedgerStore`: `getCurrentRevision`, `listCurrentRevisions` (period-range paging of current revision headers), and a gap-free change feed. With `changeFeed: true` and the new `REPORTING_LEDGER_CHANGES_MIGRATION` (PostgreSQL 13+), the store appends obligation, revision, adjustment and retirement changes in the same transaction as each record; `changesAfter` serves account feeds in commit order and a deployment-wide feed ordered by `(xid, seq)` that never skips a slower commit. `saveFeedConsumerCursor` registers durable consumers that hold back `pruneChanges`, and expired cursors throw `ReportingChangeCursorExpiredError`. The production service accepts `changeFeed` and prunes the feed on its scheduler.
