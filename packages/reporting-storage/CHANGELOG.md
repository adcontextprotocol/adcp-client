# @adcp/reporting-storage

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
