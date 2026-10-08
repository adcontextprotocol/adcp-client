---
'@adcp/sdk': minor
---

Add `PostgresReportingLedgerStore.migrateInlineRows({ limit, cursor, account_id })`, a resumable migration that moves legacy inline revision and adjustment rows into row storage. Each document is re-encoded, proven to reproduce its committed binding, written as chunks and stripped of inline rows in one transaction under the account lock. Documents whose rows no longer reproduce their binding are reported as `quarantined` and never rewritten. Row-storage errors now pass through the store's transaction wrapper with their `ReportingRowStoreError` code intact.
