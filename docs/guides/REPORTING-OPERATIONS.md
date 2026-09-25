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

Never put bearer tokens, signing secrets, provider credentials, or destination
credentials in namespaces, account metadata, source scope, cursors, ledger
records, logs, or receipt evidence. Resolve them just in time from a secret
manager and bind authorization to authenticated transport context.

## Deployment and migration

1. Back up the database and record the current application and schema versions.
2. Stop old writers when the release notes declare a writer fence. Additive,
   idempotent migrations may otherwise be applied before rolling processes.
3. Execute every SQL string in `service.setup.migrations` with the deployment's
   migration owner. Prefer one migration transaction where the platform permits
   it. Set explicit lock and statement timeouts and retry only after diagnosing
   a rollback.
4. Construct the service. Treat a migration, probe, policy-adoption, or
   capability-validation failure as a failed deployment; do not serve a reduced
   hand-authored capability document.
5. Start one canary, verify reads and worker progress for representative
   accounts, then roll the remaining instances.
6. Confirm old binaries are gone before enabling behavior that depends on new
   retained fields or fencing semantics.

Migrations are rerunnable and never authorize deleting or rebuilding reporting
tables. Roll forward after a failed application release. Do not downgrade a
writer across a retained-state compatibility fence.

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
provider errors. Error observers are isolated; page on observer failure because
it can otherwise hide degraded telemetry.

## Capacity planning

Size from measured rows, not account count alone. Forecast daily growth as:

`obligations + revisions + materializations + receipts + event attempts + buyer checkpoints`

multiplied by average row/index/WAL bytes and retention days. Include failed
attempts and revision churn in peak estimates. Keep database storage below 70%
and provision IOPS for the larger of peak source settlement and webhook retry
recovery. Load-test at least twice forecast peak accounts, periods, notification
fan-out, and row/object sizes. Confirm that one hot tenant cannot starve the
next tenant; planning and notification recovery use durable rotating cursors,
but provider quotas still need per-adapter limits.

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
- stable snapshots, exact revisions, materializations, and receipts remain readable;
- notification recovery resumes without duplicate logical events;
- buyer cursors/checkpoints resume and duplicate notification keys remain deduped;
- a new lease fences an expired owner;
- sampled manifest and canonical-content digests still verify.

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
