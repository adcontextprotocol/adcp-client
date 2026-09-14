---
'@adcp/sdk': minor
---

Implement the AdCP 3.2.0-rc.3 Reliable Reporting consumer-status hardening in the seller ledger.

**`content_mismatch` projection.** The fifth consumer status conflicts with a healthy/complete seller
projection like the other negative statuses and is immediately `action_required`. It is a
contract-fact disagreement naming the exact bytes the consumer read, never a measurement dispute.

**Stale-`received` grace.** A `received` statement made stale *only* by a seller restatement now
projects the caller-scoped view as `delayed` — with `wait_for_retry` — until a bounded re-read
deadline, then `action_required`. The deadline is the `created_at` of the first revision that
superseded the one the consumer named plus the generation's `delivery_sla`, falling back to
`automated_recovery_window_seconds` when that SLA is zero. Later restatements supersede later
revisions and cannot restart it. Previously every conflict escalated immediately.

**Escalation.** `createReportingStatusHandler` accepts `consumerMismatchEscalation`
(`escalationSeconds` + `operationsContact`, mirroring the capability block's both-or-neither rule).
Past `opened_at` plus that window an open mismatch becomes `action_required` with a `contact_*`
action naming the diagnosed party; `wait_for_retry` and `repair_access` do not survive the boundary,
and escalation takes precedence over an open grace window.

**Issue lifecycle.** Issues emit `opened_at`, fixed at first emission and carried unchanged across
re-emission and across the `delayed` → `action_required` transition under one stable `issue_id`. It
is derived from immutable ledger facts, not the read time, so polling cannot reset the escalation
clock. `issue_state` (`open` / `acknowledged`) and `external_ref` are optional and now validated at
the response boundary. `projectReportingConsumerStatusMismatchV1` is exported so a custom store can
reuse the exact projection.

**`obligation_counts.consumer_status_pending`.** Emitted on the summary view whenever a consumer
principal is resolved. Counts obligations past `expected_at` plus the recovery window with an empty
status chain for the caller. Never a health input; overlaps the health counts rather than
partitioning them.

**Reserved `authoritative_party`.** `assertSupportedReportingAuthoritativeParty` refuses
`'consumer'` with `UNSUPPORTED_FEATURE` instead of coercing it to `'seller'`, and
`installConfiguration` applies it before any other validation. Call it from `sync_accounts` too.

The lifecycle harness (`examples/reliable-reporting-lifecycle`) gains a `restate_after_received`
probe operation mirroring the comply controller's: it restates only against the revision the caller
currently reports as `received`, returns `stale_received_grace_deadline`, and is convergent on repeat.

**Cross-tenant fix.** A persisted `CONSUMER_STATUS_MISMATCH` issue is no longer republished. The
issue store is keyed by obligation and carries no consumer dimension, so echoing a persisted one
handed every other consumer on that obligation the causing `reporting_status_id`, its `opened_at`
(another tenant's exact ingest timing), and any `external_ref` ticket key. The projection recomputes
the mismatch from the caller's own current leaf on every read, so the persisted copy was redundant
as well as unsafe. Retired (`resolved` / `waived`) issues are dropped from the projection rather
than emitted with the state elided.

**Health-filter fix.** `PostgresReportingLedgerStore` applies the `health` query filter while
building the snapshot, and it carried a second copy of the mismatch rule that hardcoded
`action_required`. With rc.3's `delayed` grace window that made a stale-`received` obligation
unreachable under *every* filter — excluded from the snapshot when the caller asked for `delayed`,
dropped by the handler when they asked for `action_required`. Both now call one shared projection in
`./health`, and the store accepts `consumerMismatchEscalation` so the two cannot disagree.

`opened_at` is now the later of the first supersession and the causing statement's `recorded_at`; a
buyer that posts `received` naming an already-superseded revision no longer gets an issue dated
before the seller could have observed it, which with a short escalation window would have been born
already escalated. Grace and escalation comparisons use the ledger's exact instant comparators
instead of `Date.parse`, which floors sub-millisecond fractions and returns `NaN` for the leap
seconds this module accepts. Persisted issues preserve their `openedAt` across re-upsert, and
`HISTORY_UNAVAILABLE` is anchored to its period rather than the read time.

`UnsupportedReportingFeatureError` extends `AdcpError` so the framework maps it to
`UNSUPPORTED_FEATURE`/`terminal`; as a plain `Error` it would have been projected to
`SERVICE_UNAVAILABLE`/`transient`, telling the buyer to retry the request it refuses.
`assertSupportedReportingAuthoritativeParty` is exported from the package root, rejects a
wrong-shaped argument instead of silently passing, treats an explicit `null` as a request rather
than absence, and reports buyer-supplied values as bounded structured details.
`consumerMismatchEscalation` is validated at wiring time — `NaN` silently disabled escalation and a
negative window escalated everything.
