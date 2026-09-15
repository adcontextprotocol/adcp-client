---
'@adcp/sdk': patch
---

Harden the rc.3 buyer consumer-status loop against seller-supplied data that could abort a reconcile,
silence a conformant seller, or walk past the buyer's own memory ceiling.

**A single seller number could abort the whole run.** `JSON.parse('1e999')` is `Infinity`, which
RFC 8785 cannot represent, so `canonicalize` threw `TypeError` — and the digest guard rethrew
anything that was not a `RangeError`, out of a call site with no `catch`. The throw escaped
`reconcileReporting` after receipts had already been synced, losing the caller's record of durable
work. Canonicalization failures are now classified: a `RangeError` is a size failure and stays silent
as the buyer's own budget, anything else is `unreadable` / `reader_incompatible`, which is what that
code means — carrying the canonicalizer's own bounded message in the local `reason` so a genuine
defect stays visible.

**A conformant seller could be silenced permanently.** `expected_at` was validated against a stricter
pattern than the `format: date-time` check this SDK uses on the seller's own payloads, so a lowercase
`t`/`z`, a `+hhmm` offset or a space separator — all accepted by `ajv-formats` — yielded no deadline
and no statement, forever. The pattern now matches what the SDK itself accepts, and the instant is
**normalized rather than echoed**: `Date.parse` silently rolls `2026-02-30T00:00:00Z` forward to
March 2, and re-emitting the seller's bytes would put that contradiction on a statement the buyer
signs. A `expected_at` that is present but unreadable derives nothing at all: the seller has a real deadline
the buyer cannot read, so any derived one disagrees with it and the statement is refused on every run
forever. When `expected_at` is **absent** the buyer falls through to its own
`deliverySlaSeconds` / `officialAfterSeconds` pin, and only then to the seller's
`obligation.schedule.delivery_sla`. That order matters: `schedule` is as seller-controlled as
`expected_at`, so consulting it ahead of the pin let a seller that had published nothing omit
`expected_at`, advertise `delivery_sla: "P10Y"`, and push its own deadline a decade out — the period
never went overdue and the `revision_missing` recording the non-delivery was never posted. The pin is
the buyer's independent answer and outranks it. As a last resort for a buyer with no pin, the
schedule resolution is **calendar-aware**, because the schema permits `Y` and `M` on `delivery_sla`
and names `period_timezone` as the zone its "calendar arithmetic" happens in: `P1M` is a calendar
month in that zone, clamping to month end, with a nonexistent local time advancing by the DST gap and
an ambiguous one taking the earlier offset, exactly as `period_generation` specifies. A duration with
no calendar component stays exact elapsed time — that is the only shape this SDK's own seller emits,
and routing it through wall-clock conversion lost sub-second precision and shifted `PT0S` by an hour
across an ambiguous local hour. An unrecognized `period_timezone`, an unresolvable zone, or a
duration whose result falls outside the RFC 3339 year range derives nothing rather than a guess.

**Row size accounting is bounded by work, not by depth.** The estimate charged an unexamined subtree
a flat constant, which cut both ways: too small and nesting walked past the ceiling
(`{a:{b:{c:{d:{…1 MB…}}}}}` measured 200 bytes), too large and a structurally deep row silenced the
buyer with a `local_budget_exhausted` that blamed its own budget. It now walks a bounded number
of nodes per row and charges each for what it holds, which closes the bypass. A row the estimator cannot
size is reported as `unreadable` / `reader_incompatible` rather than suppressed: silence is reserved
for limits the adopter configured, so a seller cannot buy immunity from `revision_missing` by
publishing an awkward shape. Strings and primitives are sized in O(1) and never consume that budget,
so neither a very wide row nor a very large string can be hidden from the ceiling or used to trip it
early; a structure too deep to size is reported as the buyer's own limit rather than as an unreadable
revision.

**`period.source_timezone` is validated, and the buyer's own pin wins.** It reaches the durable
statement, the `reporting_status_id` hash and the unchanged-comparison, so a seller varying its echo
could make the buyer append a fresh statement on every reconcile. `ExpectedReportingPeriod.periodSourceTimezone`
is now preferred over the seller's copy, and both are checked for IANA identity rather than length
alone — `iana_timezone` is a MUST and Node's `Intl` happily accepts `"+05:30"`, which is exactly the
numeric-offset substitution the clause forbids.

`usableLeafInstant` normalizes the superseded leaf's `status_as_of` through the same path, so a leaf
recorded by an older SDK with a `+00:00` or lowercase spelling now produces the same monotonicity
floor as its canonical form — which feeds `reporting_status_id`, so a chain can see one id shift
across this upgrade.

Two further adopter-observable changes. A `period.source_timezone` that is not a recognized IANA zone
is no longer adopted, and `ExpectedReportingPeriod.periodSourceTimezone` now outranks the seller's
echo — that value is inside the consumer-status chain key and the `reporting_status_id` derivation,
so an adopter whose pin disagreed with the seller's echo will see the chain key change once on
upgrade. And a `expected_at` that is present but not a string (rather than merely malformed) now
suppresses instead of falling through to the pin.

`suppressed` gains `posting_unavailable`, widening that exported union — an adopter switching
exhaustively on it will see a new arm. Concretely: with no `client.syncReportingStatus` wired, a plan used to
come back live, due and unsuppressed while silently going nowhere.

Diagnostics are honest about whose field failed: the `deadline_unknown` reason named a field that
does not exist on `ExpectedReportingPeriod` and said a value "was not recorded" when it had been
recorded and merely could not be read. `chain_indeterminate` now distinguishes a forked chain from a
head naming an undisclosed predecessor, rather than claiming no head resolved in both cases.
