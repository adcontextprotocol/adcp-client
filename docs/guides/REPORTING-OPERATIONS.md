# Reliable Reporting production operations

This runbook covers both the seller production service and the durable buyer
consumer runtime. Reliable Reporting controls evidence used for billing and
large media-spend decisions. Treat its PostgreSQL state, destination objects,
signing keys, and authentication registry as financial infrastructure.

## Production topology

Use one PostgreSQL primary with synchronous durability appropriate to the
business recovery point, automated backups, point-in-time recovery, and tested
restore procedures. Run multiple stateless SDK processes against it. Database
leases and fencing make duplicate workers safe; each process still needs
bounded provider and HTTP timeouts.

Seller processes should construct
`createPostgresReliableReportingProductionService`, install its returned
`platform`, start its coordinated scheduler, and stop accepting traffic before
awaiting `stop()` during shutdown. Buyer processes should construct
`createPostgresReportingConsumerRuntimeV1`, run all migrations and `probe()`,
then start the runtime only after their authenticated seller registry and
reconciliation dependencies are ready.

The seller scheduler services notification recovery before account production
on every pass. `notificationRecoveryLimit` defaults to 25 and
`webhookRecoveryLimit` defaults to 10. Size the former to at least
`ceil(peak committed events per interval / active replicas × 2)` and verify the
oldest pending age falls under sustained peak load. Keep both bounded because
shutdown waits for transport-timeout-bounded claims.

The pending notification cap is a correctness barrier: reaching it refuses the
ledger mutation instead of committing a fact whose advertised webhook could
never be recovered. Alert well before 70% of `maxPendingPerTenant`; raise the
cap only with measured PostgreSQL headroom, and increase recovery throughput
before increasing producer volume.

Never put bearer tokens, signing secrets, provider credentials, or destination
credentials in namespaces, account metadata, source scope, cursors, ledger
records, logs, or receipt evidence. Resolve them just in time from a secret
manager and bind authorization to authenticated transport context.

## Deployment and migration

1. Back up the database and record the current application and schema versions.
2. Stop old writers when the release notes declare a writer fence. Additive,
   idempotent migrations may otherwise be applied before rolling processes.
3. On first deploy, construct the service with `applyMigrations`. The callback
   receives the complete ordered SQL list before any probe, so hand it to your
   migration runner and execute it with the deployment's migration owner.
   `service.setup.migrations` is available only after successful construction;
   it is an audit view, not a way to collect first-deploy SQL. Once the tables
   are installed, a deployment may omit `applyMigrations` if its external
   migration process applies the same ordered statements before startup.
   Prefer one migration transaction where the platform permits it. Set explicit
   lock and statement timeouts and retry only after diagnosing a rollback.
4. Treat a migration, probe, policy-adoption, or
   capability-validation failure as a failed deployment; do not serve a reduced
   hand-authored capability document.
5. Start one canary, verify reads and worker progress for representative
   accounts, then roll the remaining instances.
6. Confirm old binaries are gone before enabling behavior that depends on new
   retained fields or fencing semantics.

Migrations are rerunnable and never authorize deleting or rebuilding reporting
tables. Roll forward after a failed application release. Do not downgrade a
writer across a retained-state compatibility fence.

The seller production composer requires `deploymentWide: true` for its
scheduler and explicit recovery pass. Its notification and webhook recovery
operate over the whole namespace; isolate namespaces and publisher scopes when
different operators own tenant partitions. For Reconciled Billing offerings,
provide `obligatedConsumers` from a trusted authorization roster. A missing or
incomplete roster cannot safely mark a billing obligation reconciled.

## Adopting row storage, retention and the change feed

