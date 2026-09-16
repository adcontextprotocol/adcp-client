---
'@adcp/sdk': minor
---

Add versioned per-constituent, per-metric availability evidence to `createInlineReportingSourceExecutor`. Existing row arrays, `null`, and delivery response callbacks retain their current behavior, while evidence-bearing responses can safely represent mixed present, zero, delayed, unsupported, partial, stale, and missing metric cells. Evidence-bearing rows that claim one metric twice with contradictory values, and `availability_evidence` supplied as an accessor-backed or inherited slot, now fail closed with `INTEGRITY_FAILED` instead of silently preferring the direct value or downgrading to derived availability.
