---
'@adcp/sdk': minor
---

Harden and correct the rc.3 buyer consumer-status loop that shipped in `14.0.0-rc.38`. Most items
below are defects in that release; the two additive ones are called out as such.

**A seller could silence exactly the buyers who configured the loop carefully.** When the buyer's
`periodSourceTimezone` pin named a different zone from the seller's echoed `period.source_timezone`,
rc.38 suppressed the period as `period_identity_unknown`. Measured consequence: for the same
under-delivering seller, the buyer with no pin posted its `content_mismatch` while the buyer with a
pin recorded nothing at all — permanently, from one seller configuration change. The statement is now
posted under the seller's value, which is the only spelling its ingest accepts, and the disagreement
is surfaced on the new non-suppressing `plan.periodZoneBeyondPin`. The reason rc.38 gave for
suppressing was also wrong: adopting the echo cannot fork the buyer's chain, because
`period.source_timezone` is in neither the leaf key nor the unchanged-comparison — a seller cycling
seven spellings leaves one statement.

**One seller-supplied string could abort the whole reconcile.** The revision scope key hashed
`period.source_timezone` byte-wise, so an obligation saying `UTC` and a revision saying `Zulu` — one
zone, two legal spellings — landed in different scopes and threw `LEDGER_GRAPH_INTEGRITY_FAILED` out
of `reconcileReporting`, losing every period in scope rather than the one affected. Zone equivalence
is now resolved wherever periods are compared, not only in the consumer-status path.

**A malformed record could destroy the caller's record of durable work.** The ledger is re-read
_after_ `sync_reporting_receipts` has written, so a `null` or id-less entry in any of the five record
collections — `periods`, `revisions`, `materializations`, `receipts`, `consumer_statuses` — threw an
uncaught `TypeError` from the reload and the caller could not tell whether the write had happened.
Two further fields did the same from `selectCurrent`, which runs for every obligation after the
receipt pass: a revision with a missing `period`, and a `media_buy_ids` that was a scalar rather than
an array (`?? []` caught `null` and nothing else, so `[...0]` threw). Malformed records are now a
typed `LEDGER_RECORD_MALFORMED`, those two field shapes are refused by the ledger graph assertion
before anything durable is written, and — the part that matters most —
**`ReportingReconciliationError.submittedReceipts` now carries the receipts a failed run had already
synced**, so a caller can retry knowing it is retrying. Retrying is safe: the seller answers an
already-recorded receipt with `unchanged`.

**One strange row could buy permanent immunity from `content_mismatch`.** A single row describing
more than 262,144 containers — nesting depth 3, so it never met the depth guard — was charged to the
buyer's own budget and silently suppressed the period, for a measured ~786 KB. Breadth now accuses
the seller as `unreadable` / `reader_incompatible`, the same side as depth: no conformant tabular row
has that shape, and an array of a hundred thousand numbers is one container, not a hundred thousand.

**A seller could still set the buyer's clock invisibly.** Pin-first deadline ordering only defends a
buyer that recorded an offset, and both are optional: without one, `delivery_sla: "P10Y"` came back
as a live ten-year deadline with `suppressed` unset and no marker. `deadlineBeyondPin` now fires with
`pinned` absent when there is no pin to check against, and the new `plan.deadlineSource` records
every deadline's provenance. The seller's instant is still honoured — `expected_period` makes it
authoritative.

**Diagnostics named the wrong party or the wrong field.** `period_identity_unknown` emitted one
sentence for every cause, so an adopter whose own pin was the defect was told the seller's zone was
unrecognized and instructed to record a pin they had already recorded — an instruction they could
follow, re-run, and watch fail identically forever. It now distinguishes an unreadable seller zone,
an unreadable pin, and both, quoting the values and offering a remedy only where one exists. An
overflowing deadline under `official` finality could be attributed to whichever offset the finality
implied rather than the one actually consulted. The `missing_pin` remedy named only the SDK-local
`officialAfterSeconds`; it now names the spec-defined `deliverySlaSeconds` first. And a non-string
value renders as its type instead of as an empty pair of brackets.

**Replay verification had two gaps.** A remembered statement's `reporting_obligation_id` was
replayable but compared to nothing, so a forged value reached the wire; and `status_as_of` had a
non-future ceiling but no floor, so a consistently forged id let a poisoned store backdate a
statement to before the period it describes. Both are now checked.

`normalizedInstant` accepted a `+30:00` offset that RFC 3339 and `ajv-formats` both refuse — reachable
because the offset hour was unbounded and the newly accepted space separator reaches a laxer parser.
`maxRevisionRows` is validated like its siblings rather than silently muting every period (`-5`) or
disabling the row bound (`NaN`), and is clamped on re-read so a side-effecting getter cannot raise it.

**Additive, not defects in rc.38:** `ledgerLimits.maxRevisionBytes` is new — it may only tighten the
SDK's 256 MiB per-revision ceiling, and a larger value is refused, because that ceiling bounds the
SDK process's memory rather than the caller's. It exists mainly so the ceiling is reachable in a
test. `plan.deadlineSource`, `plan.periodZoneBeyondPin` and
`ReportingReconciliationError.submittedReceipts` are also new optional public fields; together with
the widened `suppressed` union they make this a `minor`.

Thirty-one regressions, each verified to fail with its fix reverted from a clean build. That set also
closes gaps the review found in existing coverage: the row estimator's breadth cap, its 64-level
depth boundary and both its byte floors were unpinned; the BC-era refusal and the `alignment: 'utc'`
arm each reverted green with a measured wrong deadline; one compound replay-poison test was masking
four guards now exercised one field at a time; and the `collectRecord` id guard reverted green while
the buyer posted a `received` derived from a record it could not identify. Comments and TSDoc that
described this feature's pre-release iterations as shipped behaviour are corrected, and guards with
no reachable path — the `selectCurrent` period guard behind the graph assertion, the byte-ceiling
clamp behind its validation, two minute bounds behind `Date.parse`, the hardcoded-locale hour wrap —
say so rather than claiming coverage.
