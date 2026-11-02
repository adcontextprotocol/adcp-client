---
'@adcp/sdk': minor
'@adcp/reporting-storage': minor
---

Reporting subscriptions (experimental, AdCP 3.3): buyer events.

- `client.reporting.poll()` returns the events since the last acknowledgement, derived by comparing what the seller reports now (`reconcile`, the subscription readback, each account's `subscription_coverage[]`) with the snapshot saved by the last `batch.ack()`. Delivery is at least once with deterministic ids (`rse_` + `sha256(agent, type, natural key, version)`, the same ids as the Python SDK). A partial read never fabricates a change, and `poll({ baseline: true })` records the present without emitting it.
- `client.reporting.events({ pollEvery, signal })` is the loop: each batch is acknowledged after the loop body has run for all its events.
- `client.reporting.handleWebhook(verified)` treats a seller webhook as a doorbell: it wakes a running `events()` loop or polls inline. It takes only a `VerifiedWebhook`, built by `VerifiedWebhook.fromOutcome` from a successful signature verification.
- Event types: `revision.available`, `revision.adjusted`, `period.late`, `period.missing_obligation`, `period.withheld`, `coverage.exception_opened`, `coverage.exception_closed`, `account.covered`, `account.unauthorized`, `account.regranted`, `subscription.state_changed`, `timezone.cutover`.
- Snapshots live in a `ReportingEventStore` with compare-and-set (`ReportingEventConflictError` when another worker acknowledged first). `memoryStorage().events` and `postgresStorage({ pool }).events` provide one, `createReportingEventStore({ store })` builds one over any `AdcpStateStore` with `putIfMatch`, and the client takes it as `reportingEventStore`.
- `@adcp/sdk/reporting/advanced` adds `deriveEvents`, `EVENT_TYPES` and `SNAPSHOT_VERSION`.
