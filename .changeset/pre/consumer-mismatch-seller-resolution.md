---
'@adcp/sdk': patch
'@adcp/reporting-storage': patch
---

A `CONSUMER_STATUS_MISMATCH` now resolves when the seller's own record stops conflicting with the buyer's statement, not only when the buyer supersedes it (#3653). AdCP 3.3 allows both routes. Before, a seller restatement, or a seller marking the disputed revision unreadable, never cleared a `content_mismatch`, `revision_missing` or `unreadable` mismatch.

The spec doesn't say per status when the seller's projection "no longer conflicts". The SDK now applies the reading it shares with the Python SDK:

| Statement            | Conflicts while                                                   |
| -------------------- | ----------------------------------------------------------------- |
| `obligation_missing` | always                                                            |
| `revision_missing`   | the seller has a current required revision                        |
| `unreadable`         | no open `REVISION_UNREADABLE` marks the named revision unreadable |
| `content_mismatch`   | the named revision is still the current required one              |
| `received`           | the named revision is not the current required one                |

- `projectReportingConsumerStatusMismatchV1` takes the obligation's persisted issues as a new optional last argument; `get_reporting_status` passes them.
- An `unreadable` statement can conflict again after the seller retires its unreadable mark. That recurrence gets a new `issue_id` and `opened_at`, as the spec requires. Every other mismatch keeps its `issue_id`.
- Seller-health suppression is unchanged: while the seller's own projection is degraded the mismatch is not published, and it returns with the same `issue_id`.
- The issue observer follows the same rule. `reportingConsumerMismatchOccurrenceV1` takes optional `issues` and `at` arguments. The in-memory ledger and `@adcp/reporting-storage`'s PostgreSQL store pass them, and a `REVISION_UNREADABLE` write now settles the obligation's occurrences. Because a recurrence's identity and `opened_at` come from the seller's unreadable mark, both stores now record that mark's start and end as fixed facts. Neither the start nor the end is dated after the write. The start is fixed by the first write, and the end is never before it. The end, once set, never moves, including on a retried write. A custom store can do the same with the new experimental `normalizeReportingUnreadableMarkWriteV1`.
