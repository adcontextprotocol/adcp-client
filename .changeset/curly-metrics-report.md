---
'@adcp/sdk': minor
---

Add versioned per-constituent, per-metric availability evidence to `createInlineReportingSourceExecutor`. Existing row arrays, `null`, and delivery response callbacks retain their current behavior, while evidence-bearing responses can safely represent mixed present, zero, delayed, unsupported, partial, stale, and missing metric cells.
