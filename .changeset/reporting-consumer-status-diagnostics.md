---
'@adcp/sdk': minor
---

Harden and correct the rc.3 buyer consumer-status loop that shipped in `14.0.0-rc.38`. Most items
below are defects in that release; the two additive ones are called out as such.

**A buyer that pinned `periodSourceTimezone` could never post for a seller that spelled the zone
differently.** rc.38 put the buyer's pin on the wire, and the seller's ingest compares that field
byte-for-byte, so the statement was refused on every run — it never landed, and the period showed up
permanently in `failedConsumerStatuses` rather than on the chain. The buyer's spelling is now used
only when the seller declared nothing; otherwise the seller's own value goes on the statement, and a
pin naming a genuinely different zone is reported on the new non-suppressing
`plan.periodZoneBeyondPin`. Adopting the echo cannot fork the buyer's chain, because
`period.source_timezone` is in neither the leaf key nor the unchanged-comparison — measured over
seven spellings, one statement. A link and its canonical name (`Japan` / `Asia/Tokyo`) are one zone
and no longer disagree at all.

**rc.38 silently ignored a malformed `periodSourceTimezone` pin** and posted under the seller's echo,
so an adopter's typo changed the chain key they thought they had chosen with no signal whatsoever.
That is now `period_identity_unknown`, and so is a seller zone the buyer cannot read, and so is the
case where neither is readable — three causes, three reasons, each quoting the values and offering a
remedy only where one exists.

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
synced**, so a caller can retry knowing it is retrying. Retrying is idempotent when a `checkpointStore` is wired — the
same receipt id and idempotency key are replayed and the seller answers `unchanged`. Without one,
receipt ids are generated per attempt and `reporting-receipt.json`'s `immutability` makes an accepted
leaf terminal, so a retry conflicts instead.

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

**Diagnostics named the wrong party or the wrong field.** The `period_identity_unknown` reason told
every adopter to record `periodSourceTimezone`, including when the seller's own zone was the
unreadable one and no pin could repair it — an instruction they could follow, re-run, and watch fail
identically forever. An
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

**A conformant seller could stall the reconcile for minutes and starve the whole event loop.** Zone
comparison constructs an `Intl.DateTimeFormat` (~62 µs), and it sits on a path walked once per
revision per obligation — so a seller spelling its revision's zone as a _link_ of its own
obligation's, both blessed by `iana_timezone`, turned a 150×150 ledger from 84 ms into 6,068 ms of
synchronous work. Nothing bounded it: `maxLoadMs` covers only the ledger read, and the burn is
synchronous, so every `AbortSignal` deadline in the SDK is unreachable while it runs. Canonical zones
are now memoized in a bounded cache and a zone name is length-checked before `Intl` sees it (a 1 MB
name measured 8.2 ms). The revision-to-obligation scope match is also indexed by scope key rather
than rescanned per obligation, which removes the underlying O(obligations × revisions) product —
`maxRecords` bounds only the sum, so a 50k/50k ledger was 2.5e9 comparisons.

**Seller-supplied collections and scope fields are array-checked.** `periods: 0` — or `true`, or an
object — reached `for…of` on a non-iterable and threw a raw `TypeError`; so did an omitted
`scope.delivery_config_generations` or `scope.feed_purposes` when the request filtered on them. The
first is now `LEDGER_RECORD_MALFORMED`, the second a plain scope mismatch. `obligation.issues` is
capped per obligation, since it counts against no ledger limit.

**A remembered statement carrying an explicit `null` is refused.** The replay comparisons used
`?? undefined`, so a stored `null` matched a plan with nothing there and reached the wire, where the
seller's schema refused it — permanently, because a failed post deliberately keeps the pending entry.
An older SDK that emitted explicit nulls produces the same blob with no attacker involved.

**Migration note for adopters who pinned `periodSourceTimezone`.** rc.38 put the _pin_ on the wire;
this release puts the seller's echo there whenever it has one. If your pin and your seller's value
name the same zone with different spellings — `Japan` against `Asia/Tokyo` — nothing suppresses and
no flag is set, but the wire value changes and so `reporting_status_id` shifts once for those chains.
rc.38's own note warned of a shift in the other direction; this is the same population shifting back.
Naming genuinely different zones sets `plan.periodZoneBeyondPin` instead.

**New error code.** A failure after receipts were synced that is _not_ already a
`ReportingReconciliationError` is re-thrown as `RECONCILE_FAILED_AFTER_RECEIPTS`, carrying the
original on `cause` and the receipts on `submittedReceipts`. If you were matching such a failure by
`instanceof` on the thrown value — from your own `checkpointStore`, `pendingConsumerStatusStore` or
client — match `cause` instead.

**Additive, not defects in rc.38:** `ledgerLimits.maxRevisionBytes` is new — it may only tighten the
SDK's 256 MiB per-revision ceiling, and a larger value is refused, because that ceiling bounds the
SDK process's memory rather than the caller's. It exists mainly so the ceiling is reachable in a
test. `plan.deadlineSource`, `plan.periodZoneBeyondPin` and
`ReportingReconciliationError.submittedReceipts` are also new optional public fields, which is what
makes this a `minor`. The `suppressed` union itself is unchanged from rc.38.

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
