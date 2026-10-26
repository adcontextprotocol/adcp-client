---
'@adcp/sdk': minor
'@adcp/reporting-storage': minor
---

Support trusted-host reporting history before a configuration was installed (#3453). Pass `historyStart` in the service install context (or producer install options), and call `extendConfigurationHistory({ configurationId, historyStart })` to move ownership earlier without a new configuration generation. Source retention, schedule alignment, historical calendar compatibility, and generation overlap are validated. Coverage and consumer status include historical ownership while installedAt, fingerprints and existing publications stay unchanged.

Live planning and execution take priority over history. `maxHistorySlicesPerSource` defaults to 10 claims per source offering per worker pass; `maxHistoryObligationsPerSource` optionally bounds history planning. Zero pauses either history operation. Budgets are local to each pass; hosts and adapters still coordinate shared upstream quotas. Backfill retries have a durable private recovery window from the first execution attempt without changing public period-based deadlines.

Migration: upgrade the SDK and storage package together and reapply `REPORTING_LEDGER_MIGRATION` before starting the new workers. It adds the nullable `adcp_reporting_configurations.history_start` column idempotently; existing configurations keep their original ownership. Custom stores opting into history must persist the history boundary and ordinal, implement atomic monotonic extension with generation-overlap checks, and honor live-first claims and `excludeHistoryOfferingIds`. See the reporting ledger guide for the API and pacing contract.
