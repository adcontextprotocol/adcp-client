---
'@adcp/sdk': minor
---

Add the AdCP 3.2.0-rc.3 buyer-side consumer-status loop to `reconcileReporting`.

**`content_mismatch` detection.** `detectReportingContentMismatch` decides the closed
`mismatch_code` — `scope_media_buy_missing`, `coverage_short`, `metric_missing`,
`schema_nonconformant`, `currency_mismatch`, `period_mismatch`.

Four of the six are **row-level** predicates that obligation and revision *metadata* cannot decide,
and they stay silent unless the caller passes `ReportingRowEvidenceV1` describing what it actually
read. `scope_media_buy_missing` in particular cannot be decided from `media_buy_ids`, which
`reporting-revision.json` defines as the denominator "inherited from the obligation, including buys
with zero rows" — comparing those sets is a tautology against a conformant seller, and the real
condition is a buy with no rows and no explicit zero row. `metric_missing` likewise compares against
metrics observed in rows, not against `control_totals`, which are profile-defined aggregates scoped
to the covered packages. Only `coverage_short` and `currency_mismatch` are decidable from metadata.
A false `content_mismatch` forces the caller's view to `action_required` and the seller may not
clear it while the statement is the current leaf, so not accusing is the safe default. It is deliberately incapable of firing on a delivered value
the buyer merely disagrees with: that is a measurement dispute for `measurement_terms` /
`makegood_policy`, and routing one through this operational channel would put a commercial argument
somewhere the seller can neither resolve nor ignore. Precedence follows the spec on the one pair it
pins (`metric_missing` before `schema_nonconformant`) and is otherwise most-structural-first and
stable, so the code does not flap between reads of the same bytes.

**Posting against the deadline.** `ReportingReconciliationResult.consumerStatuses` plans a status for
every expected period with its `expected_at` + `automated_recovery_window_seconds` deadline and an
`overdue` flag. That window is advertised on the delivery **capabilities**, not on the obligation, so
it comes from a new optional `ExpectedReportingPeriod.automatedRecoveryWindowSeconds` pin; without it
nothing is marked overdue and nothing is auto-posted, because posting on a guessed clock would churn
the status chain. Each planned statement also carries the seller-published
`current_consumer_status_id` as `supersedes_reporting_status_id`, and its `reporting_status_id` is
derived from the statement's own content so an exact retry reuses the ID instead of forking the
chain. When the client supplies the new optional `syncReportingStatus`, overdue statuses are
posted — the rc.3 duty is that clock, not scope close, and a buyer still retrying posts
`revision_missing` and supersedes later rather than staying silent. `postedConsumerStatuses` reports
what the seller actually recorded, so a per-item failure in the partial-success batch is never
counted as posted. Without the client method the reconciler still plans everything and reports it,
so existing adopters are unaffected.

**Surfacing.** `consumerStatusPending` carries the seller's own count of obligations past the buyer's
deadline with no current status; a failed read leaves it `undefined` rather than failing
reconciliation, because it is visibility rather than evidence. `escalations` flattens seller issues
with `openedAt` / `issueState` / `externalRef` and the advertised `operationsContact`, plus
`requiresHumanContact` for the `contact_*` family, so an SDK user can page someone without
re-reading the capability document. `operationsContact` is inert display metadata — never
dereference it.

`ExpectedReportingPeriod` gains optional `committedMetrics` and `metricUnits`. Omitting either
disables its check rather than guessing: a buyer that never recorded the metric list must not claim
a promised metric is absent.
