# @adcp/reporting-storage

## 0.2.0

### Minor Changes

- eaaa07f: Discover and cache the BigQuery dataset location on the first warehouse sink run when `location` is omitted. Use it for load submissions and replay job lookups so regional datasets work without an explicit location. Metadata failures stop the run before warehouse work and identify the required permission and explicit `location` option. Explicit locations continue to skip metadata access.

  Migration: sinks that omit `location`, including US/EU datasets, now need `bigquery.datasets.get` and a client wrapper exposing `dataset.getMetadata()`. Set `location` explicitly to skip that requirement. Empty location strings are rejected; omit the option to discover it. The `ADCP_BIGQUERY_SINK_LOCATION_UNSET` warning is replaced by discovery and actionable failures. No database migration is required.

### Patch Changes

- Updated dependencies [eaaa07f]
- Updated dependencies [47934c6]
- Updated dependencies [5a0a03f]
- Updated dependencies [a31d162]
- Updated dependencies [e678796]
- Updated dependencies [ba711f1]
- Updated dependencies [acddab4]
- Updated dependencies [4f5d366]
- Updated dependencies [7dca440]
- Updated dependencies [7dca440]
- Updated dependencies [7d272f9]
- Updated dependencies [6c281d9]
- Updated dependencies [a008b4e]
- Updated dependencies [7f7de7c]
- Updated dependencies [3d53212]
- Updated dependencies [1dcd427]
- Updated dependencies [7b181ff]
- Updated dependencies [8c97223]
- Updated dependencies [80cec20]
  - @adcp/sdk@16.5.0

## 0.1.0

### Minor Changes

