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
code means.

**A conformant seller could be silenced permanently.** `expected_at` was validated against a stricter
pattern than the `format: date-time` check this SDK uses on the seller's own payloads, so a lowercase
`t`/`z`, a `+hhmm` offset or a space separator — all accepted by `ajv-formats` — yielded no deadline
and no statement, forever. The pattern now matches what the SDK itself accepts, and the instant is
**normalized rather than echoed**: `Date.parse` silently rolls `2026-02-30T00:00:00Z` forward to
March 2, and re-emitting the seller's bytes would put that contradiction on a statement the buyer
signs. When `expected_at` is genuinely unreadable the buyer now recomputes it from
`obligation.schedule.delivery_sla` — `reporting-schedule.json` defines `expected_at` as exactly that
sum and makes `schedule` required — instead of falling silent.

**Deeply nested rows walked past the byte ceiling.** The size estimate charged an unexamined subtree
a flat 64 bytes however large it was, so `{a:{b:{c:{d:{…1 MB…}}}}}` measured 200 bytes. A subtree past
the depth cap is now charged pessimistically: over-charging costs a conformant seller nothing but an
earlier `local_budget_exhausted`, under-charging is unbounded memory.

**`period.source_timezone` is bounded before adoption.** It reaches the buyer's durable statement, the
`reporting_status_id` hash and the seller-side chain key, so a seller that varied it forked the
buyer's own chain and then pinned it at `leaf_undisclosed`. The ingest path already bounds it at 255
characters; this read path now does too.

Diagnostics are honest about whose field failed: the `deadline_unknown` reason named a field that
does not exist on `ExpectedReportingPeriod` and said a value "was not recorded" when it had been
recorded and merely could not be read. `chain_indeterminate` now distinguishes a forked chain from a
head naming an undisclosed predecessor, rather than claiming no head resolved in both cases.
