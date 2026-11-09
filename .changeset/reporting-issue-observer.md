---
'@adcp/sdk': minor
---

Reliable Reporting: `issueObserver` tells the seller when a reporting issue opens, escalates or resolves (#3648). This is the TypeScript side of the Python SDK's `issue_observer` (adcp-client-python#1874, #1875).

A `CONSUMER_STATUS_MISMATCH` is caller-scoped, so only the buyer whose `sync_reporting_status` statement caused it sees it. A seller had no supported way to learn that one opened, escalated past `consumer_mismatch_escalation_seconds`, or resolved.

- **`createReliableReportingService({ issueObserver })`.** The observer is called once per transition with a `ReportingIssueEventV1`: `eventId`, `kind`, `occurredAt`, `accountId`, `consumerId`, `principal` (subscription obligations), `issueId`, `reportingObligationId`, `reportingStatusId`, `attempt`, and `issue`, rendered as `get_reporting_status` showed it at `occurredAt` (`null` for `resolved`).
- **When it fires.**
  - The ledger records `opened` and `resolved` in the same transaction as the `sync_reporting_status` write or revision commit that caused them.
  - Each `runCycle` sweeps `escalated` and then delivers committed events.
  - Without `runCycle`, events are recorded but the observer is never called and `escalated` is never recorded.
- **At least once.** Deduplicate on `eventId`: `"rpie_" + sha256(canonical_json_utf8_v1(["reporting-issue-event-v1", issueId, consumerId, kind]))[:40]`. That is Python's scheme with the consumer added, because the published `issueId` does not name the consumer and two consumers may reuse one `reporting_status_id`. An open occurrence's events are never pruned; a closed one's (resolved, with its statement superseded or its obligation gone) are, seven days after its last delivery.
- **Failures.**
  - A throwing or timed-out observer (10 s) is retried after a backoff of 30 s doubling to 1 h, with no limit.
  - The failure reaches the scheduler's `onError` as a `ReportingIssueObserverError`, and `runCycle(...).issueEvents.errors`.
  - It never fails the buyer's call or the cycle.
- **Store interface (experimental).** A store opts in through `ReportingIssueEventStoreV1` (`issueEventsSupported`, `issueEventsReady`, `sweepIssueEscalations`, `claimIssueEvents`, `completeIssueEvent`, `releaseIssueEvent`, `pruneIssueEvents`). The same experimental surface adds the pure helpers stores share: `reportingIssueEventIdV1`, `reportingConsumerMismatchOccurrenceV1`, `planReportingIssueEventsV1`, `reportingIssueEscalationV1` and `renderReportingIssueEventV1`. `memoryStorage()` implements it, and `createReportingIssueEventDispatcherV1` runs delivery without the service. The service refuses `issueObserver` against a store without the capability.
- **Not emitted yet.** `acknowledged` and `waived` are in the kind union for parity, but no TypeScript store emits them, because the TypeScript ledger has no operator issue-state API.
- **Parity gap.** A seller-side change never clears a TypeScript mismatch (#3653).

Pair with `@adcp/reporting-storage` from this release, which records the events on PostgreSQL after migration `0012`.
