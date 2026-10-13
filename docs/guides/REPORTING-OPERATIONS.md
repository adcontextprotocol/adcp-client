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

Running Core only, without the production service? Pass `maintenance` to
`createReliableReportingService` so its scheduler (or `runMaintenance()`) does
the retention, change-feed pruning and abandoned-upload sweeps the production
service runs for you. See
[Core-only setup](REPORTING-LEDGER.md#core-only-setup-with-row-storage-change-feed-and-retention).

1. **Row storage.** Apply `REPORTING_ROW_STORAGE_MIGRATION` (PostgreSQL 13+),
   or pass `rowStorage` to the production service, which adds it to
   `setup.migrations`. Roll out with `rowStorage` set. New revisions store
   verified chunks. Existing revisions keep their inline rows, and every
   binary built with row storage reads both forms. Do not run a writer older
   than this release once chunked revisions exist: it cannot read them.
   Upgrading from 15.8.x? Row storage renamed its stored fields to AdCP's
   names; re-apply the migration before starting new binaries (see
   [Breaking: reporting row storage field alignment](../migration-reporting-row-storage-alignment.md)).
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
   `saveFeedConsumerCursor` (checkpoints are forward-only; pass `{ rewind: true }`
   to move a consumer back), and size `maxFeedHoldDays` so one stalled consumer
   cannot hold the table indefinitely.
5. **Warehouse sink.** Apply `REPORTING_WAREHOUSE_SINK_MIGRATION`, create the
   tables, and the `current_rows` view, then schedule `runOnce`. Point analysts
   at `current_rows`.
6. **Retention.** Enable `retention` last, after confirming the advertised
   `status_retention_days` is the window you intend to keep. Retirement deletes
   rows and ledger records for whole periods and cannot be undone. Keep backups
   for any longer audit requirement.
7. **Snapshot compaction (optional).** Off by default; enable `compaction`
   (`maintenance.compaction` on the Core-only service) only to reclaim the
   content of superseded snapshots. Do not enable it in production before the
   next eligible AdCP minor after November 20, 2026, when the protocol takes
   compaction into effect. Roll it out after retention, with a small `limit`,
   and watch the `snapshot compaction` task's `failed` IDs. See
   [Compacting superseded snapshots](REPORTING-LEDGER.md#compacting-superseded-snapshots-opt-in)
   for the rule and what it keeps. Compaction cannot be undone; backups hold
   any longer evidence.

Alert on these row-storage signals:

- `ROWS_INTEGRITY_FAILED` or `ROWS_UNAVAILABLE` from reads. These are never
  normal, and buyers see `SERVICE_UNAVAILABLE` for the affected revision.
- A growing count of `adcp_reporting_row_write_intents` in `sweeping` state,
  or `sweepRowWriteIntents` reporting failures. Provider deletes are failing;
  failed intents back off (one minute, doubling, capped at six hours) rather than
  blocking others. `skippedUnconfigured` counts expired uploads whose binding this
  host does not configure, and `overdue` (expired more than 24 hours ago, still
  unswept) means no host is handling them and their objects are leaking. The
  maintenance helper reports both through `onError`.
- The `snapshot compaction` task reporting `failed` revisions. Provider deletes
  are failing; the revisions stay `pruning` (reads already answer not-found) and
  the next pass resumes them.
- `retireExpiredPeriods` returning `failed` IDs or a non-empty `stuck` list.
  Usually a binding was removed from configuration while revisions still
  reference it; keep retired bindings configured. A failing period retries with
  backoff (up to six hours) and does not block other periods; `stuck` lists
  those that have failed five or more times, with their cause.
- `ReportingChangeCursorExpiredError` (`code === 'CURSOR_EXPIRED'`) in a
  consumer. Usually it fell behind retention and must resynchronize from
  `listCurrentRevisions`. A first read with no cursor can also throw it when a
  prune commits mid-read; retry it. A new warehouse sink stuck on it after such
  a race recovers with `sink.reset()`.
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

Multi-transport managed delivery: when one runtime delivers through several
transports behind the managed-delivery router, key alerts on the per-route
worker counts (`deliveryFailuresByRoute`, `revocationFailuresByRoute`,
`overdueByRoute`) instead of the totals, so one failing transport is not
averaged away. A non-zero `~unrouted` count is a configuration problem, not a
provider outage: a binding or destination authorization has no route (often a
legacy authorization with no recorded transport and no `legacyDefault`). List
those authorizations with `listDestinationAuthorizationsWithoutContract()`,
then add the route or a `legacyDefault`. A startup probe failure names the
failing route; fix that route's provider access before restarting, because
offerings are not withdrawn at runtime. See "Multi-transport delivery with the
router" in `REPORTING-LEDGER.md`.

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

## Live GCP validation

`scripts/validate-reporting-gcp.mjs` runs the built SDK against a real BigQuery
project and a real GCS bucket. The in-memory doubles in the test suite cannot
prove how BigQuery names jobs, where it stores load options, or what a real
bucket policy looks like; this script does. It is not published with the
package, so run it from a repository checkout.

What it checks:

- **BigQuery warehouse sink** (`@adcp/sdk/reporting/bigquery`). It applies the
  ledger migrations into fresh PostgreSQL schemas, commits revisions, creates a
  uniquely named dataset in the destination project from `defaultTablesSql` and
  `currentRowsViewSql`, and runs the sink. It verifies row and revision counts
  and the JSON `row` column by query, that the load jobs exist in the
  destination project and location under the deterministic job IDs, that a
  crash after the rows load (an injected failing revisions load) replays with no
  duplicate rows, and that `current_rows` returns one revision per obligation.
  It also asserts (`PASS`/`FAIL`) that the sink sends no `labels` or
  `jobTimeoutMs` inside `configuration.load`, where BigQuery silently drops
  them, and that a job cancel addressed with the destination project and
  location (what the sink sends when a load passes its client-side deadline) is
  accepted by BigQuery.
- **Overlapping runs** (`INFO`, never a failure). Two concurrent `runOnce()`
  calls over one pending batch, and a deterministic reproduction of #3196: one
  run reads its sink state, another completes the batch and a new revision
  commits, then the first resumes. Without the fence the first run reloads
  revisions the second already loaded (duplicate rows); with the fence from
  PR #3197 it rejects as stale and nothing duplicates. Read the verdict in the
  report; the exit status does not depend on it.
- **Cross-project.** Set `GCP_CLIENT_PROJECT` to a project other than
  `GCP_BQ_PROJECT`. Load jobs are then created in the destination project, and
  the crash replay fails if the "job already exists" status check looks in the
  client's default project instead.
- **GCS row provider** (`@adcp/sdk/reporting/gcs`). It prints the bucket policy,
  runs the provider probe (uniform bucket-level access, public access
  prevention, lifecycle rules) and `runReportingRowObjectProviderConformanceV1`,
  then commits a revision through an object binding on the bucket and reads it
  back verified (full read, ranged page, a second store instance, and a replayed
  commit that uploads nothing).

Everything it creates carries a per-run id: a dataset named
`<GCP_DATASET_PREFIX><run id>`, objects under `<GCS_PREFIX>/<run id>/`, and
PostgreSQL schemas `adcp_validation_<run id>_*`. All of it is deleted in
`finally` (and on Ctrl-C) unless `KEEP=1`. Deletion is limited to those names:
the script refuses to delete a dataset without the prefix, an object outside
the run prefix, or a schema without the run id.

### Setup

```bash
npm ci && npm run build
# Optional peers; --no-save leaves package.json alone.
npm install --no-save @google-cloud/bigquery @google-cloud/storage
```

Use Application Default Credentials (workload identity,
`gcloud auth application-default login`, or `GOOGLE_APPLICATION_CREDENTIALS`).
The script never reads, writes or prints credentials, and it redacts the
PostgreSQL URL and bearer tokens from anything it prints. If a peer package is
missing it prints the install command and exits with status 2.

| Variable                                                             | Required                 | Meaning                                                                                                                                                              |
| -------------------------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REPORTING_LEDGER_PG_URL`                                            | yes                      | PostgreSQL the ledger runs on. The role must be able to create and drop schemas.                                                                                     |
| `GCP_BQ_PROJECT`                                                     | unless `--skip-bigquery` | Destination project for the temporary dataset.                                                                                                                       |
| `GCP_BQ_LOCATION`                                                    | no (`US`)                | Dataset and job location.                                                                                                                                            |
| `GCP_CLIENT_PROJECT`                                                 | no                       | The BigQuery client's default project (billing project for queries and DDL). Set it different from `GCP_BQ_PROJECT` to exercise the cross-project path.             |
| `GCP_DATASET_PREFIX`                                                 | no (`adcp_sink_validation_`) | Dataset name prefix.                                                                                                                                     |
| `GCS_BUCKET`                                                         | unless `--skip-gcs`      | Bucket under test. Its policy must satisfy the row-provider probe.                                                                                                   |
| `GCS_PREFIX`                                                         | no (`adcp-reporting-validation`) | A prefix you own for the test; a unique run folder is created beneath it.                                                                                    |
| `KEEP=1`                                                             | no                       | Keep the dataset, objects and schemas, and print how to remove them.                                                                                                 |
| `ADCP_SDK_ROOT`                                                      | no                       | Another built checkout whose `dist/` is tested (see below).                                                                                                          |
| `--yes` or `CONFIRM=1`                                               | yes                      | Acknowledge the preflight; without it nothing is created and the exit status is 2.                                                                                   |
| `--skip-bigquery`, `--skip-gcs` (or `SKIP_BIGQUERY=1`, `SKIP_GCS=1`) | no                       | Skip a section.                                                                                                                                                      |

The preflight prints the identity ADC resolves to, the projects, location,
bucket, prefix and dataset name before anything is created.

### Required IAM

- **Destination project** (or the dataset, once it exists): BigQuery Data
  Editor (`roles/bigquery.dataEditor`; it includes `bigquery.datasets.create`
  and table create and read) and BigQuery Job User (`roles/bigquery.jobUser`;
  load jobs are created here). The creator of a dataset owns it, which covers
  the forced delete in cleanup; if your organization strips that, grant
  `roles/bigquery.dataOwner` instead. If reading job metadata is denied, add
  `roles/bigquery.resourceViewer` (`bigquery.jobs.get`).
- **Client project**, when it differs: BigQuery Job User, because the DDL and
  verification queries run as jobs there.
- **GCS**: Storage Object Admin (`roles/storage.objectAdmin`) on the test
  prefix, with an IAM condition such as
  `resource.name.startsWith("projects/_/buckets/BUCKET/objects/PREFIX/")`, plus
  `storage.buckets.get` for the probe (for example
  `roles/storage.legacyBucketReader`, or a custom role holding only
  `storage.buckets.get`). Object Admin alone does not include
  `storage.buckets.get`.

### Running it

Against current `main`:

```bash
git checkout main && git pull && npm ci && npm run build
npm install --no-save @google-cloud/bigquery @google-cloud/storage
export REPORTING_LEDGER_PG_URL=postgres://...   # a scratch database
export GCP_BQ_PROJECT=dest-project GCP_CLIENT_PROJECT=billing-project GCP_BQ_LOCATION=US
export GCS_BUCKET=my-test-bucket GCS_PREFIX=adcp-reporting-validation
npm run validate:reporting-gcp -- --yes
```

Against a pull request branch (for example #3197), keep running the script from
`main` and point it at a second built checkout, so a branch cut before this
script existed still works:

```bash
git fetch origin pull/3197/head:pr-3197
git worktree add ../adcp-client-pr-3197 pr-3197
(cd ../adcp-client-pr-3197 && npm ci && npm run build)
ADCP_SDK_ROOT=../adcp-client-pr-3197 npm run validate:reporting-gcp -- --yes
```

The same environment applies. The run ends with a `PASS`, `FAIL` and `INFO`
report and a markdown block (project and bucket names masked) to paste into
the PR. The exit status is 0 with no `FAIL`, 1 with any `FAIL`, and 2 for a
configuration problem or a missing `--yes`. Results of the overlap probes are
`INFO` on purpose: on `main` expect the stale-run probe to report duplicates,
and on PR #3197 expect it to report none.

`test/lib/reporting-gcp-validation-pg.test.js` drives the script's core against
in-memory BigQuery and Storage doubles and a real PostgreSQL, so the logic,
reporting and cleanup safety stay covered without credentials. It proves nothing
about real BigQuery or GCS behavior.

### The Python SDK's equivalent

The Python SDK (`adcp-client-python`, package `adcp`) has the same GCS row
provider and the same conformance runner: `create_gcs_reporting_row_object_provider_v1`
in `adcp.reporting.ledger.row_storage_gcs` and
`run_reporting_row_object_provider_conformance_v1` in
`adcp.reporting.ledger.row_storage_object`, with the same bucket policy rules.
Install `pip install 'adcp[reporting-gcs]'`, then run the conformance against the
same bucket and prefix as above (it writes and deletes only
`$GCS_PREFIX/conformance/<uuid>.jsonl`):

```bash
python - <<'PY'
import asyncio, os
from google.cloud import storage
from adcp.reporting.ledger.row_storage_gcs import create_gcs_reporting_row_object_provider_v1
from adcp.reporting.ledger.row_storage_object import run_reporting_row_object_provider_conformance_v1

async def main():
    provider = create_gcs_reporting_row_object_provider_v1(storage=storage.Client())
    passed = await run_reporting_row_object_provider_conformance_v1(
        provider,
        location={"bucket": os.environ["GCS_BUCKET"]},
        prefix=os.environ.get("GCS_PREFIX", "adcp-reporting-validation"),
    )
    print("PASS", passed)

asyncio.run(main())
PY
```

Python has no BigQuery warehouse sink. A live JavaScript to Python interop run
against GCS is not possible with the existing interop test: the Python test
(`tests/conformance/reporting/test_reporting_row_storage_interop_pg.py`) and its
JavaScript driver (`tests/interop/reporting_row_storage_js_driver.cjs`) both
hard-code the filesystem provider and a directory bucket root, and the
cross-SDK row-storage fixtures replay on a filesystem too. Running it on GCS
would need both drivers changed to build an object binding with
`provider: 'gcs'` and `location: { bucket }` (same prefix, deployment namespace
and binding definition on both sides). The optional live GCS controls in
`scripts/reporting-interop/GCS.md` exercise the Managed Delivery evidence
readers, not row storage.
