---
'@adcp/reporting-storage': minor
---

Reporting storage (experimental): `PostgresReportingLedgerStore` records issue-lifecycle events for the SDK's `issueObserver` (#3648). This mirrors the Python storage outbox (adcp-client-python#1874).

- **Same-transaction writes.**
  - `syncConsumerStatusBatch` records `opened` when the new leaf conflicts with the seller's record, and `resolved` for the occurrence of the leaf it superseded.
  - `commitRevision` records `opened` when a restatement makes a leaf conflict or anchors one filed before any revision. It also records `resolved` when the read projection stops conflicting.
  - Both run under the account lock the write already holds. An event exists exactly when its transition committed.
- **Exactly-once records.**
  - An occurrence is `(issue_id, consumer_id)`, since two consumers may reuse one `reporting_status_id`. `UNIQUE (issue_id, consumer_id, kind)` keeps every record exactly once across replicas, and the `event_id` is derived from that triple.
  - `sweepIssueEscalations` settles each candidate obligation first, then records `escalated` once.
- **Delivery.**
  - `claimIssueEvents` hands out `SKIP LOCKED` leases, at most one per occurrence, in recording order.
  - `completeIssueEvent`, `releaseIssueEvent` and `pruneIssueEvents` settle and clean up, and `issueEventsReady()` reports whether the table exists. Pruning removes whole occurrences that are resolved and fully delivered, never an open one, because the table is also the occurrence ledger.

- **Production service.** `createPostgresReliableReportingProductionService` accepts `issueObserver` (passed to the core service it drives) and adds `REPORTING_ISSUE_EVENTS_MIGRATION` to `setup.migrations` when it is set.

Why minor: this ships a new versioned migration that `postgresStorage().checkSchema()` requires (`REPORTING_SCHEMA_BEHIND` until applied), and per the stability policy a schema change goes in a minor of `@adcp/reporting-storage`.

Migration note:

1. Run `npx adcp-reporting-storage migrate`. This adds version `0012`, `reporting_issue_events`; the SQL is exported as `REPORTING_ISSUE_EVENTS_MIGRATION`. It is additive: one new table (`adcp_reporting_issue_events`) and its indexes, with no change to any existing table, key, function or trigger. It is safe to apply while workers of the previous release still run; they record no events for their own writes.
2. Until it is applied, writes record nothing and `issueEventsReady()` is `false`, and `issueObserver` refuses to start. Nothing else changes.
3. No storage contract moves. The Python SDK ships the same outbox as its migration `0008`, keeps its storage contract at `2`, and uses the same `event_id` derivation.

See `docs/migration-reporting-storage-package.md` and `docs/guides/REPORTING-LEDGER.md`.