- 4a79162: Reliable Reporting: the account change feed now orders by `(xid, seq)` behind `xid < pg_snapshot_xmin(pg_current_snapshot())`, as the deployment-wide feed already did (#3283). The feed no longer depends on the account lock to keep `seq` in commit order, and the in-flight truncation guard from #3228 is gone. A change with a lower `seq` and a higher `xid` that commits late is returned on a later page, after the cursor, instead of being skipped. This is an `@experimental` surface, so the break ships as a minor.

  **Migration note.**
  - Re-apply `REPORTING_LEDGER_CHANGES_MIGRATION` before starting the new binary. It is idempotent. It adds `pruned_through_xid` and `pruned_through_xid_seq` to `adcp_reporting_change_account_horizon`, replaces the `adcp_reporting_feed_consumers` check constraint (an account consumer may now carry an `xid`, and a pre-upgrade account row keeps a NULL one), creates the `adcp_reporting_changes_account_xid (account_id, xid, seq)` index, and takes an advisory lock so concurrent appliers cannot race. The old `adcp_reporting_changes_account (account_id, seq)` index is left in place; drop it once no older host runs.
  - On a large changes table, create the index first with `CREATE INDEX CONCURRENTLY IF NOT EXISTS adcp_reporting_changes_account_xid ON adcp_reporting_changes (account_id, xid, seq)`; a plain `CREATE INDEX` in the migration blocks appends while it builds.
  - Stop the older hosts' change-feed maintenance (`pruneChanges`, `retireExpiredPeriods`, compaction) before the new binary reads an account feed. The older code holds an account consumer's changes by `seq` alone and records only `pruned_through_seq`, so it could prune a change a new-format cursor has not read without advancing the horizon the new reader checks. Rolling back after a consumer saved a new-format account cursor is not supported: the older SDK rejects it, so reset those consumers.
  - Account cursors now carry `xid` (`{ v, account, seq, xid }`). Consumers store the cursor string opaquely and need no change.
  - An account cursor saved before the upgrade (`seq` only) is accepted. `changesAfter` maps it to `(xid, seq)` with `xid` the smaller of the oldest `xid` among the account's changes after that `seq` and the reading snapshot's `xmin`. Every later change has an `xid` at or above both, so none is skipped. Changes the consumer already read can be returned again (those with a lower `seq` and a higher `xid`, and, if a long transaction was open at that moment, every change committed since it began), so consumers must treat redelivery as normal. The returned cursor is in the new format. A legacy cursor fails closed with `CURSOR_EXPIRED` (resynchronize from `listCurrentRevisions`) if any change with a higher `seq` was pruned. A consumer registration saved before the upgrade holds retention by `seq` until its next `saveFeedConsumerCursor`.
  - `pruneChanges` (which now selects victims in `(xid, seq)` order), `retireExpiredPeriods` and snapshot compaction now hold a change for an account consumer until the consumer has passed it in `(xid, seq)` order. BigQuery sinks need no change: their saved account cursor is upgraded on the next batch.
  - Any older open transaction on the cluster now holds the account feed back, as it already held the deployment feed. An empty page means caught up or held back.

- 01cd708: Initial release of `@adcp/reporting-storage`: the Reliable Reporting storage implementations, split out of `@adcp/sdk` (adcp-client#3286) so they release on their own version line.

  It holds `PostgresReportingLedgerStore` and its migrations, row storage (PostgreSQL and object kinds, the provider contract, the conformance suite and the filesystem provider), object writes, the host change feed and ledger maintenance (`@adcp/reporting-storage`); the managed-delivery runtime, store and adapter router (`/managed`); notification activity (`/notifications`); `createPostgresReliableReportingProductionService` (`/service`); the GCS, S3 and Azure providers (`/gcs`, `/s3`, `/azure`); and the BigQuery warehouse sink (`/bigquery`). `reportingLedgerMaintenance` builds the `maintenance` option of `createReliableReportingService` for a PostgreSQL ledger.

  `@adcp/sdk` (`^16.0.0-beta.0`) is a peer dependency, so the host holds one copy of the protocol layer. `@aws-sdk/client-s3`, `@azure/storage-blob` and `@google-cloud/storage` are optional peers. The package ships CommonJS and ESM builds with declarations for both.

  The package starts at `0.0.0` so this changeset sets its first version: under pre-release mode it publishes as `0.1.0-beta.0` on the `beta` dist-tag. It is pre-1.0 on purpose: every export is `@experimental`, breaking changes ship in minor releases with a migration note, and the first stable release is `1.0.0` once the surface has run at a production adopter (`docs/guides/REPORTING-STABILITY.md`). Pin it with `~`.

  Moving from `@adcp/sdk/reporting/*`? See `docs/migration-reporting-storage-package.md` for the import mapping.

- 062bfd0: Reliable Reporting: add an opt-in listing collector for row objects the write-intent sweep cannot see (#3284). It covers an upload whose `PUT` succeeded before the intent recorded it, intents for a binding no running host configures, and intents lost to a database restore.
  - `PostgresReportingLedgerStore.collectOrphanedRowObjects` lists each configured object binding under `{prefix}/{namespace_key}/` and deletes an object only when its key is a `.jsonl` or `.jsonl.gz` row object under that prefix, it is older than `minAgeSeconds` (default 7 days, minimum 1 day), no row set that is not yet `pruned` has a chunk at the key and no write intent lists it, and, under the per-object advisory lock and exact-version reference check that every other delete takes (`deleteUnreferencedObjects`), nothing live references that version. `readOnly` bindings are skipped unless `includeReadOnly`; `dryRun` reports `candidates` and deletes nothing; `limit` bounds objects examined per binding per pass and `cursors` resume the listing.
  - Enable it in the scheduler with `orphanCollection: { enabled: true, acknowledgeExclusiveNamespace: true, ... }` on the production service, or `reportingLedgerMaintenance({ orphanCollection })` as the `maintenance` option of the Core-only service. Deleting requires `acknowledgeExclusiveNamespace: true` (a dry run does not). `intervalSeconds` (default one day) spaces full listings; a listing that does not finish within `limit` continues on the next pass. The task is named `orphan object collection`, reports listed, referenced, too young, foreign, deleted and failed counts, and warns about failed bindings and bindings whose provider cannot list. Its position (`orphanState`) is kept in the process, so a restart begins a new listing. `ReportingLedgerMaintenanceTaskNameV1` and the task result union gain `'orphan object collection'`, so an exhaustive `switch` over task names stops compiling until it handles it.
  - References are checked under every binding, because two bindings can share a bucket and prefix. Entries a provider returns that are not row-object keys under the owned prefix, or have no strict RFC 3339 write time, are never touched. A listing that fails on the first page of a resumed cursor restarts from the beginning instead of wedging, and a provider that repeats a page token or returns more than a page is failed rather than looped on.
  - `ReportingRowObjectProviderV1` gains an optional `list({ prefix, pageToken, pageSize })` returning each stored version under a prefix with its native version, size and write time. The filesystem, GCS, S3 and Azure Blob providers implement it (on versioned stores it lists noncurrent versions too and never delete markers), and `runReportingRowObjectProviderConformanceV1` checks it when present and then reports a `list` entry in its result. A custom provider without `list` keeps working; its binding is reported as unsupported by the collector.
  - Migration note: the conformance result gains a `list` entry for providers that implement `list`, so code that compares the whole array must expect it. Enable the collector only on the ledger database that owns the namespace; a clone or restore of that database pointed at the same bucket shares its namespace key and would delete the objects of row sets the original wrote after the copy. Start with `dryRun: true`. See `docs/guides/REPORTING-OPERATIONS.md`.

### Patch Changes

- Updated dependencies [9be4bc0]
- Updated dependencies [b6e98e2]
- Updated dependencies [e8e2b32]
- Updated dependencies [5b1d06c]
- Updated dependencies [67c6f1e]
- Updated dependencies [5282446]
- Updated dependencies [eb763e2]
- Updated dependencies [6485148]
- Updated dependencies [af1cda5]
- Updated dependencies [7c7f730]
- Updated dependencies [44305aa]
- Updated dependencies [01c2522]
- Updated dependencies [613aa77]
- Updated dependencies [01c2522]
- Updated dependencies [1159cd0]
- Updated dependencies [6152eeb]
- Updated dependencies [d450b7d]
- Updated dependencies [22fe878]
- Updated dependencies [f8bd48c]
- Updated dependencies [61360e4]
- Updated dependencies [ed6eefd]
- Updated dependencies [6f491ef]
- Updated dependencies [b7d1156]
- Updated dependencies [8946228]
- Updated dependencies [6129906]
- Updated dependencies [2a0fa78]
- Updated dependencies [b928628]
- Updated dependencies [2a0fa78]
- Updated dependencies [6326b54]
- Updated dependencies [7599c4d]
- Updated dependencies [90efe10]
- Updated dependencies [656022f]
- Updated dependencies [8cb06d2]
- Updated dependencies [75a6943]
- Updated dependencies [217d113]
- Updated dependencies [bb3ed66]
- Updated dependencies [55feb1c]
- Updated dependencies [11f3913]
- Updated dependencies [9a23e5b]
- Updated dependencies [1ecb660]
- Updated dependencies [d6fe8b1]
- Updated dependencies [bdaf068]
- Updated dependencies [a2b62ac]
- Updated dependencies [18ad969]
- Updated dependencies [cfa5173]
- Updated dependencies [10fac80]
- Updated dependencies [ba8151d]
- Updated dependencies [d24f791]
- Updated dependencies [cf9803b]
- Updated dependencies [61360e4]
- Updated dependencies [12f2660]
- Updated dependencies [5a7d2b4]
- Updated dependencies [891ed2d]
- Updated dependencies [aba77ed]
- Updated dependencies [01cd708]
- Updated dependencies [5b1d06c]
- Updated dependencies [28ced9e]
- Updated dependencies [dfc9c4b]
- Updated dependencies [daf93e7]
- Updated dependencies [83741da]
- Updated dependencies [cf9803b]
- Updated dependencies [32f89ff]
- Updated dependencies [e4eb640]
- Updated dependencies [7caa852]
- Updated dependencies [017160c]
  - @adcp/sdk@16.0.0

## 0.1.0-beta.0

### Minor Changes

- 4a79162: Reliable Reporting: the account change feed now orders by `(xid, seq)` behind `xid < pg_snapshot_xmin(pg_current_snapshot())`, as the deployment-wide feed already did (#3283). The feed no longer depends on the account lock to keep `seq` in commit order, and the in-flight truncation guard from #3228 is gone. A change with a lower `seq` and a higher `xid` that commits late is returned on a later page, after the cursor, instead of being skipped. This is an `@experimental` surface, so the break ships as a minor.

  **Migration note.**
  - Re-apply `REPORTING_LEDGER_CHANGES_MIGRATION` before starting the new binary. It is idempotent. It adds `pruned_through_xid` and `pruned_through_xid_seq` to `adcp_reporting_change_account_horizon`, replaces the `adcp_reporting_feed_consumers` check constraint (an account consumer may now carry an `xid`, and a pre-upgrade account row keeps a NULL one), creates the `adcp_reporting_changes_account_xid (account_id, xid, seq)` index, and takes an advisory lock so concurrent appliers cannot race. The old `adcp_reporting_changes_account (account_id, seq)` index is left in place; drop it once no older host runs.
  - On a large changes table, create the index first with `CREATE INDEX CONCURRENTLY IF NOT EXISTS adcp_reporting_changes_account_xid ON adcp_reporting_changes (account_id, xid, seq)`; a plain `CREATE INDEX` in the migration blocks appends while it builds.
  - Stop the older hosts' change-feed maintenance (`pruneChanges`, `retireExpiredPeriods`, compaction) before the new binary reads an account feed. The older code holds an account consumer's changes by `seq` alone and records only `pruned_through_seq`, so it could prune a change a new-format cursor has not read without advancing the horizon the new reader checks. Rolling back after a consumer saved a new-format account cursor is not supported: the older SDK rejects it, so reset those consumers.
  - Account cursors now carry `xid` (`{ v, account, seq, xid }`). Consumers store the cursor string opaquely and need no change.
  - An account cursor saved before the upgrade (`seq` only) is accepted. `changesAfter` maps it to `(xid, seq)` with `xid` the smaller of the oldest `xid` among the account's changes after that `seq` and the reading snapshot's `xmin`. Every later change has an `xid` at or above both, so none is skipped. Changes the consumer already read can be returned again (those with a lower `seq` and a higher `xid`, and, if a long transaction was open at that moment, every change committed since it began), so consumers must treat redelivery as normal. The returned cursor is in the new format. A legacy cursor fails closed with `CURSOR_EXPIRED` (resynchronize from `listCurrentRevisions`) if any change with a higher `seq` was pruned. A consumer registration saved before the upgrade holds retention by `seq` until its next `saveFeedConsumerCursor`.
  - `pruneChanges` (which now selects victims in `(xid, seq)` order), `retireExpiredPeriods` and snapshot compaction now hold a change for an account consumer until the consumer has passed it in `(xid, seq)` order. BigQuery sinks need no change: their saved account cursor is upgraded on the next batch.
  - Any older open transaction on the cluster now holds the account feed back, as it already held the deployment feed. An empty page means caught up or held back.

- 01cd708: Initial release of `@adcp/reporting-storage`: the Reliable Reporting storage implementations, split out of `@adcp/sdk` (adcp-client#3286) so they release on their own version line.

  It holds `PostgresReportingLedgerStore` and its migrations, row storage (PostgreSQL and object kinds, the provider contract, the conformance suite and the filesystem provider), object writes, the host change feed and ledger maintenance (`@adcp/reporting-storage`); the managed-delivery runtime, store and adapter router (`/managed`); notification activity (`/notifications`); `createPostgresReliableReportingProductionService` (`/service`); the GCS, S3 and Azure providers (`/gcs`, `/s3`, `/azure`); and the BigQuery warehouse sink (`/bigquery`). `reportingLedgerMaintenance` builds the `maintenance` option of `createReliableReportingService` for a PostgreSQL ledger.

  `@adcp/sdk` (`^16.0.0-beta.0`) is a peer dependency, so the host holds one copy of the protocol layer. `@aws-sdk/client-s3`, `@azure/storage-blob` and `@google-cloud/storage` are optional peers. The package ships CommonJS and ESM builds with declarations for both.

  The package starts at `0.0.0` so this changeset sets its first version: under pre-release mode it publishes as `0.1.0-beta.0` on the `beta` dist-tag. It is pre-1.0 on purpose: every export is `@experimental`, breaking changes ship in minor releases with a migration note, and the first stable release is `1.0.0` once the surface has run at a production adopter (`docs/guides/REPORTING-STABILITY.md`). Pin it with `~`.

  Moving from `@adcp/sdk/reporting/*`? See `docs/migration-reporting-storage-package.md` for the import mapping.

- 062bfd0: Reliable Reporting: add an opt-in listing collector for row objects the write-intent sweep cannot see (#3284). It covers an upload whose `PUT` succeeded before the intent recorded it, intents for a binding no running host configures, and intents lost to a database restore.
  - `PostgresReportingLedgerStore.collectOrphanedRowObjects` lists each configured object binding under `{prefix}/{namespace_key}/` and deletes an object only when its key is a `.jsonl` or `.jsonl.gz` row object under that prefix, it is older than `minAgeSeconds` (default 7 days, minimum 1 day), no row set that is not yet `pruned` has a chunk at the key and no write intent lists it, and, under the per-object advisory lock and exact-version reference check that every other delete takes (`deleteUnreferencedObjects`), nothing live references that version. `readOnly` bindings are skipped unless `includeReadOnly`; `dryRun` reports `candidates` and deletes nothing; `limit` bounds objects examined per binding per pass and `cursors` resume the listing.
  - Enable it in the scheduler with `orphanCollection: { enabled: true, acknowledgeExclusiveNamespace: true, ... }` on the production service, or `reportingLedgerMaintenance({ orphanCollection })` as the `maintenance` option of the Core-only service. Deleting requires `acknowledgeExclusiveNamespace: true` (a dry run does not). `intervalSeconds` (default one day) spaces full listings; a listing that does not finish within `limit` continues on the next pass. The task is named `orphan object collection`, reports listed, referenced, too young, foreign, deleted and failed counts, and warns about failed bindings and bindings whose provider cannot list. Its position (`orphanState`) is kept in the process, so a restart begins a new listing. `ReportingLedgerMaintenanceTaskNameV1` and the task result union gain `'orphan object collection'`, so an exhaustive `switch` over task names stops compiling until it handles it.
  - References are checked under every binding, because two bindings can share a bucket and prefix. Entries a provider returns that are not row-object keys under the owned prefix, or have no strict RFC 3339 write time, are never touched. A listing that fails on the first page of a resumed cursor restarts from the beginning instead of wedging, and a provider that repeats a page token or returns more than a page is failed rather than looped on.
  - `ReportingRowObjectProviderV1` gains an optional `list({ prefix, pageToken, pageSize })` returning each stored version under a prefix with its native version, size and write time. The filesystem, GCS, S3 and Azure Blob providers implement it (on versioned stores it lists noncurrent versions too and never delete markers), and `runReportingRowObjectProviderConformanceV1` checks it when present and then reports a `list` entry in its result. A custom provider without `list` keeps working; its binding is reported as unsupported by the collector.
  - Migration note: the conformance result gains a `list` entry for providers that implement `list`, so code that compares the whole array must expect it. Enable the collector only on the ledger database that owns the namespace; a clone or restore of that database pointed at the same bucket shares its namespace key and would delete the objects of row sets the original wrote after the copy. Start with `dryRun: true`. See `docs/guides/REPORTING-OPERATIONS.md`.

### Patch Changes

- Updated dependencies [2a0fa78]
- Updated dependencies [2a0fa78]
- Updated dependencies [bdaf068]
- Updated dependencies [891ed2d]
- Updated dependencies [01cd708]
- Updated dependencies [daf93e7]
- Updated dependencies [e4eb640]
  - @adcp/sdk@16.0.0-beta.4
