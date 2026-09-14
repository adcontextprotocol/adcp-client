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

The lifecycle harness gains a `restate_after_received` probe operation mirroring the comply
controller's: it restates only against the revision the caller currently reports as `received`,
returns `stale_received_grace_deadline`, and is convergent on repeat.