Each of these features is opt-in and additive. Enable them one at a time on a
running deployment. See the [ledger guide](REPORTING-LEDGER.md#row-storage)
for configuration details.

1. **Row storage.** Apply `REPORTING_ROW_STORAGE_MIGRATION` (PostgreSQL 13+),
   or pass `rowStorage` to the production service, which adds it to
   `setup.migrations`. Roll out with `rowStorage` set. New revisions store
   verified chunks. Existing revisions keep their inline rows, and every
   binary built with row storage reads both forms. Do not run a writer older
   than this release once chunked revisions exist: it cannot read them.
2. **Existing inline rows (optional).** Run `migrateInlineRows` in bounded
   batches from a maintenance job until it returns no cursor. Alert on any
   `quarantined` IDs: those revisions no longer reproduce their committed
   binding and are left untouched for investigation. Then reclaim space with
   `VACUUM FULL` or an online repack in a maintenance window.
3. **Object storage.** Create a dedicated private bucket, container or prefix
   for rows, separate from Managed Delivery buckets. Configure the binding in
   host code and run `runReportingRowObjectProviderConformanceV1` against a
   test prefix first. S3 bucket versioning and Azure blob versioning are
   **required**, and the providers' probes refuse unversioned buckets and
   accounts: deletes must be fenced to one write, and ETags are content-derived,
   so an ETag-pinned delayed delete (for example an intent sweep) could remove a
   replacement object re-created with identical bytes at the same key. Deleting
   a specific `VersionId` permanently removes that version (no delete marker),
   so retention still frees storage. Do not
   attach lifecycle rules that can delete live rows sooner than
   `max(statusRetentionDays, recordRetentionDays)` plus the restatement window.
   The GCS probe refuses them; for S3 and Azure, policies outside the client's
   view are the operator's responsibility.
4. **Change feed.** Apply `REPORTING_LEDGER_CHANGES_MIGRATION` (PostgreSQL 13+)
   or pass `changeFeed`. Register each durable consumer with
   `saveFeedConsumerCursor`, and size `maxFeedHoldDays` so one stalled consumer
   cannot hold the table indefinitely.
5. **Warehouse sink.** Apply `REPORTING_WAREHOUSE_SINK_MIGRATION`, create the
   tables, and the `current_rows` view, then schedule `runOnce`. Point analysts
   at `current_rows`.
6. **Retention.** Enable `retention` last, after confirming the advertised
   `status_retention_days` is the window you intend to keep. Retirement deletes
   rows and ledger records for whole periods and cannot be undone. Keep backups
   for any longer audit requirement.

Alert on these row-storage signals:

- `ROWS_INTEGRITY_FAILED` or `ROWS_UNAVAILABLE` from reads. These are never
  normal, and buyers see `SERVICE_UNAVAILABLE` for the affected revision.
- A growing count of `adcp_reporting_row_write_intents` in `sweeping` state,
  or `sweepRowWriteIntents` reporting failures. Provider deletes are failing.
- `retireExpiredPeriods` returning `failed` IDs. Usually a binding was removed
  from configuration while revisions still reference it; keep retired bindings
  configured.
- `ReportingChangeCursorExpiredError` in a consumer. That consumer fell behind
  retention and must resynchronize from `listCurrentRevisions`.
- A non-empty `missing` from the warehouse sink's `runOnce()`. The sink was down
  longer than `maxFeedHoldDays`, retention stopped waiting for it, and the
  warehouse lacks those revisions. Backfill them or accept the gap, and keep
  `maxFeedHoldDays` above your longest tolerated sink outage.

## Service objectives and alerts

Choose targets stricter than contractual delivery SLAs. A reasonable starting
point is:

| Signal | Target | Page when |
| --- | --- | --- |
| Core obligation materialization | before `expected_at`; 99.9% inside the advertised recovery window | oldest actionable obligation threatens its recovery deadline |
| Managed Delivery | 99.9% before delivery SLA | oldest pending/leased materialization threatens SLA or leases repeatedly expire |
| Webhook delivery | 99.9% successful or terminally classified inside 15 minutes | retry age exceeds 10 minutes or failure rate exceeds 1% for 10 minutes |
| Buyer reconciliation | every active account checked inside two poll intervals | lease makes no progress for three intervals or cursor is unchanged while seller head advances |
| API availability | 99.95% excluding rejected invalid/auth requests | error budget burn exceeds the deployment policy |
| Recovery point | at most 5 minutes of database state | replica/archive lag exceeds the target |
| Recovery time | restore and resume within 60 minutes | quarterly restore exercise misses the target |

At minimum export counts and oldest-age gauges for pending obligations,
materializations, receipt batches, notification activity, webhook attempts,
buyer pending status, notification dedupe rows, lease expiry, retries, terminal
failures, and pruning. Break them down by non-secret tenant/account identifiers
with bounded cardinality. Alert on worker-loop errors, probe failures, policy
disagreement, clock skew, PostgreSQL saturation, deadlocks, and destination
authorization failures.

Logs must include a request/trace ID, account ID, obligation/revision or event
ID, attempt number, result class, and latency. They must not include request
authorization, webhook query strings, response bodies, source rows, or raw
provider errors. Error observers are isolated; configure
`webhooks.onAttemptObserverError` and page on observer failure because
it can otherwise hide degraded telemetry.

## Capacity planning

Size from measured rows, not account count alone. Forecast daily growth as:

`obligations + revisions + adjustments + materializations + revision/adjustment receipts + event attempts + buyer checkpoints`

multiplied by average row/index/WAL bytes and retention days. Attempt-ordinal
counters share the webhook-activity retention window and are pruned only after
their last activity row disappears. Include failed
attempts and revision churn in peak estimates. Keep database storage below 70%
and provision IOPS for the larger of peak source settlement and webhook retry
recovery. Load-test at least twice forecast peak accounts, periods, notification
fan-out, and row/object sizes. Confirm that one hot tenant cannot starve the
next tenant; planning and notification recovery use durable rotating cursors,
but provider quotas still need per-adapter limits.

Buyer receipt checkpoints and unconfirmed pending consumer statuses are not
time-pruned by the SDK. Forecast them as retained evidence, not as
retention-days churn. Archive rows only after the authenticated seller ledger
confirms the corresponding receipt/status and your evidence-retention window
has elapsed; pending status is cleared automatically when confirmation is read.

Keep the worker interval well below the smallest delivery SLA. Set per-account
planning and worker iteration limits so a turn completes inside one interval.
Tune PostgreSQL pool size from concurrent transaction demand; do not create a
connection per account or hold a database transaction across provider, object
store, or webhook network I/O.

## Backup and recovery

Back up the complete reporting database, including Core, Managed Delivery,
receipt, outbox/activity, subscription, webhook-attempt, buyer checkpoint,
cursor, dedupe, and lease tables. Back up destination manifests and immutable
objects under their advertised retention policy. Retain the configuration,
schema, report-definition, canonicalization, and signing-key history required
to verify those objects.

Quarterly, restore into an isolated environment and verify:

- migrations and every `probe()` succeed;
- stable snapshots, exact revisions, adjustments, materializations, and both receipt kinds remain readable;
- notification recovery resumes without duplicate logical events;
- buyer cursors/checkpoints resume and duplicate notification keys remain deduped;
- a new lease fences an expired owner;
- sampled manifest and canonical-content digests still verify;
- sampled chunked revisions read back through `getRevision`, including rows in
  object-storage bindings.

Row objects live outside the database. A database restore and the matching
row buckets must come from the same point in time, or revisions committed
after the bucket snapshot read as `ROWS_UNAVAILABLE`. A restored replica of
the same authority keeps its installation identity. An independently writable
clone, such as staging restored from production, must mint a new
`adcp_persistence_installation` row and use new bindings before it writes or
sweeps, so it can never delete production objects.

After regional failover, fence the old primary before enabling writers. Ensure
database time is healthy, then start canary workers and watch lease generation,
oldest-work age, and duplicate conflicts. Webhooks and receipt writes are
at-least-once: preserve idempotency state and expect safe replays.

## Incident playbooks

Database unavailable: stop readiness, retain traffic only if the endpoint can
fail closed without claiming work, and do not fall back to memory. Restore the
database, run probes, then let fenced leases and durable outboxes recover.

Provider or destination outage: keep obligations and materializations pending,
honor retry/backoff limits, and surface delayed/action-required health. Never
publish empty rows as a fallback and never mark unverified delivery available.

Webhook outage: keep the persistent queue, verify endpoint authorization again
on every attempt, and recover with bounded concurrency. Do not manually replay
by constructing a new logical event; use the retained event/idempotency key.

Digest or receipt mismatch: stop financial automation for the affected scope,
preserve both sides' evidence, and investigate canonicalization, object
immutability, and revision identity. Do not overwrite or delete the conflicting
record. Resolve through a new revision/adjustment and the protocol lifecycle.

Buyer stuck or ambiguous notification scope: polling remains authoritative.
Disable notification-triggered acceleration if necessary, retain dedupe rows,
and repair the authenticated seller/principal registry before resuming. Never
choose an account based only on an untrusted webhook body.

Row-storage integrity failure: stop serving the affected scope and do not
re-upload over the recorded object. Compare the stored object's bytes and
version with the chunk manifest, restore the exact recorded version from bucket
versioning or backups, and verify by reading the revision through `getRevision`.
Never edit a chunk manifest or digest to match the stored bytes.

Clock skew: remove the host from service. Lease and event times use PostgreSQL
where correctness needs a shared clock, while provider deadlines and process
timeouts still depend on healthy host clocks.

## Pre-production release gate

- Run the complete real-PostgreSQL reporting suites, migration reruns, build,
  CommonJS and ESM package-import smoke tests, and the shared cross-SDK fixtures.
- Exercise kill/restart at source settlement, managed delivery, receipt write,
  notification reservation, HTTP completion, buyer checkpoint, and lease renewal boundaries.
- Load-test tenant fairness, retry storms, database failover, and graceful shutdown.
- Review authentication, tenancy, signing, SSRF, idempotency, migration, and
  retention changes with independent protocol and security reviewers.
- Capture dashboards, pages, runbook ownership, restore evidence, and capacity
  headroom before enabling financial decisions.

For the optional GCS provider write-fence primitive and its bucket policy, inventory retention and cancellation requirements, see [Durable GCS reporting write fence](REPORTING-GCS-FENCE.md). Complete managed delivery integration remains a separate step.

For complete GCS file-transfer delivery, private contracts and scoped buyer readers, see [Managed reporting delivery on GCS](REPORTING-GCS-MANAGED.md).
