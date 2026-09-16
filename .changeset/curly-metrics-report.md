---
'@adcp/sdk': minor
---

Add versioned per-constituent, per-metric availability evidence to `createInlineReportingSourceExecutor`.

The delivery request handed to an inline fetch handler now carries a required `constituents` array of frozen `{ constituent_id, media_buy_id }` pairs. Handlers that only read the existing request fields are unaffected; use `constituent_id` to key the cells of an `availability_evidence` envelope. Row arrays, `null`, and delivery response objects that omit `availability_evidence` keep their current derived-availability behavior, and `reporting_rows` / `media_buy_deliveries` are still read through the ordinary property channel, so class instances, prototype-inherited values, and accessor-backed slots continue to be accepted.

Evidence-bearing responses can represent mixed present, zero, delayed, unsupported, partial, stale, and missing metric cells. Rows that claim one metric twice with contradictory values now fail closed with `INTEGRITY_FAILED` instead of silently preferring the direct value, and repeated claims are reconciled as exact decimal quantities, so a number printed in exponent notation agrees with the equivalent plain-decimal string while neither claim is rounded. A row proves every constituent that names its `media_buy_id`, so constituents sharing one media buy are each checked against it rather than only the last one declared.

`availability_evidence` must be supplied as a plain own data property. The slot is classified from a single bounded descriptor observation and validated from a snapshot of that same observation, so a slot or envelope that restates itself when it is looked at again cannot downgrade the response to derived availability, and a cyclic or endlessly regenerated prototype chain fails closed instead of spinning.
