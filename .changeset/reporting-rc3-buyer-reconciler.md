---
'@adcp/sdk': minor
---

Add the AdCP 3.2.0-rc.3 buyer-side consumer-status loop to `reconcileReporting`.

**`content_mismatch` detection.** `detectReportingContentMismatch` decides the closed
`mismatch_code` — `scope_media_buy_missing`, `coverage_short`, `metric_missing`,
`schema_nonconformant`, `currency_mismatch`, `period_mismatch`.

Four of the six are **row-level** predicates that obligation and revision _metadata_ cannot decide,
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

**`received` is earned, not echoed.** `observed_revision_content_sha256` is defined as the binding
digest _"independently recomputed from the exact consumed Core revision binding"_. The reconciler
now pages `reporting_rows` for the exact revision through a new optional
`ReportingReconciliationClient.getMediaBuyDelivery`, concatenates them in cursor order, and
recomputes SHA-256 of RFC 8785 JCS over `{reporting_revision_id,row_count,control_totals,reporting_rows}`
itself. A read that fails, returns no exact-revision binding, or does not hash to the digest the
seller published becomes `unreadable` with the matching `failure_code` rather than a `received`
— and a digest that did not verify is never attached to anything. `content_mismatch` requires the
same recomputed binding, so it too only fires on bytes the buyer actually read. Without the client
method nothing is attested and nothing is posted for those two statuses
(`suppressed: 'consumption_unavailable'`): attesting a consumption that did not happen is the one
outcome worse than silence. `status_as_of` is the buyer's own consumption instant, floored by the
superseded leaf's `status_as_of` so a chain never moves backwards.

**Posting against the deadline.** `ReportingReconciliationResult.consumerStatuses` plans a status for
every expected period with its `expected_at` + `automated_recovery_window_seconds` deadline and an
`overdue` flag. `expected_at` comes from the obligation when there is one, and otherwise from
`period.end` plus a new optional `ExpectedReportingPeriod.deliverySlaSeconds` pin — `obligation_missing`
exists precisely when no obligation is there to read it from, and `expected_period` makes that
statement valid only at or after `expected_at`, so dating it from the period end has a conformant
seller reject every one. The recovery window is advertised on the delivery **capabilities**, not on
the obligation, so it comes from `ExpectedReportingPeriod.automatedRecoveryWindowSeconds`. Missing
either pin marks nothing overdue and posts nothing, because posting on a guessed clock would churn
the status chain.

**Identity that survives a retry.** `reporting_status_id` is derived from the claim the statement
makes — configuration generation, report definition, period, status, revision, recomputed digest,
`mismatch_code` / `failure_code`, and the leaf it supersedes — and no longer from `status_as_of`,
which for `received` and `unreadable` is the buyer's own clock and is new on every re-plan.
`idempotency_key` is likewise derived from the batch body rather than minted per attempt: it is
documented as _"Exact retries reuse the key and body"_, and a fresh key made the seller's batch
replay unreachable by construction. Together they make a reconstructed post byte-identical to the one
whose response was lost, so the seller replays it instead of appending a second statement. The leaf
stays in the ID derivation on purpose — it is stable across attempts at the same claim, and it keeps
a claim that genuinely recurs later in a chain (`received`, then `unreadable` after a flaky read,
then `received` again) from colliding with the earlier identical one.

**Row-level mismatch codes are reachable.** Detection runs a second time once the rows are in hand,
so `metric_missing` and the other row-gated codes can fire through the reconciler at all. Only
`observedMetricNames` is derived, only when the buyer pinned `committedMetrics`, and a metric counts
as present if any row carries it at top level or under `totals` or the revision declares a control
total for it — the remaining row predicates would need the profile's own row shape, and guessing at
them risks exactly the false accusation the row gating exists to prevent.

**Saying nothing when there is nothing to say.** Each plan names the caller's current leaf in
`supersedes_reporting_status_id` — resolved from the caller's own append-only history, now loaded
onto `ReportingLedger.consumerStatuses`, so the chain is named even before any obligation exists.
When that leaf already carries the same claim, the plan comes back `suppressed: 'unchanged'` and is
not posted: `immutability` allows a new ID only for changed status, and re-posting would supersede a
statement with its own duplicate on every reconcile, which `retention_and_limits` calls pathological
churn. A leaf the seller names but does not disclose suppresses the post too, rather than guessing.

When the client supplies the new optional `syncReportingStatus`, overdue, unsuppressed, attested
statuses are posted — the rc.3 duty is that clock, not scope close. `postedConsumerStatuses` reports
what the seller actually recorded, and the new `failedConsumerStatuses` carries item-local
rejections with the errors the seller returned, so a partial-success batch never loses one silently.
Without the client method the reconciler still plans everything and reports it, so existing adopters
are unaffected.

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
