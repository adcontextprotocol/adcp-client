---
'@adcp/sdk': minor
---

Reporting ledger: a stuck period or upload can no longer hold back the rest, and account change-feed readers no longer depend on writer lock discipline.

`retireExpiredPeriods` now backs off a period whose external deletes fail (tombstone `attempts`, `next_attempt_at`, `last_failure`; one minute, doubling, capped at six hours), skips periods still backing off, and caps retries at half of each pass so fresh periods keep a share. The result gains `deferred` (periods backing off) and `stuck` (periods with five or more failures, with `attempts` and `cause`). `sweepRowWriteIntents` backs off failing intents the same way (`sweep_attempts`, `next_sweep_at`), takes never-failed intents first, and leaves intents for a binding this host does not configure untouched. Its result gains `skippedUnconfigured`, `deferred` and `overdue` (intents expired longer than the new `overdueAfterSeconds` option, default 24 hours, meaning no host is sweeping them and their objects leak). The shared maintenance helper now reports `stuck`, `deferred`, `skippedUnconfigured` and `overdue` through `onError` (`ReportingMaintenancePartialFailureError.warnings`), not only failed items. Re-apply `REPORTING_LEDGER_MIGRATION` and `REPORTING_ROW_STORAGE_MIGRATION` before upgrading: they add the new columns idempotently.

`changesAfter({ account_id })` now ends a page before the first change whose transaction has not finished (`xid` at or above the snapshot's `xmin`), as the deployment-wide feed already does, so a lower `seq` that commits after a higher one is never passed over. Any older open transaction on the cluster now holds both feeds back until it ends. A ledger database must have exactly one writer SDK; this is now documented in `docs/guides/REPORTING-LEDGER.md`.
