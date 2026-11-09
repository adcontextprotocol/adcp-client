---
'@adcp/reporting-storage': patch
'@adcp/sdk': patch
---

Reporting storage (experimental): period retirement resolves the period's open issue occurrences (#3648 follow-up).

`retireExpiredPeriods` deleted a period's obligation and consumer statements but left its `CONSUMER_STATUS_MISMATCH` occurrences open in the issue-event outbox. Nothing could resolve or escalate them afterwards. An occurrence that had already escalated stayed open forever: the issue observer never received its `resolved` event, and retention never pruned it.

Retirement now records `resolved` for each of the obligation's open occurrences in the same transaction that deletes the obligation. Pending events stay deliverable: the `resolved` event carries `issue: null` and no `principal`. The whole-occurrence prune collects the occurrence once it is delivered. Outbox rows are never deleted at retirement, so no undelivered event is lost.

No migration and no API change. `ReportingIssueEventStoreV1` (experimental) now states the contract for custom stores: a store that deletes an obligation resolves the obligation's open occurrences in the same transaction.
